// Starts the indexer.
//
//   OSTRA_DEPLOYMENT          the deployment record (read again on every scan)
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_INDEXER_LOGS_RPC    the RPC eth_getLogs goes to (default Robinhood Chain's public RPC, which serves
//                             wide block ranges; a free Alchemy plan serves 10 blocks a request)
//   OSTRA_INDEXER_LISTEN      host:port of the HTTP API (default 127.0.0.1:4900)
//   OSTRA_INDEXER_STATE       the state file (default /var/lib/ostra-indexer/state.json)
//   OSTRA_INDEXER_EVERY_MS    time between scans (default 3000)
//   OSTRA_INDEXER_IMAGES      the directory the images of metadata and profiles are kept in (default
//                             /var/lib/ostra-indexer/images)
//   OSTRA_INDEXER_IPFS_GATEWAYS  the IPFS gateways, comma-separated, in the order they are tried (default
//                             Pinata's, then ipfs.io; ipfs.ts)
//   OSTRA_INDEXER_SOURCIFY    the Sourcify API each launched token's source is verified on (default
//                             https://sourcify.dev/server; "off": none; sourcify.ts)
//   OSTRA_PAD_INDEXER_STATE   Ostrapad's index state file (default: pad-state.json next to OSTRA_INDEXER_STATE;
//                             "off": no Ostrapad index; pad.ts)
//
// Logs are JSON lines on stdout, with the RPC URL replaced wherever it appears.

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROBINHOOD_PUBLIC_RPC, assertRobinhoodChain, parseDeployment, redact, robinhoodClient, type Deployment } from "@ostraagent/sdk";
import { createIndexerServer } from "./http.ts";
import { Indexer } from "./indexer.ts";
import { PadIndexer } from "./pad.ts";
import { IPFS_GATEWAYS, ImageStore, IpfsReader } from "./ipfs.ts";
import { SOURCIFY_API, Sourcify } from "./sourcify.ts";

function privateFile(path: string, what: string): string {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} must have mode 0600 (it has ${mode.toString(8)})`);
  return readFileSync(path, "utf8").trim();
}

async function main(): Promise<void> {
  const recordPath = process.env.OSTRA_DEPLOYMENT;
  if (recordPath === undefined || recordPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const rpcUrl = privateFile(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  const [host, portText] = (process.env.OSTRA_INDEXER_LISTEN || "127.0.0.1:4900").split(":");
  const port = Number(portText);
  if (host === undefined || host === "" || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("OSTRA_INDEXER_LISTEN must be host:port");
  const statePath = process.env.OSTRA_INDEXER_STATE || "/var/lib/ostra-indexer/state.json";
  const everyMs = Number(process.env.OSTRA_INDEXER_EVERY_MS || 3_000);
  if (!Number.isInteger(everyMs) || everyMs < 500) throw new Error("OSTRA_INDEXER_EVERY_MS must be a whole number of at least 500");
  const log = (event: string, fields: Record<string, unknown> = {}) => console.log(redact(JSON.stringify({ at: new Date().toISOString(), event, ...fields }), rpcUrl));
  try {
    await run({ recordPath, rpcUrl, host, port, statePath, everyMs, log });
  } catch (err) {
    throw new Error(redact((err as Error).message, rpcUrl));
  }
}

async function run(o: { recordPath: string; rpcUrl: string; host: string; port: number; statePath: string; everyMs: number; log: (event: string, fields?: Record<string, unknown>) => void }): Promise<void> {
  const { recordPath, rpcUrl, host, port, statePath, everyMs, log } = o;

  let record: Deployment = parseDeployment(JSON.parse(readFileSync(recordPath, "utf8")));
  let recordMtime = statSync(recordPath).mtimeMs;
  const deployment = (): Deployment => {
    try {
      const m = statSync(recordPath).mtimeMs;
      if (m !== recordMtime) {
        record = parseDeployment(JSON.parse(readFileSync(recordPath, "utf8")));
        recordMtime = m;
        log("deployment_reloaded", { registry: record.registry ?? null });
      }
    } catch (err) {
      log("deployment_reload_failed", { reason: (err as Error).message.slice(0, 200) });
    }
    return record;
  };
  const client = robinhoodClient(rpcUrl);
  await assertRobinhoodChain(client);
  const logsUrl = process.env.OSTRA_INDEXER_LOGS_RPC || ROBINHOOD_PUBLIC_RPC;
  const logsClient = robinhoodClient(logsUrl);
  await assertRobinhoodChain(logsClient);
  if (record.chainId !== (await client.getChainId())) throw new Error(`${recordPath} is a deployment on chain ${record.chainId}`);
  const gatewaysText = process.env.OSTRA_INDEXER_IPFS_GATEWAYS;
  const gateways = gatewaysText === undefined || gatewaysText === "" ? IPFS_GATEWAYS : gatewaysText.split(",").map((g) => g.trim());
  const reader = new IpfsReader({ gateways });
  const images = new ImageStore(process.env.OSTRA_INDEXER_IMAGES || "/var/lib/ostra-indexer/images", reader);
  const sourcifyApi = process.env.OSTRA_INDEXER_SOURCIFY || SOURCIFY_API;
  const sourcify = sourcifyApi === "off" ? null : new Sourcify({ api: sourcifyApi, chainId: record.chainId });
  const indexer = new Indexer({ client, logsClient, deployment, statePath, log, readFile: (uri) => reader.json(uri), images, sourcify });
  log("sourcify", { api: sourcify === null ? "off" : new URL(sourcifyApi).host });
  log("ipfs", { gateways: gateways.map((g) => new URL(g).host) });
  log("logs_rpc", { host: new URL(logsUrl).host === new URL(rpcUrl).host ? "<rpc>" : new URL(logsUrl).host });
  const padStatePath = process.env.OSTRA_PAD_INDEXER_STATE || join(dirname(statePath), "pad-state.json");
  const pad = padStatePath === "off" ? null : new PadIndexer({ client, logsClient, deployment, statePath: padStatePath, log, readFile: (uri) => reader.json(uri) });
  const server = createIndexerServer(indexer, log, pad);
  server.listen(port, host, () => log("started", { listen: `${host}:${port}`, statePath, everyMs, scannedTo: indexer.scannedTo.toString(), pad: pad === null ? "off" : padStatePath }));
  indexer.start(everyMs);
  // Ostrapad's index: its own scans, a few seconds apart (its files and records are read again every few minutes).
  pad?.start(Math.max(everyMs, 5_000));
  const stop = () => {
    indexer.stop();
    pad?.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error(`indexer failed: ${(err as Error).message}`);
  process.exit(1);
});
