// The MCP server as an agent's client runs it: spawned over stdio (the stock
// MCP client), on a fork of Robinhood Chain mainnet with Ostra and the
// launchpad deployed, without a relayer (the fee payer in OSTRA_HOME pays gas;
// the relayer path runs in core/scripts/chain-check.ts). The tools are
// listed, the launchpad's closed ones absent; the vault is opened and funded;
// a withdrawal; the creator vault is funded; its profile and ERC-8004
// registration (against the live Identity Registry); Ostrapad's tools and
// their refusals (the whole Ostrapad flow runs in core's pad.fork.test.ts);
// errors for bad input. The keys stay in OSTRA_HOME (0700) and
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
import { getAddress, parseAbi, type Address } from "viem";
import { STEAKHOUSE_USDG, USDG, deployBreaker, usdgAbi, type Deployment } from "@ostraagent/sdk";
import { OUT_DIR, deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { splitLogsClient } from "../../core/test/split-logs.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let logsServer: Server | undefined;
let logsUrl: string;

const erc1271Abi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

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

// Past the MCP client's default request timeout (60 s): on a fork, the first reads of a contract fetch its state from
// the upstream RPC, and borro_markets reads the 12 Borro markets cold (23 s through the public RPC, over 60 s through
// a busy one).
const CALL_TIMEOUT_MS = 300_000;

async function call(client: Client, name: string, args: Record<string, unknown> = {}, timeout = CALL_TIMEOUT_MS): Promise<Answer> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout })) as { isError?: boolean; content: { type: string; text: string }[] };
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

test("the MCP server's tools over stdio: vault, withdrawal, the agent's identity, Ostrapad, the launchpad closed, refusals", { timeout: 900_000 }, async () => {
  const home = join(root, "home");
  const client = await connect(home);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["open_vault", "balance", "withdraw", "pay", "open_channel", "close_channel", "private_shield", "private_unshield", "private_withdraw", "auto_shield", "set_guardian", "sell", "token_vault", "transfer_token", "claim_dividends", "vesting_release", "airdrop_claim", "release_creator_payout", "profile", "upload_image", "publish_profile", "fund_creator_vault", "creator_withdraw", "pad_publish", "pad_search", "pad_order", "pad_jobs", "pad_deliver", "pad_evaluate", "pad_earnings", "tide"]) {
      assert.ok(tools.includes(name), `tool ${name}`);
    }
    // The launchpad is closed (decided 26 Oct 2026): no launching, buying or promoting a launch. Every Ostra agent's
    // profile is Ostra's own (29 Oct 2026): publish_profile is the one identity tool.
    for (const name of ["shield", "unshield", "shield_status", "launch", "buy", "quote_swap", "pool_info", "pairs", "tokens", "token_info", "launches", "airdrop_start", "airdrop_fund", "claim_referral", "set_pool_setting", "set_creator_share", "set_token_metadata", "publish_token_metadata", "set_profile", "register_agent", "set_agent_uri"]) {
      assert.ok(!tools.includes(name), `no tool ${name}`);
    }
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

    // Ostrapad before the agent has an identity: listing refused, nothing signed.
    const early = await call(client, "pad_publish", { action: "publish", offers: [{ id: "report", title: "Report", description: "A report.", input: "A topic.", price: "1", hours: 24, evaluator: "pool" }] });
    assert.ok(!early.ok && /publish_profile|creator vault/.test(early.text), early.text);

    const funded = await call(client, "fund_creator_vault", { amount: "20" });
    assert.ok(funded.ok, funded.text);
    // The creator vault's identity: publish_profile pins Ostra's profile and card through the relayer's uploader, so
    // without a relayer it is refused before anything is signed (the pad check runs it on mainnet, uploader included).
    const unpublished = await call(client, "publish_profile");
    assert.ok(!unpublished.ok && /OSTRA_RELAYER_URL/.test(unpublished.text), unpublished.text);
    const me = await call(client, "profile");
    assert.ok(me.ok && me.json.profileUri === null && me.json.agentId === null, me.text);

    // Ostrapad's tools: a listing needs the agent registered (publish_profile); reads and refusals, against agent 20025
    // (Ostra's first Ostrapad check agent, unlisted since 28 Oct 2026).
    const noProfile = await call(client, "pad_publish", { action: "publish", offers: [{ id: "report", title: "Report", description: "A report.", input: "A topic.", price: "1", hours: 24, evaluator: "pool" }] });
    assert.ok(!noProfile.ok && /publish_profile registers it/.test(noProfile.text), noProfile.text);
    const badOffer = await call(client, "pad_publish", { action: "publish", offers: [{ id: "Bad Id", title: "x", description: "x", input: "x", price: "1", hours: 24, evaluator: "pool" }] });
    assert.equal(badOffer.ok, false);
    const noListing = await call(client, "pad_search", { agentId: "20025" });
    assert.ok(noListing.ok && noListing.text === "null", noListing.text);
    const noIndex = await call(client, "pad_search", { q: "report" });
    assert.ok(!noIndex.ok && /OSTRA_PAD_INDEXER_URL/.test(noIndex.text), noIndex.text);
    const noOrder = await call(client, "pad_order", { action: "order", agentId: "20025", offer: "report", input: "x" });
    assert.ok(!noOrder.ok && /no Ostrapad listing/.test(noOrder.text), noOrder.text);
    const jobs = await call(client, "pad_jobs");
    assert.ok(jobs.ok && Array.isArray(jobs.json.jobs) && (jobs.json.jobs as unknown[]).length === 0, jobs.text);
    const earnings = await call(client, "pad_earnings");
    assert.ok(earnings.ok && (earnings.json.provider as { limit: string }).limit === "5", earnings.text);
    const pool = await call(client, "pad_evaluate", { action: "pool_status" });
    assert.ok(pool.ok && pool.json.inPool === false, pool.text);
    const noJob = await call(client, "pad_deliver", { jobId: `0x${"11".repeat(32)}`, output: "x" });
    assert.ok(!noJob.ok && /unknown/.test(noJob.text), noJob.text);
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

test("the MCP server's Borro and withdrawal lock tools: markets, a USDG loan to Borro and back, the lock on, approvals listed and withdrawn, none approved from outside", { timeout: 900_000 }, async () => {
  const home = join(root, "home-borro");
  const client = await connect(home);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["borro_markets", "borro_position", "borro_lend", "borro_withdraw", "borro_collateral", "borro_borrow", "borro_repay", "vault_lock", "vault_link", "vault_revoke_hash", "guard_vault", "strategy_plan", "strategy_apply", "strategy_check", "strategy_report", "trading", "breaker", "raeto"]) {
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
    assert.ok(!refused.ok && /publish_profile/.test(refused.text), refused.text);
    // The trading capital: set only for a registered agent; none set yet.
    const noCapital = await call(client, "trading", { action: "set", capital: "10" }, 600_000);
    assert.ok(!noCapital.ok && /publish_profile/.test(noCapital.text), noCapital.text);
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
    // No tool approves a hash it is given (USDG takes the vault's EIP-1271 answer as a permit of its funds): the old
    // approval tool is gone, and the lock's status lists the vault's approvals (none: turning the lock on ended the
    // breaker's, which its configure had used), for the agent's own vault and read as another vault.
    assert.ok(!tools.includes("vault_approve_hash"), "vault_approve_hash is gone");
    assert.ok(locked.ok && Array.isArray(locked.json.approvals) && (locked.json.approvals as unknown[]).length === 0, locked.text);
    const read = await call(client, "vault_lock", { action: "status", vault });
    assert.ok(read.ok && getAddress(read.json.vault as string) === vault && Array.isArray(read.json.approvals), read.text);
    const notStatus = await call(client, "vault_lock", { action: "cancel", vault });
    assert.ok(!notStatus.ok && /status only/.test(notStatus.text), notStatus.text);
    const revoked = await call(client, "vault_revoke_hash", { hash: `0x${"ab".repeat(32)}` });
    assert.ok(revoked.ok && revoked.json.status === "sent", revoked.text);
  } finally {
    await client.close();
  }
});

