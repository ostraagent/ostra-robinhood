// The launch helpers without a chain: the launch kept to send a signed
// launch again (encodeLaunch, decodeLaunch, decodeLaunchFromVaultData), the
// dev buy bounds checked before signing, DevBuy params read back only in
// their canonical form, the starting tick of a market cap, and reverts of
// Ostra's contracts named by their error. The fork tests compare launchHash
// with the contract's own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeErrorResult, getAddress, keccak256, zeroAddress, type Hex } from "viem";
import { ostraLaunchpadAbi } from "../src/abi.ts";
import { DEV_BUY, LAUNCHPAD } from "../src/constants.ts";
import {
  NO_DEV_BUY,
  checkDevBuyTerms,
  decodeDevBuyParams,
  decodeLaunch,
  decodeLaunchFromVaultData,
  devBuyParams,
  encodeLaunch,
  launchFromVaultData,
  launchHash,
  launchParams,
  startTickForMarketCap,
} from "../src/launch.ts";
import { ostraRevertReason } from "../src/relayer.ts";

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const p = launchParams({ name: "Kept Launch", symbol: "KEPT", salt: `0x${"0a".repeat(32)}`, quote: at(0x5f), creatorVault: at(0xaa), startTick: -375_400, sellTaxBps: 100, creatorBucketBps: 10_000, maxBuy: 10n ** 24n });
const dev = { quoteIn: 50_000_000n, beneficiary: at(0xab), dividendRecipient: zeroAddress, cliff: DEV_BUY.MIN_CLIFF, duration: 86_400 };

test("a launch is kept as abi.encode(p, d) and read back exactly; its hash is the hash of that encoding", () => {
  const encoded = encodeLaunch(p, dev);
  const back = decodeLaunch(encoded);
  assert.equal(encodeLaunch(back.launch, back.dev), encoded);
  assert.equal(back.launch.symbol, "KEPT");
  assert.equal(back.launch.maxBuy, 10n ** 24n);
  assert.equal(back.dev.quoteIn, 50_000_000n);
  assert.equal(launchHash(p, dev), keccak256(encoded));
  assert.notEqual(launchHash(p, dev), launchHash(p, NO_DEV_BUY));
  assert.notEqual(launchHash(p, dev), launchHash({ ...p, salt: `0x${"0b".repeat(32)}` }, dev));
  const signed = { nextKeyRoot: `0x${"cd".repeat(32)}` as Hex, signature: `0x${"ef".repeat(1892)}` as Hex };
  const call = decodeLaunchFromVaultData(launchFromVaultData(p, dev, signed));
  assert.equal(launchHash(call.launch, call.dev), launchHash(p, dev));
  assert.equal(call.nextKeyRoot, signed.nextKeyRoot);
  assert.equal(call.signature, signed.signature);
  assert.throws(() => decodeLaunchFromVaultData("0x12345678"), /./);
});

test("the dev buy's bounds are checked before anything is signed", () => {
  checkDevBuyTerms(NO_DEV_BUY, false);
  checkDevBuyTerms(dev, false);
  assert.throws(() => checkDevBuyTerms({ ...NO_DEV_BUY, cliff: 1 }, false), /every other dev buy field 0/);
  assert.throws(() => checkDevBuyTerms({ ...dev, beneficiary: zeroAddress }, false), /beneficiary/);
  assert.throws(() => checkDevBuyTerms(dev, true), /dividend recipient/);
  checkDevBuyTerms({ ...dev, dividendRecipient: at(0xac) }, true);
  assert.throws(() => checkDevBuyTerms({ ...dev, cliff: DEV_BUY.MIN_CLIFF - 1 }, false), /cliff/);
  assert.throws(() => checkDevBuyTerms({ ...dev, cliff: DEV_BUY.MAX_CLIFF + 1 }, false), /cliff/);
  assert.throws(() => checkDevBuyTerms({ ...dev, duration: DEV_BUY.MAX_VESTING + 1 }, false), /vesting/);
});

test("DevBuy params: 96 bytes, read back only in their canonical encoding", () => {
  const hash = launchHash(p, dev);
  const params = devBuyParams({ devBuy: at(0x76), launchHash: hash, amount: 5n });
  assert.equal((params.length - 2) / 2, 96);
  assert.deepEqual(decodeDevBuyParams(params), { devBuy: at(0x76), launchHash: hash, amount: 5n });
  assert.throws(() => devBuyParams({ devBuy: at(0x76), launchHash: `0x${"00".repeat(32)}`, amount: 5n }), /launchHash/);
  assert.throws(() => decodeDevBuyParams(`${params}00` as Hex), /96 bytes/);
  // A dirty address word decodes, but is not the canonical encoding the vault signs.
  const dirty = `0x${"ff".repeat(12)}${params.slice(26)}` as Hex;
  assert.throws(() => decodeDevBuyParams(dirty), /./);
});

test("the starting tick of a market cap, on the tick spacing", () => {
  assert.equal(startTickForMarketCap(50_000_000_000n), -375_400);
  for (const mc of [1_000_000n, 20_000_000_000n, 10n ** 15n]) assert.ok(startTickForMarketCap(mc) % LAUNCHPAD.TICK_SPACING === 0, `${mc}`);
  assert.ok(startTickForMarketCap(100_000_000_000n) > startTickForMarketCap(50_000_000_000n));
  assert.throws(() => startTickForMarketCap(0n), /positive/);
});

test("a revert of Ostra's contracts is named by its error", () => {
  const data = encodeErrorResult({ abi: ostraLaunchpadAbi, errorName: "BadParams", args: ["buckets"] });
  assert.equal(ostraRevertReason(data), "BadParams(buckets)");
  assert.equal(ostraRevertReason(encodeAbiParameters([{ type: "uint256" }], [1n])), null);
  assert.equal(ostraRevertReason(undefined), null);
  assert.equal(ostraRevertReason("0x"), null);
});
