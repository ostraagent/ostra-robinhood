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
  /** OstraVaultModule, which version 3 vaults run their version 3 spends in; absent while the vaults run version 2. */
  vaultModule?: Address;
  /** OstraVaultModuleV4, which version 4 vaults run their version 4 spends in; absent while the vaults run version 3 or below. */
  vaultModuleV4?: Address;
  /** OstraVaultModuleV5, which version 5 vaults run their version 5 spends in; absent while the vaults run version 4 or below. */
  vaultModuleV5?: Address;
  /** OstraBreaker (Strategy 3), which serves version 3 vaults; absent before it was deployed. */
  breaker?: Address;
  /** The launchpad (deployLaunchpad), when it is deployed. */
  launchpad?: LaunchpadDeployment;
  /** OstraReputation (ostra-swap src/OstraReputation.sol, reputation.ts); absent until it is deployed. */
  reputation?: ReputationDeployment;
};

/** Where OstraReputation is: its address and the block it was deployed in (its Snapshot and Recorded logs start there). */
export type ReputationDeployment = { address: Address; fromBlock: string };

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
  if (v.vaultModule !== undefined) {
    if (typeof v.vaultModule !== "string" || !isAddress(v.vaultModule, { strict: false })) throw new Error("deployment vaultModule is not an address");
    if (v.registry === undefined) throw new Error("a deployment with a vaultModule has a registry");
    out.vaultModule = getAddress(v.vaultModule);
  }
  if (v.breaker !== undefined) {
    if (typeof v.breaker !== "string" || !isAddress(v.breaker, { strict: false })) throw new Error("deployment breaker is not an address");
    if (v.vaultModule === undefined) throw new Error("a deployment with a breaker has a vaultModule");
    out.breaker = getAddress(v.breaker);
  }
  if (v.vaultModuleV4 !== undefined) {
    if (typeof v.vaultModuleV4 !== "string" || !isAddress(v.vaultModuleV4, { strict: false })) throw new Error("deployment vaultModuleV4 is not an address");
    if (v.vaultModule === undefined) throw new Error("a deployment with a vaultModuleV4 has a vaultModule");
    out.vaultModuleV4 = getAddress(v.vaultModuleV4);
  }
  if (v.vaultModuleV5 !== undefined) {
    if (typeof v.vaultModuleV5 !== "string" || !isAddress(v.vaultModuleV5, { strict: false })) throw new Error("deployment vaultModuleV5 is not an address");
    if (v.vaultModuleV4 === undefined) throw new Error("a deployment with a vaultModuleV5 has a vaultModuleV4");
    out.vaultModuleV5 = getAddress(v.vaultModuleV5);
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
  if (v.reputation !== undefined) {
    if (typeof v.reputation !== "object" || v.reputation === null) throw new Error("deployment reputation must be an object");
    const r = v.reputation as Record<string, unknown>;
    if (typeof r.address !== "string" || !isAddress(r.address, { strict: false })) throw new Error("deployment reputation.address is not an address");
    if (typeof r.fromBlock !== "string" || !/^(0|[1-9][0-9]*)$/.test(r.fromBlock)) throw new Error("deployment reputation.fromBlock must be a block number");
    out.reputation = { address: getAddress(r.address), fromBlock: r.fromBlock };
  }
  return out as Deployment;
}

/** The OstraReputation of `d`; throws when the deployment has none (it is not deployed on that chain yet). */
export function reputationOf(d: Deployment): ReputationDeployment {
  if (d.reputation === undefined) throw new Error("OstraReputation is not deployed on this chain yet (the deployment record has no reputation): reputation proofs are not available here; nothing was signed");
  return d.reputation;
}

/** The launchpad of `d`; throws when the deployment has none. */
export function launchpadOf(d: Deployment): LaunchpadDeployment {
  if (d.launchpad === undefined) throw new Error("this deployment has no launchpad");
  return d.launchpad;
}
