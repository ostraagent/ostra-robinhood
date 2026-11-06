// scripts/upgrade-vault.ts on a mainnet fork, against the live deployment
// (deployments/robinhood-mainnet.json, version 4): prepare deploys
// OstraVaultModuleV5 and the version 5 vault implementation (keeping the live
// OstraVaultModule and OstraVaultModuleV4), scans the live vaults' locks and
// prints the upgrade to schedule; finalize refuses while the beacon still
// runs version 4; the upgrade then runs on the fork (OstraUpgradeOwner,
// impersonated, stands in for the scheduled call it executes after its delay),
// and finalize records it. prepare refuses a build that is not of this
// checkout's sources, records each deployment (deployer, nonce, address)
// before sending it and adopts what is at a recorded address only when its
// code is exactly the build's.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createWalletClient, getAddress, getContractAddress, http, numberToHex, type Address } from "viem";
import { ostraVaultAbi, ostraVaultModuleV5Abi, upgradeableBeaconAbi } from "../src/abi.ts";
import { robinhoodChain } from "../src/chain.ts";
import { PRIORS_POOL, PRIORS_POOL_CODEHASH, VAULT_V5 } from "../src/constants.ts";
import { checkDeployment, vaultModuleV5Args } from "../src/deploy.ts";
import { parseDeployment } from "../src/deployment.ts";
import { checkDeployedCode, checkPrepared, type Deployed, type Prepared } from "../scripts/upgrade-vault.ts";
import { OUT_DIR, startFork, type Fork } from "./fork.ts";

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

