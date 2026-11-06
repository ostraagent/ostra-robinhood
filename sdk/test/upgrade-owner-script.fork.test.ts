// scripts/upgrade-owner.ts on a mainnet fork, against the live deployment
// (deployments/robinhood-mainnet.json): the live beacons are handed to a test
// key on the fork (their owner is impersonated), then the script makes an
// encrypted owner seed, deploys OstraUpgradeOwner and hands both beacons to
// it, schedules an upgrade of the pool that cannot run before the 72-hour
// delay and runs after it, and cancels a second one. An upgrade of the vault
// beacon is scheduled only to the implementation upgrade-vault.ts prepared and
// checked; a call waiting already is not signed twice, and an upgrade to the
// implementation the beacon points at is refused; the vault beacon's upgrade
// runs only once every vault locked on an address with no code has been named
// as checked. The SDK's owner message is checked byte for byte against the
// contract's.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bytesToHex, encodeFunctionData, getAddress, hexToBytes, keccak256, stringToHex, type Address, type Hex } from "viem";
import { ostraPoolAbi, ostraUpgradeOwnerAbi, ostraVaultAbi, ostraVaultFactoryAbi, upgradeableBeaconAbi } from "../src/abi.ts";
import { robinhoodChain } from "../src/chain.ts";
import { OSTRA_VAULT_BEACON, USDG, VAULT_ACTION } from "../src/constants.ts";
import { checkDeployment } from "../src/deploy.ts";
import { parseDeployment } from "../src/deployment.ts";
import { setWithdrawalLockParams, signVaultSpend, UPGRADE_OWNER_ACTION, upgradeOwnerCancelPayload, upgradeOwnerMessage, upgradeOwnerSchedulePayload, vaultAddress } from "../src/messages.ts";
import { FileWotsStore } from "../src/wots-file.ts";
import { WotsKeychain } from "../src/wots.ts";
import { OUT_DIR, handBeaconsTo, startFork, vaultBeaconAtRecord, type Fork } from "./fork.ts";

const script = fileURLToPath(new URL("../scripts/upgrade-owner.ts", import.meta.url));
const vaultScript = fileURLToPath(new URL("../scripts/upgrade-vault.ts", import.meta.url));
const live = parseDeployment(JSON.parse(readFileSync(fileURLToPath(new URL("../../deployments/robinhood-mainnet.json", import.meta.url)), "utf8")));
/** anvil's development account 3 (a public test key, used on the fork only). */
const DEV_KEY_3 = "0x7c852118294e51e653712a81e05800f5f2b2a8ae56a8a0b82e3d9e0a6c0ce58b";
const PASSPHRASE = "a long test passphrase";

let fork: Fork;
let dir: string;

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-upgrade-owner-"));
});

