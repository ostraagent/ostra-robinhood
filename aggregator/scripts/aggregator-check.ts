// Runs the aggregator (src/main.ts) end to end against the real Ostra pool on
// the configured chain, with two groups of eight depositors that each deposit
// one standard leaf. Nothing is simulated: every step is a real transaction.
//
//   1. Registrations that must be refused: an unknown deposit, leaves that do
//      not match the commitment, a non-standard leaf, a leaf listed twice, and
//      a poll not signed by the deposit's depositor key.
//   2. Seven deposits of the first group registered and polled: no batch
//      (minimum anonymity 8).
//   3. The eighth: a batch of the eight is built, its leaves shuffled; every
//      depositor finds its leaf in it and the state hash the aggregator gives;
//      all approve, it is sealed, the pool fee reaches the treasury, the
//      aggregator forgets the deposits, and every leaf is spent. (On Solana
//      the aggregator then closed the spent batch for its rent; an EVM batch
//      has no rent, so it stays sealed.)
//   4. The second group: a batch of its eight; seven approve, the eighth does
//      not: after APPROVAL_SECONDS the batch is abandoned (closed for good),
//      and with only seven fresh deposits no new batch is built until the
//      eighth polls again.
//   5. The eighth polls: a new batch of the eight, all approve, it is sealed
//      as in step 3 and its leaves are spent.
// On Solana one group of eight went through the abandoned batch first and was
// sealed after it. Here a group is sealed before the 15-minute wait, so every
// token state a seal touches is read early: a mainnet fork (the fork test)
// can no longer read the forked chain's state for slots it had not read
// before once the RPC drops the fork block's state, some minutes in.
// The depositor keys hold no ETH: each signs an EIP-3009 authorization and
// the funder submits its deposit (depositWithAuthorization), as the relayer
// does for an agent; the funder is every deposit's refund owner and submits
// the approvals and leaf spends, whose WOTS signatures authorize them.
// Whether the checks pass or a step fails, the run then cleans up: consumed
// deposits are closed, unspent leaves of a sealed batch are spent, a pending
// deposit is cancelled once DEPOSIT_TIMEOUT_SECONDS have passed (otherwise the
// run prints when to recover it), tokens a depositor key still holds go back
// to the funder, and an open batch this aggregator left is closed.
//
// Environment: the aggregator's variables (OSTRA_RPC_URL, OSTRA_DEPLOYMENT,
// OSTRA_AGGREGATOR_SECRETS, OSTRA_AGGREGATOR_DATA, OSTRA_AGGREGATOR_LISTEN),
// plus
//   OSTRA_CHECK_FUNDER   file (0600) with the 32-byte hex private key of an
//                        account holding ETH and at least sixteen deposits'
//                        worth of the pool's token (sixteen leaves of 10 USDG
//                        plus the pool fee); all of it comes back at the end
//                        but the pool fees and the gas
//   OSTRA_CHECK_STATE    directory (0700) for this check's runs; each run keeps
//                        the seed its depositor keys and WOTS keys come from
//   OSTRA_CHECK_RECOVER  optional: the name of a run directory (run-...) whose
//                        cleanup did not finish; only that cleanup runs

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  hexToBytes,
  parseSignature,
  type Abi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEPOSIT_TIMEOUT_SECONDS,
  FileWotsStore,
  LEAF_DENOMINATION,
  USDG_EIP712_DOMAIN,
  WotsKeychain,
  assertRobinhoodChain,
  batchContainsLeaves,
  batchStateOf,
  checkDeployment,
  depositAuthorizationTypedData,
  depositCommitment,
  depositForLeaves,
  depositKey,
  fromHex,
  leafToWire,
  ostraPoolAbi,
  readBatch,
  readDeposit,
  readPool,
  retryingHttp,
  robinhoodChain,
  sha256,
  signAggregatorPoll,
  signApproveBatch,
  signSpendLeaf,
  toHex,
  u64Le,
  usdgAbi,
  utf8,
  type AggregatorDepositView,
  type BatchState,
  type DepositState,
  type Leaf,
} from "@ostraagent/sdk";
import { APPROVAL_SECONDS, PASS_INTERVAL_MS, loadConfig } from "../src/config.ts";
import { ensurePrivateDir, isPrivateKey, openAggregatorKey } from "../src/keys.ts";

