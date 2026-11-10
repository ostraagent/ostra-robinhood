// The remote MCP gateway's OAuth (remote-auth.ts) end to end on a fork of Robinhood Chain mainnet with Ostra's live
// deployment at version 5 and the relayer set up as on mainnet, every child in its bubblewrap sandbox. A client
// registers and is sent through /authorize to the web app's /connect page; the page's part is played here by the
// owner's Agent (core, as the web app wires it): with the browser's binding cookie it asks for the request's agent
// key, signs the policy, the relayer's allowlist entry (the split from its own relayer client) and the key with the
// owner's seed, and asks for the code. The code is redeemed with PKCE, the access token opens an agent session over
// Streamable HTTP, an owner's tool comes back as an approval link, the agent key tools are refused and not listed.
// Connecting again while a session is live hands the key out from that session's server (it goes on); kept, the
// earlier grant goes on with the new key; not kept, it ends. A reused refresh token ends its grant only; the owner's
// revoke on chain ends every grant of the vault. Refused: a redirect URI not allowed, a missing PKCE, another origin,
// another browser (no cookie), a code before the owner installed the key, a code used twice.
// Needs anvil and bwrap on PATH.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { getAddress, parseUnits, type Hex, type PrivateKeyAccount } from "viem";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkDeployment, readV5, usdgAbi, USDG } from "@ostraagent/sdk";
import { liveAtV5, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const RELAYER = here("../../relayer/src/server.ts");
const KEEPER = here("../../keeper/src/main.ts");
const GATEWAY = here("../src/remote.ts");
const DEST = getAddress("0x00000000000000000000000000000000000C0D81");
const APP = "https://app.example.test";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

let fork: Fork;
let dir: string;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-remote-oauth-"));
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

const b64url = (b: Buffer) => b.toString("base64url");
function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** The node processes whose OSTRA_HOME is `home` (the servers of that home, inside or outside a sandbox). */
function homeServers(home: string): number[] {
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (env.includes(`OSTRA_HOME=${home}`) && cmd.some((c) => c.endsWith("server.ts")) && !cmd.includes("bwrap") && !cmd.some((c) => c.endsWith("flock"))) out.push(Number(name));
    } catch {
      // gone, or not ours
    }
  }
  return out;
}