after(async () => {
  await fork.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the beacons go to a WOTS-keyed owner; an upgrade waits 72 hours, then anyone runs it; a scheduled call can be cancelled", async () => {
  const testOwner = fork.accounts[3]?.address;
  if (testOwner === undefined) throw new Error("no fork account 3");
  assert.equal(live.vaultBeacon, OSTRA_VAULT_BEACON, "the live record names the live vault beacon");
  // The vault beacon at the record's implementation (a scheduled upgrade mainnet has not run yet, run on the fork), and
  // the live beacons to the test key on the fork (whoever owns them on mainnet).
  await vaultBeaconAtRecord(fork, live);
  await handBeaconsTo(fork, [live.vaultBeacon, live.poolBeacon], testOwner);
  await fork.setBalance(testOwner, 10n ** 18n);

  const key = join(dir, "deployer.key");
  const rpcFile = join(dir, "rpc.url");
  const record = join(dir, "deployment.json");
  const seedFile = join(dir, "owner-seed.json");
  writeFileSync(record, `${JSON.stringify({ ...live, beaconOwner: testOwner }, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(key, `${DEV_KEY_3}\n`, { mode: 0o600 });
  writeFileSync(rpcFile, `${fork.url}\n`, { mode: 0o600 });
  // The lock scan reads the factory's logs from the fork itself, so it sees vaults made on the fork too.
  const env = { OSTRA_DEPLOYER_KEY_FILE: key, OSTRA_RPC_URL_FILE: rpcFile, OSTRA_DEPLOYMENT: record, OSTRA_OWNER_SEED_FILE: seedFile, OSTRA_OWNER_STATE: join(dir, "owner-state"), OSTRA_LOGS_RPC_URL: fork.url };
  const run = (args: string[], input = `${PASSPHRASE}\n`, extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env, ...extra }, input, encoding: "utf8", timeout: 600_000 });
    assert.ok(!r.stdout.includes(DEV_KEY_3.slice(2)) && !r.stderr.includes(DEV_KEY_3.slice(2)), "the key is never printed");
    assert.ok(!r.stdout.includes(fork.url) && !r.stderr.includes(fork.url), "the RPC URL is never printed");
    return r;
  };

  // init: an encrypted seed, never replaced.
  const short = run(["init"], "short\nshort\n");
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /at least 16 characters/);
  const init = run(["init"], `${PASSPHRASE}\n${PASSPHRASE}\n`);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(statSync(seedFile).mode & 0o777, 0o600);
  const sealed = JSON.parse(readFileSync(seedFile, "utf8")) as { ciphertext: string };
  assert.equal(sealed.ciphertext.length, 64);
  const again = run(["init"], `${PASSPHRASE}\n${PASSPHRASE}\n`);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /never replaced/);

  // deploy: the owner contract, both beacons handed over, the record rewritten; a second run only checks.
  const wrong = run(["deploy"], "not the passphrase at all\n");
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /does not open/);
  const deployed = run(["deploy"]);
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(deployed.stdout, /"event":"deployed"/);
  const d = parseDeployment(JSON.parse(readFileSync(record, "utf8")));
  const owner = d.beaconOwner;
  assert.notEqual(owner, getAddress(testOwner));
  assert.deepEqual({ ...d, beaconOwner: live.beaconOwner }, { ...live }, "only beaconOwner changes in the record");
  for (const beacon of [live.vaultBeacon, live.poolBeacon]) {
    assert.equal(getAddress((await fork.client.readContract({ address: beacon, abi: upgradeableBeaconAbi, functionName: "owner" })) as Address), owner);
  }
  await checkDeployment(fork.client, d);
  const read = (functionName: string, args: readonly unknown[] = []) =>
    fork.client.readContract({ address: owner, abi: ostraUpgradeOwnerAbi, functionName, args } as Parameters<typeof fork.client.readContract>[0]);
  assert.equal(await read("DELAY"), 72n * 3600n);
  assert.equal(await read("nonce"), 0n);
  const resumed = run(["deploy"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.ok(!resumed.stdout.includes('"event":"deployed"'), "a second run deploys nothing");

  // A record naming another vault beacon is refused before anything else: the vault beacon's checks would not apply.
  const otherRecord = join(dir, "other-deployment.json");
  writeFileSync(otherRecord, `${JSON.stringify({ ...d, vaultBeacon: d.poolBeacon }, null, 2)}\n`, { mode: 0o644 });
  const otherRun = run(["status"], "", { OSTRA_DEPLOYMENT: otherRecord });
  assert.notEqual(otherRun.status, 0);
  assert.match(otherRun.stderr, new RegExp(`names the vault beacon ${d.poolBeacon}, not the live one \\(${OSTRA_VAULT_BEACON}\\)`));

  // No vault beacon upgrade before upgrade-vault.ts prepare has recorded one; then prepare (on this record, while it
  // still matches the chain).
  const unprepared = run(["schedule-upgrade", live.vaultBeacon, live.vaultImplementation]);
  assert.notEqual(unprepared.status, 0);
  assert.match(unprepared.stderr, /vault-v5\.json: run upgrade-vault\.ts prepare first/);
  const prepare = spawnSync(process.execPath, [vaultScript, "prepare"], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 600_000 });
  assert.equal(prepare.status, 0, prepare.stderr);
  const prepared = (JSON.parse(readFileSync(`${record}.vault-v5.json`, "utf8")) as { implementation: { address: Address } }).implementation.address;

  // The SDK's owner message is the contract's.
  const someRoot = bytesToHex(new Uint8Array(32).fill(7));
  const data = encodeFunctionData({ abi: upgradeableBeaconAbi, functionName: "upgradeTo", args: [live.poolImplementation] });
  const payload = upgradeOwnerSchedulePayload(live.poolBeacon, data);
  assert.equal(payload, await read("schedulePayload", [live.poolBeacon, data]));
  assert.equal(
    bytesToHex(upgradeOwnerMessage({ chainId: d.chainId, owner, nonce: 0n, action: UPGRADE_OWNER_ACTION.schedule, payload, nextKeyRoot: someRoot })),
    await read("message", [UPGRADE_OWNER_ACTION.schedule, payload, someRoot]),
  );
  assert.equal(
    bytesToHex(upgradeOwnerMessage({ chainId: d.chainId, owner, nonce: 0n, action: UPGRADE_OWNER_ACTION.cancel, payload: upgradeOwnerCancelPayload(5n), nextKeyRoot: someRoot })),
    await read("message", [UPGRADE_OWNER_ACTION.cancel, upgradeOwnerCancelPayload(5n), someRoot]),
  );

  // A new pool implementation (the same code), scheduled: not before 72 hours, then by anyone.
  const artifact = JSON.parse(readFileSync(`${OUT_DIR}/OstraPool.sol/OstraPool.json`, "utf8")) as { bytecode: { object: Hex } };
  const deployer = fork.wallet(fork.accounts[0]!);
  const implHash = await deployer.deployContract({ abi: ostraPoolAbi, bytecode: artifact.bytecode.object, args: [], account: fork.accounts[0]!, chain: robinhoodChain });
  const implementation = getAddress((await fork.client.waitForTransactionReceipt({ hash: implHash })).contractAddress as Address);
  const scheduled = run(["schedule-upgrade", live.poolBeacon, implementation]);
  assert.equal(scheduled.status, 0, scheduled.stderr);
  assert.match(scheduled.stdout, /"event":"scheduled","id":"0"/);
  assert.equal(await read("nonce"), 1n);
  const early = run(["execute", "0"], "");
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /may be executed from/);
  await fork.increaseTime(72 * 3600);
  const executed = run(["execute", "0"], "");
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(getAddress((await fork.client.readContract({ address: live.poolBeacon, abi: upgradeableBeaconAbi, functionName: "implementation" })) as Address), implementation);
  assert.equal(await fork.client.readContract({ address: live.pool, abi: ostraPoolAbi, functionName: "VERSION" }), 2);

  // The vault beacon: only to the implementation upgrade-vault.ts prepared (and checked), whichever command builds
  // the call.
  const upgradeToLive = encodeFunctionData({ abi: upgradeableBeaconAbi, functionName: "upgradeTo", args: [live.vaultImplementation] });
  for (const args of [
    ["schedule-upgrade", live.vaultBeacon, live.vaultImplementation],
    ["schedule", live.vaultBeacon, upgradeToLive],
    // upgradeTo with a byte more: not exactly the call that was checked.
    ["schedule", live.vaultBeacon, `${encodeFunctionData({ abi: upgradeableBeaconAbi, functionName: "upgradeTo", args: [prepared] })}00`],
  ]) {
    const refused = run(args);
    assert.notEqual(refused.status, 0, args.join(" "));
    assert.match(refused.stderr, /is not the vault implementation upgrade-vault\.ts prepared|not exactly upgradeTo/);
  }
  // A change of the vault beacon's owner only with OSTRA_ALLOW_BEACON_OWNERSHIP=1; any other call to it never.
  for (const data of [
    encodeFunctionData({ abi: upgradeableBeaconAbi, functionName: "transferOwnership", args: [testOwner] }),
    encodeFunctionData({ abi: upgradeableBeaconAbi, functionName: "renounceOwnership" }),
  ]) {
    const refused = run(["schedule", live.vaultBeacon, data]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /would change who owns the vault beacon .*OSTRA_ALLOW_BEACON_OWNERSHIP=1/);
  }
  const otherCall = run(["schedule", live.vaultBeacon, encodeFunctionData({ abi: upgradeableBeaconAbi, functionName: "implementation" })]);
  assert.notEqual(otherCall.status, 0);
  assert.match(otherCall.stderr, /is sent only upgradeTo/);
  assert.equal(await read("nonce"), 1n, "nothing refused was signed");

  // A second call, cancelled: it can never run.
  const second = run(["schedule-upgrade", live.vaultBeacon, prepared]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"event":"checked"/);
  const cancelled = run(["cancel", "1"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(await read("nonce"), 3n);
  const status = run(["status"], "");
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /executed, cancelled or never landed/);
  const late = run(["cancel", "1"]);
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /not scheduled/);

  // Calldata that is not whole bytes is refused before anything is signed.
  const odd = run(["schedule", live.vaultBeacon, "0x123456789"]);
  assert.notEqual(odd.status, 0);
  assert.match(odd.stderr, /whole bytes/);
  // One run at a time.
  const lock = join(dir, "owner-state", "lock");
  writeFileSync(lock, "");
  const locked = run(["cancel", "1"]);
  assert.notEqual(locked.status, 0);
  assert.match(locked.stderr, /another run holds/);
  rmSync(lock);

  // A call signed and never sent (the payer had no ETH) goes out again, identical, before anything new is signed.
  await fork.setBalance(testOwner, 0n);
  const broke = run(["schedule-upgrade", live.poolBeacon, implementation]);
  assert.notEqual(broke.status, 0);
  assert.equal(await read("nonce"), 3n);
  await fork.setBalance(testOwner, 10n ** 18n);
  // Run again: the signed call goes out first, identical, and it is the call asked for: nothing new is signed.
  const resent = run(["schedule-upgrade", live.poolBeacon, implementation]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.match(resent.stdout, /"event":"resending","nonce":"3"/);
  assert.match(resent.stdout, /"event":"scheduled_already","id":"3"/);
  assert.match(resent.stdout, /UPGRADE_OWNER_OK/);
  assert.equal(await read("nonce"), 4n);
  const next = run(["schedule-upgrade", live.vaultBeacon, prepared]);
  assert.equal(next.status, 0, next.stderr);
  assert.ok(!next.stdout.includes('"event":"resending"'), "nothing was left to send again");
  assert.equal(await read("nonce"), 5n);
  assert.equal(getAddress(((await read("getCall", [3n])) as { target: Address }).target), live.poolBeacon);
  assert.equal(getAddress(((await read("getCall", [4n])) as { target: Address }).target), live.vaultBeacon);
  // Asked again while it waits: it is scheduled already, nothing new is signed.
  const twice = run(["schedule-upgrade", live.vaultBeacon, prepared]);
  assert.equal(twice.status, 0, twice.stderr);
  assert.match(twice.stdout, /"event":"scheduled_already","id":"4"/);
  assert.match(twice.stdout, /UPGRADE_OWNER_OK/);
  assert.equal(await read("nonce"), 5n);
  // A vault locked under version 4 on an address with no code: its lock would stay under version 5, so the upgrade does
  // not run until that vault is named as checked.
  const wotsDir = join(dir, "wots");
  mkdirSync(wotsDir);
  const chain = new WotsKeychain(hexToBytes(keccak256(stringToHex("OSTRA/EVM/SDK-TEST/codeless-master"))), hexToBytes(keccak256(stringToHex("OSTRA/EVM/SDK-TEST/codeless"))), new FileWotsStore(wotsDir));
  const root = bytesToHex(chain.keyRoot(0n));
  const lockedVault = vaultAddress({ factory: live.vaultFactory, beacon: live.vaultBeacon, token: USDG, initialKeyRoot: root, initialCrank: "0x0000000000000000000000000000000000000000" });
  const sender = fork.accounts[0]!;
  const create = await fork.wallet(sender).writeContract({ address: live.vaultFactory, abi: ostraVaultFactoryAbi, functionName: "createVault", args: [USDG, root, "0x0000000000000000000000000000000000000000"], account: sender, chain: robinhoodChain });
  assert.equal((await fork.client.waitForTransactionReceipt({ hash: create })).status, "success");
  const plainKey = getAddress("0x000000000000000000000000000000000000c01d");
  const lockSpend = await signVaultSpend(chain, { vault: lockedVault, nonce: 0n, keyRoot: root }, { chainId: d.chainId, action: VAULT_ACTION.SET_WITHDRAWAL_LOCK, params: setWithdrawalLockParams({ withdrawal: plainKey, delay: 36 * 3600, dailyLimit: 1_000_000n }) });
  const lockTx = await fork.wallet(sender).writeContract({ address: lockedVault, abi: ostraVaultAbi, functionName: "spend", args: [lockSpend.action, lockSpend.nextKeyRoot, lockSpend.params, lockSpend.signature], account: sender, chain: robinhoodChain });
  assert.equal((await fork.client.waitForTransactionReceipt({ hash: lockTx })).status, "success");
  // Once it has run (72 hours later, by anyone), an upgrade to the implementation the beacon points at is refused.
  await fork.increaseTime(72 * 3600);
  const held = run(["execute", "4"], "");
  assert.notEqual(held.status, 0);
  assert.match(held.stdout, new RegExp(`"event":"codeless_lock","vault":"${lockedVault}","withdrawal":"${plainKey}","waiting":false,"accepted":false`));
  assert.match(held.stderr, new RegExp(`withdrawal lock\\(s\\) on an address with no code \\(${lockedVault}:${plainKey}\\): check each, then name it as vault:withdrawal in OSTRA_ACCEPT_CODELESS_LOCKS`));
  // Another withdrawal address of the same vault is not the lock that was checked.
  const otherLock = run(["execute", "4"], "", { OSTRA_ACCEPT_CODELESS_LOCKS: `${lockedVault}:${getAddress("0x000000000000000000000000000000000000beef")}` });
  assert.notEqual(otherLock.status, 0);
  assert.equal(getAddress((await fork.client.readContract({ address: live.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "implementation" })) as Address), getAddress(live.vaultImplementation));
  const upgraded = run(["execute", "4"], "", { OSTRA_ACCEPT_CODELESS_LOCKS: `${lockedVault}:${plainKey}` });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.equal(getAddress((await fork.client.readContract({ address: live.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "implementation" })) as Address), getAddress(prepared));
  const noop = run(["schedule-upgrade", live.vaultBeacon, prepared]);
  assert.notEqual(noop.status, 0);
  assert.match(noop.stderr, new RegExp(`points at ${getAddress(prepared)} already: nothing to schedule`));
  assert.equal(await read("nonce"), 5n, "nothing refused was signed");

  // With OSTRA_ALLOW_BEACON_OWNERSHIP=1 a change of the vault beacon's owner is scheduled (and waits its 72 hours).
  const allowed = run(["schedule", live.vaultBeacon, encodeFunctionData({ abi: upgradeableBeaconAbi, functionName: "transferOwnership", args: [testOwner] })], `${PASSPHRASE}\n`, { OSTRA_ALLOW_BEACON_OWNERSHIP: "1" });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /"event":"allowed"/);
  assert.equal(await read("nonce"), 6n);
});
