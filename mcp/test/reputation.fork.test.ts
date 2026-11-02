// Reputation proofs end to end on a fork of Robinhood Chain mainnet (latest state), with Ostra's live deployment: the
// live OstraVaultFactory and vault beacon (every vault here is a real Ostra vault, created by the live factory with
// this run's WOTS keys), the live OstraPad and its evaluator pool, the live ERC-8004 Identity Registry and USDG.
// OstraReputation and RepVerifier are deployed on the fork from ostra-swap's Foundry build (out/), with the live
// OstraPad and factory; the proofs are made by ostra-prove (ostra-swap privacy/target/release, native) and verified by
// RepVerifier on chain.
//
//   * The agent under test is the MCP server's own Agent (src/agent.ts) on an OSTRA_HOME, first through the Ostra
//     relayer and keeper processes set up as on mainnet (relayer/scripts/setup-mainnet.ts) with the deployment record
//     holding OstraReputation: its first snapshot goes through the relayer (the ApproveHash spend and the snapshot in
//     one request, priced and paid in USDG from the vault's relayer channel), and the relayer refuses a snapshot whose
//     approval is not in place and one to another contract.
//   * Six providers earn a record on the live OstraPad with real pool jobs: a client account creates each job, the
//     provider vault accepts and submits by ApproveHash spends of OstraPad's action digests, five new evaluators join
//     the pool beside the live ones and the drawn evaluator decides (impersonated on the fork, whoever is drawn), and
//     each job settles after the appeal window. The agent under test does two jobs, the five others one each.
//   * The relayer prices with Chainlink ETH/USD, which stops being fresh once the fork's clock moves days ahead, so
//     after the first snapshot the agent under test runs on the same OSTRA_HOME without the relayer (its fee payer in
//     OSTRA_HOME pays gas), as an agent without OSTRA_RELAYER_URL does; the five others run core's services with a
//     local fee payer.
//   * Snapshots in epoch 0, then in epoch 5 (35 days on, so the default 30-day record age holds); one provider puts
//     its vault under the withdrawal lock first, so its approval is given for the epoch it holds in and its snapshot
//     sent by a later call once the lock's delay has passed.
//   * Proofs: the agent under test proves the default statement for a verifier's scope (anonymity set 6), the
//     verifier checks it by eth_call; refused: before any record is 30 days old, a statement only it meets (k = 5),
//     one its record misses, and a statement whose scope already holds one that leaves fewer than 5 vaults.
//   * The MCP server over stdio on the agent's OSTRA_HOME: the three reputation tools.
//   * Ostrapad: a provider lists offers with a reputation proof made for the listing; Ostra's index (indexer pad.ts)
//     verifies it on chain and serves its statements with the listing; another listing carrying a copy of that proof
//     is served without any.
// State written with cheatcodes: none of OstraPad's or a vault's storage. ETH and USDG balances are set
// (anvil_setBalance, anvil_dealERC20) and the drawn evaluators are impersonated (anvil_impersonateAccount). IPFS is
// not reached: files are kept in memory under the CID the uploader gives them. Needs anvil on PATH and ostra-prove
// built (cargo build --release in ostra-swap privacy).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, getAddress, http, keccak256, parseEventLogs, sha256, stringToHex, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  OSTRAPAD,
  USDG,
  VAULT_ACTION,
  approveHashParams,
  checkDeployment,
  ostraPadAbi,
  ostraReputationAbi,
  ostraVaultAbi,
  padCidFromDigest,
  PAD_LISTINGS_SCOPE_TEXT,
  padCommit,
  padDigest,
  padListingChallenge,
  padReputationEntry,
  padReputationProofParts,
  padJobId,
  parseDeployment,
  readPadProvider,
  registerAgentParams,
  repPackDigest,
  repSnapshotCall,
  repVerify,
  retryingHttp,
  robinhoodChain,
  setAgentUriParams,
  setWithdrawalLockParams,
  signVaultSpend,
  simulateVaultSpend,
  usdgAbi,
  type Deployment,
  type PadTerms,
} from "@ostraagent/sdk";
import { cliProver } from "@ostraagent/swap/cli-prover";
import { startFork, vaultBeaconAtRecord, rpc, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, PadService, ReputationService, VaultService, X402_NETWORK, carryListingReputation, profileFile, repProverOf, spendCall, type Config } from "@ostraagent/core";
import { MemoryFolder } from "../../core/test/memory-folder.ts";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { PadIndexer } from "../../indexer/src/pad.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const SWAP_OUT = here("../../../ostra-swap/out");
const PROVER = process.env.OSTRA_TEST_PROVER ?? here("../../../ostra-swap/privacy/target/release/ostra-prove");
const RELAYER = here("../../relayer/src/server.ts");
const KEEPER = here("../../keeper/src/main.ts");
const DAY = 86_400;
const BUDGET = 1_000_000n;

let fork: Fork;
let dir: string;
let live: Deployment;
let d: Deployment;
let repAddress: Address;
let startBlock: bigint;
let relayerUrl: string;
const children: ChildProcess[] = [];
const logs = { keeper: "", relayer: "" };

const key = (name: string) => privateKeyToAccount(keccak256(stringToHex(`OSTRA/MCP/REPUTATION-FORK/${name}`)));
const feePayer = key("fee-payer");
const deployer = key("deployer");
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
const readJson = async (uri: string) => {
  const b = ipfs.get(uri);
  return b === undefined ? null : (JSON.parse(new TextDecoder().decode(b)) as unknown);
};
const prover = repProverOf(cliProver(PROVER));
const client = () => fork.client as PublicClient;
const usdg = async (who: Address) => (await client().readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] })) as bigint;
const now = async () => (await client().getBlock({ blockTag: "latest" })).timestamp;

/** Sends a call from `account` (a key here, or an address impersonated on the fork) and waits for it to succeed. */
async function send(account: PrivateKeyAccount | Address, to: Address, data: Hex): Promise<Hex> {
  const wallet = createWalletClient({ chain: robinhoodChain, transport: http(fork.url) });
  const hash = await wallet.sendTransaction({ account: account as never, chain: robinhoodChain, to, data });
  const r = await client().waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `transaction ${hash} to ${to}`);
  return hash;
}

function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    const at = line.indexOf("=");
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer within 60 s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const tails = () => Object.entries(logs).map(([n, f]) => `--- ${n}\n${f === "" ? "" : readFileSync(f, "utf8").slice(-4_000)}`).join("\n");

