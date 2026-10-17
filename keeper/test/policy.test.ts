import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEPER_FEE_BPS, MIN_GRACE_SECONDS, SETTLE_MAX_AGE_SECONDS } from "../src/config.ts";
import { guardProblem, settleReason, voucherUsable, type SettleInput } from "../src/policy.ts";

const ONE_TOKEN = 1_000_000n;
const NOW = 1_800_000_000n;

function input(over: Partial<SettleInput>): SettleInput {
  return {
    claimed: 0n,
    voucher: 100_000n,
    unsettledSince: Number(NOW) - 60,
    now: NOW,
    threshold: ONE_TOKEN,
    maxAgeSeconds: SETTLE_MAX_AGE_SECONDS,
    ...over,
  };
}

test("small fresh vouchers wait", () => {
  assert.equal(settleReason(input({})), null);
  assert.equal(settleReason(input({ voucher: null, unsettledSince: null })), null);
});

test("1 token unclaimed is claimed at once", () => {
  assert.equal(settleReason(input({ voucher: ONE_TOKEN })), "amount");
  assert.equal(settleReason(input({ claimed: 1n, voucher: ONE_TOKEN })), null);
  assert.equal(settleReason(input({ claimed: 2_000_000n, voucher: 3_000_000n })), "amount");
});

test("an unclaimed voucher is claimed once the oldest one is an hour old", () => {
  assert.equal(SETTLE_MAX_AGE_SECONDS, 3_600);
  assert.equal(settleReason(input({ unsettledSince: Number(NOW) - 3_599 })), null);
  assert.equal(settleReason(input({ unsettledSince: Number(NOW) - 3_600 })), "age");
});

test("a voucher at or below what is claimed on-chain is never used", () => {
  assert.equal(voucherUsable(10n, 10n), false);
  assert.equal(voucherUsable(11n, 10n), true);
  assert.equal(voucherUsable(null, 0n), false);
  assert.equal(settleReason(input({ claimed: 5_000_000n, voucher: 5_000_000n, unsettledSince: 0 })), null);
});

test("the keeper guards only channels with the minimum withdraw delay that pay its fee", () => {
  assert.equal(KEEPER_FEE_BPS, 30);
  assert.equal(MIN_GRACE_SECONDS, 900);
  const fee = "0x00000000000000000000000000000000000000Aa";
  const other = "0x00000000000000000000000000000000000000bb";
  const terms = { feeRecipient: fee, feeBps: KEEPER_FEE_BPS, minGraceSeconds: MIN_GRACE_SECONDS };
  assert.equal(guardProblem({ ...terms, gracePeriod: 900, recipients: [{ recipient: fee, bps: 30 }] }), null);
  // Addresses compare whatever their case.
  assert.equal(guardProblem({ ...terms, gracePeriod: 900, recipients: [{ recipient: fee.toLowerCase(), bps: 30 }] }), null);
  assert.equal(guardProblem({ ...terms, gracePeriod: 86_400, recipients: [{ recipient: other, bps: 100 }, { recipient: fee, bps: 45 }] }), null);
  assert.equal(guardProblem({ ...terms, gracePeriod: 899, recipients: [{ recipient: fee, bps: 30 }] }), "grace_too_short");
  assert.equal(guardProblem({ ...terms, gracePeriod: 900, recipients: [] }), "keeper_fee_missing");
  assert.equal(guardProblem({ ...terms, gracePeriod: 900, recipients: [{ recipient: fee, bps: 29 }] }), "keeper_fee_missing");
  assert.equal(guardProblem({ ...terms, gracePeriod: 900, recipients: [{ recipient: other, bps: 30 }] }), "keeper_fee_missing");
});
