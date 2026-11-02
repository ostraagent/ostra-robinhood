// Starts the venue breaker keeper (venue-breaker.ts), apart from the other keepers: its own fee payer, data and service.
//
//   OSTRA_RPC_URL                    RPC endpoint of Robinhood Chain (chain 4663); never printed
//   OSTRA_LOGS_RPC_URL               RPC for the Entered events over long windows (default Robinhood Chain's public RPC)
//   OSTRA_DEPLOYMENT                 the deployment record: one whose vaults run version 4 (its vaultModuleV4)
//   OSTRA_VENUE_BREAKER_FROM_BLOCK   the first block to read Entered events from (the version 4 upgrade's block)
//   OSTRA_VENUE_BREAKER_SECRETS      directory (0700) of the fee payer key (fee-payer.key, 0600, created on first start,
//                                    never printed); its address is logged at start, to be funded with ETH
//   OSTRA_VENUE_BREAKER_DATA         directory (0700) of the event cursor and the positions found
//
//   node src/venue-breaker-main.ts         the service: reads and trips until SIGINT or SIGTERM
//   node src/venue-breaker-main.ts once    one read of the events and one tick, then exits; the last line is
//                                          VENUE_BREAKER_ONCE <trips sent> <trips failed>

import { readFileSync } from "node:fs";
import { createPublicClient, http, type Abi, type PublicClient } from "viem";
import { ROBINHOOD_PUBLIC_RPC, assertRobinhoodChain, checkDeployment, ostraVaultAbi, ostraVaultModuleV4Abi, parseDeployment, redact, retryingHttp, robinhoodChain } from "@ostraagent/sdk";
import { Sender } from "./chain.ts";
import { openFeePayer } from "./keys.ts";
import { TRIP_GAS_CAP, VenueBreakerKeeper } from "./venue-breaker.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const once = process.argv[2] === "once";
  if (process.argv[2] !== undefined && !once) throw new Error("usage: node src/venue-breaker-main.ts [once]");
  const rpcUrl = required("OSTRA_RPC_URL");
  const logsUrl = process.env.OSTRA_LOGS_RPC_URL !== undefined && process.env.OSTRA_LOGS_RPC_URL !== "" ? process.env.OSTRA_LOGS_RPC_URL : ROBINHOOD_PUBLIC_RPC;
  const deployment = parseDeployment(JSON.parse(readFileSync(required("OSTRA_DEPLOYMENT"), "utf8")));
  if (deployment.vaultModuleV4 === undefined) throw new Error("the deployment record names no vaultModuleV4: the venue breaker runs once the vaults run version 4 (sdk scripts/upgrade-vault.ts finalize)");
  const fromText = required("OSTRA_VENUE_BREAKER_FROM_BLOCK");
  if (!/^[0-9]+$/.test(fromText)) throw new Error("OSTRA_VENUE_BREAKER_FROM_BLOCK is a block number");
  const scrub = (text: string) => redact(redact(text, rpcUrl), logsUrl);
  const log = (event: string, fields: Record<string, unknown>) => console.log(scrub(JSON.stringify({ at: new Date().toISOString(), event, ...fields })));
  const transport = retryingHttp(rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport, pollingInterval: 250 }) as PublicClient;
  await assertRobinhoodChain(client);
  await checkDeployment(client, deployment);
  const logsClient = createPublicClient({ chain: robinhoodChain, transport: http(logsUrl, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const feePayer = await openFeePayer(required("OSTRA_VENUE_BREAKER_SECRETS"));
  const sender = new Sender(client, transport, feePayer, log);
  // The module's errors (Healthy, InLoss, NotEnabled) name a trip the vault refuses.
  const tripAbi = [...ostraVaultAbi, ...ostraVaultModuleV4Abi.filter((x) => x.type === "error")] as Abi;
  const keeper = await VenueBreakerKeeper.open({
    client,
    logsClient,
    deployment,
    fromBlock: BigInt(fromText),
    feePayer: feePayer.address,
    trip: (p, amount) => sender.fromFeePayer({ address: p.vault, abi: tripAbi, functionName: "tripVenue", args: [p.kind, p.venue, amount] }, TRIP_GAS_CAP[p.kind]),
    dataDir: required("OSTRA_VENUE_BREAKER_DATA"),
    log,
  });
  log("started", { chainId: deployment.chainId, feePayer: feePayer.address, eth: (await client.getBalance({ address: feePayer.address })).toString(), positions: keeper.positions.length, once });
  if (once) {
    await keeper.refreshPositions();
    const r = await keeper.tick();
    console.log(`VENUE_BREAKER_ONCE ${r.filter((x) => x.tx !== undefined).length} ${r.filter((x) => x.error !== undefined).length}`);
    return;
  }
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
  console.error(`venue breaker keeper failed: ${url === undefined || url === "" ? message : redact(message, url)}`);
  process.exit(1);
});
