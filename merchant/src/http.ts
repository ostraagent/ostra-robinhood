// HTTP endpoint of the reference seller server (routes: server.ts).

import { createServer, type Server, type ServerResponse } from "node:http";
import type { HTTPResponseInstructions } from "@x402/core/http";
import type { Log } from "./forwarder.ts";
import type { OstraMerchant } from "./merchant.ts";

function send(res: ServerResponse, r: HTTPResponseInstructions): void {
  res.writeHead(r.status, r.headers);
  res.end(r.body === undefined ? undefined : typeof r.body === "string" ? r.body : JSON.stringify(r.body));
}

/** The paid route (/paid) and the public facts (/v1/merchant). */
export function createMerchantServer(merchant: Pick<OstraMerchant, "payment">, facts: Record<string, unknown>, log: Log, scrub: (text: string) => string): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://merchant").pathname;
        if (path === "/v1/merchant" && req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(facts));
          return;
        }
        if (path === "/paid" && (req.method === "GET" || req.method === "POST")) {
          const outcome = await merchant.payment(req, { description: "Ostra reference paid resource" });
          if (outcome.kind === "respond") return send(res, outcome.response);
          const done = await outcome.complete();
          if (!done.ok) return send(res, done.response);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...done.headers });
          res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      } catch (err) {
        log("request_failed", { error: scrub(err instanceof Error ? err.message : String(err)) });
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    })();
  });
}
