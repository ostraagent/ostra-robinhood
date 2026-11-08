// scripts/setup-order-runner.ts on a fork of Robinhood Chain mainnet, as the version 5 release runs it: the key alone
// first (before the upgrade, with no record), refused with a record that is not at version 5, then the setup with the
// record at version 5 (the vault beacon upgraded on the fork as scheduled, unless mainnet runs it already), run again,
// then the order runner (src/order-runner-main.ts once) started from the environment file it wrote, as its service
// starts it. Every log search stays on the fork's own blocks (OSTRA_ORDER_RUNNER_SEARCH_FROM, or
// OSTRA_ORDER_RUNNER_FROM_BLOCK when mainnet runs version 5 already): anvil forwards a search before the fork block to
// OSTRA_FORK_RPC, which may serve only a few blocks of logs at a time. Needs anvil on PATH.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { getAddress, type Address } from "viem";
import { type Deployment } from "@ostraagent/sdk";
import { liveAtV5, startFork, vaultBeaconAtRecord, type Fork } from "@ostraagent/sdk/test/fork";

const LIVE_DEPLOYMENT = fileURLToPath(new URL("../../deployments/robinhood-mainnet.json", import.meta.url));
const script = fileURLToPath(new URL("../scripts/setup-order-runner.ts", import.meta.url));
const service = fileURLToPath(new URL("../src/order-runner-main.ts", import.meta.url));

let fork: Fork;
let d: Deployment;
let root: string;
/** The block the vault beacon was upgraded at on the fork, or null when mainnet runs version 5 already. */
let upgradedAt: bigint | null;
let forkBlock: bigint;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-order-runner-setup-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber();
  d = await liveAtV5(fork, LIVE_DEPLOYMENT);
  const how = await vaultBeaconAtRecord(fork, d);
  upgradedAt = how === "on mainnet already" ? null : await fork.client.getBlockNumber();
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

type Run = { code: number | null; out: string; events: Record<string, unknown>[] };

