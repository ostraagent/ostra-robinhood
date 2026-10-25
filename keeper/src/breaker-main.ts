// Starts the breaker keeper (breaker.ts), apart from the x402 keeper (main.ts): its own fee payer, data and service.
//
//   OSTRA_RPC_URL              RPC endpoint of Robinhood Chain (chain 4663); never printed
//   OSTRA_LOGS_RPC_URL         RPC for the breaker's events over long windows (default Robinhood Chain's public RPC)
//   OSTRA_DEPLOYMENT           the deployment record: its `breaker` (and the vault factory checkDeployment reads)
//   OSTRA_BREAKER_FROM_BLOCK   the first block to read the breaker's events from (its deployment's block)
//   OSTRA_BREAKER_SECRETS      directory (0700) of the fee payer key (fee-payer.key, created on first start, never
//                              printed); its address is logged at start, to be funded with ETH
//   OSTRA_BREAKER_DATA         directory (0700) of the event cursor and the pairs watched
//
// Stops cleanly on SIGINT and SIGTERM.

import { readFileSync } from "node:fs";
import { createPublicClient, http, type PublicClient } from "viem";
import { ROBINHOOD_PUBLIC_RPC, assertRobinhoodChain, checkDeployment, ostraBreakerAbi, parseDeployment, redact, retryingHttp, robinhoodChain } from "@ostraagent/sdk";
import { BreakerKeeper } from "./breaker.ts";
import { Sender } from "./chain.ts";
import { openFeePayer } from "./keys.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const rpcUrl = required("OSTRA_RPC_URL");
  const logsUrl = process.env.OSTRA_LOGS_RPC_URL !== undefined && process.env.OSTRA_LOGS_RPC_URL !== "" ? process.env.OSTRA_LOGS_RPC_URL : ROBINHOOD_PUBLIC_RPC;
  const deployment = parseDeployment(JSON.parse(readFileSync(required("OSTRA_DEPLOYMENT"), "utf8")));
  if (deployment.breaker === undefined) throw new Error("the deployment record has no breaker (sdk scripts/deploy-breaker.ts)");
  const fromText = required("OSTRA_BREAKER_FROM_BLOCK");
  if (!/^[0-9]+$/.test(fromText)) throw new Error("OSTRA_BREAKER_FROM_BLOCK is a block number");
  const scrub = (text: string) => redact(redact(text, rpcUrl), logsUrl);
  const log = (event: string, fields: Record<string, unknown>) => console.log(scrub(JSON.stringify({ at: new Date().toISOString(), event, ...fields })));
  const transport = retryingHttp(rpcUrl);
  // Receipts polled every 250 ms (viem's default is 4 s): trips sent one after another in a crisis stay close together.
  const client = createPublicClient({ chain: robinhoodChain, transport, pollingInterval: 250 }) as PublicClient;
  await assertRobinhoodChain(client);
  await checkDeployment(client, deployment);
  const logsClient = createPublicClient({ chain: robinhoodChain, transport: http(logsUrl, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const feePayer = await openFeePayer(required("OSTRA_BREAKER_SECRETS"));
  const sender = new Sender(client, transport, feePayer, log);
  const breaker = deployment.breaker;
  const keeper = await BreakerKeeper.open({
    client,
    logsClient,
    breaker,
    fromBlock: BigInt(fromText),
    feePayer: feePayer.address,
    trip: (p) => sender.fromFeePayer({ address: breaker, abi: ostraBreakerAbi, functionName: "trip", args: [p.vault, p.target] }),
    dataDir: required("OSTRA_BREAKER_DATA"),
    log,
  });
  log("started", { chainId: deployment.chainId, breaker, feePayer: feePayer.address, pairs: keeper.pairs.length });
  keeper.run();
  const stop = (signal: string) => {
    log("stopping", { signal });
    keeper.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`breaker keeper failed to start: ${url === undefined || url === "" ? message : redact(message, url)}`);
  process.exit(1);
});
