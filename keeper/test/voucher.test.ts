import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, keccak256, stringToHex, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROBINHOOD_CHAIN_ID, USDG, X402_BATCH_SETTLEMENT, channelId, voucherTypedData, type ChannelConfig } from "@ostraagent/sdk";
import { MAX_SPLIT_RECIPIENTS, boundChannelId, isBytes32, parseChannelConfig, parseSignature, parseSplits, parseVoucher, verifyVoucher } from "../src/voucher.ts";

const account = (name: string) => privateKeyToAccount(keccak256(stringToHex(name)));
const A = account("A").address;
const B = account("B").address;
const session = account("session");

const wireConfig = {
  payer: account("buyer vault").address.toLowerCase(),
  payerAuthorizer: session.address,
  receiver: account("split").address,
  receiverAuthorizer: account("seller vault").address,
  token: USDG,
  withdrawDelay: 900,
  salt: keccak256(stringToHex("salt")),
};

async function signed(amount: bigint, signer = session, config: ChannelConfig = parseChannelConfig(wireConfig)) {
  const id = channelId(config);
  const signature = await signer.signTypedData(voucherTypedData({ channelId: id, maxClaimableAmount: amount }));
  return { channelId: id, maxClaimableAmount: amount.toString(), signature };
}

test("a channel config in the x402 wire shape is parsed with checksummed addresses", () => {
  const c = parseChannelConfig(wireConfig);
  assert.equal(c.payer, getAddress(wireConfig.payer));
  assert.equal(c.withdrawDelay, 900);
  assert.equal(channelId(c), channelId({ ...c, payer: wireConfig.payer as Address }));
  assert.equal(parseChannelConfig({ ...wireConfig, withdrawDelay: 2_592_000 }).withdrawDelay, 2_592_000);
  assert.throws(() => parseChannelConfig(null), /channelConfig must be/);
  assert.throws(() => parseChannelConfig([]), /channelConfig must be/);
  assert.throws(() => parseChannelConfig({ ...wireConfig, withdrawDelay: 899 }), /withdrawDelay must be an integer from 900 to 2592000/);
  assert.throws(() => parseChannelConfig({ ...wireConfig, withdrawDelay: 2_592_001 }), /withdrawDelay/);
  assert.throws(() => parseChannelConfig({ ...wireConfig, withdrawDelay: 900.5 }), /withdrawDelay/);
  assert.throws(() => parseChannelConfig({ ...wireConfig, withdrawDelay: "900" }), /withdrawDelay/);
  assert.throws(() => parseChannelConfig({ ...wireConfig, receiver: "0x12" }), /channelConfig.receiver must be an address/);
  assert.throws(() => parseChannelConfig({ ...wireConfig, token: 5 }), /channelConfig.token must be an address/);
  assert.throws(() => parseChannelConfig({ ...wireConfig, salt: "0x12" }), /channelConfig.salt must be 32 bytes of hex/);
});

test("a forwarded voucher verifies against the channel's payerAuthorizer, as x402BatchSettlement checks it", async () => {
  const config = parseChannelConfig(wireConfig);
  const v = parseVoucher(await signed(250_000n));
  assert.equal(v.maxClaimableAmount, 250_000n);
  assert.equal(boundChannelId(config, ROBINHOOD_CHAIN_ID, X402_BATCH_SETTLEMENT, v.channelId), v.channelId);
  assert.equal(await verifyVoucher(v, config, ROBINHOOD_CHAIN_ID, X402_BATCH_SETTLEMENT), true);
  // Another signer, another chain or another settlement contract do not verify.
  assert.equal(await verifyVoucher(parseVoucher(await signed(250_000n, account("other"))), config, ROBINHOOD_CHAIN_ID, X402_BATCH_SETTLEMENT), false);
  assert.equal(await verifyVoucher(v, config, 1, X402_BATCH_SETTLEMENT), false);
  assert.equal(await verifyVoucher(v, config, ROBINHOOD_CHAIN_ID, A), false);
  // A channel without a payerAuthorizer is never accepted.
  assert.equal(await verifyVoucher(v, { ...config, payerAuthorizer: zeroAddress }, ROBINHOOD_CHAIN_ID, X402_BATCH_SETTLEMENT), false);
});

