// The channel an x402 payment header pays from: only read to choose whose
// credit applies (the scheme verifies the payment itself).

import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { paymentChannel } from "../src/gate.ts";

const payer = getAddress("0x00000000000000000000000000000000000aa001");
const receiverAuthorizer = getAddress("0x00000000000000000000000000000000000ee001");
const header = (inner: unknown) => encodePaymentSignatureHeader({ x402Version: 2, accepted: {}, payload: inner } as unknown as PaymentPayload);

test("no PAYMENT-SIGNATURE header: undefined (the 402 follows)", () => {
  assert.equal(paymentChannel(undefined), undefined);
  assert.equal(paymentChannel(""), undefined);
});

test("a voucher or deposit payload: its channel's payer and receiverAuthorizer", () => {
  const config = { payer: payer.toLowerCase(), payerAuthorizer: payer, receiver: payer, receiverAuthorizer: receiverAuthorizer.toLowerCase(), token: payer, withdrawDelay: 900, salt: `0x${"00".repeat(32)}` };
  assert.deepEqual(paymentChannel(header({ type: "voucher", channelConfig: config, voucher: {} })), { payer, receiverAuthorizer });
  assert.deepEqual(paymentChannel(header({ type: "deposit", channelConfig: config, voucher: {}, deposit: {} })), { payer, receiverAuthorizer });
});

test("a payload without a channel, or an unreadable header: null", () => {
  assert.equal(paymentChannel(header({ type: "exact" })), null);
  assert.equal(paymentChannel(header({ channelConfig: { payer: "nope", receiverAuthorizer } })), null);
  assert.equal(paymentChannel("!!!not-base64-json"), null);
});
