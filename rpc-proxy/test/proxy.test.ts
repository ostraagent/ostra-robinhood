// The RPC proxy's policy, and its HTTP endpoint on a real server in front of
// a local fork of Robinhood Chain mainnet (sdk/test/fork.ts). Requests are
// made by viem as core and the SDK make them, so what the proxy forwards is
// answered by the fork, and what it refuses never leaves it.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAbiItem,
  http,
  RpcRequestError,
  numberToHex,
  parseEther,
  toEventSelector,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { MULTICALL3, USDG, ostraVaultAbi, robinhoodChain } from "@ostraagent/sdk";
import { startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { APP_ORIGIN } from "../../merchant/src/cors.ts";
import { MAX_BODY_BYTES, createRpcProxyServer } from "../src/http.ts";
import { CHANNEL_OPENED_TOPIC, MAX_LOG_BLOCKS, RATE_WINDOW_MS, RateLimiter, checkRequest } from "../src/policy.ts";

const someone: Address = "0x1111111111111111111111111111111111111111";
const channel: Hex = `0x${"ab".repeat(32)}`;
const channelOpened = getAbiItem({ abi: ostraVaultAbi, name: "ChannelOpened" }) as AbiEvent;

let fork: Fork;

before(async () => {
  fork = await startFork();
});

after(async () => {
  await fork.stop();
});

/** A port nothing listens on: bound, then closed. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const at = s.address();
  if (at === null || typeof at === "string") throw new Error("no port");
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return at.port;
}

async function proxy(perIp: number, total: number, upstream: string = fork.url) {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const server: Server = createRpcProxyServer({ rpcUrl: upstream, limiter: new RateLimiter(perIp, total), clientIp: "socket", log: (event, fields = {}) => events.push({ event, fields }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const at = server.address();
  if (at === null || typeof at === "string") throw new Error("no port");
  const url = `http://127.0.0.1:${at.port}/`;
  const client = createPublicClient({ chain: robinhoodChain, transport: http(url, { retryCount: 0 }) }) as PublicClient;
  return { url, server, events, upstream, client };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** The JSON-RPC error code viem got from the proxy (its refusals are JSON-RPC errors), or 0 when the call resolved. */
async function errorCode(call: () => Promise<unknown>): Promise<number> {
  try {
    await call();
    return 0;
  } catch (err) {
    let e: unknown = err;
    while (e !== undefined && e !== null) {
      if (e instanceof RpcRequestError) return e.code;
      e = (e as { cause?: unknown }).cause;
    }
    throw err;
  }
}

const logsFilter = (over: Record<string, unknown> = {}) => ({ address: someone, topics: [CHANNEL_OPENED_TOPIC, channel], fromBlock: "0x1", toBlock: "0x10", ...over });

test("the read methods are forwarded as one request each; anything else is refused", () => {
  for (const method of [
    "eth_blockNumber",
    "eth_call",
    "eth_chainId",
    "eth_estimateGas",
    "eth_gasPrice",
    "eth_getBalance",
    "eth_getBlockByNumber",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "eth_simulateV1",
  ]) {
    const c = checkRequest({ jsonrpc: "2.0", id: "1", method, params: [], extra: "dropped" });
    assert.deepEqual(c, { ok: true, request: { jsonrpc: "2.0", id: "1", method, params: [] } }, method);
  }
  assert.deepEqual(checkRequest({ jsonrpc: "2.0", id: 7, method: "eth_chainId" }), { ok: true, request: { jsonrpc: "2.0", id: 7, method: "eth_chainId" } });
  for (const method of [
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "eth_sign",
    "eth_newFilter",
    "eth_getFilterChanges",
    "eth_subscribe",
    "eth_getBlockByHash",
    "debug_traceTransaction",
    "txpool_content",
    "anvil_setBalance",
    "anvil_dealERC20",
    "evm_mine",
    "hardhat_impersonateAccount",
  ]) {
    const c = checkRequest({ jsonrpc: "2.0", id: "1", method, params: [] });
    assert.ok(!c.ok && c.status === 403 && c.code === -32601, method);
  }
  const refused = (body: unknown, code: number) => {
    const c = checkRequest(body);
    assert.ok(!c.ok && c.status === 400 && c.code === code, JSON.stringify(body));
  };
  refused([{ jsonrpc: "2.0", id: "1", method: "eth_chainId" }], -32600);
  refused(null, -32600);
  refused("eth_chainId", -32600);
  refused({ jsonrpc: "1.0", id: "1", method: "eth_chainId" }, -32600);
  refused({ jsonrpc: "2.0", id: {}, method: "eth_chainId" }, -32600);
  refused({ jsonrpc: "2.0", id: "1" }, -32600);
  refused({ jsonrpc: "2.0", id: "1", method: "eth_chainId", params: {} }, -32602);
});

test("eth_getLogs only as core's channel recovery asks it", () => {
  assert.equal(CHANNEL_OPENED_TOPIC, toEventSelector("event ChannelOpened(bytes32 indexed channelId, uint128 amount)"));
  const ok = (filter: unknown) => checkRequest({ jsonrpc: "2.0", id: "1", method: "eth_getLogs", params: [filter] }).ok;
  assert.ok(ok(logsFilter()));
  assert.ok(ok(logsFilter({ topics: [CHANNEL_OPENED_TOPIC.toUpperCase().replace("0X", "0x"), channel] })));
  assert.ok(ok(logsFilter({ fromBlock: "0x0", toBlock: numberToHex(MAX_LOG_BLOCKS - 1n) })));
  for (const filter of [
    logsFilter({ fromBlock: "0x0", toBlock: numberToHex(MAX_LOG_BLOCKS) }),
    logsFilter({ fromBlock: "0x10", toBlock: "0x1" }),
    logsFilter({ fromBlock: "latest" }),
    logsFilter({ toBlock: "0x010" }),
    logsFilter({ address: [someone] }),
    logsFilter({ address: "0x1234" }),
    logsFilter({ address: undefined }),
    logsFilter({ topics: [CHANNEL_OPENED_TOPIC] }),
    logsFilter({ topics: [CHANNEL_OPENED_TOPIC, null] }),
    logsFilter({ topics: [CHANNEL_OPENED_TOPIC, [channel]] }),
    logsFilter({ topics: [CHANNEL_OPENED_TOPIC, channel, channel] }),
    logsFilter({ topics: [toEventSelector("event Transfer(address indexed from, address indexed to, uint256 value)"), channel] }),
    logsFilter({ blockHash: channel }),
    { address: someone, topics: [CHANNEL_OPENED_TOPIC, channel] },
  ]) {
    const body = { jsonrpc: "2.0", id: "1", method: "eth_getLogs", params: [filter] };
    const c = checkRequest(body);
    assert.ok(!c.ok && c.status === 403 && c.code === -32602, JSON.stringify(filter));
  }
  for (const params of [[], [logsFilter(), logsFilter()], undefined]) {
    const c = checkRequest({ jsonrpc: "2.0", id: "1", method: "eth_getLogs", ...(params === undefined ? {} : { params }) });
    assert.ok(!c.ok && c.status === 403, JSON.stringify(params));
  }
});

test("rates count the last second, per client and in total; refused requests do not count", () => {
  assert.throws(() => new RateLimiter(0, 1), RangeError);
  assert.throws(() => new RateLimiter(3, 2), RangeError);
  const r = new RateLimiter(2, 3);
  assert.equal(r.take("a", 0), null);
  assert.equal(r.take("a", 10), null);
  assert.equal(r.take("a", 20), "client");
  assert.equal(r.take("b", 30), null);
  assert.equal(r.take("c", 40), "total");
  assert.deepEqual(r.size(), { total: 3, clients: 2 });
  // The first request of "a" leaves the window one second after it was taken.
  assert.equal(r.take("a", RATE_WINDOW_MS - 1), "total");
  assert.equal(r.take("a", RATE_WINDOW_MS), null);
  assert.equal(r.take("c", RATE_WINDOW_MS + 10), null);
  assert.equal(r.take("c", RATE_WINDOW_MS + 11), "total");
  // Clients with nothing in the window are forgotten.
  assert.equal(r.take("d", 10 * RATE_WINDOW_MS), null);
  assert.deepEqual(r.size(), { total: 1, clients: 1 });
});

test("over HTTP on the fork: viem's reads and simulations are answered by the chain, its sends are refused", async () => {
  const p = await proxy(200, 200);
  try {
    const c = p.client;
    assert.equal(await c.getChainId(), robinhoodChain.id);
    const head = await c.getBlockNumber();
    assert.ok(head > 0n);
    assert.ok((await c.getGasPrice()) > 0n);
    assert.ok((await c.readContract({ address: USDG, abi: erc20Abi, functionName: "totalSupply" })) > 0n);
    assert.equal(await c.readContract({ address: USDG, abi: erc20Abi, functionName: "decimals" }), 6);
    const [supply, decimals] = await c.multicall({
      contracts: [
        { address: USDG, abi: erc20Abi, functionName: "totalSupply" },
        { address: USDG, abi: erc20Abi, functionName: "decimals" },
      ],
      allowFailure: false,
    });
    assert.ok(supply > 0n && decimals === 6);
    assert.ok(((await c.getCode({ address: MULTICALL3 })) ?? "0x").length > 2);
    assert.match((await c.getStorageAt({ address: USDG, slot: "0x0" })) ?? "", /^0x[0-9a-f]{64}$/);
    assert.equal(await c.getBalance({ address: someone }), await fork.client.getBalance({ address: someone }));
    assert.ok((await c.getBlock({ blockTag: "latest" })).number >= head);
    // The throwaway-key quotes: eth_simulateV1 with a state override.
    const [block] = await c.simulateBlocks({
      blocks: [
        {
          stateOverrides: [{ address: someone, balance: parseEther("1") }],
          calls: [{ account: someone, to: USDG, abi: erc20Abi, functionName: "balanceOf", args: [someone] }],
        },
      ],
    });
    assert.equal(block?.calls[0]?.status, "success");
    // A real transaction on the fork, sent to the fork itself: its receipt and its transaction through the proxy.
    const [sender] = fork.accounts;
    if (sender === undefined) throw new Error("no fork account");
    assert.ok((await c.estimateGas({ account: sender.address, to: someone, value: 1n })) >= 21_000n);
    const hash = await fork.wallet(sender).sendTransaction({ account: sender, chain: robinhoodChain, to: someone, value: 1n });
    const receipt = await c.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    assert.equal(receipt.status, "success");
    assert.equal((await c.getTransaction({ hash })).to?.toLowerCase(), someone);
    // Channel recovery's logs, as core asks them (core/src/channels.ts), over the fork's own blocks: an upstream such
    // as Alchemy Free (10 blocks a request) is not asked for the logs of the blocks the fork was made from.
    const latest = await c.getBlockNumber();
    assert.deepEqual(await c.getLogs({ address: someone, event: channelOpened, args: { channelId: channel }, fromBlock: receipt.blockNumber, toBlock: latest }), []);
    // Refused here, before the fork.
    const wallet = createWalletClient({ account: sender, chain: robinhoodChain, transport: http(p.url, { retryCount: 0 }) });
    assert.equal(await errorCode(() => wallet.sendTransaction({ to: someone, value: 1n, gas: 21_000n, gasPrice: 1_000_000_000n, nonce: 1_000 })), -32601);
    assert.equal(await errorCode(() => c.getLogs({ address: someone, fromBlock: latest - 100n, toBlock: latest })), -32602);
    assert.equal(await errorCode(() => c.getLogs({ address: someone, event: channelOpened, args: { channelId: channel }, fromBlock: 0n, toBlock: MAX_LOG_BLOCKS })), -32602);
    assert.equal(await errorCode(() => c.request({ method: "anvil_setBalance" as never, params: [someone, "0x1"] as never })), -32601);
    assert.equal(await fork.client.getBalance({ address: someone }), await c.getBalance({ address: someone }));
    const logged = p.events.filter((e) => e.event === "rpc");
    assert.deepEqual(
      logged.filter((e) => e.fields.status === 403).map((e) => String(e.fields.method)),
      // viem asks the node to fill the transaction first, then signs it itself and sends it raw: both refused.
      ["eth_fillTransaction", "eth_sendRawTransaction", "eth_getLogs", "eth_getLogs", "anvil_setBalance"],
    );
    // The upstream URL is in no answer and no log line; the client is a keyed hash, not its address.
    const answer = await (await post(p.url, { jsonrpc: "2.0", id: "x", method: "eth_chainId", params: [] })).text();
    assert.ok(!answer.includes(p.upstream) && !answer.includes("127.0.0.1"));
    const lines = JSON.stringify(p.events);
    assert.ok(!lines.includes(p.upstream) && !lines.includes("127.0.0.1"));
    assert.match(String(p.events[0]?.fields.client), /^[0-9a-f]{16}$/);
  } finally {
    p.server.close();
  }
});

test("over HTTP: an upstream that cannot be reached is answered 502, without its URL", async () => {
  const p = await proxy(50, 50, `http://127.0.0.1:${await closedPort()}/`);
  try {
    const res = await post(p.url, { jsonrpc: "2.0", id: "1", method: "eth_chainId", params: [] });
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.ok(!text.includes(p.upstream));
    assert.equal(((JSON.parse(text) as { error: { code: number } }).error.code), -32603);
  } finally {
    p.server.close();
  }
});

test("over HTTP: malformed, oversized and other routes are refused with JSON-RPC errors", async () => {
  const p = await proxy(50, 50);
  try {
    const bad = await post(p.url, "{not json");
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: { code: number } }).error.code, -32700);
    const batch = await post(p.url, [{ jsonrpc: "2.0", id: "1", method: "eth_chainId" }]);
    assert.equal(batch.status, 400);
    await batch.arrayBuffer();
    const big = await post(p.url, { jsonrpc: "2.0", id: "1", method: "eth_call", params: ["x".repeat(MAX_BODY_BYTES)] });
    assert.equal(big.status, 413);
    await big.arrayBuffer();
    const other = await fetch(`${p.url}v1/rpc`, { method: "POST", body: "{}" });
    assert.equal(other.status, 404);
    await other.arrayBuffer();
    const get = await fetch(p.url);
    assert.equal(get.status, 404);
    await get.arrayBuffer();
    const refused = await post(p.url, { jsonrpc: "2.0", id: "9", method: "eth_sendRawTransaction", params: ["0x00"] });
    assert.equal(refused.status, 403);
    assert.deepEqual(((await refused.json()) as { id: unknown; error: { code: number } }).id, "9");
  } finally {
    p.server.close();
  }
});

