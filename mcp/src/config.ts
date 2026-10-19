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
import { X402_NETWORK, type Config } from "@ostraagent/core";
import { checkPrivate } from "./disk.ts";
import { packaged } from "./packaged.ts";

export type McpConfig = Config & { home: string };

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
  return {
    home,
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
