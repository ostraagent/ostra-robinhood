// The Tide payout (scripts/tide-pay.ts) run as on the VPS, on a fork of Robinhood Chain mainnet against the live
// OstraTide, its live week 1 pot (5,000,000 OSTRA), two live OSTRA vaults of the live OstraVaultFactory as payees, and
// a third payee that does not exist yet: the OSTRA vault an agent's seed creates (core's VaultService, as the MCP
// derives it), named by its createVault params as the score carries them.
// OstraTide's owner is set to a test account on the fork (its Ownable slot), since the deployer's key is not here.
//   * Before week 1 ends the check refuses and nothing is sent; OstraTide itself refuses setRoot (NotEnded).
//   * A result read after the week but before its link deadline (the end + 23 hours) is refused too.
//   * A payee with no code whose result has no creation params, or params that create another vault, is refused.
//   * After the deadline: check passes and counts the vault to create; root posts the tree's root and total; pay
//     refuses before sending anything while the owner holds less ETH than the run can cost (a creation signed and not
//     sent counted at its own limit), and resumes once funded; pay,
//     stopped after the vault's creation was signed, sends that very transaction on the next run, which creates the
//     agent's OSTRA vault (its key root the agent's) and stops after the batch was signed; the run after sends that
//     signed batch and pays each payee exactly its share, the new vault included, leaving a share without a payee
//     unpaid and listed; a run again sends nothing; week-1.paid.json records the root's and the batch's transactions.
//   * The run that sends the batch stops right after its receipt, before week-1.paid.json is written (as a crash
//     would): the next run fills the file from the batch's recorded receipt; with the file's entries and the recorded
//     batch removed, a run fills them again from OstraTide's Paid events.
//   * A share without a payee (manual): agent L (a live ERC-8004 identity registered by its live creator vault) links
//     after the link deadline, naming the OSTRA vault its seed creates (not created yet): check manual lists what it
//     would do and sends nothing; manual creates that vault and pays L's share to it through OstraTide.pay with the
//     vault named; a run again sends nothing; agent 990003, which never linked, is listed with the time the owner can
//     pay it until and left alone. Before L's link that counts, each link that does not count is listed with why and
//     nothing is sent: one its identity vault never approved, one approved before the link deadline (the score read
//     it), one naming one of Ostra's own vaults or another agent's identity vault as its payee, one naming a vault of
//     the link without that vault's member approval, and the identity no longer owned by its identity vault (the
//     result names another one).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { decodeEventLog, encodeFunctionData, erc20Abi, getAddress, keccak256, numberToHex, pad, parseAbi, parseAbiItem, sha256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  OSTRA,
  OSTRA_TIDE,
  USDG,
  VAULT_ACTION,
  approveHashParams,
  ostraVaultAbi,
  padCidFromDigest,
  parseDeployment,
  registerAgentParams,
  retryingHttp,
  signVaultSpend,
  simulateVaultSpend,
  tideLinkDeadline,
  tidePayeeVault,
  tideSetDigest,
  tideTree,
  tideWeekSpan,
} from "@ostraagent/sdk";
import { rpc, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, VaultService, X402_NETWORK, spendCall, type Config } from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";

const run = promisify(execFile);
const FACTORY: Address = "0x043a15c514CFE2c797d33520bFF91a5DCdbf2979";
const FACTORY_FROM = 91_991_509n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ownerKey = keccak256(stringToHex("OSTRA/KEEPER/TIDE-PAY-FORK/owner"));
const EARLY_SECRET = keccak256(stringToHex("OSTRA/KEEPER/TIDE-PAY-FORK/early-secret"));
const OWN_VAULT = getAddress("0x00000000000000000000000000000000000000aa");
const owner = privateKeyToAccount(ownerKey);
const tideAbi = parseAbi([
  "struct Week { bytes32 root; uint128 total; uint128 paid; uint64 rootAt; bool rolled; }",
  "function owner() view returns (address)",
  "function weekInfo(uint256 week) view returns (Week)",
  "function paid(uint256 week, uint256 agentId) view returns (bool)",
  "function potBalance(uint256 week) view returns (uint256)",
  "function setRoot(uint256 week, bytes32 root, uint256 total)",
]);

