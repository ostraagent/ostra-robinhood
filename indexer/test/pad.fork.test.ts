// Ostrapad's index (src/pad.ts) on a fork of Robinhood Chain mainnet, against the live OstraPad, USDG and ERC-8004
// Identity Registry, with fresh version 3 Ostra vaults: an agent registers from its Ostra creator vault and lists two
// offers (its USDG vault approving the listing), a second agent registered by an account that is not an Ostra vault
// is left out, a client orders, the provider accepts and delivers and the client approves; the index then serves the
// listed agent with its record, the job with its status and pay, and its stats. Files are kept in memory under the
// CID the uploader gives them (CIDv1 raw sha2-256 of the bytes), as core's pad.fork.test.ts does. Mainnet holds
// agents and jobs of its own (Ostrapad's first jobs, 28 Oct 2026), which the fork carries: an index read before the
// test's own steps is the baseline, and the counts are checked against it. The board (the web app's Ostrapad page)
// is checked on the same index: the agent's figures from its job, and the hidden list leaving out a client's job, then
// the agent itself, and the board refused without a list. Ostrapad's content rules (moderation.ts) are checked on an
// index with a moderator: no listing is served before its content has a verdict, an allowed one is served and not
// checked again while it stays the same, and one changed to prohibited work leaves the listings and the board, its
// reason kept with the agent. The model is not reached here (a rule stands in for it, as the evaluator bot's fork test
// does for its judge): scripts/pad-moderation-check.ts checks the real API.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decodeEventLog, encodeFunctionData, getAddress, keccak256, sha256, stringToHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ERC8004_IDENTITY_REGISTRY,
  FileWotsStore,
  VAULT_ACTION,
  ostraVaultAbi,
  padCidFromDigest,
  padServiceEntry,
  registerAgentParams,
  retryingHttp,
  setAgentUriParams,
  signVaultSpend,
  simulateVaultSpend,
  type Deployment,
} from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, PadService, VaultService, X402_NETWORK, profileFile, spendCall, type Config } from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";
import type { Moderator } from "../src/moderation.ts";
import { DETAILS_EVERY_MS, PadIndexer, RETRY_MODERATION_MS } from "../src/pad.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/INDEXER/PAD-FORK/fee-payer")));
const ipfs = new Map<string, Uint8Array>();
async function upload(file: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  const uri = padCidFromDigest(sha256(bytes));
  ipfs.set(uri, bytes);
  return uri;
}
const readJson = async (uri: string) => {
  const b = ipfs.get(uri);
  return b === undefined ? null : (JSON.parse(new TextDecoder().decode(b)) as unknown);
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-indexer-pad-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function spend(vault: VaultService, sender: LocalSender, action: number, params: Hex) {
  const at = await vault.vaultAddress();
  const sim = await simulateVaultSpend(fork.client as PublicClient, d, { relayer: await sender.payer(), vault: at, action, params });
  const r = await vault.operate({ gas: (sim.gasUsed * 5n) / 4n + 100_000n, what: "spend", build: async ({ v, vault: a, keychain, chainId }) => [spendCall(a, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))] });
  assert.equal(r.status, "sent");
  return r as { txHash: Hex };
}

async function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const folder = new MemoryFolder();
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder, backupExported: async () => true });
  const creatorKeys = new Keys({ master: new Uint8Array(32).fill(seed + 100), feePayer, store: new FileWotsStore(join(root, `${name}-c`)), folder: new MemoryFolder(), backupExported: async () => true });
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  await buyer.open();
  await creator.open();
  const creatorVault = getAddress(await creator.vaultAddress());
  let agentId: bigint | null = null;
  let file: Record<string, unknown> | null = { ...profileFile({ vault: creatorVault }), name, description: `${name} does reports` };
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
      const r = await spend(creator, sender, VAULT_ACTION.SET_AGENT_URI, setAgentUriParams({ agentId: agentId as bigint, uri }));
      return { uri, profile: { status: "sent", txHash: r.txHash, vaultNonce: "0" }, agentUri: null };
    },
    upload,
    indexerUrl: null,
    fetchBytes: async (uri) => ipfs.get(uri) ?? null,
  });
  const register = async () => {
    const r = await spend(creator, sender, VAULT_ACTION.REGISTER_AGENT, registerAgentParams(await upload(file as Record<string, unknown>)));
    for (const log of (await client.getTransactionReceipt({ hash: r.txHash })).logs) {
      if (getAddress(log.address) !== creatorVault) continue;
      try {
        const e = decodeEventLog({ abi: ostraVaultAbi, data: log.data, topics: log.topics });
        if (e.eventName === "AgentRegistered") agentId = (e.args as { agentId: bigint }).agentId;
      } catch {
        // another event
      }
    }
    return agentId as bigint;
  };
  return { pad, buyer, vault: getAddress(await buyer.vaultAddress()), creatorVault, register };
}

