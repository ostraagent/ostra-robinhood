// HTTP endpoint of the RPC proxy:
//
//   POST /   one JSON-RPC 2.0 request (policy.ts): forwarded to the upstream RPC
//            and answered with its answer; 400 for a malformed request, 403 for
//            a method or query the proxy does not serve, 413 for a body over
//            MAX_BODY_BYTES, 429 (Retry-After: 1) over a rate, 502 when the
//            upstream cannot be reached. Refusals are JSON-RPC error objects.
//
// The web app's origin gets CORS, and its preflights (OPTIONS) are answered
// with 204 (merchant/src/cors.ts). The upstream URL never leaves this server:
// it is in no answer and no log line. A log line per request names the client
// by a keyed hash of its IP address (a key drawn at start), so one run's
// requests of one client can be counted together, and nothing more.

import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { applyCors } from "../../merchant/src/cors.ts";
import { RATE_WINDOW_MS, checkRequest, type RateLimiter, type RpcId } from "./policy.ts";

/** Largest request body, the relayer's limit (relayer/src/http.ts): an eth_simulateV1 of a launch with its WOTS signature fits. */
export const MAX_BODY_BYTES = 64 * 1024;

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export type ProxyOptions = {
  /** The upstream RPC endpoint (never printed). */
  rpcUrl: string;
  limiter: RateLimiter;
  clientIp: "socket" | "cf-connecting-ip";
  log: Log;
};

function rpcError(res: ServerResponse, status: number, id: RpcId, code: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

/** The body, or null when it is over MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createRpcProxyServer(o: ProxyOptions): Server {
  const clientKey = randomBytes(32);
  const clientOf = (ip: string) => createHmac("sha256", clientKey).update(ip).digest("hex").slice(0, 16);
  return createServer((req, res) => {
    void (async () => {
      const started = performance.now();
      let client = "";
      let method: string | null = null;
      let status = 0;
      try {
        if (applyCors(req, res)) return;
        const path = new URL(req.url ?? "/", "http://rpc").pathname;
        if (path !== "/" || req.method !== "POST") {
          status = 404;
          return rpcError(res, 404, null, -32601, "POST one JSON-RPC request to /");
        }
        const ip = o.clientIp === "cf-connecting-ip" ? String(req.headers["cf-connecting-ip"] ?? "") : (req.socket.remoteAddress ?? "");
        if (ip === "") {
          status = 400;
          return rpcError(res, 400, null, -32600, "no client IP address");
        }
        client = clientOf(ip);
        const body = await readBody(req);
        if (body === null) {
          status = 413;
          return rpcError(res, 413, null, -32600, `the body is over ${MAX_BODY_BYTES} bytes`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          status = 400;
          return rpcError(res, 400, null, -32700, "the body is not valid JSON");
        }
        const asked = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { method?: unknown }).method : undefined;
        if (typeof asked === "string") method = asked.slice(0, 64);
        const checked = checkRequest(parsed);
        if (!checked.ok) {
          status = checked.status;
          return rpcError(res, checked.status, checked.id, checked.code, checked.message);
        }
        const over = o.limiter.take(client, performance.now());
        if (over !== null) {
          status = 429;
          return rpcError(res, 429, checked.request.id, -32005, over === "client" ? "too many requests from this address; retry in a second" : "the proxy is busy; retry in a second", {
            "retry-after": String(RATE_WINDOW_MS / 1_000),
          });
        }
        let upstream: Response;
        try {
          upstream = await fetch(o.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checked.request) });
        } catch {
          status = 502;
          return rpcError(res, 502, checked.request.id, -32603, "the upstream RPC could not be reached; retry later");
        }
        const answer = await upstream.text();
        status = upstream.status;
        res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store", ...(upstream.status === 429 ? { "retry-after": String(RATE_WINDOW_MS / 1_000) } : {}) });
        res.end(answer);
      } catch (err) {
        status = 500;
        o.log("request_failed", { client, method, error: (err instanceof Error ? err.message : String(err)).split(o.rpcUrl).join("<rpc>") });
        if (!res.headersSent) rpcError(res, 500, null, -32603, "internal error");
        else res.end();
      } finally {
        if (status !== 0) o.log("rpc", { client, method, status, ms: Math.round(performance.now() - started) });
      }
    })();
  });
}
