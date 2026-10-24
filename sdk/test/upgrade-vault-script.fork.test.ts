// scripts/upgrade-vault.ts on a mainnet fork, against the live deployment
// (deployments/robinhood-mainnet.json): prepare deploys OstraVaultModule and the
// version 3 vault implementation and prints the upgrade to schedule; finalize
// refuses while the beacon still runs version 2; the upgrade then runs on the
// fork (OstraUpgradeOwner, impersonated, stands in for the scheduled call it
// executes after its delay), and finalize records it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createWalletClient, getAddress, http, numberToHex, type Address } from "viem";
import { ostraVaultAbi, ostraVaultModuleAbi, upgradeableBeaconAbi } from "../src/abi.ts";
import { robinhoodChain } from "../src/chain.ts";
import { BORRO_CODE, ERC8004_IDENTITY_REGISTRY, VAULT_V3 } from "../src/constants.ts";
import { checkDeployment } from "../src/deploy.ts";
import { parseDeployment } from "../src/deployment.ts";
import { startFork, type Fork } from "./fork.ts";

const script = fileURLToPath(new URL("../scripts/upgrade-vault.ts", import.meta.url));
const liveText = readFileSync(fileURLToPath(new URL("../../deployments/robinhood-mainnet.json", import.meta.url)), "utf8");
const live = parseDeployment(JSON.parse(liveText));
/** anvil's development account 3 (a public test key, used on the fork only). */
const DEV_KEY_3 = "0x7c852118294e51e653712a81e05800f5f2b2a8ae56a8a0b82e3d9e0a6c0ce58b";

let fork: Fork;
let dir: string;

async function anvil(method: string, params: unknown[]): Promise<void> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
}

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-upgrade-vault-"));
});

after(async () => {
  await fork.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("prepare deploys the module and version 3, finalize records the upgrade once it has run", async () => {
  if (live.vaultModule !== undefined) return; // the live record is version 3 already: nothing left to prepare
  const key = join(dir, "deployer.key");
  const rpc = join(dir, "rpc.url");
  const record = join(dir, "deployment.json");
  writeFileSync(key, `${DEV_KEY_3}\n`, { mode: 0o600 });
  writeFileSync(rpc, `${fork.url}\n`, { mode: 0o600 });
  writeFileSync(record, liveText, { mode: 0o644 });
  const deployer = fork.accounts[3];
  if (deployer === undefined) throw new Error("no fork account 3");
  await fork.setBalance(deployer.address, 10n ** 18n);
  const env = { PATH: process.env.PATH ?? "", OSTRA_DEPLOYER_KEY_FILE: key, OSTRA_RPC_URL_FILE: rpc, OSTRA_DEPLOYMENT: record };
  const run = (command: string) => spawnSync(process.execPath, [script, command], { env, encoding: "utf8", timeout: 600_000 });

  const prepared = run("prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /VAULT_V3_PREPARED/);
  assert.ok(!prepared.stdout.includes(fork.url) && !prepared.stderr.includes(fork.url), "the RPC URL is never printed");
  const state = JSON.parse(readFileSync(`${record}.vault-v3.json`, "utf8")) as { module: Address; implementation: Address };
  assert.match(prepared.stdout, new RegExp(`schedule-upgrade ${live.vaultBeacon} ${state.implementation}`));
  assert.equal(await fork.client.readContract({ address: state.implementation, abi: ostraVaultAbi, functionName: "VERSION" }), VAULT_V3);
  assert.equal(getAddress((await fork.client.readContract({ address: state.implementation, abi: ostraVaultAbi, functionName: "IDENTITY_REGISTRY" })) as Address), ERC8004_IDENTITY_REGISTRY);
  assert.equal(getAddress((await fork.client.readContract({ address: state.implementation, abi: ostraVaultAbi, functionName: "REGISTRY" })) as Address), live.registry);
  assert.equal(getAddress((await fork.client.readContract({ address: state.implementation, abi: ostraVaultAbi, functionName: "MODULE" })) as Address), getAddress(state.module));
  assert.equal(getAddress((await fork.client.readContract({ address: state.module, abi: ostraVaultModuleAbi, functionName: "FACTORY" })) as Address), live.vaultFactory);
  assert.equal(await fork.client.readContract({ address: state.module, abi: ostraVaultModuleAbi, functionName: "BORRO_CODE" }), BORRO_CODE);

  // Run again: nothing is deployed twice.
  const nonce = await fork.client.getTransactionCount({ address: deployer.address });
  const again = run("prepare");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(await fork.client.getTransactionCount({ address: deployer.address }), nonce, "a prepared upgrade sends nothing");

  const early = run("finalize");
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /has not run/);
  assert.equal(readFileSync(record, "utf8"), liveText, "the record is unchanged");

  // The scheduled call, as OstraUpgradeOwner executes it after its delay.
  const owner = getAddress((await fork.client.readContract({ address: live.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "owner" })) as Address);
  assert.equal(owner, live.beaconOwner);
  await anvil("anvil_impersonateAccount", [owner]);
  await anvil("anvil_setBalance", [owner, numberToHex(10n ** 18n)]);
  const wallet = createWalletClient({ account: owner, chain: robinhoodChain, transport: http(fork.url) });
  const hash = await wallet.writeContract({ address: live.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "upgradeTo", args: [state.implementation], account: owner, chain: robinhoodChain });
  assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
  await anvil("anvil_stopImpersonatingAccount", [owner]);

  const done = run("finalize");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /VAULT_V3_RECORDED/);
  assert.ok(!existsSync(`${record}.vault-v3.json`));
  const d = parseDeployment(JSON.parse(readFileSync(record, "utf8")));
  assert.equal(d.vaultImplementation, getAddress(state.implementation));
  assert.equal(d.vaultModule, getAddress(state.module));
  assert.equal(d.registry, live.registry);
  assert.equal(d.beaconOwner, live.beaconOwner);
  await checkDeployment(fork.client, d);

  const refused = run("prepare");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has a vault module already/);
});
