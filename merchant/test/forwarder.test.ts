import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { chargeRaised, paidVoucher, wireChannelConfig } from "../src/forwarder.ts";
import { channelRecord } from "./fixtures.ts";

test("paidVoucher gives the x402 wire voucher of the record's last paid request", () => {
  const empty = channelRecord("a");
  assert.equal(paidVoucher(empty), undefined);
  // An adopted channel: a charge floor from the chain, no voucher of this server's.
  assert.equal(paidVoucher({ ...empty, chargedCumulativeAmount: "1200000", signedMaxClaimable: "1200000" }), undefined);
  const paid = { ...empty, chargedCumulativeAmount: "300000", signedMaxClaimable: "300000", signature: `0x${"ab".repeat(65)}` };
  assert.deepEqual(paidVoucher(paid), { channelId: empty.channelId.toLowerCase(), maxClaimableAmount: "300000", signature: paid.signature });
});

test("a voucher is forwarded only when it raised what the channel was charged", () => {
  const sig = `0x${"cd".repeat(65)}`;
  const before = channelRecord("b");
  // The x402 scheme records a new voucher at verification, before the request is paid: not yet.
  const reserved = { ...before, signedMaxClaimable: "300000", signature: sig, pendingRequest: { pendingId: "p", signedMaxClaimable: "300000", expiresAt: 1 } };
  assert.equal(chargeRaised(before, reserved), false);
  const committed = { ...reserved, chargedCumulativeAmount: "300000", pendingRequest: undefined };
  assert.equal(chargeRaised(reserved, committed), true);
  assert.equal(chargeRaised(undefined, committed), true);
  // A mirror refresh or a meta-only change does not forward again.
  assert.equal(chargeRaised(committed, { ...committed, balance: "1" }), false);
  assert.equal(chargeRaised(committed, undefined), false);
});

test("a channel config is sent to the keeper checksummed with a numeric withdraw delay", () => {
  const c = channelRecord("c").channelConfig;
  const wire = wireChannelConfig({ ...c, payer: c.payer.toLowerCase() as `0x${string}`, withdrawDelay: "900" as unknown as number });
  assert.equal(wire.payer, getAddress(c.payer));
  assert.equal(wire.withdrawDelay, 900);
  assert.equal(wire.salt, c.salt.toLowerCase());
});
