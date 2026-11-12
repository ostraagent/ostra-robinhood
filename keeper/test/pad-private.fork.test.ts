// Ostrapad private jobs end to end on a fork of Robinhood Chain mainnet (design "Ostrapad: private job", revisions 2 to
// 9), against the live OstraPad, USDG and ERC-8004 Identity Registry, with every part of Ostra's that a private job
// passes through running for real on this machine: the client's and the provider's agents (core's PadService with the
// MCP's private side, mcp pad-private.ts), the uploader's encrypted store and its HTTP routes (uploader enc.ts and
// server.ts), Ostra's index with its private records and routes (indexer pad.ts, pad-private.ts, http.ts), and the
// evaluator bot with its five accounts, the only members of OstraPad's pool on the fork (pad-evaluator.ts):
//   P1  a private order with an attachment: the provider opens it before accepting and reserves its delivery's room;
//       the bot's drawn account gets K from the provider's wrap, reads the encrypted order and delivery from the
//       uploader's store, the judge is given their decrypted text, and the decision's reason is encrypted (kind 3) and
//       uploaded, nothing pinned publicly; the client reads the delivery and the reason; settled, the bot's plaintext
//       is removed;
//   P2  a provider that wraps nothing for the evaluator but a wrap that does not recompute (R7-B1): the bot waits, at
//       its late point rejects for no K with the fixed public reason; the provider appeals and wraps K for the panel,
//       and the bot's panel upholds the rejection under the rule for no K (registration an hour before the
//       assignment, the index healthy an hour, the header from the job's creation, no wrap that recomputes) without
//       asking the judge;
//   P3  a rejection for no K sent 5 minutes after the provider's wrap arrived, before the evaluator's late point
//       (R6-B1): the panel judges afresh with the K the appellant wrapped for it, and overturns it;
//   P4  a rejection for no K at the late point though the provider's wrap arrived in time and recomputes: judged afresh
//       and overturned;
//   U   the uploader's store on these jobs: reads by Range (and HEAD, and 404 for a file not kept); a client-judged
//       private job with a binary delivery, decided by its client (its reason signed by the client's posting key in
//       the order's header); nothing removed while the index is behind the chain; then a cancelled job's order removed
//       at once, a client-judged job's files a day after it ended, a pool job's 14 days after, and an order no job
//       names a day after its upload.
// Not reached here: IPFS for public files (kept in memory under the CID the uploader gives them, as the bot's other
// fork test does) and the judge's model (a rule stands in for it: approve a delivery unless its output says REFUSED).
// The index and the uploader run on a clock that follows the fork's block time (the time warps), as their wall clock
// follows the chain's on mainnet.

import assert from "node:assert/strict";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decodeEventLog, encodeFunctionData, getAddress, keccak256, sha256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  OSTRAPAD,
  PAD,
  PAD_KEM_DOMAIN,
  USDG,
  VAULT_ACTION,
  ostraPadAbi,
  ostraVaultAbi,
  padCidFromDigest,
  padEncryptFile,
  padKemKeys,
  padKemSeed,
  padKeyCommit,
  padNewJobKey,
  padNewSalt,
  padPlaintextPrefix,
  padProviderPay,
  padWrapBytes,
  padWrapKey,
  readPadAppeal,
  readPadJob,
  registerAgentParams,
  retryingHttp,
  setAgentUriParams,
  signVaultSpend,
  simulateVaultSpend,
  usdgAbi,
  type Deployment,
  type PadJob,
  type PadKemKeys,
} from "@ostraagent/sdk";
import { deployOnFork, rpc, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, PadService, VaultService, X402_NETWORK, profileFile, spendCall, type Config } from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";
import { createIndexerServer } from "../../indexer/src/http.ts";
import { PadIndexer } from "../../indexer/src/pad.ts";
import { PadPrivate as IndexPrivate } from "../../indexer/src/pad-private.ts";
import { PadPrivate as AgentPrivate } from "../../mcp/src/pad-private.ts";
import { EncStore, httpEncIndex } from "../../uploader/src/enc.ts";
import { Uploader, createUploaderServer } from "../../uploader/src/server.ts";
import { Sender } from "../src/chain.ts";
import { LATE_MARGIN, PadEvaluator, type Case, type Verdict } from "../src/pad-evaluator.ts";
import { NO_KEY_REASON, encFileName, httpPrivateIndex, uploadReason } from "../src/pad-private.ts";

