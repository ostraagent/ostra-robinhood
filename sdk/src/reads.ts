// Reads of Ostra's contracts and of the x402 channels they use (the Solana
// account decoders and fetchers had this role). A vault is only accepted as
// an Ostra vault when the deployment's factory derives exactly its address
// from its own initial parameters, as the Solana SDK checked the owning
// program before decoding an account.

import { bytesToHex, getAddress, hexToBytes, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { ostraPoolAbi, ostraVaultAbi, x402BatchSettlementAbi } from "./abi.ts";
import { BATCH_STATUS, DEPOSIT_STATUS, type BatchStatus, type DepositStatus } from "./constants.ts";
import type { Deployment } from "./deployment.ts";
import { batchStateHash, LTHASH_BYTES } from "./lthash.ts";
import { vaultAddress } from "./messages.ts";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;

export type VaultState = {
  vault: Address;
  token: Address;
  initialKeyRoot: Hex;
  initialCrank: Address;
  /** Root of the current one-time key, whose keychain index is `nonce`. */
  keyRoot: Hex;
  nonce: bigint;
  /** null = no crank. */
  crank: Address | null;
};

/**
 * The Ostra vault at `vault`, or null when nothing is deployed there yet or
 * it is not a vault of this deployment's factory.
 */
export async function readVault(client: PublicClient, d: Deployment, vault: Address): Promise<VaultState | null> {
  const code = await client.getCode({ address: vault });
  if (code === undefined || code === "0x") return null;
  const call = (functionName: "token" | "initialKeyRoot" | "initialCrank" | "keyRoot" | "nonce" | "crank") => ({
    address: vault,
    abi: ostraVaultAbi,
    functionName,
  });
  const results = await client.multicall({
    contracts: [call("token"), call("initialKeyRoot"), call("initialCrank"), call("keyRoot"), call("nonce"), call("crank")],
    allowFailure: true,
  });
  if (results.some((r) => r.status !== "success")) return null;
  const [token, initialKeyRoot, initialCrank, keyRoot, nonce, crank] = results.map((r) => r.result) as [Address, Hex, Address, Hex, bigint, Address];
  const expected = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot, initialCrank });
  if (expected !== getAddress(vault)) return null;
  return { vault: expected, token: getAddress(token), initialKeyRoot, initialCrank: getAddress(initialCrank), keyRoot, nonce, crank: crank === zeroAddress ? null : getAddress(crank) };
}

export type RecoveryState = {
  guardianCount: number;
  /** 0 = recovery off. */
  threshold: number;
  /** Seconds a recovery waits once the threshold is reached. */
  delay: number;
  /** Advances with every spend and every finished recovery. */
  round: number;
  /** The recovery waiting in the current round, if any. */
  pending: { newKeyRoot: Hex; executableAt: bigint } | null;
};

/** The recovery settings and state of a vault (OstraVault guardian recovery). */
export async function readRecovery(client: PublicClient, vault: Address): Promise<RecoveryState> {
  const read = <T>(functionName: "guardianCount" | "recoveryThreshold" | "recoveryDelay" | "recoveryRound" | "pendingRecovery") =>
    client.readContract({ address: vault, abi: ostraVaultAbi, functionName }) as Promise<T>;
  const [guardianCount, threshold, delay, round, pending] = await Promise.all([
    read<number>("guardianCount"),
    read<number>("recoveryThreshold"),
    read<number>("recoveryDelay"),
    read<number>("recoveryRound"),
    read<readonly [number, bigint, Hex]>("pendingRecovery"),
  ]);
  const [pendingRound, executableAt, newKeyRoot] = pending;
  return {
    guardianCount,
    threshold,
    delay,
    round,
    pending: executableAt !== 0n && pendingRound === round ? { newKeyRoot, executableAt } : null,
  };
}

export type PoolState = {
  pool: Address;
  token: Address;
  feeBps: number;
  treasury: Address;
  initAuthority: Address;
  leafAmount: bigint;
  /** Largest single deposit, and largest pool token balance after a deposit. */
  maxDeposit: bigint;
  maxTotal: bigint;
  batchCount: bigint;
  feesOwed: bigint;
};

export async function readPool(client: PublicClient, pool: Address): Promise<PoolState> {
  const call = (functionName: "token" | "feeBps" | "treasury" | "initAuthority" | "leafAmount" | "maxDeposit" | "maxTotal" | "batchCount" | "feesOwed") => ({
    address: pool,
    abi: ostraPoolAbi,
    functionName,
  });
  const [token, feeBps, treasury, initAuthority, leafAmount, maxDeposit, maxTotal, batchCount, feesOwed] = await client.multicall({
    contracts: [
      call("token"),
      call("feeBps"),
      call("treasury"),
      call("initAuthority"),
      call("leafAmount"),
      call("maxDeposit"),
      call("maxTotal"),
      call("batchCount"),
      call("feesOwed"),
    ],
    allowFailure: false,
  });
  return {
    pool: getAddress(pool),
    token: getAddress(token as Address),
    feeBps: Number(feeBps),
    treasury: getAddress(treasury as Address),
    initAuthority: getAddress(initAuthority as Address),
    leafAmount: leafAmount as bigint,
    maxDeposit: maxDeposit as bigint,
    maxTotal: maxTotal as bigint,
    batchCount: batchCount as bigint,
    feesOwed: feesOwed as bigint,
  };
}

