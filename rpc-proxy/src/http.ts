// HTTP endpoint of the RPC proxy:
//
//   POST /       one JSON-RPC 2.0 request (policy.ts): forwarded to the upstream RPC
//                and answered with its answer; 400 for a malformed request, 403 for
//                a method or query the proxy does not serve, 413 for a body over
//                MAX_BODY_BYTES, 429 (Retry-After: 1) over a rate, 502 when the
//                upstream cannot be reached. Refusals are JSON-RPC error objects.
//   POST /logs   the same for the web app's log scans (logs-policy.ts), forwarded to
//                the logs upstream (an RPC serving eth_getLogs over LOG_WINDOW_BLOCKS
//                blocks) under rates of their own, at most LOGS_UPSTREAM_IN_FLIGHT at
//                once (the others wait, up to LOGS_UPSTREAM_QUEUE of them for at most
//                LOGS_QUEUE_WAIT_MS), each within LOGS_UPSTREAM_TIMEOUT_MS. The upstream's own 429 is answered as this
//                proxy's (-32005, Retry-After: 1).
//
// No refusal of a rate says "too many": core and the swap SDK split a log search in
// halves on an error saying "too many" (their answer to "too many logs").
//
// The web app's origin gets CORS, and its preflights (OPTIONS) are answered
// with 204 (merchant/src/cors.ts). The upstream URL never leaves this server:
// it is in no answer and no log line. A log line per request names the client
// by a keyed hash of its IP address (a key drawn at start), so one run's
// requests of one client can be counted together, and nothing more.

import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { applyCors } from "../../merchant/src/cors.ts";
import { checkLogsRequest, servedTopics, type LogsPolicy } from "./logs-policy.ts";
import { RATE_WINDOW_MS, checkRequest, type Checked, type RateLimiter, type RpcId } from "./policy.ts";

/** Largest request body, the relayer's limit (relayer/src/http.ts): an eth_simulateV1 of a launch with its WOTS signature fits. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Log searches sent upstream at once: all browsers on /logs share this server's address at the public RPC, which
 * refuses some 14 searches at once from one address (measured 23 Oct 2026).
 */
export const LOGS_UPSTREAM_IN_FLIGHT = 8;
/** Searches waiting for the upstream beyond which /logs answers that it is busy. */
export const LOGS_UPSTREAM_QUEUE = 64;
/** A search not answered upstream within this is answered 504. */
export const LOGS_UPSTREAM_TIMEOUT_MS = 30_000;
/** A search that waited longer than this for a slot is answered busy, not sent: its browser stops waiting at 30 s. */
export const LOGS_QUEUE_WAIT_MS = 10_000;

