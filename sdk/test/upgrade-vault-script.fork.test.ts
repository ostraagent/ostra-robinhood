// scripts/upgrade-vault.ts on a mainnet fork, against the live deployment
// (deployments/robinhood-mainnet.json, version 3): prepare deploys a new
// OstraVaultModule, OstraVaultModuleV4 and the version 4 vault implementation
// and prints the upgrade to schedule; finalize refuses while the beacon still
// runs version 3; the upgrade then runs on the fork (OstraUpgradeOwner,
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
import { ostraVaultAbi, ostraVaultModuleAbi, ostraVaultModuleV4Abi, upgradeableBeaconAbi } from "../src/abi.ts";
import { robinhoodChain } from "../src/chain.ts";
import { BORRO_BUILDERS, BORRO_CODE, BORRO_ROUTER, ERC8004_IDENTITY_REGISTRY, MORPHO_BLUE, MORPHO_VAULT_V2_FACTORY, VAULT_V4 } from "../src/constants.ts";
import { checkDeployment } from "../src/deploy.ts";
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

test("prepare deploys the two modules and version 4, finalize records the upgrade once it has run", async () => {
  if (live.vaultModuleV4 !== undefined) return; // the live record is version 4 already: nothing left to prepare
  assert.ok(live.vaultModule !== undefined, "the live record is a version 3 record");
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
  const run = (command: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, [script, command], { env: { ...env, ...extra }, encoding: "utf8", timeout: 600_000 });
  const statePath = `${record}.vault-v4.json`;
  const read = async (address: Address, abi: typeof ostraVaultAbi | typeof ostraVaultModuleAbi | typeof ostraVaultModuleV4Abi, functionName: string) =>
    fork.client.readContract({ address, abi: abi as never, functionName } as never) as Promise<unknown>;

  // A build that is not of this checkout's sources (one source's recorded keccak-256 changed) is refused before
  // anything is sent.
  const stale = join(dir, "out-stale");
  for (const [file, contract] of [["OstraVault.sol", "OstraVault"], ["OstraVaultModule.sol", "OstraVaultModule"], ["OstraVaultModuleV4.sol", "OstraVaultModuleV4"]] as const) {
    const a = JSON.parse(readFileSync(`${OUT_DIR}/${file}/${contract}.json`, "utf8")) as { metadata: { sources: Record<string, { keccak256: string }> } };
    if (contract === "OstraVaultModuleV4") a.metadata.sources["src/OstraVaultModuleV4.sol"]!.keccak256 = `0x${"00".repeat(32)}`;
    mkdirSync(join(stale, file), { recursive: true });
    writeFileSync(join(stale, file, `${contract}.json`), JSON.stringify(a));
  }
  const nonce0 = await fork.client.getTransactionCount({ address: deployer.address });
  const refusedBuild = run("prepare", { OSTRA_OUT_DIR: stale });
  assert.notEqual(refusedBuild.status, 0);
  assert.match(refusedBuild.stderr, /is not of the src\/OstraVaultModuleV4.sol in this checkout: run forge build/);
  assert.equal(await fork.client.getTransactionCount({ address: deployer.address }), nonce0, "a stale build sends nothing");
  assert.ok(!existsSync(statePath));

  // A deployment recorded and never sent (a run stopped between the two) is sent at the same nonce, to the same address.
  const unsent: Deployed = { name: "OstraVaultModule", deployer: deployer.address, nonce: nonce0, address: getContractAddress({ from: deployer.address, nonce: BigInt(nonce0) }) };
  writeFileSync(statePath, `${JSON.stringify({ module: unsent }, null, 2)}\n`, { mode: 0o644 });

  const prepared = run("prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /VAULT_V4_PREPARED/);
  assert.ok(!prepared.stdout.includes(fork.url) && !prepared.stderr.includes(fork.url), "the RPC URL is never printed");
  const steps = JSON.parse(readFileSync(statePath, "utf8")) as Prepared;
  assert.deepEqual(steps.module, unsent);
  for (const [i, step] of (["module", "moduleV4", "implementation"] as const).entries()) {
    assert.equal(steps[step].deployer, deployer.address);
    assert.equal(steps[step].nonce, nonce0 + i);
    assert.equal(steps[step].address, getContractAddress({ from: deployer.address, nonce: BigInt(nonce0 + i) }));
  }
  const state = { module: steps.module.address, moduleV4: steps.moduleV4.address, implementation: steps.implementation.address };
  assert.match(prepared.stdout, new RegExp(`next: node scripts/upgrade-owner.ts schedule-upgrade ${live.vaultBeacon} ${state.implementation}\n`));
  // What the three deployments used, against PREPARE_GAS_BUDGET (19,000,000) less room for the chain's data fee.
  const deployed = prepared.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { event: string; name?: string; gasUsed?: string }).filter((e) => e.event === "deployed");
  assert.deepEqual(deployed.map((e) => e.name), ["OstraVaultModule", "OstraVaultModuleV4", "OstraVault"]);
  const gas = deployed.reduce((a, e) => a + BigInt(e.gasUsed ?? "0"), 0n);
  console.log(`prepare deployment gas: ${deployed.map((e) => `${e.name} ${e.gasUsed}`).join(", ")}; ${gas} in all`);
  assert.ok(gas > 0n && gas < 15_000_000n, `prepare gas ${gas} leaves room within PREPARE_GAS_BUDGET`);
  assert.equal(await read(state.implementation, ostraVaultAbi, "VERSION"), VAULT_V4);
  assert.equal(getAddress((await read(state.implementation, ostraVaultAbi, "IDENTITY_REGISTRY")) as Address), ERC8004_IDENTITY_REGISTRY);
  assert.equal(getAddress((await read(state.implementation, ostraVaultAbi, "REGISTRY")) as Address), live.registry);
  assert.equal(getAddress((await read(state.implementation, ostraVaultAbi, "MODULE")) as Address), getAddress(state.module));
  assert.equal(getAddress((await read(state.implementation, ostraVaultAbi, "MODULE_V4")) as Address), getAddress(state.moduleV4));
  // A new OstraVaultModule, bound as the live one is.
  assert.notEqual(getAddress(state.module), live.vaultModule);
  assert.equal(getAddress((await read(state.module, ostraVaultModuleAbi, "FACTORY")) as Address), live.vaultFactory);
  assert.equal(await read(state.module, ostraVaultModuleAbi, "BORRO_CODE"), BORRO_CODE);
  assert.equal(getAddress((await read(state.moduleV4, ostraVaultModuleV4Abi, "FACTORY")) as Address), live.vaultFactory);
  assert.equal(getAddress((await read(state.moduleV4, ostraVaultModuleV4Abi, "VAULT_V2_FACTORY")) as Address), MORPHO_VAULT_V2_FACTORY);
  assert.equal(getAddress((await read(state.moduleV4, ostraVaultModuleV4Abi, "IDENTITY_REGISTRY")) as Address), ERC8004_IDENTITY_REGISTRY);

  // Run again: nothing is deployed twice; what is at each recorded address is adopted, its code checked.
  const nonce = await fork.client.getTransactionCount({ address: deployer.address });
  const again = run("prepare");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(await fork.client.getTransactionCount({ address: deployer.address }), nonce, "a prepared upgrade sends nothing");
  assert.equal(again.stdout.split("\n").filter((l) => l.includes('"event":"adopted"')).length, 3);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), steps);

  // The code check: exact, at the address the recorded deployer and nonce create, with the recorded arguments.
  const d0 = parseDeployment(JSON.parse(liveText));
  await checkPrepared(fork.client, OUT_DIR, steps, d0);
  const moduleArgs = [live.vaultFactory, MORPHO_BLUE, MORPHO_VAULT_V2_FACTORY, BORRO_BUILDERS, BORRO_ROUTER, BORRO_CODE];
  await checkDeployedCode(fork.client, OUT_DIR, "module", steps.module, moduleArgs);
  // OstraVaultModule's code where OstraVaultModuleV4 is: refused.
  await assert.rejects(checkDeployedCode(fork.client, OUT_DIR, "module", steps.moduleV4, moduleArgs), /the code there is not this build's OstraVaultModule/);
  // Another constructor argument (another factory): the immutables differ, refused.
  await assert.rejects(checkDeployedCode(fork.client, OUT_DIR, "module", steps.module, [live.vaultBeacon, ...moduleArgs.slice(1)]), /not this build's OstraVaultModule/);
  // A record whose nonce does not create its address: refused.
  await assert.rejects(checkPrepared(fork.client, OUT_DIR, { ...steps, moduleV4: { ...steps.moduleV4, nonce: steps.moduleV4.nonce + 1 } }, d0), /not the address/);
  // A prepared state naming swapped modules: the implementation's immutables are not the ones it was built with.
  await assert.rejects(checkPrepared(fork.client, OUT_DIR, { ...steps, module: steps.moduleV4, moduleV4: steps.module }, d0), /not this build's/);
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
  writeFileSync(statePath, `${JSON.stringify({ ...steps, moduleV4: { ...steps.moduleV4, deployer: other } }, null, 2)}\n`);
  const foreign = run("prepare");
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, new RegExp(`records OstraVaultModuleV4 as deployed by ${other}, not by this deployer \\(${deployer.address}\\)`));
  const mixed = run("finalize");
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /names more than one deployer/);
  writeFileSync(statePath, `${JSON.stringify(steps, null, 2)}\n`);

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
  assert.match(done.stdout, /VAULT_V4_RECORDED/);
  assert.ok(!existsSync(statePath));
  const d = parseDeployment(JSON.parse(readFileSync(record, "utf8")));
  assert.equal(d.vaultImplementation, getAddress(state.implementation));
  assert.equal(d.vaultModule, getAddress(state.module));
  assert.equal(d.vaultModuleV4, getAddress(state.moduleV4));
  assert.equal(d.registry, live.registry);
  assert.equal(d.beaconOwner, live.beaconOwner);
  assert.equal(d.breaker, live.breaker);
  assert.deepEqual(d.launchpad, live.launchpad);
  await checkDeployment(fork.client, d);
  // The record's other fields are the live ones.
  const { vaultImplementation: _i, vaultModule: _m, vaultModuleV4: _m4, ...rest } = d;
  const { vaultImplementation: _li, vaultModule: _lm, ...liveRest } = live;
  assert.deepEqual(rest, liveRest);

  // Finalize again only checks; prepare refuses a version 4 record.
  const checked = run("finalize");
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /VAULT_V4_RECORDED/);
  const refused = run("prepare");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has a vault module V4 already/);
});
