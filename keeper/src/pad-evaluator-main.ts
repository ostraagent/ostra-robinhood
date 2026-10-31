// Starts Ostrapad's evaluator bot (pad-evaluator.ts), apart from the other keepers: its own fee payer, data and service.
//
//   OSTRA_RPC_URL                 RPC endpoint of Robinhood Chain (chain 4663); never printed
//   OSTRA_LOGS_RPC_URL            RPC for OstraPad's events over long windows (default Robinhood Chain's public RPC)
//   OSTRA_PAD_EVALUATOR_KEYS      the evaluator accounts' key files, comma-separated: each a 0x-prefixed private key
//                                 (a line), owned by this service's user and readable by it alone (mode 0600 or 0400)
//   OSTRA_PAD_SECRETS             directory (0700) of the fee payer key (fee-payer.key, created on first start, never
//                                 printed); its address is logged at start, to be funded with ETH
//   OSTRA_PAD_DATA                directory (0700) of the event cursor and what the bot has decided and voted
//   OSTRA_PAD_JUDGE_URL           the judge's OpenAI-compatible API base (POST <url>/chat/completions)
//   OSTRA_PAD_JUDGE_MODEL         the judge's model
//   OSTRA_PAD_JUDGE_KEY_FILE      the judge's API key file (mode 0600 or 0400; never printed)
//   OSTRA_PAD_PANEL_JUDGE_MODEL   the appeal panel's model (default OSTRA_PAD_JUDGE_MODEL): a different model, best
//                                 from another vendor, makes the panel's judgment less tied to the first evaluator's
//   OSTRA_PAD_PANEL_JUDGE_URL, OSTRA_PAD_PANEL_JUDGE_KEY_FILE
//                                 the panel's API and key when it is another provider (default the judge's). On one
//                                 API with one key, each model is the other's fallback for a request its provider
//                                 refuses under its usage policy (openAiJudge)
//   OSTRA_PAD_INDEXER_URL         Ostra's index, for a provider's offers when a job's order cannot be read (default
//                                 http://127.0.0.1:4900, the indexer on this host)
//   OSTRA_PAD_UPLOADER_URL        the Ostra uploader, for the decisions' reasons (default http://127.0.0.1:4800)
//   OSTRA_PAD_IPFS_GATEWAYS       the IPFS gateways, comma-separated, in the order they are tried (default the
//                                 Ostra uploader's /v1/ipfs/, then Pinata's public gateway, then ipfs.io)
//
// Stops cleanly on SIGINT and SIGTERM.

import { readFileSync, statSync } from "node:fs";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROBINHOOD_PUBLIC_RPC, assertRobinhoodChain, redact, retryingHttp, robinhoodChain } from "@ostraagent/sdk";
import { Sender } from "./chain.ts";
import { openFeePayer } from "./keys.ts";
import { PadEvaluator, gatewayFetch, openAiJudge } from "./pad-evaluator.ts";

