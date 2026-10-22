// The MCP server's configuration, from its environment:
//
//   OSTRA_HOME            the agent's directory (0700; default ~/.ostra): the
//                         master seed, the fee payer key, the WOTS records and
//                         every other record (no secret leaves it)
//   OSTRA_DEPLOYMENT      path of the deployment record (JSON: Ostra's
//                         contracts on Robinhood Chain, the launchpad among them);
//                         the npm package carries mainnet's (packaged.ts)
//   OSTRA_RPC_URL         Robinhood Chain RPC (default the public RPC); or
//   OSTRA_RPC_URL_FILE    a file (0600) holding it, when it carries an API key.
//                         It is never printed.
//   OSTRA_RELAYER_URL     the Ostra relayer: it sends every transaction and is
//                         paid in USDG from the vault, so the agent needs no
//                         ETH (without it the fee payer in OSTRA_HOME pays gas)
//   OSTRA_KEEPER_URL      the Ostra keeper (accept_payments)
//   OSTRA_AGGREGATOR_URL  the Ostra aggregator (shield)
//   OSTRA_SWAP_DEPLOYMENT path of Ostra Swap's deployment record (JSON:
//                         its router, stake and private pool); the npm
//                         package carries mainnet's once it is deployed.
//                         Without one the Ostra Swap tools refuse to run
//   OSTRA_LOGS_RPC_URL    Robinhood Chain RPC for Ostra Swap's event
//                         searches (Uniswap pools for routes, the private
//                         pool's trees): default the public RPC, which serves
//                         wide eth_getLogs windows. Never printed either
//   OSTRA_PRIVATE_LOCAL_SPENDS  "yes": without a relayer, private spends are
//                         sent by the fee payer in OSTRA_HOME, which links
//                         them to the agent (tests and forks); otherwise they
//                         are refused without a relayer
//   OSTRA_PROVER          path of the ostra-prove binary (the private
//                         notes' prover, ostra-swap privacy/); without it the
//                         private tools refuse to run
//
// The npm package sets the three service URLs to Ostra's own when they are
// not set and it runs on the deployment it carries (never with
// OSTRA_DEPLOYMENT); "off" turns one off (without the relayer the fee payer
// in OSTRA_HOME pays gas in ETH). On a fork of mainnet through OSTRA_RPC_URL
// they must be turned off: the services are mainnet's.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROBINHOOD_PUBLIC_RPC, parseDeployment } from "@ostraagent/sdk";
import { parseSwapDeployment, type SwapDeployment } from "@ostraagent/swap";
import { X402_NETWORK, type Config } from "@ostraagent/core";
import { checkPrivate } from "./disk.ts";
import { packaged } from "./packaged.ts";

export type McpConfig = Config & {
  home: string;
  /** Ostra Swap's contracts, or null (its tools then refuse to run). */
  swap: SwapDeployment | null;
  /** The RPC Ostra Swap searches events through. */
  logsRpcUrl: string;
  /** Private spends sent by the local fee payer without a relayer (OSTRA_PRIVATE_LOCAL_SPENDS=yes). */
  privateLocalSpends: boolean;
  /** The ostra-prove binary, or null (the private tools then refuse to run). */
  prover: string | null;
};

function serviceUrl(env: NodeJS.ProcessEnv, name: string, fallback: string | null): string | null {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "off") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must be an http(s) URL`);
  return value.replace(/\/+$/, "");
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<McpConfig> {
  const home = env.OSTRA_HOME !== undefined && env.OSTRA_HOME !== "" ? env.OSTRA_HOME : join(homedir(), ".ostra");
  const deploymentPath = env.OSTRA_DEPLOYMENT;
  let record: unknown;
  // Ostra's services are the defaults on the packaged mainnet deployment only.
  let services: { relayerUrl: string; keeperUrl: string; aggregatorUrl: string } | null = null;
  if (deploymentPath !== undefined && deploymentPath !== "") record = JSON.parse(await readFile(deploymentPath, "utf8"));
  else if (packaged !== null) {
    record = packaged.deployment;
    services = packaged;
  } else throw new Error("set OSTRA_DEPLOYMENT to the deployment record of Ostra on Robinhood Chain");
  const deployment = parseDeployment(record);
  let rpcUrl = env.OSTRA_RPC_URL !== undefined && env.OSTRA_RPC_URL !== "" ? env.OSTRA_RPC_URL : null;
  const rpcFile = env.OSTRA_RPC_URL_FILE;
  if (rpcFile !== undefined && rpcFile !== "") {
    if (rpcUrl !== null) throw new Error("set OSTRA_RPC_URL or OSTRA_RPC_URL_FILE, not both");
    await checkPrivate(rpcFile);
    rpcUrl = (await readFile(rpcFile, "utf8")).trim();
  }
  let swap: SwapDeployment | null = null;
  const swapPath = env.OSTRA_SWAP_DEPLOYMENT;
  if (swapPath !== undefined && swapPath !== "") swap = parseSwapDeployment(JSON.parse(await readFile(swapPath, "utf8")));
  else if (services !== null && packaged !== null && packaged.swapDeployment !== null && packaged.swapDeployment !== undefined) swap = parseSwapDeployment(packaged.swapDeployment);
  if (swap !== null && swap.chainId !== deployment.chainId) throw new Error(`Ostra Swap's deployment is of chain ${swap.chainId}, not ${deployment.chainId}`);
  const logsRpcUrl = env.OSTRA_LOGS_RPC_URL !== undefined && env.OSTRA_LOGS_RPC_URL !== "" ? env.OSTRA_LOGS_RPC_URL : ROBINHOOD_PUBLIC_RPC;
  const prover = env.OSTRA_PROVER !== undefined && env.OSTRA_PROVER !== "" ? env.OSTRA_PROVER : null;
  return {
    home,
    swap,
    logsRpcUrl,
    privateLocalSpends: env.OSTRA_PRIVATE_LOCAL_SPENDS === "yes",
    prover,
    chainId: deployment.chainId,
    rpcUrl: rpcUrl ?? ROBINHOOD_PUBLIC_RPC,
    deployment,
    x402Network: X402_NETWORK,
    keeperUrl: serviceUrl(env, "OSTRA_KEEPER_URL", services?.keeperUrl ?? null),
    relayerUrl: serviceUrl(env, "OSTRA_RELAYER_URL", services?.relayerUrl ?? null),
    aggregatorUrl: serviceUrl(env, "OSTRA_AGGREGATOR_URL", services?.aggregatorUrl ?? null),
    aiUrl: null,
  };
}
