// CORS for the web app on a real node:http server, answered the ways the
// relayer, the aggregator and the AI gateway answer (writeHead with their own
// headers, a Response's headers copied, a streamed body), with the x402 v2
// HTTP transport headers.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { APP_ORIGIN, applyCors } from "../src/cors.ts";

async function serve(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    if (applyCors(req, res)) return;
    const path = new URL(req.url ?? "/", "http://test").pathname;
    if (path === "/json" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === "/challenge" && req.method === "POST") {
      // As the relayer and the AI gateway answer with a gate's Response.
      const response = new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: { "content-type": "application/json", "payment-required": "required", "payment-response": "response" },
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      res.writeHead(response.status, headers);
      void response.text().then((text) => res.end(text));
      return;
    }
    if (path === "/stream" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const at = server.address();
  if (at === null || typeof at === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${at.port}`, server };
}

test("the web app's origin may read every answer, with the payment-required and payment-response headers exposed", async () => {
  const { url, server } = await serve();
  try {
    for (const [path, method, status] of [
      ["/json", "GET", 200],
      ["/challenge", "POST", 402],
      ["/stream", "GET", 200],
      ["/missing", "GET", 404],
    ] as const) {
      const res = await fetch(`${url}${path}`, { method, headers: { origin: APP_ORIGIN, "content-type": "application/json", "payment-signature": "x" } });
      assert.equal(res.status, status, path);
      assert.equal(res.headers.get("access-control-allow-origin"), APP_ORIGIN, path);
      assert.equal(res.headers.get("access-control-expose-headers"), "PAYMENT-REQUIRED, PAYMENT-RESPONSE", path);
      assert.equal(res.headers.get("vary"), "Origin", path);
      await res.arrayBuffer();
    }
    // The server's own headers are kept.
    const json = await fetch(`${url}/json`, { headers: { origin: APP_ORIGIN } });
    assert.equal(json.headers.get("cache-control"), "no-store");
    assert.deepEqual(await json.json(), { ok: true });
    const challenge = await fetch(`${url}/challenge`, { method: "POST", headers: { origin: APP_ORIGIN } });
    assert.equal(challenge.headers.get("payment-required"), "required");
    assert.equal(challenge.headers.get("payment-response"), "response");
    assert.deepEqual(await challenge.json(), { error: "payment_required" });
    assert.equal(await (await fetch(`${url}/stream`, { headers: { origin: APP_ORIGIN } })).text(), "data: one\n\ndata: [DONE]\n\n");
  } finally {
    server.close();
  }
});

test("a preflight from the web app is answered with 204 and what it may send", async () => {
  const { url, server } = await serve();
  try {
    const res = await fetch(`${url}/challenge`, {
      method: "OPTIONS",
      headers: { origin: APP_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type, payment-signature" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), APP_ORIGIN);
    assert.equal(res.headers.get("access-control-allow-methods"), "GET, POST");
    assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type, PAYMENT-SIGNATURE");
    assert.equal(res.headers.get("vary"), "Origin");
    assert.equal(await res.text(), "");
  } finally {
    server.close();
  }
});

test("other origins and requests without an origin get no CORS permission", async () => {
  const { url, server } = await serve();
  try {
    for (const origin of ["https://evil.example", "http://app.ostraagent.com", "https://app.ostraagent.com.evil.example", undefined]) {
      const headers: Record<string, string> = origin === undefined ? {} : { origin };
      const res = await fetch(`${url}/json`, { headers });
      assert.equal(res.status, 200, String(origin));
      assert.equal(res.headers.get("access-control-allow-origin"), null, String(origin));
      assert.equal(res.headers.get("access-control-expose-headers"), null, String(origin));
      assert.equal(res.headers.get("vary"), "Origin", String(origin));
      assert.deepEqual(await res.json(), { ok: true });
      // Their preflights reach the routes as before (no OPTIONS route: 404).
      const pre = await fetch(`${url}/json`, { method: "OPTIONS", headers: { ...headers, "access-control-request-method": "GET" } });
      assert.equal(pre.status, 404, String(origin));
      assert.equal(pre.headers.get("access-control-allow-origin"), null, String(origin));
      await pre.arrayBuffer();
    }
  } finally {
    server.close();
  }
});
