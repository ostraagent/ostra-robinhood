// Runtime configuration, read from the environment once at start-up, and the
// aggregator rules decided in design v0.3 (the same on Robinhood Chain, v0.4).
//
//   OSTRA_RPC_URL              RPC endpoint of Robinhood Chain (chain 4663); never
//                              printed, it may carry an API key
//   OSTRA_DEPLOYMENT           path of the deployment record (sdk deployOstra):
//                              the pool the aggregator serves and its token
//   OSTRA_AGGREGATOR_SECRETS   directory (0700) of the aggregator key: it sends
//                              createBatch, appendLeaves, sealBatch and
//                              closeBatch, and pays their gas in ETH
//   OSTRA_AGGREGATOR_DATA      directory (0700) of the aggregator state
//   OSTRA_AGGREGATOR_LISTEN    host:port of the HTTP endpoint, e.g. 127.0.0.1:4500
//                              (served to depositors through an HTTPS proxy)

import { readFileSync } from "node:fs";
import { parseDeployment, type Deployment } from "@ostraagent/sdk";

/**
 * Minimum anonymity (decided 15 Oct 2026, design v0.3): a batch is sealed
 * only with at least 8 deposits, never fewer. A deposit that never gets into
 * a sealed batch is refunded in full by cancelDeposit after
 * DEPOSIT_TIMEOUT_SECONDS (172,800 seconds, 48 hours).
 */
export const MIN_ANONYMITY_DEPOSITS = 8;

/**
 * Most deposits one batch takes. On Solana it was 56, from the 64 accounts a
 * v1 transaction may hold. On Robinhood Chain the bound is the size of the
 * sealBatch transaction: every deposit adds its 2,048-byte commitment plus
 * 96 bytes of ABI encoding (164 + 2,144 x deposits bytes of calldata), and an
 * Arbitrum sequencer queues no transaction above max-tx-data-size, 95,000
 * bytes by default. 43 deposits make 92,356 bytes of calldata and a signed
 * transaction of 92,478 bytes; 44 would be 94,622, only 378 bytes below the
 * limit (test/config.test.ts). Gas is far from the 32,000,000
 * per-transaction limit of Robinhood Chain (ArbGasInfo, read 17 Oct 2026):
 * sealBatch of 8 deposits measured 870,749 on the fork.
 */
export const MAX_DEPOSITS_PER_BATCH = 43;

/**
 * Leaves per appendLeaves transaction: 90, as on Solana. appendLeaves of 90
 * leaves measured 5,917,294 gas on the fork, well within the 32,000,000
 * per-transaction limit, so a full batch of 192 leaves takes three.
 */
export const LEAVES_PER_APPEND = 90;

/**
 * A deposit goes into a new batch only if its depositor polled within the last
 * 10 minutes (decided 15 Oct 2026: two sweeps of the MCP package, which runs
 * every 5 minutes), so a depositor that is not running does not hold a batch up.
 */
export const FRESH_SECONDS = 600;

/**
 * Every deposit of a batch must approve it within 15 minutes of the batch
 * being complete on-chain (decided 15 Oct 2026: three MCP sweeps). Otherwise
 * the batch is abandoned (closeBatch) and built again without the deposits
 * that did not approve; those go to the back of the queue and must poll again.
 */
export const APPROVAL_SECONDS = 900;

/**
 * How often the aggregator reads its deposits and batches (decided 15 Oct
 * 2026): every 30 seconds, so approvals are sealed and expired batches
 * abandoned at most 30 seconds late, as the keeper watches its channels.
 */
export const PASS_INTERVAL_MS = 30_000;

export type Config = {
  rpcUrl: string;
  deployment: Deployment;
  secretsDir: string;
  dataDir: string;
  listen: { host: string; port: number };
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

/** "host:port" with a port from 1 to 65535. */
export function parseListen(text: string): { host: string; port: number } {
  const at = text.lastIndexOf(":");
  if (at <= 0) throw new Error("OSTRA_AGGREGATOR_LISTEN must be host:port");
  const host = text.slice(0, at);
  const portText = text.slice(at + 1);
  if (!/^[0-9]+$/.test(portText)) throw new Error("OSTRA_AGGREGATOR_LISTEN must be host:port");
  const port = Number(portText);
  if (port < 1 || port > 65_535) throw new Error("OSTRA_AGGREGATOR_LISTEN port must be 1..65535");
  return { host, port };
}

function readDeployment(path: string): Deployment {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`OSTRA_DEPLOYMENT ${path} could not be read: ${(err as Error).message}`);
  }
  return parseDeployment(json);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rpcUrl = required(env, "OSTRA_RPC_URL");
  const deployment = readDeployment(required(env, "OSTRA_DEPLOYMENT"));
  return {
    rpcUrl,
    deployment,
    secretsDir: required(env, "OSTRA_AGGREGATOR_SECRETS"),
    dataDir: required(env, "OSTRA_AGGREGATOR_DATA"),
    listen: parseListen(required(env, "OSTRA_AGGREGATOR_LISTEN")),
  };
}
