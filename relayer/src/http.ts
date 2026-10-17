// HTTP endpoint of the relayer (routes: server.ts).

import { createServer, type IncomingMessage, type Server } from "node:http";
import { getAddress, isAddress } from "viem";
import { applyCors } from "../../merchant/src/cors.ts";
import type { Log, RelayerGate } from "./gate.ts";
import type { SignatureEscrow } from "./signatures.ts";

/**
 * Largest request body (decided 17 Oct 2026): MAX_RELAY_CALLS calls of a
 * WOTS spend (about 2,300 bytes of calldata, 4,600 hex characters each) with
 * room to spare. On Solana it was 16 KiB, for a 4,096-byte transaction.
 */
export const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function createRelayerServer(o: {
  gate: Pick<RelayerGate, "relay" | "vaultState">;
  escrow: Pick<SignatureEscrow, "get">;
  facts: Record<string, unknown>;
  clientIp: "socket" | "cf-connecting-ip";
  log: Log;
  scrub: (text: string) => string;
}): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        if (applyCors(req, res)) return;
        const path = new URL(req.url ?? "/", "http://relayer").pathname;
        if (path === "/v1/relayer" && req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(toJson(o.facts));
          return;
        }
        if (path.startsWith("/v1/vaults/") && req.method === "GET") {
          const text = path.slice("/v1/vaults/".length);
          if (!isAddress(text, { strict: false })) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad_vault" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(toJson(o.gate.vaultState(getAddress(text))));
          return;
        }
        if (path.startsWith("/v1/signatures/") && req.method === "GET") {
          const raw = path.slice("/v1/signatures/".length).toLowerCase();
          const keyRoot = raw.startsWith("0x") ? raw : `0x${raw}`;
          if (!/^0x[0-9a-f]{64}$/.test(keyRoot)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad_key_root", message: "a key root is 32 bytes: 64 hex characters, with or without 0x" }));
            return;
          }
          const record = o.escrow.get(keyRoot);
          res.writeHead(record === undefined ? 404 : 200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(toJson(record ?? { error: "no_signature", keyRoot }));
          return;
        }
        if (path === "/v1/relay" && req.method === "POST") {
          const body = await readBody(req);
          const ip = o.clientIp === "cf-connecting-ip" ? String(req.headers["cf-connecting-ip"] ?? "") : (req.socket.remoteAddress ?? "");
          if (ip === "") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "no_client_ip" }));
            return;
          }
          const answer = await o.gate.relay({ body, req, ip });
          res.writeHead(answer.status, answer.headers);
          res.end(answer.body === undefined ? undefined : typeof answer.body === "string" ? answer.body : toJson(answer.body));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      } catch (err) {
        o.log("request_failed", { error: o.scrub(err instanceof Error ? err.message : String(err)) });
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    })();
  });
}
