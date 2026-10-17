// Starts the aggregator: configuration, key, RPC (pinned to chain 4663 and to
// the deployment), pool, state, the pass loop and the HTTP endpoint. Stops
// cleanly on SIGINT and SIGTERM.

import { createPublicClient, type PublicClient } from "viem";
import { assertRobinhoodChain, checkDeployment, redact, retryingHttp, robinhoodChain } from "@ostraagent/sdk";
import { Aggregator } from "./aggregator.ts";
import { Sender } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { createAggregatorServer } from "./http.ts";
import { ensurePrivateDir, openAggregatorKey } from "./keys.ts";
import { StateStore } from "./store.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const transport = retryingHttp(config.rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  await checkDeployment(client, config.deployment);
  const key = await openAggregatorKey(config.secretsDir);
  await ensurePrivateDir(config.dataDir);
  const aggregator = await Aggregator.open({
    client,
    config,
    key,
    sender: new Sender(client, transport, key),
    store: new StateStore(config.dataDir),
    redact: (text) => redact(text, config.rpcUrl),
  });
  const server = createAggregatorServer(aggregator);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  const terms = aggregator.terms();
  aggregator.log("started", { chainId: terms.chainId, token: terms.token, pool: terms.pool, aggregator: terms.aggregator, listen: `${config.listen.host}:${config.listen.port}` });
  aggregator.run();

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    aggregator.log("stopping", { signal });
    server.close();
    void aggregator.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`aggregator failed to start: ${url === undefined || url === "" ? message : redact(message, url)}`);
  process.exit(1);
});