before(async () => {
  assert.ok(existsSync(PROVER), `ostra-prove is built at ${PROVER}`);
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-reputation-"));
  startBlock = await client().getBlockNumber({ cacheTime: 0 });
  live = parseDeployment(JSON.parse(readFileSync(LIVE_DEPLOYMENT, "utf8")));
  await vaultBeaconAtRecord(fork, live);
  await checkDeployment(client(), live);
  // RepVerifier and OstraReputation from ostra-swap's build, with the live OstraPad and OstraVaultFactory.
  await fork.setBalance(deployer.address, 10n ** 19n);
  await fork.setBalance(feePayer.address, 10n ** 19n);
  const wallet = createWalletClient({ account: deployer, chain: robinhoodChain, transport: http(fork.url) });
  const artifact = (name: string) => JSON.parse(readFileSync(join(SWAP_OUT, `${name}.sol`, `${name}.json`), "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
  const v = artifact("RepVerifier");
  const vr = await client().waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: v.abi, bytecode: v.bytecode.object, args: [] }) });
  const r = artifact("OstraReputation");
  const rr = await client().waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: r.abi, bytecode: r.bytecode.object, args: [OSTRAPAD, live.vaultFactory, vr.contractAddress as Address] }) });
  repAddress = getAddress(rr.contractAddress as Address);
  assert.equal(getAddress((await client().readContract({ address: repAddress, abi: ostraReputationAbi, functionName: "FACTORY" })) as Address), live.vaultFactory);
  d = { ...live, reputation: { address: repAddress, fromBlock: rr.blockNumber.toString() } };
  writeFileSync(join(dir, "deployment.json"), JSON.stringify({ ...JSON.parse(readFileSync(LIVE_DEPLOYMENT, "utf8")), reputation: d.reputation }));
  // The relayer and the keeper as on mainnet, reading that record.
  const base = join(dir, "robinhood");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const setup = await setupMainnet({ base, deploymentPath: join(dir, "deployment.json"), deployer: fork.accounts[0] as PrivateKeyAccount, rpcUrl: fork.url, log: () => {}, listen });
  await fork.setBalance(setup.relayerAccount, 10n ** 18n);
  logs.keeper = join(dir, "keeper.log");
  logs.relayer = join(dir, "relayer.log");
  const start = (script: string, envFile: string, logFile: string, extra: Record<string, string> = {}) => {
    const out = openSync(logFile, "a");
    children.push(spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...readEnv(join(base, envFile)), ...extra }, stdio: ["ignore", out, out] }));
  };
  start(KEEPER, "keeper.env", logs.keeper);
  await waitFor(`http://${listen.keeper}/v1/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  start(RELAYER, "relayer.env", logs.relayer, { OSTRA_RELAYER_CLIENT_IP: "socket" });
  relayerUrl = `http://${listen.relayer}`;
  await waitFor(`${relayerUrl}/v1/relayer`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
});

after(async () => {
  for (const c of children) c.kill();
  await fork?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// The agents
// ---------------------------------------------------------------------------------------------

const home = () => join(dir, "agent");
async function openAgent(relayer: boolean): Promise<Agent> {
  return Agent.open(
    await loadConfig({
      OSTRA_HOME: home(),
      OSTRA_DEPLOYMENT: join(dir, "deployment.json"),
      OSTRA_RPC_URL: fork.url,
      OSTRA_LOGS_RPC_URL: fork.url,
      OSTRA_RELAYER_URL: relayer ? relayerUrl : "off",
      OSTRA_KEEPER_URL: "off",
      OSTRA_AGGREGATOR_URL: "off",
      OSTRA_ETH_RPC_URL: "off",
      OSTRA_RAETO_URL: "off",
      OSTRA_PAD_INDEXER_URL: "off",
      OSTRA_PROVER: PROVER,
    }),
    () => {},
  );
}

type Provider = { name: string; vault: Address; buyer: VaultService; rep: ReputationService; creator?: VaultService; folder: MemoryFolder; sender: LocalSender };

/** One spend of `vs`, simulated with a throwaway key, then signed and sent. */
async function spend(vs: VaultService, payer: Address, action: number, params: Hex, what: string): Promise<void> {
  const at = await vs.vaultAddress();
  const sim = await simulateVaultSpend(client(), d, { relayer: payer, vault: at, action, params });
  const r = await vs.operate({ gas: (sim.gasUsed * 5n) / 4n + 100_000n, what, build: async ({ v, vault: a, keychain, chainId }) => [spendCall(a, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))] });
  assert.equal(r.status, "sent", what);
}

function config(): Config {
  return { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
}

/** A provider of core's services on a fresh vault of the live factory, with a local fee payer. */
async function provider(name: string, seed: number): Promise<Provider> {
  const transport = retryingHttp(fork.url);
  const folder = new MemoryFolder();
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(dir, name)), folder, backupExported: async () => true });
  const creatorKeys = new Keys({ master: new Uint8Array(32).fill(seed + 100), feePayer, store: new FileWotsStore(join(dir, `${name}-creator`)), folder: new MemoryFolder(), backupExported: async () => true });
  const sender = new LocalSender(client(), transport, feePayer);
  const buyer = new VaultService(client(), transport, config(), keys, sender, "buyer");
  const creator = new VaultService(client(), transport, config(), creatorKeys, sender, "creator");
  await buyer.open();
  const vault = getAddress(await buyer.vaultAddress());
  await fork.dealUsdg(vault, 20_000_000n);
  const rep = new ReputationService({ client: client(), config: config(), buyer, sender, folder, prover });
  return { name, vault, buyer, rep, creator, folder, sender };
}

// ---------------------------------------------------------------------------------------------
// OstraPad pool jobs on the live OstraPad
// ---------------------------------------------------------------------------------------------

const evaluators = Array.from({ length: 5 }, (_, i) => key(`evaluator-${i}`));

async function joinPool(): Promise<void> {
  for (const e of evaluators) {
    await fork.setBalance(e.address, 10n ** 18n);
    await fork.dealUsdg(e.address, 100_000_000n);
    await send(e, USDG, encodeFunctionData({ abi: usdgAbi, functionName: "approve", args: [OSTRAPAD, 100_000_000n] }));
    await send(e, OSTRAPAD, encodeFunctionData({ abi: ostraPadAbi, functionName: "joinPool", args: [e.address, 100_000_000n] }));
  }
}

/** Jobs open for `approve` (each an ApproveHash spend of OstraPad's action digest by the provider vault). */
type ProviderSide = { vault: Address; approve: (digest: Hex, what: string) => Promise<void> };

