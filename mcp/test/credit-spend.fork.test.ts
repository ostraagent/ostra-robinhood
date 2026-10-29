// A spend signed and not landed while no relayer channel can pay for it (its one-time key is the one a new channel's
// open needs): the relayer sends it on credit, as the vault's debt (relayer gate: a spend on credit, decided 29 Oct
// 2026), and the channel opened next pays that debt with its first voucher, then the operation asked for runs. Through
// the keeper and relayer processes set up as on mainnet (relayer/scripts/setup-mainnet.ts) on a fork of Robinhood Chain
// mainnet with Ostra's live deployment, and the MCP server's own Agent. A withdrawal is signed and left unsent (a proxy
// in front of the relayer drops its request once); the agent's relayer channels are then past their use (retired, as
// after SESSION_MAX_AGE_SECONDS); the next withdrawal sends the kept one on credit first. A kept withdrawal that would
// leave the vault less than twice its price is refused on credit, and the agent is told to send ETH as before.
// Needs anvil on PATH.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { formatUnits, getAddress, parseUnits, type Address, type PrivateKeyAccount } from "viem";
import { checkDeployment, parseDeployment, usdgAbi, USDG } from "@ostraagent/sdk";
import { startFork, vaultBeaconAtRecord, type Fork } from "@ostraagent/sdk/test/fork";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const RELAYER = here("../../relayer/src/server.ts");
const KEEPER = here("../../keeper/src/main.ts");
const DEST1 = getAddress("0x00000000000000000000000000000000000C0D01");
const DEST2 = getAddress("0x00000000000000000000000000000000000C0D02");
const DEST3 = getAddress("0x00000000000000000000000000000000000C0D03");

let fork: Fork;
let dir: string;
let proxy: Server | undefined;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-credit-spend-"));
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

test("a kept spend no channel can pay is sent on credit, its debt paid by the next channel's first voucher; one that would leave too little is refused on credit", { timeout: 1_800_000 }, async () => {
  const live = parseDeployment(JSON.parse(readFileSync(LIVE_DEPLOYMENT, "utf8")));
  await vaultBeaconAtRecord(fork, live);
  await checkDeployment(fork.client, live);
  const base = join(dir, "robinhood");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const setup = await setupMainnet({ base, deploymentPath: LIVE_DEPLOYMENT, deployer: fork.accounts[0] as PrivateKeyAccount, rpcUrl: fork.url, log: () => {}, listen });
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

  const home = join(dir, "agent");
  await mkdir(home, { mode: 0o700 });
  const open = async () =>
    Agent.open(
      await loadConfig({
        OSTRA_HOME: home,
        OSTRA_DEPLOYMENT: LIVE_DEPLOYMENT,
        OSTRA_RPC_URL: fork.url,
        OSTRA_LOGS_RPC_URL: fork.url,
        OSTRA_RELAYER_URL: p.url,
        OSTRA_KEEPER_URL: "off",
        OSTRA_AGGREGATOR_URL: "off",
        OSTRA_ETH_RPC_URL: "off",
        OSTRA_RAETO_URL: "off",
        OSTRA_PAD_INDEXER_URL: "off",
      }),
      () => {},
    );
  const usdg = async (who: Address) => (await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] })) as bigint;
  const relayerState = async (vault: Address) => (await (await fetch(`http://${listen.relayer}/v1/vaults/${vault}`)).json()) as { debt: string; unpaidOpen: unknown };

  const a = await open();
  const created = await a.buyer.open();
  assert.equal(created.created, true, JSON.stringify(created));
  const vault = getAddress(created.vault);
  await fork.dealUsdg(vault, parseUnits("20", 6));
  // A first withdrawal opens a relayer channel and pays; the second is signed and its request dropped: kept.
  const w0 = await a.buyer.withdraw(DEST3, "1");
  assert.equal(w0.status, "sent", JSON.stringify(w0));
  p.drop.address = DEST1.slice(2).toLowerCase();
  await assert.rejects(a.buyer.withdraw(DEST1, "2"), /kept/);
  assert.equal(p.drop.dropped, 1);
  assert.notEqual((await a.buyer.status()).pendingWithdrawal, null, "the withdrawal to DEST1 is signed and kept");
  assert.equal(await usdg(DEST1), 0n);

  // Its channels used up: a new Agent on the same home (as after a restart) reads them retired.
  assert.ok(retireChannels(home) >= 1);
  const b = await open();
  const w = await b.buyer.withdraw(DEST2, "3");
  assert.equal(w.status, "sent", JSON.stringify(w));
  const first = (w as unknown as { sentFirst?: { operation: string; destination: string; amount: string } }).sentFirst;
  assert.deepEqual(first && { operation: first.operation, destination: getAddress(first.destination), amount: first.amount }, { operation: "withdraw", destination: DEST1, amount: "2" }, JSON.stringify(w));
  assert.equal(await usdg(DEST1), parseUnits("2", 6));
  assert.equal(await usdg(DEST2), parseUnits("3", 6));
  // The debt was paid by the new channel's first voucher.
  const s = await relayerState(vault);
  assert.deepEqual({ debt: s.debt, unpaidOpen: s.unpaidOpen }, { debt: "0", unpaidOpen: null }, tails());
  assert.match(readFileSync(logs.relayer, "utf8"), /spend_sent_on_credit/);

  // A kept withdrawal that leaves the vault less than twice its price after it: the relayer does not send it on
  // credit, and the agent is asked for ETH as before. With its channels retired, a withdrawal of everything is refused
  // before it is signed and names what a new channel needs (spends cost more on a fork, at its gas price); the kept
  // withdrawal then leaves that channel's deposit and 0.01 USDG.
  assert.ok(retireChannels(home) >= 1);
  const c = await open();
  const left = await usdg(vault);
  const asked = await c.buyer.withdraw(DEST3, formatUnits(left, 6)).then(
    (r) => assert.fail(`a withdrawal of everything was not refused: ${JSON.stringify(r)}`),
    (e: unknown) => String(e),
  );
  const need = /less than the ([0-9.]+) a relayer channel needs/.exec(asked);
  assert.ok(need !== null, asked);
  assert.equal(await usdg(vault), left, "nothing was signed or sent for it");
  const amount = left - parseUnits(need[1] as string, 6) - 10_000n;
  assert.ok(amount > 0n, `the vault holds ${left}, a channel needs ${need[1]}`);
  p.drop.address = DEST3.slice(2).toLowerCase();
  await assert.rejects(c.buyer.withdraw(DEST3, formatUnits(amount, 6)), /kept/);
  assert.equal(p.drop.dropped, 2);
  assert.ok(retireChannels(home) >= 1);
  const d = await open();
  await assert.rejects(d.buyer.withdraw(DEST2, "0.000001"), (e: unknown) => /did not send it on credit .*credit_refused|did not send it on credit .*less than the/.test(String(e)) && /send at least .* ETH/.test(String(e)));
  const s2 = await relayerState(vault);
  assert.equal(s2.debt, "0", "nothing was relayed on credit");
});
