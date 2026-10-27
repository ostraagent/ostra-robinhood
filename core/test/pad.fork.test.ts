// Ostrapad through the core service (src/pad.ts) on a fork of Robinhood Chain mainnet, against the live OstraPad
// (OSTRAPAD), the live USDG, Multicall3 and the live ERC-8004 Identity Registry, with fresh version 3 Ostra vaults
// (deployOnFork) and the agents' own fee payer sending (LocalSender: several calls go through Multicall3, as the
// relayer sends them):
//   * a provider registers in ERC-8004 from its creator vault and lists two offers: its USDG vault approves the
//     listing once and the registration file is pointed at; a client reads the listing back from the chain;
//   * a client-judged order: the order file pinned, the budget sent to the job's box and the job created (an
//     ApproveHash and OstraPad.create in one transaction); the provider finds it, accepts and delivers; the client
//     approves; the provider's vault is paid the budget less 0.5%, the platform fee goes half to each sink;
//   * an order no provider accepted is cancelled and refunded in full;
//   * a pool-judged order with five evaluators in the pool: both sweeps reveal their secrets, the sweep draws the
//     evaluator, the evaluator approves, and once the appeal window closed the sweep settles it and the provider is
//     paid; its record and distinct clients grow;
//   * refusals before signing: an offer the listing does not have, a budget over the provider's limit;
//   * a decision approved earlier but never carried out (its spend landed alone) is withdrawn before another
//     decision is approved, so it cannot be carried out by anyone afterwards; USDG left in a bond box is returned.
// IPFS is the one thing not reached here: files are kept in memory under the CID the uploader would give them
// (CIDv1 raw sha2-256 of the bytes, as on mainnet), and read back by that CID with their bytes checked.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decodeEventLog, encodeFunctionData, getAddress, keccak256, sha256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  OSTRAPAD,
  PAD,
  USDG,
  VAULT_ACTION,
  ostraPadAbi,
  ostraVaultAbi,
  approveHashParams,
  padBondBox,
  padCidFromDigest,
  padDigest,
  padProviderPay,
  readPadJob,
  readPadProvider,
  registerAgentParams,
  retryingHttp,
  setAgentUriParams,
  signVaultSpend,
  simulateVaultSpend,
  usdgAbi,
  type Deployment,
} from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, PadService, VaultService, X402_NETWORK, profileFile, spendCall, type Config } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;

const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/PAD-FORK/fee-payer")));
const TREASURY: Address = "0x6569E27A95a6A3E92A311B4Cc6600fed56aA50A2";
const BURN_SINK: Address = "0xd86083031b7Af66ecD5C9c5e90D4C6d8E661F3f5";

/** IPFS as the uploader serves it: bytes kept under their CIDv1 raw sha2-256. */
const ipfs = new Map<string, Uint8Array>();
async function upload(file: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  const uri = padCidFromDigest(sha256(bytes));
  ipfs.set(uri, bytes);
  return uri;
}
async function fetchBytes(uri: string): Promise<Uint8Array | null> {
  return ipfs.get(uri) ?? null;
}

const usdg = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

/** One spend of `vault`, simulated with a throwaway key, then signed and sent (as the launchpad's identity tools do). */
async function spend(vault: VaultService, sender: LocalSender, action: number, params: Hex, what: string) {
  const at = await vault.vaultAddress();
  const sim = await simulateVaultSpend(fork.client as PublicClient, d, { relayer: await sender.payer(), vault: at, action, params });
  const r = await vault.operate({ gas: (sim.gasUsed * 5n) / 4n + 100_000n, what, build: async ({ v, vault: a, keychain, chainId }) => [spendCall(a, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))] });
  assert.equal(r.status, "sent", what);
  return r;
}

