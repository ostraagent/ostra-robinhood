// The indexer on a fork of Robinhood Chain mainnet (Ostra's contracts deployed
// on it): two launches from one creator vault, one with a dev buy and token
// metadata in OstraRegistry; a buy from the agent's buyer vault and a buy and a
// sell from a plain wallet through the Universal Router. The indexer finds the
// launches, the metadata and every trade with its side and trader, serves them
// over HTTP, and resumes from its state file without counting a trade twice.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { keccak256, stringToHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, USDG, retryingHttp, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import {
  Keys,
  LaunchpadService,
  LocalSender,
  VaultService,
  WALLET_SWAP_DEADLINE_SECONDS,
  X402_NETWORK,
  permitSingleTypedData,
  quoteWalletSwap,
  simulateWalletSwap,
  walletSwapCall,
  walletSwapGasLimit,
  walletSwapNeeds,
  type Config,
  type WalletSwapQuote,
} from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";
import { createIndexerServer } from "../src/http.ts";
import { Indexer, type Trade } from "../src/indexer.ts";
import { ImageStore, IpfsReader, rawCidOf } from "../src/ipfs.ts";

let fork: Fork;
let d: Deployment;
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ostra-indexer-"));
  fork = await startFork();
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
});

after(async () => {
  await fork?.stop();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

const METADATA_URI = "ipfs://bafkreih5aznjvttude6c3wbvqeebb6rlx5wkbzyppv7garjiubll2ceym4";
/** A 1x1 PNG (fixture), served by a local gateway under its raw CID: the image the metadata names. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
const PNG_CID = rawCidOf(PNG);
const METADATA = { name: "Indexed", description: "A token the indexer test launched.", image: `ipfs://${PNG_CID}`, website: "https://example.org", x: "https://x.com/example" };

async function send(account: PrivateKeyAccount, call: { to: Address; data: Hex; value?: bigint }) {
  // The gas limit the web app sends with (walletSwapGasLimit): the bare estimate ran out of gas in a swap's inner call.
  const estimate = await fork.client.estimateGas({ account, to: call.to, data: call.data, value: call.value ?? 0n });
  const hash = await fork.wallet(account).sendTransaction({ account, chain: fork.client.chain, to: call.to, data: call.data, value: call.value ?? 0n, gas: walletSwapGasLimit(estimate) });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const tx = await fork.client.getTransaction({ hash });
    console.error("REVERTED gas limit", tx.gas, "used", receipt.gasUsed);
    const { execFileSync } = await import("node:child_process");
    try {
      console.error(execFileSync("cast", ["run", hash, "--rpc-url", fork.url], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).slice(-8000));
    } catch (e) {
      console.error("TRACE", (e as { stdout?: string }).stdout?.slice(-8000), (e as { stderr?: string }).stderr?.slice(-2000));
    }
  }
  assert.equal(receipt.status, "success");
}

async function walletSwap(trader: PrivateKeyAccount, q: WalletSwapQuote): Promise<void> {
  const client = fork.client as PublicClient;
  const now = (await fork.client.getBlock({ blockTag: "latest" })).timestamp;
  const needs = await walletSwapNeeds(client as never, q, trader.address, now);
  if (needs.approve !== null) await send(trader, needs.approve);
  const permit = needs.permit === null ? undefined : { permit: needs.permit, signature: await trader.signTypedData(permitSingleTypedData(d.chainId, needs.permit)) };
  const call = walletSwapCall(q, { deadline: now + BigInt(WALLET_SWAP_DEADLINE_SECONDS), ...(permit === undefined ? {} : { permit }) });
  await simulateWalletSwap(client as never, trader.address, call);
  await send(trader, call);
}

test("the indexer: launches, metadata, trades with side and trader, candles, the HTTP API, a restart from its state", { timeout: 900_000 }, async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const lpd = d.launchpad;
  if (lpd === undefined) throw new Error("no launchpad");
  const config: Config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/INDEXER-FORK/fee-payer")));
  await fork.setBalance(feePayer.address, 10n ** 18n);
  const keys = new Keys({ master: new Uint8Array(32).fill(44), feePayer, store: new FileWotsStore(join(dir, "wots")), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const local = new LocalSender(client as never, transport as never, feePayer);
  const buyer = new VaultService(client as never, transport as never, config, keys, local, "buyer");
  const creator = new VaultService(client as never, transport as never, config, creatorKeys, local, "creator");
  const lp = new LaunchpadService({ client: client as never, transport: transport as never, config, keys, buyer, buyerSender: local, creator, creatorSender: local });
  const opened = await buyer.open();
  await fork.dealUsdg(opened.vault, 200_000_000n);
  await lp.fundCreatorVault("60");
  const creatorVault = await creator.vaultAddress();

  const first = await lp.launch({ name: "Indexed", symbol: "IDX", marketCap: "50000", devBuy: { amount: "20", cliffDays: 7, vestingDays: 30 } });
  const second = await lp.launch({ name: "Second Index", symbol: "IDX2", marketCap: "20000" });
  assert.ok(first.status === "launched" && second.status === "launched");
  if (first.status !== "launched" || second.status !== "launched") return;
  const metadata = await lp.setTokenMetadata({ token: first.token, uri: METADATA_URI });
  assert.equal(metadata.status, "sent");
  const vaultBuy = await lp.buy({ token: first.token, amount: "10" });
  assert.ok(vaultBuy.status === "sent" && vaultBuy.swapped);

  const trader = privateKeyToAccount(keccak256(stringToHex("OSTRA/INDEXER-FORK/trader")));
  await fork.setBalance(trader.address, 10n ** 18n);
  await fork.dealUsdg(trader.address, 50_000_000n);
  await walletSwap(trader, await quoteWalletSwap(client as never, lpd, { account: trader.address, token: first.token, side: "buy", amountIn: 5_000_000n }));
  const held = (await fork.client.readContract({ address: first.token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [trader.address] })) as bigint;
  await walletSwap(trader, await quoteWalletSwap(client as never, lpd, { account: trader.address, token: first.token, side: "sell", amountIn: held / 3n }));

  const recordPath = join(dir, "deployment.json");
  await writeFile(recordPath, JSON.stringify(d));
  const statePath = join(dir, "state.json");
  const logs: string[] = [];
  const readFiles: string[] = [];
  // A local gateway serving the PNG by its CID, as Pinata's serves /ipfs/<cid>.
  const gatewayServer = createServer((req, res) => {
    if (req.url === `/ipfs/${PNG_CID}`) {
      res.writeHead(200, { "content-type": "image/png" });
      return void res.end(PNG);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => gatewayServer.listen(0, "127.0.0.1", r));
  const images = new ImageStore(join(dir, "images"), new IpfsReader({ gateways: [`http://127.0.0.1:${(gatewayServer.address() as { port: number }).port}/ipfs/`] }));
  const make = () =>
    new Indexer({
      client,
      deployment: () => d,
      statePath,
      log: (event) => logs.push(event),
      readFile: async (uri) => {
        if (uri !== null) readFiles.push(uri);
        return uri === METADATA_URI ? METADATA : null;
      },
      images,
    });
  const indexer = make();
  assert.equal(await indexer.sync(), true);
  assert.equal(indexer.scannedTo, indexer.latest);
  // Metadata files are read in the background: a slow gateway never holds a scan.
  await indexer.settled();

  const list = indexer.tokens({ sort: "new", q: null, offset: 0, limit: 10 });
  assert.equal(list.total, 2);
  assert.deepEqual(list.tokens.map((t) => t.symbol), ["IDX2", "IDX"]);
  const idx = indexer.token(first.token);
  assert.ok(idx !== null);
  assert.equal(idx.creatorVault, creatorVault);
  assert.equal(idx.quote.address, USDG);
  assert.equal(idx.quote.usd, 1);
  assert.equal(idx.image, METADATA.image);
  assert.equal(idx.description, METADATA.description);
  assert.deepEqual(idx.links, { website: METADATA.website, x: METADATA.x, telegram: null });
  assert.ok(idx.price !== null && idx.price > 0);
  assert.ok(idx.marketCapUsd !== null && idx.marketCapUsd > 40_000, String(idx.marketCapUsd));
  assert.equal(idx.trades24h, 4);
  assert.ok(idx.volume24h > 25 && idx.volume24h < 45, String(idx.volume24h));
  assert.deepEqual(readFiles, [METADATA_URI]);
  assert.deepEqual(indexer.tokens({ sort: "new", q: "idx2", offset: 0, limit: 10 }).tokens.map((t) => t.symbol), ["IDX2"]);
  assert.equal(indexer.tokens({ sort: "marketcap", q: null, offset: 0, limit: 10 }).tokens[0]?.symbol, "IDX");

  // Newest first: the wallet's sell and buy (through the router: the wallet), the vault's buy, the dev buy.
  const trades = indexer.trades(first.token, { limit: 10, before: null }) as Trade[];
  assert.deepEqual(trades.map((t) => [t.side, t.via, t.trader]), [
    ["sell", "router", trader.address],
    ["buy", "router", trader.address],
    ["buy", "contract", opened.vault],
    ["buy", "dev_buy", creatorVault],
  ]);
  // The pool's side of the wallet's 5 USDG buy: the hook's 1% fee is taken before the swap.
  assert.equal(trades[1]?.quoteAmount, "4950000");
  assert.ok((trades[0]?.price ?? 0) < (trades[1]?.price ?? 0), "a sell lowers the price");
  const page = indexer.trades(first.token, { limit: 2, before: { block: BigInt(trades[1]?.block ?? "0"), logIndex: trades[1]?.logIndex ?? 0 } }) as Trade[];
  assert.deepEqual(page.map((t) => t.via), ["contract", "dev_buy"]);
  const candles = indexer.candles(first.token, 86_400) ?? [];
  assert.equal(candles.length, 1);
  assert.ok(Math.abs((candles[0]?.v ?? 0) - idx.volume24h) < 1e-9);
  assert.deepEqual(indexer.agent(creatorVault).tokens.map((t) => t.symbol), ["IDX2", "IDX"]);
  assert.equal(indexer.trades(zeroAddress, { limit: 5, before: null }), null);

  // The HTTP API.
  const server = createIndexerServer(indexer, () => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    const tokens = await get("/api/v1/tokens?sort=volume&limit=1");
    assert.equal(tokens.status, 200);
    assert.equal((tokens.body.tokens as { symbol: string }[])[0]?.symbol, "IDX");
    assert.equal((await get(`/api/v1/tokens/${first.token}`)).body.symbol, "IDX");
    assert.equal(((await get(`/api/v1/tokens/${first.token}/trades?limit=1`)).body.trades as unknown[]).length, 1);
    assert.equal((await get(`/api/v1/tokens/${first.token}/candles?interval=3600`)).status, 200);
    assert.equal((await get(`/api/v1/agents/${creatorVault}`)).status, 200);
    const health = (await get("/api/v1/health")).body;
    assert.equal(health.tokens, 2);
    assert.equal(health.trades24h, 4);
    assert.ok(Math.abs((health.volume24hUsd as number) - idx.volume24h) < 1e-9);
    assert.equal((await get(`/api/v1/tokens/${first.token}/candles?interval=61`)).status, 400);
    assert.equal((await get("/api/v1/tokens?sort=price")).status, 400);
    assert.equal((await get("/api/v1/tokens?limit=500")).status, 400);
    assert.equal((await get("/api/v1/tokens/0x123")).status, 400);
    assert.equal((await get(`/api/v1/tokens/${zeroAddress}`)).status, 404);
    assert.equal((await get("/api/v2/tokens")).status, 404);
    // The image the metadata names, kept and served from this host; no other CID.
    const img = await fetch(`http://127.0.0.1:${port}/api/v1/images/${PNG_CID}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.equal(img.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await img.arrayBuffer()), PNG);
    assert.equal((await get(`/api/v1/images/${rawCidOf(new Uint8Array([1]))}`)).status, 404);
    assert.equal((await get("/api/v1/images/..%2Fstate.json")).status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  // A restart from the state file: nothing scanned twice, a later trade found.
  const again = make();
  assert.equal(again.scannedTo, indexer.scannedTo);
  // A minute later, so the second token's trade is the latest by time as well as by block.
  await fork.increaseTime(60);
  await walletSwap(trader, await quoteWalletSwap(client as never, lpd, { account: trader.address, token: second.token, side: "buy", amountIn: 1_000_000n }));
  await again.sync();
  assert.equal((again.trades(first.token, { limit: 50, before: null }) ?? []).length, 4);
  assert.deepEqual((again.trades(second.token, { limit: 50, before: null }) ?? []).map((t) => [t.side, t.trader]), [["buy", trader.address]]);
  assert.equal(again.tokens({ sort: "active", q: null, offset: 0, limit: 10 }).tokens[0]?.symbol, "IDX2");
  assert.ok(!logs.includes("sync_failed"));
  assert.ok(logs.includes("image_kept"));
  await new Promise<void>((r) => gatewayServer.close(() => r()));
});
