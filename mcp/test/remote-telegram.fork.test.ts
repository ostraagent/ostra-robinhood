// Ostra Bot's connection (remote-telegram.ts in the remote gateway) end to end on a fork of Robinhood Chain mainnet with
// Ostra's live deployment at version 5 and the relayer set up as on mainnet, every child in its bubblewrap sandbox,
// long polling off (no Telegram here: the Mini App's initData is signed as Telegram signs it, with the bot token the
// gateway is given; telegram.test.ts checks that signature against Telegram's documented example). The Mini App's
// part: who the user is, a one-time link. The web app's /connect part is played by the owner's Agent (core, as the
// web app wires it): the link's agent key, installed with the owner's seed, then complete. Then the user is bound,
// sets a budget, and the quota (1 here) refuses a second Telegram user until the owner revokes the key on chain, which
// ends the binding. Refused: another origin, initData not signed for this bot, a wrong link secret, complete before
// the install, a budget out of range.
// Needs anvil and bwrap on PATH.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { getAddress, parseUnits, type Hex, type PrivateKeyAccount } from "viem";
import { checkDeployment, readV5 } from "@ostraagent/sdk";
import { liveAtV5, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const RELAYER = here("../../relayer/src/server.ts");
const KEEPER = here("../../keeper/src/main.ts");
const GATEWAY = here("../src/remote.ts");
const APP = "https://app.example.test";
/** A bot token of the shape BotFather gives (this test's own: no bot of Telegram's has it). */
const BOT_TOKEN = `7000000001:${"A".repeat(17)}${"b".repeat(18)}`;

let fork: Fork;
let dir: string;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-remote-telegram-"));
});

