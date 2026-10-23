// The /logs route (logs-policy.ts): its policy against the ABIs core and the swap SDK use, then over HTTP in front
// of Robinhood Chain's public RPC (mainnet, read only): the swap SDK's PoolTrees.sync and PoolIndex.v4PoolsOfPair and
// core's queries of the pool's events, through a viem client on /logs, as the web app runs them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { createPublicClient, encodeFunctionData, getAbiItem, http, numberToHex, parseAbiItem, toEventSelector, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import { ROBINHOOD_PUBLIC_RPC, USDG, robinhoodChain } from "@ostraagent/sdk";
import * as swap from "../../../ostra-swap/sdk/src/index.ts";
import { LOG_WINDOW_BLOCKS } from "../../core/src/channels.ts";
import { DEFAULT_SWAP_DEPLOYMENT, privatePoolOf } from "../src/config.ts";
import { LOGS_UPSTREAM_IN_FLIGHT, Slots, createRpcProxyServer } from "../src/http.ts";
import { INITIALIZE_EVENT, POOL_EVENTS, POOL_READS, UNISWAP_V4_POOL_MANAGER, checkLogsRequest } from "../src/logs-policy.ts";
import { RateLimiter } from "../src/policy.ts";

const { privatePool: pool, fromBlock } = privatePoolOf(DEFAULT_SWAP_DEPLOYMENT);
const policy = { privatePool: pool, fromBlock };
const topic = (e: AbiEvent) => toEventSelector(e);
const [shielded, unshielded, swapped, noteAdded] = POOL_EVENTS as [AbiEvent, AbiEvent, AbiEvent, AbiEvent];
const word: Hex = `0x${"cd".repeat(32)}`;

