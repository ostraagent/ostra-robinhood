// scripts/deploy.ts on a mainnet fork, as it runs on mainnet: a deployer key
// and an RPC URL in 0600 files, the record written, and a second run that only
// checks it, also once the beacons are handed to a contract as they are on mainnet.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { checkDeployment, checkLaunchpad } from "../src/deploy.ts";
import { parseDeployment } from "../src/deployment.ts";
import { handBeaconsTo, startFork, type Fork } from "./fork.ts";

const script = fileURLToPath(new URL("../scripts/deploy.ts", import.meta.url));
/** anvil's development account 3 (a public test key, used on the fork only). */
const DEV_KEY_3 = "0x7c852118294e51e653712a81e05800f5f2b2a8ae56a8a0b82e3d9e0a6c0ce58b";

let fork: Fork;
let dir: string;

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-deploy-"));
});

after(async () => {
  await fork.stop();
  rmSync(dir, { recursive: true, force: true });
});

const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 600_000 });

test("deploys and checks everything owned by the deployer, then resumes as a check only", async () => {
  const key = join(dir, "deployer.key");
  const rpc = join(dir, "rpc.url");
  const record = join(dir, "deployment.json");
  writeFileSync(key, `${DEV_KEY_3}\n`, { mode: 0o644 });
  writeFileSync(rpc, `${fork.url}\n`, { mode: 0o600 });
  const env = { OSTRA_DEPLOYER_KEY_FILE: key, OSTRA_RPC_URL_FILE: rpc, OSTRA_DEPLOYMENT: record };

  const loose = run(env);
  assert.notEqual(loose.status, 0);
  assert.match(loose.stderr, /must have mode 0600/);
  chmodSync(key, 0o600);
  const deployer = fork.accounts[3]?.address;
  if (deployer === undefined) throw new Error("no fork account 3");
  await fork.setBalance(deployer, 0n);
  const broke = run(env);
  assert.notEqual(broke.status, 0);
  assert.match(broke.stderr, /the deployer holds 0 ETH; the deployment needs up to/);
  await fork.setBalance(deployer, 10n ** 18n);

  const first = run(env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /DEPLOYMENT_OK/);
  assert.ok(!first.stdout.includes(DEV_KEY_3.slice(2)) && !first.stderr.includes(DEV_KEY_3.slice(2)), "the key is never printed");
  assert.ok(!first.stdout.includes(fork.url), "the RPC URL is never printed");
  const d = parseDeployment(JSON.parse(readFileSync(record, "utf8")));
  assert.equal(d.beaconOwner, deployer);
  assert.equal(d.launchpad?.owner, deployer);
  await checkDeployment(fork.client, d, { treasury: deployer, poolAuthority: deployer });
  await checkLaunchpad(fork.client, d);

  const nonce = await fork.client.getTransactionCount({ address: deployer });
  const second = run(env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"event":"found".*"launchpad":true/);
  assert.equal(await fork.client.getTransactionCount({ address: deployer }), nonce, "a complete record sends nothing");
  assert.deepEqual(parseDeployment(JSON.parse(readFileSync(record, "utf8"))), d);

  // Beacons that belong to another account: the record is not this deployer's, whether the account has no code
  // or, like anvil's account 0 on Robinhood Chain, an EIP-7702 delegation.
  const beacons = [d.vaultBeacon, d.poolBeacon] as const;
  const delegated = fork.accounts[0]?.address;
  if (delegated === undefined) throw new Error("no fork account 0");
  assert.match((await fork.client.getCode({ address: delegated })) ?? "", /^0xef0100/, "account 0 carries an EIP-7702 delegation");
  for (const stranger of [privateKeyToAccount(generatePrivateKey()).address, delegated]) {
    await handBeaconsTo(fork, beacons, stranger);
    writeFileSync(record, `${JSON.stringify({ ...d, beaconOwner: stranger }, null, 2)}\n`);
    const foreign = run(env);
    assert.notEqual(foreign.status, 0, `a record whose beacons belong to ${stranger} passed`);
    assert.match(foreign.stderr, /was deployed by 0x[0-9a-fA-F]{40}, not by this deployer/);
  }

  // Beacons handed to a contract, as to OstraUpgradeOwner on mainnet, with the record rewritten: still only a check.
  await handBeaconsTo(fork, beacons, d.vaultFactory);
  writeFileSync(record, `${JSON.stringify({ ...d, beaconOwner: d.vaultFactory }, null, 2)}\n`);
  // Handing the beacons away first sent the deployer's own transferOwnership calls; the run itself must send nothing.
  const handedNonce = await fork.client.getTransactionCount({ address: deployer });
  const handed = run(env);
  assert.equal(handed.status, 0, handed.stderr);
  assert.match(handed.stdout, /"event":"found".*"launchpad":true/);
  assert.equal(await fork.client.getTransactionCount({ address: deployer }), handedNonce, "a handed-over record sends nothing");
});