const ZERO32: Hex = `0x${"00".repeat(32)}`;
let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
const servers: Server[] = [];
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/KEEPER/PAD-PRIVATE-FORK/agents-fee-payer")));
const botFeePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/KEEPER/PAD-PRIVATE-FORK/bot-fee-payer")));
const evaluatorKeys = [1, 2, 3, 4, 5].map((i) => keccak256(stringToHex(`OSTRA/KEEPER/PAD-PRIVATE-FORK/evaluator-${i}`)));
const evaluators = evaluatorKeys.map((k) => privateKeyToAccount(k));
const kem = new Map<Address, PadKemKeys>(evaluatorKeys.map((k, i) => [getAddress(evaluators[i]!.address), padKemKeys(padKemSeed(Buffer.from(k.slice(2), "hex"), PAD_KEM_DOMAIN.keeper, 4663, OSTRAPAD))]));

const ipfs = new Map<string, Uint8Array>();
async function upload(file: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  const uri = padCidFromDigest(sha256(bytes));
  ipfs.set(uri, bytes);
  return uri;
}
const usdg = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

/** The index's and the uploader's clock: the fork's block time. */
let simMs = 0;
async function warp(seconds: number): Promise<void> {
  await fork.increaseTime(seconds);
  simMs = Number((await fork.client.getBlock({ blockTag: "latest" })).timestamp) * 1000;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-keeper-pad-private-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
  await fork.setBalance(botFeePayer.address, 10n ** 19n);
  simMs = Number((await fork.client.getBlock({ blockTag: "latest" })).timestamp) * 1000;
});

