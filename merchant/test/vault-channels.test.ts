import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, keccak256, stringToHex, zeroAddress, type Hex } from "viem";
import { USDG, type ChannelState, type VaultState } from "@ostraagent/sdk";
import type { PaymentPayload } from "@x402/core/types";
import { adoptedChannel, checkSplits, isReplayedVoucher, vaultChannelProblem, type VaultChannelOffer } from "../src/merchant.ts";
import { address, channelRecord } from "./fixtures.ts";

const config = channelRecord("v").channelConfig;
const offer: VaultChannelOffer = { vault: address("seller vault"), split: address("split"), token: USDG, gracePeriodSeconds: 900, minimumDeposit: 10_000n };
const ch: ChannelState = { channelId: channelRecord("v").channelId as Hex, balance: 200_000n, totalClaimed: 0n, pendingWithdrawal: null };
const payerVault: VaultState = {
  vault: config.payer,
  token: USDG,
  initialKeyRoot: keccak256("0x"),
  initialCrank: zeroAddress,
  keyRoot: keccak256("0x"),
  nonce: 1n,
  crank: null,
};

test("splits follow OstraSplit's rules", () => {
  const a = address("a");
  const b = address("b");
  checkSplits([]);
  checkSplits([{ recipient: a, bps: 30 }, { recipient: b, bps: 9_970 }]);
  assert.throws(() => checkSplits([{ recipient: a, bps: 0 }]), /1..10000/);
  assert.throws(() => checkSplits([{ recipient: a, bps: 1.5 }]), /1..10000/);
  assert.throws(() => checkSplits([{ recipient: a, bps: 30 }, { recipient: a.toLowerCase() as `0x${string}`, bps: 30 }]), /listed twice/);
  assert.throws(() => checkSplits([{ recipient: a, bps: 30 }, { recipient: b, bps: 9_971 }]), /at most 10000/);
  assert.throws(() => checkSplits([{ recipient: zeroAddress, bps: 30 }]), /zero address/);
  assert.throws(() => checkSplits([{ recipient: "not-an-address" as `0x${string}`, bps: 30 }]));
  assert.throws(() => checkSplits(Array.from({ length: 33 }, (_, i) => ({ recipient: address(`r${i}`), bps: 1 }))), /at most 32/);
});

test("a vault channel is adopted only when it is exactly the seller's offer", () => {
  assert.equal(vaultChannelProblem(config, ch, payerVault, offer), null);
  assert.equal(vaultChannelProblem(config, ch, payerVault, { ...offer, minimumDeposit: undefined }), null);
  assert.match(vaultChannelProblem(config, { ...ch, pendingWithdrawal: { amount: 1n, initiatedAt: 1n } }, payerVault, offer) ?? "", /asked to close/);
  assert.match(vaultChannelProblem({ ...config, receiver: address("other") }, ch, payerVault, offer) ?? "", /not this seller's split/);
  assert.match(vaultChannelProblem({ ...config, receiverAuthorizer: address("other") }, ch, payerVault, offer) ?? "", /not this seller's vault/);
  assert.match(vaultChannelProblem({ ...config, token: address("token") }, ch, payerVault, offer) ?? "", /in token/);
  assert.match(vaultChannelProblem(config, ch, null, offer) ?? "", /is not an Ostra vault/);
  assert.match(vaultChannelProblem(config, ch, { ...payerVault, token: address("token") }, offer) ?? "", /payer vault holds token/);
  assert.match(vaultChannelProblem({ ...config, withdrawDelay: 901 }, ch, payerVault, offer) ?? "", /withdraw delay is 901 s/);
  assert.match(vaultChannelProblem(config, { ...ch, totalClaimed: ch.balance }, payerVault, offer) ?? "", /no unclaimed escrow/);
  assert.match(vaultChannelProblem(config, { ...ch, balance: 9_999n }, payerVault, offer) ?? "", /below the minimum deposit/);
  assert.match(vaultChannelProblem({ ...config, payerAuthorizer: zeroAddress }, ch, payerVault, offer) ?? "", /no voucher key/);
  // Addresses compare whatever their case.
  assert.equal(vaultChannelProblem({ ...config, receiver: config.receiver.toLowerCase() as `0x${string}` }, ch, payerVault, offer), null);
});

test("an adopted channel records what a verified channel records, with the claimed amount as charge floor", () => {
  const fresh = adoptedChannel(ch.channelId.toUpperCase().replace("0X", "0x"), config, ch, 0n, 1_800_000_000_000);
  assert.equal(fresh.channelId, ch.channelId.toLowerCase());
  assert.deepEqual(fresh.channelConfig, config);
  assert.equal(fresh.chargedCumulativeAmount, "0");
  assert.equal(fresh.signedMaxClaimable, "0");
  assert.equal(fresh.signature, "");
  assert.equal(fresh.balance, "200000");
  assert.equal(fresh.withdrawRequestedAt, 0);
  assert.equal(fresh.onchainSyncedAt, 1_800_000_000_000);
  assert.equal(fresh.lastRequestTimestamp, 1_800_000_000_000);
  assert.equal(fresh.pendingRequest, undefined);
  const claimed = adoptedChannel(ch.channelId, config, { ...ch, totalClaimed: 40_000n, pendingWithdrawal: { amount: 1n, initiatedAt: 1_800_000_000n } }, 3n, 1);
  assert.equal(claimed.chargedCumulativeAmount, "40000");
  assert.equal(claimed.signedMaxClaimable, "40000");
  assert.equal(claimed.totalClaimed, "40000");
  assert.equal(claimed.withdrawRequestedAt, 1_800_000_000);
  assert.equal(claimed.refundNonce, 3);
});

test("only the channel's last paid voucher, sent again, is a replay", () => {
  const sig = `0x${"ef".repeat(65)}` as Hex;
  const record = { ...channelRecord("r"), chargedCumulativeAmount: "600000", signedMaxClaimable: "600000", signature: sig };
  const payload = (maxClaimableAmount: string, signature: Hex, type = "voucher") =>
    ({ x402Version: 2, payload: { type, channelConfig: record.channelConfig, voucher: { channelId: record.channelId, maxClaimableAmount, signature } } }) as unknown as PaymentPayload;
  assert.equal(isReplayedVoucher(payload("600000", sig), record), true);
  assert.equal(isReplayedVoucher(payload("600000", sig.toUpperCase().replace("0X", "0x") as Hex), record), true);
  assert.equal(isReplayedVoucher(payload("900000", sig), record), false);
  assert.equal(isReplayedVoucher(payload("600000", `0x${"aa".repeat(65)}`), record), false);
  assert.equal(isReplayedVoucher(payload("600000", sig), undefined), false);
  assert.equal(isReplayedVoucher(payload("600000", sig, "refund"), record), false);
  // An adopted channel has no paid voucher yet.
  assert.equal(isReplayedVoucher(payload("0", "0x" as Hex), { ...record, chargedCumulativeAmount: "0", signature: "" }), false);
  assert.equal(getAddress(record.channelConfig.receiver), address("split"));
});
