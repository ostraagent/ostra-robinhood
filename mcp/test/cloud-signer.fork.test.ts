// Ostra Cloud's signer behind the remote MCP gateway (signer.ts, signer-client.ts, remote.ts with
// OSTRA_REMOTE_SIGNER_*), end to end on a fork of Robinhood Chain mainnet with Ostra's live deployment at version 5,
// the keeper and the relayer set up as on mainnet (relayer/scripts/setup-mainnet.ts). The signer runs as its own
// process; the gateway has it make the agent's seed and hands the agent's server, in its bubblewrap sandbox, its socket
// and a token. The agent's home never holds a seed. Over Streamable HTTP the agent asks for a key, the owner installs
// it, and the agent withdraws within the policy through the signer; above the policy nothing is signed; the agent's own
// seed is refused (private notes) and balance says where the seed is. A new server of the home gets a new token and
// the one before stops opening the seed. With the signer stopped no server starts (503); restarted with its records of
// the agent key lost, the agent key's signature is still found in the relayer's escrow, and the agent spends again.
// Needs anvil and bwrap on PATH.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { getAddress, parseUnits, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROBINHOOD_CHAIN_ID, checkDeployment, readV5, usdgAbi, wotsVerify, USDG } from "@ostraagent/sdk";
import { liveAtV5, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, SignatureEscrowClient } from "@ostraagent/core";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { DiskFolder } from "../src/disk.ts";
import { ADMIN, socketPath } from "../src/signer.ts";
import { SignerError, SignerSeed } from "../src/signer-client.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const RELAYER = here("../../relayer/src/server.ts");
const KEEPER = here("../../keeper/src/main.ts");
const GATEWAY = here("../src/remote.ts");
const SIGNER = here("../src/signer.ts");
const ADD_USER = here("../scripts/remote-user.ts");
const DEST = getAddress("0x00000000000000000000000000000000000C0D81");

let fork: Fork;
let dir: string;
/** The signer's sockets: a short path of its own (a socket path holds at most 107 bytes). */
let sockets: string;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-cloud-signer-"));
  sockets = mkdtempSync("/tmp/ocs-");
});

