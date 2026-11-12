#!/usr/bin/env node
// Ostra Cloud's egress (design 12 Nov 2026, model A): the only way out of the enclave's inner network, for the remote
// gateway and the agents' servers (the signer has no network at all). An HTTP proxy that takes CONNECT to port 443 and
// nothing else: the host is resolved here and refused unless every address it resolves to is public unicast (the rule
// of the pay tool, public-fetch.ts isPublicAddress: no loopback, private, link-local and cloud metadata, CGNAT,
// documentation, multicast or reserved space, nor IPv6 carrying IPv4), and the tunnel connects to the addresses
// checked, in order, never to a second lookup. A plain HTTP request, another port, a host that is not public: 403, the
// reason in the X-Ostra-Egress-Refused header (public-fetch.ts proxiedFetch reads it).
//
// Limits, all of it (the agents' servers share one network address, the gateway's): MAX_TUNNELS open at once, at most
// TUNNELS_PER_MINUTE new ones a minute (past either: 429), and BYTES_PER_MINUTE both ways, past which every tunnel waits
// for the next minute (throttled, not cut); one tunnel alone at most TUNNEL_BYTES_PER_MINUTE, past which it waits, so
// that one download never holds the others up. A tunnel idle for IDLE_MS is closed; a client gone before its tunnel is
// up frees its place at once. Logs are counts, never a host or an address: what an agent reaches is its own.
//
//   OSTRA_EGRESS_LISTEN              host:port (default 0.0.0.0:3128)
//   OSTRA_EGRESS_MAX_TUNNELS         default 1024
//   OSTRA_EGRESS_TUNNELS_PER_MINUTE  default 6000
//   OSTRA_EGRESS_BYTES_PER_MINUTE    default 1073741824 (1 GiB)
//   OSTRA_EGRESS_TUNNEL_BYTES_PER_MINUTE  default 67108864 (64 MiB)

import { ADDRCONFIG } from "node:dns";
import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { EGRESS_REFUSED_HEADER, isPublicAddress } from "./public-fetch.ts";

const CONNECT_MS = 10_000;
const IDLE_MS = 5 * 60_000;
/** The longest CONNECT target taken (a host name is at most 253 bytes). */
const MAX_TARGET = 300;

type Address = { address: string; family: number };
type Resolve = (host: string) => Promise<Address[]>;

export type EgressOptions = {
  host: string;
  port: number;
  maxTunnels: number;
  tunnelsPerMinute: number;
  bytesPerMinute: number;
  /** What one tunnel may carry a minute, both ways. */
  tunnelBytesPerMinute: number;
  /** DNS and the public-address rule, for tests (default: the system's resolver and isPublicAddress). */
  resolve?: Resolve;
  allow?: (address: string) => boolean;
  /** The port the tunnels connect to (default 443; another one in tests only). */
  upstreamPort?: number;
  /** Called with each counter event (never a host). */
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

/** A minute's budget, on the monotonic clock. */
class Minute {
  #start = performance.now();
  #used = 0;
  readonly #limit: number;
  constructor(limit: number) {
    this.#limit = limit;
  }
  #roll(): void {
    if (performance.now() - this.#start >= 60_000) {
      this.#start = performance.now();
      this.#used = 0;
    }
  }
  /** Takes `n` if it fits this minute. */
  take(n: number): boolean {
    this.#roll();
    if (this.#used + n > this.#limit) return false;
    this.#used += n;
    return true;
  }
  /** Charges `n` whatever it was; true while within the limit. */
  charge(n: number): boolean {
    this.#roll();
    this.#used += n;
    return this.#used <= this.#limit;
  }
  /** Milliseconds until the next minute. */
  left(): number {
    return Math.max(0, 60_000 - (performance.now() - this.#start));
  }
}

/** Parses a CONNECT target: host:443 (a name, an IPv4 literal or a bracketed IPv6 one). */
export function connectTarget(target: string): { host: string } | { refused: string } {
  if (target.length === 0 || target.length > MAX_TARGET) return { refused: "not a host:port" };
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]+)):([0-9]{1,5})$/.exec(target);
  if (m === null) return { refused: "not a host:port" };
  if (m[3] !== "443") return { refused: `port ${m[3]} is closed: the egress opens port 443 (HTTPS) only` };
  const host = (m[1] ?? m[2] ?? "").toLowerCase();
  if (m[1] !== undefined && isIP(host) !== 6) return { refused: "not a host:port" };
  if (m[2] !== undefined && isIP(host) === 0 && !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/.test(host)) return { refused: "not a host name" };
  const name = host.replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return { refused: "this machine is not reachable through the egress" };
  return { host };
}

