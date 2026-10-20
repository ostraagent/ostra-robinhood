// One buyback run (buyback.ts), as the hourly timer starts it
// (ops/systemd/ostra-buyback.timer). Configuration, from the environment:
//
//   OSTRA_RPC_URL_FILE        file (0600) holding the RPC URL (default
//                             /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYMENT          path of the mainnet deployment record
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the 32-byte hex private key of
//                             OstraDispatcher's owner (default
//                             /etc/ostra/deployer.key); never printed
//   OSTRA_BUYBACK_STATE       the run's state file (default
//                             /var/lib/ostra-buyback/state.json)
//   OSTRA_BUYBACK_MIN_USD     the least a currency's buyback share must be
//                             worth to be claimed, in US dollars (default 1)
//
// Every line it prints is one JSON event, with the RPC URL redacted. It exits
// 0 after a run, 1 when a check or a transaction failed.

import { readFileSync, statSync } from "node:fs";
import { createPublicClient, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseDeployment, redact, retryingHttp, robinhoodChain } from "@ostraagent/sdk";
import { parseUsd, runBuyback } from "./buyback.ts";

function privateFile(path: string, what: string): string {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} must have mode 0600 (it has ${mode.toString(8)})`);
  return readFileSync(path, "utf8").trim();
}

async function main(): Promise<void> {
  const rpcUrl = privateFile(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(redact(JSON.stringify({ at: new Date().toISOString(), event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), rpcUrl));
  try {
    const recordPath = process.env.OSTRA_DEPLOYMENT;
    if (recordPath === undefined || recordPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
    const deployment = parseDeployment(JSON.parse(readFileSync(recordPath, "utf8")));
    const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
    const key = privateFile(keyFile, "the deployer key file");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
    const account = privateKeyToAccount(key as `0x${string}`);
    const transport = retryingHttp(rpcUrl);
    const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
    log("start", { account: account.address });
    await runBuyback({
      client,
      transport,
      account,
      deployment,
      statePath: process.env.OSTRA_BUYBACK_STATE || "/var/lib/ostra-buyback/state.json",
      minUsdE6: parseUsd(process.env.OSTRA_BUYBACK_MIN_USD || "1"),
      log,
    });
  } catch (err) {
    log("failed", { reason: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  }
}

await main();
