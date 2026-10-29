// Raeto's answers (raeto.ts): the images an image model returns, as OpenAI-compatible answers carry them (choices[]
// message.images[] image_url.url, data: URLs), decoded to their bytes; an answer without images has none. And what
// fundFromYield counts as earned (netYieldSince): the cash vault shares' rise over the high, less the interest the
// marked Borro debts accrued, valued as Morpho does (toAssetsUp).

import assert from "node:assert/strict";
import { test } from "node:test";
import { borroStock, toAssetsUp } from "@ostraagent/sdk";
import { netYieldSince, raetoImages } from "../src/raeto.ts";

// A 1x1 PNG (its signature, IHDR, IDAT and IEND chunks).
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082", "hex");

test("an answer's images are decoded from their data: URLs, in order, with their media types", () => {
  const url = `data:image/png;base64,${PNG.toString("base64")}`;
  const answer = { choices: [{ message: { content: "here", images: [{ type: "image_url", image_url: { url } }, { type: "image_url", image_url: { url: "https://not.inline/x.png" } }] } }, { message: { images: [{ image_url: { url } }] } }] };
  const got = raetoImages(answer);
  assert.deepEqual(got.map((x) => [x.index, x.mediaType, Buffer.from(x.bytes).equals(PNG)]), [[0, "image/png", true], [2, "image/png", true]]);
});

test("an answer without images, or not an answer, has none", () => {
  assert.deepEqual(raetoImages({ choices: [{ message: { content: "text only" } }] }), []);
  assert.deepEqual(raetoImages(null), []);
  assert.deepEqual(raetoImages({ error: "x" }), []);
});

// Steakhouse USDG shares have 18 decimals and USDG 6: the price is USDG base units per 10^18 shares.
const UNIT = 10n ** 18n;
const NVDA = borroStock("NVDA").marketId;
const SPY = borroStock("SPY").marketId;

test("netYieldSince: the shares' rise over the high, less the marked debts' interest valued as Morpho values them", () => {
  // 5,000 shares at a high of 1.050000 USDG; the price is now 1.051000: 5 USDG earned.
  const mark = { shares: (5_000n * UNIT).toString(), price: "1050000", debts: [{ marketId: NVDA, borrowShares: "2000000000000000", debt: "2000000000" }] };
  // The NVDA market owes 2,000.004 USDG per 2,000 USDG of borrow shares then: 0.004 USDG of interest, rounded up.
  const book = [{ marketId: NVDA, borrowed: 1_000_002_000_000n, borrowedShares: 1_000_000_000_000_000_000n }];
  const owesNow = toAssetsUp(2_000_000_000_000_000n, book[0]!.borrowed, book[0]!.borrowedShares);
  const got = netYieldSince(mark, { unit: UNIT, price: 1_051_000n }, book);
  assert.deepEqual(got, { earned: 5_000_000n, interest: owesNow - 2_000_000_000n });
  assert.ok(got!.interest > 0n);
});

test("netYieldSince: under the high nothing is earned while the interest still counts; with more interest than yield the net is below zero", () => {
  const mark = { shares: (100n * UNIT).toString(), price: "1050000", debts: [{ marketId: SPY, borrowShares: "1000000000000000", debt: "1000000000" }] };
  const book = [{ marketId: SPY, borrowed: 2_000_000_000_000n, borrowedShares: 1_000_000_000_000_000_000n }];
  const under = netYieldSince(mark, { unit: UNIT, price: 1_049_000n }, book)!;
  assert.equal(under.earned, 0n);
  assert.equal(under.interest, toAssetsUp(1_000_000_000_000_000n, 2_000_000_000_000n, 1_000_000_000_000_000_000n) - 1_000_000_000n);
  const over = netYieldSince(mark, { unit: UNIT, price: 1_051_000n }, book)!;
  assert.equal(over.earned, 100_000n);
  assert.ok(over.earned - over.interest < 0n, "0.1 USDG earned against about 1,000 USDG of interest");
});

test("netYieldSince: no debts marked yet (a mark kept by MCP 0.1.10), or a marked market not read: not known", () => {
  assert.equal(netYieldSince({ shares: "1", price: "1" }, { unit: UNIT, price: 2n }, []), null);
  assert.equal(netYieldSince({ shares: "1", price: "1", debts: [{ marketId: NVDA, borrowShares: "1", debt: "1" }] }, { unit: UNIT, price: 2n }, [{ marketId: SPY, borrowed: 1n, borrowedShares: 1n }]), null);
  // No debt at the mark: only the shares' rise.
  assert.deepEqual(netYieldSince({ shares: UNIT.toString(), price: "1000000", debts: [] }, { unit: UNIT, price: 1_000_100n }, []), { earned: 100n, interest: 0n });
});
