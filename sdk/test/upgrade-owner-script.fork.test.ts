// scripts/upgrade-owner.ts on a mainnet fork, against the live deployment
// (deployments/robinhood-mainnet.json): the live beacons are handed to a test
// key on the fork (their owner is impersonated), then the script makes an
// encrypted owner seed, deploys OstraUpgradeOwner and hands both beacons to
// it, schedules an upgrade of the pool that cannot run before the 72-hour
// delay and runs after it, and cancels a second one. The SDK's owner message
// is checked byte for byte against the contract's.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bytesToHex, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { ostraPoolAbi, ostraUpgradeOwnerAbi, upgradeableBeaconAbi } from "../src/abi.ts";
import { robinhoodChain } from "../src/chain.ts";
import { checkDeployment } from "../src/deploy.ts";
import { parseDeployment } from "../src/deployment.ts";
import { UPGRADE_OWNER_ACTION, upgradeOwnerCancelPayload, upgradeOwnerMessage, upgradeOwnerSchedulePayload } from "../src/messages.ts";
import { OUT_DIR, handBeaconsTo, startFork, type Fork } from "./fork.ts";

const script = fileURLToPath(new URL("../scripts/upgrade-owner.ts", import.meta.url));
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
  // The live beacons go to the test key on the fork (whoever owns them on mainnet).
  await handBeaconsTo(fork, [live.vaultBeacon, live.poolBeacon], testOwner);
  await fork.setBalance(testOwner, 10n ** 18n);

  const key = join(dir, "deployer.key");
  const rpcFile = join(dir, "rpc.url");
  const record = join(dir, "deployment.json");
  const seedFile = join(dir, "owner-seed.json");
  writeFileSync(record, `${JSON.stringify({ ...live, beaconOwner: testOwner }, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(key, `${DEV_KEY_3}\n`, { mode: 0o600 });
  writeFileSync(rpcFile, `${fork.url}\n`, { mode: 0o600 });
  const env = { OSTRA_DEPLOYER_KEY_FILE: key, OSTRA_RPC_URL_FILE: rpcFile, OSTRA_DEPLOYMENT: record, OSTRA_OWNER_SEED_FILE: seedFile, OSTRA_OWNER_STATE: join(dir, "owner-state") };
  const run = (args: string[], input = `${PASSPHRASE}\n`) => {
    const r = spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, input, encoding: "utf8", timeout: 600_000 });
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

  // A second call, cancelled: it can never run.
  const second = run(["schedule-upgrade", live.vaultBeacon, live.vaultImplementation]);
  assert.equal(second.status, 0, second.stderr);
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
  const next = run(["schedule-upgrade", live.vaultBeacon, live.vaultImplementation]);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /"event":"resending","nonce":"3"/);
  assert.equal(await read("nonce"), 5n);
  assert.equal(getAddress(((await read("getCall", [3n])) as { target: Address }).target), live.poolBeacon);
  assert.equal(getAddress(((await read("getCall", [4n])) as { target: Address }).target), live.vaultBeacon);
});
