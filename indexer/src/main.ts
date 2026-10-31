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
//                             the Ostra uploader's, Pinata's, then ipfs.io; ipfs.ts)
//   OSTRA_INDEXER_IPFS_UPLOADER  an Ostra uploader on this machine (http://127.0.0.1:4800/v1/ipfs/ on the VPS):
//                             raw CIDs are read from it alone, other CIDs through the gateways (default none)
//   OSTRA_INDEXER_SOURCIFY    the Sourcify API each launched token's source is verified on (default
//                             https://sourcify.dev/server; "off": none; sourcify.ts)
//   OSTRA_PAD_INDEXER_STATE   Ostrapad's index state file (default: pad-state.json next to OSTRA_INDEXER_STATE;
//                             "off": no Ostrapad index; pad.ts)
//   OSTRA_PAD_HIDE            files of accounts the Ostrapad board leaves out, comma-separated, one address at the
//                             start of a line (Ostra's own vaults; they live on the server). Unset, or a file that
//                             cannot be read: the board is not served (pad.ts); the other Ostrapad routes are not
//                             filtered
//   OSTRA_PAD_MODERATION_URL, OSTRA_PAD_MODERATION_MODEL, OSTRA_PAD_MODERATION_KEY_FILE
//                             Ostrapad's content rules: the OpenAI-compatible API (POST <url>/chat/completions), the
//                             model and the API key file (mode 0600; never printed) each listing is checked with
//                             (moderation.ts); all three or none. Unset: listings are served unchecked
//   OSTRA_PAD_MODERATION_FALLBACK_MODEL  another provider's model on the same API, asked when the first model's
//                             provider refuses a listing under its usage policy (optional)
//   OSTRA_TIDE_LINKS          Ostra Tide's links (tide.ts), 0600 (default: tide-links.json next to
//                             OSTRA_INDEXER_STATE; off: no Tide routes)
//   OSTRA_TIDE_RESULTS        the directory of the Tide score's results (default /var/lib/ostra-tide)
//
// Logs are JSON lines on stdout, with the RPC URL replaced wherever it appears.

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROBINHOOD_PUBLIC_RPC, assertRobinhoodChain, parseDeployment, redact, robinhoodClient, type Deployment } from "@ostraagent/sdk";
import { createIndexerServer } from "./http.ts";
import { Indexer } from "./indexer.ts";
import { openAiModerator, type Moderator } from "./moderation.ts";
import { PadIndexer, hiddenListFromFiles } from "./pad.ts";
import { TideApi, tideLinkVerifier } from "./tide.ts";
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
  const uploaderText = process.env.OSTRA_INDEXER_IPFS_UPLOADER;
  const uploader = uploaderText === undefined || uploaderText === "" ? null : uploaderText.trim();
  const reader = new IpfsReader({ gateways, ...(uploader === null ? {} : { uploader }) });
  const images = new ImageStore(process.env.OSTRA_INDEXER_IMAGES || "/var/lib/ostra-indexer/images", reader);
  const sourcifyApi = process.env.OSTRA_INDEXER_SOURCIFY || SOURCIFY_API;
  const sourcify = sourcifyApi === "off" ? null : new Sourcify({ api: sourcifyApi, chainId: record.chainId });
  const indexer = new Indexer({ client, logsClient, deployment, statePath, log, readFile: (uri) => reader.json(uri), images, sourcify });
  log("sourcify", { api: sourcify === null ? "off" : new URL(sourcifyApi).host });
  log("ipfs", { uploader: uploader === null ? null : new URL(uploader).host, gateways: gateways.map((g) => new URL(g).host) });
  log("logs_rpc", { host: new URL(logsUrl).host === new URL(rpcUrl).host ? "<rpc>" : new URL(logsUrl).host });
  const padStatePath = process.env.OSTRA_PAD_INDEXER_STATE || join(dirname(statePath), "pad-state.json");
  const hideText = process.env.OSTRA_PAD_HIDE;
  const hideFiles = hideText === undefined || hideText.trim() === "" ? [] : hideText.split(",").map((f) => f.trim()).filter((f) => f !== "");
  const hidden = hideFiles.length === 0 ? () => null : hiddenListFromFiles(hideFiles, log);
  const moderation = ["OSTRA_PAD_MODERATION_URL", "OSTRA_PAD_MODERATION_MODEL", "OSTRA_PAD_MODERATION_KEY_FILE"].map((k) => process.env[k] ?? "");
  if (moderation.some((v) => v !== "") && moderation.some((v) => v === "")) throw new Error("OSTRA_PAD_MODERATION_URL, OSTRA_PAD_MODERATION_MODEL and OSTRA_PAD_MODERATION_KEY_FILE go together");
  let moderate: Moderator | null = null;
  if (moderation[0] !== "") {
    const [url, model, keyFile] = moderation as [string, string, string];
    const apiKey = privateFile(keyFile, "the moderation API key file");
    if (apiKey === "") throw new Error(`${keyFile} is empty`);
    const fallbackModel = process.env.OSTRA_PAD_MODERATION_FALLBACK_MODEL || undefined;
    moderate = openAiModerator({ url, model, apiKey, ...(fallbackModel === undefined ? {} : { fallbackModel }) });
    log("pad_moderation", { host: new URL(url).host, model, fallback: fallbackModel ?? null });
  } else {
    log("pad_moderation", { host: null });
  }
  const pad = padStatePath === "off" ? null : new PadIndexer({ client, logsClient, deployment, statePath: padStatePath, log, readFile: (uri) => reader.json(uri), hidden, moderate });
  log("pad_board", { hiddenFiles: hideFiles.length });
  const tideLinks = process.env.OSTRA_TIDE_LINKS || join(dirname(statePath), "tide-links.json");
  let tide: TideApi | null = null;
  if (tideLinks !== "off") {
    tide = new TideApi({ linksPath: tideLinks, resultsDir: process.env.OSTRA_TIDE_RESULTS || "/var/lib/ostra-tide", verify: tideLinkVerifier(client, record.chainId, record.vaultBeacon) });
    await tide.load();
  }
  log("tide", { links: tide === null ? "off" : tideLinks });
  const server = createIndexerServer(indexer, log, pad, tide);
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
