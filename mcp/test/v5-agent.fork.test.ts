// Version 5 end to end on a fork of Robinhood Chain mainnet with Ostra's live deployment, the vault beacon upgraded to
// the version 5 implementation deployed on mainnet (as its scheduled call does), the keeper and the relayer set up as
// on mainnet (relayer/scripts/setup-mainnet.ts), and two MCP servers: the owner of a vault, and its agent (another
// seed, OSTRA_AGENT_OF). The owner sets the policy and the allowlist; the agent asks for a key and the owner installs
// it; the agent pays the relayer from the vault through a channel its own key opens, and withdraws within the policy;
// what the policy refuses is refused before anything is signed; a PAY order the agent sets is run by the owner's
// sweep through the relayer; an agent withdrawal signed and not relayed is sent first by the next call (and is not
// signed twice), and with no relayer channel left to pay for it, on credit; revoking the key ends the agent's spends,
// and a new key is never one handed out before.
// Needs anvil on PATH.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { getAddress, parseUnits, type Address, type PrivateKeyAccount } from "viem";
import { checkDeployment, readV5, usdgAbi, USDG } from "@ostraagent/sdk";
import { liveAtV5, startFork, vaultBeaconAtRecord, type Fork } from "@ostraagent/sdk/test/fork";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const RELAYER = here("../../relayer/src/server.ts");
const KEEPER = here("../../keeper/src/main.ts");
const DEST = getAddress("0x00000000000000000000000000000000000C0D61");
const STRANGER = getAddress("0x00000000000000000000000000000000000C0D62");

let fork: Fork;
let dir: string;
let proxy: Server | undefined;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-v5-agent-"));
});

after(async () => {
  for (const c of children) c.kill();
  await new Promise<void>((resolve) => (proxy === undefined ? resolve() : proxy.close(() => resolve())));
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

/** Forwards to `upstream`; the first relay request whose calldata names `drop.address` (set before) is answered 503, once. */
async function relayerProxy(upstream: string): Promise<{ url: string; drop: { address: string | null; dropped: number } }> {
  const drop = { address: null as string | null, dropped: 0 };
  proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (req.method === "POST" && req.url === "/v1/relay" && drop.address !== null && body.toString("utf8").toLowerCase().includes(drop.address)) {
      drop.address = null;
      drop.dropped++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable", message: "dropped by the test's proxy" }));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const up = await fetch(`${upstream}${req.url ?? "/"}`, { method: req.method ?? "GET", headers, ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }) });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (k !== "content-length" && k !== "transfer-encoding" && k !== "content-encoding") out[k] = v;
    });
    res.writeHead(up.status, out);
    res.end(Buffer.from(await up.arrayBuffer()));
  });
  await new Promise<void>((resolve) => (proxy as Server).listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, drop };
}

/** Marks every relayer channel kept in `home` retired (as after SESSION_MAX_AGE_SECONDS): it pays nothing more. */
function retireChannels(home: string): number {
  let n = 0;
  for (const name of readdirSync(join(home, "relayer"))) {
    const path = join(home, "relayer", name);
    const r = JSON.parse(readFileSync(path, "utf8")) as { channels: { retired: boolean }[] };
    for (const c of r.channels) {
      c.retired = true;
      n++;
    }
    writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  }
  return n;
}

