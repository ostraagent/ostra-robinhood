// scripts/deploy.ts on a mainnet fork, as it runs on mainnet: a deployer key
// and an RPC URL in 0600 files, the record written, and a second run that only
// checks it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDeployment, checkLaunchpad } from "../src/deploy.ts";
import { parseDeployment } from "../src/deployment.ts";
import { startFork, type Fork } from "./fork.ts";

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
});
