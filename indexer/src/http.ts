// The indexer's HTTP API, read-only JSON for the web app, served under /api/v1
// on the web app's own host (app.ostraagent.xyz, nginx in front: same origin,
// so no CORS, and nginx limits the request rate per client).
//
//   GET /api/v1/health
//   GET /api/v1/tokens?sort=new|marketcap|volume|active&q=&offset=&limit=
//   GET /api/v1/tokens/<token>
//   GET /api/v1/tokens/<token>/trades?limit=&before=<block>:<logIndex>
//   GET /api/v1/tokens/<token>/candles?interval=60|300|900|3600|14400|86400
//   GET /api/v1/agents/<creator vault>
//   GET /api/v1/images/<cid>   an image a token's metadata or a creator's profile names (ipfs://<cid>), as the
//                              indexer keeps it (ipfs.ts): PNG, JPEG, WebP or GIF, by its first bytes
//   GET /api/v1/pad/listings?q=&provider=&offset=&limit=   Ostrapad's listed agents, ranked (pad.ts); provider:
//                                                one provider vault's listings only
//   GET /api/v1/pad/agents/<agentId>             one agent, its listing, record and recent jobs
//   GET /api/v1/pad/jobs?limit=                  recent jobs
//   GET /api/v1/pad/stats
//   GET /api/v1/pad/board?q=&offset=&limit=      the web app's Ostrapad page: its stats and its agents ranked with
//                                                their figures, without the hidden list's accounts (pad.ts board)
//   GET /api/v1/pad/board/<agentId>              one agent of the board, its jobs and its clients
//   GET /api/v1/pad/board/jobs?limit=            the board's recent jobs
//   The board answers 503 board_unavailable while its hidden list cannot be read.
//   POST /api/v1/tide/link, POST /api/v1/tide/points, GET /api/v1/tide/summary   Ostra Tide (tide.ts): an agent's
//                                                vault link, and its own points to the holder of its view key

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAddress } from "viem";
import { CANDLE_INTERVALS, type Indexer } from "./indexer.ts";
import type { PadIndexer } from "./pad.ts";
import { TIDE_BODY_MAX, TideBadRequest, type TideApi } from "./tide.ts";

const MAX_LIMIT = 100;
const SORTS = new Set(["new", "marketcap", "volume", "active"]);

function send(res: ServerResponse, status: number, body: unknown, maxAge = 2): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

