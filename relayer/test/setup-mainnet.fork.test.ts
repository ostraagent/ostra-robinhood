// scripts/setup-mainnet.ts on a mainnet fork: the services' keys, the operator
// and relayer vaults (with the keeper crank), their ETH and their environment
// files; then every service started from its environment file as systemd
// starts it, and a second run that sends nothing.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAddress, type Address, type PrivateKeyAccount } from "viem";
import { readVault, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { ETH_TARGETS, setupMainnet } from "../scripts/setup-mainnet.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const SERVICES = {
  keeper: { script: here("../../keeper/src/main.ts"), env: "keeper.env" },
  relayer: { script: here("../src/server.ts"), env: "relayer.env" },
  aggregator: { script: here("../../aggregator/src/main.ts"), env: "aggregator.env" },
  rpcProxy: { script: here("../../rpc-proxy/src/main.ts"), env: "rpc-proxy.env" },
} as const;

let fork: Fork;
let d: Deployment;
let dir: string;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  dir = mkdtempSync(join(tmpdir(), "ostra-setup-"));
});

after(async () => {
  for (const c of children) c.kill();
  await fork.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** The variables of an environment file (KEY=value lines, as systemd's EnvironmentFile reads them). */
function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    const at = line.indexOf("=");
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

async function waitFor(url: string, init: RequestInit = {}): Promise<Response> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer within 60 s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("sets up the keys, vaults, ETH and environment files; the services start from them; a second run sends nothing", async () => {
  const deployer = fork.accounts[0] as PrivateKeyAccount;
  const base = join(dir, "robinhood");
  const deploymentPath = join(dir, "deployment.json");
  writeFileSync(deploymentPath, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o644 });
  const events: string[] = [];
  const log = (event: string, fields: Record<string, unknown> = {}) => events.push(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const first = await setupMainnet({ base, deploymentPath, deployer, rpcUrl: fork.url, log, listen });
  // Two vaults created, the crank installed, three accounts funded.
  assert.equal(first.sent, 6, events.join("\n"));
  const operator = await readVault(fork.client, d, first.operatorVault);
  const relayerVault = await readVault(fork.client, d, first.relayerVault);
  assert.ok(operator !== null && relayerVault !== null);
  assert.equal(relayerVault.crank, first.crank);
  assert.equal(await fork.client.getBalance({ address: first.keeperFeePayer }), ETH_TARGETS.keeperFeePayer);
  assert.equal(await fork.client.getBalance({ address: first.relayerAccount }), ETH_TARGETS.relayer);
  assert.equal(await fork.client.getBalance({ address: first.aggregator }), ETH_TARGETS.aggregator);
  for (const sub of ["", "keeper", "keeper/secrets", "relayer/secrets", "aggregator/secrets", "operator-vault", "relayer-vault"]) {
    assert.equal(statSync(join(base, sub)).mode & 0o777, 0o700, sub);
  }
  for (const f of ["keeper.env", "relayer.env", "aggregator.env", "rpc-proxy.env", "operator-vault/master.key", "relayer-vault/keychain.id"]) {
    assert.equal(statSync(join(base, f)).mode & 0o777, 0o600, f);
  }
  assert.ok(!events.join("\n").includes(fork.url), "the RPC URL is in no log line");
  assert.equal(readEnv(join(base, "keeper.env")).OSTRA_KEEPER_FEE_RECIPIENT, first.operatorVault);
  assert.equal(readEnv(join(base, "relayer.env")).OSTRA_RELAYER_VAULT, first.relayerVault);
  assert.equal(readEnv(join(base, "relayer.env")).OSTRA_KEEPER_URL, `http://${listen.keeper}`);

  // Each service starts from its environment file alone.
  const start = (name: keyof typeof SERVICES) => {
    const s = SERVICES[name];
    const child = spawn(process.execPath, [s.script], { env: { PATH: process.env.PATH ?? "", ...readEnv(join(base, s.env)) }, stdio: ["ignore", "ignore", "inherit"] });
    children.push(child);
  };
  start("keeper");
  const keeperHealth = (await (await waitFor(`http://${listen.keeper}/v1/health`)).json()) as { feePayer: string };
  assert.equal(getAddress(keeperHealth.feePayer), first.keeperFeePayer);
  start("relayer");
  const ip = { "cf-connecting-ip": "203.0.113.7" };
  const facts = (await (await waitFor(`http://${listen.relayer}/v1/relayer`, { headers: ip })).json()) as { vault: Address; crank: Address; feePayer: Address; merchant: Address };
  assert.deepEqual(
    { vault: facts.vault, crank: facts.crank, feePayer: facts.feePayer, merchant: facts.merchant },
    { vault: first.relayerVault, crank: first.crank, feePayer: first.relayerAccount, merchant: first.merchant },
  );
  start("aggregator");
  assert.equal((await waitFor(`http://${listen.aggregator}/v1/health`)).status, 200);
  start("rpcProxy");
  const chain = await waitFor(`http://${listen.rpcProxy}/`, { method: "POST", headers: { "content-type": "application/json", ...ip }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  assert.equal(((await chain.json()) as { result: string }).result, "0x1237");

  const second = await setupMainnet({ base, deploymentPath, deployer, rpcUrl: fork.url, log, listen });
  assert.equal(second.sent, 0);
  assert.deepEqual({ ...second, sent: 6 }, first);
});
