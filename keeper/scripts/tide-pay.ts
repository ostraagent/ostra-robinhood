// Pays an Ostra Tide week (design "Ostra Tide", decided by Edu on 26 and 31 Oct 2026: the root of a week's shares is
// posted, then the shares paid, every Thursday 00:00 UTC; week 1 on 5 Nov 2026) from the week's result that
// scripts/tide-score.ts wrote (week-<n>.json in OSTRA_TIDE_RESULTS):
//
//   check   sends nothing: the result is final, read after the week's link deadline (its end + 23 hours: links
//           approved until then count), and holds a tree; every leaf is OstraTide's own leaf (read from the
//           contract), its proof verifies against the root, its amount is not zero and its agent's share; the amounts
//           add up to the tree's total and the result's shared amount; the week is over, its root is not set yet (or
//           set to this root and total), it has not rolled over, and the pot holds the total. A payee with no code yet
//           (an agent's OSTRA vault named by its creation params, decided by Edu on 1 Nov 2026: Ostra creates it at
//           payout) must have its params in the result, in OSTRA, and OstraTide's factory must compute exactly that
//           address from them; the check says how many vaults pay will create and about how much gas that takes.
//           Exit 1 on any problem.
//   root    after the checks: OstraTide.setRoot(week, root, total) from OSTRA_DEPLOYER_KEY_FILE's account, which must be
//           OstraTide's owner. A root set already to this root and total is left as it is.
//   pay     after the checks, with this root on chain: first, for every share not paid yet whose payee has no code,
//           OstraVaultFactory.createVault with its params from OSTRA_DEPLOYER_KEY_FILE's account (createVault is open
//           to anyone and gives the vault to the keys its params name: the agent's), and then the vault there must be
//           the payee, in OSTRA; then OstraTide.payMany in batches of OSTRA_TIDE_PAY_BATCH (default 20) for every
//           share whose payee is an OSTRA vault and that is not paid yet (paid(week, agentId)). A share without a
//           payee (a link without one, made before MCP 0.1.16) is listed, and only the owner can pay it once the
//           vault exists (manual), within HOLD of the root.
//   manual  after the checks, with this root on chain and before the week can roll over (OstraTide.rolloverAt): each
//           share without a payee, not paid yet, whose agent linked after the link deadline (src/tide-manual.ts: the
//           index's link, its identity vault's set approval in force and valid from after the deadline, the payee as
//           0.1.16 names it) is paid by the owner to that payee (OstraTide.pay, the vault named), its OSTRA vault
//           created first when it has no code; a share whose agent did not is listed with the time the owner can pay
//           it until, and left alone. `check manual` sends nothing and says what manual would do.
//
// Each transaction is signed here and recorded (its hash and its signed bytes, in OSTRA_TIDE_RESULTS/tide-pay.json)
// before it is sent; a step recorded is never signed again, and a run stopped at any point is run again to finish.
// Before root or pay sends anything, the owner's account must hold what the run's transactions can cost (each at its
// gas limit and the current maximum fee; one recorded and not mined at its own): otherwise it stops and says how much
// more it needs, and run again once funded it goes on with what it recorded.
// What was paid, by whom and in which transaction is kept in week-<n>.paid.json (0600), which the index serves to
// each agent with its points. root, pay and manual first fill it from the chain (a run stopped after a transaction was
// mined and before the file was written): the Paid events of every payMany or pay step recorded, then, for a share
// paid on chain that the file still lacks, OstraTide's Paid event of it since the root. Nothing secret is printed: the
// RPC URL is redacted.
//
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) of OstraTide's owner (default /etc/ostra/deployer.key)
//   OSTRA_TIDE_RESULTS        the scorer's directory (default /var/lib/ostra-tide)
//   OSTRA_TIDE_PAY_BATCH      shares per payMany (default 20)
//   OSTRA_TIDE_LINKS          manual: the links the index keeps (default /var/lib/ostra-indexer/tide-links.json)
//   OSTRA_STATS_OWN           manual: Ostra's own vaults, one address at the start of each line (default
//                             /var/lib/ostra-stats/own.tsv)
//   OSTRA_TIDE_TEST_STOP      tests only: "<step>:signed" or "<step>:mined" ends the run (exit 3) there
//
//   node scripts/tide-pay.ts check|root|pay|manual <week>
//   node scripts/tide-pay.ts check manual <week>
// The last line is TIDE_CHECKED, TIDE_ROOT_SET, TIDE_PAID, TIDE_MANUAL_CHECKED or TIDE_MANUAL_PAID.

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
  parseAbiItem,
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
import { OSTRA, OSTRA_TIDE, ROBINHOOD_CHAIN_ID, assertRobinhoodChain, getLogsChunked, ostraVaultFactoryAbi, redact, retryingHttp, robinhoodChain, tideLeaf, tideLinkDeadline, tideVerify, type TidePayeeCreation } from "@ostraagent/sdk";
import { manualPayees } from "../src/tide-manual.ts";
import type { TideLinkRecord, TideWeekResult } from "../src/tide-score.ts";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