test("an owner and its agent: policy, allowlist, agent key, agent spends within the policy, a standing order, revoke", { timeout: 1_800_000 }, async () => {
  const d = await liveAtV5(fork, LIVE_DEPLOYMENT);
  const record = join(dir, "robinhood-v5.json");
  writeFileSync(record, `${JSON.stringify(d, null, 2)}\n`);
  // Version 5 went live on mainnet on 9 Nov 2026: a fork after that has it already.
  assert.ok(["upgraded on the fork as scheduled", "on mainnet already"].includes(await vaultBeaconAtRecord(fork, d)));
  await checkDeployment(fork.client, d);
  const base = join(dir, "robinhood");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const setup = await setupMainnet({ base, deploymentPath: record, deployer: fork.accounts[0] as PrivateKeyAccount, rpcUrl: fork.url, log: () => {}, listen });
  await fork.setBalance(setup.relayerAccount, 10n ** 18n);
  const logs = { keeper: join(dir, "keeper.log"), relayer: join(dir, "relayer.log") };
  const tails = () => Object.entries(logs).map(([n, f]) => `--- ${n}\n${readFileSync(f, "utf8").slice(-4_000)}`).join("\n");
  const start = (script: string, envFile: string, logFile: string, extra: Record<string, string> = {}) => {
    const out = openSync(logFile, "a");
    children.push(spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...readEnv(join(base, envFile)), ...extra }, stdio: ["ignore", out, out] }));
  };
  start(KEEPER, "keeper.env", logs.keeper);
  await waitFor(`http://${listen.keeper}/v1/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  start(RELAYER, "relayer.env", logs.relayer, { OSTRA_RELAYER_CLIENT_IP: "socket" });
  await waitFor(`http://${listen.relayer}/v1/relayer`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));

  const p = await relayerProxy(`http://${listen.relayer}`);
  const open = async (name: string, agentOf?: Address) => {
    const home = join(dir, name);
    await mkdir(home, { recursive: true, mode: 0o700 });
    return Agent.open(
      await loadConfig({
        OSTRA_HOME: home,
        OSTRA_DEPLOYMENT: record,
        OSTRA_RPC_URL: fork.url,
        OSTRA_LOGS_RPC_URL: fork.url,
        OSTRA_RELAYER_URL: agentOf === undefined ? `http://${listen.relayer}` : p.url,
        OSTRA_KEEPER_URL: "off",
        OSTRA_AGGREGATOR_URL: "off",
        OSTRA_ETH_RPC_URL: "off",
        OSTRA_RAETO_URL: "off",
        OSTRA_PAD_INDEXER_URL: "off",
        ...(agentOf === undefined ? {} : { OSTRA_AGENT_OF: agentOf }),
      }),
      () => {},
    );
  };
  const usdg = async (who: Address) => (await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] })) as bigint;

  // The owner's vault, at version 5, with an empty policy.
  const owner = await open("owner");
  const vault = getAddress((await owner.buyer.open()).vault);
  await fork.dealUsdg(vault, parseUnits("40", 6));
  assert.equal((await owner.v5.status()).version, 5);

  // The agent asks for a key; the owner sets the policy and the allowlist the agent needs, then installs it.
  const agent = await open("agent", vault);
  assert.equal(await agent.buyer.vaultAddress(), vault, "the agent's vault is the owner's");
  await assert.rejects(agent.v5.setPolicy({ perTx: "1" }), /policy|owner/, "the agent key never sets the policy");
  const request = await agent.agentKey!.request();
  const facts = await owner.relayer!.facts();
  const policy = await owner.v5.setPolicy({ actions: ["transfer", "open_channel", "set_order", "cancel_order"], perTx: "5", daily: "20" });
  assert.equal(policy.status, "sent", JSON.stringify(policy));
  assert.equal((await owner.v5.setAllow("recipient", DEST, true)).status, "sent");
  assert.equal((await owner.v5.setAllow("channel", facts.split, true)).status, "sent");
  await assert.rejects(owner.v5.setAllow("recipient", DEST, true), /in force already/, "nothing is signed for an entry already there");
  const installed = await owner.v5.setAgentKey(request.root, 30);
  assert.equal(installed.status, "sent", JSON.stringify(installed));
  assert.equal((await readV5(fork.client, vault))?.agentKey.inForce, true);
  await assert.rejects(owner.v5.setAgentKey(request.root, 30), /in force already|before/, "the same root is never installed twice");

  // The agent withdraws within the policy: its own key opens the relayer channel from the vault and pays it.
  const w = await agent.buyer.withdraw(DEST, "2");
  assert.equal(w.status, "sent", `${JSON.stringify(w)}\n${tails()}`);
  assert.equal(await usdg(DEST), parseUnits("2", 6));
  const after = await readV5(fork.client, vault);
  assert.ok(after !== null && after.agentKey.agentNonce >= 3n, "the channel open and the withdrawal were agent spends");
  // Refused before anything is signed: a recipient not on the allowlist, an amount above perTx.
  const nonce = after.agentKey.agentNonce;
  await assert.rejects(agent.buyer.withdraw(STRANGER, "1"), /allowlist/);
  await assert.rejects(agent.buyer.withdraw(DEST, "6"), /perTx/);
  assert.equal((await readV5(fork.client, vault))?.agentKey.agentNonce, nonce, "nothing was signed");

  // An agent withdrawal signed and its request dropped: kept. The same withdrawal asked again sends the kept one and
  // answers sent (never signed twice).
  p.drop.address = DEST.slice(2).toLowerCase();
  await assert.rejects(agent.buyer.withdraw(DEST, "1.5"), /kept/);
  assert.equal(p.drop.dropped, 1);
  assert.deepEqual((await agent.buyer.status()).pendingWithdrawal, { destination: DEST, amount: "1.5" });
  const dest0 = await usdg(DEST);
  const resent = await agent.buyer.withdraw(DEST, "1.5");
  assert.equal(resent.status, "sent", JSON.stringify(resent));
  assert.equal((await usdg(DEST)) - dest0, parseUnits("1.5", 6), "paid once");
  assert.equal((await agent.buyer.status()).pendingWithdrawal, null);
  // Kept again, and no relayer channel of the agent can pay any more (retired): the next call sends it on credit, and
  // the channel the agent key opens next pays that debt with its first voucher.
  p.drop.address = DEST.slice(2).toLowerCase();
  await assert.rejects(agent.buyer.withdraw(DEST, "0.5"), /kept/);
  assert.equal(p.drop.dropped, 2);
  assert.ok(retireChannels(join(dir, "agent")) >= 1);
  const agent2 = await open("agent", vault);
  const dest1 = await usdg(DEST);
  const after2 = await agent2.buyer.withdraw(DEST, "0.25");
  assert.equal(after2.status, "sent", `${JSON.stringify(after2)}\n${tails()}`);
  assert.equal((await usdg(DEST)) - dest1, parseUnits("0.75", 6), "the kept 0.5, then 0.25");
  assert.match(readFileSync(logs.relayer, "utf8"), /spend_sent_on_credit/);

  // A PAY order the agent sets runs from the owner's sweep, through the relayer.
  const order = await agent.v5.setOrder({ kind: "pay", target: DEST, amount: "1", intervalSeconds: 3_600, runs: 2 });
  assert.equal(order.status, "sent", JSON.stringify(order));
  const before = await usdg(DEST);
  const ran = await owner.v5.runDue();
  assert.deepEqual(ran.ran.map((r) => [r.kind, r.error]), [["order", undefined]], JSON.stringify(ran));
  assert.equal((await usdg(DEST)) - before, parseUnits("1", 6));
  assert.deepEqual((await owner.v5.runDue()).ran, [], "not due again before its interval");
  assert.equal((await agent.v5.cancelOrder(BigInt(order.orderId!))).status, "sent");

  // The owner revokes the key: the agent signs nothing more; a new key is never one handed out before.
  assert.equal((await owner.v5.revokeAgentKey()).status, "sent");
  await assert.rejects(agent.buyer.withdraw(DEST, "1"), /agent key/);
  const again = await agent.agentKey!.request();
  assert.notEqual(again.root, request.root);
  assert.ok(BigInt(again.index) > BigInt(request.index));
  const status = await owner.v5.status();
  assert.equal(status.agentKey.inForce, false);
  assert.deepEqual(status.allowlist.map((e) => e.kind).sort(), ["channel", "recipient"]);
});
