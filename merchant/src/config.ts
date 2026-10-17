// Configuration of the reference seller server (server.ts), read from the
// environment once at start-up.
//
//   OSTRA_RPC_URL            RPC endpoint of Robinhood Chain (chain 4663); never
//                            printed, it may carry an API key
//   OSTRA_DEPLOYMENT         path of the deployment record (sdk deployOstra):
//                            the token the seller is paid in, the vault and
//                            split factories, x402BatchSettlement
//   OSTRA_MERCHANT_SECRETS   directory (0700) of the merchant key and the
//                            facilitator key
//   OSTRA_MERCHANT_DATA      directory (0700) of the channel records
//   OSTRA_MERCHANT_VAULT     the seller's Ostra vault (the channels'
//                            receiverAuthorizer)
//   OSTRA_KEEPER_URL         base URL of the Ostra keeper
//   OSTRA_MERCHANT_LISTEN    host:port of this server, e.g. 127.0.0.1:4200
//   OSTRA_MERCHANT_PRICE     price per paid request, in base units of the token
//   OSTRA_MERCHANT_DEPOSIT   deposit suggested to buyers, in base units
//                            (optional; the x402 extra.minDeposit)
//   OSTRA_MERCHANT_SPLITS    splits the seller adds after the keeper fee, as JSON
//                            [{"recipient": "<address>", "bps": <1..10000>}] (optional)
//   OSTRA_MERCHANT_GRACE_SECONDS  withdraw delay of new channels; at least the
//                            keeper's minimum, which is the default (optional)
// The MCP tool accept_payments returns these settings for this server.

import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import { X402_MAX_WITHDRAW_DELAY, parseDeployment, type Deployment } from "@ostraagent/sdk";

export type MerchantConfig = {
  rpcUrl: string;
  deployment: Deployment;
  secretsDir: string;
  dataDir: string;
  vault: Address;
  keeperUrl: string;
  listen: { host: string; port: number };
  price: bigint;
  suggestedDeposit: bigint | undefined;
  extraSplits: { recipient: Address; bps: number }[];
  gracePeriodSeconds: number | undefined;
};

const U128_MAX = (1n << 128n) - 1n;

function evmAddress(text: string, name: string): Address {
  if (!isAddress(text, { strict: false })) throw new Error(`${name} is not an address`);
  return getAddress(text);
}

/** OSTRA_MERCHANT_SPLITS: shape only; merchant.ts checks them with the keeper fee against OstraSplit's rules. */
export function parseSplitsEnv(text: string | undefined): { recipient: Address; bps: number }[] {
  if (text === undefined || text === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("OSTRA_MERCHANT_SPLITS is not JSON");
  }
  if (!Array.isArray(value)) throw new Error("OSTRA_MERCHANT_SPLITS must be a JSON array of { recipient, bps }");
  return value.map((entry: unknown, i) => {
    const e = entry as { recipient?: unknown; bps?: unknown } | null;
    if (e === null || typeof e !== "object" || typeof e.recipient !== "string" || typeof e.bps !== "number") {
      throw new Error(`OSTRA_MERCHANT_SPLITS[${i}] must be { recipient, bps }`);
    }
    return { recipient: evmAddress(e.recipient, `OSTRA_MERCHANT_SPLITS[${i}].recipient`), bps: e.bps };
  });
}

/** A withdraw delay x402BatchSettlement accepts (at most 30 days); merchant.ts checks the keeper's minimum. */
function graceSeconds(text: string | undefined): number | undefined {
  if (text === undefined || text === "") return undefined;
  if (!/^[1-9][0-9]{0,6}$/.test(text) || Number(text) > X402_MAX_WITHDRAW_DELAY) {
    throw new Error(`OSTRA_MERCHANT_GRACE_SECONDS must be a whole number of seconds from 1 to ${X402_MAX_WITHDRAW_DELAY}`);
  }
  return Number(text);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

/** A positive amount in base units that fits a uint128 (x402BatchSettlement amounts). */
function baseUnits(text: string, name: string): bigint {
  if (!/^[1-9][0-9]{0,38}$/.test(text)) throw new Error(`${name} must be a positive integer in base units`);
  const n = BigInt(text);
  if (n > U128_MAX) throw new Error(`${name} does not fit in a uint128`);
  return n;
}

function httpUrl(text: string, name: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be an http or https URL`);
  return text;
}

export function parseListen(text: string): { host: string; port: number } {
  const at = text.lastIndexOf(":");
  const portText = text.slice(at + 1);
  if (at <= 0 || !/^[0-9]+$/.test(portText)) throw new Error("OSTRA_MERCHANT_LISTEN must be host:port");
  const port = Number(portText);
  if (port < 1 || port > 65_535) throw new Error("OSTRA_MERCHANT_LISTEN port must be 1..65535");
  return { host: text.slice(0, at), port };
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

export function loadMerchantConfig(env: NodeJS.ProcessEnv = process.env): MerchantConfig {
  const deposit = env.OSTRA_MERCHANT_DEPOSIT;
  return {
    rpcUrl: httpUrl(required(env, "OSTRA_RPC_URL"), "OSTRA_RPC_URL"),
    deployment: readDeployment(required(env, "OSTRA_DEPLOYMENT")),
    secretsDir: required(env, "OSTRA_MERCHANT_SECRETS"),
    dataDir: required(env, "OSTRA_MERCHANT_DATA"),
    vault: evmAddress(required(env, "OSTRA_MERCHANT_VAULT"), "OSTRA_MERCHANT_VAULT"),
    keeperUrl: httpUrl(required(env, "OSTRA_KEEPER_URL"), "OSTRA_KEEPER_URL"),
    listen: parseListen(required(env, "OSTRA_MERCHANT_LISTEN")),
    price: baseUnits(required(env, "OSTRA_MERCHANT_PRICE"), "OSTRA_MERCHANT_PRICE"),
    suggestedDeposit: deposit === undefined || deposit === "" ? undefined : baseUnits(deposit, "OSTRA_MERCHANT_DEPOSIT"),
    extraSplits: parseSplitsEnv(env.OSTRA_MERCHANT_SPLITS),
    gracePeriodSeconds: graceSeconds(env.OSTRA_MERCHANT_GRACE_SECONDS),
  };
}