test("the MCP server lists a vault's live EIP-1271 approval and withdraws it: OstraBreaker's approval of its limits, before any lock", { timeout: 900_000 }, async () => {
  const home = join(root, "home-approvals");
  const client = await connect(home);
  const valid = async (vault: Address, hash: `0x${string}`) =>
    ((await fork.client.readContract({ address: vault, abi: erc1271Abi, functionName: "isValidSignature", args: [hash, "0x"] })) as string).toLowerCase() === "0x1626ba7e";
  try {
    const status = (await call(client, "balance")).json.vault as { feePayer: Address };
    await fork.setBalance(status.feePayer, 10n ** 18n);
    const opened = await call(client, "open_vault");
    assert.ok(opened.ok, opened.text);
    const vault = getAddress(opened.json.vault as string);
    const none = await call(client, "vault_lock", { action: "status" });
    assert.ok(none.ok && Array.isArray(none.json.approvals) && (none.json.approvals as unknown[]).length === 0, none.text);
    // The breaker set up without the lock: its configure used the vault's approval of its limits, which stays approved.
    const armed = await call(client, "breaker", { action: "arm" }, 600_000);
    assert.ok(armed.ok, armed.text);
    const listed = await call(client, "vault_lock", { action: "status" });
    const approvals = listed.json.approvals as { hash: `0x${string}`; valid: boolean }[];
    assert.ok(listed.ok && approvals.length === 1 && approvals[0]!.valid === true, listed.text);
    const hash = approvals[0]!.hash;
    assert.ok(await valid(vault, hash), "the listed hash is the one the vault approves");
    // Read as another vault (a guardian's view): the same list.
    const read = await call(client, "vault_lock", { action: "status", vault });
    assert.deepEqual((read.json.approvals as { hash: string }[]).map((x) => x.hash), [hash], read.text);
    // Withdrawn: the vault no longer approves it, and the status lists nothing.
    const revoked = await call(client, "vault_revoke_hash", { hash });
    assert.ok(revoked.ok && revoked.json.status === "sent", revoked.text);
    assert.ok(!(await valid(vault, hash)), "the hash is no longer approved");
    const after = await call(client, "vault_lock", { action: "status" });
    assert.ok(after.ok && (after.json.approvals as unknown[]).length === 0, after.text);
  } finally {
    await client.close();
  }
});
