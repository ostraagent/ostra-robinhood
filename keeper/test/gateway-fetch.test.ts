// gatewayFetch: the first gateway (Ostra's uploader) first, the others once it failed or after the hedge wait, the
// first answer the caller accepts taken, one deadline for all.

import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayFetch } from "../src/pad-evaluator.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
/** A gateway that never answers until its request is aborted. */
const hang = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

test("the first gateway answering in time: the others are not asked", async () => {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(url);
    await new Promise((r) => setTimeout(r, 20));
    return new Response(bytes("hello"));
  }) as typeof fetch;
  assert.deepEqual(await gatewayFetch(["https://a/", "https://b/"], f, 5_000, 1_000)("ipfs://cid", 100), bytes("hello"));
  assert.deepEqual(asked, ["https://a/cid"]);
});

test("the first gateway failing: the others are asked at once, the first answer taken, the pending ones cancelled", async () => {
  const aborted: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => aborted.push(url), { once: true });
    if (url.startsWith("https://a/")) return new Response("missing", { status: 404 });
    if (url.startsWith("https://b/")) return hang(init?.signal);
    await new Promise((r) => setTimeout(r, 20));
    return new Response(bytes("hello"));
  }) as typeof fetch;
  const t0 = Date.now();
  const got = await gatewayFetch(["https://a/", "https://b/", "https://c/"], f, 5_000, 2_000)("ipfs://cid", 100);
  assert.deepEqual(got, bytes("hello"));
  assert.ok(Date.now() - t0 < 1_000, "not held by the hedge wait nor by the gateway that hangs");
  assert.ok(aborted.includes("https://b/cid"), "the pending gateway is cancelled");
});

test("the first gateway hanging: the others are asked after the hedge wait", async () => {
  const f = (async (url: string, init?: RequestInit) => (url.startsWith("https://a/") ? hang(init?.signal) : new Response(bytes("late")))) as typeof fetch;
  const t0 = Date.now();
  assert.deepEqual(await gatewayFetch(["https://a/", "https://b/"], f, 5_000, 150)("ipfs://cid", 100), bytes("late"));
  const took = Date.now() - t0;
  assert.ok(took >= 120 && took < 1_000, `asked after the hedge wait (${took} ms)`);
});

test("an answer the caller does not accept (wrong bytes) is not taken; another gateway's is", async () => {
  const f = (async (url: string) => (url.startsWith("https://a/") ? new Response(bytes("wrong")) : new Response(bytes("right")))) as typeof fetch;
  const got = await gatewayFetch(["https://a/", "https://b/"], f, 5_000, 2_000)("ipfs://cid", 100, (b) => new TextDecoder().decode(b) === "right");
  assert.deepEqual(got, bytes("right"));
});

test("nothing takes longer than the deadline, and no answer is null", async () => {
  const f = (async (_url: string, init?: RequestInit) => hang(init?.signal)) as typeof fetch;
  const t0 = Date.now();
  const got = await gatewayFetch(["https://a/", "https://b/", "https://c/"], f, 200, 50)("ipfs://cid", 100);
  assert.equal(got, null);
  const took = Date.now() - t0;
  assert.ok(took >= 150 && took < 1_000, `one deadline for all gateways (${took} ms)`);
});

test("a body still streaming at the deadline is cut off", async () => {
  const f = (async (_url: string, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const t = setInterval(() => controller.enqueue(bytes("x")), 20);
        init?.signal?.addEventListener("abort", () => {
          clearInterval(t);
          controller.error(new Error("aborted"));
        });
      },
    });
    return new Response(body);
  }) as typeof fetch;
  const t0 = Date.now();
  assert.equal(await gatewayFetch(["https://a/"], f, 200, 50)("ipfs://cid", 10_000), null);
  assert.ok(Date.now() - t0 < 1_000);
});

test("an answer over the size limit is not taken; another gateway's is", async () => {
  const f = (async (url: string) => (url.startsWith("https://a/") ? new Response(bytes("x".repeat(200))) : new Response(bytes("small")))) as typeof fetch;
  assert.deepEqual(await gatewayFetch(["https://a/", "https://b/"], f, 1_000, 500)("ipfs://cid", 100), bytes("small"));
  const big = (async () => new Response(bytes("x".repeat(200)))) as typeof fetch;
  assert.equal(await gatewayFetch(["https://a/"], big, 1_000, 500)("ipfs://cid", 100), null);
});

test("https URIs are read directly; other schemes are not read", async () => {
  const seen: string[] = [];
  const f = (async (url: string) => {
    seen.push(url);
    return new Response(bytes("file"));
  }) as typeof fetch;
  assert.deepEqual(await gatewayFetch(["https://a/"], f, 1_000, 500)("https://host/file.json", 100), bytes("file"));
  assert.deepEqual(seen, ["https://host/file.json"]);
  assert.equal(await gatewayFetch(["https://a/"], f, 1_000, 500)("http://host/file.json", 100), null);
});
