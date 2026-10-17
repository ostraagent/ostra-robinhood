// Where Ostra's contracts are on a chain: what deploy.ts writes and every
// service and client reads (the Solana program id and PDAs had this role).

import { getAddress, isAddress, type Address } from "viem";

export type Deployment = {
  version: 1;
  chainId: number;
  /** The token vaults and the pool hold (USDG). */
  token: Address;
  batchSettlement: Address;
  vaultImplementation: Address;
  vaultBeacon: Address;
  vaultFactory: Address;
  poolImplementation: Address;
  poolBeacon: Address;
  pool: Address;
  splitFactory: Address;
  /** Owner of both beacons until the Phase 4 conditions are met (then released). */
  beaconOwner: Address;
  /** Block of the first deployment transaction: services read events from here. */
  fromBlock: string;
};

const ADDRESS_FIELDS = [
  "token",
  "batchSettlement",
  "vaultImplementation",
  "vaultBeacon",
  "vaultFactory",
  "poolImplementation",
  "poolBeacon",
  "pool",
  "splitFactory",
  "beaconOwner",
] as const;

/** Parses a deployment record; throws on anything else. Addresses come back checksummed. */
export function parseDeployment(value: unknown): Deployment {
  if (typeof value !== "object" || value === null) throw new Error("a deployment must be an object");
  const v = value as Record<string, unknown>;
  if (v.version !== 1) throw new Error("unknown deployment version");
  if (typeof v.chainId !== "number" || !Number.isSafeInteger(v.chainId) || v.chainId <= 0) throw new Error("deployment chainId must be a positive integer");
  if (typeof v.fromBlock !== "string" || !/^(0|[1-9][0-9]*)$/.test(v.fromBlock)) throw new Error("deployment fromBlock must be a block number");
  const out: Record<string, unknown> = { version: 1, chainId: v.chainId, fromBlock: v.fromBlock };
  for (const field of ADDRESS_FIELDS) {
    const a = v[field];
    if (typeof a !== "string" || !isAddress(a, { strict: false })) throw new Error(`deployment ${field} is not an address`);
    out[field] = getAddress(a);
  }
  return out as Deployment;
}