const ostraTideAbi = parseAbi([
  "struct Share { uint256 week; uint256 agentId; address payee; uint256 amount; }",
  "struct Week { bytes32 root; uint128 total; uint128 paid; uint64 rootAt; bool rolled; }",
  "function owner() view returns (address)",
  "function TOKEN() view returns (address)",
  "function FACTORY() view returns (address)",
  "function weekEnd(uint256 week) view returns (uint256)",
  "function potBalance(uint256 week) view returns (uint256)",
  "function weekInfo(uint256 week) view returns (Week)",
  "function rolloverAt(uint256 week) view returns (uint256)",
  "function paid(uint256 week, uint256 agentId) view returns (bool)",
  "function leaf(Share s) pure returns (bytes32)",
  "function setRoot(uint256 week, bytes32 root, uint256 total)",
  "function payMany(Share[] shares, bytes32[][] proofs, address[] vaults)",
  "function pay(Share s, bytes32[] proof, address vault)",
  "event Paid(uint256 indexed week, uint256 indexed agentId, address indexed vault, uint256 amount)",
]);
const vaultTokenAbi = parseAbi(["function token() view returns (address)"]);
const paidEvent = parseAbiItem("event Paid(uint256 indexed week, uint256 indexed agentId, address indexed vault, uint256 amount)");
/**
 * Gas one share of a payMany is counted at before it can be estimated (its root not set, or its payee not created
 * yet). A batch of three shares, one into a vault just created, used 265,200 gas on the fork (1 Nov 2026; a fork has
 * no L1 data gas); on Robinhood Chain calldata cost about 16.6 gas a byte then (eth_estimateGas, 1 Nov 2026), and a
 * share is about 480 bytes of calldata with its proof: 200,000 a share leaves room for an L1 fee many times higher.
 */
