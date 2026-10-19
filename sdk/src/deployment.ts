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
  /** OstraRegistry (profiles and token metadata), which version 2 vaults write to; absent before it was deployed. */
  registry?: Address;
  /** The launchpad (deployLaunchpad), when it is deployed. */
  launchpad?: LaunchpadDeployment;
};

/** Where the Ostra launchpad's contracts are (src/launchpad/). */
export type LaunchpadDeployment = {
  hook: Address;
  fees: Address;
  launchpad: Address;
  creatorSplit: Address;
  dispatcher: Address;
  locker: Address;
  devBuy: Address;
  /** The OstraVesting implementation every dev buy's vesting clones (OstraDevBuy.VESTING). */
  vesting: Address;
  airdrop: Address;
  /** Owner of the hook, the launchpad and the dispatcher. */
  owner: Address;
};

const LAUNCHPAD_FIELDS = ["hook", "fees", "launchpad", "creatorSplit", "dispatcher", "locker", "devBuy", "vesting", "airdrop", "owner"] as const;

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
  if (v.registry !== undefined) {
    if (typeof v.registry !== "string" || !isAddress(v.registry, { strict: false })) throw new Error("deployment registry is not an address");
    out.registry = getAddress(v.registry);
  }
  if (v.launchpad !== undefined) {
    if (typeof v.launchpad !== "object" || v.launchpad === null) throw new Error("deployment launchpad must be an object");
    const l = v.launchpad as Record<string, unknown>;
    const launchpad: Record<string, unknown> = {};
    for (const field of LAUNCHPAD_FIELDS) {
      const a = l[field];
      if (typeof a !== "string" || !isAddress(a, { strict: false })) throw new Error(`deployment launchpad.${field} is not an address`);
      launchpad[field] = getAddress(a);
    }
    out.launchpad = launchpad;
  }
  return out as Deployment;
}

/** The launchpad of `d`; throws when the deployment has none. */
export function launchpadOf(d: Deployment): LaunchpadDeployment {
  if (d.launchpad === undefined) throw new Error("this deployment has no launchpad");
  return d.launchpad;
}