after(async () => {
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
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

/** An agent as the MCP runs it, with its private side on Ostra's uploader and index. */
async function agent(name: string, seed: number, uploaderUrl: string, indexerUrl: string, f: typeof fetch) {
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
  let file: Record<string, unknown> | null = { ...profileFile({ vault: creatorVault }), name, description: `${name}, a test agent` };
  const priv = new AgentPrivate({ client, chainId: d.chainId, pad: OSTRAPAD, kemPublicKey: () => keys.padKemPublicKey(d.chainId, OSTRAPAD), unwrap: (w, r, c) => keys.padUnwrap(d.chainId, OSTRAPAD, w, r, c), posting: () => keys.padPosting(d.chainId, OSTRAPAD), uploaderUrl, indexerUrl, folder: folder.folder("pad"), filesDir: join(root, `${name}-files`), fetch: f, history: client });
  const pad = new PadService({
    client,
    config,
    buyer,
    sender,
    folder,
    identity: async () => ({ agentId, creatorVault }),
    currentFile: async () => file,
    publishFile: async (x) => {
      file = x;
      const uri = await upload(x);
      const r = await spend(creator, sender, VAULT_ACTION.SET_AGENT_URI, setAgentUriParams({ agentId: agentId as bigint, uri }));
      return { uri, profile: { status: "sent", txHash: r.txHash, vaultNonce: "0" }, agentUri: null };
    },
    upload,
    indexerUrl: null,
    fetchBytes: async (uri) => ipfs.get(uri) ?? null,
    private: priv,
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
  return { pad, keys, vault: getAddress(await buyer.vaultAddress()), register };
}

test("private jobs: read, judged and reasoned under K; a rejection for no K upheld only when the rule holds", { timeout: 3_600_000 }, async () => {
  const c = fork.client as PublicClient;
  const forked = await c.getBlockNumber();
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const log = (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields });

  // Ostra's index and uploader, on this machine, as on the VPS.
  const index = new PadIndexer({ client: c, deployment: () => d, statePath: join(root, "pad-state.json"), log: () => {}, readFile: async (uri) => {
    const b = ipfs.get(uri);
    return b === undefined ? null : (JSON.parse(new TextDecoder().decode(b)) as unknown);
  }, nowMs: () => simMs });
  // The index reads the uploader's store directly (enc/files), the uploader reads the index's routes on this machine.
  const ipriv = new IndexPrivate({ pad: index, client: c, dir: join(root, "pad-private"), store: join(root, "enc", "files"), chainId: d.chainId, nowMs: () => simMs, log });
  const indexerUrl = await listen(createIndexerServer(null as never, log, index, null, null, ipriv));
  const enc2 = new EncStore({ dir: join(root, "enc"), chain: { job: (id) => readPadJob(c, id) }, index: httpEncIndex(`${indexerUrl}/api/v1/pad/private`), log, now: () => simMs });
  assert.equal(enc2.filesDir, join(root, "enc", "files"));
  const uploaderUrl = await listen(createUploaderServer(new Uploader({ jwt: "test-jwt-never-sent-to-pinata", dailyBytes: 1_000_000, log, store: join(root, "public-files"), upstream: [] }), log, enc2));
  const sync = async () => {
    await index.sync();
    await ipriv.tick();
  };
  /** The index's heartbeat for `minutes` of block time, one beat a minute (the index reading the chain meanwhile, as it does every few seconds). */
  const beats = async (minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      await sync();
      await warp(60);
    }
    await sync();
  };

  // The provider's network: its wraps can be held back (a provider that wraps nothing for its evaluator).
  let dropEvaluatorWraps = false;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (dropEvaluatorWraps && init?.method === "POST" && url.includes("/api/v1/pad/private/wraps/")) {
      const round = (JSON.parse(String(init.body)) as { round: number }).round;
      if (round !== 256) return new Response(JSON.stringify({ error: "dropped (test)" }), { status: 503 });
    }
    return fetch(input, init);
  };
  const provider = await agent("provider", 81, uploaderUrl, indexerUrl, providerFetch);
  const client = await agent("client", 82, uploaderUrl, indexerUrl, fetch);
  await fork.dealUsdg(provider.vault, 20_000_000n);
  await fork.dealUsdg(client.vault, 40_000_000n);
  const agentId = await provider.register();
  await provider.pad.publish([
    { id: "private-report", title: "Private report", description: "A short report, kept private.", input: "The topic, with notes attached.", price: "1", hours: 24, evaluator: "pool" },
    { id: "private-file", title: "Private file", description: "A small file, judged by the client.", input: "What file.", price: "1", hours: 24, evaluator: "client", binary: true },
  ]);

  // OstraPad's live pool leaves on the fork; the bot's five accounts are the pool.
  for (const m of (await c.readContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: "pool" })) as Address[]) {
    await fork.setBalance(m, 10n ** 18n);
    await rpc(fork.url, "anvil_impersonateAccount", [m]);
    const hash = (await rpc(fork.url, "eth_sendTransaction", [{ from: m, to: OSTRAPAD, data: encodeFunctionData({ abi: ostraPadAbi, functionName: "leavePool", args: [m] }) }])) as Hex;
    assert.equal((await c.waitForTransactionReceipt({ hash })).status, "success");
    await rpc(fork.url, "anvil_stopImpersonatingAccount", [m]);
  }
  for (const e of evaluators) {
    await fork.setBalance(e.address, 10n ** 18n);
    await fork.dealUsdg(e.address, PAD.MIN_EVALUATOR_BOND);
    const w = fork.wallet(e);
    await c.waitForTransactionReceipt({ hash: await w.sendTransaction({ account: e, chain: null, to: USDG, data: encodeFunctionData({ abi: usdgAbi, functionName: "approve", args: [OSTRAPAD, PAD.MIN_EVALUATOR_BOND] }) }) });
    await c.waitForTransactionReceipt({ hash: await w.sendTransaction({ account: e, chain: null, to: OSTRAPAD, data: encodeFunctionData({ abi: ostraPadAbi, functionName: "joinPool", args: [e.address, PAD.MIN_EVALUATOR_BOND] }) }) });
    await fork.setBalance(e.address, 0n);
  }
  await warp(Number(PAD.STAKE_DELAY) + 60);
  await sync();
  assert.deepEqual(index.listingPosts(provider.vault), [(await provider.keys.padPosting(d.chainId, OSTRAPAD)).address], "the listing publishes the provider's posting address");

  const cases: Case[] = [];
  const judge = async (k: Case): Promise<Verdict | null> => {
    cases.push(k);
    const out = (k.delivery as { output?: string } | null)?.output ?? "";
    return out.includes("REFUSED") ? { approve: false, reason: "The delivery refuses the order." } : { approve: true, reason: "The delivery is the private report asked for." };
  };
  const transport = retryingHttp(fork.url);
  const sender = new Sender(c, transport, botFeePayer, log);
  let clock = Date.now();
  const parts = {
    client: c,
    logsClient: c,
    evaluators,
    fromEvaluator: (a: (typeof evaluators)[number], call: Parameters<Sender["fromCrank"]>[1]) => sender.fromCrank(a, call),
    fromFeePayer: (call: Parameters<Sender["fromFeePayer"]>[0]) => sender.fromFeePayer(call),
    judge,
    fetchBytes: async (uri: string) => ipfs.get(uri) ?? null,
    pin: upload,
    dataDir: join(root, "bot"),
    log,
    nowMs: () => clock,
    followFrom: forked + 1n,
    private: { store: enc2.filesDir, index: httpPrivateIndex(indexerUrl), kem, uploadReason: (a: (typeof evaluators)[number], jobId: Hex, file: Uint8Array) => uploadReason(uploaderUrl, a, d.chainId, OSTRAPAD, jobId, file), chainId: d.chainId },
  };
  const bot = await PadEvaluator.open(parts);
  const sentFor = (what: string, id: Hex) => logs.filter((l) => l.event === "pad_sent" && l.fields.what === what && l.fields.jobId === id).length;
  /** Passes until `done` holds (each after the bot's read waits), at most `n`. */
  const ticks = async (n: number, done: () => Promise<boolean>) => {
    for (let i = 0; i < n && !(await done()); i++) {
      clock += 2 * 3600_000;
      await bot.tick();
    }
    assert.ok(await done(), JSON.stringify(logs.slice(-12)));
  };

  // The bot registers each account's KEM key with the index at its first pass, and not again.
  await bot.tick();
  for (const e of evaluators) assert.equal(ipriv.registrations(e.address).length, 1, `registered ${e.address}`);
  await bot.tick();
  assert.equal(logs.filter((l) => l.event === "pad_private_registered" && l.fields.account !== undefined).length, 5, "registered once (the bot's log; the index logs each too)");
  // The rule for no K counts a registration that arrived at least an hour before the assignment.
  await beats(62);

  const notes = join(root, "notes.md");
  await writeFile(notes, "The second line matters.\nKeep it private.");
  const findings = join(root, "findings.txt");
  await writeFile(findings, "Finding: the second line matters.");
  /** A private job through its draw: ordered, accepted (the provider opens it first), both secrets revealed, drawn. */
  const drawnJob = async (input: string): Promise<{ id: Hex; job: PadJob }> => {
    const o = await client.pad.order({ agentId: agentId.toString(), offer: "private-report", input, private: true, attachments: [notes] });
    const id = o.jobId as Hex;
    await sync(); // the index reads the order's header within minutes of the job's creation
    assert.equal(ipriv.job(id)?.fromCreation, true);
    const accepted = await provider.pad.accept(id);
    assert.ok((accepted.private as { reserved?: number } | undefined)?.reserved !== undefined, JSON.stringify(accepted));
    await client.pad.sweep();
    await warp(2);
    await bot.tick();
    const job = (await readPadJob(c, id)) as PadJob;
    assert.ok(evaluators.some((e) => getAddress(e.address) === getAddress(job.evaluator)), "one of the bot's accounts is drawn");
    await sync();
    return { id, job };
  };
  const evalStartOf = (j: PadJob) => (j.submittedAt > j.assignedAt ? j.submittedAt : j.assignedAt);
  const toLatePoint = async (id: Hex) => {
    const j = (await readPadJob(c, id)) as PadJob;
    await warp(Number(evalStartOf(j) + PAD.EVAL_WINDOW - LATE_MARGIN - (await c.getBlock()).timestamp) + 60);
  };
  const decidedReason = async (id: Hex): Promise<Hex> => {
    const ev = await c.getContractEvents({ address: OSTRAPAD, abi: ostraPadAbi, eventName: "Decided", args: { jobId: id }, fromBlock: forked });
    return (ev.at(-1)?.args as { reason: Hex }).reason;
  };
  /** The provider appeals; the bot draws the panel; the provider, appellant, wraps K for it. */
  const appealed = async (id: Hex) => {
    await provider.pad.appeal(id);
    await warp(2);
    await bot.tick();
    assert.notEqual((await readPadAppeal(c, id)).panel[0], "0x0000000000000000000000000000000000000000", JSON.stringify(logs.slice(-6)));
    await sync();
    const swept = await provider.pad.sweep();
    assert.ok(!JSON.stringify(swept).includes("privateWrap"), JSON.stringify(swept));
  };
  /** A decision sent by the drawn account itself (as a third-party evaluator's), rejecting for no K. */
  const rejectByHand = async (j: PadJob) => {
    const i = evaluators.findIndex((e) => getAddress(e.address) === getAddress(j.evaluator));
    const e = evaluators[i]!;
    await fork.setBalance(e.address, 10n ** 17n);
    const hash = await fork.wallet(e).sendTransaction({ account: e, chain: null, to: OSTRAPAD, data: encodeFunctionData({ abi: ostraPadAbi, functionName: "decide", args: [j.id, false, ZERO32] }) });
    assert.equal((await c.waitForTransactionReceipt({ hash })).status, "success");
  };

  // P1: read, judged, reasoned under K; settled, the plaintext removed.
  const p1 = await drawnJob("Private topic one");
  await provider.pad.deliver({ jobId: p1.id, output: "A private report on topic one.", attachments: [findings] });
  await sync();
  await provider.pad.sweep(); // the wrap for the drawn evaluator
  assert.equal(ipriv.job(p1.id)?.wraps.length, 1);
  await ticks(4, async () => (await readPadJob(c, p1.id))?.status === "Decided");
  const j1 = (await readPadJob(c, p1.id)) as PadJob;
  assert.equal(j1.approved, true);
  const k1 = cases.filter((x) => x.jobId === p1.id).at(-1) as Case;
  assert.equal((k1.order as { input?: string }).input, "Private topic one");
  assert.equal((k1.delivery as { output?: string }).output, "A private report on topic one.");
  assert.equal(((k1.delivery as { attachments: { text?: string }[] }).attachments[0] as { text?: string }).text, "Finding: the second line matters.");
  assert.equal(((k1.order as { attachments: { name: string; text?: string }[] }).attachments[0] as { text?: string }).text, "The second line matters.\nKeep it private.");
  const plainPath = join(root, "bot", "files", p1.id.toLowerCase(), `plain-${j1.deliverable.toLowerCase()}`);
  assert.equal((await stat(plainPath)).mode & 0o777, 0o600);
  const r1 = await decidedReason(p1.id);
  assert.notEqual(r1, ZERO32, "the reason was uploaded");
  await access(join(enc2.filesDir, encFileName(r1)));
  assert.equal(ipfs.get(padCidFromDigest(r1)), undefined, "nothing of the private job pinned publicly");
  for (const bytes of ipfs.values()) assert.ok(!new TextDecoder().decode(bytes).includes("topic one"), "no plaintext of the job in any public file");
  const view = JSON.stringify(await client.pad.jobs({ jobId: p1.id }));
  assert.ok(view.includes("A private report on topic one."), view.slice(0, 400));
  const p0 = await usdg(provider.vault);
  await warp(Number(PAD.APPEAL_WINDOW) + 60);
  await bot.tick();
  assert.equal((await readPadJob(c, p1.id))?.status, "Completed");
  assert.equal(await usdg(provider.vault), p0 + padProviderPay(1_000_000n));
  await bot.tick();
  await assert.rejects(access(plainPath), "the plaintext is removed once the job is finished");

  // P2: no wrap that opens (one that does not recompute), rejected for no K at the late point, upheld by the panel.
  dropEvaluatorWraps = true;
  const p2 = await drawnJob("Private topic two");
  const evaluatorPk = kem.get(getAddress(p2.job.evaluator))!.publicKey;
  const junk = padWrapKey(padNewJobKey(), { chainId: d.chainId, pad: OSTRAPAD, jobId: p2.id, round: p2.job.round }, getAddress(p2.job.evaluator), evaluatorPk);
  const seq = BigInt(simMs);
  const posting = await provider.keys.padPosting(d.chainId, OSTRAPAD);
  const signature = await posting.signPost({ kind: "wrap", jobId: p2.id, round: p2.job.round, wrap: junk, seq });
  const posted = await fetch(`${indexerUrl}/api/v1/pad/private/wraps/${p2.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ round: p2.job.round, wrap: Buffer.from(padWrapBytes(junk)).toString("base64"), seq: seq.toString(), signature }) });
  assert.equal(posted.status, 200, await posted.text());
  await provider.pad.deliver({ jobId: p2.id, output: "A private report on topic two.", attachments: [findings] });
  await provider.pad.sweep();
  await beats(62); // the index healthy an hour after the assignment
  clock += 2 * 3600_000;
  await bot.tick();
  await bot.tick();
  assert.equal((await readPadJob(c, p2.id))?.status, "Submitted", "no key: the bot waits before its late point");
  assert.ok(logs.some((l) => l.event === "pad_waiting" && l.fields.jobId === p2.id));
  await toLatePoint(p2.id);
  clock += 2 * 3600_000;
  await bot.tick();
  const j2 = (await readPadJob(c, p2.id)) as PadJob;
  assert.equal(j2.status, "Decided", JSON.stringify(logs.slice(-8)));
  assert.equal(j2.approved, false);
  const r2 = ipfs.get(padCidFromDigest(await decidedReason(p2.id)));
  assert.equal((JSON.parse(new TextDecoder().decode(r2)) as { reason: string }).reason, NO_KEY_REASON, "the fixed public reason");
  dropEvaluatorWraps = false;
  const judgedBefore = cases.filter((x) => x.jobId === p2.id).length;
  await appealed(p2.id);
  await ticks(6, async () => (await readPadJob(c, p2.id))?.status !== "Appealed");
  assert.equal((await readPadJob(c, p2.id))?.status, "Rejected", "the panel upholds the rejection for no K");
  assert.ok(logs.some((l) => l.event === "pad_private_upheld" && l.fields.jobId === p2.id), JSON.stringify(logs.filter((l) => String(l.event).startsWith("pad_private")).slice(-6)));
  assert.equal(cases.filter((x) => x.jobId === p2.id).length, judgedBefore, "the judge is not asked: the rule decides");
  assert.equal(sentFor("vote", p2.id), 3);

  // P3: a rejection for no K 5 minutes after the provider's wrap arrived, before the late point: judged afresh.
  const p3 = await drawnJob("Private topic three");
  await provider.pad.deliver({ jobId: p3.id, output: "A private report on topic three." });
  await sync();
  await provider.pad.sweep();
  await warp(300);
  await rejectByHand(p3.job);
  await appealed(p3.id);
  const pay3 = await usdg(provider.vault);
  await ticks(6, async () => (await readPadJob(c, p3.id))?.status !== "Appealed");
  assert.equal((await readPadJob(c, p3.id))?.status, "Completed", "the panel overturns an early rejection for no K");
  assert.ok(logs.some((l) => l.event === "pad_private_afresh" && l.fields.jobId === p3.id && /late point/.test(String(l.fields.why))));
  assert.equal((cases.filter((x) => x.jobId === p3.id).at(-1) as Case).decision?.approve, false, "judged afresh, the decision in view");
  assert.ok((await usdg(provider.vault)) > pay3, "the provider is paid");

  // P4: a rejection for no K at the late point though the provider's wrap arrived in time and recomputes: judged afresh.
  const p4 = await drawnJob("Private topic four");
  await provider.pad.deliver({ jobId: p4.id, output: "A private report on topic four." });
  await sync();
  await provider.pad.sweep();
  await beats(62);
  await toLatePoint(p4.id);
  await rejectByHand(p4.job);
  await appealed(p4.id);
  await ticks(6, async () => (await readPadJob(c, p4.id))?.status !== "Appealed");
  assert.equal((await readPadJob(c, p4.id))?.status, "Completed", "the panel overturns a rejection for no K with a wrap that recomputes");
  assert.ok(logs.some((l) => l.event === "pad_private_afresh" && l.fields.jobId === p4.id && /recomputes/.test(String(l.fields.why))));

  // U: the uploader's store on the same jobs. Reads by Range; nothing removed while the index is behind; each file
  // removed when its rule says (a cancelled job's at once, a client-judged job's a day after it ended, a pool job's 14
  // days after, a file no job names a day after its upload); a reservation lapsed before its accept is retaken by the
  // retry without counting its bytes twice.
  const cidOf = (digest: Hex) => encFileName(digest);
  const kept = (digest: Hex) => access(join(enc2.filesDir, cidOf(digest))).then(() => true, () => false);
  const j4 = (await readPadJob(c, p4.id)) as PadJob;
  const size4 = (await stat(join(enc2.filesDir, cidOf(j4.deliverable)))).size;
  const range = (h: Record<string, string>, method = "GET") => fetch(`${uploaderUrl}/v1/ipfs/${cidOf(j4.deliverable)}`, { method, headers: h });
  let r = await range({ range: "bytes=0-12" });
  assert.equal(r.status, 206);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString("latin1"), "OSTRAPAD-ENC1");
  assert.equal(r.headers.get("content-range"), `bytes 0-12/${size4}`);
  assert.equal(r.headers.get("cache-control"), "no-store");
  r = await range({ range: "bytes=-16" });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 16);
  r = await range({ range: `bytes=${size4}-` });
  assert.equal(r.status, 416);
  await r.body?.cancel();
  r = await range({ range: "bytes=9-3" });
  assert.equal(r.status, 416);
  await r.body?.cancel();
  r = await range({}, "HEAD");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-length"), String(size4));
  r = await fetch(`${uploaderUrl}/v1/ipfs/${cidOf(`0x${"99".repeat(32)}`)}`);
  assert.equal(r.status, 404);
  await r.body?.cancel();

  // A client-judged private job with a binary delivery (allowed only where the client judges): completed by the client.
  const fixed = (await client.pad.order({ agentId: agentId.toString(), offer: "private-file", input: "A small file, please.", private: true })).jobId as Hex;
  await sync();
  await provider.pad.accept(fixed);
  const bin = join(root, "blob.bin");
  await writeFile(bin, Uint8Array.of(0, 255, 1, 254, 2, 253));
  await provider.pad.deliver({ jobId: fixed, output: "The file is attached.", attachments: [bin] });
  const fixedView = JSON.stringify(await client.pad.jobs({ jobId: fixed }));
  assert.ok(fixedView.includes("blob.bin") && fixedView.includes("The file is attached."), fixedView.slice(0, 400));
  await client.pad.decide({ jobId: fixed, approve: true });
  const jf = (await readPadJob(c, fixed)) as PadJob;
  assert.equal(jf.status, "Completed");
  // A private order cancelled before any accept.
  const cancelled = (await client.pad.order({ agentId: agentId.toString(), offer: "private-file", input: "Never mind.", private: true })).jobId as Hex;
  await client.pad.cancel(cancelled);
  // An encrypted order uploaded but never made a job (as when a client's create fails after its upload).
  const loneK = padNewJobKey();
  const lonePlain = padPlaintextPrefix({ type: "ostrapad-order-v1", agent: `eip155:${d.chainId}:${agentId}`, offer: "private-file", client: `eip155:${d.chainId}:${client.vault}`, provider: `eip155:${d.chainId}:${provider.vault}`, input: "Never made a job." });
  const loneFile = padEncryptFile(loneK, { kind: 1, salt: padNewSalt(), plaintextLength: lonePlain.length, order: { keyCommit: padKeyCommit(loneK), clientPosting: (await client.keys.padPosting(d.chainId, OSTRAPAD)).address, providerPosting: (await provider.keys.padPosting(d.chainId, OSTRAPAD)).address, wraps: [padWrapKey(loneK, { chainId: d.chainId, pad: OSTRAPAD, jobId: ZERO32, round: 0 }, client.vault, await client.keys.padKemPublicKey(d.chainId, OSTRAPAD))] } }, lonePlain);
  const loneDigest = sha256(loneFile);
  const begun = (await (await fetch(`${uploaderUrl}/v1/enc/uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: loneFile.length, sha256: loneDigest, kind: 1 }) })).json()) as { id: string };
  assert.equal((await fetch(`${uploaderUrl}/v1/enc/uploads/${begun.id}/0`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: loneFile })).status, 200);
  assert.equal((await fetch(`${uploaderUrl}/v1/enc/uploads/${begun.id}/done`, { method: "POST" })).status, 200);
  // Keeping it another day is charged at its kept size: a start that declares another size is refused (R9-M1).
  const refresh = await fetch(`${uploaderUrl}/v1/enc/uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: 74, sha256: loneDigest, kind: 1 }) });
  assert.equal(refresh.status, 409);
  assert.equal(((await refresh.json()) as { error: string }).error, "kept_differs");
  await sync();
  const desc = async (id: Hex) => ipriv.files().jobs.find((x) => x.id === id)?.description as Hex;
  const fixedOrder = await desc(fixed);
  const cancelledOrder = await desc(cancelled);
  const p1Order = await desc(p1.id);
  assert.ok((await kept(fixedOrder)) && (await kept(jf.deliverable)) && (await kept(cancelledOrder)) && (await kept(p1Order)) && (await kept(loneDigest)));

  // The index behind the chain: nothing is removed.
  await warp(600);
  await enc2.tick();
  assert.ok(logs.some((l) => l.event === "enc_release_skipped" && /behind/.test(String(l.fields.reason))));
  assert.ok(await kept(cancelledOrder), "nothing removed while the index is behind");
  await sync();
  await enc2.tick();
  assert.equal(await kept(cancelledOrder), false, "a cancelled job's order is removed at once");
  assert.ok((await kept(fixedOrder)) && (await kept(jf.deliverable)), "a client-judged job's files are kept a day after it ended");
  const closedFixed = ipriv.files().jobs.find((x) => x.id === fixed)?.closedAt as number;
  await warp(Math.max(0, closedFixed + 86_400 - Number((await c.getBlock()).timestamp)) + 60);
  await sync();
  await enc2.tick();
  assert.equal(await kept(fixedOrder), false, "removed a day after the client-judged job ended");
  // A file no job names goes a day after its upload, unless a running job's order is not known to the index (then any
  // order may be its, and none is removed as unnamed).
  const unknownOrder = ipriv.files().jobs.some((x) => x.description === null && x.closedAt === null);
  assert.equal(await kept(loneDigest), unknownOrder, unknownOrder ? "kept: a running job's order is unknown" : "an order no job names is removed a day after its upload");
  assert.equal(await kept(jf.deliverable), false);
  assert.ok(await kept(p1Order), "a pool job's files are kept 14 days after it ended");
  const closedP1 = ipriv.files().jobs.find((x) => x.id === p1.id)?.closedAt as number;
  await warp(Math.max(0, closedP1 + 14 * 86_400 - Number((await c.getBlock()).timestamp)) + 60);
  await sync();
  await enc2.tick();
  assert.equal(await kept(p1Order), false, "removed 14 days after the pool job ended");
  assert.equal(await kept(j1.deliverable), false);
  assert.equal(await kept(r1), false, "and its reason");

  const failures = logs.filter((l) => l.event === "pad_send_failed");
  assert.equal(failures.length, 0, JSON.stringify(failures));
  const alerts = logs.filter((l) => l.event === "pad_alert" && (l.fields.what === "store" || l.fields.what === "kem" || l.fields.what === "reason"));
  assert.deepEqual(alerts, [], "no store, key or reason alert");
});
