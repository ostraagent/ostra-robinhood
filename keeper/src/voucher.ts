// Vouchers, channel configs and splits as sellers forward them.
//
// A voucher arrives in the shape of the x402 batch-settlement scheme
// (x402-foundation/x402, specs/schemes/batch-settlement), so a seller's
// server forwards what its buyer sent unchanged:
//   channelConfig: { payer, payerAuthorizer, receiver, receiverAuthorizer,
//                    token, withdrawDelay, salt }
//   voucher:       { channelId, maxClaimableAmount: "<uint128>", signature }
// The signed digest is x402BatchSettlement's EIP-712 Voucher(channelId,
// maxClaimableAmount), checked against the channel's payerAuthorizer exactly as
// the contract checks it (ecrecover; Ostra vaults never open a channel without
// a payerAuthorizer). Vouchers are cumulative and do not expire.
//
// Splits are the shares of the channel's receiver, an OstraSplit:
// { recipient, bps }[] in the order the split was created with; the keeper
// accepts them only when the split factory derives the channel's receiver
// from them.

import { getAddress, isAddress, isHex, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { X402_MAX_WITHDRAW_DELAY, X402_MIN_WITHDRAW_DELAY, channelId, voucherTypedData, type ChannelConfig } from "@ostraagent/sdk";

const U128_MAX = (1n << 128n) - 1n;
const BPS_DENOMINATOR = 10_000;
/** OstraSplit.MAX_RECIPIENTS. */
export const MAX_SPLIT_RECIPIENTS = 32;

export type ChannelRecipient = { recipient: Address; bps: number };

export type Voucher = {
  channelId: Hex;
  /** Cumulative ceiling the payerAuthorizer signed. */
  maxClaimableAmount: bigint;
  signature: Hex;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAddress(value: unknown, name: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`${name} must be an address`);
  return getAddress(value);
}

function parseBytes32(value: unknown, name: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be 32 bytes of hex`);
  return value.toLowerCase() as Hex;
}

function parseU128(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(value)) throw new Error(`${name} must be a uint128 decimal string`);
  const n = BigInt(value);
  if (n > U128_MAX) throw new Error(`${name} must be a uint128 decimal string`);
  return n;
}

/** 65-byte r || s || v signature in hex. */
export function parseSignature(value: unknown, name: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) throw new Error(`${name} must be a 65-byte signature in hex`);
  return value as Hex;
}

/** Parses a channel config in the x402 wire shape. */
export function parseChannelConfig(value: unknown): ChannelConfig {
  if (!isRecord(value)) throw new Error("channelConfig must be { payer, payerAuthorizer, receiver, receiverAuthorizer, token, withdrawDelay, salt }");
  const withdrawDelay = value.withdrawDelay;
  if (typeof withdrawDelay !== "number" || !Number.isInteger(withdrawDelay) || withdrawDelay < X402_MIN_WITHDRAW_DELAY || withdrawDelay > X402_MAX_WITHDRAW_DELAY) {
    throw new Error(`channelConfig.withdrawDelay must be an integer from ${X402_MIN_WITHDRAW_DELAY} to ${X402_MAX_WITHDRAW_DELAY}`);
  }
  return {
    payer: parseAddress(value.payer, "channelConfig.payer"),
    payerAuthorizer: parseAddress(value.payerAuthorizer, "channelConfig.payerAuthorizer"),
    receiver: parseAddress(value.receiver, "channelConfig.receiver"),
    receiverAuthorizer: parseAddress(value.receiverAuthorizer, "channelConfig.receiverAuthorizer"),
    token: parseAddress(value.token, "channelConfig.token"),
    withdrawDelay,
    salt: parseBytes32(value.salt, "channelConfig.salt"),
  };
}

/** Parses a forwarded voucher; its signature is checked separately (verifyVoucher). */
export function parseVoucher(value: unknown): Voucher {
  if (!isRecord(value)) throw new Error("voucher must be { channelId, maxClaimableAmount, signature }");
  const maxClaimableAmount = parseU128(value.maxClaimableAmount, "voucher.maxClaimableAmount");
  if (maxClaimableAmount === 0n) throw new Error("voucher.maxClaimableAmount must be greater than zero");
  return {
    channelId: parseBytes32(value.channelId, "voucher.channelId"),
    maxClaimableAmount,
    signature: parseSignature(value.signature, "voucher.signature"),
  };
}

/** The channel id of `config`, required to equal `id` when one is given. */
export function boundChannelId(config: ChannelConfig, chainId: number, settlement: Address, id?: Hex): Hex {
  const computed = channelId(config, chainId, settlement).toLowerCase() as Hex;
  if (id !== undefined && id.toLowerCase() !== computed) throw new Error("the voucher's channelId is not the id of channelConfig");
  return computed;
}

/** True when the voucher is signed by the channel's payerAuthorizer, as x402BatchSettlement checks it. */
export async function verifyVoucher(v: Voucher, config: ChannelConfig, chainId: number, settlement: Address): Promise<boolean> {
  if (getAddress(config.payerAuthorizer) === "0x0000000000000000000000000000000000000000") return false;
  try {
    const signer = await recoverTypedDataAddress({
      ...voucherTypedData({ channelId: v.channelId, maxClaimableAmount: v.maxClaimableAmount, chainId, settlement }),
      signature: v.signature,
    });
    return signer === getAddress(config.payerAuthorizer);
  } catch {
    return false;
  }
}

/** The split's shares in creation order; OstraSplit's rules (1..10000 bps each, at most 10000 in total, at most 32, no repeats, no zero address). */
export function parseSplits(value: unknown): ChannelRecipient[] {
  if (!Array.isArray(value)) throw new Error("splits must be an array of { recipient, bps }");
  if (value.length > MAX_SPLIT_RECIPIENTS) throw new Error(`splits: at most ${MAX_SPLIT_RECIPIENTS} entries`);
  const seen = new Set<string>();
  let total = 0;
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`splits[${i}] must be { recipient, bps }`);
    const recipient = parseAddress(entry.recipient, `splits[${i}].recipient`);
    if (recipient === "0x0000000000000000000000000000000000000000") throw new Error(`splits[${i}].recipient must not be the zero address`);
    const bps = entry.bps;
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 1 || bps > BPS_DENOMINATOR) throw new Error(`splits[${i}].bps must be an integer from 1 to 10000`);
    if (seen.has(recipient)) throw new Error(`splits: ${recipient} is listed twice`);
    seen.add(recipient);
    total += bps;
    if (total > BPS_DENOMINATOR) throw new Error(`splits: ${total} bps in total (at most 10000)`);
    return { recipient, bps };
  });
}

/** True for a 32-byte hex string. */
export function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && isHex(value) && value.length === 66;
}
