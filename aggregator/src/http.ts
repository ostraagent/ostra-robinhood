// HTTP endpoint of the aggregator (JSON over HTTP; served to depositors
// through an HTTPS proxy):
//
//   POST /v1/deposits             { deposit, leaves: [{ keyRoot, amount }] }
//                                 the leaves of a pending deposit (deposit =
//                                 its OstraPool deposit key, 0x hex); accepted
//                                 only if they match its on-chain commitment
//   GET  /v1/deposits/<deposit>?at=<unix seconds>&signature=<0x hex>
//                                 a poll signed (EIP-191) by the deposit's
//                                 depositor key: queued, or the batch number
//                                 and state hash to approve
//   GET  /v1/terms                the chain, the pool, the aggregator account and the batch rules
//   GET  /v1/health               aggregator ETH, queue and open batch
//
// Errors are { error: <code>, message }. The web app's origin gets CORS on
// every route, and its preflights (OPTIONS) are answered with 204
// (merchant/src/cors.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MAX_LEAVES_PER_BATCH } from "@ostraagent/sdk";
import { applyCors } from "../../merchant/src/cors.ts";
import { AggregatorError, type Aggregator } from "./aggregator.ts";

/** Largest request body: MAX_LEAVES_PER_BATCH leaves of about 110 bytes of JSON each, with room to spare. */
const MAX_BODY_BYTES = 256 + MAX_LEAVES_PER_BATCH * 128;

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new AggregatorError(415, "unsupported_media_type", "send application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new AggregatorError(413, "body_too_large", `the body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AggregatorError(400, "invalid_json", "the body is not valid JSON");
  }
}

const DEPOSIT_PATH = /^\/v1\/deposits\/(0x[0-9a-fA-F]{64})$/;

export function createAggregatorServer(aggregator: Aggregator): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        if (applyCors(req, res)) return;
        const url = new URL(req.url ?? "/", "http://aggregator");
        const method = req.method ?? "";
        if (method === "POST" && url.pathname === "/v1/deposits") return reply(res, 200, await aggregator.register(await readJson(req)));
        const deposit = DEPOSIT_PATH.exec(url.pathname);
        if (method === "GET" && deposit !== null) {
          return reply(res, 200, await aggregator.poll(deposit[1], url.searchParams.get("at"), url.searchParams.get("signature")));
        }
        if (method === "GET" && url.pathname === "/v1/terms") return reply(res, 200, aggregator.terms());
        if (method === "GET" && url.pathname === "/v1/health") return reply(res, 200, await aggregator.health());
        return reply(res, 404, { error: "not_found", message: "unknown route" });
      } catch (err) {
        if (err instanceof AggregatorError) return reply(res, err.status, { error: err.code, message: err.message });
        aggregator.log("request_failed", { route: `${req.method ?? ""} ${req.url?.split("?")[0] ?? ""}`, error: err instanceof Error ? err.message : String(err) });
        return reply(res, 500, { error: "internal", message: "the aggregator could not complete the request; retry later" });
      }
    })();
  });
}
