// Pays an Ostra Tide week (design "Ostra Tide", decided by Edu on 26 and 31 Oct 2026: the root of a week's shares is
// posted, then the shares paid, every Thursday 00:00 UTC; week 1 on 5 Nov 2026) from the week's result that
// scripts/tide-score.ts wrote (week-<n>.json in OSTRA_TIDE_RESULTS):
//
//   check   sends nothing: the result is final, read after the week's link deadline (its end + 23 hours: links
//           approved until then count), and holds a tree; every leaf is OstraTide's own leaf (read from the
//           contract), its proof verifies against the root, its amount is not zero and its agent's share; the amounts
//           add up to the tree's total and the result's shared amount; the week is over, its root is not set yet (or
//           set to this root and total), it has not rolled over, and the pot holds the total. Exit 1 on any problem.
//   root    after the checks: OstraTide.setRoot(week, root, total) from OSTRA_DEPLOYER_KEY_FILE's account, which must be
//           OstraTide's owner. A root set already to this root and total is left as it is.
//   pay     after the checks, with this root on chain: OstraTide.payMany in batches of OSTRA_TIDE_PAY_BATCH (default 20)
//           for every share whose payee is an OSTRA vault and that is not paid yet (paid(week, agentId)); a share
//           without a payee (the agent had no OSTRA vault) is listed, and only the owner can pay it once the vault
//           exists (pay with the vault named), within HOLD of the root.
//
// Each transaction is signed here and recorded (its hash and its signed bytes, in OSTRA_TIDE_RESULTS/tide-pay.json)
// before it is sent; a step recorded is never signed again, and a run stopped at any point is run again to finish.
// What was paid, by whom and in which transaction is kept in week-<n>.paid.json (0600), which the index serves to
// each agent with its points. Nothing secret is printed: the RPC URL is redacted.
//
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) of OstraTide's owner (default /etc/ostra/deployer.key)
//   OSTRA_TIDE_RESULTS        the scorer's directory (default /var/lib/ostra-tide)
//   OSTRA_TIDE_PAY_BATCH      shares per payMany (default 20)
//   OSTRA_TIDE_TEST_STOP      tests only: "<step>:signed" or "<step>:mined" ends the run (exit 3) there
//
//   node scripts/tide-pay.ts check|root|pay <week>
// The last line is TIDE_CHECKED, TIDE_ROOT_SET or TIDE_PAID.

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  type Address,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { OSTRA, OSTRA_TIDE, assertRobinhoodChain, redact, retryingHttp, robinhoodChain, tideLeaf, tideLinkDeadline, tideVerify } from "@ostraagent/sdk";
import type { TideWeekResult } from "../src/tide-score.ts";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

const ostraTideAbi = parseAbi([
  "struct Share { uint256 week; uint256 agentId; address payee; uint256 amount; }",
  "struct Week { bytes32 root; uint128 total; uint128 paid; uint64 rootAt; bool rolled; }",
  "function owner() view returns (address)",
  "function TOKEN() view returns (address)",
  "function weekEnd(uint256 week) view returns (uint256)",
  "function potBalance(uint256 week) view returns (uint256)",
  "function weekInfo(uint256 week) view returns (Week)",
  "function paid(uint256 week, uint256 agentId) view returns (bool)",
  "function leaf(Share s) pure returns (bytes32)",
  "function setRoot(uint256 week, bytes32 root, uint256 total)",
  "function payMany(Share[] shares, bytes32[][] proofs, address[] vaults)",
  "event Paid(uint256 indexed week, uint256 indexed agentId, address indexed vault, uint256 amount)",
]);

/** What week-<n>.paid.json holds (design "Ostra Tide": the index serves each agent its own entry). */
type TidePaidFile = { week: number; root: Hex; rootTx: Hex | null; paid: Record<string, { tx: Hex; amount: string; vault: Address }> };

const secretsSeen: string[] = [];
const testStop = (at: string) => {
  if (process.env.OSTRA_TIDE_TEST_STOP === at) {
    console.log(`TEST STOP at ${at}`);
    process.exit(3);
  }
};
const scrub = (text: string) => secretsSeen.reduce((t, s) => (s === "" ? t : redact(t, s).split(s).join("<secret>")), text);
const say = (line: string) => console.log(scrub(line));

