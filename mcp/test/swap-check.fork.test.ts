// scripts/swap-check.ts on a fork of Robinhood Chain mainnet, as the mainnet run will go: Ostra's live deployment
// (deployments/robinhood-mainnet.json) with every vault on OstraVault version 2 (the upgrade OstraUpgradeOwner
// scheduled, run on the fork by the owner, impersonated, when mainnet has not run it yet, and the record as
// sdk/scripts/upgrade-vault.ts finalize then writes it: the keeper and the relayer check the record against the
// vault beacon when they start, so they refuse a version 1 record once the beacon runs version 2), Ostra Swap deployed by
// ostra-swap's deploy code (deploySwap) from its Foundry
// build, the services set up by relayer/scripts/setup-mainnet.ts, the keeper and the relayer started from their
// environment files (the relayer's with OSTRA_SWAP_DEPLOYMENT added, and the socket address as the client's: no
// Cloudflare in front here), and the check's agent funded when it asks (FUND line) with exactly what it asks for. The
// pool index (Uniswap pools per pair) is searched once from Robinhood Chain's public RPC and kept in the agent's home,
// as its first swap would; the server and the check read the fork. Needs ../../ostra-swap built (forge build;
// privacy/wasm/build.sh) and anvil on PATH.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, getAddress, http, numberToHex, parseUnits, type Address, type PrivateKeyAccount, type PublicClient } from "viem";
import { VAULT_VERSION, checkDeployment, ostraVaultAbi, parseDeployment, robinhoodChain, upgradeableBeaconAbi, type Deployment } from "@ostraagent/sdk";
import { startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { PoolIndex, ROBINHOOD_PUBLIC_RPC, USDG, WETH, findRoute } from "@ostraagent/swap";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { deploySwap } from "../../../ostra-swap/sdk/scripts/deploy.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const SWAP_OUT = here("../../../ostra-swap/out");
/**
 * OstraVault version 2, the code OstraUpgradeOwner scheduled for the vault beacon (upgradeTo, transaction
 * 0xd4adb65a26c60f0f7f498237419bdc9bb3026931e0a746a6280bb6d9a260c3b7), runnable from 22 Oct 2026 09:07 UTC.
 */
const VAULT_V2 = getAddress("0xd20c6744cfa46d9ec564b119cc923bab2f9f9331");
const SERVICES = { keeper: { script: here("../../keeper/src/main.ts"), env: "keeper.env" }, relayer: { script: here("../../relayer/src/server.ts"), env: "relayer.env" } } as const;

let fork: Fork;
let dir: string;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-swap-check-"));
});

after(async () => {
  for (const c of children) c.kill();
  await fork?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

async function anvil(method: string, params: unknown[]): Promise<void> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
}

/**
 * Every vault on version 2: the scheduled upgrade, sent on the fork by the beacon's owner when mainnet has not run it.
 * Returns the deployment record to run on: `live`, or what upgrade-vault.ts finalize writes after the upgrade (the
 * version 2 implementation and its OstraRegistry, which the implementation names).
 */
async function vaultsOnV2(live: Deployment, livePath: string, dir: string): Promise<{ how: string; record: string }> {
  const beacon = live.vaultBeacon;
  const read = () => fork.client.readContract({ address: beacon, abi: upgradeableBeaconAbi, functionName: "implementation" }) as Promise<Address>;
  let how = "on mainnet already";
  if (getAddress(await read()) !== VAULT_V2) {
    const owner = getAddress((await fork.client.readContract({ address: beacon, abi: upgradeableBeaconAbi, functionName: "owner" })) as Address);
    await anvil("anvil_impersonateAccount", [owner]);
    await anvil("anvil_setBalance", [owner, numberToHex(10n ** 18n)]);
    const wallet = createWalletClient({ account: owner, chain: robinhoodChain, transport: http(fork.url) });
    const hash = await wallet.writeContract({ address: beacon, abi: upgradeableBeaconAbi, functionName: "upgradeTo", args: [VAULT_V2], account: owner, chain: robinhoodChain });
    assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
    await anvil("anvil_stopImpersonatingAccount", [owner]);
    how = "upgraded on the fork as scheduled";
  }
  assert.equal(getAddress(await read()), VAULT_V2);
  assert.equal(await fork.client.readContract({ address: VAULT_V2, abi: ostraVaultAbi, functionName: "VERSION" }), VAULT_VERSION);
  if (live.registry !== undefined) {
    assert.equal(live.vaultImplementation, VAULT_V2, "the live record names version 2");
    return { how, record: livePath };
  }
  const registry = getAddress((await fork.client.readContract({ address: VAULT_V2, abi: ostraVaultAbi, functionName: "REGISTRY" })) as Address);
  const record = join(dir, "deployment-v2.json");
  const d: Deployment = { ...live, vaultImplementation: VAULT_V2, registry };
  await checkDeployment(fork.client, d);
  writeFileSync(record, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o644 });
  return { how: `${how}; the record as finalize writes it (registry ${registry})`, record };
}

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