/** Starts the egress; resolves once it listens. */
export async function startEgress(o: EgressOptions): Promise<Server> {
  const resolve: Resolve = o.resolve ?? ((host) => lookup(host, { all: true, verbatim: true, hints: ADDRCONFIG }));
  const allow = o.allow ?? isPublicAddress;
  const log = o.log ?? (() => {});
  const tunnels = new Minute(o.tunnelsPerMinute);
  const bytes = new Minute(o.bytesPerMinute);
  let open = 0;
  /** Tunnels paused for the byte budget of all, resumed at its next minute; and for their own budget (`held`). */
  const paused = new Set<Socket>();
  const held = new Set<Socket>();
  /** A side may read again once neither budget nor its peer's full buffer holds it. */
  const free = (s: Socket) => !paused.has(s) && !held.has(s);
  let resumeTimer: NodeJS.Timeout | null = null;
  const resumeLater = () => {
    if (resumeTimer !== null) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      const was = [...paused];
      paused.clear();
      for (const s of was) if (!s.destroyed && !held.has(s)) s.resume();
    }, bytes.left() + 10);
    resumeTimer.unref();
  };

  const refuse = (socket: Socket, status: number, why: string) => {
    const text = status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : status === 502 ? "Bad Gateway" : "Bad Request";
    socket.end(`HTTP/1.1 ${status} ${text}\r\n${EGRESS_REFUSED_HEADER}: ${why}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    socket.destroySoon?.();
  };

  const server = createServer((req, res) => {
    // A plain HTTP request (GET http://...): never forwarded.
    res.writeHead(403, { [EGRESS_REFUSED_HEADER]: "plain HTTP is not forwarded: the egress opens CONNECT to port 443 (HTTPS) only", "content-length": "0", connection: "close" });
    res.end();
    req.resume();
  });
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    const t = connectTarget(req.url ?? "");
    if ("refused" in t) {
      log("refused", { why: "target" });
      return refuse(client, 403, t.refused);
    }
    if (open >= o.maxTunnels || !tunnels.take(1)) {
      log("refused", { why: "limit" });
      return refuse(client, 429, "the egress is busy: try again shortly");
    }
    open++;
    let closed = false;
    /** The upstream connection being made, gone with the client. */
    let pending: Socket | null = null;
    const done = () => {
      if (closed) return;
      closed = true;
      open--;
      pending?.destroy();
    };
    client.once("close", done);
    // A client that ends before its tunnel is up is gone (a half close then counts as leaving: TLS clients never send
    // one before the tunnel answers): its place is freed now (the HTTP server's sockets stay half open, so its end
    // would close nothing by itself).
    let tunneled = false;
    const early = () => {
      if (!tunneled) client.destroy();
    };
    client.once("end", early);
    void (async () => {
      let addresses: Address[];
      if (isIP(t.host) !== 0) addresses = [{ address: t.host, family: isIP(t.host) }];
      else {
        try {
          addresses = await resolve(t.host);
        } catch {
          log("refused", { why: "dns" });
          return refuse(client, 502, "the host cannot be resolved");
        }
      }
      if (client.destroyed) return;
      if (addresses.length === 0) return refuse(client, 502, "the host resolves to no address");
      if (addresses.some((a) => !allow(a.address))) {
        log("refused", { why: "not_public" });
        return refuse(client, 403, "the host is not a public address: the egress reaches public hosts only");
      }
      // The addresses checked, in order: the first that answers within CONNECT_MS.
      let upstream: Socket | null = null;
      for (const a of addresses) {
        if (client.destroyed) return;
        upstream = await new Promise<Socket | null>((ok) => {
          const s = connect({ host: a.address, port: o.upstreamPort ?? 443, family: a.family });
          pending = s;
          const timer = setTimeout(() => {
            s.destroy();
            ok(null);
          }, CONNECT_MS);
          s.once("connect", () => {
            clearTimeout(timer);
            ok(s);
          });
          s.once("error", () => {
            clearTimeout(timer);
            s.destroy();
            ok(null);
          });
          s.once("close", () => {
            clearTimeout(timer);
            ok(null);
          });
        });
        pending = null;
        if (upstream !== null) break;
      }
      if (client.destroyed) return upstream?.destroy();
      if (upstream === null) return refuse(client, 502, "the host does not answer on port 443");
      const up = upstream;
      tunneled = true;
      client.off("end", early);
      up.on("error", () => client.destroy());
      client.on("error", () => up.destroy());
      up.once("close", () => client.destroy());
      client.once("close", () => up.destroy());
      // An end passes to the other side (the HTTP server's sockets stay half open until ended here).
      client.once("end", () => up.end());
      up.once("end", () => client.end());
      for (const s of [client, up]) {
        s.setTimeout(IDLE_MS, () => {
          client.destroy();
          up.destroy();
        });
      }
      // Bytes both ways count against the minute's budget of all, and of this tunnel; past either, the side that sent
      // them waits for the next minute of that budget.
      const own = new Minute(o.tunnelBytesPerMinute);
      const charge = (from: Socket, n: number) => {
        if (!own.charge(n) && !held.has(from)) {
          from.pause();
          held.add(from);
          setTimeout(() => {
            held.delete(from);
            if (!from.destroyed && free(from)) from.resume();
          }, own.left() + 10).unref();
        }
        if (!bytes.charge(n)) {
          from.pause();
          paused.add(from);
          resumeLater();
        }
      };
      const meter = (from: Socket, to: Socket) =>
        from.on("data", (chunk: Buffer) => {
          if (!to.write(chunk)) {
            from.pause();
            to.once("drain", () => {
              if (free(from)) from.resume();
            });
          }
          charge(from, chunk.length);
        });
      meter(client, up);
      meter(up, client);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        up.write(head);
        charge(client, head.length);
      }
      log("tunnel", { open });
    })().catch(() => client.destroy());
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(o.port, o.host, () => {
      server.off("error", fail);
      ok();
    });
  });
  return server;
}

function whole(name: string, fallback: number, max: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  if (!/^[1-9][0-9]{0,12}$/.test(v) || Number(v) > max) throw new Error(`${name} is a whole number from 1 to ${max}`);
  return Number(v);
}

async function main(): Promise<void> {
  const listen = process.env.OSTRA_EGRESS_LISTEN ?? "0.0.0.0:3128";
  const at = listen.lastIndexOf(":");
  const host = listen.slice(0, at);
  const port = Number(listen.slice(at + 1));
  if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("OSTRA_EGRESS_LISTEN is host:port");
  const log = (event: string, fields: Record<string, unknown> = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
  const server = await startEgress({
    host,
    port,
    maxTunnels: whole("OSTRA_EGRESS_MAX_TUNNELS", 1024, 65_536),
    tunnelsPerMinute: whole("OSTRA_EGRESS_TUNNELS_PER_MINUTE", 6000, 1_000_000),
    bytesPerMinute: whole("OSTRA_EGRESS_BYTES_PER_MINUTE", 1 << 30, 2 ** 40),
    tunnelBytesPerMinute: whole("OSTRA_EGRESS_TUNNEL_BYTES_PER_MINUTE", 1 << 26, 2 ** 40),
    // Refusals and tunnels are counted per minute in one line, never one line per request.
    log: (() => {
      const counts: Record<string, number> = {};
      setInterval(() => {
        if (Object.keys(counts).length === 0) return;
        log("egress_minute", { ...counts });
        for (const k of Object.keys(counts)) delete counts[k];
      }, 60_000).unref();
      return (event: string, fields: Record<string, unknown> = {}) => {
        const k = event === "refused" ? `refused_${String(fields.why)}` : event;
        counts[k] = (counts[k] ?? 0) + 1;
      };
    })(),
  });
  log("listening", { listen });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/** True when this module is the program node runs. */
function isEntry(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((err: unknown) => {
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), event: "fatal", message: err instanceof Error ? err.message : String(err) })}\n`);
    process.exit(1);
  });
}