function intParam(url: URL, name: string, fallback: number, max: number): number | null {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return fallback;
  if (!/^[0-9]{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > max ? null : n;
}

/** An image's bytes: named by its CID, so it never changes; the type from its first bytes; nothing in it runs. */
function sendImage(res: ServerResponse, image: { bytes: Uint8Array; type: string }): void {
  res.writeHead(200, {
    "content-type": image.type,
    "content-length": String(image.bytes.length),
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  res.end(image.bytes);
}

export function handle(indexer: Indexer, req: IncomingMessage, res: ServerResponse, pad: PadIndexer | null = null): void {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method_not_allowed" });
  const url = new URL(req.url ?? "/", "http://indexer.local");
  const parts = url.pathname.split("/").filter((p) => p !== "");
  if (parts[0] !== "api" || parts[1] !== "v1") return send(res, 404, { error: "not_found" });
  const [, , resource, id, sub] = parts;
  if (parts.length > 5) return send(res, 404, { error: "not_found" });
  if (resource === "health" && id === undefined) return send(res, 200, indexer.health(), 1);
  if (resource === "tokens" && id === undefined) {
    const sort = url.searchParams.get("sort") ?? "new";
    if (!SORTS.has(sort)) return send(res, 400, { error: "bad_sort" });
    const q = url.searchParams.get("q");
    if (q !== null && q.length > 64) return send(res, 400, { error: "bad_query" });
    const offset = intParam(url, "offset", 0, 1_000_000);
    const limit = intParam(url, "limit", 30, MAX_LIMIT);
    if (offset === null || limit === null || limit === 0) return send(res, 400, { error: "bad_page" });
    return send(res, 200, indexer.tokens({ sort: sort as "new", q, offset, limit }));
  }
  if (resource === "tokens" && id !== undefined) {
    if (!isAddress(id, { strict: false })) return send(res, 400, { error: "bad_address" });
    if (sub === undefined) {
      const t = indexer.token(id);
      return t === null ? send(res, 404, { error: "unknown_token" }) : send(res, 200, t);
    }
    if (sub === "trades") {
      const limit = intParam(url, "limit", 50, MAX_LIMIT);
      if (limit === null || limit === 0) return send(res, 400, { error: "bad_page" });
      const beforeText = url.searchParams.get("before");
      let before: { block: bigint; logIndex: number } | null = null;
      if (beforeText !== null) {
        const m = /^([0-9]{1,15}):([0-9]{1,6})$/.exec(beforeText);
        if (m === null) return send(res, 400, { error: "bad_before" });
        before = { block: BigInt(m[1] as string), logIndex: Number(m[2]) };
      }
      const trades = indexer.trades(id, { limit, before });
      return trades === null ? send(res, 404, { error: "unknown_token" }) : send(res, 200, { trades });
    }
    if (sub === "candles") {
      const interval = intParam(url, "interval", 300, 86_400);
      if (interval === null || !CANDLE_INTERVALS.has(interval)) return send(res, 400, { error: "bad_interval" });
      const candles = indexer.candles(id, interval);
      return candles === null ? send(res, 404, { error: "unknown_token" }) : send(res, 200, { interval, candles });
    }
    return send(res, 404, { error: "not_found" });
  }
  if (resource === "images" && id !== undefined && sub === undefined) {
    if (!/^[A-Za-z0-9]{1,100}$/.test(id)) return send(res, 400, { error: "bad_cid" });
    const image = indexer.image(id);
    return image === null ? send(res, 404, { error: "unknown_image" }) : sendImage(res, image);
  }
  if (resource === "agents" && id !== undefined && sub === undefined) {
    if (!isAddress(id, { strict: false })) return send(res, 400, { error: "bad_address" });
    return send(res, 200, indexer.agent(id), 5);
  }
  if (resource === "pad") {
    if (pad === null) return send(res, 404, { error: "not_found" });
    if (id === "listings" && sub === undefined) {
      const q = url.searchParams.get("q");
      if (q !== null && q.length > 100) return send(res, 400, { error: "bad_query" });
      const provider = url.searchParams.get("provider");
      if (provider !== null && !isAddress(provider)) return send(res, 400, { error: "bad_provider" });
      const offset = intParam(url, "offset", 0, 1_000_000);
      const limit = intParam(url, "limit", 20, MAX_LIMIT);
      if (offset === null || limit === null || limit === 0) return send(res, 400, { error: "bad_page" });
      return send(res, 200, pad.listings({ ...(q === null ? {} : { q }), ...(provider === null ? {} : { provider }), offset, limit }), 10);
    }
    if (id === "agents" && sub !== undefined) {
      if (!/^[0-9]{1,30}$/.test(sub)) return send(res, 400, { error: "bad_agent_id" });
      const a = pad.agent(sub);
      return a === null ? send(res, 404, { error: "unknown_agent" }) : send(res, 200, a, 10);
    }
    if (id === "jobs" && sub === undefined) {
      const limit = intParam(url, "limit", 50, MAX_LIMIT);
      if (limit === null || limit === 0) return send(res, 400, { error: "bad_page" });
      return send(res, 200, { jobs: pad.jobs({ limit }) }, 5);
    }
    if (id === "stats" && sub === undefined) return send(res, 200, pad.stats(), 10);
    if (id === "board") {
      if (sub === undefined) {
        const q = url.searchParams.get("q");
        if (q !== null && q.length > 100) return send(res, 400, { error: "bad_query" });
        const offset = intParam(url, "offset", 0, 1_000_000);
        const limit = intParam(url, "limit", 20, MAX_LIMIT);
        if (offset === null || limit === null || limit === 0) return send(res, 400, { error: "bad_page" });
        const b = pad.board({ ...(q === null ? {} : { q }), offset, limit });
        return b === null ? send(res, 503, { error: "board_unavailable" }) : send(res, 200, b, 10);
      }
      if (sub === "jobs") {
        const limit = intParam(url, "limit", 50, MAX_LIMIT);
        if (limit === null || limit === 0) return send(res, 400, { error: "bad_page" });
        const jobs = pad.boardJobs({ limit });
        return jobs === null ? send(res, 503, { error: "board_unavailable" }) : send(res, 200, { jobs }, 10);
      }
      if (!/^[0-9]{1,30}$/.test(sub)) return send(res, 400, { error: "bad_agent_id" });
      const a = pad.boardAgent(sub);
      if (a === null) return send(res, 503, { error: "board_unavailable" });
      return a === undefined ? send(res, 404, { error: "unknown_agent" }) : send(res, 200, a, 10);
    }
    return send(res, 404, { error: "not_found" });
  }
  return send(res, 404, { error: "not_found" });
}

/** A request body of at most `max` bytes, as JSON; null when it is longer or not JSON. */
async function jsonBody(req: IncomingMessage, max: number): Promise<{ ok: true; value: unknown } | { ok: false; error: "too_large" | "bad_json" }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return { ok: false, error: "too_large" };
    chunks.push(chunk as Buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, error: "bad_json" };
  }
}

/** Ostra Tide's routes (tide.ts); never cached, as they answer one agent alone or change with each score. */
export async function handleTide(tide: TideApi, req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  if (route === "summary") {
    if (req.method !== "GET" && req.method !== "HEAD") return reply(405, { error: "method_not_allowed" });
    return reply(200, await tide.summary());
  }
  if (route !== "link" && route !== "points") return reply(404, { error: "not_found" });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  const body = await jsonBody(req, TIDE_BODY_MAX);
  if (!body.ok) return reply(body.error === "too_large" ? 413 : 400, { error: body.error });
  try {
    if (route === "link") return reply(200, await tide.link(body.value));
    const r = await tide.points(body.value);
    return reply(r.status, r.body);
  } catch (err) {
    if (err instanceof TideBadRequest) return reply(400, { error: "bad_request", message: err.message });
    throw err;
  }
}

export function createIndexerServer(indexer: Indexer, log: (event: string, fields?: Record<string, unknown>) => void, pad: PadIndexer | null = null, tide: TideApi | null = null): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const m = /^\/api\/v1\/tide\/([a-z]{1,16})$/.exec(path);
    if (m !== null) {
      if (tide === null) return send(res, 404, { error: "not_found" });
      handleTide(tide, req, res, m[1] as string).catch((err: unknown) => {
        log("request_failed", { path: path.slice(0, 200), reason: (err as Error).message.slice(0, 200) });
        if (!res.headersSent) send(res, 500, { error: "internal" });
        else res.end();
      });
      return;
    }
    try {
      handle(indexer, req, res, pad);
    } catch (err) {
      log("request_failed", { path: (req.url ?? "").slice(0, 200), reason: (err as Error).message.slice(0, 200) });
      if (!res.headersSent) send(res, 500, { error: "internal" });
      else res.end();
    }
  });
}
