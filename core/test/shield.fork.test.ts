// shield and unshield on a fork of Robinhood Chain mainnet, against the real
// aggregator (aggregator/src, its HTTP endpoint served on a local port), with
// the agent's own fee payer sending (LocalSender, as without the relayer):
//   * eight shield deposits of one leaf from one vault: each sweep registers
//     and polls them; the aggregator builds one batch of the eight, every
//     deposit approves it after checking it on-chain, the aggregator seals it
//     and every deposit is closed; the pool fee reaches the treasury;
//   * unshield of the eight leaves at once (window 0): each leaf goes into
//     its own new private vault, created and funded in one transaction;
//   * a ninth deposit no batch takes (fewer than eight): once
//     DEPOSIT_TIMEOUT_SECONDS have passed on the chain, the sweep cancels it
//     and the pool refunds it in full to the vault.
// The aggregator's pass runs when the test calls it instead of every 30
// seconds, so the test does not wait for its timer.

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
import { loadConfig as loadAggregatorConfig } from "../../aggregator/src/config.ts";
import { createAggregatorServer } from "../../aggregator/src/http.ts";
import { ensurePrivateDir } from "../../aggregator/src/keys.ts";
import { StateStore } from "../../aggregator/src/store.ts";
import { Keys, LocalSender, ShieldService, UnshieldService, VaultService, X402_NETWORK, type Config, type PrivateVaultContext } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

const DEPOSITS = 8;

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

test("eight shield deposits are sealed in one batch, unshielded into eight private vaults, and a lone deposit is refunded after the timeout", async () => {
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
  await fork.dealUsdg(opened.vault, amount * BigInt(DEPOSITS + 1));
  const treasuryBefore = await balanceOf(p.treasury);

  // Eight deposits of one leaf: each is registered and polled when it is made.
  for (let i = 0; i < DEPOSITS; i++) {
    const r = await shield.shield(1);
    assert.equal(r.status, "pending");
    assert.equal(r.aggregator.status, "queued", JSON.stringify(r.aggregator));
  }
  assert.equal(await balanceOf(opened.vault), amount);

  // Sweeps and aggregator passes until every deposit is closed: build, approve, seal, close.
  for (let round = 0; round < 8; round++) {
    await aggregator.pass();
    assert.deepEqual(await shield.sweep(), []);
    if ((await shield.list()).every((s) => s.status === "closed")) break;
  }
  const views = await shield.list();
  assert.equal(views.length, DEPOSITS);
  assert.ok(views.every((v) => v.status === "closed" && v.batch !== null && v.leavesInPool.length === 1 && !v.leavesInPool[0]!.spent), JSON.stringify(views));
  const batchId = BigInt(views[0]!.batch!);
  assert.ok(views.every((v) => v.batch === views[0]!.batch));
  const sealed = await readBatch(client, d.pool, batchId);
  assert.equal(sealed.status, "sealed");
  assert.equal(sealed.leafCount, DEPOSITS);
  assert.equal(sealed.unspent, DEPOSITS);
  assert.equal((await balanceOf(p.treasury)) - treasuryBefore, (amount - LEAF_DENOMINATION) * BigInt(DEPOSITS));
  assert.equal((await aggregator.health()).queued, 0);

  // Unshield every leaf now: eight private vaults, ten tokens each.
  const u = await unshield.unshield(DEPOSITS, 0);
  assert.equal(u.leaves.length, DEPOSITS);
  assert.ok(u.leaves.every((l) => l.status === "spent"), JSON.stringify(u.leaves));
  const privateVaults = await unshield.vaults();
  assert.equal(privateVaults.length, DEPOSITS);
  assert.equal(new Set(privateVaults.map((v) => v.vault)).size, DEPOSITS);
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
});
