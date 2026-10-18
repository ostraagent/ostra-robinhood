// CORS for the Ostra web app (design: web app, decided 17 Oct 2026). The web
// app runs at https://app.ostraagent.xyz and calls the relayer, the
// aggregator, the AI gateway and the RPC proxy from the browser; only that
// origin is allowed. Other sites' pages get no CORS headers, so browsers keep
// them from reading the answers. Requests without an Origin (agents, servers)
// are served as before.
//
// The web app sends JSON bodies and x402 payments (the PAYMENT-SIGNATURE
// header), and reads the 402 challenge (PAYMENT-REQUIRED) and the settlement
// receipt (PAYMENT-RESPONSE), the x402 v2 HTTP transport headers that replace
// MPP's Authorization, WWW-Authenticate and Payment-Receipt.

import type { IncomingMessage, ServerResponse } from "node:http";

/** The web app's origin. */
export const APP_ORIGIN = "https://app.ostraagent.xyz";

const ALLOWED_METHODS = "GET, POST";
const ALLOWED_HEADERS = "Content-Type, PAYMENT-SIGNATURE";
const EXPOSED_HEADERS = "PAYMENT-REQUIRED, PAYMENT-RESPONSE";

/** The CORS headers for an answer to a request from `origin`. */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin !== APP_ORIGIN) return { vary: "Origin" };
  return { vary: "Origin", "access-control-allow-origin": APP_ORIGIN, "access-control-expose-headers": EXPOSED_HEADERS };
}

/** The headers of the answer to a preflight (OPTIONS) from the web app. */
export function preflightHeaders(): Record<string, string> {
  return {
    vary: "Origin",
    "access-control-allow-origin": APP_ORIGIN,
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
  };
}

/**
 * Sets the CORS headers of `req`'s answer on `res` (they stay through a
 * later writeHead) and answers a preflight from the web app with 204. True
 * when the request was answered here.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS" && origin === APP_ORIGIN) {
    res.writeHead(204, preflightHeaders());
    res.end();
    return true;
  }
  for (const [name, value] of Object.entries(corsHeaders(origin))) res.setHeader(name, value);
  return false;
}
