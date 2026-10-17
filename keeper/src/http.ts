// HTTP endpoint of the keeper (JSON over HTTP; served to sellers through an
// HTTPS proxy):
//
//   POST /v1/vouchers   { merchant, channelConfig, voucher, splits? }
//                       a seller forwards a buyer's x402 batch-settlement
//                       voucher; no login, since a valid voucher can only add
//                       to what the seller is paid
//   POST /v1/close      { merchant, channelConfig, signature, voucher?, splits? }
//                       a seller's server asks for a channel to be claimed,
//                       refunded and paid out; `signature` is the merchant key's
//                       EIP-191 signature of "OSTRA/KEEPER/CLOSE/EVM/v1" ||
//                       chainid || channel id
//   GET  /v1/crank?merchant=<address>
//                       the crank a seller installs on its vault with SetCrankKey
//   GET  /v1/terms      what a seller's offer must contain: the keeper fee
//                       recipient and bps, and the minimum withdraw delay
//   GET  /v1/health     fee payer balance and the state of the watch loop
//
// Errors are { error: <code>, message }.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { KeeperError, type Keeper } from "./keeper.ts";

/** Largest request body: a channel config, a voucher and 32 splits fit in well under this. */
const MAX_BODY_BYTES = 16 * 1024;

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new KeeperError(415, "unsupported_media_type", "send application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new KeeperError(413, "body_too_large", `the body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new KeeperError(400, "invalid_json", "the body is not valid JSON");
  }
}

export function createKeeperServer(keeper: Keeper): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://keeper");
        const route = `${req.method ?? ""} ${url.pathname}`;
        switch (route) {
          case "POST /v1/vouchers":
            return reply(res, 200, await keeper.acceptVoucher(await readJson(req)));
          case "POST /v1/close":
            return reply(res, 200, await keeper.close(await readJson(req)));
          case "GET /v1/terms":
            return reply(res, 200, keeper.terms());
          case "GET /v1/crank":
            return reply(res, 200, keeper.crankFor(url.searchParams.get("merchant") ?? undefined));
          case "GET /v1/health":
            return reply(res, 200, await keeper.health());
          default:
            return reply(res, 404, { error: "not_found", message: "unknown route" });
        }
      } catch (err) {
        if (err instanceof KeeperError) return reply(res, err.status, { error: err.code, message: err.message });
        keeper.log("request_failed", { route: `${req.method ?? ""} ${req.url ?? ""}`, error: err instanceof Error ? err.message : String(err) });
        return reply(res, 500, { error: "internal", message: "the keeper could not complete the request; retry later" });
      }
    })();
  });
}
