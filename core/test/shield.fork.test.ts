// shield and unshield on a fork of Robinhood Chain mainnet, against the real
// aggregator (aggregator/src, its HTTP endpoint served on a local port), with
// the agent's own fee payer sending (LocalSender, as without the relayer):
//   * eight shield deposits: seven of one leaf from the buyer vault, and one
//     of two leaves the creator vault's auto-shield makes from its balance
//     above what it keeps (its own records folder and sender, the agent's
//     shield records); each service moves on only its own vault's deposits.
//     The first batch of the eight is abandoned: the creator vault's service
//     does not sweep within the approval time. Its leaves are public, so
//     every deposit sends a new leaf set (attempt 1) when the aggregator asks.
//     The aggregator builds the next batch of the eight, sharing no leaf with
//     the abandoned one; every deposit approves it
//     after checking it on-chain, the aggregator seals it and every deposit
//     is closed; the pool fee reaches the treasury;
//   * unshield of the nine leaves at once (window 0), the creator's among
//     them: each leaf goes into its own new private vault, created and funded
//     in one transaction;
//   * a ninth deposit no batch takes (fewer than eight): once
//     DEPOSIT_TIMEOUT_SECONDS have passed on the chain, the sweep cancels it
//     and the pool refunds it in full to the vault;
//   * a deposit the pool has no room for (its total limit) is refused before
//     anything is signed: nothing leaves the vault and nothing is recorded.
// The aggregator's pass runs when the test calls it instead of every 30
// seconds, so the test does not wait for its timer, and the wall clock the
// aggregator and the agent read (Date.now) is moved forward past the approval
// time instead of waiting it out.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { keccak256, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEPOSIT_TIMEOUT_SECONDS, FileWotsStore, LEAF_DENOMINATION, USDG, depositForLeaves, readBatch, readPool, retryingHttp, usdgAbi, type Deployment } from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Aggregator } from "../../aggregator/src/aggregator.ts";
import { Sender as AggregatorSender } from "../../aggregator/src/chain.ts";
import { APPROVAL_SECONDS, loadConfig as loadAggregatorConfig } from "../../aggregator/src/config.ts";
import { createAggregatorServer } from "../../aggregator/src/http.ts";
import { ensurePrivateDir } from "../../aggregator/src/keys.ts";
import { StateStore } from "../../aggregator/src/store.ts";
import { Keys, LEAF_KEYS_PER_ATTEMPT, LocalSender, RELAYER_CHANNEL_DEPOSIT, ShieldService, UnshieldService, VaultService, X402_NETWORK, type Config, type PrivateVaultContext } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

const DEPOSITS = 8;
/** Deposits of one leaf from the buyer vault; the eighth is the creator vault's auto-shield of two leaves. */
const BUYER_DEPOSITS = DEPOSITS - 1;
const CREATOR_LEAVES = 2;
const LEAVES = BUYER_DEPOSITS + CREATOR_LEAVES;

let fork: Fork;
let d: Deployment;
let root: string;
let server: Server | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      s.close(() => (address !== null && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-shield-"));
  fork = await startFork();
  d = await deployOnFork(fork);
});

