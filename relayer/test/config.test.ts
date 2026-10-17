import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getAddress } from "viem";
import { loadRelayerConfig, parseListen } from "../src/config.ts";

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
  root = await mkdtemp(join(tmpdir(), "ostra-relayer-config-"));
  await writeFile(join(root, "deployment.json"), JSON.stringify(deployment));
  base = {
    OSTRA_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
    OSTRA_DEPLOYMENT: join(root, "deployment.json"),
    OSTRA_KEEPER_URL: "http://127.0.0.1:4100",
    OSTRA_RELAYER_VAULT: "0x00000000000000000000000000000000000000bb",
    OSTRA_RELAYER_SECRETS: "/etc/ostra/relayer-secrets",
    OSTRA_RELAYER_DATA: "/var/lib/ostra/relayer",
    OSTRA_RELAYER_LISTEN: "127.0.0.1:4300",
  };
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("defaults: the socket's address; the token comes from the deployment", () => {
  const c = loadRelayerConfig(base);
  assert.equal(c.clientIp, "socket");
  assert.deepEqual(c.listen, { host: "127.0.0.1", port: 4300 });
  assert.equal(c.deployment.token, deployment.token);
  assert.equal(c.vault, getAddress("0x00000000000000000000000000000000000000bb"));
});

test("every variable is checked", () => {
  for (const name of Object.keys(base)) {
    const env: Record<string, string> = { ...base };
    delete env[name];
    assert.throws(() => loadRelayerConfig(env), new RegExp(name), name);
  }
  assert.throws(() => loadRelayerConfig({ ...base, OSTRA_RELAYER_VAULT: "not-an-address" }), /OSTRA_RELAYER_VAULT is not an address/);
  assert.throws(() => loadRelayerConfig({ ...base, OSTRA_KEEPER_URL: "ftp://x" }), /http or https/);
  assert.throws(() => loadRelayerConfig({ ...base, OSTRA_DEPLOYMENT: join(root, "missing.json") }), /OSTRA_DEPLOYMENT .* could not be read/);
  assert.throws(() => loadRelayerConfig({ ...base, OSTRA_RELAYER_CLIENT_IP: "x-forwarded-for" }), /socket or cf-connecting-ip/);
  assert.equal(loadRelayerConfig({ ...base, OSTRA_RELAYER_CLIENT_IP: "cf-connecting-ip" }).clientIp, "cf-connecting-ip");
});

test("listen addresses", () => {
  assert.deepEqual(parseListen("[::1]:80"), { host: "[::1]", port: 80 });
  assert.throws(() => parseListen("4300"), /host:port/);
  assert.throws(() => parseListen("h:0"), /1..65535/);
  assert.throws(() => parseListen("h:65536"), /1..65535/);
});
