import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig, parseListen } from "../src/config.ts";

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
  root = await mkdtemp(join(tmpdir(), "ostra-keeper-config-"));
  await writeFile(join(root, "deployment.json"), JSON.stringify(deployment));
  base = {
    OSTRA_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
    OSTRA_DEPLOYMENT: join(root, "deployment.json"),
    OSTRA_KEEPER_SECRETS: "/etc/ostra/keeper",
    OSTRA_KEEPER_DATA: "/var/lib/ostra/keeper",
    OSTRA_KEEPER_LISTEN: "127.0.0.1:4100",
    OSTRA_KEEPER_FEE_RECIPIENT: "0x00000000000000000000000000000000000000aa",
  };
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the deployment, listen address and fee recipient are read", () => {
  const c = loadConfig(base);
  assert.equal(c.deployment.token, deployment.token);
  assert.equal(c.deployment.chainId, 4663);
  assert.deepEqual(c.listen, { host: "127.0.0.1", port: 4100 });
  assert.equal(c.feeRecipient, "0x00000000000000000000000000000000000000AA");
});

test("missing or invalid settings are refused", async () => {
  assert.throws(() => loadConfig({ ...base, OSTRA_RPC_URL: "" }), /OSTRA_RPC_URL/);
  assert.throws(() => loadConfig({ ...base, OSTRA_KEEPER_DATA: undefined }), /OSTRA_KEEPER_DATA/);
  assert.throws(() => loadConfig({ ...base, OSTRA_KEEPER_FEE_RECIPIENT: "" }), /OSTRA_KEEPER_FEE_RECIPIENT/);
  assert.throws(() => loadConfig({ ...base, OSTRA_KEEPER_FEE_RECIPIENT: "not-an-address" }), /not an address/);
  assert.throws(() => loadConfig({ ...base, OSTRA_DEPLOYMENT: join(root, "missing.json") }), /could not be read/);
  await writeFile(join(root, "bad.json"), JSON.stringify({ ...deployment, pool: "0x12" }));
  assert.throws(() => loadConfig({ ...base, OSTRA_DEPLOYMENT: join(root, "bad.json") }), /pool is not an address/);
  assert.throws(() => parseListen("4100"), /host:port/);
  assert.throws(() => parseListen("127.0.0.1:"), /host:port/);
  assert.throws(() => parseListen("127.0.0.1:70000"), /1..65535/);
  assert.deepEqual(parseListen("[::1]:8080"), { host: "[::1]", port: 8080 });
});
