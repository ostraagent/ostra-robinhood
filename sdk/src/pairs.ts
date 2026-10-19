// The quote currencies a launch through Ostra's own tools can pair with (the
// launchpad contract takes any ERC-20; Ostra's MCP server, web app and relayer
// offer this list only): USDG, ETH and the Robinhood stock tokens that have a
// Chainlink price feed on Robinhood Chain, so a launch's market cap is set in
// US dollars.
//
// Every stock token below was checked on chain 4663 on 20 Oct 2026: its
// address is the one api.robinhood.com/rhj/assets lists for chain 4663, the
// Ostra launchpad's isStockToken returns true for it, its symbol() is the
// ticker and it has 18 decimals; its feed's description() names the same
// ticker against USD, with 8 decimals (Chainlink's directory
// feeds-robinhood-mainnet.json).
//
// A stock token's price in USD is the feed's answer times the token's
// uiMultiplier() / 1e18 (Chainlink, "Robinhood Tokenized Equities": token
// price = underlying price x uiMultiplier), read on chain at the time of use.
// The equity feeds are configured for 24/5 sessions and hold their last value
// when the market is closed (no heartbeat then), so a price is accepted up to
// STOCK_PRICE_MAX_AGE old: a long weekend, not a stale feed.

import { getAddress, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { CHAINLINK_ETH_USD, USDG } from "./constants.ts";
import { chainlinkAggregatorAbi } from "./external-abi.ts";

export type LaunchPairKind = "usdg" | "eth" | "stock";

export type LaunchPair = {
  /** The ticker shown for the pair: USDG, ETH, NVDA, ... */
  symbol: string;
  name: string;
  kind: LaunchPairKind;
  /** The pool's quote currency: address(0) for ETH. */
  address: Address;
  decimals: number;
  /** The Chainlink feed of its USD price (null: USDG, one dollar). */
  feed: Address | null;
};

/** A stock price older than this (seconds) is refused: the equity feeds hold their last value over a closed market (up to a long weekend). */
export const STOCK_PRICE_MAX_AGE = 4 * 86_400;
/** ETH/USD has a heartbeat of 86,400 s: older than this (seconds) is refused. */
export const ETH_PRICE_MAX_AGE = 86_400 + 3_600;

const stock = (symbol: string, name: string, address: string, feed: string): LaunchPair => ({
  symbol,
  name,
  kind: "stock",
  address: getAddress(address),
  decimals: 18,
  feed: getAddress(feed),
});

/** The pairs offered, in the order shown: USDG, ETH, then the stock tokens by ticker. */
export const LAUNCH_PAIRS: readonly LaunchPair[] = [
  { symbol: "USDG", name: "Global Dollar", kind: "usdg", address: USDG, decimals: 6, feed: null },
  { symbol: "ETH", name: "Ether", kind: "eth", address: zeroAddress, decimals: 18, feed: CHAINLINK_ETH_USD },
  stock("AAPL", "Apple", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0"),
  stock("AMZN", "Amazon", "0x12f190a9F9d7D37a250758b26824B97CE941bF54", "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C"),
  stock("ASML", "ASML Holding", "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA", "0xB4106147E8cce40b7d46124090d373A71b70f87D"),
  stock("BABA", "Alibaba Group", "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", "0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984"),
  stock("CLSK", "CleanSpark", "0xcBB95BBF36099d34dA091dc6Fa6F49EfA257Cee3", "0x810c12D3a554Bc47fd39597Fe3b3AAC4941F50eF"),
  stock("COIN", "Coinbase", "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", "0xA3a468A452940B7D6b69991207B508c609a98Ef2"),
  stock("CRCL", "Circle Internet Group", "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", "0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a"),
  stock("DELL", "Dell Technologies", "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd", "0x1C6c8cADBe02E19129c39dDB92281cE4c0bf206b"),
  stock("EWY", "iShares MSCI South Korea ETF", "0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc", "0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1"),
  stock("GOOGL", "Alphabet", "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", "0xF6f373a037c30F0e5010d854385cA89185AE638b"),
  stock("INTC", "Intel", "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", "0x3f390C5C24628Ac7C489515402235FeAD71D1913"),
  stock("IONQ", "IonQ", "0x558378E000D634A36593E338eBacdd6207640EfE", "0x22EfeC4919baf55F360E0EDee4AbEB26DE4971eb"),
  stock("META", "Meta", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", "0x7C38C00C30BEe9378381E7B6135d7283356D71b1"),
  stock("MSFT", "Microsoft", "0xe93237C50D904957Cf27E7B1133b510C669c2e74", "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E"),
  stock("MSTR", "MicroStrategy", "0xec262a75e413fAfD0dF80480274532C79D42da09", "0x396118bdFB181e6240E74D243F266B061c0edc3D"),
  stock("MU", "Micron Technology", "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", "0x425EEFdCf05ed6526C3cE61Af99429A228a6d596"),
  stock("NBIS", "Nebius Group", "0x9D9c6684F596F66a64C030B93A886D51Fd4D7931", "0xE1D87B116Ba0fe898998f1D140339D1fA1E09705"),
  stock("NVDA", "Nvidia", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15"),
  stock("ORCL", "Oracle", "0xb0992820E760d836549ba69BC7598b4af75dEE03", "0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844"),
  stock("PLTR", "Palantir Technologies", "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c"),
  stock("QQQ", "Invesco QQQ ETF", "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", "0x80901d846d5D7B030F26B480776EE3b29374C2ae"),
  stock("RGTI", "Rigetti Computing", "0x284358abc07F9359f19f4b5b4aC91901Be2597Ba", "0x2A045cF1C49c61c166C036d2f06FA2D2d984f765"),
  stock("RKLB", "Rocket Lab", "0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2", "0x045477BF65Aef6f4F2386ad0164579e48381CC74"),
  stock("SGOV", "iShares 0-3 Month Treasury Bond ETF", "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", "0xa0DF4ee0fFf975306345875E3548Fcc519577A11"),
  stock("SLV", "iShares Silver Trust ETF", "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", "0x209b73908e92Ae021826eD79609845451Ecba2ce"),
  stock("SNDK", "SanDisk", "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", "0xfb133Fa4B7b385802B693a293606682Df47109A3"),
  stock("SPCX", "Space Exploration Technologies", "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", "0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb"),
  stock("SPY", "SPDR S&P 500 ETF", "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", "0x319724394D3A0e3669269846abE664Cd621f9f6A"),
  stock("TSLA", "Tesla", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", "0x4A1166a659A55625345e9515b32adECea5547C38"),
  stock("TSM", "Taiwan Semiconductor", "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", "0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F"),
  stock("USAR", "USA Rare Earth", "0xd917B029C761D264c6A312BBbcDA868658eF86a6", "0xA994d3684e8400A6c8078226925779FdeE682DD9"),
  stock("USO", "United States Oil Fund ETF", "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", "0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c"),
];

/** The listed pair of `symbolOrAddress` (a ticker, case-insensitive, or the quote's address), or null. */
export function findLaunchPair(symbolOrAddress: string): LaunchPair | null {
  const s = symbolOrAddress.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    const a = getAddress(s);
    return LAUNCH_PAIRS.find((q) => q.address === a) ?? null;
  }
  const u = s.toUpperCase();
  return LAUNCH_PAIRS.find((q) => q.symbol === u) ?? null;
}

/** The listed pair of `symbolOrAddress`; throws, naming the list, when it is not one. */
export function launchPair(symbolOrAddress: string): LaunchPair {
  const q = findLaunchPair(symbolOrAddress);
  if (q === null) throw new RangeError(`${symbolOrAddress} is not a pair Ostra offers; the pairs are ${LAUNCH_PAIRS.map((x) => x.symbol).join(", ")}`);
  return q;
}

const stockTokenAbi = parseAbi(["function uiMultiplier() view returns (uint256)"]);

export type PairUsdPrice = {
  quote: LaunchPair;
  /** USD per whole quote token, 8 decimals. */
  priceE8: bigint;
  /** When the feed last updated (seconds; USDG: the time read). */
  updatedAt: number;
};

/** The price of `quote` in USD now: USDG is one dollar; ETH and the stock tokens from Chainlink (a stock times its uiMultiplier). */
export async function readPairUsdPrice(client: PublicClient, quote: LaunchPair): Promise<PairUsdPrice> {
  const block = await client.getBlock();
  const now = Number(block.timestamp);
  if (quote.feed === null) return { quote, priceE8: 100_000_000n, updatedAt: now };
  const [decimals, round] = await Promise.all([
    client.readContract({ address: quote.feed, abi: chainlinkAggregatorAbi, functionName: "decimals" }),
    client.readContract({ address: quote.feed, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" }),
  ]);
  if (Number(decimals) !== 8) throw new Error(`the ${quote.symbol}/USD feed ${quote.feed} has ${decimals} decimals, not 8`);
  const answer = round[1];
  const updatedAt = Number(round[3]);
  if (answer <= 0n) throw new Error(`the ${quote.symbol}/USD feed ${quote.feed} answers ${answer}`);
  const maxAge = quote.kind === "stock" ? STOCK_PRICE_MAX_AGE : ETH_PRICE_MAX_AGE;
  if (now - updatedAt > maxAge) {
    throw new Error(`the ${quote.symbol}/USD price was last updated ${Math.round((now - updatedAt) / 3600)} hours ago, older than ${Math.round(maxAge / 3600)} hours; try again once the feed updates`);
  }
  let priceE8 = answer;
  if (quote.kind === "stock") {
    const multiplier = await client.readContract({ address: quote.address, abi: stockTokenAbi, functionName: "uiMultiplier" });
    if (multiplier <= 0n) throw new Error(`${quote.symbol} reports a uiMultiplier of ${multiplier}`);
    priceE8 = (answer * multiplier) / 10n ** 18n;
  }
  return { quote, priceE8, updatedAt };
}

/** `usdE6` US dollars (6 decimals) in base units of a quote priced `priceE8` USD per whole token (8 decimals), rounded down. */
export function usdToQuoteUnits(usdE6: bigint, priceE8: bigint, decimals: number): bigint {
  if (usdE6 <= 0n) throw new RangeError("the amount in USD must be positive");
  if (priceE8 <= 0n) throw new RangeError("the price must be positive");
  return (usdE6 * 10n ** BigInt(decimals) * 100n) / priceE8;
}

/** `units` base units of a quote priced `priceE8` in US dollars (6 decimals), rounded down. */
export function quoteUnitsToUsd(units: bigint, priceE8: bigint, decimals: number): bigint {
  return (units * priceE8) / (10n ** BigInt(decimals) * 100n);
}
