// The MCP server as an agent's client runs it: spawned over stdio (the stock
// MCP client), on a fork of Robinhood Chain mainnet with Ostra and the
// launchpad deployed, without a relayer (the fee payer in OSTRA_HOME pays gas;
// the relayer path runs in core/scripts/chain-check.ts). The tools are
// listed; the vault is opened and funded; a withdrawal; the creator vault is
// funded; a launch whose dev buy the contract refuses comes back as an error
// refused before signing; a launch with a dev buy, a buy and a sell, the
// pool's view; the token list and a token's page; the creator vault's
// profile, its ERC-8004 registration (against the live Identity Registry) and
// the token's metadata; the pairs (USDG, ETH, the stock tokens) and a launch
// paired with NVDA, whose pool a vault without NVDA cannot buy; errors for bad
// input. The keys stay in OSTRA_HOME (0700) and
// a second server on the same OSTRA_HOME finds the same vault.
// The server's event searches (OSTRA_LOGS_RPC_URL) go to a local JSON-RPC
// endpoint that sends eth_getLogs over the chain's history to Robinhood
// Chain's public RPC and over the fork's own blocks to the fork (core's
// split-logs.ts), as the MCP's default logs RPC is the public one: through the
// fork they would reach OSTRA_FORK_RPC, whose plan may cap eth_getLogs at 10
// blocks (the VPS's, seen 25 Oct 2026), and never finish.

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAddress, type Address } from "viem";
import { STEAKHOUSE_USDG, USDG, deployBreaker, usdgAbi, type Deployment } from "@ostraagent/sdk";
import { OUT_DIR, deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { splitLogsClient } from "../../core/test/split-logs.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let logsServer: Server | undefined;
let logsUrl: string;

/** A JSON-RPC endpoint over `split` (single and batch requests); an error goes back as a JSON-RPC error, so the caller's chunked log search narrows its span. */
async function serveLogs(split: ReturnType<typeof splitLogsClient>): Promise<{ server: Server; url: string }> {
  type Req = { id?: unknown; method: string; params?: unknown[] };
  const one = async (m: Req) => {
    try {
      return { jsonrpc: "2.0", id: m.id ?? null, result: await split.request({ method: m.method, params: m.params } as never) };
    } catch (e) {
      return { jsonrpc: "2.0", id: m.id ?? null, error: { code: typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : -32603, message: (e as Error).message.split("\n")[0] } };
    }
  };
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      void (async () => {
        let out: unknown;
        try {
          const parsed = JSON.parse(body) as Req | Req[];
          out = Array.isArray(parsed) ? await Promise.all(parsed.map(one)) : await one(parsed);
        } catch (e) {
          out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: (e as Error).message } };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-mcp-"));
  fork = await startFork();
  const served = await serveLogs(splitLogsClient(fork.url, await fork.client.getBlockNumber({ cacheTime: 0 })));
  logsServer = served.server;
  logsUrl = served.url;
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  // With OstraBreaker (vault version 3): vault_lock sets it up before the USDG vault's lock.
  d = await deployBreaker({ publicClient: fork.client, walletClient: fork.wallet(fork.accounts[0]!), outDir: OUT_DIR }, d);
  await writeFile(join(root, "deployment.json"), JSON.stringify(d));
});

after(async () => {
  logsServer?.closeAllConnections();
  await new Promise<void>((resolve) => (logsServer === undefined ? resolve() : logsServer.close(() => resolve())));
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function connect(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    // OSTRA_MCP_ENTRY runs the npm package instead: dist/ostra-mcp.js of the tarball (scripts/pack.ts)
    // installed with npm, so that its dependencies resolve. The services are off either way.
    args: [process.env.OSTRA_MCP_ENTRY ?? fileURLToPath(new URL("../src/server.ts", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      OSTRA_HOME: home,
      OSTRA_DEPLOYMENT: join(root, "deployment.json"),
      OSTRA_RPC_URL: fork.url,
      OSTRA_RELAYER_URL: "off",
      OSTRA_KEEPER_URL: "off",
      OSTRA_AGGREGATOR_URL: "off",
      // The planner's event searches: the chain's history from the public RPC, the fork's blocks from the fork.
      OSTRA_LOGS_RPC_URL: logsUrl,
      OSTRA_ETH_RPC_URL: "off",
      OSTRA_RAETO_URL: "off",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "ostra-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type Answer = { ok: boolean; text: string; json: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown> = {}, timeout?: number): Promise<Answer> {
  const r = (await client.callTool({ name, arguments: args }, undefined, timeout === undefined ? undefined : { timeout })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]?.text ?? "";
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { ok: r.isError !== true, text, json };
}

const usdg = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] });

test("the MCP server's tools over stdio: vault, withdrawal, launch with a dev buy, buy, sell, refusals", { timeout: 900_000 }, async () => {
  const home = join(root, "home");
  const client = await connect(home);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["open_vault", "balance", "withdraw", "pay", "open_channel", "close_channel", "private_shield", "private_unshield", "private_withdraw", "auto_shield", "set_guardian", "launch", "buy", "sell", "quote_swap", "pool_info", "airdrop_start", "vesting_release", "claim_referral", "tokens", "token_info", "profile", "set_profile", "register_agent", "set_agent_uri", "set_token_metadata", "upload_image", "publish_profile", "publish_token_metadata", "pairs", "fund_creator_vault", "creator_withdraw"]) {
      assert.ok(tools.includes(name), `tool ${name}`);
    }
    for (const name of ["shield", "unshield", "shield_status"]) assert.ok(!tools.includes(name), `no tool ${name}`);
    assert.equal(((await stat(home)).mode & 0o777).toString(8), "700");
    assert.equal(((await stat(join(home, "master.key"))).mode & 0o777).toString(8), "600");

    const before = await call(client, "balance");
    assert.ok(before.ok, before.text);
    const vaultStatus = before.json.vault as { vault: Address; vaultExists: boolean; feePayer: Address };
    assert.equal(vaultStatus.vaultExists, false);
    await fork.setBalance(vaultStatus.feePayer, 10n ** 18n);
    const opened = await call(client, "open_vault");
    assert.ok(opened.ok && opened.json.created === true, opened.text);
    const vault = getAddress(opened.json.vault as string);
    await fork.dealUsdg(vault, 300_000_000n);

    const bad = await call(client, "withdraw", { destination: "0x1234", amount: "1" });
    assert.equal(bad.ok, false);
    const tooMuch = await call(client, "withdraw", { destination: fork.accounts[3]!.address, amount: "1000" });
    assert.ok(!tooMuch.ok && /less than 1000/.test(tooMuch.text), tooMuch.text);
    const w = await call(client, "withdraw", { destination: fork.accounts[3]!.address, amount: "1.5" });
    assert.ok(w.ok && w.json.status === "sent", w.text);

    const funded = await call(client, "fund_creator_vault", { amount: "120" });
    assert.ok(funded.ok, funded.text);
    const refused = await call(client, "launch", { name: "Too Big", symbol: "BIG", marketCap: "1000", devBuy: { amount: "100" } });
    assert.ok(!refused.ok && /^refused_before_signing launch_fails/.test(refused.text), refused.text);
    const launched = await call(client, "launch", { name: "Ostra MCP Launch", symbol: "OMCP", marketCap: "30000", devBuy: { amount: "20", cliffDays: 7, vestingDays: 14 }, options: { sellTaxBps: 200, taxDuration: 3600, creatorBucketBps: 10000 } });
    assert.ok(launched.ok && launched.json.status === "launched", launched.text);
    const token = launched.json.token as Address;
    const info = await call(client, "pool_info", { token });
    assert.ok(info.ok && info.json.symbol === "OMCP" && info.json.sellTaxBps === 200, info.text);

    const quote = await call(client, "quote_swap", { side: "buy", token, amount: "5" });
    assert.ok(quote.ok && Number(quote.json.expectedOut) > 0, quote.text);
    const bought = await call(client, "buy", { token, amount: "5" });
    assert.ok(bought.ok && bought.json.swapped === true, bought.text);
    const tv = await call(client, "token_vault", { token });
    assert.ok(tv.ok && tv.json.exists === true && Number(tv.json.balance) > 0, tv.text);
    const before2 = await usdg(vault);
    const sold = await call(client, "sell", { token, amount: tv.json.balance as string });
    assert.ok(sold.ok && sold.json.swapped === true, sold.text);
    assert.ok((await usdg(vault)) > before2);
    const empty = await call(client, "token_vault", { token });
    assert.equal(empty.json.balance, "0");
    const unknown = await call(client, "set_pool_setting", { token, setting: "sell_tax", value: "500" });
    assert.ok(!unknown.ok && /refused_before_signing spend_fails/.test(unknown.text), unknown.text);
    const lowered = await call(client, "set_pool_setting", { token, setting: "sell_tax", value: "100" });
    assert.ok(lowered.ok && lowered.json.status === "sent", lowered.text);
    const launches = JSON.parse((await call(client, "launches")).text) as unknown[];
    assert.equal(launches.length, 1);

    // Every Ostra launch, for any buyer: the one launch, newest first, and its page.
    const listed = await call(client, "tokens", { limit: 5 });
    assert.ok(listed.ok && listed.json.total === 1, listed.text);
    const first = (listed.json.tokens as { token: string; symbol: string; metadataUri: string | null }[])[0];
    assert.equal(getAddress(first?.token ?? "0x"), getAddress(token));
    assert.equal(first?.symbol, "OMCP");
    assert.equal(first?.metadataUri, null);

    // The creator vault's identity: profile, ERC-8004 registration, then the token's metadata.
    const badUri = await call(client, "set_profile", { uri: "not a uri" });
    assert.equal(badUri.ok, false);
    const profiled = await call(client, "set_profile", { uri: "ipfs://bafkreiprofileone" });
    assert.ok(profiled.ok && profiled.json.status === "sent", profiled.text);
    const registered = await call(client, "register_agent", { uri: "ipfs://bafkreiagentone" });
    assert.ok(registered.ok && registered.json.status === "sent" && typeof registered.json.agentId === "string", registered.text);
    const twice = await call(client, "register_agent", { uri: "ipfs://bafkreiagenttwo" });
    assert.ok(!twice.ok && /registered already/.test(twice.text), twice.text);
    const moved = await call(client, "set_agent_uri", { uri: "ipfs://bafkreiagenttwo" });
    assert.ok(moved.ok && moved.json.status === "sent", moved.text);
    const me = await call(client, "profile");
    assert.ok(me.ok && me.json.profileUri === "ipfs://bafkreiprofileone" && me.json.agentId === registered.json.agentId, me.text);
    // Publishing goes through the relayer's uploader: without a relayer it is refused before anything is signed.
    const unpublished = await call(client, "publish_profile", { name: "Ostra MCP Agent" });
    assert.ok(!unpublished.ok && /OSTRA_RELAYER_URL/.test(unpublished.text), unpublished.text);
    const meta = await call(client, "set_token_metadata", { token, uri: "ipfs://bafkreitokenone" });
    assert.ok(meta.ok && meta.json.status === "sent", meta.text);
    const page = await call(client, "token_info", { token });
    const pageJson = page.json as { metadata: { uri: string }; creator: { vault: string; profileUri: string } };
    assert.ok(page.ok && pageJson.metadata.uri === "ipfs://bafkreitokenone" && pageJson.creator.profileUri === "ipfs://bafkreiprofileone", page.text);
    assert.equal(getAddress(pageJson.creator.vault), getAddress(launched.json.creatorVault as string));

    // The pairs: USDG, ETH, OSTRA and the 32 stock tokens, each priced; a launch paired with NVDA, without a dev buy.
    // On a fresh fork the first read of each stock token and feed fetches its code and storage from the forked RPC:
    // that first call took 63.5 s (19 Oct 2026; the same call again 0.65 s, and on mainnet 0.4 s through an archive
    // RPC, 6.6 s through the public RPC), over the client's default 60 s, so it gets 5 minutes.
    const pairs = await call(client, "pairs", {}, 300_000);
    const pairRows = JSON.parse(pairs.text) as { symbol: string; kind: string; creatorVault: string; priceUsd: string | null }[];
    assert.ok(
      pairs.ok && pairRows.length === 35 && pairRows[0]?.symbol === "USDG" && pairRows[1]?.symbol === "ETH" && pairRows[2]?.symbol === "OSTRA" && pairRows[2]?.kind === "ostra" && pairRows.filter((r) => r.kind === "stock").length === 32,
      pairs.text,
    );
    assert.ok(pairRows.every((r) => r.priceUsd !== null && Number(r.priceUsd) > 0), pairs.text);
    const nvda = pairRows.find((r) => r.symbol === "NVDA");
    assert.ok(nvda !== undefined, pairs.text);
    const notOffered = await call(client, "launch", { name: "Not Offered", symbol: "NOPE", pair: "DOGE", marketCap: "20000" });
    assert.equal(notOffered.ok, false);
    const stockLaunch = await call(client, "launch", { name: "Ostra MCP Stock", symbol: "OMST", pair: "NVDA", marketCap: "20000" });
    assert.ok(stockLaunch.ok && stockLaunch.json.status === "launched" && stockLaunch.json.pair === "NVDA" && stockLaunch.json.marketCapUsd === "20000" && Number(stockLaunch.json.marketCapInPair) > 0, stockLaunch.text);
    assert.equal(getAddress(stockLaunch.json.creatorVault as string), getAddress(nvda.creatorVault));
    const stockInfo = await call(client, "pool_info", { token: stockLaunch.json.token as string });
    assert.ok(stockInfo.ok && stockInfo.json.symbol === "OMST", stockInfo.text);
    const noNvda = await call(client, "buy", { token: stockLaunch.json.token as string, amount: "0.01" });
    assert.ok(!noNvda.ok && /vault in NVDA holds 0, less than 0.01/.test(noNvda.text), noNvda.text);
    // NVDA paid into the USDG vault would stay there for good: refused before anything is signed.
    const stranded = await call(client, "claim_referral", { pair: "NVDA", referrer: vault });
    assert.ok(!stranded.ok && /stuck there for good/.test(stranded.text), stranded.text);
    const launches2 = JSON.parse((await call(client, "launches")).text) as unknown[];
    assert.equal(launches2.length, 2);
  } finally {
    await client.close();
  }

  // The same OSTRA_HOME again: the same vault, found, not created.
  const again = await connect(home);
  try {
    const opened = await call(again, "open_vault");
    assert.ok(opened.ok && opened.json.created === false, opened.text);
  } finally {
    await again.close();
  }
});

test("the MCP server's Borro and withdrawal lock tools: markets, a USDG loan to Borro and back, the lock on, an EIP-1271 approval", { timeout: 900_000 }, async () => {
  const home = join(root, "home-borro");
  const client = await connect(home);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["borro_markets", "borro_position", "borro_lend", "borro_withdraw", "borro_collateral", "borro_borrow", "borro_repay", "vault_lock", "vault_link", "vault_approve_hash", "guard_vault", "strategy_plan", "strategy_apply", "strategy_check", "strategy_report", "trading", "breaker", "raeto"]) {
      assert.ok(tools.includes(name), `tool ${name}`);
    }
    const status = (await call(client, "balance")).json.vault as { feePayer: Address };
    await fork.setBalance(status.feePayer, 10n ** 18n);
    const opened = await call(client, "open_vault");
    assert.ok(opened.ok, opened.text);
    const vault = getAddress(opened.json.vault as string);
    await fork.dealUsdg(vault, 50_000_000n);

    const markets = await call(client, "borro_markets");
    assert.ok(markets.ok && markets.text.includes('"symbol": "NVDA"'), markets.text);
    const lent = await call(client, "borro_lend", { asset: "USDG", amount: "20" });
    assert.ok(lent.ok && lent.json.status === "sent", lent.text);
    const position = await call(client, "borro_position");
    assert.ok(position.ok && Number((position.json.usdgLent as { value: string }).value) >= 19.99, position.text);
    const back = await call(client, "borro_withdraw", { asset: "USDG", shares: "all" });
    assert.ok(back.ok && back.json.status === "sent", back.text);
    const nothing = await call(client, "borro_repay", { stock: "NVDA", amount: "all" });
    assert.ok(!nothing.ok && /no NVDA vault yet|owes nothing/.test(nothing.text), nothing.text);

    const off = await call(client, "vault_lock", { action: "status" });
    assert.ok(off.ok && off.json.lockedSince === "0", off.text);
    const missing = await call(client, "vault_lock", { action: "set" });
    assert.ok(!missing.ok && /takes withdrawal, delaySeconds and dailyLimit/.test(missing.text), missing.text);
    const withdrawal = fork.accounts[3]!.address;
    // Strategies: the check runs for anyone (exits are never gated), a plan only for an agent registered in ERC-8004.
    const checked = await call(client, "strategy_check", { execute: true }, 600_000);
    assert.ok(checked.ok && Array.isArray(checked.json.findings), checked.text);
    const refused = await call(client, "strategy_plan", {}, 600_000);
    assert.ok(!refused.ok && /register_agent/.test(refused.text), refused.text);
    // The trading capital: set only for a registered agent; none set yet.
    const noCapital = await call(client, "trading", { action: "set", capital: "10" }, 600_000);
    assert.ok(!noCapital.ok && /register_agent/.test(noCapital.text), noCapital.text);
    const noStatus = await call(client, "trading", { action: "status" });
    assert.ok(!noStatus.ok && /no trading capital is set/.test(noStatus.text), noStatus.text);
    const raeto = await call(client, "raeto", { action: "models" });
    assert.ok(!raeto.ok && /OSTRA_RAETO_URL=off/.test(raeto.text), raeto.text);
    const unarmed = await call(client, "breaker", { action: "status" });
    assert.ok(unarmed.ok && unarmed.json.guardian === false && unarmed.json.locked === false, unarmed.text);
    // A lock setLock would refuse (the withdrawal address is the agent's own vault) is refused before the breaker is set
    // up: nothing is spent.
    const own = await call(client, "vault_lock", { action: "set", withdrawal: vault, delaySeconds: 129_600, dailyLimit: "5" });
    assert.ok(!own.ok && /one of this agent's own vaults/.test(own.text), own.text);
    const stillUnarmed = await call(client, "breaker", { action: "status" });
    assert.ok(stillUnarmed.ok && stillUnarmed.json.guardian === false && stillUnarmed.json.locked === false, stillUnarmed.text);
    // The lock on: OstraBreaker is set up first (guardian, the approval of its limits, the limits sent), then the lock.
    const on = await call(client, "vault_lock", { action: "set", withdrawal, delaySeconds: 129_600, dailyLimit: "5" }, 600_000);
    const onLock = on.json.lock as { status?: string } | undefined;
    const onSteps = (on.json.breaker as { steps?: { step: string; done: string }[] } | undefined)?.steps?.map((x) => `${x.step}:${x.done}`);
    assert.ok(on.ok && onLock?.status === "sent", on.text);
    assert.deepEqual(onSteps, ["guardian:now", "approve:now", "configure:now"], on.text);
    const armed = await call(client, "breaker", { action: "status" });
    const watches = armed.json.watches as { target: string; watched: boolean }[];
    assert.ok(armed.ok && armed.json.guardian === true && armed.json.locked === true && watches.length === 1 && watches[0]!.watched && getAddress(watches[0]!.target) === STEAKHOUSE_USDG, armed.text);
    const again = await call(client, "breaker", { action: "arm" });
    assert.ok(!again.ok && /withdrawal lock is on/.test(again.text), again.text);
    const locked = await call(client, "vault_lock", { action: "status" });
    assert.ok(locked.ok && getAddress((locked.json.lock as { withdrawal: string }).withdrawal) === getAddress(withdrawal), locked.text);
    const over = await call(client, "withdraw", { destination: fork.accounts[2]!.address, amount: "10" });
    assert.ok(!over.ok && /nothing was signed/.test(over.text), over.text);
    const approved = await call(client, "vault_approve_hash", { hash: `0x${"ab".repeat(32)}`, approved: true });
    assert.ok(approved.ok && approved.json.status === "sent", approved.text);
  } finally {
    await client.close();
  }
});
