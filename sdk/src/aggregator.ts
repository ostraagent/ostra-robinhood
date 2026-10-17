// What the aggregator server (aggregator/) and the depositors (the MCP
// package) share: the wire format of leaves, the depositor's signed poll, and
// the checks a depositor runs on a batch before it approves it.
//
// Design v0.3, decided 15 Oct 2026: a depositor sends its leaves to the
// aggregator over HTTPS (POST /v1/deposits), then polls its deposit (GET
// /v1/deposits/<deposit>) with a signature of the deposit's refund owner, its
// one-time depositor key. Only polled deposits are put in a batch, so a
// depositor that is not running does not hold a batch up. Before approving,
// the depositor reads the batch on-chain and checks that every one of its
// leaves is there, that every leaf in it is a standard leaf, and that the
// state it signs is the batch's current state.
//
// On Robinhood Chain (design v0.4) a deposit is named by its OstraPool deposit
// key, and the poll is an EIP-191 signature of the depositor key over
// "OSTRA/AGGREGATOR/POLL/EVM/v1" || chainid || pool || deposit key || at (u64,
// unix seconds), so a poll for one pool or chain is never valid for another.

import { bytesToHex, encodePacked, getAddress, hexToBytes, isAddress, isHex, stringToHex, verifyMessage, type Address, type Hex, type LocalAccount } from "viem";
import { fromHex, toHex } from "./hash.ts";
import { isStandardLeaf } from "./leaves.ts";
import { batchStateHash, encodeLeaf, lthashOfLeaves } from "./lthash.ts";

const POLL_DOMAIN = stringToHex("OSTRA/AGGREGATOR/POLL/EVM/v1"); // bytes28
const U64_MAX = (1n << 64n) - 1n;

/** A leaf: its WOTS key root and its amount in base units (one standard leaf on Robinhood Chain). */
export type Leaf = { keyRoot: Uint8Array; amount: bigint };

/** A leaf as JSON: the WOTS key root in hex and the amount in base units. */
export type WireLeaf = { keyRoot: string; amount: string };

export function leafToWire(leaf: Leaf): WireLeaf {
  if (leaf.keyRoot.length !== 32) throw new RangeError("keyRoot must be 32 bytes");
  if (leaf.amount <= 0n) throw new RangeError("leaf amount must be positive");
  return { keyRoot: toHex(leaf.keyRoot), amount: leaf.amount.toString() };
}

/** Parses a WireLeaf; throws on anything else. */
export function leafFromWire(value: unknown): Leaf {
  if (typeof value !== "object" || value === null) throw new Error("a leaf must be an object");
  const { keyRoot, amount } = value as Record<string, unknown>;
  if (typeof keyRoot !== "string" || !/^[0-9a-f]{64}$/.test(keyRoot)) throw new Error("leaf keyRoot must be 32 bytes of lowercase hex");
  if (typeof amount !== "string" || !/^[1-9][0-9]{0,19}$/.test(amount)) throw new Error("leaf amount must be a positive integer string");
  const parsed = BigInt(amount);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error("leaf amount must fit in a u64");
  return { keyRoot: fromHex(keyRoot), amount: parsed };
}

/** The LtHash commitment a deposit records for these leaves (order does not matter). */
export function depositCommitment(leaves: readonly Leaf[]): Uint8Array {
  return lthashOfLeaves(leaves.map((l) => encodeLeaf(l.keyRoot, l.amount)));
}

/** The state hash of a batch holding exactly these leaves, as approveBatch and sealBatch compute it. */
export function leavesStateHash(leaves: readonly Leaf[]): Uint8Array {
  const total = leaves.reduce((sum, l) => sum + l.amount, 0n);
  return batchStateHash(depositCommitment(leaves), leaves.length, total);
}

/** The leaves of a batch as a depositor checks them (reads.ts readBatch gives them). */
export type BatchLeaves = { leaves: readonly { keyRoot: Hex; amount: bigint }[] };

const leafKey = (keyRoot: Uint8Array, amount: bigint) => `${toHex(keyRoot)}:${amount}`;

/**
 * True when every leaf of `batch` is a standard leaf (LEAF_DENOMINATION). A
 * depositor approves only such a batch: one amount for every leaf is what
 * keeps its own leaves indistinguishable, and sealBatch refuses any other.
 */
export function batchLeavesStandard(batch: BatchLeaves): boolean {
  return batch.leaves.every((l) => isStandardLeaf(l.amount));
}

/** True when every one of `leaves` is in `batch` (as a multiset: a leaf listed twice must be there twice). */
export function batchContainsLeaves(batch: BatchLeaves, leaves: readonly Leaf[]): boolean {
  const have = new Map<string, number>();
  for (const l of batch.leaves) {
    const k = leafKey(hexToBytes(l.keyRoot), l.amount);
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  for (const l of leaves) {
    const k = leafKey(l.keyRoot, l.amount);
    const n = have.get(k) ?? 0;
    if (n === 0) return false;
    have.set(k, n - 1);
  }
  return true;
}

export type PollTarget = { chainId: number; pool: Address; deposit: Hex };

/** The message a depositor signs to poll its deposit. */
export function aggregatorPollMessage(t: PollTarget, at: bigint): Uint8Array {
  if (!Number.isSafeInteger(t.chainId) || t.chainId <= 0) throw new RangeError("chainId must be a positive integer");
  if (!isAddress(t.pool, { strict: false })) throw new RangeError("pool is not an address");
  if (!isHex(t.deposit) || t.deposit.length !== 66) throw new RangeError("deposit must be a 32-byte deposit key");
  if (at < 0n || at > U64_MAX) throw new RangeError("at out of range");
  return hexToBytes(encodePacked(["bytes28", "uint256", "address", "bytes32", "uint64"], [POLL_DOMAIN, BigInt(t.chainId), getAddress(t.pool), t.deposit, at]));
}

/** The depositor key's poll signature (65 bytes, EIP-191). */
export async function signAggregatorPoll(signer: LocalAccount, t: PollTarget, at: bigint): Promise<Hex> {
  return signer.signMessage({ message: { raw: aggregatorPollMessage(t, at) } });
}

/** True when `signature` is `owner`'s poll signature for the deposit at `at`. */
export async function verifyAggregatorPoll(owner: Address, t: PollTarget, at: bigint, signature: Hex): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    return await verifyMessage({ address: owner, message: { raw: bytesToHex(aggregatorPollMessage(t, at)) }, signature });
  } catch {
    return false;
  }
}

/** GET /v1/deposits/<deposit>: what the aggregator holds for a deposit. */
export type AggregatorDepositView =
  | { status: "unknown" }
  | { status: "queued"; leaves: number }
  | { status: "batched"; batch: string; stateHash: string; approveBy: number };
