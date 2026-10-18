import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getAddress } from "viem";
import { loadMerchantConfig, parseIdleSeconds, parseListen, parseSplitsEnv } from "../src/config.ts";

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
const MARKET = getAddress("0x00000000000000000000000000000000000000aa");

let root: string;
let base: Record<string, string>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-merchant-config-"));
  await writeFile(join(root, "deployment.json"), JSON.stringify(deployment));
  base = {
    OSTRA_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
    OSTRA_DEPLOYMENT: join(root, "deployment.json"),
    OSTRA_MERCHANT_SECRETS: "/etc/ostra/merchant",
    OSTRA_MERCHANT_DATA: "/var/lib/ostra/merchant",
    OSTRA_MERCHANT_VAULT: "0x00000000000000000000000000000000000000bb",
    OSTRA_KEEPER_URL: "http://127.0.0.1:4100",
    OSTRA_MERCHANT_LISTEN: "127.0.0.1:4200",
    OSTRA_MERCHANT_PRICE: "1000",
  };
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the deployment names the token; the deposit is optional", () => {
  const c = loadMerchantConfig(base);
  assert.equal(c.deployment.token, deployment.token);
  assert.equal(c.vault, getAddress(base.OSTRA_MERCHANT_VAULT!));
  assert.equal(c.price, 1000n);
  assert.equal(c.suggestedDeposit, undefined);
  assert.deepEqual(c.listen, { host: "127.0.0.1", port: 4200 });
  assert.equal(loadMerchantConfig({ ...base, OSTRA_MERCHANT_DEPOSIT: "2500000" }).suggestedDeposit, 2_500_000n);
});

test("missing or invalid settings are refused without echoing the RPC URL", () => {
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_DEPLOYMENT: join(root, "missing.json") }), /could not be read/);
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_MERCHANT_VAULT: undefined }), /OSTRA_MERCHANT_VAULT/);
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_MERCHANT_VAULT: "0x1111" }), /OSTRA_MERCHANT_VAULT is not an address/);
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_KEEPER_URL: "ftp://keeper" }), /http or https/);
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_MERCHANT_PRICE: "0" }), /positive integer/);
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_MERCHANT_PRICE: "1.5" }), /positive integer/);
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_MERCHANT_PRICE: (1n << 128n).toString() }), /uint128/);
  assert.equal(loadMerchantConfig({ ...base, OSTRA_MERCHANT_PRICE: ((1n << 128n) - 1n).toString() }).price, (1n << 128n) - 1n);
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_MERCHANT_DEPOSIT: "-1" }), /positive integer/);
  assert.throws(
    () => loadMerchantConfig({ ...base, OSTRA_RPC_URL: "not a url secret-key-123" }),
    (err: Error) => /OSTRA_RPC_URL is not a URL/.test(err.message) && !err.message.includes("secret-key-123"),
  );
  assert.throws(() => parseListen("4200"), /host:port/);
  assert.throws(() => parseListen("127.0.0.1:0"), /1..65535/);
});

test("the seller's own splits and withdraw delay come from accept_payments' settings", () => {
  const c = loadMerchantConfig(base);
  assert.deepEqual(c.extraSplits, []);
  assert.equal(c.gracePeriodSeconds, undefined);
  const set = loadMerchantConfig({ ...base, OSTRA_MERCHANT_SPLITS: JSON.stringify([{ recipient: MARKET.toLowerCase(), bps: 100 }]), OSTRA_MERCHANT_GRACE_SECONDS: "1800" });
  assert.deepEqual(set.extraSplits, [{ recipient: MARKET, bps: 100 }]);
  assert.equal(set.gracePeriodSeconds, 1800);
  // The idle timeout: the 300 s default unless set; any whole number of seconds a Node timer can wait.
  assert.equal(c.idleTimeoutSeconds, undefined);
  assert.equal(loadMerchantConfig({ ...base, OSTRA_MERCHANT_IDLE_SECONDS: "20" }).idleTimeoutSeconds, 20);
  assert.equal(parseIdleSeconds("2147483"), 2_147_483);
  assert.throws(() => parseIdleSeconds("2147484"), /OSTRA_MERCHANT_IDLE_SECONDS/);
  assert.throws(() => parseIdleSeconds("0"), /OSTRA_MERCHANT_IDLE_SECONDS/);
  assert.throws(() => parseIdleSeconds("1.5"), /OSTRA_MERCHANT_IDLE_SECONDS/);
  assert.deepEqual(parseSplitsEnv("[]"), []);
  assert.throws(() => parseSplitsEnv("{"), /not JSON/);
  assert.throws(() => parseSplitsEnv('{"recipient":"x"}'), /JSON array/);
  assert.throws(() => parseSplitsEnv('[{"recipient":1,"bps":1}]'), /\[0\] must be/);
  assert.throws(() => parseSplitsEnv('[{"recipient":"bad","bps":1}]'), /not an address/);
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_MERCHANT_GRACE_SECONDS: "0" }), /GRACE_SECONDS/);
  assert.equal(loadMerchantConfig({ ...base, OSTRA_MERCHANT_GRACE_SECONDS: "2592000" }).gracePeriodSeconds, 2_592_000);
  assert.throws(() => loadMerchantConfig({ ...base, OSTRA_MERCHANT_GRACE_SECONDS: "2592001" }), /GRACE_SECONDS/);
});