/** core's event declarations, read from its source (they are not exported). */
function coreEvents(): AbiEvent[] {
  const text = readFileSync(new URL("../../core/src/private-balance.ts", import.meta.url), "utf8");
  return [...text.matchAll(/parseAbiItem\(\s*"(event [^"]+)"\s*,?\s*\)/g)].map((m) => parseAbiItem(m[1] as string) as AbiEvent);
}

const body = (method: string, params?: unknown[]) => ({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
const served = (method: string, params?: unknown[]) => checkLogsRequest(body(method, params), policy).ok;
const filter = (over: Record<string, unknown> = {}) => ({ address: pool, topics: [topic(noteAdded)], fromBlock: numberToHex(fromBlock), toBlock: numberToHex(fromBlock + 100n), ...over });

test("the events and reads served are the ones core and the swap SDK ask, at the pool and PoolManager they use", () => {
  assert.equal(UNISWAP_V4_POOL_MANAGER, swap.UNISWAP_V4_POOL_MANAGER);
  assert.equal(topic(INITIALIZE_EVENT), topic(swap.initializeEvent));
  for (const name of ["Shielded", "Unshielded", "PrivateSwapped", "NoteAdded"] as const) {
    assert.ok(POOL_EVENTS.some((e) => topic(e) === topic(getAbiItem({ abi: swap.ostraPrivatePoolAbi, name }) as AbiEvent)), name);
  }
  // core declares Shielded, PrivateSwapped and Unshielded itself: the same events.
  const core = coreEvents();
  assert.deepEqual(core.map((e) => e.name).sort(), ["PrivateSwapped", "Shielded", "Unshielded"]);
  for (const e of core) assert.ok(POOL_EVENTS.some((p) => topic(p) === topic(e)), e.name);
  for (const [name, args] of [["currentTree", []], ["treeSize", [3n]], ["currentRoot", []]] as const) {
    const data = encodeFunctionData({ abi: swap.ostraPrivatePoolAbi, functionName: name, args: args as never });
    assert.equal(POOL_READS.get(data.slice(0, 10) as Hex)?.name, name);
    assert.ok(served("eth_call", [{ to: pool, data }, "latest"]), name);
    assert.ok(served("eth_call", [{ to: pool.toLowerCase(), data }, "0x5a8f1c9"]), name);
  }
});

test("/logs serves the web app's queries and nothing else", () => {
  assert.ok(served("eth_blockNumber", []));
  assert.ok(served("eth_blockNumber"));
  assert.ok(served("eth_chainId", []));
  for (const e of POOL_EVENTS) assert.ok(served("eth_getLogs", [filter({ topics: [topic(e)] })]), e.name);
  // An argument in an indexed position (core: from, nullifier) and the trailing nulls viem may send.
  assert.ok(served("eth_getLogs", [filter({ topics: [topic(shielded), word], toBlock: "latest" })]));
  assert.ok(served("eth_getLogs", [filter({ topics: [topic(unshielded), word, null, null] })]));
  assert.ok(served("eth_getLogs", [filter({ fromBlock: "0x0", toBlock: numberToHex(LOG_WINDOW_BLOCKS - 1n) })]));
  // PoolIndex: Initialize of one pair, the id position left open.
  assert.ok(served("eth_getLogs", [filter({ address: UNISWAP_V4_POOL_MANAGER, topics: [topic(INITIALIZE_EVENT), null, word, word], fromBlock: "0x0", toBlock: numberToHex(LOG_WINDOW_BLOCKS - 1n) })]));

  const refused = (method: string, params: unknown[] | undefined, code: number) => {
    const c = checkLogsRequest(body(method, params), policy);
    assert.ok(!c.ok && c.status === 403 && c.code === code, `${method} ${JSON.stringify(params)}`);
  };
  for (const method of ["eth_sendRawTransaction", "eth_getBalance", "eth_getCode", "eth_simulateV1", "eth_estimateGas", "eth_getTransactionReceipt", "eth_newFilter", "debug_traceTransaction"]) {
    refused(method, [], -32601);
  }
  const transfer = toEventSelector("event Transfer(address indexed from, address indexed to, uint256 value)");
  for (const f of [
    filter({ address: USDG }),
    filter({ address: USDG, topics: [transfer] }),
    filter({ address: [pool] }),
    filter({ address: undefined }),
    filter({ topics: [transfer] }),
    filter({ topics: [topic(INITIALIZE_EVENT)] }),
    filter({ address: UNISWAP_V4_POOL_MANAGER, topics: [topic(noteAdded)] }),
    filter({ topics: [[topic(shielded), topic(unshielded)]] }),
    filter({ topics: [topic(shielded), [word, word]] }),
    filter({ topics: [topic(shielded), "0x12"] }),
    filter({ topics: [] }),
    filter({ topics: [null] }),
    filter({ topics: [topic(swapped), null, null, null, null] }),
    filter({ topics: undefined }),
    filter({ fromBlock: "latest" }),
    filter({ fromBlock: "earliest" }),
    filter({ toBlock: "pending" }),
    filter({ toBlock: "0x010" }),
    filter({ fromBlock: "0x10", toBlock: "0x1" }),
    filter({ fromBlock: "0x0", toBlock: numberToHex(LOG_WINDOW_BLOCKS) }),
    // Up to "latest": the pool's logs only, from its first block on.
    filter({ fromBlock: "0x0", toBlock: "latest" }),
    filter({ fromBlock: numberToHex(fromBlock - 1n), toBlock: "latest" }),
    filter({ address: UNISWAP_V4_POOL_MANAGER, topics: [topic(INITIALIZE_EVENT)], fromBlock: numberToHex(fromBlock), toBlock: "latest" }),
    filter({ blockHash: word }),
    { address: pool, topics: [topic(noteAdded)] },
  ]) {
    refused("eth_getLogs", [f], -32602);
  }
  refused("eth_getLogs", [filter(), filter()], -32602);
  refused("eth_getLogs", undefined, -32602);
  const currentTree = encodeFunctionData({ abi: swap.ostraPrivatePoolAbi, functionName: "currentTree" });
  for (const params of [
    [{ to: USDG, data: currentTree }, "latest"],
    [{ to: pool, data: encodeFunctionData({ abi: swap.ostraPrivatePoolAbi, functionName: "isSpent", args: [word] }) }, "latest"],
    [{ to: pool, data: `${currentTree}00` }, "latest"],
    [{ to: pool, data: currentTree, from: USDG }, "latest"],
    [{ to: pool, data: currentTree }, "latest", {}],
    [{ to: pool, data: currentTree }],
    [{ to: pool, data: currentTree }, "pending"],
  ]) {
    refused("eth_call", params, -32602);
  }
  refused("eth_blockNumber", ["latest"], -32602);
});

async function logsProxy(upstream: string, extra: { slots?: Slots; timeoutMs?: number } = {}) {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const server: Server = createRpcProxyServer({
    rpcUrl: "http://127.0.0.1:9/",
    limiter: new RateLimiter(1, 1),
    clientIp: "socket",
    log: (event, fields = {}) => events.push({ event, fields }),
    logs: { rpcUrl: upstream, limiter: new RateLimiter(50, 50), policy, ...extra },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const at = server.address();
  if (at === null || typeof at === "string") throw new Error("no port");
  const url = `http://127.0.0.1:${at.port}/logs`;
  const client = createPublicClient({ chain: robinhoodChain, transport: http(url, { retryCount: 4, retryDelay: 1_500 }) }) as PublicClient;
  return { url, server, events, client };
}

test("over HTTP, mainnet: the swap SDK's trees and pool index and core's pool queries through /logs", { timeout: 300_000 }, async () => {
  const p = await logsProxy(ROBINHOOD_PUBLIC_RPC);
  const direct = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_PUBLIC_RPC, { retryCount: 2 }) }) as PublicClient;
  try {
    assert.equal(await p.client.getChainId(), robinhoodChain.id);
    // PoolTrees.sync: NoteAdded logs from the pool's deployment, checked against currentTree, treeSize and currentRoot.
    const trees = new swap.PoolTrees(pool, fromBlock);
    await trees.sync(p.client as never);
    const data = trees.data();
    assert.ok(BigInt(data.searchedTo) > fromBlock);
    const notes = data.trees.reduce((n, t) => n + t.leaves.length, 0);
    assert.ok(notes > 0, "the pool holds notes on mainnet");
    // The same as without the proxy.
    const again = new swap.PoolTrees(pool, fromBlock);
    await again.sync(direct as never);
    const viaProxyLeaves = data.trees.flatMap((t) => t.leaves);
    const directLeaves = again.data().trees.flatMap((t) => t.leaves);
    const n = Math.min(viaProxyLeaves.length, directLeaves.length);
    assert.deepEqual(viaProxyLeaves.slice(0, n), directLeaves.slice(0, n));
    // core's queries: one event a request over the pool's whole history, and a query by an indexed argument up to latest.
    const head = await p.client.getBlockNumber();
    const shields = await p.client.getLogs({ address: pool, event: shielded, fromBlock, toBlock: head, strict: true });
    assert.ok(shields.length > 0);
    assert.equal(shields.length, (await direct.getLogs({ address: pool, event: shielded, fromBlock, toBlock: head, strict: true })).length);
    await p.client.getLogs({ address: pool, event: unshielded, fromBlock, toBlock: head, strict: true });
    await p.client.getLogs({ address: pool, event: swapped, fromBlock, toBlock: head, strict: true });
    const from = (shields[0] as unknown as { args: { from: Address } }).args.from;
    const byFrom = await p.client.getLogs({ address: pool, event: shielded, args: { from } as never, fromBlock, toBlock: "latest" });
    assert.ok(byFrom.length >= 1);
    // PoolIndex: the pools of WETH and USDG, as the swap route searches them (from block 0, LOG_WINDOW_BLOCKS a request).
    const index = new swap.PoolIndex();
    const viaProxy = await index.v4PoolsOfPair(p.client as never, swap.WETH, USDG);
    const plain = await new swap.PoolIndex().v4PoolsOfPair(direct as never, swap.WETH, USDG);
    assert.deepEqual(viaProxy.map((x) => x.id).sort(), plain.map((x) => x.id).sort());
    // Nothing else of the chain through /logs.
    await assert.rejects(p.client.getBalance({ address: pool }));
    await assert.rejects(p.client.getLogs({ address: USDG, fromBlock: head - 10n, toBlock: head }));
    const statuses = p.events.filter((e) => e.event === "rpc").map((e) => e.fields.status);
    assert.equal(statuses.filter((s) => s === 403).length, 2);
    assert.ok(p.events.every((e) => e.fields.path === "/logs"));
  } finally {
    p.server.close();
  }
});

test("slots: at most max at once, the others wait in order, a full queue is refused", async () => {
  const slots = new Slots(2, 1);
  assert.equal(await slots.take(), true);
  assert.equal(await slots.take(), true);
  let third = false;
  const waiting = slots.take().then((ok) => (third = ok));
  assert.deepEqual(slots.size(), { held: 2, waiting: 1 });
  assert.equal(await slots.take(), false, "the queue holds one");
  slots.release();
  await waiting;
  assert.equal(third, true);
  assert.deepEqual(slots.size(), { held: 2, waiting: 0 });
  slots.release();
  slots.release();
  assert.deepEqual(slots.size(), { held: 0, waiting: 0 });
  assert.equal(LOGS_UPSTREAM_IN_FLIGHT, 8);
});

/**
 * A local upstream answering as the public RPC answered over its rate on 23 Oct 2026 (recorded: HTTP 429,
 * `access-control-allow-origin: *,*`, this body), or never answering.
 */
async function upstream(kind: "rate" | "silent") {
  const held: { end: () => void }[] = [];
  const server = createServer((req, res) => {
    req.resume();
    if (kind === "silent") return void held.push(res);
    res.writeHead(429, { "content-type": "text/plain", "access-control-allow-origin": "*,*" });
    res.end('{"jsonrpc":"2.0","error":{"code":429,"message":"Too Many Requests"}}\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const at = server.address();
  if (at === null || typeof at === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${at.port}/`, close: () => (held.forEach((r) => r.end()), server.close()) };
}

const blockNumber = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };
const postJson = (url: string, b: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

test("over HTTP: the upstream's 429 is answered as the proxy's own, without saying \"too many\"", async () => {
  const up = await upstream("rate");
  const p = await logsProxy(up.url);
  try {
    const res = await postJson(p.url, blockNumber);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "1");
    const answer = (await res.json()) as { error: { code: number; message: string } };
    assert.equal(answer.error.code, -32005);
    // core and the swap SDK split a search in halves on these words (their answer to too many logs).
    assert.doesNotMatch(answer.error.message, /exceeds limit|too many|query returned more than/i);
  } finally {
    p.server.close();
    up.close();
  }
});

test("over HTTP: an upstream that does not answer is answered 504 in time, and its slot is freed", async () => {
  const up = await upstream("silent");
  const slots = new Slots(1, 0);
  const p = await logsProxy(up.url, { slots, timeoutMs: 300 });
  try {
    const first = postJson(p.url, blockNumber);
    // The one slot is taken and nothing may wait: the second is refused at once.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await postJson(p.url, blockNumber);
    assert.equal(second.status, 429);
    assert.doesNotMatch(((await second.json()) as { error: { message: string } }).error.message, /too many/i);
    const res = await first;
    assert.equal(res.status, 504);
    assert.equal(((await res.json()) as { error: { code: number } }).error.code, -32603);
    assert.deepEqual(slots.size(), { held: 0, waiting: 0 });
  } finally {
    p.server.close();
    up.close();
  }
});
