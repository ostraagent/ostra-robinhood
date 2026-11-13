#!/usr/bin/env node
// Ostra Cloud's front (design 12 Nov 2026): the enclave's one published port. The dstack gateway ends TLS (in its own
// TEE) and passes the connection here; the front passes its bytes, untouched, to the remote MCP gateway (remote.ts) on
// the inner network, which has no published port and no way out but the egress. Nothing is parsed or logged here but
// the front's own start: the requests are the gateway's to read.
//
//   OSTRA_FRONT_LISTEN       host:port (default 0.0.0.0:8080)
//   OSTRA_FRONT_TARGET       host:port of the gateway (default gateway:4920)
//   OSTRA_FRONT_MAX          connections at once (default 4096)

import { connect, createServer, type Server, type Socket } from "node:net";
import { isEntry } from "./entry.ts";

/** How long a connection may stay with no byte either way: longer than a gateway session's idle time (900 s default). */
const IDLE_MS = 20 * 60_000;

function hostPort(v: string, name: string): { host: string; port: number } {
  const at = v.lastIndexOf(":");
  const host = v.slice(0, at);
  const port = Number(v.slice(at + 1));
  if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} is host:port`);
  return { host, port };
}

/** Starts the front: each connection to `listen` is piped to `target`. */
export async function startFront(o: { listen: { host: string; port: number }; target: { host: string; port: number }; max: number }): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, (client: Socket) => {
    const up = connect({ host: o.target.host, port: o.target.port, allowHalfOpen: true });
    const kill = () => {
      client.destroy();
      up.destroy();
    };
    client.on("error", kill);
    up.on("error", kill);
    client.once("close", () => up.destroy());
    up.once("close", () => client.destroy());
    client.setTimeout(IDLE_MS, kill);
    up.setTimeout(IDLE_MS, kill);
    client.pipe(up);
    up.pipe(client);
  });
  server.maxConnections = o.max;
  server.on("error", (err) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), event: "front_error", message: err.message.slice(0, 120) })}\n`));
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(o.listen.port, o.listen.host, () => {
      server.off("error", fail);
      ok();
    });
  });
  return server;
}

async function main(): Promise<void> {
  const listen = hostPort(process.env.OSTRA_FRONT_LISTEN ?? "0.0.0.0:8080", "OSTRA_FRONT_LISTEN");
  const target = hostPort(process.env.OSTRA_FRONT_TARGET ?? "gateway:4920", "OSTRA_FRONT_TARGET");
  const max = Number(process.env.OSTRA_FRONT_MAX ?? "4096");
  if (!Number.isInteger(max) || max < 1 || max > 65_536) throw new Error("OSTRA_FRONT_MAX is a whole number from 1 to 65536");
  const server = await startFront({ listen, target, max });
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), event: "listening", listen: `${listen.host}:${listen.port}` })}\n`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (isEntry("front", import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), event: "fatal", message: err instanceof Error ? err.message : String(err) })}\n`);
    process.exit(1);
  });
}