after(async () => {
  for (const c of children) c.kill();
  await fork?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

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

/** A Mini App's initData for user `id`, signed as Telegram signs it (core.telegram.org/bots/webapps) with `token`. */
function initData(id: number, firstName: string, token = BOT_TOKEN, authDate = Math.floor(Date.now() / 1000)): string {
  const fields: [string, string][] = [
    ["query_id", `AAH${id}`],
    ["user", JSON.stringify({ id, first_name: firstName, username: `${firstName.toLowerCase()}_tg`, language_code: "en" })],
    ["auth_date", String(authDate)],
  ];
  const check = [...fields].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  return new URLSearchParams([...fields, ["hash", createHmac("sha256", secret).update(check).digest("hex")]]).toString();
}

test("Ostra Bot: a Telegram user connects a vault through a one-time link proved by the owner's key; quota; revoke", { timeout: 1_800_000 }, async () => {
  const d = await liveAtV5(fork, LIVE_DEPLOYMENT);
  const record = join(dir, "robinhood-v5.json");
  writeFileSync(record, `${JSON.stringify(d, null, 2)}\n`);
  await checkDeployment(fork.client, d);
  const base = join(dir, "robinhood");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const gw = `127.0.0.1:${port + 4}`;
  const url = `http://${gw}`;
  const setup = await setupMainnet({ base, deploymentPath: record, deployer: fork.accounts[0] as PrivateKeyAccount, rpcUrl: fork.url, log: () => {}, listen });
  await fork.setBalance(setup.relayerAccount, 10n ** 18n);
  const logs = { keeper: join(dir, "keeper.log"), relayer: join(dir, "relayer.log"), gateway: join(dir, "gateway.log") };
  const root = join(dir, "remote");
  const childLogs = () => {
    try {
      return readdirSync(root)
        .filter((n) => /^t[0-9a-f]{40}$/.test(n))
        .map((n) => `--- child ${n}\n${readFileSync(join(root, n, "mcp.log"), "utf8").slice(-3_000)}`)
        .join("\n");
    } catch {
      return "";
    }
  };
  const tails = () => `${Object.entries(logs).map(([n, f]) => `--- ${n}\n${readFileSync(f, "utf8").slice(-4_000)}`).join("\n")}\n${childLogs()}`;
  const start = (script: string, env: Record<string, string>, logFile: string) => {
    const out = openSync(logFile, "a");
    children.push(spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", out, out] }));
  };
  start(KEEPER, readEnv(join(base, "keeper.env")), logs.keeper);
  await waitFor(`http://${listen.keeper}/v1/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  start(RELAYER, { ...readEnv(join(base, "relayer.env")), OSTRA_RELAYER_CLIENT_IP: "socket" }, logs.relayer);
  await waitFor(`http://${listen.relayer}/v1/relayer`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  const services = { OSTRA_DEPLOYMENT: record, OSTRA_RPC_URL: fork.url, OSTRA_LOGS_RPC_URL: fork.url, OSTRA_RELAYER_URL: `http://${listen.relayer}`, OSTRA_KEEPER_URL: "off", OSTRA_AGGREGATOR_URL: "off", OSTRA_ETH_RPC_URL: "off", OSTRA_RAETO_URL: "off", OSTRA_PAD_INDEXER_URL: "off" };

  // The owner: the web app's part, with the same core services.
  const ownerHome = join(dir, "owner");
  await mkdir(ownerHome, { recursive: true, mode: 0o700 });
  const owner = await Agent.open(await loadConfig({ OSTRA_HOME: ownerHome, ...services }), () => {});
  const vault = getAddress((await owner.buyer.open()).vault);
  await fork.dealUsdg(vault, parseUnits("40", 6));

  await mkdir(root, { recursive: true, mode: 0o700 });
  const tokenFile = join(dir, "telegram.token");
  writeFileSync(tokenFile, `${BOT_TOKEN}\n`, { mode: 0o600 });
  start(
    GATEWAY,
    {
      ...services,
      OSTRA_REMOTE_APP_URL: APP,
      OSTRA_REMOTE_ROOT: root,
      OSTRA_REMOTE_LISTEN: gw,
      OSTRA_REMOTE_SANDBOX: "bwrap",
      OSTRA_REMOTE_TELEGRAM_TOKEN_FILE: tokenFile,
      OSTRA_REMOTE_TELEGRAM_QUOTA: "1",
      OSTRA_REMOTE_TELEGRAM_BUDGET: "0.05",
      OSTRA_REMOTE_TELEGRAM_POLL: "off",
      OSTRA_PROVER: "off",
    },
    logs.gateway,
  );
  await waitFor(`${url}/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  assert.match(readFileSync(logs.gateway, "utf8"), /"telegram":true/);

  const call = (path: string, body?: unknown, origin = APP) =>
    fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ok = async <T>(r: Promise<Response>): Promise<T> => {
    const res = await r;
    const out = (await res.json()) as T;
    assert.equal(res.status, 200, `${JSON.stringify(out)}\n${tails()}`);
    return out;
  };
  const err = async (r: Promise<Response>, status: number, code: string) => {
    const res = await r;
    const out = (await res.json()) as { error: string };
    assert.deepEqual([res.status, out.error], [status, code], JSON.stringify(out));
  };
  const alice = initData(279_058_397, "Alice");
  const bob = initData(279_058_398, "Bob");

  // Only the web app's origin; only initData signed for this bot, and not too old.
  await err(call("/tg/me", { initData: alice }, "https://evil.example"), 403, "origin_not_allowed");
  await err(call("/tg/me", { initData: initData(279_058_397, "Alice", `7000000002:${"A".repeat(35)}`) }), 401, "bad_init_data");
  await err(call("/tg/me", { initData: initData(279_058_397, "Alice", BOT_TOKEN, Math.floor(Date.now() / 1000) - 5 * 3_600) }), 401, "bad_init_data");
  const pre = (await call("/tg/me", { initData: alice }, APP)).headers.get("access-control-allow-origin");
  assert.equal(pre, APP);
  type Me = { user: { id: string; name: string; username: string | null }; bound: { vault: string; budget: string; keyExpiresAt: string } | null; quota: { taken: number; max: number }; defaultBudget: string };
  const me0 = await ok<Me>(call("/tg/me", { initData: alice }));
  assert.deepEqual([me0.user, me0.bound, me0.quota, me0.defaultBudget], [{ id: "279058397", name: "Alice", username: "alice_tg" }, null, { taken: 0, max: 1 }, "0.05"]);

  // A one-time link to the web app's /connect page; one per 10 s.
  const l1 = await ok<{ link: string; expiresAt: string }>(call("/tg/link", { initData: alice }));
  const to = new URL(l1.link);
  assert.equal(`${to.origin}${to.pathname}`, `${APP}/connect`);
  const link = to.searchParams.get("tg") as string;
  assert.match(link, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32}$/);
  await err(call("/tg/link", { initData: alice }), 429, "slow_down");
  await err(call(`/tg/connect/request?link=${link.slice(0, 17)}${"x".repeat(32)}`), 404, "unknown_link");
  // Who the link is for: the account's id and username (nobody else has them) apart from the name it chose.
  const alice_ = { id: "279058397", username: "alice_tg", name: "Alice" };
  const info = await ok<{ telegram: typeof alice_; status: string }>(call(`/tg/connect/request?link=${encodeURIComponent(link)}`));
  assert.deepEqual([info.telegram, info.status], [alice_, "open"]);

  // The page: the link's agent key (the same one asked again), installed by the owner, then complete.
  const key = await ok<{ root: Hex; vault: string }>(call("/tg/connect/agent-key", { link, vault }));
  assert.match(key.root, /^0x[0-9a-f]{64}$/i);
  assert.equal(key.vault, vault);
  assert.equal((await ok<{ root: Hex }>(call("/tg/connect/agent-key", { link, vault }))).root, key.root, "one root per link");
  await err(call("/tg/connect/complete", { link }), 409, "not_installed");
  const homes = readdirSync(root).filter((n) => /^t[0-9a-f]{40}$/.test(n));
  assert.equal(homes.length, 1, "the key came from the Telegram user's own home");
  assert.equal(existsSync(join(root, homes[0] as string, "home", "master.key")), true, "without a signer the home holds its seed");
  assert.equal((await owner.v5.setAgentKey(key.root, 30)).status, "sent");
  const done = await ok<{ done: boolean; vault: string; telegram: typeof alice_ }>(call("/tg/connect/complete", { link }));
  assert.deepEqual([done.done, done.vault, done.telegram], [true, vault, alice_]);
  assert.equal((await ok<{ again: boolean }>(call("/tg/connect/complete", { link }))).again, true);
  assert.equal(((await readV5(fork.client, vault))?.agentKey.root ?? "").toLowerCase(), key.root.toLowerCase());

  // Bound: the vault, the default budget; the budget set within its range only.
  const me1 = await ok<Me>(call("/tg/me", { initData: alice }));
  assert.deepEqual([me1.bound?.vault, me1.bound?.budget, me1.quota], [vault, "0.05", { taken: 1, max: 1 }]);
  assert.equal((await ok<{ budget: string }>(call("/tg/budget", { initData: alice, budget: "0.2" }))).budget, "0.2");
  await err(call("/tg/budget", { initData: alice, budget: "10" }), 400, "invalid_request");
  await err(call("/tg/budget", { initData: alice, budget: "0.0001" }), 400, "invalid_request");
  await err(call("/tg/budget", { initData: bob, budget: "0.2" }), 409, "not_connected");
  assert.equal((await ok<Me>(call("/tg/me", { initData: alice }))).bound?.budget, "0.2");

  // The quota (1): another Telegram user is told it is full.
  await err(call("/tg/link", { initData: bob }), 403, "quota_full");

  // The owner revokes the agent key on chain: the binding ends, and its place is free again.
  assert.equal((await owner.v5.revokeAgentKey()).status, "sent");
  const me2 = await ok<Me>(call("/tg/me", { initData: alice }));
  assert.deepEqual([me2.bound, me2.quota.taken], [null, 0]);
  assert.match(readFileSync(logs.gateway, "utf8"), /"event":"telegram_unbound"[^\n]*"why":"key_replaced"/);
  await ok(call("/tg/link", { initData: bob }));

  // Nothing in the gateway's logs names the vault, a Telegram user or the bot's token.
  const log = readFileSync(logs.gateway, "utf8");
  assert.equal(log.toLowerCase().includes(vault.slice(2).toLowerCase()), false, "the logs name homes, never vaults");
  assert.equal(log.includes("279058397"), false, "nor Telegram users");
  assert.equal(log.includes(BOT_TOKEN.split(":")[1] as string), false, "nor the token");
});