/** At most `max` holders at once; up to `queue` more wait, in order. */
export class Slots {
  readonly #max: number;
  readonly #queue: number;
  #held = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(max: number, queue: number) {
    this.#max = max;
    this.#queue = queue;
  }

  /** Takes a slot, waiting for one; false (nothing taken) when `queue` already wait. */
  async take(): Promise<boolean> {
    if (this.#held < this.#max && this.#waiting.length === 0) {
      this.#held++;
      return true;
    }
    if (this.#waiting.length >= this.#queue) return false;
    // A released slot passes straight to the first waiting: #held stays counted for it.
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
    return true;
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next !== undefined) next();
    else this.#held--;
  }

  size(): { held: number; waiting: number } {
    return { held: this.#held, waiting: this.#waiting.length };
  }
}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export type ProxyOptions = {
  /** The upstream RPC endpoint (never printed). */
  rpcUrl: string;
  limiter: RateLimiter;
  clientIp: "socket" | "cf-connecting-ip";
  log: Log;
  /** The /logs route: its upstream (never printed either), its rates and what it serves (and, for tests, its slots and timeout). */
  logs: { rpcUrl: string; limiter: RateLimiter; policy: LogsPolicy; slots?: Slots; timeoutMs?: number };
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
  const topics = servedTopics(o.logs.policy);
  type Route = { rpcUrl: string; limiter: RateLimiter; check: (body: unknown) => Checked; slots: Slots | null; timeoutMs: number | null; ownRate: boolean };
  const routes: Record<string, Route> = {
    "/": { rpcUrl: o.rpcUrl, limiter: o.limiter, check: checkRequest, slots: null, timeoutMs: null, ownRate: false },
    "/logs": {
      rpcUrl: o.logs.rpcUrl,
      limiter: o.logs.limiter,
      check: (body) => checkLogsRequest(body, o.logs.policy, topics),
      slots: o.logs.slots ?? new Slots(LOGS_UPSTREAM_IN_FLIGHT, LOGS_UPSTREAM_QUEUE),
      timeoutMs: o.logs.timeoutMs ?? LOGS_UPSTREAM_TIMEOUT_MS,
      ownRate: true,
    },
  };
  const busy = (res: ServerResponse, id: RpcId, message: string) => rpcError(res, 429, id, -32005, message, { "retry-after": String(RATE_WINDOW_MS / 1_000) });
  const redact = (text: string) => text.split(o.rpcUrl).join("<rpc>").split(o.logs.rpcUrl).join("<logs rpc>");
  return createServer((req, res) => {
    void (async () => {
      const started = performance.now();
      let client = "";
      let method: string | null = null;
      let path = "";
      let status = 0;
      try {
        if (applyCors(req, res)) return;
        const asked = new URL(req.url ?? "/", "http://rpc").pathname;
        const route = Object.hasOwn(routes, asked) ? routes[asked] : undefined;
        path = route === undefined ? "other" : asked;
        if (route === undefined || req.method !== "POST") {
          status = 404;
          return rpcError(res, 404, null, -32601, "POST one JSON-RPC request to / (or to /logs for the web app's log scans)");
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
        const named = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { method?: unknown }).method : undefined;
        if (typeof named === "string") method = named.slice(0, 64);
        const checked = route.check(parsed);
        if (!checked.ok) {
          status = checked.status;
          return rpcError(res, checked.status, checked.id, checked.code, checked.message);
        }
        const over = route.limiter.take(client, performance.now());
        if (over !== null) {
          status = 429;
          return busy(res, checked.request.id, over === "client" ? "over the rate of this address; retry in a second" : "the proxy is busy; retry in a second");
        }
        if (route.slots !== null) {
          const queued = performance.now();
          if (!(await route.slots.take())) {
            status = 429;
            return busy(res, checked.request.id, "the proxy is busy; retry in a second");
          }
          if (performance.now() - queued > LOGS_QUEUE_WAIT_MS) {
            route.slots.release();
            status = 429;
            return busy(res, checked.request.id, "the proxy is busy; retry in a second");
          }
        }
        let upstream: Response;
        let answer: string;
        try {
          upstream = await fetch(route.rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(checked.request),
            ...(route.timeoutMs === null ? {} : { signal: AbortSignal.timeout(route.timeoutMs) }),
          });
          answer = await upstream.text();
        } catch (err) {
          const late = err instanceof Error && err.name === "TimeoutError";
          status = late ? 504 : 502;
          return rpcError(res, status, checked.request.id, -32603, late ? "the upstream RPC did not answer in time; retry later" : "the upstream RPC could not be reached; retry later");
        } finally {
          route.slots?.release();
        }
        if (route.ownRate && upstream.status === 429) {
          status = 429;
          return busy(res, checked.request.id, "the public RPC is busy; retry in a second");
        }
        status = upstream.status;
        res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store", ...(upstream.status === 429 ? { "retry-after": String(RATE_WINDOW_MS / 1_000) } : {}) });
        res.end(answer);
      } catch (err) {
        status = 500;
        o.log("request_failed", { client, path, method, error: redact(err instanceof Error ? err.message : String(err)) });
        if (!res.headersSent) rpcError(res, 500, null, -32603, "internal error");
        else res.end();
      } finally {
        if (status !== 0) o.log("rpc", { client, path, method, status, ms: Math.round(performance.now() - started) });
      }
    })();
  });
}
