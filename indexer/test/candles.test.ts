// Candles from trades, and a token's price from its pool's sqrtPriceX96.

import assert from "node:assert/strict";
import { test } from "node:test";
import { candlesOf, priceFromSqrt, type Trade } from "../src/indexer.ts";

const trade = (time: number, price: number, quoteAmount: string): Trade => ({
  block: "1",
  logIndex: 0,
  txHash: "0x00",
  time,
  side: "buy",
  trader: "0x0000000000000000000000000000000000000001",
  via: "router",
  tokenAmount: "1",
  quoteAmount,
  price,
});

test("candles: one per interval with trades, opening at the previous close, volume in whole quote units", () => {
  const trades = [trade(60, 1, "1000000"), trade(90, 3, "2000000"), trade(110, 2, "500000"), trade(300, 5, "1000000")];
  const c = candlesOf(trades, 60, 6);
  assert.deepEqual(c, [
    { t: 60, o: 1, h: 3, l: 1, c: 2, v: 3.5 },
    { t: 300, o: 2, h: 5, l: 2, c: 5, v: 1 },
  ]);
  assert.deepEqual(candlesOf([], 60, 6), []);
  assert.equal(candlesOf(trades, 60, 6, 1).length, 1);
});

test("price from sqrtPriceX96: the token as currency0 or currency1, in whole quote units", () => {
  const Q96 = 2n ** 96n;
  // currency1 per currency0 = 1e-12 raw: one token (1e18) is 1e6 raw quote, 1 whole USDG.
  const sqrt = Q96 / 1_000_000n;
  assert.ok(Math.abs(priceFromSqrt(sqrt, true, 6) - 1) < 1e-9);
  // The token as currency1: the price is the inverse ratio.
  assert.ok(Math.abs(priceFromSqrt(Q96 * 1_000_000n, false, 6) - 1) < 1e-9);
  // An ETH pool (18 decimals): a raw ratio of 1e-6 is 1e-6 ETH a token.
  assert.ok(Math.abs(priceFromSqrt(Q96 / 1_000n, true, 18) - 1e-6) < 1e-15);
});