/** A pool job of BUDGET from a new client account to `p`, up to its decision; returns its id. */
async function poolJob(p: ProviderSide, n: number): Promise<Hex> {
  const c = key(`client-${n}`);
  await fork.setBalance(c.address, 10n ** 18n);
  const cs = keccak256(stringToHex(`client secret ${n}`));
  const ps = keccak256(stringToHex(`provider secret ${n}`));
  const terms: PadTerms = { client: c.address, provider: p.vault, evaluator: "0x0000000000000000000000000000000000000000", budget: BUDGET, description: sha256(stringToHex(`order ${n}`)), clientCommit: padCommit(cs), salt: keccak256(stringToHex(`salt ${n}`)) };
  const id = padJobId(terms);
  const need = BUDGET + ((await client().readContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: "evaluatorFeeFor", args: [BUDGET] })) as bigint);
  await fork.dealUsdg(c.address, need);
  await send(c, USDG, encodeFunctionData({ abi: usdgAbi, functionName: "approve", args: [OSTRAPAD, need] }));
  await send(c, OSTRAPAD, encodeFunctionData({ abi: ostraPadAbi, functionName: "create", args: [terms] }));
  const commit = padCommit(ps);
  await p.approve(padDigest({ kind: "accept", id, providerCommit: commit }), "Ostrapad accept approval");
  await send(feePayer, OSTRAPAD, encodeFunctionData({ abi: ostraPadAbi, functionName: "accept", args: [id, commit] }));
  await send(feePayer, OSTRAPAD, encodeFunctionData({ abi: ostraPadAbi, functionName: "reveal", args: [id, cs] }));
  await send(feePayer, OSTRAPAD, encodeFunctionData({ abi: ostraPadAbi, functionName: "reveal", args: [id, ps] }));
  const drawn = await client().getTransactionReceipt({ hash: await send(feePayer, OSTRAPAD, encodeFunctionData({ abi: ostraPadAbi, functionName: "draw", args: [id] })) });
  const ev = parseEventLogs({ abi: ostraPadAbi, logs: drawn.logs, eventName: "EvaluatorDrawn" })[0];
  assert.ok(ev !== undefined, "an evaluator is drawn");
  const evaluator = getAddress((ev.args as { evaluator: Address }).evaluator);
  const deliverable = sha256(stringToHex(`delivery ${n}`));
  await p.approve(padDigest({ kind: "submit", id, deliverable }), "Ostrapad submit approval");
  await send(feePayer, OSTRAPAD, encodeFunctionData({ abi: ostraPadAbi, functionName: "submit", args: [id, deliverable] }));
  // The drawn evaluator decides: one of this run's, or a live member of the pool, impersonated.
  await rpc(fork.url, "anvil_impersonateAccount", [evaluator]);
  await fork.setBalance(evaluator, 10n ** 18n);
  await send(evaluator, OSTRAPAD, encodeFunctionData({ abi: ostraPadAbi, functionName: "decide", args: [id, true, keccak256(stringToHex("good work"))] }));
  await rpc(fork.url, "anvil_stopImpersonatingAccount", [evaluator]);
  return id;
}

// ---------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------

let agentVault: Address;
let others: Provider[] = [];
let local: Agent;