const live = parseDeployment(JSON.parse(readFileSync(new URL("../../deployments/robinhood-mainnet.json", import.meta.url), "utf8")));

let fork: Fork;
let root: string;
let payees: Address[] = [];
/** The agent whose OSTRA vault does not exist yet: its token vault service, as the MCP has it. */
let fresh: VaultService;
/** Agent L (manual): its identity, its creator vault (the identity vault) and its OSTRA vault, not created. */
let lateId: bigint;
let lateCreator: VaultService;
let lateSender: LocalSender;
let lateOstra: VaultService;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-tide-pay-"));
  fork = await startFork();
  // The owner, a test account: OpenZeppelin Ownable's _owner is slot 0.
  await rpc(fork.url, "anvil_setStorageAt", [OSTRA_TIDE, "0x0", pad(owner.address)]);
  assert.equal(getAddress((await fork.client.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "owner" })) as Address), owner.address);
  await fork.setBalance(owner.address, 10n ** 17n);
  // Two live OSTRA vaults of the live factory.
  // The public RPC answers at most 10,000,000 blocks per search: two halves.
  const head = await fork.client.getBlockNumber();
  const mid = FACTORY_FROM + (head - FACTORY_FROM) / 2n;
  const event = parseAbiItem("event VaultCreated(address indexed vault, address indexed token, bytes32 initialKeyRoot, address initialCrank)");
  const created = [
    ...(await fork.client.getLogs({ address: FACTORY, event, args: { token: OSTRA }, fromBlock: FACTORY_FROM, toBlock: mid })),
    ...(await fork.client.getLogs({ address: FACTORY, event, args: { token: OSTRA }, fromBlock: mid + 1n, toBlock: head })),
  ];
  payees = created.map((l) => getAddress(l.args.vault as Address)).slice(0, 2);
  assert.equal(payees.length, 2, "two live OSTRA vaults");
  // An agent with no OSTRA vault: its seed's OSTRA token vault (the payee its link names), not created.
  const config: Config = { chainId: live.chainId, rpcUrl: fork.url, deployment: live, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/KEEPER/TIDE-PAY-FORK/fee-payer")));
  const keys = new Keys({ master: new Uint8Array(32).fill(77), feePayer, store: new FileWotsStore(join(root, "wots")), folder: new MemoryFolder(), backupExported: async () => true });
  const transport = retryingHttp(fork.url);
  fresh = new VaultService(fork.client as PublicClient, transport, config, keys, new LocalSender(fork.client as PublicClient, transport, feePayer), "token", null, OSTRA);
  assert.equal(await fork.client.getCode({ address: await fresh.vaultAddress() }), undefined, "the agent's OSTRA vault does not exist");
  // Agent L: its creator vault registers it in the live ERC-8004 registry; its OSTRA vault is not created.
  await fork.setBalance(feePayer.address, 10n ** 18n);
  const lateKeys = new Keys({ master: new Uint8Array(32).fill(78), feePayer, store: new FileWotsStore(join(root, "wots-late")), folder: new MemoryFolder(), backupExported: async () => true });
  lateSender = new LocalSender(fork.client as PublicClient, transport, feePayer);
  lateCreator = new VaultService(fork.client as PublicClient, transport, config, await lateKeys.forCreatorVault(live.chainId, USDG), lateSender, "creator");
  lateOstra = new VaultService(fork.client as PublicClient, transport, config, lateKeys, lateSender, "token", null, OSTRA);
  await lateCreator.open();
  const creatorAt = getAddress(await lateCreator.vaultAddress());
  const tx = await spend(lateCreator, VAULT_ACTION.REGISTER_AGENT, registerAgentParams(padCidFromDigest(sha256(stringToHex('{"name":"L"}')))));
  for (const log of (await fork.client.getTransactionReceipt({ hash: tx })).logs) {
    if (getAddress(log.address) !== creatorAt) continue;
    try {
      const e = decodeEventLog({ abi: ostraVaultAbi, data: log.data, topics: log.topics });
      if (e.eventName === "AgentRegistered") lateId = (e.args as { agentId: bigint }).agentId;
    } catch {
      // another event
    }
  }
  assert.ok(lateId !== undefined, "agent L is registered");
  assert.equal(await fork.client.getCode({ address: await lateOstra.vaultAddress() }), undefined, "L has no OSTRA vault");
  // A link of L approved before the link deadline (the fork is still in week 1): the score read it, manual does not.
  await spend(lateCreator, VAULT_ACTION.APPROVE_HASH, approveHashParams({ hash: tideSetDigest({ chainId: live.chainId, agentId: lateId, vaults: [creatorAt], payee: getAddress(await lateOstra.vaultAddress()), secret: EARLY_SECRET, outsidePayee: true }), approved: true }));
  await writeFile(join(root, "tide-links.json"), "[]", { mode: 0o600 });
  await writeFile(join(root, "own.tsv"), "0x00000000000000000000000000000000000000aa\tOstra's own (test)\n", { mode: 0o600 });
  await writeFile(join(root, "rpc.url"), `${fork.url}\n`, { mode: 0o600 });
  await writeFile(join(root, "owner.key"), `${ownerKey}\n`, { mode: 0o600 });
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** One spend of `vault` (simulated first for its gas), from its LocalSender. */
async function spend(vault: VaultService, action: number, params: Hex): Promise<Hex> {
  const at = await vault.vaultAddress();
  const sim = await simulateVaultSpend(fork.client as PublicClient, live, { relayer: await lateSender.payer(), vault: at, action, params });
  const r = await vault.operate({ gas: (sim.gasUsed * 5n) / 4n + 100_000n, what: "spend", build: async ({ v, vault: a, keychain, chainId }) => [spendCall(a, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))] });
  assert.equal(r.status, "sent", JSON.stringify(r));
  return (r as { txHash: Hex }).txHash;
}