after(async () => {
  server?.close();
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("eight shield deposits, one of them the creator vault's auto-shield, are sealed in one batch, unshielded into nine private vaults, and a lone deposit is refunded after the timeout", async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const balanceOf = (x: Address) => client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [x] });

  // The aggregator, in this process, on its own key and state.
  const port = await freePort();
  await writeFile(join(root, "deployment.json"), JSON.stringify(d));
  const aggregatorConfig = loadAggregatorConfig({
    OSTRA_RPC_URL: fork.url,
    OSTRA_DEPLOYMENT: join(root, "deployment.json"),
    OSTRA_AGGREGATOR_SECRETS: join(root, "aggregator-secrets"),
    OSTRA_AGGREGATOR_DATA: join(root, "aggregator-data"),
    OSTRA_AGGREGATOR_LISTEN: `127.0.0.1:${port}`,
  });
  await ensurePrivateDir(aggregatorConfig.dataDir);
  // A test key for the aggregator account; the service would read it from OSTRA_AGGREGATOR_SECRETS.
  const aggregatorKey = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/SHIELD-FORK/aggregator")));
  await fork.setBalance(aggregatorKey.address, 10n ** 18n);
  const aggregator = await Aggregator.open({
    client,
    config: aggregatorConfig,
    key: aggregatorKey,
    sender: new AggregatorSender(client, transport, aggregatorKey),
    store: new StateStore(aggregatorConfig.dataDir),
  });
  server = createAggregatorServer(aggregator);
  await new Promise<void>((resolve) => server?.listen(port, "127.0.0.1", () => resolve()));

  // The agent: one vault, its shield and unshield services, its private vaults.
  const config: Config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: `http://127.0.0.1:${port}`, aiUrl: null };
  const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/SHIELD-FORK/fee-payer")));
  await fork.setBalance(feePayer.address, 10n ** 18n);
  const keys = new Keys({ master: new Uint8Array(32).fill(21), feePayer, store: new FileWotsStore(join(root, "wots")), folder: new MemoryFolder(), backupExported: async () => true });
  const sender = new LocalSender(client, transport, feePayer);
  const vault = new VaultService(client, transport, config, keys, sender, "buyer");
  const shield = new ShieldService(client, config, keys, vault, sender);
  const privateContext = async (index: bigint): Promise<PrivateVaultContext> => {
    const privateKeys = await keys.forPrivateVault(config.chainId, d.token, index);
    return { vault: new VaultService(client, transport, config, privateKeys, sender, "private", index), sender };
  };
  const unshield = new UnshieldService(client, config, keys, shield, privateContext);

  const opened = await vault.open();
  assert.equal(opened.created, true);
  const p = await readPool(client, d.pool);
  const amount = depositForLeaves(1, p.feeBps);
  const creatorAmount = depositForLeaves(CREATOR_LEAVES, p.feeBps);
  await fork.dealUsdg(opened.vault, amount * BigInt(BUYER_DEPOSITS + 1));
  const treasuryBefore = await balanceOf(p.treasury);

  // The creator vault: its own records and sender; its shield service keeps the agent's shield records.
  const creatorKeys = await keys.forCreatorVault(config.chainId, d.token);
  const creatorSender = new LocalSender(client, transport, feePayer);
  const creatorVault = new VaultService(client, transport, config, creatorKeys, creatorSender, "creator");
  const creatorShield = new ShieldService(client, config, keys, creatorVault, creatorSender);
  const creator = await creatorVault.open();
  assert.equal(creator.created, true);
  assert.notEqual(creator.vault, opened.vault);
  // What a launch's dispatch paid it (the fork stands in for the payouts): two leaves and what it keeps, plus a little.
  await fork.dealUsdg(creator.vault, creatorAmount + RELAYER_CHANNEL_DEPOSIT + 5_000n);
  assert.deepEqual(await creatorShield.autoShield(), { vault: creator.vault, enabled: false, keep: "1" });
  assert.deepEqual(await creatorShield.sweep(), []);
  assert.equal(await balanceOf(creator.vault), creatorAmount + RELAYER_CHANNEL_DEPOSIT + 5_000n, "off: nothing shielded");
  assert.deepEqual(await creatorShield.setAutoShield(true), { vault: creator.vault, enabled: true, keep: "1" });

  // Seven deposits of one leaf from the buyer vault: each is registered and polled when it is made.
  for (let i = 0; i < BUYER_DEPOSITS; i++) {
    const r = await shield.shield(1);
    assert.equal(r.status, "pending");
    assert.equal(r.aggregator.status, "queued", JSON.stringify(r.aggregator));
  }
  assert.equal(await balanceOf(opened.vault), amount);

  // The creator vault's sweep shields its balance above what it keeps: one deposit of two leaves, once.
  assert.deepEqual(await creatorShield.sweep(), []);
  assert.equal(await balanceOf(creator.vault), RELAYER_CHANNEL_DEPOSIT + 5_000n);
  const creatorDeposit = (await shield.list()).filter((s) => s.vault === creator.vault);
  assert.equal(creatorDeposit.length, 1);
  assert.equal(creatorDeposit[0]?.leaves, CREATOR_LEAVES);
  assert.equal(creatorDeposit[0]?.status, "pending");
  assert.ok((await shield.list()).filter((s) => s.vault !== creator.vault).every((s) => s.vault === opened.vault));
  assert.deepEqual(await creatorShield.sweep(), []);
  assert.equal((await shield.list()).length, DEPOSITS, "nothing more is due");

  // The first batch: built and complete on-chain, approved by the buyer vault's seven deposits only.
  await aggregator.pass();
  await aggregator.pass();
  const first = (await aggregator.health()).open;
  assert.ok(first !== null && first.batch !== null && first.approveBy !== null && first.deposits === DEPOSITS && first.leaves === LEAVES, JSON.stringify(first));
  const abandonedId = BigInt(first.batch);
  assert.deepEqual(await shield.sweep(), []);
  await aggregator.pass();
  assert.notEqual((await aggregator.health()).open, null, "still waiting for the creator vault's approval");
  // The approval time passes (the wall clock moves; the chain's own time is not involved).
  const realNow = Date.now;
  let offset = 0;
  const shift = (seconds: number) => {
    offset += seconds * 1000;
    Date.now = () => realNow() + offset;
  };
  shift(APPROVAL_SECONDS + 1);
  await aggregator.pass();
  assert.equal((await aggregator.health()).open, null);
  const abandoned = await readBatch(client, d.pool, abandonedId);
  assert.equal(abandoned.status, "closed");
  assert.equal(abandoned.leafCount, LEAVES);
  shift(5);

  // Sweeps and aggregator passes until every deposit is closed: new leaf sets, build, approve, seal, close.
  for (let round = 0; round < 12; round++) {
    await aggregator.pass();
    assert.deepEqual(await shield.sweep(), []);
    assert.deepEqual(await creatorShield.sweep(), []);
    if ((await shield.list()).every((s) => s.status === "closed")) break;
  }
  const views = await shield.list();
  assert.equal(views.length, DEPOSITS);
  assert.ok(views.every((v) => v.status === "closed" && v.batch !== null && v.leavesInPool.length === v.leaves && v.leavesInPool.every((l) => !l.spent)), JSON.stringify(views));
  const batchId = BigInt(views[0]!.batch!);
  assert.ok(views.every((v) => v.batch === views[0]!.batch));
  const sealed = await readBatch(client, d.pool, batchId);
  assert.equal(sealed.status, "sealed");
  assert.equal(sealed.leafCount, LEAVES);
  assert.equal(sealed.unspent, LEAVES);
  assert.notEqual(batchId, abandonedId);
  // The sealed batch holds the second leaf sets only: no leaf of the abandoned batch is in it.
  const abandonedRoots = new Set(abandoned.leaves.map((l) => l.keyRoot.toLowerCase()));
  assert.ok(sealed.leaves.every((l) => !abandonedRoots.has(l.keyRoot.toLowerCase())));
  assert.ok(views.every((v) => v.leavesInPool.every((l) => l.key >= LEAF_KEYS_PER_ATTEMPT && l.key < 2 * LEAF_KEYS_PER_ATTEMPT)), JSON.stringify(views));
  assert.equal((await balanceOf(p.treasury)) - treasuryBefore, (amount - LEAF_DENOMINATION) * BigInt(BUYER_DEPOSITS) + (creatorAmount - LEAF_DENOMINATION * BigInt(CREATOR_LEAVES)));
  assert.equal((await aggregator.health()).queued, 0);

  // Unshield every leaf now, the creator's too: nine private vaults, ten tokens each.
  const u = await unshield.unshield(LEAVES, 0);
  assert.equal(u.leaves.length, LEAVES);
  assert.ok(u.leaves.every((l) => l.status === "spent"), JSON.stringify(u.leaves));
  const privateVaults = await unshield.vaults();
  assert.equal(privateVaults.length, LEAVES);
  assert.equal(new Set(privateVaults.map((v) => v.vault)).size, LEAVES);
  for (const v of privateVaults) assert.equal(await balanceOf(v.vault), LEAF_DENOMINATION);
  assert.equal((await readBatch(client, d.pool, batchId)).unspent, 0);
  assert.ok((await shield.list()).every((s) => s.leavesInPool.every((l) => l.spent)));

  // A ninth deposit alone: no batch below eight; after the timeout the sweep cancels it and the vault gets it all back.
  const lone = await shield.shield(1);
  assert.equal(lone.status, "pending");
  assert.equal(await balanceOf(opened.vault), 0n);
  await aggregator.pass();
  assert.equal((await aggregator.health()).open, null);
  assert.deepEqual(await shield.sweep(), []);
  assert.equal((await shield.list()).find((s) => s.index === lone.index)?.status, "pending");
  await fork.increaseTime(Number(DEPOSIT_TIMEOUT_SECONDS) + 1);
  assert.deepEqual(await shield.sweep(), []);
  const refunded = (await shield.list()).find((s) => s.index === lone.index);
  assert.equal(refunded?.status, "closed");
  assert.equal(await balanceOf(opened.vault), amount);

  // The pool counts every token it holds against maxTotal; filled to one unit short of the room a leaf needs,
  // it cannot take the deposit, so shield refuses it before the vault sends anything to a depositor key.
  await fork.dealUsdg(d.pool, p.maxTotal - amount + 1n);
  const recorded = (await shield.list()).length;
  await assert.rejects(shield.shield(1), /the pool has room for .*; nothing was signed/);
  assert.equal(await balanceOf(opened.vault), amount, "nothing left the vault");
  assert.equal((await shield.list()).length, recorded, "no deposit was recorded");
  Date.now = realNow;
});