/** An agent: its seed, USDG vault and creator vault, and Ostrapad from them. */
async function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const folder = new MemoryFolder();
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder, backupExported: async () => true });
  const creatorKeys = new Keys({ master: new Uint8Array(32).fill(seed + 100), feePayer, store: new FileWotsStore(join(root, `${name}-creator`)), folder: new MemoryFolder(), backupExported: async () => true });
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  await buyer.open();
  await creator.open();
  const vault = getAddress(await buyer.vaultAddress());
  const creatorVault = getAddress(await creator.vaultAddress());
  let agentId: bigint | null = null;
  let file: Record<string, unknown> | null = null;
  const pad = new PadService({
    client,
    config,
    buyer,
    sender,
    folder,
    identity: async () => ({ agentId, creatorVault }),
    currentFile: async () => file,
    publishFile: async (f) => {
      file = f;
      const uri = await upload(f);
      const agentUri = await spend(creator, sender, VAULT_ACTION.SET_AGENT_URI, setAgentUriParams({ agentId: agentId as bigint, uri }), "agent registration file");
      return { uri, profile: agentUri, agentUri };
    },
    upload,
    indexerUrl: null,
    fetchBytes,
  });
  /** Publishes a profile and registers the creator vault in the live ERC-8004 Identity Registry. */
  const register = async () => {
    file = profileFile({ name, description: `${name}, a test agent`, vault: creatorVault });
    const uri = await upload(file);
    const r = await spend(creator, sender, VAULT_ACTION.REGISTER_AGENT, registerAgentParams(uri), "agent registration");
    assert.equal(r.status, "sent");
    const receipt = await client.getTransactionReceipt({ hash: (r as { txHash: Hex }).txHash });
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== creatorVault) continue;
      try {
        const e = decodeEventLog({ abi: ostraVaultAbi, data: log.data, topics: log.topics });
        if (e.eventName === "AgentRegistered") agentId = (e.args as { agentId: bigint }).agentId;
      } catch {
        // another event
      }
    }
    assert.notEqual(agentId, null, "the AgentRegistered event names the agent id");
    file = { ...file, registrations: [{ agentId: Number(agentId), agentRegistry: `eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` }] };
    return agentId as bigint;
  };
  return { name, pad, buyer, vault, creatorVault, register, folder, sender };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-pad-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

let provider: Awaited<ReturnType<typeof agent>>;
let client: Awaited<ReturnType<typeof agent>>;
let agentId: bigint;

const offers = [
  { id: "quick-check", title: "Quick check", description: "Checks one Robinhood Chain address and reports what it holds.", input: "The address.", price: "2", hours: 6, evaluator: "client" as const },
  { id: "pool-report", title: "Pool-judged report", description: "A short report judged by the evaluator pool.", input: "The topic.", price: "1", hours: 24, evaluator: "pool" as const },
];

test("a provider lists offers from its USDG vault; a client reads the listing from the chain", { timeout: 900_000 }, async () => {
  provider = await agent("provider", 41);
  client = await agent("client", 42);
  await fork.dealUsdg(provider.vault, 20_000_000n);
  await fork.dealUsdg(client.vault, 50_000_000n);
  agentId = await provider.register();
  const r = await provider.pad.publish(offers);
  assert.equal(r.listed, true);
  assert.notEqual(r.listingApproval, null, "the listing is approved once");
  const l = await client.pad.listing(agentId.toString());
  assert.notEqual(l, null);
  assert.equal(l?.approved, true);
  assert.equal(l?.listing.provider, provider.vault);
  assert.equal(l?.owner, provider.creatorVault);
  assert.deepEqual(l?.listing.offers.map((o) => o.id), ["quick-check", "pool-report"]);
  assert.equal(l?.limit, "5");
  // Published again: no second approval.
  const again = await provider.pad.publish(offers);
  assert.equal(again.listingApproval, null);
});

