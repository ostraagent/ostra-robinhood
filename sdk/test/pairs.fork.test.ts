// The pairs Ostra offers (pairs.ts) against chain 4663's own state, on a fork
// of mainnet: every stock token is a Robinhood stock token by the deployed
// Ostra launchpad's isStockToken, reports its ticker and 18 decimals, and its
// feed names that ticker against USD with 8 decimals; every pair has a USD
// price now (a stock's includes its uiMultiplier; OSTRA's is ETH/USD times its
// spot price in the pool Pons graduated it to); OSTRA and its curve are the code
// they were checked as, the curve has graduated and holds nothing, and OSTRA's
// pool is that pool, priced and quoted; and the USD conversion is exact in both
// directions where it can be.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { encodeAbiParameters, getAddress, keccak256, parseAbi, zeroAddress, type Address } from "viem";
import { ostraLaunchpadAbi } from "../src/abi.ts";
import { CHAINLINK_ETH_USD, OSTRA, OSTRA_CODE_HASH, OSTRA_PONS_CURVE, OSTRA_PONS_CURVE_CODE_HASH, OSTRA_POOL_FEE, OSTRA_POOL_TICK_SPACING, PONS_HOOK, UNISWAP_V4_QUOTER, USDG } from "../src/constants.ts";
import { chainlinkAggregatorAbi, ponsCurveAbi } from "../src/external-abi.ts";
import { LAUNCH_PAIRS, OSTRA_POOL_ID, findLaunchPair, launchPair, quoteUnitsToUsd, readOstraPool, readPairUsdPrice, usdToQuoteUnits } from "../src/pairs.ts";
import { startFork, type Fork } from "./fork.ts";

const record = JSON.parse(readFileSync(new URL("../../deployments/robinhood-mainnet.json", import.meta.url), "utf8")) as { launchpad: { launchpad: string } };
const LAUNCHPAD_ADDRESS = getAddress(record.launchpad.launchpad);
const erc20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function uiMultiplier() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const poolKeyType = { type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] } as const;
const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [{ name: "poolKey", ...poolKeyType }, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
  },
] as const;
const ostraKey = { currency0: zeroAddress, currency1: OSTRA, fee: OSTRA_POOL_FEE, tickSpacing: OSTRA_POOL_TICK_SPACING, hooks: PONS_HOOK };

let fork: Fork;

before(async () => {
  fork = await startFork();
});

after(async () => {
  await fork?.stop();
});

test("the list: USDG first, then ETH, then OSTRA, then 32 stock tokens, no ticker or address twice", () => {
  assert.equal(LAUNCH_PAIRS[0]?.symbol, "USDG");
  assert.equal(LAUNCH_PAIRS[0]?.address, USDG);
  assert.equal(LAUNCH_PAIRS[1]?.symbol, "ETH");
  assert.equal(LAUNCH_PAIRS[1]?.address, zeroAddress);
  assert.equal(LAUNCH_PAIRS[1]?.feed, CHAINLINK_ETH_USD);
  assert.equal(LAUNCH_PAIRS[2]?.symbol, "OSTRA");
  assert.equal(LAUNCH_PAIRS[2]?.kind, "ostra");
  assert.equal(LAUNCH_PAIRS[2]?.address, OSTRA);
  assert.equal(LAUNCH_PAIRS.length, 35);
  assert.equal(LAUNCH_PAIRS.filter((p) => p.kind === "stock").length, 32);
  assert.equal(findLaunchPair("ostra")?.address, OSTRA);
  assert.equal(findLaunchPair(OSTRA.toLowerCase())?.symbol, "OSTRA");
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
  // ETH, USDG and OSTRA are not stock tokens.
  assert.equal(await fork.client.readContract({ address: LAUNCHPAD_ADDRESS, abi: ostraLaunchpadAbi, functionName: "isStockToken", args: [USDG] }), false);
  assert.equal(await fork.client.readContract({ address: LAUNCHPAD_ADDRESS, abi: ostraLaunchpadAbi, functionName: "isStockToken", args: [OSTRA] }), false);
});

