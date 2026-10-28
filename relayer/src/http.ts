// HTTP endpoint of the relayer (routes: server.ts).

import { createServer, type IncomingMessage, type Server } from "node:http";
import { getAddress, isAddress } from "viem";
import type { PrivateRelay } from "./private.ts";
import { applyCors } from "../../merchant/src/cors.ts";
import type { BackupStore } from "./backups.ts";
import type { Log, RelayerGate } from "./gate.ts";
import type { SignatureEscrow } from "./signatures.ts";
import { clientKey } from "./rate.ts";

/**
 * Largest request body (decided 17 Oct 2026; raised 21 Oct 2026): a private
 * spend's calldata (OstraPrivatePool privateSwap or unshield, about 75.5 KB
 * with its STARK proof: 151,000 hex characters) with room to spare. Before,
 * 64 KiB: MAX_RELAY_CALLS calls of a WOTS spend (about 2,300 bytes of
 * calldata each). On Solana it was 16 KiB, for a 4,096-byte transaction.
 */
export const MAX_BODY_BYTES = 256 * 1024;

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
  gate: Pick<RelayerGate, "relay" | "vaultState" | "escrow">;
  escrow: Pick<SignatureEscrow, "get">;
  backups: Pick<BackupStore, "get" | "lastWrite" | "write">;
  /** Serves GET /v1/private/price when the relayer relays private spends. */
  privateRelay?: Pick<PrivateRelay, "price">;
  facts: Record<string, unknown>;
  clientIp: "socket" | "cf-connecting-ip";
  log: Log;
  /** Removes the RPC URL (it may carry an API key) from logs and from every answer that can carry an error's text. */
  scrub: (text: string) => string;
}): Server {
  // The client a request counts against (rate.ts clientKey: an IPv6 address by its /64).
  const ipOf = (req: IncomingMessage) => clientKey(o.clientIp === "cf-connecting-ip" ? String(req.headers["cf-connecting-ip"] ?? "") : (req.socket.remoteAddress ?? ""));
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
        if (path === "/v1/private/price" && req.method === "GET" && o.privateRelay !== undefined) {
          const q = new URL(req.url ?? "/", "http://relayer").searchParams;
          const token = q.get("token") ?? "";
          const kind = q.get("kind") ?? "";
          if (!isAddress(token, { strict: false }) || (kind !== "swap" && kind !== "unshield")) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad_request", message: "token=<address>&kind=swap|unshield" }));
            return;
          }
          const answer = await o.privateRelay.price(getAddress(token), kind);
          res.writeHead(answer.status, answer.headers);
          res.end(o.scrub(toJson(answer.body)));
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
        if (path.startsWith("/v1/backups/") && (req.method === "GET" || req.method === "POST")) {
          const name = path.slice("/v1/backups/".length).toLowerCase();
          if (!/^0x[0-9a-f]{64}$/.test(name)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad_request", message: "a backup name is 32 bytes of 0x hex" }));
            return;
          }
          if (req.method === "GET") {
            const backup = o.backups.get(name);
            // A deleted backup still tells when it was deleted: the next write must be later.
            const deletedAt = backup === undefined ? o.backups.lastWrite(name) : undefined;
            res.writeHead(backup === undefined ? 404 : 200, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(toJson(backup ?? { error: "no_backup", name, ...(deletedAt === undefined ? {} : { updatedAt: deletedAt }) }));
            return;
          }
          const ip = ipOf(req);
          if (ip === "") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "no_client_ip" }));
            return;
          }
          let body: unknown;
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad_request", message: "the body must be JSON" }));
            return;
          }
          const answer = await o.backups.write(name, body, ip, Date.now());
          if (answer.status === 200) o.log("backup_written", { name, deleted: answer.body.deleted });
          res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(toJson(answer.body));
          return;
        }
        if (path === "/v1/escrow" && req.method === "POST") {
          const answer = await o.gate.escrow({ body: await readBody(req) });
          res.writeHead(answer.status, answer.headers);
          res.end(answer.body === undefined ? undefined : o.scrub(typeof answer.body === "string" ? answer.body : toJson(answer.body)));
          return;
        }
        if (path === "/v1/relay" && req.method === "POST") {
          const body = await readBody(req);
          const ip = ipOf(req);
          if (ip === "") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "no_client_ip" }));
            return;
          }
          const answer = await o.gate.relay({ body, req, ip });
          res.writeHead(answer.status, answer.headers);
          res.end(answer.body === undefined ? undefined : o.scrub(typeof answer.body === "string" ? answer.body : toJson(answer.body)));
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
