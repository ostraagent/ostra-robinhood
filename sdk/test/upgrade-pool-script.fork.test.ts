// scripts/upgrade-pool.ts on a mainnet fork, against the live deployment
// (deployments/robinhood-mainnet.json): the live beacons are handed to a test
// key on the fork (their owner is impersonated), the script refuses a pool
// that holds tokens, upgrades the empty live pool from version 1 to 2 keeping
// every setting, rewrites the record, and a second run only checks it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createWalletClient, getAddress, http, numberToHex, type Address, type Hex } from "viem";
import { ostraPoolAbi, upgradeableBeaconAbi } from "../src/abi.ts";
import { robinhoodChain } from "../src/chain.ts";
import { USDG } from "../src/constants.ts";
import { checkDeployment } from "../src/deploy.ts";
import { parseDeployment } from "../src/deployment.ts";
import { startFork, type Fork } from "./fork.ts";

const script = fileURLToPath(new URL("../scripts/upgrade-pool.ts", import.meta.url));
const live = parseDeployment(JSON.parse(readFileSync(fileURLToPath(new URL("../../deployments/robinhood-mainnet.json", import.meta.url)), "utf8")));
/** anvil's development account 3 (a public test key, used on the fork only). */
const DEV_KEY_3 = "0x7c852118294e51e653712a81e05800f5f2b2a8ae56a8a0b82e3d9e0a6c0ce58b";

let fork: Fork;
let dir: string;

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-upgrade-pool-"));
});

after(async () => {
  await fork.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 600_000 });

const read = (address: Address, abi: typeof ostraPoolAbi | typeof upgradeableBeaconAbi, functionName: string) =>
  fork.client.readContract({ address, abi, functionName } as Parameters<typeof fork.client.readContract>[0]);

test("upgrades the live pool from version 1 to 2 with the beacon owner's key, keeping every setting, then resumes as a check only", async () => {
  const key = join(dir, "owner.key");
  const rpcFile = join(dir, "rpc.url");
  const record = join(dir, "deployment.json");
  const testOwner = fork.accounts[3]?.address;
  if (testOwner === undefined) throw new Error("no fork account 3");

  // The live beacons go to the test key on the fork.
  assert.equal(getAddress((await read(live.poolBeacon, upgradeableBeaconAbi, "owner")) as Address), live.beaconOwner);
  await rpc("anvil_impersonateAccount", [live.beaconOwner]);
  await rpc("anvil_setBalance", [live.beaconOwner, numberToHex(10n ** 18n)]);
  const ownerWallet = createWalletClient({ account: live.beaconOwner, chain: robinhoodChain, transport: http(fork.url) });
  for (const beacon of [live.poolBeacon, live.vaultBeacon]) {
    const hash: Hex = await ownerWallet.writeContract({ address: beacon, abi: upgradeableBeaconAbi, functionName: "transferOwnership", args: [testOwner as Address], account: live.beaconOwner, chain: robinhoodChain });
    assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
  }
  await rpc("anvil_stopImpersonatingAccount", [live.beaconOwner]);
  await fork.setBalance(testOwner, 10n ** 18n);
  const d = { ...live, beaconOwner: testOwner };
  writeFileSync(record, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(key, `${DEV_KEY_3}\n`, { mode: 0o600 });
  writeFileSync(rpcFile, `${fork.url}\n`, { mode: 0o600 });
  chmodSync(key, 0o600);
  const env = { OSTRA_DEPLOYER_KEY_FILE: key, OSTRA_RPC_URL_FILE: rpcFile, OSTRA_DEPLOYMENT: record };

  const settings = async () => {
    const out: Record<string, string> = {};
    for (const name of ["token", "feeBps", "treasury", "initAuthority", "leafAmount", "maxDeposit", "maxTotal", "batchCount", "feesOwed"]) out[name] = String(await read(d.pool, ostraPoolAbi, name));
    return out;
  };
  const before = await settings();
  await assert.rejects(read(d.pool, ostraPoolAbi, "VERSION"), "version 1 has no VERSION");

  // A pool holding tokens is not upgraded.
  await rpc("anvil_dealERC20", [d.pool, USDG, numberToHex(1n)]);
  const held = run(env);
  assert.notEqual(held.status, 0);
  assert.match(held.stderr, /only an empty pool is upgraded/);
  await rpc("anvil_dealERC20", [d.pool, USDG, numberToHex(0n)]);
  assert.equal(getAddress((await read(d.poolBeacon, upgradeableBeaconAbi, "implementation")) as Address), live.poolImplementation);

  const first = run(env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /POOL_UPGRADE_OK/);
  assert.ok(!first.stdout.includes(DEV_KEY_3.slice(2)) && !first.stderr.includes(DEV_KEY_3.slice(2)), "the key is never printed");
  assert.ok(!first.stdout.includes(fork.url) && !first.stderr.includes(fork.url), "the RPC URL is never printed");
  const written = parseDeployment(JSON.parse(readFileSync(record, "utf8")));
  assert.notEqual(written.poolImplementation, live.poolImplementation);
  assert.deepEqual({ ...written, poolImplementation: live.poolImplementation }, d, "only poolImplementation changes in the record");
  assert.equal(getAddress((await read(d.poolBeacon, upgradeableBeaconAbi, "implementation")) as Address), written.poolImplementation);
  assert.equal(await read(d.pool, ostraPoolAbi, "VERSION"), 2);
  assert.deepEqual(await settings(), before);
  await checkDeployment(fork.client, written);

  const again = run(env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /"event":"checked"/);
  assert.ok(!again.stdout.includes('"event":"deployed"'), "a second run deploys nothing");
  assert.deepEqual(parseDeployment(JSON.parse(readFileSync(record, "utf8"))), written);
});