async function privateText(path: string, what: string): Promise<string> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${what} ${path} must be readable by its owner alone (it has mode ${mode.toString(8)})`);
  return (await readFile(path, "utf8")).split("\n")[0]!.trim();
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  const weekText = process.argv[3] ?? "";
  if ((phase !== "check" && phase !== "root" && phase !== "pay") || !/^[1-9][0-9]{0,3}$/.test(weekText)) throw new Error("usage: node scripts/tide-pay.ts check|root|pay <week>");
  const week = Number(weekText);
  const rpcUrl = await privateText(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  secretsSeen.push(rpcUrl);
  const dir = process.env.OSTRA_TIDE_RESULTS || "/var/lib/ostra-tide";
  const batchSize = Number(process.env.OSTRA_TIDE_PAY_BATCH || 20);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("OSTRA_TIDE_PAY_BATCH must be a whole number from 1 to 100");

  const transport: Transport = retryingHttp(rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  const tide = (functionName: string, args: readonly unknown[] = []): Promise<unknown> => client.readContract({ address: OSTRA_TIDE, abi: ostraTideAbi, functionName: functionName as "owner", args: args as [] });

  // --- the result and its tree, checked against the contract ---------------------------------------------------------
  const resultPath = join(dir, `week-${week}.json`);
  const result = await readJson<TideWeekResult>(resultPath);
  if (result === null) throw new Error(`no result at ${resultPath}: run scripts/tide-score.ts for week ${week} first`);
  const problems: string[] = [];
  if (result.week !== week) problems.push(`${resultPath} is the result of week ${result.week}`);
  if (!result.final) problems.push("the result was read before the week ended (final false): score it again after the week");
  else if (result.at <= tideLinkDeadline(week)) {
    problems.push(`the result was read at ${new Date(result.at * 1000).toISOString()}, before the link deadline ${new Date(tideLinkDeadline(week) * 1000).toISOString()}: score it again after it`);
  }
  const tree = result.tree;
  if (tree === null) throw new Error(`week ${week}'s result holds no tree (no agent has a share): nothing to post or pay`);
  if (getAddress((await tide("TOKEN")) as Address) !== OSTRA) problems.push("OstraTide's token is not OSTRA");
  const shareOf = new Map(result.agents.map((a) => [a.agentId, a]));
  const seen = new Set<string>();
  let sum = 0n;
  for (const l of tree.leaves) {
    if (seen.has(l.agentId)) problems.push(`agent ${l.agentId} has two leaves`);
    seen.add(l.agentId);
    const amount = BigInt(l.amount);
    sum += amount;
    if (amount === 0n) problems.push(`agent ${l.agentId}'s leaf pays nothing`);
    const a = shareOf.get(l.agentId);
    if (a === undefined || a.share !== l.amount) problems.push(`agent ${l.agentId}'s leaf is not its share in the result`);
    if (a !== undefined && getAddress(a.payee ?? ZERO) !== getAddress(l.payee)) problems.push(`agent ${l.agentId}'s leaf pays ${l.payee}, not its payee in the result`);
    const share = { week: BigInt(week), agentId: BigInt(l.agentId), payee: getAddress(l.payee), amount };
    const local = tideLeaf({ week, agentId: l.agentId, payee: getAddress(l.payee), amount });
    const onChain = (await tide("leaf", [share])) as Hex;
    if (local.toLowerCase() !== onChain.toLowerCase()) problems.push(`agent ${l.agentId}'s leaf is ${local}, OstraTide computes ${onChain}`);
    if (!tideVerify(tree.root, local, l.proof)) problems.push(`agent ${l.agentId}'s proof does not verify against the root`);
  }
  if (sum.toString() !== tree.total) problems.push(`the leaves add up to ${sum}, not the tree's total ${tree.total}`);
  if (tree.total !== result.shared) problems.push(`the tree's total ${tree.total} is not the result's shared ${result.shared}`);
  const now = (await client.getBlock()).timestamp;
  const end = (await tide("weekEnd", [BigInt(week)])) as bigint;
  if (now < end) problems.push(`week ${week} ends at ${new Date(Number(end) * 1000).toISOString()}: not yet`);
  const info = (await tide("weekInfo", [BigInt(week)])) as { root: Hex; total: bigint; paid: bigint; rootAt: bigint; rolled: boolean };
  const pot = (await tide("potBalance", [BigInt(week)])) as bigint;
  const zeroRoot = BigInt(info.root) === 0n;
  const ours = !zeroRoot && info.root.toLowerCase() === tree.root.toLowerCase() && info.total.toString() === tree.total;
  if (info.rolled) problems.push(`week ${week} has rolled over: its shares can no longer be paid`);
  if (!zeroRoot && !ours) problems.push(`week ${week}'s root on chain is ${info.root} (total ${info.total}), not this result's ${tree.root} (total ${tree.total})`);
  // Before the root, the pot must hold the whole total; after it, what is still unpaid.
  const due = BigInt(tree.total) - (ours ? info.paid : 0n);
  if (pot < due) problems.push(`the pot holds ${formatUnits(pot, 18)} OSTRA, less than the ${formatUnits(due, 18)} still due`);
  const waiting = tree.leaves.filter((l) => getAddress(l.payee) === ZERO);
  say(`week ${week}: ${tree.leaves.length} shares, total ${formatUnits(BigInt(tree.total), 18)} OSTRA of a pot of ${formatUnits(pot, 18)}, root ${tree.root}${ours ? " (set on chain)" : zeroRoot ? " (not set yet)" : ""}; ${waiting.length} without an OSTRA vault`);
  if (problems.length > 0) {
    for (const p of problems) say(`PROBLEM ${p}`);
    throw new Error(`${problems.length} problem(s) with week ${week}'s result; nothing was sent`);
  }
  if (phase === "check") {
    say("TIDE_CHECKED");
    return;
  }

  // --- the owner's transactions ---------------------------------------------------------------------------------------
  const key = await privateText(process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key", "the owner key");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("the owner key file does not hold a 0x-prefixed private key");
  const owner: PrivateKeyAccount = privateKeyToAccount(key as Hex);
  const onChainOwner = getAddress((await tide("owner")) as Address);
  if (onChainOwner !== owner.address) throw new Error(`the key's account ${owner.address} is not OstraTide's owner ${onChainOwner}; nothing was sent`);
  say(`owner ${owner.address}: ETH ${formatEther(await client.getBalance({ address: owner.address }))}`);

  const keptFile = join(dir, "tide-pay.json");
  const kept = (await readJson<Record<string, string>>(keptFile)) ?? {};
  const record = async (name: string, value: string) => {
    kept[name] = value;
    await writePrivate(keptFile, kept);
  };
  await writePrivate(keptFile, kept);

  /** One recorded transaction from the owner, as scripts/fund-pad-evaluator.ts's step: signed once, recorded, sent. */
  const step = async (name: string, tx: { to: Address; data: Hex }): Promise<TransactionReceipt> => {
    let hash = kept[name] as Hash | undefined;
    let raw = kept[`${name}:raw`] as Hex | undefined;
    if (hash === undefined || raw === undefined) {
      const wallet = createWalletClient({ account: owner, chain: robinhoodChain, transport });
      const gas = await client.estimateGas({ account: owner.address, to: tx.to, data: tx.data });
      const request = await wallet.prepareTransactionRequest({ account: owner, chain: robinhoodChain, to: tx.to, data: tx.data, value: 0n, gas: gas + gas / 5n });
      raw = await wallet.signTransaction(request as Parameters<typeof wallet.signTransaction>[0]);
      hash = keccak256(raw);
      kept[`${name}:raw`] = raw;
      await record(name, hash);
      testStop(`${name}:signed`);
    }
    const known = await client.getTransaction({ hash }).then(() => true, () => false);
    if (!known) {
      try {
        await client.sendRawTransaction({ serializedTransaction: raw });
      } catch (err) {
        say(`${name}: sending ${hash} again answered: ${((err as Error).message ?? String(err)).split("\n")[0]}`);
        const n = parseTransaction(raw).nonce ?? 0;
        const used = (await client.getTransactionCount({ address: owner.address, blockTag: "latest" })) > n;
        const mined = await client.getTransactionReceipt({ hash }).then(() => true, () => false);
        const inPool = mined || (await client.getTransaction({ hash }).then(() => true, () => false));
        if (used && !inPool) {
          throw new Error(`${name}: its transaction ${hash} (nonce ${n} of ${owner.address}) is not on chain and that nonce was used by another transaction: nothing of this step was sent. Check ${hash} on the explorer first; if it is not there, remove "${name}" and "${name}:raw" from ${keptFile} to sign it again`);
        }
      }
    }
    const r = await client.waitForTransactionReceipt({ hash, timeout: 300_000 });
    if (r.status !== "success") throw new Error(`${name}: transaction ${hash} reverted`);
    say(`SENT ${name}: ${hash}`);
    testStop(`${name}:mined`);
    return r;
  };

  const paidPath = join(dir, `week-${week}.paid.json`);
  const paidFile: TidePaidFile = (await readJson<TidePaidFile>(paidPath)) ?? { week, root: tree.root, rootTx: null, paid: {} };
  if (paidFile.root.toLowerCase() !== tree.root.toLowerCase()) throw new Error(`${paidPath} records root ${paidFile.root}, not ${tree.root}; nothing was sent`);

  const rootStep = `root:${week}:${tree.root}`;
  if (!ours) {
    const r = await step(rootStep, { to: OSTRA_TIDE, data: encodeFunctionData({ abi: ostraTideAbi, functionName: "setRoot", args: [BigInt(week), tree.root, BigInt(tree.total)] }) });
    paidFile.rootTx = r.transactionHash;
    await writePrivate(paidPath, paidFile);
  } else {
    if (kept[rootStep] !== undefined && paidFile.rootTx === null) paidFile.rootTx = kept[rootStep] as Hex;
    await writePrivate(paidPath, paidFile);
    say(`week ${week}'s root is set already`);
  }
  if (phase === "root") {
    say("TIDE_ROOT_SET");
    return;
  }

  // --- the shares ------------------------------------------------------------------------------------------------------
  const unpaid = [];
  for (const l of tree.leaves) {
    if (getAddress(l.payee) === ZERO) continue;
    if ((await tide("paid", [BigInt(week), BigInt(l.agentId)])) as boolean) continue;
    unpaid.push(l);
  }
  // The steps' names name their shares: a run again forms the same batch of the same unpaid shares, so it finds its
  // recorded transaction; a batch whose share someone else paid meanwhile is a new batch (payMany skips a paid share).
  for (let i = 0; i < unpaid.length; i += batchSize) {
    const batch = unpaid.slice(i, i + batchSize);
    const name = `pay:${week}:${keccak256(`0x${Buffer.from(batch.map((l) => l.agentId).join(",")).toString("hex")}` as Hex).slice(0, 18)}`;
    const shares = batch.map((l) => ({ week: BigInt(week), agentId: BigInt(l.agentId), payee: getAddress(l.payee), amount: BigInt(l.amount) }));
    const r = await step(name, {
      to: OSTRA_TIDE,
      data: encodeFunctionData({ abi: ostraTideAbi, functionName: "payMany", args: [shares, batch.map((l) => l.proof), batch.map(() => ZERO)] }),
    });
    for (const log of r.logs) {
      if (getAddress(log.address) !== OSTRA_TIDE) continue;
      try {
        const e = decodeEventLog({ abi: ostraTideAbi, data: log.data, topics: log.topics });
        if (e.eventName !== "Paid") continue;
        const a = e.args as { week: bigint; agentId: bigint; vault: Address; amount: bigint };
        if (Number(a.week) === week) paidFile.paid[a.agentId.toString()] = { tx: r.transactionHash, amount: a.amount.toString(), vault: getAddress(a.vault) };
      } catch {
        // another event of OstraTide's
      }
    }
    await writePrivate(paidPath, paidFile);
  }
  // Every share with a payee is paid on chain now (by this run or anyone: payMany skips a paid share).
  for (const l of tree.leaves) {
    if (getAddress(l.payee) === ZERO) continue;
    if (!((await tide("paid", [BigInt(week), BigInt(l.agentId)])) as boolean)) throw new Error(`agent ${l.agentId}'s share is not paid after this run`);
  }
  const info2 = (await tide("weekInfo", [BigInt(week)])) as { paid: bigint; total: bigint };
  say(`week ${week}: paid ${formatUnits(info2.paid, 18)} of ${formatUnits(info2.total, 18)} OSTRA; ${Object.keys(paidFile.paid).length} shares recorded paid`);
  for (const l of waiting) say(`agent ${l.agentId}: ${formatUnits(BigInt(l.amount), 18)} OSTRA waits for an OSTRA vault (the owner pays it once the vault exists, before the hold ends)`);
  say(`owner ${owner.address}: ETH ${formatEther(await client.getBalance({ address: owner.address }))}`);
  say("TIDE_PAID");
}

main().catch((err: unknown) => {
  console.error(scrub(`STOPPED: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
