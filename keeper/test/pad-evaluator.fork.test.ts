// Ostrapad's evaluator bot (src/pad-evaluator.ts) on a fork of Robinhood Chain mainnet, against the live OstraPad,
// USDG and ERC-8004 Identity Registry, with fresh version 3 Ostra vaults for a provider and a client (core's
// PadService, as an agent's MCP runs it) and five plain evaluator accounts in OstraPad's pool, all of them the bot's:
//   * the bot finds the jobs from OstraPad's events, and draws the evaluator once both secrets are revealed (from its
//     fee payer); the drawn account, holding no ETH, is topped up from the fee payer and decides;
//   * a delivery the judge approves: approved with its reason pinned (the file's sha256 is the decision's reason),
//     then settled by the bot once the appeal window closed, and the provider paid;
//   * a judge that cannot answer: nothing is decided, judge_unavailable is logged, and the pass after the retry wait
//     decides; a decision whose send fails is sent again on the next pass;
//   * a delivery the judge rejects, appealed by the provider: the bot draws the panel, its three accounts on it vote
//     (agreeing with the rejection, as the judge does), the appeal is resolved and the client refunded;
//   * the judge is given the provider's offer from its listing, the client's order and the delivery, each read by
//     its CID with its bytes checked; on the panel, the decision and its reason too;
//   * an order file that cannot be read: the bot waits (it does not reject the provider over it), and at the late
//     point of its window decides with what it has instead of staying silent (which would get it slashed);
//   * approvals appealed by the client: where the panel gets no answer from its judge, the bot's panel accounts wait,
//     then at the vote's late point vote for the decision, which stands; a delivery unpinned after the bot read it is
//     still read from the copy the bot kept, and the approval stands; a delivery none of the bot's accounts ever read
//     that cannot be read is a rejection at the late point, as when deciding, and the approval is overturned;
//   * finished jobs are dropped from the passes; a bot started again on the same data sends nothing twice;
//   * the jobs mainnet held already at the fork (real agents' jobs since 28 Oct 2026, judged by their clients) are
//     seen too, as on mainnet, and the bot sends nothing for those already finished then.
// Two things are not reached here: IPFS (files are kept in memory under the CID the uploader gives them, CIDv1 raw
// sha2-256 of the bytes, as core's pad.fork.test.ts does) and the judge's model (a rule stands in for it: approve a
// delivery unless its output says REFUSED; openAiJudge is checked against the real API by scripts/pad-judge-check.ts).

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decodeEventLog, encodeFunctionData, getAddress, keccak256, sha256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  OSTRAPAD,
  OSTRAPAD_FROM_BLOCK,
  PAD,
  PAD_EVENTS,
  USDG,
  VAULT_ACTION,
  getLogsChunked,
  ostraPadAbi,
  ostraVaultAbi,
  padCidFromDigest,
  padDigestFromCid,
  padProviderPay,
  readPadAppeal,
  readPadJob,
  registerAgentParams,
  retryingHttp,
  setAgentUriParams,
  signVaultSpend,
  simulateVaultSpend,
  usdgAbi,
  type Deployment,
} from "@ostraagent/sdk";
import { deployOnFork, rpc, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, PadService, VaultService, X402_NETWORK, profileFile, spendCall, type Config } from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";
import { Sender } from "../src/chain.ts";
import { LATE_MARGIN, PadEvaluator, RETRY_MS, type Case, type Verdict } from "../src/pad-evaluator.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/KEEPER/PAD-FORK/agents-fee-payer")));
const botFeePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/KEEPER/PAD-FORK/bot-fee-payer")));
const evaluators = [1, 2, 3, 4, 5].map((i) => privateKeyToAccount(keccak256(stringToHex(`OSTRA/KEEPER/PAD-FORK/evaluator-${i}`))));

const ipfs = new Map<string, Uint8Array>();
async function upload(file: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  const uri = padCidFromDigest(sha256(bytes));
  ipfs.set(uri, bytes);
  return uri;
}
const usdg = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-keeper-pad-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
  await fork.setBalance(botFeePayer.address, 10n ** 19n);
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
  let file: Record<string, unknown> | null = { ...profileFile({ vault: creatorVault }), name, description: `${name}, a test agent` };
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
  return { pad, vault: getAddress(await buyer.vaultAddress()), register };
}

