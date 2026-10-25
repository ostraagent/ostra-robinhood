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
//   OSTRA_AI_URL          Ostra AI, the gateway of the ostra_ai tools
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
//   OSTRA_ETH_RPC_URL     an Ethereum mainnet RPC, for Chainlink's USDe / USD feed
//                         the strategies read before lending to a cash vault
//                         that can lend against USDe (default
//                         ETHEREUM_PUBLIC_RPC; "off": none, and then no cash
//                         goes into such a vault). Never printed
//   OSTRA_RAETO_URL       Raeto's API (default https://api.raeto.cc; "off":
//                         the raeto tool refuses to run)
//   OSTRA_PROVER          the private notes' prover: unset, the WebAssembly
//                         build of ostra-prove (the npm package carries it in
//                         dist/prover and checks the SHA-256 of its files;
//                         from source,
//                         ostra-swap privacy/wasm/pkg, or the directory
//                         OSTRA_PROVER_WASM names); a path, that native
//                         ostra-prove binary instead; "off", none. Without a
//                         prover the private tools refuse to spend
//
// The npm package sets the four service URLs to Ostra's own when they are
// not set and it runs on the deployment it carries (never with
// OSTRA_DEPLOYMENT); "off" turns one off (without the relayer the fee payer
// in OSTRA_HOME pays gas in ETH). On a fork of mainnet through OSTRA_RPC_URL
// they must be turned off: the services are mainnet's.

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROBINHOOD_PUBLIC_RPC, parseDeployment } from "@ostraagent/sdk";
import { parseSwapDeployment, type SwapDeployment } from "@ostraagent/swap";
import { RAETO_API, X402_NETWORK, type Config } from "@ostraagent/core";
import { checkPrivate } from "./disk.ts";
import { packaged, type ProverHashes } from "./packaged.ts";

/** ostra-prove as a native binary, or its WebAssembly build: a directory with ostra_prove.js and ostra_prove_bg.wasm. */
export type ProverConfig = { kind: "native"; path: string } | { kind: "wasm"; dir: string; sha256: ProverHashes | null };

/** The WebAssembly prover's files in a directory. */
export const PROVER_WASM_FILES = ["ostra_prove.js", "ostra_prove_bg.wasm"] as const;

/**
 * The prover OSTRA_PROVER chooses (see the file comment). A WebAssembly build whose files are missing is none, except
 * the npm package's own: a package without it is broken, and the server does not start.
 */
async function proverConfig(env: NodeJS.ProcessEnv): Promise<ProverConfig | null> {
  const v = env.OSTRA_PROVER;
  if (v === "off") return null;
  if (v !== undefined && v !== "") return { kind: "native", path: v };
  let dir: string;
  let sha256: ProverHashes | null = null;
  if (env.OSTRA_PROVER_WASM !== undefined && env.OSTRA_PROVER_WASM !== "") dir = env.OSTRA_PROVER_WASM;
  else if (packaged !== null) {
    dir = join(dirname(fileURLToPath(import.meta.url)), "prover");
    sha256 = packaged.prover;
  } else dir = fileURLToPath(new URL("../../../ostra-swap/privacy/wasm/pkg/", import.meta.url));
  try {
    for (const f of PROVER_WASM_FILES) await access(join(dir, f));
  } catch {
    if (sha256 !== null) throw new Error(`the package's prover is missing from ${dir}: reinstall @ostraagent/mcp`);
    return null;
  }
  return { kind: "wasm", dir, sha256 };
}

/** The Ethereum RPC the strategies read USDe's price through by default (a public one; OSTRA_ETH_RPC_URL replaces it). */
export const ETHEREUM_PUBLIC_RPC = "https://ethereum-rpc.publicnode.com";

export type McpConfig = Config & {
  home: string;
  /** Ethereum mainnet's RPC for USDe's price, or null (OSTRA_ETH_RPC_URL=off). */
  ethRpcUrl: string | null;
  /** Raeto's API, or null (OSTRA_RAETO_URL=off). */
  raetoUrl: string | null;
  /** Ostra Swap's contracts, or null (its tools then refuse to run). */
  swap: SwapDeployment | null;
  /** The RPC Ostra Swap searches events through. */
  logsRpcUrl: string;
  /** Private spends sent by the local fee payer without a relayer (OSTRA_PRIVATE_LOCAL_SPENDS=yes). */
  privateLocalSpends: boolean;
  /** The private notes' prover, or null (the private tools then refuse to spend). */
  prover: ProverConfig | null;
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
  let services: { relayerUrl: string; keeperUrl: string; aggregatorUrl: string; aiUrl?: string } | null = null;
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
  const prover = await proverConfig(env);
  const ethRpcUrl = serviceUrl(env, "OSTRA_ETH_RPC_URL", ETHEREUM_PUBLIC_RPC);
  const raetoUrl = serviceUrl(env, "OSTRA_RAETO_URL", RAETO_API);
  return {
    home,
    ethRpcUrl,
    raetoUrl,
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
    aiUrl: serviceUrl(env, "OSTRA_AI_URL", services?.aiUrl ?? null),
  };
}
