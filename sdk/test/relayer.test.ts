// Relay requests and their price (relayer.ts): the rules the relayer charges
// by and an agent checks a quote with. Chainlink itself is read in
// relayer.fork.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { concat, decodeFunctionData, getAddress, hexToBytes, keccak256, type Hex } from "viem";
import { MULTICALL3 } from "../src/constants.ts";
import { multicall3Abi } from "../src/external-abi.ts";
import {
  ETH_USD_DEVIATION_BPS,
  ETH_USD_MAX_AGE_SECONDS,
  MAX_RELAY_CALLS,
  RELAYER_MARGIN_BPS,
  RELAYER_QUOTE_TOLERANCE_BPS,
  checkFresh,
  maxAcceptedQuote,
  relayCalls,
  relayRequestBody,
  relayRequestHash,
  relayTransaction,
  weiToTokenUnits,
  withMargin,
} from "../src/relayer.ts";

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
/** $4,000.00 per ETH in the feed's 8 decimals. */
const price = { answer: 400_000_000_000n, roundId: 1n, updatedAt: 1_000n };

test("decided numbers", () => {
  assert.equal(RELAYER_MARGIN_BPS, 1_000n);
  assert.equal(RELAYER_QUOTE_TOLERANCE_BPS, 200n);
  assert.equal(ETH_USD_DEVIATION_BPS, 50n);
  assert.equal(ETH_USD_MAX_AGE_SECONDS, 90_000n);
  assert.equal(MAX_RELAY_CALLS, 8);
});

test("the margin is 10%, rounded up", () => {
  assert.equal(withMargin(1_000n), 1_100n);
  assert.equal(withMargin(1n), 2n);
  assert.equal(withMargin(0n), 0n);
});

test("wei to token units: at the answer + 0.5%, rounded up, at least 1", () => {
  // 0.001 ETH at $4,000 = $4, + 0.5% = $4.02 = 4,020,000 units of a 6-decimal token.
  assert.equal(weiToTokenUnits(10n ** 15n, price, 6), 4_020_000n);
  // One more wei rounds up by one unit.
  assert.equal(weiToTokenUnits(10n ** 15n + 1n, price, 6), 4_020_001n);
  // A tiny cost is still one unit; nothing costs nothing.
  assert.equal(weiToTokenUnits(1n, price, 6), 1n);
  assert.equal(weiToTokenUnits(0n, price, 6), 0n);
  assert.throws(() => weiToTokenUnits(1n, { ...price, answer: 0n }, 6), RangeError);
  assert.throws(() => weiToTokenUnits(1n, price, 19), RangeError);
});

test("an agent pays a quote at most 2% above its own price", () => {
  assert.equal(maxAcceptedQuote(1_000n), 1_020n);
  assert.equal(maxAcceptedQuote(1n), 2n);
  assert.throws(() => maxAcceptedQuote(-1n), RangeError);
});

test("an ETH/USD answer older than the heartbeat plus an hour is refused", () => {
  checkFresh(price, price.updatedAt + ETH_USD_MAX_AGE_SECONDS);
  assert.throws(() => checkFresh(price, price.updatedAt + ETH_USD_MAX_AGE_SECONDS + 1n), /old/);
  assert.throws(() => checkFresh({ ...price, updatedAt: 10n ** 9n }, 1_000n), /future/);
});

test("one call is sent as it is; several go through Multicall3 aggregate3, none allowed to fail", () => {
  const a = { to: at(1), data: "0x12345678aa" as Hex };
  const b = { to: at(2), data: "0xdeadbeef" as Hex };
  assert.deepEqual(relayTransaction([a]), { to: a.to, data: a.data });
  const tx = relayTransaction([a, b]);
  assert.equal(tx.to, MULTICALL3);
  const decoded = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
  assert.equal(decoded.functionName, "aggregate3");
  assert.deepEqual(decoded.args[0], [
    { target: a.to, allowFailure: false, callData: a.data },
    { target: b.to, allowFailure: false, callData: b.data },
  ]);
  assert.equal(relayRequestHash([a, b]), keccak256(concat([hexToBytes(MULTICALL3), hexToBytes(tx.data)]), "hex"));
});

test("calls are checked and normalized; the body an agent posts reads back", () => {
  const calls = relayCalls([{ to: at(1).toLowerCase(), data: "0xABCDEF01" }]);
  assert.deepEqual(calls, [{ to: at(1), data: "0xabcdef01" }]);
  assert.deepEqual(JSON.parse(relayRequestBody(calls, { prepay: true, payer: at(3) })), { calls: [{ to: at(1), data: "0xabcdef01" }], prepay: true, payer: at(3) });
  assert.deepEqual(JSON.parse(relayRequestBody(calls)), { calls: [{ to: at(1), data: "0xabcdef01" }] });
  assert.throws(() => relayCalls(Array.from({ length: MAX_RELAY_CALLS + 1 }, () => ({ to: at(1), data: "0x12345678" }))), /at most 8 calls/);
  assert.throws(() => relayCalls([{ to: at(1), data: "0x123456" }]), /4-byte selector/);
  assert.throws(() => relayCalls([{ to: at(1), data: "0x12345678", value: "0x1" }]), /no ETH value/);
});
