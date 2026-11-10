// The remote MCP gateway (remote.ts) end to end on a fork of Robinhood Chain mainnet with Ostra's live deployment at
// version 5, the keeper and the relayer set up as on mainnet (relayer/scripts/setup-mainnet.ts). The owner of a vault
// runs in this process; its agent is reached only over Streamable HTTP, through the gateway, as a Claude connector
// would: a user added with scripts/remote-user.ts, a bearer token, an MCP client. The agent asks for a key over HTTP,
// the owner installs it, and the agent withdraws within the policy over HTTP; an owner's tool is refused in the
// agent's session; a wrong token is refused; the sessions of one user share one child (one server per home), each
// answered on its own even when they ask at once with the same request ids; a burst of initializes starts one server;
// a home past its sessions ends the one idle longest; a home's last session ended by DELETE takes its child with it.
// Needs anvil on PATH.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { getAddress, parseUnits, type PrivateKeyAccount } from "viem";
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
const ADD_USER = here("../scripts/remote-user.ts");
const DEST = getAddress("0x00000000000000000000000000000000000C0D71");

let fork: Fork;
let dir: string;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-remote-"));
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

/** A tool's text answer, parsed as JSON; a tool error fails with its text. */
function result(r: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
  if (r.isError === true) throw new Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}

