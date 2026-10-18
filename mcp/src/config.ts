// The MCP server's configuration, from its environment:
//
//   OSTRA_HOME            the agent's directory (0700; default ~/.ostra): the
//                         master seed, the fee payer key, the WOTS records and
//                         every other record (no secret leaves it)
//   OSTRA_DEPLOYMENT      path of the deployment record (JSON: Ostra's
//                         contracts on Robinhood Chain, the launchpad among them)
//   OSTRA_RPC_URL         Robinhood Chain RPC (default the public RPC); or
//   OSTRA_RPC_URL_FILE    a file (0600) holding it, when it carries an API key.
//                         It is never printed.
//   OSTRA_RELAYER_URL     the Ostra relayer: it sends every transaction and is
//                         paid in USDG from the vault, so the agent needs no
//                         ETH (without it the fee payer in OSTRA_HOME pays gas)
//   OSTRA_KEEPER_URL      the Ostra keeper (accept_payments)
//   OSTRA_AGGREGATOR_URL  the Ostra aggregator (shield)

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROBINHOOD_PUBLIC_RPC, parseDeployment } from "@ostraagent/sdk";
import { X402_NETWORK, type Config } from "@ostraagent/core";
import { checkPrivate } from "./disk.ts";

export type McpConfig = Config & { home: string };

function optionalUrl(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (value === undefined || value === "") return null;
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
  if (deploymentPath === undefined || deploymentPath === "") throw new Error("set OSTRA_DEPLOYMENT to the deployment record of Ostra on Robinhood Chain");
  const deployment = parseDeployment(JSON.parse(await readFile(deploymentPath, "utf8")));
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
    keeperUrl: optionalUrl(env, "OSTRA_KEEPER_URL"),
    relayerUrl: optionalUrl(env, "OSTRA_RELAYER_URL"),
    aggregatorUrl: optionalUrl(env, "OSTRA_AGGREGATOR_URL"),
    aiUrl: null,
  };
}