/** Depositors in a group: exactly the minimum anonymity, so the abandoned batch leaves too few fresh deposits. */
const GROUP = 8;
/** Depositors in the check: two groups. */
const DEPOSITORS = 2 * GROUP;
/** Gas the aggregator account is funded for before the run: three batches of 8 (createBatch, appendLeaves, sealBatch or closeBatch), with headroom. */
const AGGREGATOR_GAS_BUDGET = 12_000_000n;
/** How long a deposit authorization stays valid. */
const AUTHORIZATION_TTL_SECONDS = 3_600n;
const PASS_SECONDS = PASS_INTERVAL_MS / 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

let failures = 0;
let passes = 0;
function check(ok: boolean, what: string, detail: unknown = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === "" ? "" : ` (${typeof detail === "string" ? detail : toJson(detail)})`}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`set ${name}`);
  return value;
}

async function readFunder(path: string): Promise<PrivateKeyAccount> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by other users`);
  const text = (await readFile(path, "utf8")).trim().replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text) || !isPrivateKey(hexToBytes(`0x${text}`))) throw new Error(`${path}: expected a 32-byte secp256k1 private key in hex`);
  return privateKeyToAccount(`0x${text}`);
}

/** The aggregator process; its JSON log lines are kept for checks and echoed with a prefix. */
class Proc {
  readonly child: ChildProcess;
  readonly events: Record<string, unknown>[] = [];
  readonly exited: Promise<number | null>;

  constructor(script: string, env: Record<string, string>) {
    this.child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
    if (this.child.stdout !== null) {
      createInterface({ input: this.child.stdout }).on("line", (line) => {
        console.log(`  aggregator | ${line}`);
        try {
          this.events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not a log event
        }
      });
    }
    if (this.child.stderr !== null) createInterface({ input: this.child.stderr }).on("line", (line) => console.log(`  aggregator ! ${line}`));
  }

  async waitEvent(match: (e: Record<string, unknown>) => boolean, seconds: number): Promise<Record<string, unknown> | undefined> {
    for (let i = 0; i < seconds * 4; i++) {
      const found = this.events.find(match);
      if (found !== undefined) return found;
      await sleep(250);
    }
    return this.events.find(match);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      await this.exited;
    }
  }
}

type Depositor = {
  index: number;
  key: PrivateKeyAccount;
  approval: WotsKeychain;
  leafKeys: WotsKeychain;
  leaves: Leaf[];
  deposit: Hex;
  depositId: Hex;
};

function depositorsOf(master: Uint8Array, store: FileWotsStore): Depositor[] {
  const out: Depositor[] = [];
  for (let index = 0; index < DEPOSITORS; index++) {
    const i = u64Le(BigInt(index));
    const secret = sha256([utf8("OSTRA/CHECK/DEPOSITOR/EVM/v1"), master, i]);
    // A SHA-256 output outside 1..n-1 has probability below 2^-127; it would be refused, never altered.
    if (!isPrivateKey(secret)) throw new Error(`depositor ${index}: the derived key is not a valid secp256k1 key`);
    const key = privateKeyToAccount(bytesToHex(secret));
    const approval = new WotsKeychain(master, sha256([utf8("OSTRA/CHECK/APPROVE/EVM/v1"), i]), store);
    const leafKeys = new WotsKeychain(master, sha256([utf8("OSTRA/CHECK/LEAF/EVM/v1"), i]), store);
    const depositId = bytesToHex(sha256([utf8("OSTRA/CHECK/DEPOSIT-ID/EVM/v1"), master, i]));
    out.push({ index, key, approval, leafKeys, leaves: [{ keyRoot: leafKeys.keyRoot(0n), amount: LEAF_DENOMINATION }], deposit: depositKey(key.address, depositId), depositId });
  }
  return out;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const d = config.deployment;
  const listen = `${config.listen.host}:${config.listen.port}`;
  const base = `http://${listen}`;
  const funder = await readFunder(required("OSTRA_CHECK_FUNDER"));
  const stateDir = required("OSTRA_CHECK_STATE");
  const recoverRun = process.env.OSTRA_CHECK_RECOVER === undefined || process.env.OSTRA_CHECK_RECOVER === "" ? undefined : process.env.OSTRA_CHECK_RECOVER;
  if (recoverRun !== undefined && !/^run-[0-9]+$/.test(recoverRun)) throw new Error("OSTRA_CHECK_RECOVER must be a run directory name (run-<number>)");
  const transport = retryingHttp(config.rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  await checkDeployment(client, d);
  const pool = d.pool;
  const poolInfo = await readPool(client, pool);
  const amount = depositForLeaves(1, poolInfo.feeBps);
  const fee = amount - LEAF_DENOMINATION;
  const tokenBalance = (holder: Address) => client.readContract({ address: d.token, abi: usdgAbi, functionName: "balanceOf", args: [holder] });
  const chainTime = async () => (await client.getBlock({ blockTag: "latest" })).timestamp;
  const sendFrom = async (account: PrivateKeyAccount, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) => {
    const { request } = await client.simulateContract({ address, abi, functionName, args, account } as Parameters<PublicClient["simulateContract"]>[0]);
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport });
    const hash = await wallet.writeContract(request as Parameters<typeof wallet.writeContract>[0]);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} ${hash} reverted`);
    return hash;
  };
  const send = (address: Address, abi: Abi, functionName: string, args: readonly unknown[]) => sendFrom(funder, address, abi, functionName, args);
  const readDep = (dep: Depositor): Promise<DepositState> => readDeposit(client, pool, dep.deposit);

  await ensurePrivateDir(stateDir);
  const runDir = join(stateDir, recoverRun ?? `run-${Date.now()}`);
  let master: Uint8Array;
  if (recoverRun === undefined) {
    await ensurePrivateDir(runDir);
    master = new Uint8Array(randomBytes(32));
    await writeFile(join(runDir, "master.key"), `${toHex(master)}\n`, { mode: 0o600, flag: "wx" });
  } else {
    master = fromHex((await readFile(join(runDir, "master.key"), "utf8")).trim());
  }
  await ensurePrivateDir(join(runDir, "wots"));
  const store = new FileWotsStore(join(runDir, "wots"));
  const depositors = depositorsOf(master, store);
  const aggregatorKey = await openAggregatorKey(config.secretsDir);
  console.log(`funder ${funder.address}, aggregator ${aggregatorKey.address}, pool ${pool} (fee ${poolInfo.feeBps} bps, treasury ${poolInfo.treasury}), run state ${runDir}${recoverRun === undefined ? "" : " (recovery only)"}`);

  const funderTokensBefore = await tokenBalance(funder.address);
  const treasuryTokensBefore = await tokenBalance(poolInfo.treasury);
  let proc: Proc | undefined;
  const http = async (path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const register = (deposit: Hex, leaves: Leaf[]) =>
    http("/v1/deposits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deposit, leaves: leaves.map(leafToWire) }) });
  const poll = async (dep: Depositor, signer: PrivateKeyAccount = dep.key) => {
    const at = BigInt(nowSeconds());
    const signature = await signAggregatorPoll(signer, { chainId: d.chainId, pool, deposit: dep.deposit }, at);
    return http(`/v1/deposits/${dep.deposit}?at=${at}&signature=${signature}`);
  };
  const viewOf = async (dep: Depositor) => (await poll(dep)).body as AggregatorDepositView;
  /** The approval key index whose root is on-chain now (it rotates with every approval). */
  const approvalIndex = (dep: Depositor, onChain: Hex) => {
    for (let i = 0n; i < 16n; i++) if (bytesToHex(dep.approval.keyRoot(i)) === onChain.toLowerCase()) return i;
    throw new Error(`depositor ${dep.index}: approval key root not found`);
  };
  const approve = async (dep: Depositor, batchId: bigint, state: Hex) => {
    const current = await readDep(dep);
    const index = approvalIndex(dep, current.approvalKeyRoot);
    const a = await signApproveBatch(dep.approval, { index, currentKeyRoot: current.approvalKeyRoot }, { chainId: d.chainId, pool, key: dep.deposit, batchId, state });
    return send(pool, ostraPoolAbi, "approveBatch", [a.key, a.batchId, a.state, a.nextKeyRoot, a.signature]);
  };
  const spendLeaf = async (dep: Depositor, b: BatchState, destination: Address) => {
    const leaf = dep.leaves[0] as Leaf;
    const leafIndex = b.leaves.findIndex((l) => l.keyRoot.toLowerCase() === bytesToHex(leaf.keyRoot));
    if (leafIndex < 0) throw new Error(`depositor ${dep.index}: its leaf is not in batch ${b.batchId}`);
    const s = await signSpendLeaf(dep.leafKeys, { index: 0n, leafKeyRoot: bytesToHex(leaf.keyRoot) }, { chainId: d.chainId, pool, batchId: b.batchId, leafIndex, destination, leafAmount: LEAF_DENOMINATION });
    return send(pool, ostraPoolAbi, "spendLeaf", [s.batchId, s.leafIndex, s.destination, s.signature]);
  };
  /** Polls the depositors in `who` until each reports a batch (or `seconds` pass); returns their views. */
  const waitBatched = async (who: Depositor[], seconds: number) => {
    const until = Date.now() + seconds * 1000;
    let views: AggregatorDepositView[] = [];
    while (Date.now() < until) {
      views = [];
      for (const dep of who) views.push(await viewOf(dep));
      if (views.every((v) => v.status === "batched")) return views;
      await sleep(10_000);
    }
    return views;
  };

  let runError: unknown;
  if (recoverRun === undefined) {
    try {
      // --- preflight and start ----------------------------------------------------------------
      if (funderTokensBefore < amount * BigInt(DEPOSITORS)) throw new Error(`the funder holds ${funderTokensBefore} base units; the check needs ${amount * BigInt(DEPOSITORS)}`);
      const { maxFeePerGas } = await client.estimateFeesPerGas();
      const aggregatorWei = await client.getBalance({ address: aggregatorKey.address });
      const want = AGGREGATOR_GAS_BUDGET * maxFeePerGas;
      if (aggregatorWei < want) {
        const hash = await createWalletClient({ account: funder, chain: robinhoodChain, transport }).sendTransaction({ to: aggregatorKey.address, value: want - aggregatorWei });
        if ((await client.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`the aggregator top-up ${hash} reverted`);
      }
      const env: Record<string, string> = {};
      for (const name of ["PATH", "HOME", "OSTRA_RPC_URL", "OSTRA_DEPLOYMENT", "OSTRA_AGGREGATOR_SECRETS", "OSTRA_AGGREGATOR_DATA", "OSTRA_AGGREGATOR_LISTEN"]) {
        const value = process.env[name];
        if (value !== undefined && value !== "") env[name] = value;
      }
      proc = new Proc(fileURLToPath(new URL("../src/main.ts", import.meta.url)), env);
      const started = await proc.waitEvent((e) => e.event === "started", 60);
      if (started === undefined) throw new Error("the aggregator did not start");
      const terms = (await http("/v1/terms")).body;
      check(
        terms.chainId === d.chainId && terms.pool === pool && terms.token === d.token && terms.aggregator === aggregatorKey.address && terms.minDeposits === 8 && terms.leafAmount === LEAF_DENOMINATION.toString(),
        "the aggregator serves the pool with minimum anonymity 8 and one leaf amount",
        terms,
      );

      // --- deposits -------------------------------------------------------------------------------
      for (const dep of depositors) {
        if ((await readDep(dep)).status !== "none") continue;
        if ((await tokenBalance(dep.key.address)) < amount) await send(d.token, usdgAbi, "transfer", [dep.key.address, amount]);
        const args = {
          depositor: dep.key.address,
          depositId: dep.depositId,
          amount,
          refundOwner: funder.address,
          approvalKeyRoot: bytesToHex(dep.approval.keyRoot(0n)),
          commitment: depositCommitment(dep.leaves),
        };
        const validBefore = (await chainTime()) + AUTHORIZATION_TTL_SECONDS;
        const signature = await dep.key.signTypedData(depositAuthorizationTypedData({ ...args, chainId: d.chainId, pool, validAfter: 0n, validBefore }));
        const { v, yParity, r, s } = parseSignature(signature);
        await send(pool, ostraPoolAbi, "depositWithAuthorization", [
          args.depositor,
          args.depositId,
          args.amount,
          args.refundOwner,
          args.approvalKeyRoot,
          bytesToHex(args.commitment),
          0n,
          validBefore,
          v === undefined ? yParity + 27 : Number(v),
          r,
          s,
        ]);
      }
      const deps = await Promise.all(depositors.map(readDep));
      check(
        deps.every((x) => x.status === "pending" && x.amount === amount && x.refundOwner === funder.address),
        `${DEPOSITORS} deposits of one leaf each are pending (${amount} base units each, refunded to the funder)`,
      );

      // --- 1. refusals ----------------------------------------------------------------------------
      const groupA = depositors.slice(0, GROUP);
      const groupB = depositors.slice(GROUP);
      const d0 = groupA[0] as Depositor;
      const stranger = privateKeyToAccount(generatePrivateKey());
      let r = await register(depositKey(stranger.address, bytesToHex(randomBytes(32))), d0.leaves);
      check(r.status === 404 && r.body.error === "unknown_deposit", "a key that is not a deposit is refused", r);
      r = await register(d0.deposit, [{ keyRoot: d0.leafKeys.keyRoot(1n), amount: LEAF_DENOMINATION }]);
      check(r.status === 409 && r.body.error === "commitment_mismatch", "leaves that do not match the deposit's commitment are refused", r);
      r = await register(d0.deposit, [{ keyRoot: d0.leafKeys.keyRoot(0n), amount: LEAF_DENOMINATION / 2n }, { keyRoot: d0.leafKeys.keyRoot(1n), amount: LEAF_DENOMINATION / 2n }]);
      check(r.status === 400 && r.body.error === "non_standard_leaf", "a leaf of another amount is refused", r);
      r = await register(d0.deposit, [d0.leaves[0] as Leaf, d0.leaves[0] as Leaf]);
      check(r.status === 400 && r.body.error === "duplicate_leaf", "a leaf listed twice is refused", r);
      r = await poll(d0);
      check(r.status === 200 && r.body.status === "unknown", "a deposit not registered polls as unknown", r);

      // --- 2. seven deposits of the first group: no batch -----------------------------------------
      for (const dep of groupA.slice(0, GROUP - 1)) {
        r = await register(dep.deposit, dep.leaves);
        if (r.status !== 200 || r.body.status !== "queued") throw new Error(`registration of deposit ${dep.index} failed: ${toJson(r)}`);
        await poll(dep);
      }
      r = await poll(d0, stranger);
      check(r.status === 401 && r.body.error === "bad_signature", "a poll not signed by the depositor key is refused", r);
      await sleep((2 * PASS_SECONDS + 5) * 1000);
      let health = (await http("/v1/health")).body;
      check(health.open === null && health.fresh === GROUP - 1, "seven fresh deposits: no batch is built below the minimum anonymity", { open: health.open, fresh: health.fresh });

      // --- 3. the eighth: a batch of eight, approved by all and sealed -----------------------------
      r = await register((groupA[GROUP - 1] as Depositor).deposit, (groupA[GROUP - 1] as Depositor).leaves);
      check(r.status === 200 && r.body.status === "queued", "the eighth deposit is registered", r.body);
      const batched = async (group: Depositor[], what: string): Promise<{ batchId: bigint; state: Hex } | null> => {
        const views = await waitBatched(group, 4 * PASS_SECONDS + 60);
        const first = views[0];
        const ok = first?.status === "batched" && views.every((v) => v.status === "batched" && v.batch === first.batch && v.stateHash === first.stateHash);
        check(ok, what, views);
        return ok && first?.status === "batched" ? { batchId: BigInt(first.batch), state: first.stateHash.toLowerCase() as Hex } : null;
      };
      const sealAndSpend = async (group: Depositor[], batchId: bigint, state: Hex, feesBefore: bigint) => {
        for (const dep of group) await approve(dep, batchId, state);
        const sealed = await proc?.waitEvent((e) => e.event === "batch_sealed" && e.batch === batchId.toString(), 3 * PASS_SECONDS + 30);
        check(sealed !== undefined, `batch ${batchId} is sealed once every deposit approved`, sealed);
        let b = await readBatch(client, pool, batchId);
        const consumed = (await Promise.all(group.map(readDep))).every((x) => x.status === "consumed");
        check(b.status === "sealed" && b.unspent === GROUP && consumed, `on-chain: batch ${batchId} is sealed with 8 unspent leaves and every deposit is consumed`);
        if (poolInfo.treasury !== funder.address) {
          check((await tokenBalance(poolInfo.treasury)) - feesBefore === fee * BigInt(GROUP), `the treasury got the pool fee of every deposit of batch ${batchId}`, fee * BigInt(GROUP));
        }
        const views: AggregatorDepositView[] = [];
        for (const dep of group) views.push(await viewOf(dep));
        check(views.every((v) => v.status === "unknown"), `after sealing batch ${batchId} the aggregator no longer knows its deposits (which leaf came from which deposit is forgotten)`, views);
        for (const dep of group) await spendLeaf(dep, b, funder.address);
        b = await readBatch(client, pool, batchId);
        check(b.unspent === 0 && b.status === "sealed", `every leaf of batch ${batchId} is spent to the funder; the batch stays sealed (an EVM batch has no rent to reclaim)`, { unspent: b.unspent, status: b.status });
      };
      const a = await batched(groupA, "all eight deposits report the same batch and state hash");
      if (a === null) throw new Error("no batch was built");
      const bA = await readBatch(client, pool, a.batchId);
      check(bA.status === "open" && bA.leafCount === GROUP && bA.capacity === GROUP && batchStateOf(bA).toLowerCase() === a.state, "the batch on-chain holds 8 leaves and has the state hash the aggregator gives", { leaves: bA.leafCount, capacity: bA.capacity });
      check(groupA.every((dep) => batchContainsLeaves(bA, dep.leaves)), "every depositor finds its leaf in the batch");
      await sealAndSpend(groupA, a.batchId, a.state, treasuryTokensBefore);

      // --- 4. the second group: seven approve, the eighth does not: abandoned ----------------------
      // (Sealed first, then abandoned: every token state a seal touches is read before the 15-minute wait.)
      for (const dep of groupB) {
        r = await register(dep.deposit, dep.leaves);
        if (r.status !== 200 || r.body.status !== "queued") throw new Error(`registration of deposit ${dep.index} failed: ${toJson(r)}`);
      }
      const b1 = await batched(groupB, "the second group's eight deposits report one new batch and state hash");
      if (b1 === null) throw new Error("no batch was built for the second group");
      check(b1.batchId !== a.batchId, "the second group's batch is a new batch", { first: a.batchId, second: b1.batchId });
      const late = groupB[GROUP - 1] as Depositor;
      const early = groupB.slice(0, GROUP - 1);
      for (const dep of early) await approve(dep, b1.batchId, b1.state);
      const approvedBy = (await Promise.all(groupB.map(readDep))).filter((x) => x.approvedBatch === b1.batchId).length;
      check(approvedBy === GROUP - 1, "seven deposits approved the batch on-chain", approvedBy);
      const expireBy = Date.now() + (APPROVAL_SECONDS + 3 * PASS_SECONDS + 30) * 1000;
      let abandoned: Record<string, unknown> | undefined;
      while (Date.now() < expireBy && abandoned === undefined) {
        for (const dep of early) await poll(dep);
        abandoned = await proc.waitEvent((e) => e.event === "batch_abandoned" && e.batch === b1.batchId.toString(), 60);
      }
      check(abandoned?.reason === "approval_expired" && abandoned.notApproved === 1, "the batch is abandoned when one deposit does not approve in time", abandoned);
      check((await readBatch(client, pool, b1.batchId)).status === "closed", "the abandoned batch is closed on-chain (it can never be sealed)");
      for (const dep of early) await poll(dep);
      await sleep((2 * PASS_SECONDS + 5) * 1000);
      health = (await http("/v1/health")).body;
      check(health.open === null && health.fresh === GROUP - 1, "the deposit that did not approve is no longer fresh: no new batch from seven", { open: health.open, fresh: health.fresh });

      // --- 5. the eighth polls again: a new batch, sealed ------------------------------------------
      await poll(late);
      const b2 = await batched(groupB, "once the eighth polls again a new batch of the eight is built");
      if (b2 === null || b2.batchId === b1.batchId) throw new Error("no second batch was built for the second group");
      const bB = await readBatch(client, pool, b2.batchId);
      check(groupB.every((dep) => batchContainsLeaves(bB, dep.leaves)) && batchStateOf(bB).toLowerCase() === b2.state, "every depositor finds its leaf in the new batch, at the state hash given");
      await sealAndSpend(groupB, b2.batchId, b2.state, await tokenBalance(poolInfo.treasury));
    } catch (err) {
      runError = err;
      console.log(`run stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- cleanup ----------------------------------------------------------------------------------
  await proc?.stop();
  try {
    const now = await chainTime();
    let left = 0;
    for (const dep of depositors) {
      const current = await readDep(dep);
      if (current.status === "consumed") {
        // A leaf of a sealed batch still unspent goes to the funder.
        const bt = current.approvedBatch === null ? null : await readBatch(client, pool, current.approvedBatch);
        const leaf = dep.leaves[0] as Leaf;
        const at = bt === null ? undefined : bt.leaves.find((l) => l.keyRoot.toLowerCase() === bytesToHex(leaf.keyRoot));
        if (bt !== null && bt.status === "sealed" && at !== undefined && !at.spent) {
          await spendLeaf(dep, bt, funder.address);
          console.log(`cleanup: depositor ${dep.index} spent its leaf to the funder`);
        }
        await send(pool, ostraPoolAbi, "closeDeposit", [dep.deposit]);
      } else if (current.status === "pending") {
        const unlock = current.createdAt + DEPOSIT_TIMEOUT_SECONDS;
        if (now >= unlock) {
          await send(pool, ostraPoolAbi, "cancelDeposit", [dep.deposit]);
          console.log(`cleanup: deposit ${dep.deposit} cancelled and refunded to the funder`);
        } else {
          left++;
          console.log(`cleanup: deposit ${dep.deposit} is pending; it can be cancelled from ${new Date(Number(unlock) * 1000).toISOString()} (chain time)`);
          continue;
        }
      }
      // Tokens a depositor key still holds (a deposit that never landed) go back to the funder: the
      // key holds no ETH, so it signs an EIP-3009 transfer and the funder submits it.
      const held = await tokenBalance(dep.key.address);
      if (held > 0n) {
        const nonce = bytesToHex(randomBytes(32));
        const validBefore = now + AUTHORIZATION_TTL_SECONDS;
        const signature = await dep.key.signTypedData({
          domain: USDG_EIP712_DOMAIN,
          types: {
            TransferWithAuthorization: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
              { name: "nonce", type: "bytes32" },
            ],
          },
          primaryType: "TransferWithAuthorization",
          message: { from: dep.key.address, to: funder.address, value: held, validAfter: 0n, validBefore, nonce },
        });
        const { v, yParity, r, s } = parseSignature(signature);
        await send(d.token, usdgAbi, "transferWithAuthorization", [dep.key.address, funder.address, held, 0n, validBefore, nonce, v === undefined ? yParity + 27 : Number(v), r, s]);
      }
      console.log(`cleanup: depositor ${dep.index} returned ${held} base units to the funder`);
    }
    // An unsealed batch of this aggregator left behind by a stopped run is closed with the aggregator key.
    const { batchCount } = await readPool(client, pool);
    for (let i = batchCount > 4n ? batchCount - 4n : 0n; i < batchCount; i++) {
      const bt = await readBatch(client, pool, i);
      if (bt.aggregator === aggregatorKey.address && bt.status === "open") {
        await sendFrom(aggregatorKey, pool, ostraPoolAbi, "closeBatch", [i]);
        console.log(`cleanup: open batch ${i} closed`);
      }
    }
    if (left > 0) {
      console.log(`cleanup: ${left} deposit(s) are still pending; run again with OSTRA_CHECK_RECOVER=${runDir.split("/").pop() ?? ""} once they can be cancelled`);
      check(false, "cleanup: every deposit is closed");
    } else {
      check(true, "cleanup: every deposit is closed and every depositor key emptied");
    }
    if (recoverRun === undefined && runError === undefined) {
      const funderTokensAfter = await tokenBalance(funder.address);
      const expected = poolInfo.treasury === funder.address ? 0n : -fee * BigInt(DEPOSITORS);
      check(funderTokensAfter - funderTokensBefore === expected, "accounting: the funder got back every leaf; only the pool fee left it", { before: funderTokensBefore, after: funderTokensAfter, expectedChange: expected });
    }
  } catch (err) {
    check(false, "cleanup", err instanceof Error ? err.message : String(err));
  }
  if (runError !== undefined) check(false, "the run", runError instanceof Error ? runError.message : String(runError));
  console.log(`\n${passes} passed, ${failures} failed`);
  if (recoverRun !== undefined) console.log(failures === 0 ? "RECOVERY DONE" : `RECOVERY: ${failures} STEP(S) FAILED`);
  else console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`aggregator-check failed: ${url === undefined || url === "" ? message : message.split(url).join("<rpc>")}`);
  process.exit(1);
});