test("OSTRA and its Pons curve: the code checked, the token's facts, the curve graduated and empty, and OSTRA's pool the one Pons graduated it to", { timeout: 300_000 }, async () => {
  assert.equal(keccak256((await fork.client.getCode({ address: OSTRA })) ?? "0x"), OSTRA_CODE_HASH, "OSTRA's code");
  assert.equal(keccak256((await fork.client.getCode({ address: OSTRA_PONS_CURVE })) ?? "0x"), OSTRA_PONS_CURVE_CODE_HASH, "the curve's code");
  assert.equal(await fork.client.readContract({ address: OSTRA, abi: erc20, functionName: "symbol" }), "OSTRA");
  assert.equal(await fork.client.readContract({ address: OSTRA, abi: erc20, functionName: "name" }), "Ostra Agent");
  assert.equal(Number(await fork.client.readContract({ address: OSTRA, abi: erc20, functionName: "decimals" })), 18);
  assert.ok((await fork.client.readContract({ address: OSTRA, abi: erc20, functionName: "totalSupply" })) <= 1_000_000_000n * 10n ** 18n);
  assert.equal(getAddress(await fork.client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "token" })), OSTRA);
  // OSTRA graduated on 22 Oct 2026: the curve holds neither OSTRA nor ETH.
  assert.equal(await fork.client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "graduated" }), true, "OSTRA has graduated from its Pons curve");
  assert.equal(await fork.client.readContract({ address: OSTRA, abi: erc20, functionName: "balanceOf", args: [OSTRA_PONS_CURVE] }), 0n);
  assert.equal(await fork.client.getBalance({ address: OSTRA_PONS_CURVE }), 0n);
  // Its pool: the id of its key, priced, with liquidity, and a buy and a sell through it quote near the spot price.
  assert.equal(OSTRA_POOL_ID, keccak256(encodeAbiParameters([poolKeyType], [ostraKey])));
  const { sqrtPriceX96, liquidity } = await readOstraPool(fork.client);
  assert.ok(sqrtPriceX96 > 0n && liquidity > 0n, "OSTRA's pool has a price and liquidity");
  const ethIn = 10n ** 15n;
  const spotOut = (ethIn * sqrtPriceX96 * sqrtPriceX96) >> 192n;
  const { result: buy } = await fork.client.simulateContract({ address: UNISWAP_V4_QUOTER, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: ostraKey, zeroForOne: true, exactAmount: ethIn, hookData: "0x" }] });
  assert.ok(buy[0] > 0n && buy[0] <= spotOut && buy[0] * 100n >= spotOut * 90n, `a buy of 0.001 ETH: ${buy[0]} OSTRA against ${spotOut} at the spot price`);
  const ostraIn = 1_000n * 10n ** 18n;
  const { result: sell } = await fork.client.simulateContract({ address: UNISWAP_V4_QUOTER, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: ostraKey, zeroForOne: false, exactAmount: ostraIn, hookData: "0x" }] });
  const spotEth = (ostraIn << 192n) / (sqrtPriceX96 * sqrtPriceX96);
  assert.ok(sell[0] > 0n && sell[0] <= spotEth && sell[0] * 100n >= spotEth * 90n, `a sell of 1,000 OSTRA: ${sell[0]} wei against ${spotEth} at the spot price`);
});

test("every pair has a USD price now; a stock's is its feed times its uiMultiplier", { timeout: 300_000 }, async () => {
  for (const p of LAUNCH_PAIRS) {
    const price = await readPairUsdPrice(fork.client, p);
    assert.ok(price.priceE8 > 0n, `${p.symbol} price`);
    if (p.kind === "usdg") assert.equal(price.priceE8, 100_000_000n);
    if (p.kind === "ostra") {
      const round = await fork.client.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" });
      const { sqrtPriceX96 } = await readOstraPool(fork.client);
      assert.equal(price.priceE8, (round[1] << 192n) / (sqrtPriceX96 * sqrtPriceX96), "OSTRA price");
    }
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