function run(file: string, args: string[], env: Record<string, string>, timeoutMs = 300_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env: { PATH: process.env.PATH ?? "", HOME: root, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${file} did not finish within ${timeoutMs} ms:\n${out}`));
    }, timeoutMs);
    const onData = (c: Buffer) => {
      out += c.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const events = out
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      resolve({ code, out, events });
    });
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

test("setup-order-runner makes the fallback's key before the upgrade, its environment after, and the runner starts from them", { timeout: 900_000 }, async () => {
  const services = join(root, "robinhood");
  const rpcFile = join(root, "rpc.url");
  await writeFile(rpcFile, `${fork.url}\n`, { mode: 0o600 });
  const base = { OSTRA_SERVICES_DIR: services, OSTRA_RPC_URL_FILE: rpcFile, OSTRA_LOGS_RPC_URL: fork.url };

  // An RPC file other users can read is refused before anything is made.
  const loose = join(root, "rpc-loose.url");
  await writeFile(loose, `${fork.url}\n`, { mode: 0o644 });
  const refused = await run(script, ["key"], { ...base, OSTRA_RPC_URL_FILE: loose });
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /must have mode 0600/);
  await assert.rejects(stat(join(services, "order-runner")));

  // The key alone, with no record: its address and the ETH it should get.
  const key = await run(script, ["key"], base);
  assert.equal(key.code, 0, key.out);
  assert.match(key.out, /ORDER_RUNNER_KEY_OK\s*$/);
  const k = key.events.find((e) => e.event === "order_runner_key")!;
  const feePayer = getAddress(k.feePayer as string) as Address;
  assert.equal(k.eth, "0");
  assert.ok(Number(k.suggested) > 0, key.out);
  assert.match(key.out, new RegExp(`FUND_ORDER_RUNNER ${feePayer} holds 0 ETH`));
  await assert.rejects(stat(join(services, "order-runner.env")));

  // A record that is not at version 5 is refused, and no environment is written.
  const v4Path = join(root, "deployment-v4.json");
  await writeFile(v4Path, await readFile(LIVE_DEPLOYMENT, "utf8"), { mode: 0o644 });
  if ((JSON.parse(await readFile(v4Path, "utf8")) as { vaultModuleV5?: string }).vaultModuleV5 === undefined) {
    const notV5 = await run(script, [], { ...base, OSTRA_DEPLOYMENT: v4Path });
    assert.equal(notV5.code, 1, notV5.out);
    assert.match(notV5.out, /names no vaultModuleV5/);
    await assert.rejects(stat(join(services, "order-runner.env")));
  }

  // The record at version 5: the environment, from the block of the vault beacon's upgrade.
  const deploymentPath = join(root, "deployment.json");
  await writeFile(deploymentPath, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o644 });
  // Searched from the fork's first block on: the upgrade on the fork is found there. When mainnet runs version 5
  // already, its upgrade lies before the fork: the runner is set to start after the fork instead.
  const env = { ...base, OSTRA_DEPLOYMENT: deploymentPath, ...(upgradedAt !== null ? { OSTRA_ORDER_RUNNER_SEARCH_FROM: (forkBlock + 1n).toString() } : { OSTRA_ORDER_RUNNER_FROM_BLOCK: (forkBlock + 1n).toString() }) };
  const first = await run(script, [], env);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /ORDER_RUNNER_SETUP_OK\s*$/);
  const setup = first.events.find((e) => e.event === "order_runner")!;
  assert.equal(getAddress(setup.feePayer as string), feePayer, "the key made before is the one kept");
  assert.equal(setup.envWritten, true);
  const fromBlock = BigInt(setup.fromBlock as string);
  if (upgradedAt !== null) assert.equal(fromBlock, upgradedAt, "the block of the upgrade on the fork");
  else assert.equal(fromBlock, forkBlock + 1n, "the block it was set to");
  for (const dir of [services, join(services, "order-runner"), join(services, "order-runner", "secrets"), join(services, "order-runner", "data")]) assert.equal((await stat(dir)).mode & 0o777, 0o700, dir);
  assert.equal((await stat(join(services, "order-runner", "secrets", "fee-payer.key"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(services, "order-runner.env"))).mode & 0o777, 0o600);
  const vars = readEnv(await readFile(join(services, "order-runner.env"), "utf8"));
  assert.deepEqual(vars, {
    OSTRA_RPC_URL: fork.url,
    OSTRA_DEPLOYMENT: deploymentPath,
    OSTRA_ORDER_RUNNER_FROM_BLOCK: fromBlock.toString(),
    OSTRA_ORDER_RUNNER_SECRETS: join(services, "order-runner", "secrets"),
    OSTRA_ORDER_RUNNER_DATA: join(services, "order-runner", "data"),
  });
  assert.ok(!first.out.includes(fork.url), "the RPC URL is never printed");

  // Run again: the same key, nothing rewritten.
  const second = await run(script, [], env);
  assert.equal(second.code, 0, second.out);
  const again = second.events.find((e) => e.event === "order_runner")!;
  assert.equal(getAddress(again.feePayer as string), feePayer);
  assert.equal(again.envWritten, false);
  assert.equal(again.fromBlock, setup.fromBlock);

  // The runner starts from that environment, as its service runs it (its events read through the fork here).
  const once = await run(service, ["once"], { ...vars, OSTRA_LOGS_RPC_URL: fork.url });
  assert.equal(once.code, 0, once.out);
  const started = once.events.find((e) => e.event === "started");
  assert.ok(started !== undefined, once.out);
  assert.equal(getAddress(started.feePayer as string), feePayer);
  assert.match(once.out, /ORDER_RUNNER_ONCE 0 0\s*$/);
  assert.ok(!once.out.includes(fork.url), "the RPC URL is never printed");
});