export type DepositState = {
  key: Hex;
  status: DepositStatus;
  /** Unix seconds. */
  createdAt: bigint;
  amount: bigint;
  refundOwner: Address;
  /** The batch this deposit approved last, or null. */
  approvedBatch: bigint | null;
  /** Root of the approval key the next approval must be signed with (it rotates on every approval). */
  approvalKeyRoot: Hex;
  /** The batch state it approved, or null. */
  approvedState: Hex | null;
};

/** The deposit under `key`; status "none" when there is none. */
export async function readDeposit(client: PublicClient, pool: Address, key: Hex): Promise<DepositState> {
  const d = await client.readContract({ address: pool, abi: ostraPoolAbi, functionName: "getDeposit", args: [key] });
  const status = DEPOSIT_STATUS[d.status];
  if (status === undefined) throw new Error(`unknown deposit status ${d.status}`);
  return {
    key,
    status,
    createdAt: d.createdAt,
    amount: d.amount,
    refundOwner: getAddress(d.refundOwner),
    approvedBatch: d.approvedBatch === 0n ? null : d.approvedBatch - 1n,
    approvalKeyRoot: d.approvalKeyRoot,
    approvedState: d.approvedState === ZERO32 ? null : d.approvedState,
  };
}

export type BatchLeaf = { keyRoot: Hex; amount: bigint; spent: boolean };

export type BatchState = {
  batchId: bigint;
  status: BatchStatus;
  aggregator: Address;
  capacity: number;
  leafCount: number;
  unspent: number;
  totalAmount: bigint;
  /** The LtHash accumulator of the batch's leaves (2,048 bytes); batchStateOf hashes it into the state a deposit approves. */
  acc: Uint8Array;
  leaves: BatchLeaf[];
};

/** The batch `batchId` with every leaf (status "none" when it does not exist). */
export async function readBatch(client: PublicClient, pool: Address, batchId: bigint): Promise<BatchState> {
  const [header, acc, leafAmount] = await client.multicall({
    contracts: [
      { address: pool, abi: ostraPoolAbi, functionName: "getBatch", args: [batchId] },
      { address: pool, abi: ostraPoolAbi, functionName: "batchAccumulator", args: [batchId] },
      { address: pool, abi: ostraPoolAbi, functionName: "leafAmount" },
    ],
    allowFailure: false,
  });
  const [statusNumber, aggregator, capacity, leafCount, unspent, totalAmount] = header as readonly [number, Address, number, number, number, bigint];
  const status = BATCH_STATUS[statusNumber];
  if (status === undefined) throw new Error(`unknown batch status ${statusNumber}`);
  const accBytes = hexToBytes(acc as Hex);
  if (accBytes.length !== LTHASH_BYTES) throw new Error("the batch accumulator is not 2,048 bytes");
  const leafCalls = Array.from({ length: leafCount }, (_, i) => ({
    address: pool,
    abi: ostraPoolAbi,
    functionName: "leaf" as const,
    args: [batchId, i] as const,
  }));
  const leafResults = leafCount === 0 ? [] : await client.multicall({ contracts: leafCalls, allowFailure: false });
  const leaves = leafResults.map((r) => {
    const [keyRoot, spent] = r as readonly [Hex, boolean];
    return { keyRoot, amount: leafAmount as bigint, spent };
  });
  return { batchId, status, aggregator: getAddress(aggregator), capacity, leafCount, unspent, totalAmount, acc: accBytes, leaves };
}

/** The state a depositor approves, from a batch read (OstraPool.batchState). */
export function batchStateOf(batch: BatchState): Hex {
  return bytesToHex(batchStateHash(batch.acc, batch.leafCount, batch.totalAmount));
}

export type ChannelState = {
  channelId: Hex;
  /** Escrow still in the channel. */
  balance: bigint;
  /** Cumulative amount claimed by the receiver side so far. */
  totalClaimed: bigint;
  /** A timed withdrawal the payer side started, or null. */
  pendingWithdrawal: { amount: bigint; initiatedAt: bigint } | null;
};

export async function readChannel(client: PublicClient, settlement: Address, channelId: Hex): Promise<ChannelState> {
  const [channel, pending] = await client.multicall({
    contracts: [
      { address: settlement, abi: x402BatchSettlementAbi, functionName: "channels", args: [channelId] },
      { address: settlement, abi: x402BatchSettlementAbi, functionName: "pendingWithdrawals", args: [channelId] },
    ],
    allowFailure: false,
  });
  const [balance, totalClaimed] = channel as readonly [bigint, bigint];
  const [amount, initiatedAt] = pending as readonly [bigint, number];
  return { channelId, balance, totalClaimed, pendingWithdrawal: initiatedAt === 0 ? null : { amount, initiatedAt: BigInt(initiatedAt) } };
}
