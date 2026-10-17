// Starts the keeper: configuration, keys, RPC (pinned to chain 4663 and to
// the deployment), channel records, the watch loop and the HTTP endpoint.
// Stops cleanly on SIGINT and SIGTERM.

import { createPublicClient, type PublicClient } from "viem";
import { assertRobinhoodChain, checkDeployment, redact, retryingHttp, robinhoodChain, usdgAbi } from "@ostraagent/sdk";
import { Sender } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { createKeeperServer } from "./http.ts";
import { Keeper } from "./keeper.ts";
import { KeeperKeys, ensurePrivateDir } from "./keys.ts";
import { ChannelStore } from "./store.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const transport = retryingHttp(config.rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  await checkDeployment(client, config.deployment);
  const keys = await KeeperKeys.open(config.secretsDir, config.deployment.chainId);
  await ensurePrivateDir(config.dataDir);
  const store = new ChannelStore(config.dataDir);
  await store.init();
  const decimals = await client.readContract({ address: config.deployment.token, abi: usdgAbi, functionName: "decimals" });
  const scrub = (text: string) => redact(text, config.rpcUrl);
  let keeper: Keeper | undefined;
  const log = (event: string, fields: Record<string, unknown>) => keeper?.log(event, fields);
  const sender = new Sender(client, transport, keys.feePayer, log);
  keeper = await Keeper.open({ client, config, keys, store, sender, decimals, redact: scrub });
  const server = createKeeperServer(keeper);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  keeper.log("started", {
    chainId: config.deployment.chainId,
    token: config.deployment.token,
    feePayer: keys.feePayer.address,
    feeRecipient: config.feeRecipient,
    listen: `${config.listen.host}:${config.listen.port}`,
  });
  keeper.run();

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping || keeper === undefined) return;
    stopping = true;
    keeper.log("stopping", { signal });
    server.close();
    void keeper.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`keeper failed to start: ${url === undefined || url === "" ? message : redact(message, url)}`);
  process.exit(1);
});