/** After the Ostra uploader (OSTRA_PAD_UPLOADER_URL /v1/ipfs/, the files it pinned and keeps): the public gateways. */
const PUBLIC_GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** A secret file's text: refused unless only its owner can read it. */
function secretFile(path: string): string {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} must be readable by its owner alone (chmod 600)`);
  return readFileSync(path, "utf8").trim();
}

async function main(): Promise<void> {
  const rpcUrl = required("OSTRA_RPC_URL");
  const logsUrl = optional("OSTRA_LOGS_RPC_URL") ?? ROBINHOOD_PUBLIC_RPC;
  // A judge is required: without one the bot could only reject at the late point (it is never silent).
  const judgeUrl = required("OSTRA_PAD_JUDGE_URL");
  const judgeModel = required("OSTRA_PAD_JUDGE_MODEL");
  const panelModel = optional("OSTRA_PAD_PANEL_JUDGE_MODEL") ?? judgeModel;
  const judgeKey = secretFile(required("OSTRA_PAD_JUDGE_KEY_FILE"));
  if (judgeKey === "") throw new Error("OSTRA_PAD_JUDGE_KEY_FILE is empty");
  const panelUrl = optional("OSTRA_PAD_PANEL_JUDGE_URL") ?? judgeUrl;
  const panelKeyFile = optional("OSTRA_PAD_PANEL_JUDGE_KEY_FILE");
  const panelKey = panelKeyFile === undefined ? judgeKey : secretFile(panelKeyFile);
  if (panelKey === "") throw new Error("OSTRA_PAD_PANEL_JUDGE_KEY_FILE is empty");
  // The judge and the panel on one API with one key: each is the other's fallback when a provider refuses a request.
  const sameApi = panelUrl === judgeUrl && panelKey === judgeKey && panelModel !== judgeModel;
  const scrub = (text: string) => redact(redact(text, rpcUrl), logsUrl).split(judgeKey).join("<judge key>").split(panelKey).join("<panel key>");
  const indexerUrl = (optional("OSTRA_PAD_INDEXER_URL") ?? "http://127.0.0.1:4900").replace(/\/+$/, "");
  const log = (event: string, fields: Record<string, unknown>) => console.log(scrub(JSON.stringify({ at: new Date().toISOString(), event, ...fields })));

  const evaluators = required("OSTRA_PAD_EVALUATOR_KEYS")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((path) => {
      const key = secretFile(path);
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${path} is not a 0x-prefixed private key`);
      return privateKeyToAccount(key as `0x${string}`);
    });
  if (evaluators.length === 0) throw new Error("OSTRA_PAD_EVALUATOR_KEYS names no key file");
  if (new Set(evaluators.map((a) => a.address)).size !== evaluators.length) throw new Error("OSTRA_PAD_EVALUATOR_KEYS names the same account twice");

  const transport = retryingHttp(rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport, pollingInterval: 1_000 }) as PublicClient;
  await assertRobinhoodChain(client);
  const logsClient = createPublicClient({ chain: robinhoodChain, transport: http(logsUrl, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const feePayer = await openFeePayer(required("OSTRA_PAD_SECRETS"));
  const sender = new Sender(client, transport, feePayer, log);
  const uploader = (optional("OSTRA_PAD_UPLOADER_URL") ?? "http://127.0.0.1:4800").replace(/\/+$/, "");
  const gateways = optional("OSTRA_PAD_IPFS_GATEWAYS")?.split(",").map((g) => g.trim()).filter((g) => g !== "") ?? [`${uploader}/v1/ipfs/`, ...PUBLIC_GATEWAYS];

  const bot = await PadEvaluator.open({
    client,
    logsClient,
    evaluators,
    fromEvaluator: (account, call) => sender.fromCrank(account, call),
    fromFeePayer: (call) => sender.fromFeePayer(call),
    // A request one model's provider refuses under its usage policy goes to the other model (both on one API).
    judge: openAiJudge({ url: judgeUrl, model: judgeModel, apiKey: judgeKey, ...(sameApi ? { fallbackModel: panelModel } : {}) }),
    panelJudge: openAiJudge({ url: panelUrl, model: panelModel, apiKey: panelKey, ...(sameApi ? { fallbackModel: judgeModel } : {}) }),
    findOffers: async (provider) => {
      try {
        const res = await fetch(`${indexerUrl}/api/v1/pad/listings?provider=${provider}&limit=5`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const body = (await res.json()) as { agents?: { offers?: { id?: unknown; price?: unknown; evaluator?: unknown }[] }[] };
        return (body.agents ?? []).flatMap((a) => (a.offers ?? []).filter((o): o is { id: string; price: string; evaluator: string } => typeof o.id === "string" && typeof o.price === "string" && typeof o.evaluator === "string"));
      } catch {
        return null;
      }
    },
    fetchBytes: gatewayFetch(gateways),
    pin: async (file) => {
      try {
        const res = await fetch(`${uploader}/v1/ipfs/json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(file), signal: AbortSignal.timeout(90_000) });
        const out = (await res.json().catch(() => ({}))) as { uri?: unknown };
        return res.ok && typeof out.uri === "string" ? out.uri : null;
      } catch {
        return null;
      }
    },
    dataDir: required("OSTRA_PAD_DATA"),
    log,
  });
  log("started", {
    chainId: robinhoodChain.id,
    feePayer: feePayer.address,
    evaluators: evaluators.map((a) => getAddress(a.address)),
    judge: { host: new URL(judgeUrl).host, model: judgeModel, fallback: sameApi ? panelModel : null },
    panel: { host: new URL(panelUrl).host, model: panelModel, fallback: sameApi ? judgeModel : null },
    jobs: bot.jobs.length,
  });
  bot.run();
  const stop = (signal: string) => {
    log("stopping", { signal });
    bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`pad evaluator failed to start: ${url === undefined || url === "" ? message : redact(message, url)}`);
  process.exit(1);
});
