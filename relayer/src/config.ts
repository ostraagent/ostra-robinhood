// Configuration of the relayer server, read from the environment once at
// start-up.
//
//   OSTRA_RPC_URL            RPC endpoint of Robinhood Chain (chain 4663); never
//                            printed, it may carry an API key
//   OSTRA_DEPLOYMENT         path of the deployment record (sdk deployOstra):
//                            the token the relayer is paid in, the vault
//                            factory, the pool, x402BatchSettlement
//   OSTRA_KEEPER_URL         base URL of the Ostra keeper
//   OSTRA_RELAYER_VAULT      the relayer's Ostra vault: the receiverAuthorizer
//                            of its channels (a seller vault whose crank is the
//                            keeper crank of the merchant key in
//                            OSTRA_RELAYER_SECRETS)
//   OSTRA_RELAYER_SECRETS    directory (0700) of that merchant key, the
//                            facilitator key and the relayer key (keys.ts)
//   OSTRA_RELAYER_DATA       directory (0700) of the channel records, the
//                            relayer ledger, the signature escrow and the
//                            passkey backups
//   OSTRA_RELAYER_LISTEN     host:port of this server, e.g. 127.0.0.1:4300
//   OSTRA_RELAYER_CLIENT_IP  "socket" (default: the connection's address) or
//                            "cf-connecting-ip" (behind Cloudflare and a local proxy only)
//
// On Solana the relayer also read OSTRA_CLUSTER, OSTRA_MINT and OSTRA_KORA_URL:
// the chain is checked by its id, the token comes from the deployment, and
// the relayer signs and sends its own transactions (send.ts).

import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import { parseDeployment, type Deployment } from "@ostraagent/sdk";

export type RelayerConfig = {
  rpcUrl: string;
  deployment: Deployment;
  keeperUrl: string;
  vault: Address;
  secretsDir: string;
  dataDir: string;
  listen: { host: string; port: number };
  clientIp: "socket" | "cf-connecting-ip";
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

function evmAddress(text: string, name: string): Address {
  if (!isAddress(text, { strict: false })) throw new Error(`${name} is not an address`);
  return getAddress(text);
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
  if (at <= 0 || !/^[0-9]+$/.test(portText)) throw new Error("OSTRA_RELAYER_LISTEN must be host:port");
  const port = Number(portText);
  if (port < 1 || port > 65_535) throw new Error("OSTRA_RELAYER_LISTEN port must be 1..65535");
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

export function loadRelayerConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const clientIp = env.OSTRA_RELAYER_CLIENT_IP === undefined || env.OSTRA_RELAYER_CLIENT_IP === "" ? "socket" : env.OSTRA_RELAYER_CLIENT_IP;
  if (clientIp !== "socket" && clientIp !== "cf-connecting-ip") throw new Error("OSTRA_RELAYER_CLIENT_IP must be socket or cf-connecting-ip");
  return {
    rpcUrl: httpUrl(required(env, "OSTRA_RPC_URL"), "OSTRA_RPC_URL"),
    deployment: readDeployment(required(env, "OSTRA_DEPLOYMENT")),
    keeperUrl: httpUrl(required(env, "OSTRA_KEEPER_URL"), "OSTRA_KEEPER_URL"),
    vault: evmAddress(required(env, "OSTRA_RELAYER_VAULT"), "OSTRA_RELAYER_VAULT"),
    secretsDir: required(env, "OSTRA_RELAYER_SECRETS"),
    dataDir: required(env, "OSTRA_RELAYER_DATA"),
    listen: parseListen(required(env, "OSTRA_RELAYER_LISTEN")),
    clientIp,
  };
}