/** USDG text (as the index writes it) in base units. */
const units = (text: string) => {
  const [w, f = ""] = text.split(".");
  return BigInt(w as string) * 1_000_000n + BigInt(f.padEnd(6, "0").slice(0, 6));
};

test("the index serves listed agents ranked with their record, jobs with status and pay, and leaves out what is not a listing", { timeout: 1_200_000 }, async () => {
  // What mainnet holds already, at the fork's block.
  const baseline = new PadIndexer({ client: fork.client as PublicClient, deployment: () => d, statePath: join(root, "pad-baseline.json"), log: () => {}, readFile: readJson });
  await baseline.sync();
  const base = baseline.stats();
  const provider = await agent("provider", 51);
  const client = await agent("client", 52);
  await fork.dealUsdg(provider.vault, 10_000_000n);
  await fork.dealUsdg(client.vault, 20_000_000n);
  const agentId = await provider.register();
  await provider.pad.publish([{ id: "token-report", title: "Token report", description: "A report on one token.", input: "The token address.", price: "2", hours: 12, evaluator: "client" }]);
  // An agent registered by a plain account (not an Ostra vault), with a listing naming the provider's vault: left out.
  // A fresh account: anvil's development accounts carry EIP-7702 code on Robinhood Chain, which ERC-721 minting refuses.
  const outsider = privateKeyToAccount(keccak256(stringToHex("OSTRA/INDEXER/PAD-FORK/outsider")));
  await fork.setBalance(outsider.address, 10n ** 18n);
  const outsiderFile = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Outsider", services: [padServiceEntry({ provider: provider.vault, offers: [{ id: "copy", title: "Copy", description: "A copy.", input: "x", price: "1", hours: 1, evaluator: "client" }] })] };
  const w = fork.wallet(outsider);
  await fork.client.waitForTransactionReceipt({
    hash: await w.sendTransaction({ account: outsider, chain: null, to: ERC8004_IDENTITY_REGISTRY, data: encodeFunctionData({ abi: [{ type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "", type: "uint256" }] }], functionName: "register", args: [await upload(outsiderFile)] }) }),
  });

  const o = await client.pad.order({ agentId: agentId.toString(), offer: "token-report", input: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" });
  const id = o.jobId as Hex;
  await provider.pad.accept(id);
  await provider.pad.deliver({ jobId: id, output: "A report." });
  await client.pad.decide({ jobId: id, approve: true });

  let hidden: Set<string> | null = new Set();
  const index = new PadIndexer({ client: fork.client as PublicClient, deployment: () => d, statePath: join(root, "pad-state.json"), log: () => {}, readFile: readJson, hidden: () => hidden });
  await index.sync();
  const l = index.listings({ limit: 50 });
  assert.equal(l.total, base.listed + 1, JSON.stringify(l));
  const a = l.agents.find((x) => x.agentId === agentId.toString())!;
  assert.ok(a !== undefined, "the test's agent is listed");
  assert.equal(a.agentId, agentId.toString());
  assert.equal(a.owner, provider.creatorVault);
  assert.equal(a.provider, provider.vault);
  assert.equal(a.approved, true);
  assert.equal(a.name, "provider");
  assert.deepEqual(a.offers.map((x) => x.id), ["token-report"]);
  assert.equal(a.record?.fixedCompleted, 1);
  assert.equal(a.record?.limit, "5");
  assert.ok(index.listings({ q: "token", limit: 50 }).agents.some((x) => x.agentId === agentId.toString()));
  assert.equal(index.listings({ q: "nothing like it" }).total, 0);
  assert.equal(index.listings({ provider: provider.vault }).total, 1, "one provider vault's listings");
  assert.equal(index.listings({ provider: client.vault }).total, 0);
  const jobs = index.jobs({ limit: 1_000 });
  assert.equal(jobs.length, base.jobs + 1);
  const job = jobs.find((j) => j.id === id);
  assert.equal(job?.status, "Completed");
  assert.equal(job?.paid, "1.99");
  assert.equal(job?.funded, "2");
  assert.equal(index.agent(agentId.toString())?.jobs.length, 1);
  const s = index.stats();
  assert.equal(s.agents, base.agents + 1, "only the Ostra vault's registration is kept");
  assert.equal(s.completed, base.completed + 1);
  assert.equal(units(s.valueCompleted), units(base.valueCompleted) + 1_990_000n);

  // The board: the agent with the figures of its one job.
  const job0 = index.boardJobs({ limit: 100 })!.find((j) => j.id === id)!;
  assert.equal(job0.agentId, agentId.toString());
  assert.equal(job0.judgedBy, "client");
  assert.equal("evaluator" in job0, false, "the board names no judge's account");
  assert.ok(job0.acceptedAt !== null && job0.submittedAt !== null && job0.closedAt !== null && job0.acceptedAt >= job0.createdAt && job0.submittedAt >= job0.acceptedAt && job0.closedAt >= job0.submittedAt, JSON.stringify(job0));
  const board = index.board({ limit: 100 })!;
  assert.equal(board.total, base.listed + 1);
  const row = board.agents.find((x) => x.agentId === agentId.toString())!;
  assert.equal(row.completed, 1);
  assert.equal(row.clients, 1);
  assert.equal(row.earned, "1.99");
  assert.equal(row.priceFrom, "2");
  assert.equal(row.successRate, 1);
  assert.equal(row.rejectionRate, 0);
  assert.equal(row.inProgress, 0);
  assert.equal(row.deliverySeconds, (job0.submittedAt as number) - (job0.acceptedAt as number));
  assert.equal(typeof row.providerSince, "number", "the provider vault's creation was read");
  const detail = index.boardAgent(agentId.toString())!;
  assert.equal(detail.jobs.length, 1);
  assert.deepEqual(detail.clientsOf, [{ client: client.vault, orders: 1, completed: 1, rejected: 0, judged: 1, rejectionRate: 0 }]);
  assert.ok(board.stats.completed >= 1 && board.stats.listed === board.total);
  // A hidden client: its job leaves the board, the agent stays with no figures.
  hidden = new Set([client.vault.toLowerCase()]);
  assert.equal(index.boardJobs({ limit: 100 })!.some((j) => j.id === id), false);
  const quiet = index.board({ limit: 100 })!.agents.find((x) => x.agentId === agentId.toString())!;
  assert.equal(quiet.completed, 0);
  assert.equal(quiet.successRate, null);
  // A hidden owner (the creator vault): the agent leaves the board, and so do its jobs.
  hidden = new Set([provider.creatorVault.toLowerCase()]);
  assert.equal(index.board({ limit: 100 })!.agents.some((x) => x.agentId === agentId.toString()), false);
  assert.equal(index.boardAgent(agentId.toString()), undefined);
  assert.equal(index.boardJobs({ limit: 100 })!.some((j) => j.id === id), false, "the job of an agent left out leaves too");
  // No list configured: no board.
  assert.equal(new PadIndexer({ client: fork.client as PublicClient, deployment: () => d, statePath: join(root, "pad-state.json"), log: () => {}, readFile: readJson }).board(), null);
  // No readable list: no board.
  hidden = null;
  assert.equal(index.board(), null);
  assert.equal(index.boardAgent(agentId.toString()), null);
  assert.equal(index.boardJobs(), null);
  // The listings (MCP's pad_search, the evaluator bot) do not use the list.
  assert.equal(index.listings({ provider: provider.vault }).total, 1);

  // Ostrapad's content rules: an index with a moderator (a rule standing in for the model).
  let up = false;
  const calls: string[] = [];
  const moderate: Moderator = async (l) => {
    calls.push(l.agentId);
    if (!up) return null;
    return l.offers.some((x) => /login page/i.test(x.description)) ? { prohibited: true, category: "fraud", reason: "Sells copies of login pages that collect passwords." } : { prohibited: false, category: null, reason: "Reports." };
  };
  let clock = Date.now();
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const checked = new PadIndexer({ client: fork.client as PublicClient, deployment: () => d, statePath: join(root, "pad-moderated.json"), log: (event, fields) => logs.push({ event, fields }), readFile: readJson, hidden: () => new Set(), moderate, nowMs: () => clock });
  await checked.sync();
  const mine = () => checked.listings({ limit: 50 }).agents.some((x) => x.agentId === agentId.toString());
  assert.equal(mine(), false, "not served before its content has a verdict");
  assert.equal(checked.board({ limit: 100 })!.agents.some((x) => x.agentId === agentId.toString()), false);
  assert.ok((checked.stats().moderation?.pending ?? 0) >= 1);
  assert.ok(logs.some((l) => l.event === "pad_moderation_unavailable" && l.fields?.agentId === agentId.toString()));
  up = true;
  await checked.sync();
  assert.equal(mine(), false, "a listing with no answer is checked again only after the retry wait");
  clock += RETRY_MODERATION_MS;
  await checked.sync();
  assert.equal(mine(), true, "allowed: served");
  assert.equal(checked.agent(agentId.toString())?.moderation?.prohibited, false);
  assert.equal(checked.board({ limit: 100 })!.agents.some((x) => x.agentId === agentId.toString()), true);
  assert.deepEqual(checked.stats().moderation, { prohibited: 0, pending: 0 });
  // The same content read again: not checked again.
  const before = calls.filter((c) => c === agentId.toString()).length;
  clock += DETAILS_EVERY_MS;
  await checked.sync();
  assert.equal(calls.filter((c) => c === agentId.toString()).length, before);
  // Its offers changed to prohibited work: checked again, and left out.
  await provider.pad.publish([{ id: "login-copy", title: "Login copy", description: "A copy of a bank's login page that sends what is typed into it to the client.", input: "The bank's name.", price: "2", hours: 12, evaluator: "client" }]);
  clock += DETAILS_EVERY_MS;
  await checked.sync();
  assert.equal(calls.filter((c) => c === agentId.toString()).length, before + 1);
  assert.equal(mine(), false, "prohibited: not served");
  assert.equal(checked.listings({ provider: provider.vault }).total, 0, "not found by its provider either (pad_search, the evaluator bot)");
  assert.equal(checked.board({ limit: 100 })!.agents.some((x) => x.agentId === agentId.toString()), false);
  assert.equal(checked.boardAgent(agentId.toString()), undefined);
  const kept = checked.agent(agentId.toString())!;
  assert.deepEqual([kept.moderation?.prohibited, kept.moderation?.category, kept.moderation?.reason], [true, "fraud", "Sells copies of login pages that collect passwords."]);
  assert.equal(checked.stats().moderation?.prohibited, 1);
  assert.ok(logs.some((l) => l.event === "pad_moderated" && l.fields?.agentId === agentId.toString() && l.fields?.category === "fraud"));
  // Read back from its state: the verdict stays.
  const reread = new PadIndexer({ client: fork.client as PublicClient, deployment: () => d, statePath: join(root, "pad-moderated.json"), log: () => {}, readFile: readJson, moderate, nowMs: () => clock });
  assert.equal(reread.listings({ provider: provider.vault }).total, 0);

  // A state written and read back: the same listing.
  const again = new PadIndexer({ client: fork.client as PublicClient, deployment: () => d, statePath: join(root, "pad-state.json"), log: () => {}, readFile: readJson });
  assert.equal(again.listings({ limit: 50 }).total, base.listed + 1);
});