test("prepare deploys module V5 and version 5, finalize records the upgrade once it has run", async () => {
  if (live.vaultModuleV5 !== undefined) return; // the live record is version 5 already: nothing left to prepare
  assert.ok(live.vaultModuleV4 !== undefined && live.vaultModule !== undefined, "the live record is a version 4 record");
  const key = join(dir, "deployer.key");
  const rpc = join(dir, "rpc.url");
  const record = join(dir, "deployment.json");
  writeFileSync(key, `${DEV_KEY_3}\n`, { mode: 0o600 });
  writeFileSync(rpc, `${fork.url}\n`, { mode: 0o600 });
  writeFileSync(record, liveText, { mode: 0o644 });
  const deployer = fork.accounts[3];
  if (deployer === undefined) throw new Error("no fork account 3");
  await fork.setBalance(deployer.address, 10n ** 18n);
  // The lock scan reads the factory's logs from the fork itself, so it sees what is made on the fork too.
  const env = { PATH: process.env.PATH ?? "", OSTRA_DEPLOYER_KEY_FILE: key, OSTRA_RPC_URL_FILE: rpc, OSTRA_DEPLOYMENT: record, OSTRA_LOGS_RPC_URL: fork.url };
  const run = (command: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, [script, command], { env: { ...env, ...extra }, encoding: "utf8", timeout: 600_000 });
  const statePath = `${record}.vault-v5.json`;
  const read = async (address: Address, abi: typeof ostraVaultAbi | typeof ostraVaultModuleV5Abi, functionName: string) =>
    fork.client.readContract({ address, abi: abi as never, functionName } as never) as Promise<unknown>;

  // A build that is not of this checkout's sources (one source's recorded keccak-256 changed) is refused before
  // anything is sent.
  const stale = join(dir, "out-stale");
  for (const [file, contract] of [["OstraVault.sol", "OstraVault"], ["OstraVaultModuleV5.sol", "OstraVaultModuleV5"]] as const) {
    const a = JSON.parse(readFileSync(`${OUT_DIR}/${file}/${contract}.json`, "utf8")) as { metadata: { sources: Record<string, { keccak256: string }> } };
    if (contract === "OstraVaultModuleV5") a.metadata.sources["src/OstraVaultModuleV5.sol"]!.keccak256 = `0x${"00".repeat(32)}`;
    mkdirSync(join(stale, file), { recursive: true });
    writeFileSync(join(stale, file, `${contract}.json`), JSON.stringify(a));
  }
  const nonce0 = await fork.client.getTransactionCount({ address: deployer.address });
  const refusedBuild = run("prepare", { OSTRA_OUT_DIR: stale });
  assert.notEqual(refusedBuild.status, 0);
  assert.match(refusedBuild.stderr, /is not of the src\/OstraVaultModuleV5.sol in this checkout: run forge build/);
  assert.equal(await fork.client.getTransactionCount({ address: deployer.address }), nonce0, "a stale build sends nothing");
  assert.ok(!existsSync(statePath));

  // A deployment recorded and never sent (a run stopped between the two) is sent at the same nonce, to the same address.
  const unsent: Deployed = { name: "OstraVaultModuleV5", deployer: deployer.address, nonce: nonce0, address: getContractAddress({ from: deployer.address, nonce: BigInt(nonce0) }) };
  writeFileSync(statePath, `${JSON.stringify({ moduleV5: unsent }, null, 2)}\n`, { mode: 0o644 });

  const prepared = run("prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /VAULT_V5_PREPARED/);
  assert.ok(!prepared.stdout.includes(fork.url) && !prepared.stderr.includes(fork.url), "the RPC URL is never printed");
  const steps = JSON.parse(readFileSync(statePath, "utf8")) as Prepared;
  assert.deepEqual(steps.moduleV5, unsent);
  for (const [i, step] of (["moduleV5", "implementation"] as const).entries()) {
    assert.equal(steps[step].deployer, deployer.address);
    assert.equal(steps[step].nonce, nonce0 + i);
    assert.equal(steps[step].address, getContractAddress({ from: deployer.address, nonce: BigInt(nonce0 + i) }));
  }
  const state = { moduleV5: steps.moduleV5.address, implementation: steps.implementation.address };
  assert.match(prepared.stdout, new RegExp(`next: node scripts/upgrade-owner.ts schedule-upgrade ${live.vaultBeacon} ${state.implementation}\n`));
  // The lock scan ran over every vault the factory made (whatever mainnet's vaults hold: their locks are the users').
  const scanned = prepared.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { event: string; vaults?: number; codeless?: number }).find((e) => e.event === "locks_scanned");
  assert.ok(scanned !== undefined && (scanned.vaults ?? 0) >= 192 && typeof scanned.codeless === "number", JSON.stringify(scanned));
  // What the two deployments used, against PREPARE_GAS_BUDGET (22,000,000) less room for the chain's data fee.
  const deployed = prepared.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { event: string; name?: string; gasUsed?: string }).filter((e) => e.event === "deployed");
  assert.deepEqual(deployed.map((e) => e.name), ["OstraVaultModuleV5", "OstraVault"]);
  const gas = deployed.reduce((a, e) => a + BigInt(e.gasUsed ?? "0"), 0n);
  console.log(`prepare deployment gas: ${deployed.map((e) => `${e.name} ${e.gasUsed}`).join(", ")}; ${gas} in all`);
  assert.ok(gas > 0n && gas < 18_000_000n, `prepare gas ${gas} leaves room within PREPARE_GAS_BUDGET`);
  assert.equal(await read(state.implementation, ostraVaultAbi, "VERSION"), VAULT_V5);
  // Version 5 keeps the live modules and adds module V5, bound to the live factory and module V4.
  assert.equal(getAddress((await read(state.implementation, ostraVaultAbi, "MODULE")) as Address), live.vaultModule);
  assert.equal(getAddress((await read(state.implementation, ostraVaultAbi, "MODULE_V4")) as Address), live.vaultModuleV4);
  assert.equal(getAddress((await read(state.implementation, ostraVaultAbi, "MODULE_V5")) as Address), getAddress(state.moduleV5));
  assert.equal(getAddress((await read(state.implementation, ostraVaultAbi, "REGISTRY")) as Address), live.registry);
  assert.equal(getAddress((await read(state.moduleV5, ostraVaultModuleV5Abi, "FACTORY")) as Address), live.vaultFactory);
  assert.equal(getAddress((await read(state.moduleV5, ostraVaultModuleV5Abi, "MODULE_V4")) as Address), live.vaultModuleV4);
  assert.equal(getAddress((await read(state.moduleV5, ostraVaultModuleV5Abi, "POOL")) as Address), PRIORS_POOL);
  assert.equal(await read(state.moduleV5, ostraVaultModuleV5Abi, "POOL_CODEHASH"), PRIORS_POOL_CODEHASH);

  // Run again: nothing is deployed twice; what is at each recorded address is adopted, its code checked.
  const nonce = await fork.client.getTransactionCount({ address: deployer.address });
  const again = run("prepare");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(await fork.client.getTransactionCount({ address: deployer.address }), nonce, "a prepared upgrade sends nothing");
  assert.equal(again.stdout.split("\n").filter((l) => l.includes('"event":"adopted"')).length, 2);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), steps);

  // The code check: exact, at the address the recorded deployer and nonce create, with the recorded arguments.
  const d0 = parseDeployment(JSON.parse(liveText));
  await checkPrepared(fork.client, OUT_DIR, steps, d0);
  const moduleArgs = vaultModuleV5Args(live.vaultFactory, live.vaultModuleV4!);
  await checkDeployedCode(fork.client, OUT_DIR, "moduleV5", steps.moduleV5, moduleArgs);
  // Module V5's code where the implementation is: refused.
  await assert.rejects(checkDeployedCode(fork.client, OUT_DIR, "moduleV5", steps.implementation, moduleArgs), /not this build's OstraVaultModuleV5/);
  // Another constructor argument (another factory): the immutables differ, refused.
  await assert.rejects(checkDeployedCode(fork.client, OUT_DIR, "moduleV5", steps.moduleV5, [live.vaultBeacon, ...moduleArgs.slice(1)]), /not this build's OstraVaultModuleV5/);
  // A record whose nonce does not create its address: refused.
  await assert.rejects(checkPrepared(fork.client, OUT_DIR, { ...steps, moduleV5: { ...steps.moduleV5, nonce: steps.moduleV5.nonce + 1 } }, d0), /not the address/);
  // A record naming another module V4 (or module, or registry) than the live one is refused: those are pinned.
  await assert.rejects(checkPrepared(fork.client, OUT_DIR, steps, { ...d0, vaultModuleV4: live.vaultModule }), /is not the live one/);
  await assert.rejects(checkPrepared(fork.client, OUT_DIR, steps, { ...d0, vaultModule: live.vaultModuleV4 }), /is not the live one/);
  // An implementation whose Initializable slot is not disabled for good (set on the fork): refused.
  const slot = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
  const disabled = await fork.client.getStorageAt({ address: state.implementation, slot });
  assert.equal(BigInt(disabled ?? "0x0"), (1n << 64n) - 1n);
  await anvil("anvil_setStorageAt", [state.implementation, slot, numberToHex(1, { size: 32 })]);
  await assert.rejects(checkPrepared(fork.client, OUT_DIR, steps, d0), /Initializable slot/);
  await anvil("anvil_setStorageAt", [state.implementation, slot, disabled]);
  await checkPrepared(fork.client, OUT_DIR, steps, d0);
  // A state file naming another deployer: prepare refuses to adopt it, finalize refuses deployments by two accounts.
  const other = getAddress("0x00000000000000000000000000000000000d0e00");
  writeFileSync(statePath, `${JSON.stringify({ ...steps, moduleV5: { ...steps.moduleV5, deployer: other } }, null, 2)}\n`);
  const foreign = run("prepare");
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, new RegExp(`records OstraVaultModuleV5 as deployed by ${other}, not by this deployer \\(${deployer.address}\\)`));
  const mixed = run("finalize");
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /names more than one deployer/);
  writeFileSync(statePath, `${JSON.stringify(steps, null, 2)}\n`);

  const early = run("finalize");
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /has not run/);
  assert.equal(readFileSync(record, "utf8"), liveText, "the record is unchanged");

  // The scan alone.
  const scan = run("scan-locks");
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stdout, /"event":"locks_scanned"/);
  assert.match(scan.stdout, /VAULT_LOCKS_SCANNED/);

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
  assert.match(done.stdout, /VAULT_V5_RECORDED/);
  assert.ok(!existsSync(statePath));
  const d = parseDeployment(JSON.parse(readFileSync(record, "utf8")));
  assert.equal(d.vaultImplementation, getAddress(state.implementation));
  assert.equal(d.vaultModuleV5, getAddress(state.moduleV5));
  assert.equal(d.vaultModule, live.vaultModule);
  assert.equal(d.vaultModuleV4, live.vaultModuleV4);
  assert.equal(d.registry, live.registry);
  assert.equal(d.beaconOwner, live.beaconOwner);
  await checkDeployment(fork.client, d);
  // The record's other fields are the live ones.
  const { vaultImplementation: _i, vaultModuleV5: _m5, ...rest } = d;
  const { vaultImplementation: _li, ...liveRest } = live;
  assert.deepEqual(rest, liveRest);

  // Finalize again only checks; prepare refuses a version 5 record.
  const checked = run("finalize");
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /VAULT_V5_RECORDED/);
  const refused = run("prepare");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has a vault module V5 already/);
});