async function waitFor(url: string): Promise<Response> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return res;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer within 60 s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The pool index an agent's first swap of USDG and WETH builds, searched from the public RPC and kept where the server keeps it. */
async function keepPoolIndex(home: string): Promise<void> {
  const logsClient = createPublicClient({ transport: http(ROBINHOOD_PUBLIC_RPC, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const index = new PoolIndex();
  const client = createPublicClient({ transport: http(fork.url, { timeout: 180_000 }) }) as PublicClient;
  await findRoute({ client, logsClient, index, tokenIn: USDG, tokenOut: WETH, amountIn: parseUnits("100", 6), feeBps: 20, slippageBps: 100 });
  for (const sub of ["ostra-swap", "ostra-swap-private"]) {
    await mkdir(join(home, sub), { recursive: true, mode: 0o700 });
    await writeFile(join(home, sub, "pool-index.json"), JSON.stringify(index.data()), { mode: 0o600 });
  }
}

test("scripts/swap-check.ts passes through the relayer and keeper processes set up as on mainnet", { timeout: 2_400_000 }, async () => {
  const live = parseDeployment(JSON.parse(readFileSync(LIVE_DEPLOYMENT, "utf8")));
  const v2 = await vaultsOnV2(live, LIVE_DEPLOYMENT, dir);
  console.log(`vault version ${VAULT_VERSION}: ${v2.how}`);
  const deploymentPath = v2.record;
  const deployer = fork.accounts[0] as PrivateKeyAccount;
  const { deployment: swap, gasUsed } = await deploySwap(fork.client, fork.wallet(deployer), SWAP_OUT);
  console.log(`Ostra Swap deployed on the fork: ${gasUsed} gas`);
  const swapPath = join(dir, "swap.json");
  await writeFile(swapPath, `${JSON.stringify(swap, null, 2)}\n`);

  const base = join(dir, "robinhood");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const setup = await setupMainnet({ base, deploymentPath, deployer, rpcUrl: fork.url, log: () => {}, listen });
  // anvil's base fee (about 1 gwei) is some fifty times mainnet's, so the relayer's mainnet target (0.007 ETH) covers no
  // private spend's gas limit here (about 19M gas at the base fee and more): the relayer account gets 1 ETH.
  await fork.setBalance(setup.relayerAccount, 10n ** 18n);
  // As step 5 does on the VPS: the relayer serves Ostra Swap from its record.
  appendFileSync(join(base, "relayer.env"), `OSTRA_SWAP_DEPLOYMENT=${swapPath}\n`);
  // Each service's output goes to its own log, shown when the check fails.
  const start = (name: keyof typeof SERVICES, extra: Record<string, string> = {}) => {
    const s = SERVICES[name];
    const out = openSync(join(dir, `${name}.log`), "a");
    const child = spawn(process.execPath, [s.script], { env: { PATH: process.env.PATH ?? "", ...readEnv(join(base, s.env)), ...extra }, stdio: ["ignore", out, out] });
    children.push(child);
  };
  const tail = (n: string) => {
    try {
      return readFileSync(join(dir, `${n}.log`), "utf8").slice(-4_000);
    } catch {
      return "(not started)";
    }
  };
  const serviceLogs = () => (["keeper", "relayer"] as const).map((n) => `--- ${n} (end)\n${tail(n)}`).join("\n");
  const up = (url: string) => waitFor(url).catch((err: unknown) => assert.fail(`${String(err)}\n${serviceLogs()}`));
  start("keeper");
  await up(`http://${listen.keeper}/v1/health`);
  start("relayer", { OSTRA_RELAYER_CLIENT_IP: "socket" });
  await up(`http://${listen.relayer}/v1/relayer`);

  const home = join(dir, "agent");
  await mkdir(home, { mode: 0o700 });
  await keepPoolIndex(home);
  const child = spawn(process.execPath, [here("../scripts/swap-check.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      OSTRA_CHECK_HOME: home,
      OSTRA_CHECK_FUND_SECONDS: "600",
      OSTRA_DEPLOYMENT: deploymentPath,
      OSTRA_SWAP_DEPLOYMENT: swapPath,
      OSTRA_RPC_URL: fork.url,
      OSTRA_LOGS_RPC_URL: fork.url,
      OSTRA_RELAYER_URL: `http://${listen.relayer}`,
      OSTRA_KEEPER_URL: `http://${listen.keeper}`,
      OSTRA_AGGREGATOR_URL: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const lines: string[] = [];
  let err = "";
  child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-5_000)));
  const funded: Promise<void>[] = [];
  const dealErrors: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    console.log(line);
    const m = /^FUND (0x[0-9a-fA-F]{40}) ([0-9]+) /.exec(line);
    if (m) funded.push(fork.dealUsdg(getAddress(m[1]!), BigInt(m[2]!)).catch((e: unknown) => void dealErrors.push(String(e))));
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  await Promise.all(funded);
  assert.deepEqual(dealErrors, [], "the funding was dealt");
  const out = `${lines.join("\n")}\n${err}\n${code === 0 ? "" : serviceLogs()}`;
  assert.equal(code, 0, out);
  assert.ok(lines.includes("ALL CHECKS PASSED"), out);
  assert.equal(lines.filter((l) => l.startsWith("FAIL ")).length, 0, out);
  assert.equal(lines.filter((l) => l.startsWith("FUND ")).length, 1, "the agent asked for its funding once");
  assert.equal(lines.filter((l) => l.startsWith("PASS TX ")).length, 7, "seven transactions measured");
  // The agent's vault ran version 2 throughout (the beacon's code for every vault).
  const vault = /^FUND (0x[0-9a-fA-F]{40}) /.exec(lines.find((l) => l.startsWith("FUND ")) ?? "")?.[1];
  assert.ok(vault !== undefined);
  assert.equal(await fork.client.readContract({ address: getAddress(vault), abi: ostraVaultAbi, functionName: "VERSION" }), VAULT_VERSION, "the agent's vault runs version 2");
});