test("the remote gateway's OAuth: connect proved by the owner's key, sessions, approvals, refresh, grants bound to the key", { timeout: 1_800_000 }, async () => {
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
        .filter((n) => n.startsWith("v"))
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
  // The relayer's split as the page finds it: from its own relayer client (checked on chain), never from the gateway.
  const split = (await owner.relayer!.facts()).split;

  await mkdir(root, { recursive: true, mode: 0o700 });
  start(
    GATEWAY,
    {
      ...services,
      OSTRA_REMOTE_PUBLIC_URL: url,
      OSTRA_REMOTE_APP_URL: APP,
      OSTRA_REMOTE_ROOT: root,
      OSTRA_REMOTE_LISTEN: gw,
      OSTRA_REMOTE_SANDBOX: "bwrap",
      OSTRA_REMOTE_REFRESH_GRACE_SECONDS: "0",
      OSTRA_REMOTE_KEY_STATE_SECONDS: "1",
      OSTRA_PROVER: "off",
    },
    logs.gateway,
  );
  await waitFor(`${url}/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  assert.match(readFileSync(logs.gateway, "utf8"), /"sandbox":"bwrap"/);

  // Discovery, as a connector finds it from a 401.
  const unauth = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get("www-authenticate"), `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`);
  const prm = (await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
  assert.deepEqual([prm.resource, prm.authorization_servers], [`${url}/mcp`, [url]]);
  const asm = (await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);

  // Registration: only allowed redirect URIs.
  const reg = (uris: string[]) => fetch(`${url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: uris }) });
  assert.equal((await reg(["https://evil.example/cb"])).status, 400);
  assert.match(((await (await reg([CLAUDE])).json()) as { client_id: string }).client_id, /^c_/);
  const cbPort = 40_000 + Math.floor(Math.random() * 10_000);
  const redirect = `http://127.0.0.1:${cbPort}/callback`;
  const client = (await (await reg([redirect])).json()) as { client_id: string };

  const authorize = (q: Record<string, string>) => fetch(`${url}/authorize?${new URLSearchParams(q).toString()}`, { redirect: "manual" });
  const tokenReq = (form: Record<string, string>) => fetch(`${url}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  type Tokens = { access_token: string; refresh_token: string; expires_in: number };
  const refresh = (t: Tokens) => tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id });

  /** The /authorize redirect and the browser's cookie: the request id, and the page's calls bound to that cookie. */
  const startConnect = async (state: string) => {
    const p = pkce();
    const ok = await authorize({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: p.challenge, code_challenge_method: "S256", state, resource: `${url}/mcp` });
    assert.equal(ok.status, 302);
    const to = new URL(ok.headers.get("location") ?? "");
    assert.equal(`${to.origin}${to.pathname}`, `${APP}/connect`);
    const request = to.searchParams.get("request") as string;
    const setCookie = ok.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly; SameSite=Lax/);
    const cookie = setCookie.split(";")[0] as string;
    const page = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
      fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: APP, cookie, "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { p, request, page };
  };
  /** The page's agent key, the owner's install of it, and the code redeemed: the new grant's tokens. */
  const connect = async (state: string, keep: boolean): Promise<{ tokens: Tokens; code: string; root: Hex; kept: number }> => {
    const c = await startConnect(state);
    const keyRes = await c.page("/connect/agent-key", { request: c.request, vault });
    const key = (await keyRes.json()) as { root: Hex };
    assert.equal(keyRes.status, 200, `${JSON.stringify(key)}\n${tails()}`);
    assert.equal(Object.keys(key).includes("relayerSplit"), false, "the gateway gives no address for the owner to allow");
    const again = (await (await c.page("/connect/agent-key", { request: c.request, vault })).json()) as { root: Hex };
    assert.equal(again.root, key.root, "one root per request");
    const early = await c.page("/connect/complete", { request: c.request });
    assert.equal(early.status, 409);
    assert.equal(((await early.json()) as { error: string }).error, "not_installed");
    assert.equal((await owner.v5.setAgentKey(key.root, 30)).status, "sent");
    const doneRes = await c.page("/connect/complete", { request: c.request, keep });
    const done = (await doneRes.json()) as { redirect: string; kept: number };
    assert.equal(doneRes.status, 200, JSON.stringify(done));
    const back = new URL(done.redirect);
    assert.deepEqual([`${back.origin}${back.pathname}`, back.searchParams.get("state"), back.searchParams.get("iss")], [redirect, state, url]);
    // Asked again before the code is redeemed (its answer lost): the same answer, to this browser only.
    const twice = (await (await c.page("/connect/complete", { request: c.request })).json()) as { redirect: string; again: boolean };
    assert.deepEqual([twice.redirect, twice.again], [done.redirect, true]);
    const code = back.searchParams.get("code") as string;
    const wrong = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: pkce().verifier });
    assert.equal(wrong.status, 400, "a wrong code_verifier");
    const res = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: c.p.verifier });
    const tokens = (await res.json()) as Tokens;
    assert.equal(res.status, 200, JSON.stringify(tokens));
    assert.equal((await c.page("/connect/complete", { request: c.request })).status, 409, "once redeemed, complete is done");
    return { tokens, code, root: key.root, kept: done.kept };
  };
  const mcp = async (accessToken: string) => {
    const c = new Client({ name: "oauth-test", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
    return c;
  };
  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => {
    const t = (r.content as { type: string; text: string }[])[0]?.text ?? "";
    if (r.isError === true) throw new Error(t);
    return JSON.parse(t) as Record<string, unknown>;
  };
  /** The status of an initialize with `accessToken`. */
  const initStatus = async (accessToken: string) =>
    (
      await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
      })
    ).status;
  const usdg = async () => (await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [DEST] })) as bigint;

  // Authorize: the redirect must be the client's (never redirected to otherwise); PKCE S256 required.
  const p0 = pkce();
  assert.equal((await authorize({ response_type: "code", client_id: client.client_id, redirect_uri: CLAUDE, code_challenge: p0.challenge, code_challenge_method: "S256", state: "s0" })).status, 400);
  const noPkce = await authorize({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, state: "s0" });
  assert.equal(noPkce.status, 302);
  assert.match(noPkce.headers.get("location") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback\?error=invalid_request/);

  // The page's calls: another origin, or another browser (no cookie), are refused.
  const c0 = await startConnect("s0");
  assert.equal((await c0.page(`/connect/request?id=${c0.request}`, undefined, { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${url}/connect/request?id=${c0.request}`, { headers: { origin: APP } })).status, 403);
  assert.equal((await fetch(`${url}/connect/agent-key`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ request: c0.request, vault }) })).status, 403);
  const info = (await (await c0.page(`/connect/request?id=${c0.request}`)).json()) as { client: string; redirectHost: string; status: string };
  assert.deepEqual([info.client, info.redirectHost, info.status], ["Claude", `127.0.0.1:${cbPort}`, "open"]);
  // The page waits for USDG on its way: the request lives on, at most two hours from /authorize.
  const ext = await c0.page("/connect/extend", { request: c0.request });
  assert.equal(ext.status, 200);
  assert.ok(new Date(((await ext.json()) as { expiresAt: string }).expiresAt).getTime() > Date.now() + 500_000);
  assert.match(((await (await c0.page("/connect/cancel", { request: c0.request })).json()) as { redirect: string }).redirect, /error=access_denied/);
  assert.equal((await c0.page("/connect/extend", { request: c0.request })).status, 409, "a cancelled request is not kept");

  // The owner's policy and allowlist, as the page sets them before the first key.
  assert.equal((await owner.v5.setPolicy({ actions: ["transfer", "open_channel"], perTx: "5", daily: "20" })).status, "sent");
  assert.equal((await owner.v5.setAllow("channel", split, true)).status, "sent");
  assert.equal((await owner.v5.setAllow("recipient", DEST, true)).status, "sent");

  // First connect: a short-lived child hands the key out (no session yet).
  const issued1 = Date.now();
  const g1 = await connect("s1", false);
  assert.equal(g1.tokens.expires_in, 3_600);
  assert.equal((await readV5(fork.client, vault))?.agentKey.root.toLowerCase(), g1.root.toLowerCase());
  const reused = await tokenReq({ grant_type: "authorization_code", code: g1.code, redirect_uri: redirect, client_id: client.client_id, code_verifier: pkce().verifier });
  assert.equal(reused.status, 400, "a code is redeemed once");

  // A code redeemed twice revokes its grant (RFC 6749 4.1.2): g1 is gone, and the sessions below use a fresh connect.
  assert.equal(await initStatus(g1.tokens.access_token), 401, "the grant of a code redeemed twice is revoked");
  let wait = 21_000 - (Date.now() - issued1);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const issued2 = Date.now();
  const g2 = await connect("s2", false);

  // The access token opens an agent session of the vault, in its sandbox.
  const a = await mcp(g2.tokens.access_token).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  assert.equal(text(await a.callTool({ name: "v5_status", arguments: {} })).role, "agent");
  const homeDir = readdirSync(root).find((n) => /^v[0-9a-f]{40}$/.test(n)) as string;
  const servers = homeServers(join(root, homeDir, "home"));
  assert.equal(servers.length, 1, tails());
  const pid = servers[0] as number;
  assert.notEqual(readlinkSync(`/proc/${pid}/ns/pid`), readlinkSync("/proc/self/ns/pid"), "the server runs in its own process namespace");
  assert.ok(existsSync(`/proc/${pid}/root${join(root, homeDir, "home")}`), "it sees its home");
  assert.equal(existsSync(`/proc/${pid}/root${join(root, "auth.sqlite")}`), false, "it does not see the gateway's database");
  assert.equal(existsSync(`/proc/${pid}/root${join(root, "home-id.key")}`), false, "nor the homes' key");
  assert.equal(existsSync(`/proc/${pid}/root${join(root, homeDir, "mcp.log")}`), false, "nor its own log (the gateway writes it)");
  assert.equal(existsSync(`/proc/${pid}/root${ownerHome}`), false, "nor anything else of the host");

  const names = (await a.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("withdraw") && names.includes("policy_set"));
  assert.ok(!names.includes("agent_key_request") && !names.includes("agent_key_set"), "the agent key tools are not listed");
  await assert.rejects(async () => text(await a.callTool({ name: "agent_key_request", arguments: {} })), /only by connecting/);
  const w = text(await a.callTool({ name: "withdraw", arguments: { destination: DEST, amount: "2" } }));
  assert.equal(w.status, "sent", `${JSON.stringify(w)}\n${tails()}`);
  assert.equal(await usdg(), parseUnits("2", 6));

  // An owner's tool is not run: it comes back as an approval for the owner, with its arguments as asked.
  const asked = text(await a.callTool({ name: "policy_set", arguments: { perTx: "50" } }));
  assert.equal(asked.status, "waiting_for_the_owner");
  const approval = new URL(asked.approve as string);
  assert.equal(`${approval.origin}${approval.pathname}`, `${APP}/approve`);
  const aid = approval.searchParams.get("id") as string;
  const appApi = (path: string, body?: unknown) => fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: APP, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const details = (await (await appApi(`/approve/request?id=${aid}`)).json()) as { vault: string; tool: string; args: Record<string, unknown>; status: string; askedBy: string };
  assert.deepEqual([getAddress(details.vault), details.tool, details.args, details.status, details.askedBy], [vault, "policy_set", { perTx: "50" }, "open", "Claude"]);
  await assert.rejects(async () => text(await a.callTool({ name: "policy_set", arguments: { perTx: "-1" } })), /invalid_input/);
  assert.equal(((await (await appApi("/approve/done", { id: aid, outcome: "declined" })).json()) as { status: string }).status, "declined");
  assert.equal((await appApi("/approve/done", { id: aid, outcome: "signed" })).status, 409);
  assert.equal((await readV5(fork.client, vault))?.policy.perTx, parseUnits("5", 6), "nothing changed on chain");

  // Refresh: a new pair; its session replaces the first.
  const r2 = (await (await refresh(g2.tokens)).json()) as Tokens;
  assert.ok(r2.access_token !== g2.tokens.access_token && r2.refresh_token !== g2.tokens.refresh_token);
  const b = await mcp(r2.access_token);
  assert.equal(text(await b.callTool({ name: "v5_status", arguments: {} })).role, "agent");

  // Connecting again, kept, while b's session lives: its server hands the key out and b goes on, with the new key.
  wait = 21_000 - (Date.now() - issued2);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const issued3 = Date.now();
  const g3 = await connect("s3", true);
  assert.equal(g3.kept, 1, "g2 was kept");
  assert.match(readFileSync(logs.gateway, "utf8"), /"event":"connect_agent_key"[^\n]*"from":"session"/);
  const w2 = text(await b.callTool({ name: "withdraw", arguments: { destination: DEST, amount: "1" } }));
  assert.equal(w2.status, "sent", `${JSON.stringify(w2)}\n${tails()}`);
  assert.equal(await usdg(), parseUnits("3", 6));
  // g2 refreshes still (kept).
  const r2b = (await (await refresh(r2)).json()) as Tokens;
  assert.ok(typeof r2b.access_token === "string", JSON.stringify(r2b));
  // A refresh token taken twice (no grace here) ends its grant only: g3 ends, g2 goes on.
  const g3r = (await (await refresh(g3.tokens)).json()) as Tokens;
  assert.equal((await refresh(g3.tokens)).status, 400);
  assert.equal(await initStatus(g3r.access_token), 401, "the reused refresh token's grant is revoked");
  const c = await mcp(r2b.access_token);
  assert.equal(text(await c.callTool({ name: "v5_status", arguments: {} })).role, "agent");

  // Connecting again, not kept: g2 ends with the key it was bound to.
  wait = 21_000 - (Date.now() - issued3);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const g4 = await connect("s4", false);
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(await initStatus(r2b.access_token), 401, "a grant ends when another key is installed and it is not kept");
  assert.equal((await refresh(r2b)).status, 400);
  const e = await mcp(g4.tokens.access_token);
  assert.equal(text(await e.callTool({ name: "v5_status", arguments: {} })).role, "agent");

  // The owner revokes the agent key on chain: every grant of the vault ends, its session with it.
  assert.equal((await owner.v5.revokeAgentKey()).status, "sent");
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(await initStatus(g4.tokens.access_token), 401, "the owner's revoke ends the grant");
  await assert.rejects(async () => e.callTool({ name: "v5_status", arguments: {} }));
  assert.equal((await refresh(g4.tokens)).status, 400);
  assert.match(readFileSync(logs.gateway, "utf8"), /"event":"grants_revoked_on_chain"/);

  // Nothing in the gateway's logs names the vault.
  assert.equal(readFileSync(logs.gateway, "utf8").toLowerCase().includes(vault.slice(2).toLowerCase()), false, "the logs name homes, never vaults");
});
