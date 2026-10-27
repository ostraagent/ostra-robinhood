// scripts/setup-breaker.ts on a fork of Robinhood Chain mainnet, as the release that deploys OstraBreaker runs it: Ostra
// and OstraBreaker deployed on the fork, the script run as its own process from 0600 key and RPC files, then run again,
// then the breaker keeper (src/breaker-main.ts) started from the environment file it wrote, as its service starts it.
// The fork only stands in for funding: the funder gets ETH (anvil_setBalance).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { getAddress, type Address } from "viem";
import { deployBreaker, type Deployment } from "@ostraagent/sdk";
import { OUT_DIR, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { LOW_ETH_WEI } from "../src/breaker.ts";
import { FEE_PAYER_TARGET_WEI } from "../scripts/setup-breaker.ts";

/** anvil's development account 2 (a public test key, used only on the fork). */
const FUNDER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const script = fileURLToPath(new URL("../scripts/setup-breaker.ts", import.meta.url));
const service = fileURLToPath(new URL("../src/breaker-main.ts", import.meta.url));

let fork: Fork;
let d: Deployment;
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-breaker-setup-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  d = await deployBreaker({ publicClient: fork.client, walletClient: fork.wallet(fork.accounts[0]!), outDir: OUT_DIR }, d);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

type Run = { code: number | null; out: string; events: Record<string, unknown>[] };

function run(file: string, env: Record<string, string>, until?: (out: string) => boolean, timeoutMs = 300_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env: { PATH: process.env.PATH ?? "", HOME: root, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const done = (code: number | null) => {
      clearTimeout(timer);
      const events = out
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      resolve({ code, out, events });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${file} did not finish within ${timeoutMs} ms:\n${out}`));
    }, timeoutMs);
    const onData = (c: Buffer) => {
      out += c.toString("utf8");
      if (until !== undefined && until(out)) child.kill("SIGTERM");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", done);
  });
}

function readEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m !== null) out[m[1]!] = m[2]!;
  }
  return out;
}

test("setup-breaker makes the breaker keeper's key, environment and ETH once, and the keeper starts from them", { timeout: 900_000 }, async () => {
  const services = join(root, "robinhood");
  const deploymentPath = join(root, "deployment.json");
  await writeFile(deploymentPath, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o644 });
  const rpcFile = join(root, "rpc.url");
  await writeFile(rpcFile, `${fork.url}\n`, { mode: 0o600 });
  const keyFile = join(root, "deployer.key");
  await writeFile(keyFile, `${FUNDER_KEY}\n`, { mode: 0o600 });
  const funder = fork.accounts[2]!;
  assert.equal(funder.address, getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"));
  await fork.setBalance(funder.address, 10n ** 18n);
  const env = { OSTRA_SERVICES_DIR: services, OSTRA_DEPLOYMENT: deploymentPath, OSTRA_RPC_URL_FILE: rpcFile, OSTRA_DEPLOYER_KEY_FILE: keyFile };

  // A key file other users can read is refused before anything is made or sent.
  const loose = join(root, "deployer-loose.key");
  await writeFile(loose, `${FUNDER_KEY}\n`, { mode: 0o644 });
  const refused = await run(script, { ...env, OSTRA_DEPLOYER_KEY_FILE: loose });
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /must have mode 0600/);
  await assert.rejects(stat(join(services, "breaker.env")));

  const first = await run(script, env);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /BREAKER_SETUP_OK\s*$/);
  assert.ok(!first.out.includes(FUNDER_KEY.slice(2)), "the funder's key is never printed");
  const setup = first.events.find((e) => e.event === "breaker")!;
  assert.equal(getAddress(setup.breaker as string), d.breaker);
  assert.equal(setup.fromBlock, d.fromBlock);
  assert.equal(setup.envWritten, true);
  const feePayer = getAddress(setup.feePayer as string) as Address;
  assert.ok(first.events.some((e) => e.event === "funded"), first.out);
  assert.equal(await fork.client.getBalance({ address: feePayer }), FEE_PAYER_TARGET_WEI);
  assert.ok(FEE_PAYER_TARGET_WEI > LOW_ETH_WEI);
  // The top-up's nonce record is gone once it landed.
  await assert.rejects(stat(join(services, "breaker", "funding.json")));

  // The files: the directories 0700, the key and the environment 0600, the environment as the service reads it.
  for (const dir of [services, join(services, "breaker"), join(services, "breaker", "secrets"), join(services, "breaker", "data")]) assert.equal((await stat(dir)).mode & 0o777, 0o700, dir);
  assert.equal((await stat(join(services, "breaker", "secrets", "fee-payer.key"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(services, "breaker.env"))).mode & 0o777, 0o600);
  const vars = readEnv(await readFile(join(services, "breaker.env"), "utf8"));
  assert.deepEqual(vars, {
    OSTRA_RPC_URL: fork.url,
    OSTRA_DEPLOYMENT: deploymentPath,
    OSTRA_BREAKER_FROM_BLOCK: d.fromBlock,
    OSTRA_BREAKER_SECRETS: join(services, "breaker", "secrets"),
    OSTRA_BREAKER_DATA: join(services, "breaker", "data"),
  });

  // Run again: the same key, nothing rewritten, nothing sent.
  const second = await run(script, env);
  assert.equal(second.code, 0, second.out);
  const again = second.events.find((e) => e.event === "breaker")!;
  assert.equal(getAddress(again.feePayer as string), feePayer);
  assert.equal(again.envWritten, false);
  assert.ok(!second.events.some((e) => e.event === "funded"), second.out);
  assert.equal(await fork.client.getBalance({ address: feePayer }), FEE_PAYER_TARGET_WEI);

  // The breaker keeper starts from that environment, as its service runs it: its breaker and its fee payer.
  const started = await run(service, vars, (out) => /"event":"started"/.test(out), 300_000);
  const line = started.events.find((e) => e.event === "started");
  assert.ok(line !== undefined, started.out);
  assert.equal(getAddress(line.breaker as string), d.breaker);
  assert.equal(getAddress(line.feePayer as string), feePayer);
  assert.ok(!started.out.includes(fork.url), "the RPC URL is never printed");
});