test("over HTTP: a client over its rate gets 429 with Retry-After before anything is forwarded", async () => {
  const p = await proxy(2, 3);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await post(p.url, { jsonrpc: "2.0", id: String(i), method: "eth_chainId", params: [] });
      statuses.push(res.status);
      if (res.status === 429) assert.equal(res.headers.get("retry-after"), "1");
      await res.arrayBuffer();
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    // A refused method does not use the rate.
    const refused = await post(p.url, { jsonrpc: "2.0", id: "r", method: "eth_sendRawTransaction", params: ["0x00"] });
    assert.equal(refused.status, 403);
    await refused.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, RATE_WINDOW_MS + 50));
    const later = await post(p.url, { jsonrpc: "2.0", id: "later", method: "eth_chainId", params: [] });
    assert.equal(later.status, 200);
    assert.equal(((await later.json()) as { result: string }).result, numberToHex(robinhoodChain.id));
  } finally {
    p.server.close();
  }
});

test("over HTTP: the web app's origin gets CORS, its preflight 204", async () => {
  const p = await proxy(50, 50);
  try {
    const pre = await fetch(p.url, { method: "OPTIONS", headers: { origin: APP_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), APP_ORIGIN);
    assert.equal(pre.headers.get("access-control-allow-headers"), "Content-Type, PAYMENT-SIGNATURE");
    const res = await post(p.url, { jsonrpc: "2.0", id: "1", method: "eth_sendRawTransaction", params: ["0x00"] }, { origin: APP_ORIGIN });
    assert.equal(res.headers.get("access-control-allow-origin"), APP_ORIGIN);
    await res.arrayBuffer();
    const other = await post(p.url, { jsonrpc: "2.0", id: "1", method: "eth_chainId", params: [] }, { origin: "https://evil.example" });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    await other.arrayBuffer();
    assert.equal(p.events.filter((e) => e.event === "rpc").length, 2, "a preflight is not a request");
  } finally {
    p.server.close();
  }
});
