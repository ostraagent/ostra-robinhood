// When the keeper claims an open channel's voucher (design v0.3, decided 14
// Oct 2026): once the unclaimed voucher amount reaches the threshold (1 token)
// or the oldest unclaimed voucher is 1 hour old. x402 vouchers never expire,
// so the Solana rule that settled a voucher about to expire has nothing to
// apply to; a buyer's close request (initiateWithdraw) is handled by the watch
// pass at once instead (keeper.ts).

export type SettleInput = {
  /** On-chain totalClaimed of the channel. */
  claimed: bigint;
  /** Highest voucher ceiling the keeper holds, or null. */
  voucher: bigint | null;
  /** Unix seconds when the oldest unclaimed voucher arrived. */
  unsettledSince: number | null;
  /** Current unix seconds. */
  now: bigint;
  /** Threshold in base units. */
  threshold: bigint;
  /** Maximum age of an unclaimed voucher in seconds. */
  maxAgeSeconds: number;
};

export type SettleReason = "amount" | "age";

export type GuardProblem = "grace_too_short" | "keeper_fee_missing";

/**
 * Why the keeper refuses to guard a channel, or null when it accepts it: the
 * withdraw delay must be at least the sellers' minimum, and the split must pay
 * the keeper fee (at least `feeBps`) to the Ostra operator vault.
 */
export function guardProblem(a: {
  gracePeriod: number;
  recipients: readonly { recipient: string; bps: number }[];
  feeRecipient: string;
  feeBps: number;
  minGraceSeconds: number;
}): GuardProblem | null {
  if (a.gracePeriod < a.minGraceSeconds) return "grace_too_short";
  const fee = a.feeRecipient.toLowerCase();
  if (!a.recipients.some((r) => r.recipient.toLowerCase() === fee && r.bps >= a.feeBps)) return "keeper_fee_missing";
  return null;
}

/** True when `voucher` adds to what is claimed on-chain. */
export function voucherUsable(voucher: bigint | null, claimed: bigint): voucher is bigint {
  return voucher !== null && voucher > claimed;
}

/** Why an open channel's voucher should be claimed now, or null when it can wait. */
export function settleReason(s: SettleInput): SettleReason | null {
  if (!voucherUsable(s.voucher, s.claimed)) return null;
  if (s.voucher - s.claimed >= s.threshold) return "amount";
  if (s.unsettledSince !== null && s.now - BigInt(s.unsettledSince) >= BigInt(s.maxAgeSeconds)) return "age";
  return null;
}