test("the bot draws, judges, decides with a pinned reason, settles, and sits on the appeal panel", { timeout: 2_400_000 }, async () => {
  const c = fork.client as PublicClient;
  // The jobs on mainnet before this test's: the bot reads every job since OstraPad's deployment, as it does on mainnet.
  const forked = await c.getBlockNumber();
  const onChain = (await getLogsChunked(c, { address: OSTRAPAD, event: PAD_EVENTS.JobCreated, fromBlock: OSTRAPAD_FROM_BLOCK, toBlock: forked })).map((l) => (l.args as { jobId: Hex }).jobId);
  // Those finished at the fork: nothing is ever sent for them. (One still open is the bot's to settle once the test's
  // warps pass its expiry, as on mainnet.)
  const finishedThen = new Set<string>();
  for (const id of onChain) {
    const s = (await readPadJob(c, id))?.status;
    if (s === "Completed" || s === "Rejected" || s === "Expired" || s === "Cancelled") finishedThen.add(id);
  }
  const provider = await agent("provider", 61);
  const client = await agent("client", 62);
  await fork.dealUsdg(provider.vault, 20_000_000n);
  await fork.dealUsdg(client.vault, 20_000_000n);
  const agentId = await provider.register();
  await provider.pad.publish([{ id: "pool-report", title: "Pool-judged report", description: "A short report on a topic.", input: "The topic.", price: "1", hours: 24, evaluator: "pool" }]);

  // OstraPad's live pool on mainnet (Ostra's evaluator accounts, counted in draws since 2 Nov 2026) leaves on the fork,
  // so every draw here picks one of this test's accounts, all of them the bot's.
  for (const m of (await c.readContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: "pool" })) as Address[]) {
    await fork.setBalance(m, 10n ** 18n);
    await rpc(fork.url, "anvil_impersonateAccount", [m]);
    const hash = (await rpc(fork.url, "eth_sendTransaction", [{ from: m, to: OSTRAPAD, data: encodeFunctionData({ abi: ostraPadAbi, functionName: "leavePool", args: [m] }) }])) as Hex;
    assert.equal((await c.waitForTransactionReceipt({ hash })).status, "success");
    await rpc(fork.url, "anvil_stopImpersonatingAccount", [m]);
  }
  assert.equal(((await c.readContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: "pool" })) as Address[]).length, 0);
  // The bot's five accounts join the pool (msg.sender, bonds by transferFrom), then hold no ETH: the bot tops them up.
  for (const e of evaluators) {
    await fork.setBalance(e.address, 10n ** 18n);
    await fork.dealUsdg(e.address, PAD.MIN_EVALUATOR_BOND);
    const w = fork.wallet(e);
    await c.waitForTransactionReceipt({ hash: await w.sendTransaction({ account: e, chain: null, to: USDG, data: encodeFunctionData({ abi: usdgAbi, functionName: "approve", args: [OSTRAPAD, PAD.MIN_EVALUATOR_BOND] }) }) });
    await c.waitForTransactionReceipt({ hash: await w.sendTransaction({ account: e, chain: null, to: OSTRAPAD, data: encodeFunctionData({ abi: ostraPadAbi, functionName: "joinPool", args: [e.address, PAD.MIN_EVALUATOR_BOND] }) }) });
    await fork.setBalance(e.address, 0n);
  }
  await fork.increaseTime(Number(PAD.STAKE_DELAY) + 60);

  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const cases: Case[] = [];
  let judgeUp = true;
  const silent = new Set<string>();
  const judge = async (k: Case): Promise<Verdict | null> => {
    cases.push(k);
    if (!judgeUp || silent.has(k.jobId)) return null;
    const out = (k.delivery as { output?: string }).output ?? "";
    return out.includes("REFUSED") ? { approve: false, reason: "The delivery refuses the order." } : { approve: true, reason: "The delivery is a report on the topic asked." };
  };
  const transport = retryingHttp(fork.url);
  const log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
  const sender = new Sender(c, transport, botFeePayer, log);
  let clock = Date.now();
  let failNextEvaluatorSend = false;
  const parts = {
    client: c,
    logsClient: c,
    evaluators,
    fromEvaluator: async (a: (typeof evaluators)[number], call: Parameters<Sender["fromCrank"]>[1]) => {
      if (failNextEvaluatorSend) {
        failNextEvaluatorSend = false;
        throw new Error("the RPC dropped the request (test)");
      }
      return sender.fromCrank(a, call);
    },
    fromFeePayer: (call: Parameters<Sender["fromFeePayer"]>[0]) => sender.fromFeePayer(call),
    judge,
    fetchBytes: async (uri: string) => ipfs.get(uri) ?? null,
    pin: upload,
    dataDir: join(root, "bot"),
    log,
    nowMs: () => clock,
  };
  const bot = await PadEvaluator.open(parts);
  // What the bot sent for this test's jobs (one mainnet held still open would add its own).
  const sent = (what: string) => logs.filter((l) => l.event === "pad_sent" && l.fields.what === what && !onChain.includes(l.fields.jobId as Hex)).length;

  // Job A: approved, reason pinned, settled.
  const p0 = await usdg(provider.vault);
  const a = (await client.pad.order({ agentId: agentId.toString(), offer: "pool-report", input: "Robinhood Chain agents" })).jobId as Hex;
  await provider.pad.accept(a);
  await client.pad.sweep();
  await provider.pad.sweep();
  assert.equal((await readPadJob(c, a))?.revealed, 3);
  await fork.increaseTime(2);
  await bot.tick();
  assert.ok(bot.jobs.includes(a), "the bot found the job from OstraPad's events");
  assert.equal(sent("draw"), 1, JSON.stringify(logs));
  let job = await readPadJob(c, a);
  const drawn = getAddress(job?.evaluator as Address);
  assert.ok(evaluators.some((e) => getAddress(e.address) === drawn), "one of the bot's accounts is drawn");
  await provider.pad.deliver({ jobId: a, output: "Robinhood Chain agents: a short report." });

  judgeUp = false;
  await bot.tick();
  assert.equal((await readPadJob(c, a))?.status, "Submitted", "no answer from the judge, no decision");
  assert.ok(logs.some((l) => l.event === "judge_unavailable" && l.fields.jobId === a));
  judgeUp = true;
  const asked = cases.length;
  await bot.tick();
  assert.equal(cases.length, asked, "not asked again before the retry wait");
  clock += RETRY_MS + 1;
  failNextEvaluatorSend = true;
  await bot.tick();
  assert.equal((await readPadJob(c, a))?.status, "Submitted", "the send failed");
  assert.ok(logs.some((l) => l.event === "pad_send_failed" && l.fields.what === "decide"));
  await bot.tick();
  job = await readPadJob(c, a);
  assert.equal(job?.status, "Decided", JSON.stringify(logs.slice(-5)));
  assert.equal(job?.approved, true);
  assert.ok(logs.some((l) => l.event === "crank_topped_up" && getAddress(l.fields.crank as Address) === drawn), "the drawn account was topped up");
  const decided = await c.getContractEvents({ address: OSTRAPAD, abi: ostraPadAbi, eventName: "Decided", args: { jobId: a }, fromBlock: (await c.getBlockNumber()) - 50n });
  const reason = (decided[0]?.args as { reason: Hex }).reason;
  const reasonFile = ipfs.get(padCidFromDigest(reason));
  assert.notEqual(reasonFile, undefined, "the decision's reason is the sha256 of the pinned reason file");
  assert.equal((JSON.parse(new TextDecoder().decode(reasonFile)) as { approve: boolean }).approve, true);
  const k = cases.find((x) => x.jobId === a) as Case;
  assert.equal((k.offer as { id: string }).id, "pool-report", "the judge is given the offer from the listing");
  assert.equal((k.order as { offer: string }).offer, "pool-report");
  assert.equal((k.delivery as { output: string }).output, "Robinhood Chain agents: a short report.");
  assert.equal(k.budget, "1");

  await bot.tick();
  assert.equal(sent("decide"), 1, "decided once, the failed send retried");
  await fork.increaseTime(Number(PAD.APPEAL_WINDOW) + 60);
  await bot.tick();
  assert.equal((await readPadJob(c, a))?.status, "Completed");
  assert.equal(await usdg(provider.vault), p0 + padProviderPay(1_000_000n));

  // Job B: rejected, appealed by the provider; the bot draws the panel and its accounts on it vote.
  const b = (await client.pad.order({ agentId: agentId.toString(), offer: "pool-report", input: "Another topic" })).jobId as Hex;
  const c1 = await usdg(client.vault);
  await provider.pad.accept(b);
  await client.pad.sweep();
  await provider.pad.sweep();
  await fork.increaseTime(2);
  await bot.tick();
  await provider.pad.deliver({ jobId: b, output: "REFUSED" });
  await bot.tick();
  job = await readPadJob(c, b);
  assert.equal(job?.status, "Decided");
  assert.equal(job?.approved, false);
  await provider.pad.appeal(b);
  const panelCasesFrom = cases.length;
  assert.equal((await readPadJob(c, b))?.status, "Appealed");
  await fork.increaseTime(2);
  await bot.tick();
  const ap = await readPadAppeal(c, b);
  assert.notEqual(ap.panel[0], "0x0000000000000000000000000000000000000000", JSON.stringify(logs.slice(-5)));
  assert.equal(sent("drawPanel"), 1);
  await bot.tick();
  assert.equal(sent("vote"), 3, JSON.stringify(logs.slice(-8)));
  job = await readPadJob(c, b);
  assert.equal(job?.status, "Rejected", "three votes resolve the appeal: the rejection stands");
  const panelCase = cases.slice(panelCasesFrom).find((x) => x.jobId === b) as Case;
  assert.equal(panelCase.decision?.approve, false, "the panel sees the decision");
  assert.equal(panelCase.decision?.reason, "The delivery refuses the order.", "and its reason, read from the pinned file");
  assert.ok((await usdg(client.vault)) >= c1 + 1_000_000n, "the client is refunded the budget");
  const failures = logs.filter((l) => l.event === "pad_send_failed" && l.fields.error !== "the RPC dropped the request (test)");
  assert.equal(failures.length, 0, JSON.stringify(failures));

  // Job C: its order file cannot be read. The bot waits through most of the window, then decides with what it has.
  const co = await client.pad.order({ agentId: agentId.toString(), offer: "pool-report", input: "A third topic" });
  const cid = co.jobId as Hex;
  ipfs.delete(co.orderUri as string);
  await provider.pad.accept(cid);
  await client.pad.sweep();
  await fork.increaseTime(2);
  await bot.tick();
  await provider.pad.deliver({ jobId: cid, output: "A report on a third topic." });
  await bot.tick();
  assert.equal((await readPadJob(c, cid))?.status, "Submitted", "an unreadable order: the bot waits");
  assert.ok(logs.some((l) => l.event === "pad_waiting" && l.fields.jobId === cid));
  await fork.increaseTime(Number(PAD.EVAL_WINDOW - LATE_MARGIN) + 60);
  await bot.tick();
  job = await readPadJob(c, cid);
  assert.equal(job?.status, "Decided", "decided at the late point, not left silent");
  assert.ok(logs.some((l) => l.event === "pad_alert" && l.fields.jobId === cid));
  const late = cases.filter((x) => x.jobId === cid).at(-1) as Case;
  assert.equal(late.order, null);
  assert.ok(late.notes.some((n) => /order file could not be read/.test(n)), JSON.stringify(late.notes));

  // Jobs D, E and F: approved, then appealed by the client. The panel's judge gives no answer on D. E's delivery file is
  // unpinned after the bot read it: its panel reads the copy the bot kept. F's delivery file is unpinned and the bot's
  // copy removed (as if an evaluator other than the bot's had read it). Before the vote's late point the panel waits on
  // D and F; at it, on D it votes for the decision (a panel does not overturn without a reason) and on F against it
  // (a delivery that cannot be read is a rejection: its provider controls whether its file is served).
  const ids: Hex[] = [];
  const orderUris: string[] = [];
  for (const topic of ["A fourth topic", "A fifth topic", "A sixth topic"]) {
    const o = await client.pad.order({ agentId: agentId.toString(), offer: "pool-report", input: topic });
    ids.push(o.jobId as Hex);
    orderUris.push(o.orderUri as string);
  }
  const [dj, ej, fj] = ids as [Hex, Hex, Hex];
  for (const id of ids) await provider.pad.accept(id);
  await client.pad.sweep();
  await provider.pad.sweep();
  await fork.increaseTime(2);
  await bot.tick();
  const uris: string[] = [];
  for (const [i, id] of ids.entries()) uris.push((await provider.pad.deliver({ jobId: id, output: `A report on topic ${i + 4}.` })).deliveryUri as string);
  await bot.tick();
  for (const id of ids) {
    job = await readPadJob(c, id);
    assert.equal(job?.status, "Decided", JSON.stringify(logs.slice(-5)));
    assert.equal(job?.approved, true);
  }
  const keptDir = (id: Hex) => join(root, "bot", "files", id.toLowerCase());
  const eDigest = (await readPadJob(c, ej))?.deliverable as Hex;
  await access(join(keptDir(ej), eDigest.toLowerCase()));
  // The kept files lost (a data directory not carried over): a bot started then keeps them again from IPFS on its first
  // pass, as for any pool job it follows (one decided before it started, or by another evaluator). This one has no
  // accounts of its own, so it neither decides nor votes.
  await rm(keptDir(ej), { recursive: true, force: true });
  const sentBefore = logs.filter((l) => l.event === "pad_sent").length;
  await (await PadEvaluator.open({ ...parts, evaluators: [] })).tick();
  await access(join(keptDir(ej), eDigest.toLowerCase()));
  assert.equal(logs.filter((l) => l.event === "pad_sent").length, sentBefore, "nothing sent by the bot started again");
  // A kept file whose bytes no longer match is read again from IPFS, and kept again.
  const eOrder = padDigestFromCid(orderUris[1] as string) as Hex;
  await writeFile(join(keptDir(ej), eOrder.toLowerCase()), "not the order");
  ipfs.delete(uris[1] as string);
  ipfs.delete(uris[2] as string);
  await rm(keptDir(fj), { recursive: true, force: true });
  silent.add(dj);
  const p1 = await usdg(provider.vault);
  for (const id of ids) await client.pad.appeal(id);
  await fork.increaseTime(2);
  await bot.tick();
  const votesBefore = sent("vote");
  await bot.tick();
  assert.equal(sent("vote"), votesBefore + 3, "E's panel reads the kept delivery and votes at once; D and F wait");
  assert.equal((await readPadJob(c, ej))?.status, "Completed", "the kept copy: the approval stands");
  assert.equal(sha256(new Uint8Array(await readFile(join(keptDir(ej), eOrder.toLowerCase())))), eOrder, "the order read again from IPFS and kept");
  assert.equal((cases.filter((x) => x.jobId === ej).at(-1)?.order as { input?: string } | null)?.input, "A fifth topic", "E's panel read its order");
  for (const id of [dj, fj]) assert.equal((await readPadJob(c, id))?.status, "Appealed");
  assert.ok(logs.some((l) => l.event === "pad_waiting" && l.fields.jobId === fj && l.fields.purpose === "vote"));
  const voteBy = (await readPadAppeal(c, dj)).voteBy;
  const now = (await c.getBlock()).timestamp;
  await fork.increaseTime(Number(voteBy - LATE_MARGIN - now) + 60);
  await bot.tick();
  assert.equal(sent("vote"), votesBefore + 9, JSON.stringify(logs.slice(-10)));
  assert.equal((await readPadJob(c, dj))?.status, "Completed", "three votes for the decision: the approval stands");
  assert.ok(logs.some((l) => l.event === "pad_alert" && l.fields.jobId === dj && l.fields.voted === "agreed"));
  assert.equal((await readPadJob(c, fj))?.status, "Rejected", "three votes against an approval whose delivery cannot be read");
  assert.ok(logs.some((l) => l.event === "pad_alert" && l.fields.jobId === fj && l.fields.verdict === "reject"));
  assert.equal(await usdg(provider.vault), p1 + 2n * padProviderPay(1_000_000n), "the provider is paid for D and E");

  // Finished jobs are dropped from the passes. A bot started again on the same data: nothing sent twice.
  await bot.tick(); // D and F finished in the last pass: this one drops them
  assert.ok(![a, b, dj, ej, fj].some((id) => bot.jobs.includes(id)), "finished jobs dropped");
  await assert.rejects(access(keptDir(ej)), "the files kept for a finished job are removed");
  assert.deepEqual([...bot.seen].sort(), [...onChain, a, b, cid, dj, ej, fj].sort());
  assert.equal(logs.filter((l) => l.event === "pad_sent" && finishedThen.has(l.fields.jobId as string)).length, 0, "nothing sent for the jobs mainnet had finished already");
  const again = await PadEvaluator.open(parts);
  assert.deepEqual([...again.seen].sort(), [...onChain, a, b, cid, dj, ej, fj].sort());
  const before = logs.length;
  await again.tick();
  assert.equal(logs.slice(before).filter((l) => l.event === "pad_sent").length, 0);
});
