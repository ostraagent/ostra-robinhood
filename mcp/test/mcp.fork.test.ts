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

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAddress, type Address } from "viem";
import { USDG, usdgAbi, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";

let fork: Fork;
let d: Deployment;
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-mcp-"));
  fork = await startFork();
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  await writeFile(join(root, "deployment.json"), JSON.stringify(d));
});

after(async () => {
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
    for (const name of ["open_vault", "balance", "withdraw", "pay", "open_channel", "close_channel", "shield", "unshield", "set_guardian", "launch", "buy", "sell", "quote_swap", "pool_info", "airdrop_start", "vesting_release", "claim_referral", "tokens", "token_info", "profile", "set_profile", "register_agent", "set_agent_uri", "set_token_metadata", "upload_image", "publish_profile", "publish_token_metadata", "pairs", "fund_creator_vault", "creator_withdraw"]) {
      assert.ok(tools.includes(name), `tool ${name}`);
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
