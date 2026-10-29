// pad_publish's check before the listing approval (LaunchpadService.publishShortfall, RelayerClient.shortfall), through
// the keeper and relayer processes set up as on mainnet (relayer/scripts/setup-mainnet.ts, started from their environment files) on a
// fork of Robinhood Chain mainnet with Ostra's live deployment, and the MCP server's own Agent (Agent.open from
// loadConfig, as the server builds it): the creator vault pays its relayed spends itself, so the listing approval
// from the USDG vault is refused before it is signed when the creator vault could not then publish the file. Before the
// creator vault exists; empty and with half of what it names: refused; with what it names, the profile spend is paid;
// registered (two spends), the vault emptied, and with what it then names the profile and agent URI spends land.
// Needs anvil on PATH.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { parseUnits, type PrivateKeyAccount } from "viem";
import { checkDeployment, parseDeployment, usdgAbi, USDG } from "@ostraagent/sdk";
import { startFork, vaultBeaconAtRecord, type Fork } from "@ostraagent/sdk/test/fork";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const RELAYER = here("../../relayer/src/server.ts");
const KEEPER = here("../../keeper/src/main.ts");

let fork: Fork;
let dir: string;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-publish-shortfall-"));
});

after(async () => {
  for (const c of children) c.kill();
  await fork?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
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

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer within 60 s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("the listing approval waits for a creator vault that can pay its relayed publish: refused before it exists, empty and one unit short; passes with what it needs", { timeout: 1_800_000 }, async () => {
  const live = parseDeployment(JSON.parse(readFileSync(LIVE_DEPLOYMENT, "utf8")));
  await vaultBeaconAtRecord(fork, live);
  await checkDeployment(fork.client, live);
  const base = join(dir, "robinhood");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const setup = await setupMainnet({ base, deploymentPath: LIVE_DEPLOYMENT, deployer: fork.accounts[0] as PrivateKeyAccount, rpcUrl: fork.url, log: () => {}, listen });
  await fork.setBalance(setup.relayerAccount, 10n ** 18n);
  const logs = { keeper: join(dir, "keeper.log"), relayer: join(dir, "relayer.log") };
  const tails = () => Object.entries(logs).map(([n, f]) => `--- ${n}\n${readFileSync(f, "utf8").slice(-3_000)}`).join("\n");
  const start = (script: string, envFile: string, logFile: string, extra: Record<string, string> = {}) => {
    const out = openSync(logFile, "a");
    children.push(spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...readEnv(join(base, envFile)), ...extra }, stdio: ["ignore", out, out] }));
  };
  // The relayer reads the keeper when it starts, as on the VPS.
  start(KEEPER, "keeper.env", logs.keeper);
  await waitFor(`http://${listen.keeper}/v1/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  start(RELAYER, "relayer.env", logs.relayer, { OSTRA_RELAYER_CLIENT_IP: "socket" });
  await waitFor(`http://${listen.relayer}/v1/relayer`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));

  const home = join(dir, "agent");
  await mkdir(home, { mode: 0o700 });
  const config = await loadConfig({
    OSTRA_HOME: home,
    OSTRA_DEPLOYMENT: LIVE_DEPLOYMENT,
    OSTRA_RPC_URL: fork.url,
    OSTRA_LOGS_RPC_URL: fork.url,
    OSTRA_RELAYER_URL: `http://${listen.relayer}`,
    OSTRA_KEEPER_URL: "off",
    OSTRA_AGGREGATOR_URL: "off",
    OSTRA_ETH_RPC_URL: "off",
    OSTRA_RAETO_URL: "off",
    OSTRA_PAD_INDEXER_URL: "off",
  });
  const agent = await Agent.open(config, () => {});
  const lp = agent.launchpad;
  assert.ok(lp !== null, "the live deployment has the launchpad (the creator vault's identity tools)");
  assert.ok(agent.creatorRelayer !== null, "the creator vault pays through the relayer");

  // No creator vault yet.
  const creator = await agent.creator.vaultAddress();
  assert.match((await lp.publishShortfall()) ?? "", new RegExp(`the creator vault ${creator} does not exist yet`));
  const balance = async () => (await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [creator] })) as bigint;
  const URI_A = `ipfs://bafkrei${"b".repeat(52)}`;
  const URI_B = `ipfs://bafkrei${"c".repeat(52)}`;

  // Created through the relayer (its creation paid later, from the vault). Empty, before registration (one spend:
  // the profile): refused with what it needs, and with half of it; with what it said, the profile spend is paid. Each
  // simulation signs with a throwaway key, whose verification costs more or less gas, so the amount is not exact
  // from one call to the next: what is checked is that the amount it names is enough.
  await agent.creator.open();
  const one = (await lp.publishShortfall()) ?? "";
  console.log(`empty, one spend: ${one}`);
  const need1 = /its relayed transaction needs it to hold ([0-9.]+) USDG now/.exec(one);
  assert.ok(need1 !== null, one);
  assert.match(one, /holds 0 USDG: .*; fund_creator_vault moves USDG into it$/);
  const units1 = parseUnits(need1[1] as string, 6);
  await fork.dealUsdg(creator, units1 / 2n);
  assert.match((await lp.publishShortfall()) ?? "", /needs it to hold/);
  await fork.dealUsdg(creator, units1);
  const profile = await lp.setProfile(URI_A);
  assert.equal(profile.status, "sent", JSON.stringify(profile));

  // Registered (two spends now: the profile and the agent URI), then the vault's USDG taken away (its relayer
  // channels keep what they have left): with what it then names (or nothing, if the channels can pay), both spends land.
  await fork.dealUsdg(creator, 50_000_000n);
  const reg = await lp.registerAgent(URI_A);
  assert.equal(reg.status, "sent", JSON.stringify(reg));
  await fork.dealUsdg(creator, 0n);
  const two = await lp.publishShortfall();
  console.log(`registered, empty vault, its channels as left: ${two ?? "can pay"}`);
  if (two !== null) {
    const need2 = /its 2 relayed transactions need it to hold ([0-9.]+) USDG now/.exec(two);
    assert.ok(need2 !== null, two);
    const units2 = parseUnits(need2[1] as string, 6);
    await fork.dealUsdg(creator, units2);
    assert.equal(await balance(), units2);
  }
  const p2 = await lp.setProfile(URI_B);
  assert.equal(p2.status, "sent", JSON.stringify(p2));
  const u2 = await lp.setAgentUri(URI_B);
  assert.equal(u2.status, "sent", JSON.stringify(u2));
});