const PAY_SHARE_GAS = 200_000n;

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
  const manual = phase === "manual" || (phase === "check" && process.argv[3] === "manual");
  const weekText = (phase === "check" && manual ? process.argv[4] : process.argv[3]) ?? "";
  if ((phase !== "check" && phase !== "root" && phase !== "pay" && phase !== "manual") || !/^[1-9][0-9]{0,3}$/.test(weekText)) throw new Error("usage: node scripts/tide-pay.ts check|root|pay|manual <week>, or check manual <week>");
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
  // Payees with no code yet: created at payout with OstraTide's own factory (the one it checks a vault against).
  const factory = getAddress((await tide("FACTORY")) as Address);
  const toCreate: { agentId: string; payee: Address; creation: TidePayeeCreation; data: Hex }[] = [];
  for (const l of tree.leaves) {
    const payee = getAddress(l.payee);
    if (payee === ZERO) continue;
    const code = await client.getCode({ address: payee });
    if (code !== undefined && code !== "0x") continue;
    const c = shareOf.get(l.agentId)?.payeeCreation ?? null;
    if (c === null) {
      problems.push(`agent ${l.agentId}'s payee ${payee} has no code and the result names no creation params for it`);
      continue;
    }
    if (getAddress(c.token) !== OSTRA) {
      problems.push(`agent ${l.agentId}'s payee would be created in ${c.token}, not OSTRA`);
      continue;
    }
    const at = getAddress((await client.readContract({ address: factory, abi: ostraVaultFactoryAbi, functionName: "vaultAddress", args: [OSTRA, c.initialKeyRoot, c.initialCrank] })) as Address);
    if (at !== payee) {
      problems.push(`agent ${l.agentId}'s creation params create ${at} with OstraTide's factory, not its payee ${payee}`);
      continue;
    }
    toCreate.push({ agentId: l.agentId, payee, creation: c, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [OSTRA, c.initialKeyRoot, c.initialCrank] }) });
  }
  say(`week ${week}: ${tree.leaves.length} shares, total ${formatUnits(BigInt(tree.total), 18)} OSTRA of a pot of ${formatUnits(pot, 18)}, root ${tree.root}${ours ? " (set on chain)" : zeroRoot ? " (not set yet)" : ""}; ${waiting.length} without an OSTRA vault`);
  if (toCreate.length > 0) {
    const from = getAddress((await tide("owner")) as Address);
    let gas = 0n;
    for (const x of toCreate) gas += await client.estimateGas({ account: from, to: factory, data: x.data });
    say(`${toCreate.length} OSTRA vault(s) to create before their shares are paid: about ${gas} gas, ${formatEther(gas * (await client.getGasPrice()))} ETH at the current gas price, paid by the owner's account`);
  }
  if (problems.length > 0) {
    for (const p of problems) say(`PROBLEM ${p}`);
    throw new Error(`${problems.length} problem(s) with week ${week}'s result; nothing was sent`);
  }
  if (phase === "check" && !manual) {
    say("TIDE_CHECKED");
    return;
  }

  // --- manual: the shares without a payee ---------------------------------------------------------------------------
  let manualPlan: Awaited<ReturnType<typeof manualPayees>> = [];
  if (manual) {
    if (!ours) throw new Error(`week ${week}'s root on chain is not this result's yet (root first): nothing was sent`);
    const until = Number((await tide("rolloverAt", [BigInt(week)])) as bigint);
    const untilText = new Date(until * 1000).toISOString();
    if (Number(now) >= until) throw new Error(`week ${week} may roll over since ${untilText}: the owner can no longer pay its shares without a payee; nothing was sent`);
    const linksPath = process.env.OSTRA_TIDE_LINKS || "/var/lib/ostra-indexer/tide-links.json";
    let links: TideLinkRecord[] = [];
    try {
      await privateText(linksPath, "the Tide links");
      links = JSON.parse(await readFile(linksPath, "utf8")) as TideLinkRecord[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const own = new Set<Address>();
    for (const line of (await readFile(process.env.OSTRA_STATS_OWN || "/var/lib/ostra-stats/own.tsv", "utf8")).split("\n")) {
      const m = /^\s*(0x[0-9a-fA-F]{40})\b/.exec(line);
      if (m) own.add(getAddress(m[1] as Address));
    }
    if (own.size === 0) throw new Error("Ostra's own list names no vault: refusing to pay without it");
    const open = [];
    for (const l of waiting) if (!((await tide("paid", [BigInt(week), BigInt(l.agentId)])) as boolean)) open.push(l);
    manualPlan = await manualPayees({ client, factory, chainId: ROBINHOOD_CHAIN_ID, linkDeadline: tideLinkDeadline(week), now: Number(now), leaves: open, agents: result.agents, links, own });
    for (const m of manualPlan) {
      const amount = formatUnits(BigInt(m.amount), 18);
      if (m.payee === null) say(`agent ${m.agentId}: ${amount} OSTRA left alone (${m.why}); the owner can pay it until ${untilText}`);
      else say(`agent ${m.agentId}: ${amount} OSTRA to its OSTRA vault ${m.payee}${m.creation === null ? "" : ", created first"} (its link approved from ${new Date((m.setApprovedAt as number) * 1000).toISOString()})`);
    }
    say(`week ${week}: ${manualPlan.filter((m) => m.payee !== null).length} share(s) without a payee to pay, ${manualPlan.filter((m) => m.payee === null).length} left alone, ${waiting.length - open.length} paid already; the owner can pay them until ${untilText}`);
    if (phase === "check") {
      say("TIDE_MANUAL_CHECKED");
      return;
    }
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
    say(`SENT ${name}: ${hash} (${r.gasUsed} gas)`);
    testStop(`${name}:mined`);
    return r;
  };

  const paidPath = join(dir, `week-${week}.paid.json`);
  const rootStepName = `root:${week}:${tree.root}`;
  const paidFile: TidePaidFile = (await readJson<TidePaidFile>(paidPath)) ?? { week, root: tree.root, rootTx: null, paid: {} };
  if (paidFile.root.toLowerCase() !== tree.root.toLowerCase()) throw new Error(`${paidPath} records root ${paidFile.root}, not ${tree.root}; nothing was sent`);

  /** The Paid events of `logs` for this week, into the paid file; how many it lacked. */
  const recordPaid = (logs: readonly { address: Address; data: Hex; topics: readonly Hex[]; transactionHash: Hex | null }[]): number => {
    let added = 0;
    for (const log of logs) {
      if (getAddress(log.address) !== OSTRA_TIDE || log.transactionHash === null) continue;
      try {
        const e = decodeEventLog({ abi: ostraTideAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (e.eventName !== "Paid") continue;
        const a = e.args as { week: bigint; agentId: bigint; vault: Address; amount: bigint };
        if (Number(a.week) !== week) continue;
        if (paidFile.paid[a.agentId.toString()] === undefined) added++;
        paidFile.paid[a.agentId.toString()] = { tx: log.transactionHash, amount: a.amount.toString(), vault: getAddress(a.vault) };
      } catch {
        // another event of OstraTide's
      }
    }
    return added;
  };
  // The paid file filled from the chain: a run stopped after a transaction was mined and before the file was written
  // left its shares out (a run again does not send them again, they are paid). First the receipts of the payMany and
  // pay steps recorded here; then, for a share paid on chain the file still lacks (paid by anyone: payMany is open),
  // OstraTide's Paid event of it, searched from the block of the root (or, when this run did not record the root, the
  // first block at or after its rootAt).
  {
    let added = 0;
    for (const [name, hash] of Object.entries(kept)) {
      if (name.endsWith(":raw") || !(name.startsWith(`pay:${week}:`) || name.startsWith(`manual:${week}:`))) continue;
      const r = await client.getTransactionReceipt({ hash: hash as Hash }).catch(() => null);
      if (r !== null && r.status === "success") added += recordPaid(r.logs);
    }
    const lacking: string[] = [];
    for (const l of tree.leaves) {
      if (paidFile.paid[l.agentId] !== undefined) continue;
      if ((await tide("paid", [BigInt(week), BigInt(l.agentId)])) as boolean) lacking.push(l.agentId);
    }
    if (lacking.length > 0) {
      const rootHash = (paidFile.rootTx ?? kept[rootStepName]) as Hash | undefined;
      const rootReceipt = rootHash === undefined ? null : await client.getTransactionReceipt({ hash: rootHash }).catch(() => null);
      let from: bigint;
      if (rootReceipt !== null) from = rootReceipt.blockNumber;
      else {
        const rootAt = ((await tide("weekInfo", [BigInt(week)])) as { rootAt: bigint }).rootAt;
        let lo = 0n;
        let hi = await client.getBlockNumber({ cacheTime: 0 });
        while (lo < hi) {
          const mid = (lo + hi) / 2n;
          if ((await client.getBlock({ blockNumber: mid })).timestamp < rootAt) lo = mid + 1n;
          else hi = mid;
        }
        from = lo;
      }
      const to = await client.getBlockNumber({ cacheTime: 0 });
      const logs = await getLogsChunked(client, { address: OSTRA_TIDE, event: paidEvent, args: { week: BigInt(week) }, fromBlock: from, toBlock: to });
      added += recordPaid(logs.filter((l) => lacking.includes((l.args.agentId as bigint).toString())));
      for (const id of lacking) if (paidFile.paid[id] === undefined) throw new Error(`agent ${id}'s share is paid on chain but no Paid event of it was found since block ${from}; nothing was sent`);
    }
    if (added > 0) {
      await writePrivate(paidPath, paidFile);
      say(`${paidPath}: ${added} share(s) paid on chain recorded from the chain`);
    }
  }

  const rootStep = rootStepName;
  const rootData = encodeFunctionData({ abi: ostraTideAbi, functionName: "setRoot", args: [BigInt(week), tree.root, BigInt(tree.total)] });
  const unpaid = [];
  for (const l of tree.leaves) {
    if (getAddress(l.payee) === ZERO) continue;
    if ((await tide("paid", [BigInt(week), BigInt(l.agentId)])) as boolean) continue;
    unpaid.push(l);
  }
  const creates = [];
  for (const x of toCreate) if (unpaid.some((l) => l.agentId === x.agentId)) creates.push({ ...x, name: `create:${week}:${x.payee}` });
  // The steps' names name their shares: a run again forms the same batch of the same unpaid shares, so it finds its
  // recorded transaction; a batch whose share someone else paid meanwhile is a new batch (payMany skips a paid share).
  const batches = [];
  for (let i = 0; i < unpaid.length; i += batchSize) {
    const batch = unpaid.slice(i, i + batchSize);
    const name = `pay:${week}:${keccak256(`0x${Buffer.from(batch.map((l) => l.agentId).join(",")).toString("hex")}` as Hex).slice(0, 18)}`;
    const shares = batch.map((l) => ({ week: BigInt(week), agentId: BigInt(l.agentId), payee: getAddress(l.payee), amount: BigInt(l.amount) }));
    batches.push({ name, batch, data: encodeFunctionData({ abi: ostraTideAbi, functionName: "payMany", args: [shares, batch.map((l) => l.proof), batch.map(() => ZERO)] }) });
  }

  // Before anything is sent: the owner must hold what this run's transactions can cost, each at its gas limit (the
  // estimate and a fifth, as step signs it) and the current maximum fee per gas (a step recorded and not mined, at
  // its own signed limit and fee). A payMany that cannot be estimated yet (its root not set, or a payee still to be
  // created) is counted at PAY_SHARE_GAS a share.
  {
    const { maxFeePerGas } = await client.estimateFeesPerGas({ chain: robinhoodChain, type: "eip1559" });
    const steps: { name: string; to: Address; data: Hex; estimate: boolean }[] = [];
    if (!ours) steps.push({ name: rootStep, to: OSTRA_TIDE, data: rootData, estimate: true });
    if (phase === "pay") {
      for (const c of creates) {
        const code = await client.getCode({ address: c.payee });
        if (code === undefined || code === "0x") steps.push({ name: c.name, to: factory, data: c.data, estimate: true });
      }
      const later = new Set(creates.map((c) => c.payee));
      for (const b of batches) steps.push({ name: b.name, to: OSTRA_TIDE, data: b.data, estimate: ours && !b.batch.some((l) => later.has(getAddress(l.payee))) });
    }
    let need = 0n;
    for (const x of steps) {
      const raw = kept[`${x.name}:raw`] as Hex | undefined;
      if (raw !== undefined) {
        if (await client.getTransactionReceipt({ hash: keccak256(raw) }).then(() => true, () => false)) continue;
        const t = parseTransaction(raw);
        need += (t.gas ?? 0n) * (t.maxFeePerGas ?? t.gasPrice ?? 0n);
        continue;
      }
      const shares = batches.find((b) => b.name === x.name)?.batch.length ?? 0;
      const gas = x.estimate ? await client.estimateGas({ account: owner.address, to: x.to, data: x.data }) : PAY_SHARE_GAS * BigInt(shares);
      need += (gas + gas / 5n) * maxFeePerGas;
    }
    const have = await client.getBalance({ address: owner.address });
    if (have < need) {
      throw new Error(`the owner ${owner.address} holds ETH ${formatEther(have)}; this run's ${steps.length} transaction(s) can cost up to ETH ${formatEther(need)}: send it ETH ${formatEther(need - have)} more first; nothing was sent`);
    }
  }

  if (!ours) {
    const r = await step(rootStep, { to: OSTRA_TIDE, data: rootData });
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

  /** An agent's OSTRA vault with no code created once (its step named by the vault), then checked: the payee, in OSTRA. */
  const createPayee = async (x: { agentId: string; payee: Address; name: string; data: Hex }) => {
    const code = await client.getCode({ address: x.payee });
    if (code === undefined || code === "0x") {
      const r = await step(x.name, { to: factory, data: x.data });
      for (const log of r.logs) {
        if (getAddress(log.address) !== factory) continue;
        let vault: Address | null = null;
        try {
          const e = decodeEventLog({ abi: ostraVaultFactoryAbi, data: log.data, topics: log.topics });
          if (e.eventName === "VaultCreated") vault = getAddress((e.args as { vault: Address }).vault);
        } catch {
          // another event of the factory's
        }
        if (vault !== null && vault !== x.payee) throw new Error(`the factory created ${vault}, not agent ${x.agentId}'s payee ${x.payee}`);
      }
    }
    const made = await client.getCode({ address: x.payee });
    if (made === undefined || made === "0x") throw new Error(`agent ${x.agentId}'s payee ${x.payee} has no code after its creation`);
    const token = getAddress((await client.readContract({ address: x.payee, abi: vaultTokenAbi, functionName: "token" })) as Address);
    if (token !== OSTRA) throw new Error(`agent ${x.agentId}'s payee ${x.payee} holds ${token}, not OSTRA`);
    say(`agent ${x.agentId}: its OSTRA vault ${x.payee} exists`);
  };

  // --- manual: each share without a payee paid by the owner to the vault its agent's late link names ----------------
  if (phase === "manual") {
    const toPay = [];
    for (const m of manualPlan) {
      if (m.payee === null) continue;
      const payee = m.payee;
      const share = { week: BigInt(week), agentId: BigInt(m.agentId), payee: ZERO, amount: BigInt(m.amount) };
      toPay.push({
        m,
        payee,
        create: m.creation === null ? null : { agentId: m.agentId, payee, name: `create:${week}:${payee}`, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [OSTRA, m.creation.initialKeyRoot, m.creation.initialCrank] }) },
        // Named by the agent alone: a run again sends the transaction it recorded, whatever vault a newer link names.
        name: `manual:${week}:${m.agentId}`,
        data: encodeFunctionData({ abi: ostraTideAbi, functionName: "pay", args: [share, m.proof, payee] }),
      });
    }
    // The owner must hold what these transactions can cost, as for pay (a pay whose vault is still to be created is
    // counted at PAY_SHARE_GAS).
    {
      const { maxFeePerGas } = await client.estimateFeesPerGas({ chain: robinhoodChain, type: "eip1559" });
      let need = 0n;
      let count = 0;
      for (const x of toPay) {
        const later = x.create !== null && ((await client.getCode({ address: x.payee })) ?? "0x") === "0x";
        const txs = [...(later && x.create !== null ? [{ name: x.create.name, to: factory, data: x.create.data, estimate: true }] : []), { name: x.name, to: OSTRA_TIDE, data: x.data, estimate: !later }];
        for (const t of txs) {
          const raw = kept[`${t.name}:raw`] as Hex | undefined;
          if (raw !== undefined) {
            if (await client.getTransactionReceipt({ hash: keccak256(raw) }).then(() => true, () => false)) continue;
            const p = parseTransaction(raw);
            need += (p.gas ?? 0n) * (p.maxFeePerGas ?? p.gasPrice ?? 0n);
            count++;
            continue;
          }
          if (t.name === x.name && ((await tide("paid", [BigInt(week), BigInt(x.m.agentId)])) as boolean)) continue;
          const gas = t.estimate ? await client.estimateGas({ account: owner.address, to: t.to, data: t.data }) : PAY_SHARE_GAS;
          need += (gas + gas / 5n) * maxFeePerGas;
          count++;
        }
      }
      const have = await client.getBalance({ address: owner.address });
      if (have < need) throw new Error(`the owner ${owner.address} holds ETH ${formatEther(have)}; this run's ${count} transaction(s) can cost up to ETH ${formatEther(need)}: send it ETH ${formatEther(need - have)} more first; nothing was sent`);
    }
    for (const x of toPay) {
      // Never twice: a share paid on chain is not paid again (its Paid event is in the paid file), and a pay recorded
      // and not mined is sent as it was signed.
      if ((await tide("paid", [BigInt(week), BigInt(x.m.agentId)])) as boolean) {
        say(`agent ${x.m.agentId}: its share is paid already`);
        continue;
      }
      if (x.create !== null) await createPayee(x.create);
      const r = await step(x.name, { to: OSTRA_TIDE, data: x.data });
      recordPaid(r.logs);
      await writePrivate(paidPath, paidFile);
    }
    for (const x of toPay) if (!((await tide("paid", [BigInt(week), BigInt(x.m.agentId)])) as boolean)) throw new Error(`agent ${x.m.agentId}'s share is not paid after this run`);
    const info3 = (await tide("weekInfo", [BigInt(week)])) as { paid: bigint; total: bigint };
    say(`week ${week}: paid ${formatUnits(info3.paid, 18)} of ${formatUnits(info3.total, 18)} OSTRA; ${toPay.length} share(s) without a payee paid by the owner, ${manualPlan.length - toPay.length} left alone`);
    say(`owner ${owner.address}: ETH ${formatEther(await client.getBalance({ address: owner.address }))}`);
    say("TIDE_MANUAL_PAID");
    return;
  }

  // --- the shares ------------------------------------------------------------------------------------------------------
  // The OSTRA vaults of unpaid shares that do not exist yet, each created once (its step named by the vault): a run
  // again finds the vault there, or sends the very transaction it recorded. Then the vault there must be the payee,
  // in OSTRA (created by this run or anyone: createVault returns a vault that exists).
  for (const x of creates) await createPayee(x);
  for (const { name, data } of batches) {
    const r = await step(name, { to: OSTRA_TIDE, data });
    recordPaid(r.logs);
    await writePrivate(paidPath, paidFile);
  }
  // Every share with a payee is paid on chain now (by this run or anyone: payMany skips a paid share).
  for (const l of tree.leaves) {
    if (getAddress(l.payee) === ZERO) continue;
    if (!((await tide("paid", [BigInt(week), BigInt(l.agentId)])) as boolean)) throw new Error(`agent ${l.agentId}'s share is not paid after this run`);
  }
  const info2 = (await tide("weekInfo", [BigInt(week)])) as { paid: bigint; total: bigint };
  say(`week ${week}: paid ${formatUnits(info2.paid, 18)} of ${formatUnits(info2.total, 18)} OSTRA; ${Object.keys(paidFile.paid).length} shares recorded paid`);
  for (const l of waiting) if (!((await tide("paid", [BigInt(week), BigInt(l.agentId)])) as boolean)) say(`agent ${l.agentId}: ${formatUnits(BigInt(l.amount), 18)} OSTRA waits for an OSTRA vault (manual pays it to the vault its agent links after the link deadline, before the hold ends)`);
  say(`owner ${owner.address}: ETH ${formatEther(await client.getBalance({ address: owner.address }))}`);
  say("TIDE_PAID");
}

main().catch((err: unknown) => {
  console.error(scrub(`STOPPED: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