after(async () => {
  for (const c of children) c.kill();
  await fork?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  if (sockets !== undefined) rmSync(sockets, { recursive: true, force: true });
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

test("Ostra Cloud's signer: a hosted agent with no seed in its home, held to the owner's policy, its tokens revoked per server", { timeout: 1_800_000 }, async () => {
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
  const logs = { keeper: join(dir, "keeper.log"), relayer: join(dir, "relayer.log"), gateway: join(dir, "gateway.log"), signer: join(dir, "signer.log") };
  const tails = () => Object.entries(logs).map(([n, f]) => `--- ${n}\n${existsSync(f) ? readFileSync(f, "utf8").slice(-4_000) : ""}`).join("\n");
  const start = (script: string, env: Record<string, string>, logFile: string): ChildProcess => {
    const out = openSync(logFile, "a");
    const c = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", out, out] });
    children.push(c);
    return c;
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

  // The signer: its own process, its seeds sealed on its own volume (a seal key file here: outside a TEE).
  const signerRoot = join(dir, "signer");
  const adminKeyFile = join(dir, "signer-admin.key");
  const sealFile = join(dir, "signer-seal.key");
  const adminKey = randomBytes(32);
  writeFileSync(adminKeyFile, `${adminKey.toString("hex")}\n`, { mode: 0o600 });
  writeFileSync(sealFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  const signerEnv = { OSTRA_SIGNER_SOCKETS: sockets, OSTRA_SIGNER_ROOT: signerRoot, OSTRA_SIGNER_ADMIN_KEY_FILE: adminKeyFile, OSTRA_SIGNER_SEAL: `file:${sealFile}` };
  /** Starts the signer and waits until the sockets of the admin and of `agents` listen (the agents' open after the admin's). */
  const startSigner = async (agents: string[] = []): Promise<ChildProcess> => {
    const before = existsSync(logs.signer) ? readFileSync(logs.signer, "utf8").length : 0;
    const c = start(SIGNER, signerEnv, logs.signer);
    const deadline = Date.now() + 30_000;
    const listening = () => {
      const text = readFileSync(logs.signer, "utf8").slice(before);
      return [ADMIN, ...agents].every((p) => text.includes(`"socket":"${socketPath(sockets, p)}"`));
    };
    while (!listening()) {
      if (c.exitCode !== null || Date.now() > deadline) assert.fail(`the signer did not start\n${tails()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    return c;
  };
  const stopSigner = async (c: ChildProcess): Promise<void> => {
    if (c.exitCode !== null) return;
    const exited = new Promise((r) => c.once("exit", r));
    c.kill("SIGTERM");
    await exited;
  };
  let signer = await startSigner();

  // The gateway, with the signer, every child in its sandbox; one user: the agent of the owner's vault.
  const root = join(dir, "remote");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const usersFile = join(dir, "users.json");
  const token = execFileSync(process.execPath, [ADD_USER, usersFile, "add", "alice", vault], { encoding: "utf8" }).trim();
  const bobToken = execFileSync(process.execPath, [ADD_USER, usersFile, "add", "bob", vault], { encoding: "utf8" }).trim();
  start(
    GATEWAY,
    {
      OSTRA_REMOTE_USERS: usersFile,
      OSTRA_REMOTE_ROOT: root,
      OSTRA_REMOTE_LISTEN: gatewayListen,
      OSTRA_REMOTE_SANDBOX: "bwrap",
      OSTRA_REMOTE_SIGNER_SOCKETS: sockets,
      OSTRA_REMOTE_SIGNER_ADMIN_KEY_FILE: adminKeyFile,
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
  assert.match(readFileSync(logs.gateway, "utf8"), /"sandbox":"bwrap","signer":true/);
  // GET /attestation: anyone may ask (no token, CORS open); the nonce is checked; this signer seals from a file, so it
  // has no TEE to attest and the gateway answers 503 (the enclave's own is checked on Ostra Cloud, by dstack-verifier).
  const att = async (q: string) => {
    const r = await fetch(`${url}/attestation${q}`);
    return { status: r.status, cors: r.headers.get("access-control-allow-origin"), body: (await r.json()) as { error?: string } };
  };
  assert.deepEqual(await att("?nonce=xyz"), { status: 400, cors: "*", body: { error: "nonce must be 32 bytes, lower case hex (64 characters)" } });
  assert.deepEqual(await att(`?nonce=${"AB".repeat(32)}`), { status: 400, cors: "*", body: { error: "nonce must be 32 bytes, lower case hex (64 characters)" } });
  assert.deepEqual(await att(`?nonce=${"ab".repeat(32)}`), { status: 503, cors: "*", body: { error: "the attestation could not be made: ask again" } });
  assert.match(readFileSync(logs.gateway, "utf8"), /"event":"attest_failed","message":"the signer refused: no attestation here: the signer runs outside a TEE/);

  const connect = async (bearer = token) => {
    const client = new Client({ name: "cloud-signer-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
    return client;
  };
  const a = await connect().catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));

  // The home holds no seed; the signer holds alice's, sealed; the token beside the home is 0600.
  const aliceHome = join(root, "alice", "home");
  const tokenFile = join(root, "alice", "signer.token");
  assert.equal(existsSync(join(aliceHome, "master.key")), false, "no seed in the home");
  assert.equal(existsSync(join(signerRoot, "agents", "alice", "seed.sealed")), true);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  const token1 = readFileSync(tokenFile, "utf8").trim();

  // The agent asks for a key over HTTP; the owner sets the policy and the allowlist and installs it.
  const request = result(await a.callTool({ name: "agent_key_request", arguments: {} }));
  const facts = await owner.relayer!.facts();
  assert.equal((await owner.v5.setPolicy({ actions: ["transfer", "open_channel"], perTx: "5", daily: "20" })).status, "sent");
  assert.equal((await owner.v5.setAllow("recipient", DEST, true)).status, "sent");
  assert.equal((await owner.v5.setAllow("channel", facts.split, true)).status, "sent");
  assert.equal((await owner.v5.setAgentKey(request.root as `0x${string}`, 30)).status, "sent");
  assert.equal(result(await a.callTool({ name: "v5_status", arguments: {} })).role, "agent");

  // Within the policy, through the signer: the channel to the relayer and the withdrawal.
  const w = result(await a.callTool({ name: "withdraw", arguments: { destination: DEST, amount: "2" } }));
  assert.equal(w.status, "sent", `${JSON.stringify(w)}\n${tails()}`);
  assert.equal(await usdg(), parseUnits("2", 6));
  const nonce = (await readV5(fork.client, vault))?.agentKey.agentNonce;
  await assert.rejects(async () => result(await a.callTool({ name: "withdraw", arguments: { destination: DEST, amount: "6" } })), /perTx/);
  assert.equal((await readV5(fork.client, vault))?.agentKey.agentNonce, nonce, "nothing was signed");

  // The agent's own seed is refused (private notes); balance says where the seed is, with no vaults of the agent's own.
  await assert.rejects(async () => result(await a.callTool({ name: "private_balance", arguments: {} })), /not_on_ostra_cloud: .*signer/);
  const bal = result(await a.callTool({ name: "balance", arguments: {} }));
  assert.equal(bal.creatorVault, null);
  assert.deepEqual(bal.tokenVaults, []);
  assert.match(String(bal.keys), /Ostra Cloud/);
  assert.ok(!JSON.stringify(bal).includes("backup export"));
  assert.equal(existsSync(join(aliceHome, "master.key")), false, "still no seed in the home");

  // The home's server ends with its session; the next one gets a new token, and the one before opens nothing.
  await (a.transport as StreamableHTTPClientTransport).terminateSession();
  await a.close();
  await until(async () => (await health()).children === 0, "alice's server ends");
  const b = await connect();
  const token2 = readFileSync(tokenFile, "utf8").trim();
  assert.notEqual(token2, token1);
  const stale = new SignerSeed(socketPath(sockets, "alice"), "alice", token1);
  await assert.rejects(stale.voucherAddress(ROBINHOOD_CHAIN_ID, USDG, `0x${"11".repeat(32)}`), (e: Error) => e instanceof SignerError && /not authorized/.test(e.message));
  stale.close();
  const w2 = result(await b.callTool({ name: "withdraw", arguments: { destination: DEST, amount: "1" } }));
  assert.equal(w2.status, "sent", `${JSON.stringify(w2)}\n${tails()}`);
  assert.equal(await usdg(), parseUnits("3", 6));

  // The signer stopped: no new home's server starts (503).
  await stopSigner(signer);
  assert.equal(await rawInitialize(bobToken), 503);
  assert.match(readFileSync(logs.gateway, "utf8"), /"event":"signer_failed","user":"bob"/);

  // Restarted with its records of alice's agent keys lost (a volume restored from before): the first agent key's
  // signature is still found in the relayer's escrow, checked against the signer's key root, and alice spends again.
  rmSync(join(signerRoot, "agents", "alice", "wots"), { recursive: true, force: true });
  signer = await startSigner(["alice"]);
  const seed = new SignerSeed(socketPath(sockets, "alice"), "alice", token2);
  try {
    const keys = new Keys({ remote: seed, feePayer: privateKeyToAccount(generatePrivateKey()), store: { load: async () => undefined, saveIfAbsent: async () => true }, folder: new DiskFolder(join(dir, "escrow-check")), backupExported: async () => true, escrow: new SignatureEscrowClient(`http://${listen.relayer}`) });
    const first = BigInt(String(request.index));
    assert.equal(await keys.agentRecorded(ROBINHOOD_CHAIN_ID, vault, first), undefined, "the signer's record is gone");
    const found = await keys.agentSigned(ROBINHOOD_CHAIN_ID, vault, first);
    assert.ok(found !== undefined, "found in the escrow");
    assert.equal(`0x${found.keyRoot}`, (request.root as string).toLowerCase());
    assert.equal(wotsVerify(Buffer.from(found.signature, "hex"), Buffer.from(found.message, "hex"), Buffer.from(found.keyRoot, "hex")), true);
  } finally {
    seed.close();
  }
  const w3 = result(await b.callTool({ name: "withdraw", arguments: { destination: DEST, amount: "0.5" } }));
  assert.equal(w3.status, "sent", `${JSON.stringify(w3)}\n${tails()}`);
  assert.equal(await usdg(), parseUnits("3.5", 6));
  await b.close();

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
  /** An initialize POSTed to /mcp, answering its status. */
  function rawInitialize(bearer: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
      const req = httpRequest(
        { host: "127.0.0.1", port: Number(gatewayListen.split(":")[1]), path: "/mcp", method: "POST", headers: { host: gatewayListen, authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(data) } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          res.destroy();
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }
});
