// Starts the uploader: the Pinata JWT from OSTRA_UPLOADER_SECRETS/pinata.jwt (mode 0600), the HTTP endpoint on
// OSTRA_UPLOADER_LISTEN (default 127.0.0.1:4800), the daily byte budget OSTRA_UPLOADER_DAILY_BYTES (default
// 200 MB), the directory the files it pins or reads are kept in, OSTRA_UPLOADER_STORE (default
// /var/lib/ostra-uploader/files), and the gateways a file not kept is read from, OSTRA_UPLOADER_UPSTREAM
// (comma-separated, each an http(s) URL ending in /, tried in order; default UPSTREAM_GATEWAYS). Logs are JSON lines
// on stdout; the JWT is never printed.
//
// Ostrapad's encrypted files (enc.ts) are kept in OSTRA_UPLOADER_ENC (default /var/lib/ostra-uploader/enc), checked
// against the chain through the RPC in OSTRA_RPC_URL_FILE (never printed) and against the indexer's private-job routes
// at OSTRA_UPLOADER_INDEXER (default http://127.0.0.1:4900/api/v1/pad/private); without OSTRA_RPC_URL_FILE no
// encrypted file is taken.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPadJob, redact, robinhoodClient } from "../../sdk/src/index.ts";
import { EncStore, httpEncIndex } from "./enc.ts";
import { UPSTREAM_GATEWAYS, Uploader, createUploaderServer } from "./server.ts";

function main(): void {
  const secrets = process.env.OSTRA_UPLOADER_SECRETS || "/etc/ostra/robinhood/uploader/secrets";
  const file = join(secrets, "pinata.jwt");
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${file} must have mode 0600 (it has ${mode.toString(8)})`);
  const jwt = readFileSync(file, "utf8").trim();
  const [host, portText] = (process.env.OSTRA_UPLOADER_LISTEN || "127.0.0.1:4800").split(":");
  const port = Number(portText);
  if (host === undefined || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("OSTRA_UPLOADER_LISTEN must be host:port");
  const dailyBytes = Number(process.env.OSTRA_UPLOADER_DAILY_BYTES || 200_000_000);
  if (!Number.isInteger(dailyBytes) || dailyBytes <= 0) throw new Error("OSTRA_UPLOADER_DAILY_BYTES must be a positive whole number");
  const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }).split(jwt).join("<jwt>"));
  const store = process.env.OSTRA_UPLOADER_STORE || "/var/lib/ostra-uploader/files";
  const upstreamText = process.env.OSTRA_UPLOADER_UPSTREAM;
  const upstream = upstreamText === undefined || upstreamText.trim() === "" ? UPSTREAM_GATEWAYS : upstreamText.split(",").map((g) => g.trim());
  for (const g of upstream) if (!/^https?:\/\/[^/\s]+\/(\S*\/)?$/.test(g)) throw new Error(`OSTRA_UPLOADER_UPSTREAM: ${g} is not an http(s) URL ending in /`);
  const uploader = new Uploader({ jwt, dailyBytes, log, store, upstream });
  let enc: EncStore | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  const rpcFile = process.env.OSTRA_RPC_URL_FILE;
  if (rpcFile !== undefined && rpcFile !== "") {
    const rpc = readFileSync(rpcFile, "utf8").trim();
    const client = robinhoodClient(rpc);
    const encLog = (event: string, fields: Record<string, unknown>) => log(event, JSON.parse(redact(JSON.stringify(fields), rpc)) as Record<string, unknown>);
    enc = new EncStore({
      dir: process.env.OSTRA_UPLOADER_ENC || "/var/lib/ostra-uploader/enc",
      chain: { job: (id) => readPadJob(client, id) },
      index: httpEncIndex(process.env.OSTRA_UPLOADER_INDEXER || "http://127.0.0.1:4900/api/v1/pad/private"),
      log: encLog,
    });
    const run = () => void enc?.tick().catch((err) => encLog("enc_tick_failed", { reason: (err as Error).message.slice(0, 200) }));
    tick = setInterval(run, 60_000);
    run();
  }
  const server = createUploaderServer(uploader, log, enc);
  server.listen(port, host, () => log("started", { listen: `${host}:${port}`, dailyBytes, store, upstream: upstream.map((g) => new URL(g).host), encrypted: enc !== undefined }));
  const stop = () => {
    if (tick !== undefined) clearInterval(tick);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

try {
  main();
} catch (err) {
  console.error(`uploader failed: ${(err as Error).message}`);
  process.exit(1);
}