test("a voucher whose amount or channel was changed does not verify", async () => {
  const config = parseChannelConfig(wireConfig);
  const wire = await signed(100n);
  assert.equal(await verifyVoucher(parseVoucher({ ...wire, maxClaimableAmount: "101" }), config, ROBINHOOD_CHAIN_ID, X402_BATCH_SETTLEMENT), false);
  const other = parseChannelConfig({ ...wireConfig, salt: keccak256(stringToHex("other")) });
  assert.throws(() => boundChannelId(other, ROBINHOOD_CHAIN_ID, X402_BATCH_SETTLEMENT, wire.channelId), /not the id of channelConfig/);
  assert.equal(boundChannelId(other, ROBINHOOD_CHAIN_ID, X402_BATCH_SETTLEMENT), channelId(other).toLowerCase());
  // A signature with a broken v is refused, not thrown.
  assert.equal(await verifyVoucher(parseVoucher({ ...wire, signature: `${wire.signature.slice(0, -2)}05` }), config, ROBINHOOD_CHAIN_ID, X402_BATCH_SETTLEMENT), false);
});

test("malformed vouchers are refused", async () => {
  const wire = await signed(5n);
  assert.throws(() => parseVoucher(null), /voucher must be/);
  assert.throws(() => parseVoucher({ ...wire, maxClaimableAmount: "0" }), /greater than zero/);
  assert.throws(() => parseVoucher({ ...wire, maxClaimableAmount: (1n << 128n).toString() }), /uint128/);
  assert.throws(() => parseVoucher({ ...wire, maxClaimableAmount: 5 }), /uint128 decimal string/);
  assert.throws(() => parseVoucher({ ...wire, maxClaimableAmount: "05" }), /uint128 decimal string/);
  assert.throws(() => parseVoucher({ ...wire, maxClaimableAmount: "-1" }), /uint128 decimal string/);
  assert.throws(() => parseVoucher({ ...wire, channelId: "x" }), /channelId must be 32 bytes/);
  assert.throws(() => parseVoucher({ ...wire, signature: "0x1234" }), /65-byte signature/);
  assert.throws(() => parseSignature(`0x${"zz".repeat(65)}`, "s"), /65-byte signature/);
  assert.equal(parseVoucher({ ...wire, maxClaimableAmount: ((1n << 128n) - 1n).toString() }).maxClaimableAmount, (1n << 128n) - 1n);
  assert.equal(parseVoucher({ ...wire, channelId: wire.channelId.toUpperCase().replace("0X", "0x") }).channelId, wire.channelId.toLowerCase());
});

test("splits follow OstraSplit's rules", () => {
  assert.deepEqual(parseSplits([]), []);
  assert.deepEqual(parseSplits([{ recipient: A.toLowerCase(), bps: 30 }, { recipient: B, bps: 9_970 }]), [
    { recipient: A, bps: 30 },
    { recipient: B, bps: 9_970 },
  ]);
  assert.equal(MAX_SPLIT_RECIPIENTS, 32);
  assert.throws(() => parseSplits({}), /array/);
  assert.throws(() => parseSplits([null]), /splits\[0\] must be/);
  assert.throws(() => parseSplits([{ recipient: A, bps: 0 }]), /from 1 to 10000/);
  assert.throws(() => parseSplits([{ recipient: A, bps: 1.5 }]), /from 1 to 10000/);
  assert.throws(() => parseSplits([{ recipient: zeroAddress, bps: 1 }]), /zero address/);
  assert.throws(() => parseSplits([{ recipient: "nope", bps: 1 }]), /must be an address/);
  assert.throws(() => parseSplits([{ recipient: A, bps: 10 }, { recipient: A.toLowerCase(), bps: 10 }]), /listed twice/);
  assert.throws(() => parseSplits([{ recipient: A, bps: 6_000 }, { recipient: B, bps: 4_001 }]), /10001 bps/);
  const many = Array.from({ length: 33 }, (_, i) => ({ recipient: account(`r${i}`).address, bps: 1 }));
  assert.throws(() => parseSplits(many), /at most 32/);
  assert.equal(parseSplits(many.slice(0, 32)).length, 32);
});

test("bytes32 check", () => {
  assert.equal(isBytes32(keccak256("0x")), true);
  assert.equal(isBytes32("0x12"), false);
  assert.equal(isBytes32(5), false);
});
