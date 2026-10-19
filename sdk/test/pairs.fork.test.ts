// The pairs Ostra offers (pairs.ts) against chain 4663's own state, on a fork
// of mainnet: every stock token is a Robinhood stock token by the deployed
// Ostra launchpad's isStockToken, reports its ticker and 18 decimals, and its
// feed names that ticker against USD with 8 decimals; every pair has a USD
// price now (a stock's includes its uiMultiplier); and the USD conversion is
// exact in both directions where it can be.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { ostraLaunchpadAbi } from "../src/abi.ts";
import { CHAINLINK_ETH_USD, USDG } from "../src/constants.ts";
import { chainlinkAggregatorAbi } from "../src/external-abi.ts";
import { LAUNCH_PAIRS, findLaunchPair, launchPair, quoteUnitsToUsd, readPairUsdPrice, usdToQuoteUnits } from "../src/pairs.ts";
import { startFork, type Fork } from "./fork.ts";

const record = JSON.parse(readFileSync(new URL("../../deployments/robinhood-mainnet.json", import.meta.url), "utf8")) as { launchpad: { launchpad: string } };
const LAUNCHPAD_ADDRESS = getAddress(record.launchpad.launchpad);
const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function uiMultiplier() view returns (uint256)"]);

let fork: Fork;

before(async () => {
  fork = await startFork();
});

after(async () => {
  await fork?.stop();
});

test("the list: USDG first, then ETH, then 32 stock tokens, no ticker or address twice", () => {
  assert.equal(LAUNCH_PAIRS[0]?.symbol, "USDG");
  assert.equal(LAUNCH_PAIRS[0]?.address, USDG);
  assert.equal(LAUNCH_PAIRS[1]?.symbol, "ETH");
  assert.equal(LAUNCH_PAIRS[1]?.address, zeroAddress);
  assert.equal(LAUNCH_PAIRS[1]?.feed, CHAINLINK_ETH_USD);
  assert.equal(LAUNCH_PAIRS.filter((p) => p.kind === "stock").length, 32);
  assert.equal(new Set(LAUNCH_PAIRS.map((p) => p.symbol)).size, LAUNCH_PAIRS.length);
  assert.equal(new Set(LAUNCH_PAIRS.map((p) => p.address)).size, LAUNCH_PAIRS.length);
  assert.equal(findLaunchPair("nvda")?.symbol, "NVDA");
  assert.equal(findLaunchPair("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec")?.symbol, "NVDA");
  assert.equal(findLaunchPair("DOGE"), null);
  assert.equal(findLaunchPair("0x0000000000000000000000000000000000000001"), null);
  assert.throws(() => launchPair("DOGE"), /not a pair Ostra offers/);
});

test("every stock token is a Robinhood stock token with its ticker, 18 decimals and its own USD feed", { timeout: 300_000 }, async () => {
  for (const p of LAUNCH_PAIRS.filter((x) => x.kind === "stock")) {
    const a: Address = p.address;
    assert.equal(await fork.client.readContract({ address: LAUNCHPAD_ADDRESS, abi: ostraLaunchpadAbi, functionName: "isStockToken", args: [a] }), true, `${p.symbol} isStockToken`);
    assert.equal(await fork.client.readContract({ address: a, abi: erc20, functionName: "symbol" }), p.symbol, `${p.symbol} symbol`);
    assert.equal(Number(await fork.client.readContract({ address: a, abi: erc20, functionName: "decimals" })), 18, `${p.symbol} decimals`);
    assert.ok((await fork.client.readContract({ address: a, abi: erc20, functionName: "uiMultiplier" })) > 0n, `${p.symbol} uiMultiplier`);
    const feed = p.feed as Address;
    const description = await fork.client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "description" });
    assert.match(description, new RegExp(`(^|[^A-Z])(RH)?${p.symbol}( / |-)USD$`), `${p.symbol} feed ${feed}: ${description}`);
    assert.equal(Number(await fork.client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "decimals" })), 8, `${p.symbol} feed decimals`);
  }
  // ETH and USDG are not stock tokens.
  assert.equal(await fork.client.readContract({ address: LAUNCHPAD_ADDRESS, abi: ostraLaunchpadAbi, functionName: "isStockToken", args: [USDG] }), false);
});

test("every pair has a USD price now; a stock's is its feed times its uiMultiplier", { timeout: 300_000 }, async () => {
  for (const p of LAUNCH_PAIRS) {
    const price = await readPairUsdPrice(fork.client, p);
    assert.ok(price.priceE8 > 0n, `${p.symbol} price`);
    if (p.kind === "usdg") assert.equal(price.priceE8, 100_000_000n);
    if (p.kind === "stock") {
      const round = await fork.client.readContract({ address: p.feed as Address, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" });
      const m = await fork.client.readContract({ address: p.address, abi: erc20, functionName: "uiMultiplier" });
      assert.equal(price.priceE8, (round[1] * m) / 10n ** 18n, `${p.symbol} price`);
    }
  }
});

test("USD to quote units and back", () => {
  // USDG: one to one.
  assert.equal(usdToQuoteUnits(20_000_000_000n, 100_000_000n, 6), 20_000_000_000n);
  assert.equal(quoteUnitsToUsd(20_000_000_000n, 100_000_000n, 6), 20_000_000_000n);
  // $20,000 at $200 a token, 18 decimals: 100 tokens.
  assert.equal(usdToQuoteUnits(20_000_000_000n, 20_000_000_000n, 18), 100n * 10n ** 18n);
  assert.equal(quoteUnitsToUsd(100n * 10n ** 18n, 20_000_000_000n, 18), 20_000_000_000n);
  // Rounded down: $1 at $3 a token.
  assert.equal(usdToQuoteUnits(1_000_000n, 300_000_000n, 18), 333_333_333_333_333_333n);
  assert.throws(() => usdToQuoteUnits(0n, 1n, 18), /positive/);
  assert.throws(() => usdToQuoteUnits(1n, 0n, 18), /positive/);
});
