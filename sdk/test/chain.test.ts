// retryingHttp against a local JSON-RPC server: an idempotent read answered -32000 "unsupported block number" (a node
// behind the one that gave the block number, as an agent's Alchemy RPC answered on 29 Oct 2026) is asked again, as a
// read answered -32602 is; -32000 with another message is not, nor is a transaction. With a retry count (the relayer,
// 29 Oct 2026), transient failures are retried that many times and each retry is reported.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { createPublicClient, parseAbi, type PublicClient } from "viem";
import { robinhoodChain, retryingHttp, type RpcRetry } from "../src/chain.ts";
import { USDG } from "../src/constants.ts";

/** Answers the first `fail` requests of `method` with `error`, then eth_call with uint8 6; counts the requests of `method`. */
async function rpc(method: string, fail: number, error: { code: number; message: string }): Promise<{ url: string; seen: () => number; close: () => Promise<void> }> {
  let seen = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
    res.writeHead(200, { "content-type": "application/json" });
    if (body.method === method) {
      seen++;
      if (seen <= fail) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error }));
        return;
      }
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${"6".padStart(64, "0")}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen: () => seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const decimals = (url: string) =>
  (createPublicClient({ chain: robinhoodChain, transport: retryingHttp(url) }) as PublicClient).readContract({ address: USDG, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });

test("retryingHttp asks a read answered -32000 unsupported block number again, and nothing else answered -32000", { timeout: 60_000 }, async () => {
  // Two answers of -32000 "unsupported block number", then the read: it succeeds after waiting 1 and 2 s.
  let p = await rpc("eth_call", 2, { code: -32000, message: "unsupported block number" });
  const t0 = Date.now();
  assert.equal(await decimals(p.url), 6);
  assert.ok(Date.now() - t0 >= 3_000, `waited ${Date.now() - t0} ms`);
  assert.equal(p.seen(), 3);
  await p.close();
  // -32000 with another message (a revert, a node's other refusal) is the answer.
  p = await rpc("eth_call", 1, { code: -32000, message: "execution reverted" });
  await assert.rejects(decimals(p.url), (e: unknown) => /execution reverted/i.test(String(e)));
  assert.equal(p.seen(), 1);
  await p.close();
  // A transaction answered -32000 "unsupported block number" is not sent again.
  p = await rpc("eth_sendRawTransaction", 1, { code: -32000, message: "unsupported block number" });
  const c = createPublicClient({ chain: robinhoodChain, transport: retryingHttp(p.url) }) as PublicClient;
  await assert.rejects(c.request({ method: "eth_sendRawTransaction", params: ["0x00"] }), (e: unknown) => /unsupported block number/i.test(String(e)));
  assert.equal(p.seen(), 1);
  await p.close();
});

/** Answers the first `fail` eth_call requests with HTTP `status`, then uint8 6. */
async function httpFailing(fail: number, status: number): Promise<{ url: string; seen: () => number; close: () => Promise<void> }> {
  let seen = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
    if (body.method === "eth_call" && ++seen <= fail) {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("upstream unavailable");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${"6".padStart(64, "0")}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen: () => seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("retryingHttp with a retry count: transient failures retried that many times, 1 and 2 s apart, each one reported without the URL", { timeout: 60_000 }, async () => {
  const read = (url: string, o: Parameters<typeof retryingHttp>[1]) =>
    (createPublicClient({ chain: robinhoodChain, transport: retryingHttp(url, o) }) as PublicClient).readContract({ address: USDG, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });
  // Two 503 answers, then the read: two retries reported, after 1 and 2 s.
  let p = await httpFailing(2, 503);
  const seen: RpcRetry[] = [];
  const t0 = Date.now();
  assert.equal(await read(p.url, { retryCount: 3, onRetry: (r) => seen.push(r) }), 6);
  assert.ok(Date.now() - t0 >= 3_000, `waited ${Date.now() - t0} ms`);
  assert.equal(p.seen(), 3);
  assert.deepEqual(seen.map((r) => [r.method, r.retry, r.waitMs]), [["eth_call", 1, 1_000], ["eth_call", 2, 2_000]]);
  assert.ok(seen.every((r) => /HTTP 503/.test(r.error) && !r.error.includes(p.url)), JSON.stringify(seen));
  await p.close();
  // More failures than retries: the last failure is the answer, after retryCount retries.
  p = await httpFailing(5, 503);
  const few: RpcRetry[] = [];
  await assert.rejects(read(p.url, { retryCount: 1, onRetry: (r) => few.push(r) }));
  assert.equal(p.seen(), 2);
  assert.equal(few.length, 1);
  await p.close();
  // An answer viem does not retry (400) is not retried here either.
  p = await httpFailing(1, 400);
  await assert.rejects(read(p.url, { retryCount: 3, onRetry: () => assert.fail("400 is not retried") }));
  assert.equal(p.seen(), 1);
  await p.close();
  // An attempt over timeoutMs is a transient failure: retried.
  let slow = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
    if (body.method === "eth_call" && ++slow === 1) await new Promise((r) => setTimeout(r, 1_500));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${"6".padStart(64, "0")}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const timed: RpcRetry[] = [];
  assert.equal(await read(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { retryCount: 2, timeoutMs: 500, onRetry: (r) => timed.push(r) }), 6);
  assert.equal(timed.length, 1, JSON.stringify(timed));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
