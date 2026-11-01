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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { encodeFunctionData, erc20Abi, getAddress, keccak256, numberToHex, pad, parseAbi, parseAbiItem, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, OSTRA, OSTRA_TIDE, ostraVaultAbi, parseDeployment, retryingHttp, tideLinkDeadline, tidePayeeVault, tideTree, tideWeekSpan } from "@ostraagent/sdk";
import { rpc, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, VaultService, X402_NETWORK, type Config } from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";

const run = promisify(execFile);
const FACTORY: Address = "0x043a15c514CFE2c797d33520bFF91a5DCdbf2979";
const FACTORY_FROM = 91_991_509n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ownerKey = keccak256(stringToHex("OSTRA/KEEPER/TIDE-PAY-FORK/owner"));
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
  await writeFile(join(root, "rpc.url"), `${fork.url}\n`, { mode: 0o600 });
  await writeFile(join(root, "owner.key"), `${ownerKey}\n`, { mode: 0o600 });
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function pay(phase: "check" | "root" | "pay", stopAt?: string): Promise<{ ok: boolean; out: string }> {
  const env = { ...process.env, OSTRA_RPC_URL_FILE: join(root, "rpc.url"), OSTRA_DEPLOYER_KEY_FILE: join(root, "owner.key"), OSTRA_TIDE_RESULTS: root, OSTRA_TIDE_PAY_BATCH: "20", OSTRA_TIDE_TEST_STOP: stopAt ?? "" };
  try {
    const r = await run(process.execPath, ["scripts/tide-pay.ts", phase, "1"], { env, cwd: join(import.meta.dirname, ".."), timeout: 600_000 });
    return { ok: true, out: r.stdout + r.stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const ostra = (a: Address) => fork.client.readContract({ address: OSTRA, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const nonce = () => fork.client.getTransactionCount({ address: owner.address });

test("week 1 is posted and paid from the scorer's result: checks, root, a stopped pay finished, nothing twice", { timeout: 1_800_000 }, async () => {
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
  ];
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
      identityVault: ZERO,
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
  assert.ok(r.ok && r.out.includes("TIDE_CHECKED") && r.out.includes("1 without an OSTRA vault"), r.out);
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
  r = await pay("pay");
  assert.ok(r.out.includes(`SENT ${batch}: ${signed}`) && !r.out.includes(`SENT ${create}`), r.out);
  assert.ok(r.ok && r.out.includes("TIDE_PAID"), r.out);
  assert.equal(await ostra(payees[0]!), before0 + shares[0]!.amount, "payee 1 paid its share exactly");
  assert.equal(await ostra(payees[1]!), before1 + shares[1]!.amount, "payee 2 paid its share exactly");
  assert.equal(await ostra(created), shares[3]!.amount, "the vault created at payout paid its share exactly");
  assert.equal((await fresh.state()).balance, shares[3]!.amount);
  for (const id of [990001n, 990002n, 990004n]) assert.equal(await c.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "paid", args: [1n, id] }), true);
  assert.equal(await c.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "paid", args: [1n, 990003n] }), false, "no payee: not paid");
  assert.match(r.out, /agent 990003: 400000 OSTRA waits for an OSTRA vault/);
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
});
