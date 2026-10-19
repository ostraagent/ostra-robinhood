import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeFunctionData, size, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAX_LEAVES_PER_BATCH, ostraPoolAbi } from "@ostraagent/sdk";
import { MAX_DEPOSITS_PER_BATCH, loadConfig, parseListen } from "../src/config.ts";

const deployment = {
  version: 1,
  chainId: 4663,
  token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  batchSettlement: "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003",
  vaultImplementation: "0x0000000000000000000000000000000000000001",
  vaultBeacon: "0x0000000000000000000000000000000000000002",
  vaultFactory: "0x0000000000000000000000000000000000000003",
  poolImplementation: "0x0000000000000000000000000000000000000004",
  poolBeacon: "0x0000000000000000000000000000000000000005",
  pool: "0x0000000000000000000000000000000000000006",
  splitFactory: "0x0000000000000000000000000000000000000007",
  beaconOwner: "0x0000000000000000000000000000000000000008",
  fromBlock: "1",
};

let root: string;
let base: Record<string, string>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-aggregator-config-"));
  await writeFile(join(root, "deployment.json"), JSON.stringify(deployment));
  base = {
    OSTRA_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
    OSTRA_DEPLOYMENT: join(root, "deployment.json"),
    OSTRA_AGGREGATOR_SECRETS: "/etc/ostra/aggregator",
    OSTRA_AGGREGATOR_DATA: "/var/lib/ostra/aggregator",
    OSTRA_AGGREGATOR_LISTEN: "127.0.0.1:4500",
  };
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the deployment, directories and listen address are read", () => {
  const c = loadConfig(base);
  assert.equal(c.deployment.pool, deployment.pool);
  assert.equal(c.deployment.token, deployment.token);
  assert.equal(c.deployment.chainId, 4663);
  assert.equal(c.secretsDir, "/etc/ostra/aggregator");
  assert.equal(c.dataDir, "/var/lib/ostra/aggregator");
  assert.deepEqual(c.listen, { host: "127.0.0.1", port: 4500 });
});

test("missing or invalid settings are refused", async () => {
  assert.throws(() => loadConfig({ ...base, OSTRA_RPC_URL: "" }), /OSTRA_RPC_URL/);
  assert.throws(() => loadConfig({ ...base, OSTRA_DEPLOYMENT: undefined }), /OSTRA_DEPLOYMENT/);
  assert.throws(() => loadConfig({ ...base, OSTRA_AGGREGATOR_SECRETS: undefined }), /OSTRA_AGGREGATOR_SECRETS/);
  assert.throws(() => loadConfig({ ...base, OSTRA_AGGREGATOR_DATA: "" }), /OSTRA_AGGREGATOR_DATA/);
  assert.throws(() => loadConfig({ ...base, OSTRA_AGGREGATOR_LISTEN: undefined }), /OSTRA_AGGREGATOR_LISTEN/);
  assert.throws(() => loadConfig({ ...base, OSTRA_DEPLOYMENT: join(root, "missing.json") }), /could not be read/);
  await writeFile(join(root, "bad.json"), JSON.stringify({ ...deployment, pool: "0x12" }));
  assert.throws(() => loadConfig({ ...base, OSTRA_DEPLOYMENT: join(root, "bad.json") }), /pool is not an address/);
  assert.throws(() => parseListen("4500"), /host:port/);
  assert.throws(() => parseListen("127.0.0.1:"), /host:port/);
  assert.throws(() => parseListen("127.0.0.1:70000"), /1..65535/);
  assert.deepEqual(parseListen("[::1]:8080"), { host: "[::1]", port: 8080 });
});

/** The signed sealBatch transaction of `deposits` deposits, in bytes (largest field values, so no encoding is shorter). */
async function sealBatchSize(deposits: number): Promise<number> {
  const keys = Array.from({ length: deposits }, () => `0x${"ff".repeat(32)}` as Hex);
  const data = encodeFunctionData({ abi: ostraPoolAbi, functionName: "sealBatch", args: [(1n << 64n) - 1n, keys] });
  // A public test key (anvil's account 1); the transaction is only measured, never sent.
  const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const tx = await account.signTransaction({
    chainId: 4663,
    type: "eip1559",
    to: deployment.pool as Hex,
    data,
    gas: 32_000_000n,
    maxFeePerGas: 10n ** 12n,
    maxPriorityFeePerGas: 10n ** 12n,
    nonce: 1_000_000,
  });
  return size(tx);
}

test("a sealBatch of every deposit a batch can hold is far below the sequencer's 95,000-byte transaction limit", async () => {
  assert.equal(MAX_DEPOSITS_PER_BATCH, 43);
  assert.ok(MAX_DEPOSITS_PER_BATCH <= MAX_LEAVES_PER_BATCH);
  // A deposit carries at least one leaf, so no batch has more deposits than leaves.
  const most = await sealBatchSize(MAX_LEAVES_PER_BATCH);
  assert.ok(most <= 10_000, `${most} bytes`);
});