async function pay(phase: "check" | "root" | "pay" | "manual" | "check manual", stopAt?: string): Promise<{ ok: boolean; out: string }> {
  const env = {
    ...process.env,
    OSTRA_RPC_URL_FILE: join(root, "rpc.url"),
    OSTRA_DEPLOYER_KEY_FILE: join(root, "owner.key"),
    OSTRA_TIDE_RESULTS: root,
    OSTRA_TIDE_PAY_BATCH: "20",
    OSTRA_TIDE_TEST_STOP: stopAt ?? "",
    OSTRA_TIDE_LINKS: join(root, "tide-links.json"),
    OSTRA_STATS_OWN: join(root, "own.tsv"),
  };
  try {
    const r = await run(process.execPath, ["scripts/tide-pay.ts", ...phase.split(" "), "1"], { env, cwd: join(import.meta.dirname, ".."), timeout: 600_000 });
    return { ok: true, out: r.stdout + r.stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const ostra = (a: Address) => fork.client.readContract({ address: OSTRA, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const nonce = () => fork.client.getTransactionCount({ address: owner.address });

test("week 1 is posted and paid from the scorer's result: checks, root, a stopped pay finished, the paid file filled from the chain, a share without a payee paid after a late link, nothing twice", { timeout: 1_800_000 }, async () => {
  const c = fork.client;
  const pot = (await c.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "potBalance", args: [1n] })) as bigint;
  assert.ok(pot >= 3_000_000n * 10n ** 18n, `the live pot holds ${pot}`);
  const creation = fresh.creationParams();
  const created = getAddress(await fresh.vaultAddress());
  assert.equal(tidePayeeVault(live, creation), created);
  const shares = [
    { week: 1, agentId: "990001", payee: payees[0]!, amount: 1_000_000n * 10n ** 18n + 7n },
    { week: 1, agentId: "990002", payee: payees[1]!, amount: 600_000n * 10n ** 18n },
    { week: 1, agentId: "990003", payee: ZERO, amount: 400_000n * 10n ** 18n },
    { week: 1, agentId: "990004", payee: created, amount: 300_000n * 10n ** 18n + 3n },
    { week: 1, agentId: lateId.toString(), payee: ZERO, amount: 200_000n * 10n ** 18n + 5n },
  ];
  const lateCreatorAt = getAddress(await lateCreator.vaultAddress());
  const tree = tideTree(shares);
  const total = shares.reduce((s, x) => s + x.amount, 0n);
  const { start, end } = tideWeekSpan(1);
  const result = {
    week: 1,
    start,
    end,
    at: tideLinkDeadline(1) + 60,
    block: "0",
    final: true,
    pot: pot.toString(),
    totalPoints: "3",
    shared: total.toString(),
    agents: shares.map((s) => ({
      agentId: s.agentId,
      identityVault: s.agentId === lateId.toString() ? lateCreatorAt : s.agentId === "990002" ? payees[1]! : ZERO,
      registeredAt: start,
      link: { status: "none" },
      vaults: [],
      payee: s.payee === ZERO ? null : s.payee,
      payeeCreation: s.payee === created ? creation : null,
      breakdown: {},
      share: s.amount.toString(),
      dropped: [],
    })),
    excluded: [],
    tree: { root: tree.root, total: total.toString(), leaves: shares.map((s) => ({ agentId: s.agentId, payee: s.payee, amount: s.amount.toString(), proof: tree.proofs.get(s.agentId)! })) },
  };
  await writeFile(join(root, "week-1.json"), JSON.stringify(result), { mode: 0o600 });

  // Before the week ends (the fork is at the live chain's time, in week 1): refused, nothing sent.
  const now = Number((await c.getBlock()).timestamp);
  assert.ok(now < end, "the fork is still in week 1");
  let r = await pay("check");
  assert.ok(!r.ok && /ends at .*: not yet/.test(r.out), r.out);
  r = await pay("root");
  assert.ok(!r.ok && r.out.includes("nothing was sent"), r.out);
  assert.equal(await nonce(), 0);
  await assert.rejects(
    c.call({ account: owner.address, to: OSTRA_TIDE, data: encodeFunctionData({ abi: tideAbi, functionName: "setRoot", args: [1n, tree.root, total] }) }),
    /NotEnded|revert/,
  );

  // After the week, a result read before the link deadline: refused.
  await rpc(fork.url, "anvil_setNextBlockTimestamp", [numberToHex(tideLinkDeadline(1) + 60)]);
  await rpc(fork.url, "evm_mine", []);
  await writeFile(join(root, "week-1.json"), JSON.stringify({ ...result, at: end + 60 }), { mode: 0o600 });
  r = await pay("check");
  assert.ok(!r.ok && r.out.includes("before the link deadline"), r.out);
  assert.equal(await nonce(), 0);

  // A payee with no code: refused without its creation params, or with params that create another vault.
  const agentsWith = (c4: unknown) => result.agents.map((a) => (a.agentId === "990004" ? { ...a, payeeCreation: c4 } : a));
  for (const [c4, why] of [
    [null, "agent 990004's payee " + created + " has no code and the result names no creation params for it"],
    [{ ...creation, initialKeyRoot: keccak256(stringToHex("another key")) }, "agent 990004's creation params create "],
  ] as const) {
    await writeFile(join(root, "week-1.json"), JSON.stringify({ ...result, agents: agentsWith(c4) }), { mode: 0o600 });
    r = await pay("check");
    assert.ok(!r.ok && r.out.includes(why), r.out);
  }
  assert.equal(await nonce(), 0);

  // A result read after the deadline: check, root, pay.
  await writeFile(join(root, "week-1.json"), JSON.stringify(result), { mode: 0o600 });
  r = await pay("check");
  assert.ok(r.ok && r.out.includes("TIDE_CHECKED") && r.out.includes("2 without an OSTRA vault"), r.out);
  assert.match(r.out, /1 OSTRA vault\(s\) to create before their shares are paid: about [0-9]+ gas, [0-9.]+ ETH/);
  r = await pay("root");
  assert.ok(r.ok && r.out.includes("TIDE_ROOT_SET"), r.out);
  const info = (await c.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "weekInfo", args: [1n] })) as { root: Hex; total: bigint };
  assert.equal(info.root, tree.root);
  assert.equal(info.total, total);
  assert.equal(await nonce(), 1);
  const before0 = await ostra(payees[0]!);
  const before1 = await ostra(payees[1]!);
  // The owner short of ETH for the creation and the batch: refused before anything is signed or sent.
  const broke = async () => {
    await fork.setBalance(owner.address, 1_000n);
    const x = await pay("pay");
    assert.ok(!x.ok && /holds ETH 0\.000000000000001; this run's 2 transaction\(s\) can cost up to ETH [0-9.]+: send it ETH [0-9.]+ more first; nothing was sent/.test(x.out), x.out);
    assert.equal(await nonce(), 1, "nothing sent");
    await fork.setBalance(owner.address, 10n ** 17n);
  };
  await broke();
  assert.equal(JSON.parse(await readFile(join(root, "tide-pay.json"), "utf8"))[`create:1:${created}`], undefined, "nothing signed");
  // Stopped after the vault's creation was signed: nothing sent; the next run sends that very transaction.
  const create = `create:1:${created}`;
  r = await pay("pay", `${create}:signed`);
  assert.ok(!r.ok && r.out.includes(`TEST STOP at ${create}:signed`), r.out);
  assert.equal(await nonce(), 1, "signed, not sent");
  assert.equal(await c.getCode({ address: created }), undefined);
  const createSigned = (JSON.parse(await readFile(join(root, "tide-pay.json"), "utf8")) as Record<string, string>)[create];
  assert.match(createSigned ?? "", /^0x[0-9a-f]{64}$/);
  // Short of ETH again with the creation recorded: refused (it is counted at its own signed limit), then resumed.
  await broke();
  // Then stopped after the batch was signed: the vault created, nothing paid yet; the next run sends that very batch.
  const batch = `pay:1:${keccak256(stringToHex("990001,990002,990004")).slice(0, 18)}`;
  r = await pay("pay", `${batch}:signed`);
  assert.ok(!r.ok && r.out.includes(`SENT ${create}: ${createSigned}`) && r.out.includes(`TEST STOP at ${batch}:signed`), r.out);
  assert.equal(await nonce(), 2, "the creation sent, the batch signed and not sent");
  // The vault there is the agent's: its OSTRA vault, keyed by its seed's key 0, as its own service reads it.
  assert.equal(getAddress((await c.readContract({ address: created, abi: ostraVaultAbi, functionName: "token" })) as Address), OSTRA);
  assert.equal(((await c.readContract({ address: created, abi: ostraVaultAbi, functionName: "keyRoot" })) as Hex).toLowerCase(), creation.initialKeyRoot.toLowerCase());
  assert.deepEqual(await fresh.state(), { vault: created, exists: true, nonce: 0n, balance: 0n, pendingAction: null });
  assert.equal(await ostra(payees[0]!), before0);
  const kept = JSON.parse(await readFile(join(root, "tide-pay.json"), "utf8")) as Record<string, string>;
  const signed = kept[batch];
  assert.match(signed ?? "", /^0x[0-9a-f]{64}$/);
  // Stopped right after the batch's receipt, before week-1.paid.json is written (as a crash would leave it).
  r = await pay("pay", `${batch}:mined`);
  assert.ok(!r.ok && r.out.includes(`SENT ${batch}: ${signed}`) && !r.out.includes(`SENT ${create}`) && r.out.includes(`TEST STOP at ${batch}:mined`), r.out);
  const stopped = JSON.parse(await readFile(join(root, "week-1.paid.json"), "utf8")) as { paid: Record<string, unknown> };
  assert.deepEqual(stopped.paid, {}, "the batch is paid on chain and not in the file yet");
  // The next run fills the file from the batch's recorded receipt and sends nothing.
  r = await pay("pay");
  assert.ok(r.ok && r.out.includes("TIDE_PAID") && /week-1\.paid\.json: 3 share\(s\) paid on chain recorded from the chain/.test(r.out) && !r.out.includes("SENT "), r.out);
  assert.equal(await ostra(payees[0]!), before0 + shares[0]!.amount, "payee 1 paid its share exactly");
  assert.equal(await ostra(payees[1]!), before1 + shares[1]!.amount, "payee 2 paid its share exactly");
  assert.equal(await ostra(created), shares[3]!.amount, "the vault created at payout paid its share exactly");
  assert.equal((await fresh.state()).balance, shares[3]!.amount);
  for (const id of [990001n, 990002n, 990004n]) assert.equal(await c.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "paid", args: [1n, id] }), true);
  assert.equal(await c.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "paid", args: [1n, 990003n] }), false, "no payee: not paid");
  assert.match(r.out, /agent 990003: 400000 OSTRA waits for an OSTRA vault/);
  assert.match(r.out, new RegExp(`agent ${lateId}: 200000\\.000000000000000005 OSTRA waits for an OSTRA vault`));
  assert.equal(await nonce(), 3);
  const paidFile = JSON.parse(await readFile(join(root, "week-1.paid.json"), "utf8")) as { root: Hex; rootTx: Hex; paid: Record<string, { tx: Hex; amount: string; vault: Address }> };
  assert.equal(paidFile.root, tree.root);
  assert.match(paidFile.rootTx, /^0x[0-9a-f]{64}$/);
  assert.equal(paidFile.paid["990001"]?.amount, shares[0]!.amount.toString());
  assert.equal(paidFile.paid["990002"]?.vault, payees[1]);
  assert.equal(paidFile.paid["990004"]?.vault, created);
  assert.equal(paidFile.paid["990003"], undefined);
  // A run again of every phase sends nothing (the vault exists: no creation either).
  for (const p of ["check", "root", "pay"] as const) {
    r = await pay(p);
    assert.ok(r.ok, r.out);
    assert.ok(!r.out.includes("to create before their shares are paid"), r.out);
  }
  assert.equal(await nonce(), 3, "nothing sent again");
  assert.equal(r.out.includes(fork.url), false, "the RPC URL is never printed");

  // The paid file's entries and the recorded batch removed: a run fills them again from OstraTide's Paid events.
  const full = JSON.parse(await readFile(join(root, "week-1.paid.json"), "utf8")) as { paid: Record<string, unknown> };
  await writeFile(join(root, "week-1.paid.json"), JSON.stringify({ ...full, paid: {} }), { mode: 0o600 });
  const keptNow = JSON.parse(await readFile(join(root, "tide-pay.json"), "utf8")) as Record<string, string>;
  for (const k of Object.keys(keptNow)) if (k.startsWith("pay:")) delete keptNow[k];
  await writeFile(join(root, "tide-pay.json"), JSON.stringify(keptNow), { mode: 0o600 });
  r = await pay("pay");
  assert.ok(r.ok && /3 share\(s\) paid on chain recorded from the chain/.test(r.out), r.out);
  assert.deepEqual(JSON.parse(await readFile(join(root, "week-1.paid.json"), "utf8")).paid, full.paid, "the same entries, read from the Paid events");
  assert.equal(await nonce(), 3);

  // Manual: L has linked nothing yet; 990003 never links. check manual lists both, left alone, and sends nothing.
  const lateRoot = await c.readContract({ address: OSTRA_TIDE, abi: parseAbi(["function rolloverAt(uint256 week) view returns (uint256)"]), functionName: "rolloverAt", args: [1n] });
  const until = new Date(Number(lateRoot) * 1000).toISOString();
  r = await pay("check manual");
  assert.ok(r.ok && r.out.includes("TIDE_MANUAL_CHECKED"), r.out);
  assert.ok(r.out.includes(`agent ${lateId}: 200000.000000000000000005 OSTRA left alone (no link made after the link deadline ${new Date(tideLinkDeadline(1) * 1000).toISOString()}); the owner can pay it until ${until}`), r.out);
  assert.ok(new RegExp(`agent 990003: 400000 OSTRA left alone \\(.+\\); the owner can pay it until ${until.replace(/\./g, "\\.")}`).test(r.out), r.out);
  // L links after the deadline: its identity vault approves the set digest naming the OSTRA vault its seed creates
  // (outside the list, by its creation params), and the index keeps the link.
  const secret = keccak256(stringToHex("OSTRA/KEEPER/TIDE-PAY-FORK/late-secret"));
  const lateCreation = lateOstra.creationParams();
  const lateVault = getAddress(await lateOstra.vaultAddress());
  assert.equal(tidePayeeVault(live, lateCreation), lateVault);

  // Links that do not count, each listed with why; nothing is sent.
  const deadlineText = new Date(tideLinkDeadline(1) * 1000).toISOString();
  const nonceNegative = await nonce();
  const approveSet = async (x: { secret: Hex; vaults: Address[]; payee: Address; outside: boolean }) =>
    spend(lateCreator, VAULT_ACTION.APPROVE_HASH, approveHashParams({ hash: tideSetDigest({ chainId: live.chainId, agentId: lateId, vaults: [lateCreatorAt, ...x.vaults], payee: x.payee, secret: x.secret, outsidePayee: x.outside }), approved: true }));
  const leftAlone = async (records: unknown[], why: string, resultFile?: unknown) => {
    await writeFile(join(root, "tide-links.json"), JSON.stringify(records), { mode: 0o600 });
    if (resultFile !== undefined) await writeFile(join(root, "week-1.json"), JSON.stringify(resultFile), { mode: 0o600 });
    const x = await pay("check manual");
    if (resultFile !== undefined) await writeFile(join(root, "week-1.json"), JSON.stringify(result), { mode: 0o600 });
    assert.ok(x.ok && x.out.includes(`agent ${lateId}: 200000.000000000000000005 OSTRA left alone (`) && x.out.includes(why), `${why}\n${x.out}`);
  };
  const link = (secretOf: Hex, vaults: Address[], payee: Address, payeeCreation?: unknown) => ({ agentId: lateId.toString(), secret: secretOf, vaults, payee, ...(payeeCreation === undefined ? {} : { payeeCreation }), at: Number((Date.now() / 1000).toFixed(0)) });
  // Never approved by the identity vault.
  await leftAlone([link(keccak256(stringToHex("not approved")), [], lateVault, lateCreation)], `the identity vault ${lateCreatorAt} has no approval of a link's set digest naming ${lateVault} in force now`);
  // Approved before the deadline (in before()): the score read it.
  await leftAlone([link(EARLY_SECRET, [], lateVault, lateCreation)], `the link naming ${lateVault} was in force by the link deadline ${deadlineText}: the score read it`);
  // One of Ostra's own vaults as the payee.
  const ownSecret = keccak256(stringToHex("OSTRA/KEEPER/TIDE-PAY-FORK/own-secret"));
  await approveSet({ secret: ownSecret, vaults: [], payee: OWN_VAULT, outside: true });
  await leftAlone([link(ownSecret, [], OWN_VAULT, lateCreation)], `${OWN_VAULT} is one of Ostra's own vaults`);
  // Another agent's identity vault as the payee (990002's, as the result names it).
  const idSecret = keccak256(stringToHex("OSTRA/KEEPER/TIDE-PAY-FORK/identity-secret"));
  await approveSet({ secret: idSecret, vaults: [], payee: payees[1]!, outside: true });
  await leftAlone([link(idSecret, [], payees[1]!, lateCreation)], `${payees[1]} is another agent's identity vault`);
  // A vault of the link (a live OSTRA vault) as the payee, without that vault's member approval.
  const memberSecret = keccak256(stringToHex("OSTRA/KEEPER/TIDE-PAY-FORK/member-secret"));
  await approveSet({ secret: memberSecret, vaults: [payees[0]!], payee: payees[0]!, outside: false });
  await leftAlone([link(memberSecret, [payees[0]!], payees[0]!)], `${payees[0]} has no approval of its member digest in force now`);
  // The identity no longer owned by the vault the result names.
  await leftAlone(
    [link(memberSecret, [payees[0]!], payees[0]!)],
    `its identity is now owned by ${lateCreatorAt}, not its identity vault ${payees[0]}`,
    { ...result, agents: result.agents.map((a) => (a.agentId === lateId.toString() ? { ...a, identityVault: payees[0]! } : a)) },
  );
  assert.equal(await nonce(), nonceNegative, "check manual sends nothing");
  const digest = tideSetDigest({ chainId: live.chainId, agentId: lateId, vaults: [lateCreatorAt], payee: lateVault, secret, outsidePayee: true });
  await spend(lateCreator, VAULT_ACTION.APPROVE_HASH, approveHashParams({ hash: digest, approved: true }));
  const linkedAt = Number((await c.getBlock()).timestamp);
  assert.ok(linkedAt > tideLinkDeadline(1), "the link is made after the link deadline");
  await writeFile(join(root, "tide-links.json"), JSON.stringify([{ agentId: lateId.toString(), secret, vaults: [], payee: lateVault, payeeCreation: lateCreation, at: linkedAt }]), { mode: 0o600 });
  const nonceBefore = await nonce();
  r = await pay("check manual");
  assert.ok(r.ok && r.out.includes(`agent ${lateId}: 200000.000000000000000005 OSTRA to its OSTRA vault ${lateVault}, created first`), r.out);
  assert.ok(r.out.includes("1 share(s) without a payee to pay, 1 left alone"), r.out);
  assert.equal(await nonce(), nonceBefore, "check manual sends nothing");
  // manual: the vault created, the share paid to it.
  r = await pay("manual");
  assert.ok(r.ok && r.out.includes("TIDE_MANUAL_PAID") && r.out.includes(`SENT create:1:${lateVault}`) && r.out.includes(`SENT manual:1:${lateId}`), r.out);
  assert.equal(await nonce(), nonceBefore + 2);
  assert.equal(getAddress((await c.readContract({ address: lateVault, abi: ostraVaultAbi, functionName: "token" })) as Address), OSTRA);
  assert.equal(await ostra(lateVault), shares[4]!.amount, "L's OSTRA vault holds its share exactly");
  assert.equal(await c.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "paid", args: [1n, lateId] }), true);
  assert.equal(await c.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "paid", args: [1n, 990003n] }), false, "990003 left alone");
  const paidNow = JSON.parse(await readFile(join(root, "week-1.paid.json"), "utf8")) as { paid: Record<string, { vault: Address; amount: string }> };
  assert.deepEqual({ vault: paidNow.paid[lateId.toString()]?.vault, amount: paidNow.paid[lateId.toString()]?.amount }, { vault: lateVault, amount: shares[4]!.amount.toString() });
  // A run again sends nothing.
  r = await pay("manual");
  assert.ok(r.ok && r.out.includes("TIDE_MANUAL_PAID") && !r.out.includes("SENT "), r.out);
  assert.equal(await nonce(), nonceBefore + 2, "nothing sent again");
});
