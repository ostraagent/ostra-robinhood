// Runtime configuration, read from the environment once at start-up, and the
// keeper rules decided in design v0.3 (the same on Robinhood Chain, v0.4).
//
//   OSTRA_RPC_URL            RPC endpoint of Robinhood Chain (chain 4663); never
//                            printed, it may carry an API key
//   OSTRA_DEPLOYMENT         path of the deployment record (sdk deployOstra):
//                            the token, the vault factory and the split factory
//   OSTRA_KEEPER_SECRETS     directory (0700) of the keeper keys: the crank
//                            master seed and the fee payer key
//   OSTRA_KEEPER_DATA        directory (0700) of the channel records
//   OSTRA_KEEPER_LISTEN      host:port of the HTTP endpoint, e.g. 127.0.0.1:4100
//                            (served to sellers through an HTTPS proxy)
//   OSTRA_KEEPER_FEE_RECIPIENT  the Ostra operator vault that receives the
//                            keeper fee share of every guarded channel

import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import { parseDeployment, type Deployment } from "@ostraagent/sdk";

/**
 * Settle threshold (decided 14 Oct 2026, design v0.3): an open channel's
 * voucher is claimed once its unclaimed amount reaches 1 token (1 USDG) or the
 * oldest unclaimed voucher is 1 hour old.
 */
export const SETTLE_THRESHOLD_TOKENS = 1n;
export const SETTLE_MAX_AGE_SECONDS = 60 * 60;

/**
 * How often the keeper reads the channels it guards (decided 14 Oct 2026,
 * design v0.3): every 30 seconds, so a buyer's close request (initiateWithdraw)
 * is seen at most 30 seconds late and more than 14 minutes of the 15-minute
 * minimum withdraw delay remain to claim the last voucher.
 */
export const WATCH_INTERVAL_MS = 30_000;

/**
 * Voucher endpoint rate limits (decided 14 Oct 2026, design v0.3): 10
 * requests per second per channel, and 20 channels per second not seen before
 * (each costs RPC reads) across every seller.
 */
export const VOUCHERS_PER_SECOND_PER_CHANNEL = 10;
export const NEW_CHANNELS_PER_SECOND = 20;

/**
 * Keeper fee (decided 14 Oct 2026, design v0.3): a 30 bps share to the Ostra
 * operator vault in the split of every channel the keeper guards.
 */
export const KEEPER_FEE_BPS = 30;

/**
 * Minimum withdraw delay (grace period) of a seller's channel (decided 14 Oct
 * 2026, design v0.3): 15 minutes, so the keeper and the seller have time to
 * act after a buyer asks to close.
 */
export const MIN_GRACE_SECONDS = 900;

export type Config = {
  rpcUrl: string;
  deployment: Deployment;
  secretsDir: string;
  dataDir: string;
  listen: { host: string; port: number };
  /** Ostra operator vault receiving the keeper fee share. */
  feeRecipient: Address;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

/** "host:port" with a port from 1 to 65535. */
export function parseListen(text: string): { host: string; port: number } {
  const at = text.lastIndexOf(":");
  if (at <= 0) throw new Error("OSTRA_KEEPER_LISTEN must be host:port");
  const host = text.slice(0, at);
  const portText = text.slice(at + 1);
  if (!/^[0-9]+$/.test(portText)) throw new Error("OSTRA_KEEPER_LISTEN must be host:port");
  const port = Number(portText);
  if (port < 1 || port > 65_535) throw new Error("OSTRA_KEEPER_LISTEN port must be 1..65535");
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
  const feeRecipient = required(env, "OSTRA_KEEPER_FEE_RECIPIENT");
  if (!isAddress(feeRecipient, { strict: false })) throw new Error("OSTRA_KEEPER_FEE_RECIPIENT is not an address");
  return {
    rpcUrl,
    deployment,
    secretsDir: required(env, "OSTRA_KEEPER_SECRETS"),
    dataDir: required(env, "OSTRA_KEEPER_DATA"),
    listen: parseListen(required(env, "OSTRA_KEEPER_LISTEN")),
    feeRecipient: getAddress(feeRecipient),
  };
}