test("the agent's first snapshot goes through the relayer, paid in USDG; the relayer refuses snapshots without their approval and to another contract", { timeout: 1_200_000 }, async () => {
  await mkdir(home(), { mode: 0o700 });
  const a = await openAgent(true);
  const status0 = await a.reputation.status();
  assert.equal(status0.deployed, true);
  assert.equal(status0.epoch, "0");
  const opened = await a.buyer.open();
  agentVault = getAddress(opened.vault);
  await fork.dealUsdg(agentVault, 30_000_000n);
  // A first relayed operation opens the vault's relayer channel.
  const w = await a.buyer.withdraw(key("sink").address, "0.5");
  assert.equal(w.status, "sent", JSON.stringify(w));
  const before = await usdg(agentVault);
  const s = await a.reputation.snapshot();
  assert.equal(s.status, "snapshotted", JSON.stringify(s));
  assert.equal(s.epoch, "0");
  assert.equal(s.index, 0);
  assert.equal(s.provable, true);
  assert.deepEqual(s.record, { completed: 0, clients: 0, volume: "0", rejected: 0, expired: 0, tier: 0, firstDay: 0, epoch: 0 });
  console.log(`gas: the relayed ApproveHash spend and snapshot (first leaf of the tree) ${(await client().getTransactionReceipt({ hash: s.txHash as Hex })).gasUsed}`);
  const tx = await client().getTransaction({ hash: s.txHash as Hex });
  assert.notEqual(getAddress(tx.from), getAddress(a.keys.feePayer.address), "the relayer's account sent it");
  assert.ok((await usdg(agentVault)) < before, "the relayer was paid in USDG from the vault's channel");
  assert.match(readFileSync(logs.relayer, "utf8"), new RegExp(s.txHash as string, "i"));
  // Once per epoch.
  assert.equal((await a.reputation.snapshot()).status, "snapshotted before");
  // Refusals of the relayer's gate: a snapshot whose approval is not in place (nonce 1 is not approved), and one to an
  // address that is not the configured OstraReputation.
  const status = await a.reputation.status();
  const idc = status.idc as Hex;
  const ask = async (call: { to: Address; data: Hex }) => {
    const r = await fetch(`${relayerUrl}/v1/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ calls: [call] }) });
    return { status: r.status, body: (await r.json()) as { error: string; message: string } };
  };
  const unapproved = await ask(repSnapshotCall(repAddress, agentVault, idc));
  assert.equal(unapproved.status, 422, JSON.stringify(unapproved));
  assert.match(unapproved.body.message, /has not approved this snapshot/);
  const elsewhere = await ask(repSnapshotCall(USDG, agentVault, idc));
  assert.equal(elsewhere.status, 422);
  assert.match(elsewhere.body.message, /not this relayer's OstraReputation/);
  // The reputation secret is a 0600 file in OSTRA_HOME, and no answer carries it.
  const { statSync } = await import("node:fs");
  assert.equal((statSync(join(home(), "reputation", "sk")).mode & 0o777).toString(8), "600");
  const secretHex = readFileSync(join(home(), "reputation", "sk"), "utf8").trim();
  assert.match(secretHex, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(s).includes(secretHex) && !JSON.stringify(status).includes(secretHex));
});

test("six providers earn a record with real pool jobs on the live OstraPad", { timeout: 2_400_000 }, async () => {
  // From here the agent runs without the relayer (the fork's clock moves days ahead): its fee payer pays gas.
  local = await openAgent(false);
  await fork.setBalance(local.keys.feePayer.address, 10n ** 19n);
  assert.equal(getAddress(await local.buyer.vaultAddress()), agentVault);
  const me: ProviderSide = {
    vault: agentVault,
    approve: async (digest, what) => spend(local.buyer, await local.sender.payer(), VAULT_ACTION.APPROVE_HASH, approveHashParams({ hash: digest, approved: true }), what),
  };
  others = [];
  for (let i = 0; i < 5; i++) others.push(await provider(`provider-${i}`, 61 + i));
  await joinPool();
  await fork.increaseTime(2 * DAY + 1);
  const ids: Hex[] = [];
  let n = 0;
  ids.push(await poolJob(me, n++));
  ids.push(await poolJob(me, n++));
  for (const p of others) ids.push(await poolJob({ vault: p.vault, approve: (digest, what) => spend(p.buyer, feePayer.address, VAULT_ACTION.APPROVE_HASH, approveHashParams({ hash: digest, approved: true }), what) }, n++));
  await fork.increaseTime(2 * DAY + 1);
  for (const id of ids) await send(feePayer, OSTRAPAD, encodeFunctionData({ abi: ostraPadAbi, functionName: "settle", args: [id] }));
  const mine = await readPadProvider(client(), agentVault);
  assert.deepEqual({ completed: mine.completed, clients: mine.clients, volume: mine.volume, rejected: mine.rejected }, { completed: 2, clients: 2, volume: 2n * BUDGET, rejected: 0 });
  for (const p of others) {
    const r = await readPadProvider(client(), p.vault);
    assert.deepEqual({ completed: r.completed, clients: r.clients, volume: r.volume }, { completed: 1, clients: 1, volume: BUDGET }, p.name);
  }
});

test("epoch 0: the others' first snapshots; no statement before any record is 30 days old", { timeout: 1_200_000 }, async () => {
  for (const p of others) {
    const s = await p.rep.snapshot();
    assert.equal(s.status, "snapshotted", JSON.stringify(s));
    assert.equal(s.epoch, "0");
    assert.deepEqual(s.record, { completed: 1, clients: 1, volume: "1", rejected: 0, expired: 0, tier: 0, firstDay: 4, epoch: 0 });
  }
  await assert.rejects(
    (others[0] as Provider).rep.prove({ scope: "ostra:test:early", recipient: agentVault, challenge: keccak256(stringToHex("early")) }),
    /no record is 30 days old yet/,
  );
});

let proven: Record<string, unknown>;
const verifierScope = "ostra:test:verifier";
const challenge = keccak256(stringToHex("a verifier's fresh challenge"));
const recipient = getAddress("0x00000000000000000000000000000000000BEEF1");

test("epoch 5: snapshots of every vault; under the withdrawal lock the approval waits its delay; the agent proves the default statement and a verifier checks it", { timeout: 2_400_000 }, async () => {
  const baseTs = (await client().readContract({ address: repAddress, abi: ostraReputationAbi, functionName: "BASE" })) as bigint;
  await fork.increaseTime(Number(baseTs + 5n * 7n * BigInt(DAY) + 60n - (await now())));
  assert.equal(((await client().readContract({ address: repAddress, abi: ostraReputationAbi, functionName: "currentEpoch" })) as bigint).toString(), "5");
  // The last provider turns its withdrawal lock on (36 hours): its approval is given for the epoch it holds in.
  const locked = others[4] as Provider;
  await spend(locked.buyer, feePayer.address, VAULT_ACTION.SET_WITHDRAWAL_LOCK, setWithdrawalLockParams({ withdrawal: key("withdrawal").address, delay: 36 * 3600, dailyLimit: 5_000_000n }), "withdrawal lock");
  const waiting = await locked.rep.snapshot();
  assert.equal(waiting.status, "approved, waiting", JSON.stringify(waiting));
  assert.equal(waiting.epoch, "5");
  const again = await locked.rep.snapshot();
  assert.equal(again.status, "approved, waiting", "nothing new is approved while it waits");
  assert.equal(again.approvalTx, undefined);
  const s = await local.reputation.snapshot();
  // Right after its own snapshot its leaf is the newest under the root: refused until 4 other vaults follow.
  await assert.rejects(local.reputation.prove({ scope: verifierScope, recipient, challenge }), /only 0 vaults snapshotted after this one in epoch 5: a proof waits for 4 \(4 more\)/);
  assert.equal(s.status, "snapshotted", JSON.stringify(s));
  assert.deepEqual(s.record, { completed: 2, clients: 2, volume: "2", rejected: 0, expired: 0, tier: 0, firstDay: 0, epoch: 5 });
  for (const p of others.slice(0, 4)) assert.equal((await p.rep.snapshot()).status, "snapshotted");
  // Five vaults so far: the default statement has an anonymity set of 5.
  await fork.increaseTime(36 * 3600 + 60);
  const sent = await locked.rep.snapshot();
  assert.equal(sent.status, "snapshotted", JSON.stringify(sent));
  assert.equal(sent.epoch, "5");
  assert.equal(sent.index, 5);
  console.log(`gas: a snapshot sent alone once its approval holds (sixth leaf) ${(await client().getTransactionReceipt({ hash: sent.txHash as Hex })).gasUsed}`);

  proven = await local.reputation.prove({ scope: verifierScope, recipient, challenge });
  assert.equal(proven.verifiedByProver, true);
  assert.equal(proven.anonymitySet, 6);
  assert.equal(proven.rootSize, 6);
  assert.equal(proven.epoch, "5");
  const t = proven.thresholdsShown as Record<string, unknown>;
  assert.deepEqual({ minCompleted: t.minCompleted, maxFailPermille: t.maxFailPermille, maxFirstDay: t.maxFirstDay }, { minCompleted: 0, maxFailPermille: 1000, maxFirstDay: 6 });
  assert.equal((proven.publicValues as string[]).length, 43);
  const th = proven.thresholds as { minCompleted: number; minClients: number; minVolume: bigint; maxFailPermille: number; minTier: number; maxFirstDay: number };
  const verifyData = encodeFunctionData({
    abi: ostraReputationAbi,
    functionName: "verify",
    args: [proven.root as Hex, proven.pseudonym as Hex, proven.scopeHash as Hex, recipient, challenge, { minCompleted: BigInt(th.minCompleted), minClients: BigInt(th.minClients), minVolume: th.minVolume, maxFailPermille: BigInt(th.maxFailPermille), minTier: BigInt(th.minTier), maxFirstDay: BigInt(th.maxFirstDay) }, proven.proof as Hex],
  });
  console.log(`gas: OstraReputation.verify as a transaction would use it ${await client().estimateGas({ account: feePayer.address, to: repAddress, data: verifyData })} (proof ${((proven.proof as string).length - 2) / 2} bytes)`);
  // Its execution alone, measured as the forge test does (gasleft() around the call), from a probe contract in a
  // transaction: GasProbe { function measure(address target, bytes calldata data) external returns (bool ok, uint256
  // used) { uint256 g = gasleft(); (ok,) = target.call(data); used = g - gasleft(); emit Used(ok, used); } }, solc
  // 0.8.30, optimizer 200 runs, cancun.
  const probeAbi = [
    { type: "function", name: "measure", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }], outputs: [{ name: "ok", type: "bool" }, { name: "used", type: "uint256" }] },
    { type: "event", name: "Used", inputs: [{ name: "ok", type: "bool", indexed: false }, { name: "gas", type: "uint256", indexed: false }] },
  ] as const;
  const probeWallet = createWalletClient({ account: deployer, chain: robinhoodChain, transport: http(fork.url) });
  const probe = (await client().waitForTransactionReceipt({ hash: await probeWallet.deployContract({ abi: probeAbi, bytecode: "0x6080604052348015600e575f5ffd5b506102058061001c5f395ff3fe608060405234801561000f575f5ffd5b5060043610610029575f3560e01c806305e832bc1461002d575b5f5ffd5b61004061003b366004610110565b61005b565b60408051921515835260208301919091520160405180910390f35b5f5f5f5a9050856001600160a01b0316858560405161007b92919061019b565b5f604051808303815f865af19150503d805f81146100b4576040519150601f19603f3d011682016040523d82523d5f602084013e6100b9565b606091505b50909350505a6100c990826101aa565b604080518515158152602081018390529193507f287cc7bf01f722698d56bd9f4c4593b0ea6725cfe041444f4925a3bf618385c0910160405180910390a150935093915050565b5f5f5f60408486031215610122575f5ffd5b83356001600160a01b0381168114610138575f5ffd5b9250602084013567ffffffffffffffff811115610153575f5ffd5b8401601f81018613610163575f5ffd5b803567ffffffffffffffff811115610179575f5ffd5b86602082840101111561018a575f5ffd5b939660209190910195509293505050565b818382375f9101908152919050565b818103818111156101c957634e487b7160e01b5f52601160045260245ffd5b9291505056fea2646970667358221220589527280f09931c670a8ce470918cf45aad328e19dad412e63b090fb38d48d764736f6c634300081e0033", args: [] }) })).contractAddress as Address;
  const measured = await client().waitForTransactionReceipt({ hash: await probeWallet.writeContract({ address: probe, abi: probeAbi, functionName: "measure", args: [repAddress, verifyData], gas: 30_000_000n, chain: robinhoodChain }) });
  const used = parseEventLogs({ abi: probeAbi, logs: measured.logs, eventName: "Used" })[0]?.args as { ok: boolean; gas: bigint };
  assert.equal(used.ok, true);
  console.log(`gas: OstraReputation.verify execution (gasleft around the call, in a transaction) ${used.gas}; the transaction ${measured.gasUsed}`);
  // The verifier: its own scope text, recipient, challenge and thresholds (the proof's maxFirstDay).
  const verifier = others[0] as Provider;
  const v = await verifier.rep.verify({ scope: verifierScope, recipient, challenge, root: proven.root as string, pseudonym: proven.pseudonym as string, proof: proven.proof as string, thresholds: { maxFirstDay: 6 } });
  assert.equal(v.valid, true, JSON.stringify(v));
  assert.equal(v.rootSize, 6);
  assert.equal(v.anonymitySet, 6);
  // No verdict is never "invalid": too little gas (InsufficientGas: 12,000,000 for the whole call, its 81 KB of
  // calldata taken first) and a failed read are unverifiable; a tampered proof is a genuine rejection.
  const q = { root: proven.root as Hex, pseudonym: proven.pseudonym as Hex, scope: proven.scopeHash as Hex, recipient, challenge, thresholds: th, proof: proven.proof as Hex };
  assert.deepEqual(await repVerify(client(), repAddress, q), { valid: true, reverted: null, unverifiable: null });
  assert.deepEqual(await repVerify(client(), repAddress, q, undefined, 12_000_000n), { valid: false, reverted: null, unverifiable: "InsufficientGas" });
  const dead = createPublicClient({ chain: robinhoodChain, transport: http("http://127.0.0.1:9", { retryCount: 0 }) }) as PublicClient;
  const down = await repVerify(dead, repAddress, q);
  assert.equal(down.valid, false);
  assert.equal(down.reverted, null);
  assert.notEqual(down.unverifiable, null, "a failed read is no verdict");
  const p = q.proof;
  const at = 2 + 2 * 40_000;
  const tampered = `${p.slice(0, at)}${p.slice(at, at + 2) === "00" ? "01" : "00"}${p.slice(at + 2)}` as Hex;
  const rejected = await repVerify(client(), repAddress, { ...q, proof: tampered });
  assert.deepEqual(rejected, { valid: false, reverted: null, unverifiable: null }, "RepVerifier rejects a tampered proof: a verdict");
  const unknownRoot = await repVerify(client(), repAddress, { ...q, root: repPackDigest([1, 2, 3, 4, 5, 6, 7, 8]) });
  assert.deepEqual(unknownRoot, { valid: false, reverted: "UnknownRoot", unverifiable: null });
  // Bound to the recipient, the challenge, the scope and the thresholds.
  for (const other of [
    { recipient: agentVault },
    { challenge: keccak256(stringToHex("another")) },
    { scope: "ostra:test:another" },
    { thresholds: { maxFirstDay: 6, minCompleted: 1 } },
  ]) {
    const x = await verifier.rep.verify({ scope: verifierScope, recipient, challenge, root: proven.root as string, pseudonym: proven.pseudonym as string, proof: proven.proof as string, thresholds: { maxFirstDay: 6 }, ...other });
    assert.equal(x.valid, false, JSON.stringify(other));
  }
});

test("refused before proving: a statement only the agent meets (k = 5), one its record misses, a scope whose earlier statement leaves fewer than 5", { timeout: 1_200_000 }, async () => {
  await assert.rejects(local.reputation.prove({ scope: "ostra:test:k", recipient, challenge, thresholds: { minCompleted: 2 } }), /only 1 vault in epoch 5's tree meets this statement: a proof needs at least 5/);
  await assert.rejects(local.reputation.prove({ scope: "ostra:test:k", recipient, challenge, thresholds: { minCompleted: 3 } }), /does not meet the thresholds/);
  // A scope with one statement proven (volume at least 1 USDG: six vaults), then one only the agent meets in it.
  const first = await local.reputation.prove({ scope: "ostra:test:twice", recipient, challenge, thresholds: { minVolume: "1" } });
  assert.equal(first.anonymitySet, 6);
  // Alone, fail per mille below 1 holds for all six; with the earlier statement, still six.
  const second = await local.reputation.prove({ scope: "ostra:test:twice", recipient, challenge, thresholds: { maxFailPermille: 1 } });
  assert.equal(second.anonymitySet, 6);
  assert.equal(second.statementsInScope, 2);
  await assert.rejects(local.reputation.prove({ scope: "ostra:test:twice", recipient, challenge, thresholds: { minClients: 2 } }), /only 1 vault .* and the 2 proven before under this scope/);
});

test("the MCP tools over stdio on the agent's OSTRA_HOME: reputation_snapshot status, reputation_prove and reputation_verify", { timeout: 1_200_000 }, async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [here("../src/server.ts")],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      OSTRA_HOME: home(),
      OSTRA_DEPLOYMENT: join(dir, "deployment.json"),
      OSTRA_RPC_URL: fork.url,
      OSTRA_LOGS_RPC_URL: fork.url,
      OSTRA_RELAYER_URL: "off",
      OSTRA_KEEPER_URL: "off",
      OSTRA_AGGREGATOR_URL: "off",
      OSTRA_ETH_RPC_URL: "off",
      OSTRA_RAETO_URL: "off",
      OSTRA_PAD_INDEXER_URL: "off",
      OSTRA_PROVER: PROVER,
    },
    stderr: "pipe",
  });
  const mcp = new Client({ name: "ostra-reputation-test", version: "0.0.0" });
  await mcp.connect(transport);
  try {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as { isError?: boolean; content: { text: string }[] };
      const text = r.content[0]?.text ?? "";
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = {};
      }
      return { ok: r.isError !== true, text, json };
    };
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    for (const name of ["reputation_snapshot", "reputation_prove", "reputation_verify"]) assert.ok(tools.includes(name), name);
    const st = await call("reputation_snapshot", { action: "status" });
    assert.ok(st.ok && st.json.deployed === true && st.json.snapshottedThisEpoch === true && st.json.epoch === "5", st.text);
    assert.equal((st.json.account as { isThisAgents: boolean }).isThisAgents, true);
    const again = await call("reputation_snapshot");
    assert.ok(again.ok && again.json.status === "snapshotted before", again.text);
    const c = keccak256(stringToHex("stdio challenge"));
    const p = await call("reputation_prove", { scope: "ostra:test:stdio", recipient, challenge: c, minCompleted: 1, minVolume: "1" });
    assert.ok(p.ok && p.json.verifiedByProver === true && p.json.anonymitySet === 6, p.text.slice(0, 2_000));
    const shown = p.json.thresholdsShown as { maxFirstDay: number };
    const v = await call("reputation_verify", { scope: "ostra:test:stdio", recipient, challenge: c, root: p.json.root, pseudonym: p.json.pseudonym, proof: p.json.proof, minCompleted: 1, minVolume: "1", maxFirstDay: shown.maxFirstDay });
    assert.ok(v.ok && v.json.valid === true && v.json.anonymitySet === 6, v.text);
    const w = await call("reputation_verify", { scope: "ostra:test:stdio", recipient, challenge: keccak256(stringToHex("another")), root: p.json.root, pseudonym: p.json.pseudonym, proof: p.json.proof, minCompleted: 1, minVolume: "1", maxFirstDay: shown.maxFirstDay });
    assert.ok(w.ok && w.json.valid === false, w.text);
    const bad = await call("reputation_prove", { scope: "ostra:test:stdio", recipient, challenge: "0x12" });
    assert.equal(bad.ok, false);
  } finally {
    await mcp.close();
  }
});

test("Ostrapad: a listing with a reputation proof made for it is served by Ostra's index with its statements; a copy of that proof in another listing is not", { timeout: 2_400_000 }, async () => {
  // The lister snapshotted second in epoch 5 (four vaults after it); the copier's own record proves nothing here.
  const lister = others[0] as Provider;
  const copier = others[2] as Provider;
  const register = async (p: Provider) => {
    const creator = p.creator as VaultService;
    await creator.open();
    const creatorVault = getAddress(await creator.vaultAddress());
    let file: Record<string, unknown> = { ...profileFile({ vault: creatorVault }), name: p.name, description: `${p.name}, a test agent` };
    const uri = await upload(file);
    await spend(creator, feePayer.address, VAULT_ACTION.REGISTER_AGENT, registerAgentParams(uri), "agent registration");
    let agentId: bigint | null = null;
    const receipts = await client().getLogs({ address: creatorVault, fromBlock: (await client().getBlockNumber()) - 2n });
    for (const log of receipts) {
      try {
        const e = decodeEventLog({ abi: ostraVaultAbi, data: log.data, topics: log.topics });
        if (e.eventName === "AgentRegistered") agentId = (e.args as { agentId: bigint }).agentId;
      } catch {
        // another event
      }
    }
    assert.notEqual(agentId, null);
    file = { ...file, registrations: [{ agentId: Number(agentId), agentRegistry: "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }] };
    const pad = new PadService({
      client: client(),
      config: config(),
      buyer: p.buyer,
      sender: p.sender,
      folder: p.folder,
      identity: async () => ({ agentId, creatorVault }),
      currentFile: async () => file,
      publishFile: async (f) => {
        file = f;
        const u = await upload(f);
        await spend(creator, feePayer.address, VAULT_ACTION.SET_AGENT_URI, setAgentUriParams({ agentId: agentId as bigint, uri: u }), "agent registration file");
        return { uri: u, profile: { status: "sent", txHash: "0x", vaultNonce: "0" } as never, agentUri: null };
      },
      upload,
      indexerUrl: null,
      fetchBytes,
      listingProof: async (a) => (await p.rep.listingProof({ agentId: a.agentId, file: a.file, thresholds: a.thresholds as never, upload })).entry as unknown as Record<string, unknown>,
    });
    return { agentId: agentId as bigint, pad, file: () => file, creatorVault, setFile: (f: Record<string, unknown>) => (file = f) };
  };
  const offers = [{ id: "report", title: "Report", description: "A short report.", input: "The topic.", price: "1", hours: 24, evaluator: "pool" as const }];
  const l = await register(lister);
  const published = await l.pad.publish(offers, { minCompleted: 1 });
  const rep = published.reputation as { epoch: string; anonymitySet: number; proofParts: number };
  assert.equal(rep.epoch, "5");
  assert.equal(rep.anonymitySet, 6);
  assert.ok(rep.proofParts >= 10 && rep.proofParts <= 12, `${rep.proofParts} parts`);
  // The copier's listing carries the lister's proof object as it is.
  const c = await register(copier);
  await c.pad.publish(offers);
  const entryOf = (f: Record<string, unknown>) => (f.services as Record<string, unknown>[]).find((s) => s.name === "Ostrapad") as Record<string, unknown>;
  const copied = { ...c.file(), services: (c.file().services as Record<string, unknown>[]).map((s) => (s.name === "Ostrapad" ? { ...s, reputation: entryOf(l.file()).reputation } : s)) };
  await c.pad.publish(offers);
  const cu = await upload(copied);
  await spend(copier.creator as VaultService, feePayer.address, VAULT_ACTION.SET_AGENT_URI, setAgentUriParams({ agentId: c.agentId, uri: cu }), "the copied listing");

  // Ostra's index, from the fork's first block (the agents registered here).
  const indexLog: string[] = [];
  const index = new PadIndexer({ client: client(), deployment: () => ({ ...d, fromBlock: startBlock.toString() }), statePath: join(dir, "pad-state.json"), log: (e, f) => indexLog.push(`${e} ${JSON.stringify(f)}`), readFile: readJson });
  await index.sync();
  const shown = index.agent(l.agentId.toString());
  assert.notEqual(shown, null);
  const r = shown?.reputation;
  assert.ok(r !== null && r !== undefined, `${JSON.stringify(shown)}\n${indexLog.join("\n")}`);
  assert.equal(r.epoch, "5");
  assert.equal(r.statements.completedAtLeast, 1);
  assert.equal(r.statements.failPerMilleBelow, 1000);
  assert.equal(r.statements.firstSnapshotByDay, 6);
  assert.equal(r.rootSize, 6);
  assert.equal(r.anonymitySet, 6);
  const listed = index.listings({ limit: 50 }).agents.find((x) => x.agentId === l.agentId.toString());
  assert.equal(listed?.reputation?.statements.completedAtLeast, 1, "the listings carry it");
  const copiedShown = index.agent(c.agentId.toString());
  assert.equal(copiedShown?.offers.length, 1, "the copier's listing is read");
  assert.equal(copiedShown?.reputation, null, "a proof made for another listing shows nothing");
  // publish_profile rebuilds the file around the kept listing (its profile and card): the proof is made again for the
  // new content (carryListingReputation, as publishProfile runs it), and the index verifies the new one.
  const listingProof = async (a: { agentId: bigint; file: Record<string, unknown>; thresholds: Record<string, unknown> }) => (await lister.rep.listingProof({ agentId: a.agentId, file: a.file, thresholds: a.thresholds as never, upload })).entry as unknown as Record<string, unknown>;
  const rebuilt = () => ({ ...profileFile({ vault: l.creatorVault, agentId: l.agentId.toString(), image: "ipfs://bafkreiaaaa" }), services: [entryOf(l.file())] });
  const carried = await carryListingReputation({ file: rebuilt(), agentId: l.agentId, config: config(), client: client(), prove: listingProof });
  assert.equal(carried.reputation.status, "regenerated", JSON.stringify(carried.reputation));
  assert.equal(carried.reputation.anonymitySet, 6);
  const carriedEntry = entryOf(carried.file).reputation as { proofSha256: string; thresholds: unknown };
  assert.notEqual(carriedEntry.proofSha256, (entryOf(l.file()).reputation as { proofSha256: string }).proofSha256, "a new proof, for the new content");
  assert.deepEqual(carriedEntry.thresholds, (entryOf(l.file()).reputation as { thresholds: unknown }).thresholds, "the same statement");
  const ru = await upload(carried.file);
  await spend(lister.creator as VaultService, feePayer.address, VAULT_ACTION.SET_AGENT_URI, setAgentUriParams({ agentId: l.agentId, uri: ru }), "the rebuilt listing");
  l.setFile(carried.file);
  const reread = new PadIndexer({ client: client(), deployment: () => ({ ...d, fromBlock: startBlock.toString() }), statePath: join(dir, "pad-state-rebuilt.json"), log: () => {}, readFile: readJson });
  await reread.sync();
  assert.equal(reread.agent(l.agentId.toString())?.reputation?.statements.completedAtLeast, 1, "the proof made for the rebuilt file verifies");
  // A statement that no longer holds (made stricter here than the record meets): published without it, said so.
  const stricter = rebuilt();
  const se = entryOf(stricter);
  se.reputation = { ...(se.reputation as Record<string, unknown>), thresholds: { ...((se.reputation as { thresholds: Record<string, string> }).thresholds), minCompleted: "2" } };
  const dropped = await carryListingReputation({ file: stricter, agentId: l.agentId, config: config(), client: client(), prove: listingProof });
  assert.equal(dropped.reputation.status, "dropped");
  assert.match(dropped.reputation.note, /cannot be proven again now .*does not meet the thresholds.*published without a reputation proof/);
  assert.equal(entryOf(dropped.file).reputation, undefined);
  // A listing without a proof: nothing to carry.
  assert.equal((await carryListingReputation({ file: c.file(), agentId: c.agentId, config: config(), client: client(), prove: listingProof })).reputation.status, "none");

  // Lending: the lister's record also backs the copier's listing (a proof made for that listing: the copier's vault,
  // its content, the one listings scope). One record backs one listing an epoch: the index shows it for neither.
  const lent = await lister.rep.prove({ scope: PAD_LISTINGS_SCOPE_TEXT, recipient: copier.vault, challenge: padListingChallenge(c.file()), thresholds: { minCompleted: 1 } });
  const lentParts: string[] = [];
  for (const part of padReputationProofParts(lent.proof as Hex)) lentParts.push(await upload(part));
  const lentEntry = padReputationEntry({ reputation: repAddress, chainId: d.chainId, epoch: 5n, root: lent.root as Hex, pseudonym: lent.pseudonym as Hex, thresholds: lent.thresholds as never, proofParts: lentParts, proof: lent.proof as Hex, anonymitySet: lent.anonymitySet as number });
  assert.equal(lentEntry.pseudonym, (entryOf(l.file()).reputation as { pseudonym: string }).pseudonym, "one record, one pseudonym in the listings scope this epoch");
  const lentFile = { ...c.file(), services: (c.file().services as Record<string, unknown>[]).map((x) => (x.name === "Ostrapad" ? { ...x, reputation: lentEntry } : x)) };
  await spend(copier.creator as VaultService, feePayer.address, VAULT_ACTION.SET_AGENT_URI, setAgentUriParams({ agentId: c.agentId, uri: await upload(lentFile) }), "the lent listing");
  const lending = new PadIndexer({ client: client(), deployment: () => ({ ...d, fromBlock: startBlock.toString() }), statePath: join(dir, "pad-state-lent.json"), log: () => {}, readFile: readJson });
  await lending.sync();
  for (const id of [l.agentId, c.agentId]) {
    const x = lending.agent(id.toString());
    assert.equal(x?.reputation, null, `agent ${id}: a record backing two listings shows for neither`);
    assert.match(String(x?.reputationWithheld), /backs 2 listings in epoch 5/);
    assert.equal(x?.record?.completed, 1, "the provider vault's own public record is shown with no proof");
  }
  const listedLent = lending.listings({ limit: 50 }).agents.filter((x) => x.agentId === l.agentId.toString() || x.agentId === c.agentId.toString());
  assert.equal(listedLent.length, 2);
  assert.ok(listedLent.every((x) => x.reputation === null));

  // Next epoch: the proof no longer holds, and the index shows nothing until it is proven again.
  await fork.increaseTime(7 * DAY);
  const later = new PadIndexer({ client: client(), deployment: () => ({ ...d, fromBlock: startBlock.toString() }), statePath: join(dir, "pad-state-later.json"), log: () => {}, readFile: readJson });
  await later.sync();
  assert.equal(later.agent(l.agentId.toString())?.reputation, null);
  // publish_profile now: the epoch-5 proof is not carried, and the answer says why.
  const ended = await carryListingReputation({ file: rebuilt(), agentId: l.agentId, config: config(), client: client(), prove: listingProof });
  assert.equal(ended.reputation.status, "dropped");
  assert.match(ended.reputation.note, /made for epoch 5, which ended \(it is epoch 6\)/);
  // And the verifier's check refuses the epoch-5 proof's root now (OstraReputation: UnknownRoot).
  const stale = await (others[0] as Provider).rep.verify({ scope: verifierScope, includeEpoch: false, recipient, challenge, root: proven.root as string, pseudonym: proven.pseudonym as string, proof: proven.proof as string, thresholds: { maxFirstDay: 6 } });
  assert.equal(stale.valid, false);
  assert.equal(stale.refused, "UnknownRoot", JSON.stringify(stale));
});

test("rotation: a new secret scheduled with a snapshot, the old one proving in the pending epoch, the new one after it, files switched; the cooldown refused", { timeout: 1_800_000 }, async () => {
  const four = others.slice(0, 4);
  const epochNow = async () => (await client().readContract({ address: repAddress, abi: ostraReputationAbi, functionName: "currentEpoch" })) as bigint;
  assert.equal(await epochNow(), 6n);
  const before = await local.reputation.status();
  const oldIdc = before.idc as Hex;
  const r = await local.reputation.rotate();
  assert.equal(r.status, "scheduled", JSON.stringify(r));
  assert.equal(r.takesEffectInEpoch, "7");
  assert.notEqual(r.idc, oldIdc);
  assert.equal((r.snapshot as { provable: boolean }).provable, true, "this epoch's leaf carries the idc in force, still this agent's");
  const st = await local.reputation.status();
  assert.equal(st.idc, oldIdc, "the old secret stays in force here");
  assert.deepEqual({ idc: (st.rotation as { idc: string }).idc, from: (st.rotation as { takesEffectInEpoch: number }).takesEffectInEpoch }, { idc: r.idc, from: 7 });
  assert.deepEqual((st.account as { pendingIdc: unknown }).pendingIdc, { idc: r.idc, fromEpoch: 7 });
  assert.ok(existsSync(join(home(), "reputation", "sk")) && existsSync(join(home(), "reputation", "sk-1")), "both secrets kept");
  for (const p of four) assert.equal((await p.rep.snapshot()).status, "snapshotted");
  // The pending epoch: the old secret proves.
  const pending = await local.reputation.prove({ scope: "ostra:test:rotation", recipient, challenge });
  assert.equal(pending.anonymitySet, 5);
  assert.equal((await local.reputation.rotate()).status, "scheduled before");
  // Epoch 7: the first snapshot puts the new idc in force; the files switch; the new secret proves.
  const baseTs = (await client().readContract({ address: repAddress, abi: ostraReputationAbi, functionName: "BASE" })) as bigint;
  await fork.increaseTime(Number(baseTs + 7n * 7n * BigInt(DAY) + 60n - (await now())));
  assert.equal(await epochNow(), 7n);
  const s7 = await local.reputation.snapshot();
  assert.equal(s7.status, "snapshotted", JSON.stringify(s7));
  for (const p of four) assert.equal((await p.rep.snapshot()).status, "snapshotted");
  assert.equal(s7.provable, true);
  assert.match(String(s7.rotated), /in force from epoch 7/);
  const st7 = await local.reputation.status();
  assert.equal(st7.idc, r.idc);
  assert.equal(st7.rotation, null);
  assert.equal((st7.account as { isThisAgents: boolean }).isThisAgents, true);
  assert.ok(!existsSync(join(home(), "reputation", "sk")) && existsSync(join(home(), "reputation", "sk-1")), "the old secret removed once the new one is in force");
  const after7 = await local.reputation.prove({ scope: "ostra:test:rotation", recipient, challenge });
  assert.equal(after7.anonymitySet, 5);
  assert.notEqual(after7.pseudonym, pending.pseudonym);
  const v7 = await (others[0] as Provider).rep.verify({ scope: "ostra:test:rotation", recipient, challenge, root: after7.root as string, pseudonym: after7.pseudonym as string, proof: after7.proof as string, thresholds: { maxFirstDay: (after7.thresholds as { maxFirstDay: number }).maxFirstDay } });
  assert.equal(v7.valid, true, JSON.stringify(v7));
  // Epoch 8: the idc in force took effect in epoch 7, so the next may take effect from epoch 11: refused, nothing drawn.
  await fork.increaseTime(7 * DAY);
  assert.equal(await epochNow(), 8n);
  await assert.rejects(local.reputation.rotate(), /took effect in epoch 7; OstraReputation lets a new one take effect from epoch 11 only .*rotate from epoch 10 \(it is epoch 8\); nothing was drawn or signed/);
  const st8 = await local.reputation.status();
  assert.deepEqual({ idc: st8.idc, rotation: st8.rotation }, { idc: r.idc, rotation: null });
  assert.ok(!existsSync(join(home(), "reputation", "sk-2")));
  // An approval and a snapshot are not sent together within 10 minutes of an epoch's end.
  await fork.increaseTime(Number(baseTs + 9n * 7n * BigInt(DAY) - 300n - (await now())));
  await assert.rejects((others[0] as Provider).rep.snapshot(), /epoch 8 ends in \d+ s: a snapshot is not approved and sent within 10 minutes of an epoch's end/);
  await fork.increaseTime(400);
  assert.equal((await (others[0] as Provider).rep.snapshot()).epoch, "9");
});