test("a client-judged order: funded, created, accepted, delivered, approved; the provider paid less 0.5%", { timeout: 900_000 }, async () => {
  const [p0, t0, b0, c0] = await Promise.all([usdg(provider.vault), usdg(TREASURY), usdg(BURN_SINK), usdg(client.vault)]);
  const o = await client.pad.order({ agentId: agentId.toString(), offer: "quick-check", input: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" });
  const id = o.jobId as Hex;
  let job = await readPadJob(fork.client as PublicClient, id);
  assert.equal(job?.status, "Open");
  assert.equal(job?.evaluator, client.vault, "the client judges a client offer");
  assert.equal(await usdg(client.vault), c0 - 2_000_000n);
  const seen = (await provider.pad.jobs()).jobs as { id: Hex; role: string }[];
  assert.ok(seen.some((j) => j.id === id && j.role === "provider"), "the provider finds the job from the chain");
  const read = await provider.pad.jobs({ jobId: id });
  assert.equal((read.order as { offer: string }).offer, "quick-check", "the order file is read back by its digest");
  await provider.pad.accept(id);
  await provider.pad.deliver({ jobId: id, output: "It holds 0 USDG." });
  job = await readPadJob(fork.client as PublicClient, id);
  assert.equal(job?.status, "Submitted");
  await client.pad.decide({ jobId: id, approve: true, reason: "Correct." });
  job = await readPadJob(fork.client as PublicClient, id);
  assert.equal(job?.status, "Completed");
  const pay = padProviderPay(2_000_000n);
  assert.equal(await usdg(provider.vault), p0 + pay);
  const fee = 2_000_000n - pay;
  assert.equal((await usdg(TREASURY)) - t0 + ((await usdg(BURN_SINK)) - b0), fee);
  const rec = await readPadProvider(fork.client as PublicClient, provider.vault);
  assert.equal(rec.fixedCompleted, 1);
  assert.equal(rec.completed, 0, "a client-judged job does not build the record");
});

test("an order no provider accepted is cancelled and refunded in full", { timeout: 900_000 }, async () => {
  const c0 = await usdg(client.vault);
  const o = await client.pad.order({ agentId: agentId.toString(), offer: "quick-check", input: "anything" });
  const id = o.jobId as Hex;
  await client.pad.cancel(id);
  assert.equal((await readPadJob(fork.client as PublicClient, id))?.status, "Cancelled");
  assert.equal(await usdg(client.vault), c0);
});

test("refused before signing: an offer the listing lacks, a budget over the provider's limit", { timeout: 900_000 }, async () => {
  await assert.rejects(client.pad.order({ agentId: agentId.toString(), offer: "nope", input: "x" }), /offers no "nope"/);
  await provider.pad.publish([...offers, { id: "big", title: "Big", description: "Too big for a new provider.", input: "x", price: "6", hours: 24, evaluator: "client" }]);
  await assert.rejects(client.pad.order({ agentId: agentId.toString(), offer: "big", input: "x" }), /up to 5 USDG/);
  await provider.pad.publish(offers);
});

test("a pool-judged order: secrets revealed and the evaluator drawn by the sweeps, approved, settled after the appeal window", { timeout: 1_800_000 }, async () => {
  const c = fork.client as PublicClient;
  // Five evaluators join the pool directly (msg.sender), their bonds by transferFrom.
  const evaluators = [1, 2, 3, 4, 5].map((i) => privateKeyToAccount(keccak256(stringToHex(`OSTRA/CORE/PAD-FORK/evaluator-${i}`))));
  for (const e of evaluators) {
    await fork.setBalance(e.address, 10n ** 18n);
    await fork.dealUsdg(e.address, PAD.MIN_EVALUATOR_BOND);
    const w = fork.wallet(e);
    for (const data of [
      encodeFunctionData({ abi: usdgAbi, functionName: "approve", args: [OSTRAPAD, PAD.MIN_EVALUATOR_BOND] }),
    ]) await c.waitForTransactionReceipt({ hash: await w.sendTransaction({ account: e, chain: null, to: USDG, data }) });
    await c.waitForTransactionReceipt({ hash: await w.sendTransaction({ account: e, chain: null, to: OSTRAPAD, data: encodeFunctionData({ abi: ostraPadAbi, functionName: "joinPool", args: [e.address, PAD.MIN_EVALUATOR_BOND] }) }) });
  }
  // Refused while the joins have not taken effect.
  await assert.rejects(client.pad.order({ agentId: agentId.toString(), offer: "pool-report", input: "a topic" }), /pool evaluators can judge/);
  await fork.increaseTime(Number(PAD.STAKE_DELAY) + 60);
  const p0 = await usdg(provider.vault);
  const o = await client.pad.order({ agentId: agentId.toString(), offer: "pool-report", input: "Robinhood Chain agents" });
  const id = o.jobId as Hex;
  assert.equal(o.funding, "1.05", "the budget and the 1% evaluator fee, at least 0.05 USDG");
  await provider.pad.accept(id);
  // Both sweeps reveal; then the draw is armed and the next sweep draws.
  await client.pad.sweep();
  await provider.pad.sweep();
  let job = await readPadJob(c, id);
  assert.equal(job?.revealed, 3);
  await fork.increaseTime(2);
  const drew = await client.pad.sweep();
  assert.ok(drew.sent.some((s) => s.call === "draw"), JSON.stringify(drew));
  job = await readPadJob(c, id);
  const drawn = evaluators.find((e) => getAddress(e.address) === getAddress(job?.evaluator as Address));
  assert.notEqual(drawn, undefined, "one of the pool's evaluators is drawn");
  await provider.pad.deliver({ jobId: id, output: "A short report." });
  const ew = fork.wallet(drawn as never);
  await c.waitForTransactionReceipt({ hash: await ew.sendTransaction({ account: drawn as never, chain: null, to: OSTRAPAD, data: encodeFunctionData({ abi: ostraPadAbi, functionName: "decide", args: [id, true, `0x${"00".repeat(32)}`] }) }) });
  assert.equal((await readPadJob(c, id))?.status, "Decided");
  // Not settled before the appeal window closes; settled by the sweep after it.
  const early = await provider.pad.sweep();
  assert.equal(early.sent.length, 0);
  await fork.increaseTime(Number(PAD.APPEAL_WINDOW) + 60);
  const settled = await provider.pad.sweep();
  assert.ok(settled.sent.some((s) => s.call === "settle"), JSON.stringify(settled));
  assert.equal((await readPadJob(c, id))?.status, "Completed");
  assert.equal(await usdg(provider.vault), p0 + padProviderPay(1_000_000n));
  const rec = await readPadProvider(c, provider.vault);
  assert.equal(rec.completed, 1);
  assert.equal(rec.clients, 1);
  const earned = await provider.pad.earnings();
  assert.equal((earned.provider as { completed: number }).completed, 1);
});

test("an earlier decision approval never carried out is withdrawn before another is approved; a bond box is returned", { timeout: 900_000 }, async () => {
  const c = fork.client as PublicClient;
  const o = await client.pad.order({ agentId: agentId.toString(), offer: "quick-check", input: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" });
  const id = o.jobId as Hex;
  await provider.pad.accept(id);
  await provider.pad.deliver({ jobId: id, output: "It holds 0 USDG." });
  const job = await readPadJob(c, id);
  // An approval of "approve, no reason" landed alone (as a spend kept after a failed send lands on the vault's next
  // operation), recorded as this service records the choices it approves.
  const earlier = padDigest({ kind: "decide", id, round: job?.round as number, approve: true, reason: `0x${"00".repeat(32)}` }, OSTRAPAD, d.chainId);
  await spend(client.buyer, client.sender, VAULT_ACTION.APPROVE_HASH, approveHashParams({ hash: earlier, approved: true }), "an earlier approval");
  const magic = (h: Hex) => c.readContract({ address: client.vault, abi: [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "h", type: "bytes32" }, { name: "s", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }] }] as const, functionName: "isValidSignature", args: [h, "0x"] });
  assert.equal(await magic(earlier), "0x1626ba7e");
  await client.folder.folder("pad").write("pending.json", JSON.stringify({ [`decide:${id}:${job?.round}`]: earlier }));
  const r = await client.pad.decide({ jobId: id, approve: false, reason: "The address holds USDG." });
  assert.match(String(r.approvals), /withdrawn first/);
  assert.notEqual(await magic(earlier), "0x1626ba7e", "the earlier approval no longer holds");
  assert.equal((await readPadJob(c, id))?.status, "Rejected");

  // USDG left in the provider bond box (a deposit whose second step failed) is returned to the vault.
  const box = padBondBox(provider.vault, false);
  await fork.dealUsdg(box, 3_000_000n);
  const p0 = await usdg(provider.vault);
  const back = await provider.pad.bond({ action: "sweep" });
  assert.notEqual(back.returned, null);
  assert.equal(await usdg(box), 0n);
  assert.equal(await usdg(provider.vault), p0 + 3_000_000n);
  assert.equal((await provider.pad.bond({ action: "sweep" })).returned, null, "an empty box: nothing to send");
});