test("the remote gateway: an agent reached over Streamable HTTP, held to the owner's policy, the sessions of a user on one server", { timeout: 1_800_000 }, async () => {
  const d = await liveAtV5(fork, LIVE_DEPLOYMENT);
  const record = join(dir, "robinhood-v5.json");
  writeFileSync(record, `${JSON.stringify(d, null, 2)}\n`);
  await checkDeployment(fork.client, d);
  const base = join(dir, "robinhood");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const gatewayListen = `127.0.0.1:${port + 4}`;
  const setup = await setupMainnet({ base, deploymentPath: record, deployer: fork.accounts[0] as PrivateKeyAccount, rpcUrl: fork.url, log: () => {}, listen });
  await fork.setBalance(setup.relayerAccount, 10n ** 18n);
  const logs = { keeper: join(dir, "keeper.log"), relayer: join(dir, "relayer.log"), gateway: join(dir, "gateway.log") };
  const tails = () => Object.entries(logs).map(([n, f]) => `--- ${n}\n${readFileSync(f, "utf8").slice(-4_000)}`).join("\n");
  const start = (script: string, env: Record<string, string>, logFile: string) => {
    const out = openSync(logFile, "a");
    children.push(spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", out, out] }));
  };
  start(KEEPER, readEnv(join(base, "keeper.env")), logs.keeper);
  await waitFor(`http://${listen.keeper}/v1/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  start(RELAYER, { ...readEnv(join(base, "relayer.env")), OSTRA_RELAYER_CLIENT_IP: "socket" }, logs.relayer);
  await waitFor(`http://${listen.relayer}/v1/relayer`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));

  // The owner, in this process, with its vault.
  const ownerHome = join(dir, "owner");
  await mkdir(ownerHome, { recursive: true, mode: 0o700 });
  const owner = await Agent.open(
    await loadConfig({
      OSTRA_HOME: ownerHome,
      OSTRA_DEPLOYMENT: record,
      OSTRA_RPC_URL: fork.url,
      OSTRA_LOGS_RPC_URL: fork.url,
      OSTRA_RELAYER_URL: `http://${listen.relayer}`,
      OSTRA_KEEPER_URL: "off",
      OSTRA_AGGREGATOR_URL: "off",
      OSTRA_ETH_RPC_URL: "off",
      OSTRA_RAETO_URL: "off",
      OSTRA_PAD_INDEXER_URL: "off",
    }),
    () => {},
  );
  const vault = getAddress((await owner.buyer.open()).vault);
  await fork.dealUsdg(vault, parseUnits("40", 6));
  const usdg = async () => (await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [DEST] })) as bigint;

  // The gateway, with one user: the agent of that vault.
  const root = join(dir, "remote");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const usersFile = join(dir, "users.json");
  const token = execFileSync(process.execPath, [ADD_USER, usersFile, "add", "alice", vault], { encoding: "utf8" }).trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((JSON.parse(readFileSync(usersFile, "utf8")) as { users: unknown[] }).users.length, 1);
  start(
    GATEWAY,
    {
      OSTRA_REMOTE_USERS: usersFile,
      OSTRA_REMOTE_ROOT: root,
      OSTRA_REMOTE_LISTEN: gatewayListen,
      OSTRA_DEPLOYMENT: record,
      OSTRA_RPC_URL: fork.url,
      OSTRA_LOGS_RPC_URL: fork.url,
      OSTRA_RELAYER_URL: `http://${listen.relayer}`,
      OSTRA_KEEPER_URL: "off",
      OSTRA_AGGREGATOR_URL: "off",
      OSTRA_ETH_RPC_URL: "off",
      OSTRA_RAETO_URL: "off",
      OSTRA_PAD_INDEXER_URL: "off",
      OSTRA_PROVER: "off",
    },
    logs.gateway,
  );
  const url = `http://${gatewayListen}`;
  await waitFor(`${url}/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));

  // A wrong token, or none, is refused before any session.
  for (const auth of [{}, { authorization: "Bearer wrong" }]) {
    const r = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }) });
    assert.equal(r.status, 401);
  }

  const connect = async () => {
    const client = new Client({ name: "remote-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  };
  const a = await connect().catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  const names = (await a.listTools()).tools.map((t) => t.name);
  for (const n of ["agent_key_request", "withdraw", "v5_status", "balance"]) assert.ok(names.includes(n), n);

  // The agent asks for a key over HTTP; the owner sets the policy and the allowlist and installs it.
  const request = result(await a.callTool({ name: "agent_key_request", arguments: {} }));
  const facts = await owner.relayer!.facts();
  assert.equal((await owner.v5.setPolicy({ actions: ["transfer", "open_channel"], perTx: "5", daily: "20" })).status, "sent");
  assert.equal((await owner.v5.setAllow("recipient", DEST, true)).status, "sent");
  assert.equal((await owner.v5.setAllow("channel", facts.split, true)).status, "sent");
  assert.equal((await owner.v5.setAgentKey(request.root as `0x${string}`, 30)).status, "sent");
  assert.equal((await readV5(fork.client, vault))?.agentKey.inForce, true);
  assert.equal(result(await a.callTool({ name: "v5_status", arguments: {} })).role, "agent");

  // Within the policy over HTTP; above it, refused before anything is signed; an owner's tool refused.
  const w = result(await a.callTool({ name: "withdraw", arguments: { destination: DEST, amount: "2" } }));
  assert.equal(w.status, "sent", `${JSON.stringify(w)}\n${tails()}`);
  assert.equal(await usdg(), parseUnits("2", 6));
  const nonce = (await readV5(fork.client, vault))?.agentKey.agentNonce;
  await assert.rejects(async () => result(await a.callTool({ name: "withdraw", arguments: { destination: DEST, amount: "6" } })), /perTx/);
  await assert.rejects(async () => result(await a.callTool({ name: "agent_key_set", arguments: { root: request.root, days: 30 } })), /owner/);
  assert.equal((await readV5(fork.client, vault))?.agentKey.agentNonce, nonce, "nothing was signed");

  // A local file outside the user's own pad-files is never read: not the users file, not another folder.
  await assert.rejects(async () => result(await a.callTool({ name: "upload_image", arguments: { path: usersFile } })), /only files under/);
  await assert.rejects(async () => result(await a.callTool({ name: "pad_deliver", arguments: { jobId: `0x${"00".repeat(32)}`, output: "x", attachments: [join(root, "alice", "home", "server.lock")] } })), /only files under/);
  await assert.rejects(async () => result(await a.callTool({ name: "upload_image", arguments: { path: join(root, "alice", "pad-files", "..", "home", "server.lock") } })), /only files under/);
  symlinkSync(usersFile, join(root, "alice", "pad-files", "link.png"));
  await assert.rejects(async () => result(await a.callTool({ name: "upload_image", arguments: { path: join(root, "alice", "pad-files", "link.png") } })), /only files under/);

  // A second session of the same user shares the first's server: both answered, each its own answers, even asked at
  // once (the two clients number their requests alike: the gateway gives the child ids of its own).
  const aliceHome = join(root, "alice", "home");
  assert.equal(homeProcs(aliceHome).length, 1);
  const firstPid = homeProcs(aliceHome)[0];
  const b = await connect();
  for (let i = 0; i < 3; i++) {
    const [ra, rb, la, lb] = await Promise.all([
      a.callTool({ name: "v5_status", arguments: {} }),
      b.callTool({ name: "balance", arguments: {} }),
      a.listTools(),
      b.listTools(),
    ]);
    assert.equal(result(ra).role, "agent");
    assert.equal(rb.isError, undefined, JSON.stringify(rb).slice(0, 300));
    assert.equal(la.tools.length, lb.tools.length);
  }
  // Two fresh clients number their requests alike (initialize 0, then 1, 2...): asked at once with the same ids, each
  // gets its own answer (v5_status has the policy; balance has the relayer channels). Hosted by the gateway, balance
  // never tells the user to export the seed (kept on the gateway's host) and says so.
  const c1 = await connect();
  const c2 = await connect();
  for (let i = 0; i < 3; i++) {
    const [r1, r2] = await Promise.all([c1.callTool({ name: "v5_status", arguments: {} }), c2.callTool({ name: "balance", arguments: {} })]);
    assert.equal(result(r1).role, "agent");
    assert.ok("policy" in result(r1) && !("relayerChannels" in result(r1)));
    const bal = result(r2);
    assert.ok("relayerChannels" in bal && !("policy" in bal), JSON.stringify(r2).slice(0, 300));
    assert.ok(typeof bal.creatorVault === "object" && bal.creatorVault !== null);
    assert.match(String(bal.keys), /remote MCP gateway/);
    assert.ok(!("backupReminder" in (bal.vault as Record<string, unknown>)) && !("backupExported" in (bal.vault as Record<string, unknown>)));
    assert.ok(!JSON.stringify(r2).includes("backup export"));
  }
  await (c1.transport as StreamableHTTPClientTransport).terminateSession();
  await (c2.transport as StreamableHTTPClientTransport).terminateSession();
  await c1.close();
  await c2.close();
  assert.deepEqual(await health(), { ok: true, sessions: 2, children: 1 });
  assert.deepEqual(homeProcs(aliceHome), [firstPid], "one server for both sessions");
  assert.doesNotMatch(readFileSync(logs.gateway, "utf8"), /"why":"replaced"/);

  // Initializes in a burst join the live server: all answered, never a second server on the home.
  let most = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      most = Math.max(most, homeProcs(aliceHome).length);
      await new Promise((r) => setTimeout(r, 15));
    }
  })();
  const burst = await Promise.all(Array.from({ length: 5 }, () => rawInitialize(token)));
  await new Promise((r) => setTimeout(r, 1_000));
  sampling = false;
  await sampler;
  assert.deepEqual(burst, [200, 200, 200, 200, 200], `burst answered ${burst.join(",")}`);
  assert.equal(most, 1, `at most one server on the home at once (saw ${most})`);
  assert.deepEqual(await health(), { ok: true, sessions: 7, children: 1 });
  assert.deepEqual(homeProcs(aliceHome), [firstPid]);

  // A home keeps at most 16 sessions: one more ends the one idle longest, and the server goes on.
  for (let i = 0; i < 10; i++) assert.equal(await rawInitialize(token), 200);
  assert.deepEqual(await health(), { ok: true, sessions: 16, children: 1 });
  assert.match(readFileSync(logs.gateway, "utf8"), /"why":"home_full"/);
  assert.deepEqual(homeProcs(aliceHome), [firstPid]);

  // A refused initialize (a Host not allowed) ends nothing and starts nothing.
  assert.equal(await rawInitialize(token, "evil.example:443"), 403);
  assert.deepEqual(homeProcs(aliceHome), [firstPid]);
  assert.equal((await health()).sessions, 16);

  // Another user's token never reaches alice's session.
  const bobToken = execFileSync(process.execPath, [ADD_USER, usersFile, "add", "bob", vault], { encoding: "utf8" }).trim();
  const live = await connect();
  const sessionId = (live.transport as StreamableHTTPClientTransport).sessionId as string;
  const asBob = await postRaw(bobToken, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, { "mcp-session-id": sessionId });
  assert.equal(asBob, 404);

  // A new token for alice: the old one is refused and her live sessions end, her server with them.
  const token2 = execFileSync(process.execPath, [ADD_USER, usersFile, "add", "alice", vault], { encoding: "utf8" }).trim();
  assert.equal(await rawInitialize(token), 401);
  await until(async () => (await health()).children === 0, "alice's sessions end with her old token");
  assert.equal(homeProcs(aliceHome).length, 0);
  assert.match(readFileSync(logs.gateway, "utf8"), /"why":"user_changed"/);
  await live.close().catch(() => {});
  await a.close().catch(() => {});
  await b.close().catch(() => {});

  // With no server on the home, a burst of initializes starts exactly one (the home's lock): all answered.
  let most2 = 0;
  let sampling2 = true;
  const sampler2 = (async () => {
    while (sampling2) {
      most2 = Math.max(most2, homeProcs(aliceHome).length);
      await new Promise((r) => setTimeout(r, 15));
    }
  })();
  const burst2 = await Promise.all(Array.from({ length: 4 }, () => rawInitialize(token2)));
  await new Promise((r) => setTimeout(r, 1_000));
  sampling2 = false;
  await sampler2;
  assert.deepEqual(burst2, [200, 200, 200, 200], `burst answered ${burst2.join(",")}`);
  assert.equal(most2, 1, `one server started for the burst (saw ${most2})`);
  assert.deepEqual(await health(), { ok: true, sessions: 4, children: 1 });
  // Their user removed again (a new token, unused): its sessions and server end.
  execFileSync(process.execPath, [ADD_USER, usersFile, "add", "alice", vault], { encoding: "utf8" });
  assert.equal(await rawInitialize(token2), 401);
  await until(async () => (await health()).children === 0, "alice's sessions end again");

  // DELETE ends a session and its child (bob's).
  const bobClient = new Client({ name: "remote-test", version: "0.0.0" });
  await bobClient.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bobToken}` } } }));
  const bobHome = join(root, "bob", "home");
  assert.equal(homeProcs(bobHome).length, 1);
  await (bobClient.transport as StreamableHTTPClientTransport).terminateSession();
  await bobClient.close();
  await until(async () => (await health()).children === 0, "bob's session ends on DELETE");
  assert.equal(homeProcs(bobHome).length, 0);
  assert.match(readFileSync(join(root, "alice", "mcp.log"), "utf8"), /"event":"started"/);

  async function health(): Promise<{ ok: boolean; sessions: number; children: number }> {
    return (await (await fetch(`${url}/health`)).json()) as { ok: boolean; sessions: number; children: number };
  }
  async function until(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      if (Date.now() > deadline) assert.fail(`${what}: not within 15 s\n${tails()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  /** One POST to /mcp through node:http (so that the Host header can be set), answering its status. */
  function postRaw(bearer: string, body: unknown, extra: Record<string, string> = {}, hostHeader?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = httpRequest(
        { host: "127.0.0.1", port: Number(gatewayListen.split(":")[1]), path: "/mcp", method: "POST", headers: { host: hostHeader ?? gatewayListen, authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(data), ...extra } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          // An initialize answered over SSE stays open: the status is all that is wanted.
          res.destroy();
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }
  function rawInitialize(bearer: string, hostHeader?: string): Promise<number> {
    return postRaw(bearer, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }, {}, hostHeader);
  }
});

/** The pids of server.ts processes whose OSTRA_HOME is `home` (read from /proc). */
function homeProcs(home: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, "latin1");
      // The server itself, not the flock(1) that holds its home for it.
      if (!cmd.includes("server.ts") || cmd.startsWith("/usr/bin/flock")) continue;
      if (readFileSync(`/proc/${d}/environ`, "latin1").split("\0").includes(`OSTRA_HOME=${home}`)) out.push(d);
    } catch {
      // gone, or not ours
    }
  }
  return out;
}
