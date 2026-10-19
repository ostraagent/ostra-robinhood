// Reads of a token the Ostra launchpad launched, for anyone: its pool (key and
// config, as OstraHook records them) and the view a buyer reads (price, rules,
// circuit breaker, airdrop round, creator shares). They need no keys, so the
// launchpad service (launchpad.ts), the web app and the indexer share them.

import { getAddress, isAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { ostraAirdropAbi, ostraCreatorSplitAbi, ostraHookAbi, ostraLaunchpadAbi, ostraTokenAbi, poolTick, type LaunchpadDeployment, type PoolKey } from "@ostraagent/sdk";
import { formatUnitsAmount } from "./amount.ts";
import { tokenDecimals } from "./chain.ts";

/** A launched token's pool: its PoolKey and OstraHook's PoolConfig. */
export type LaunchedPool = {
  token: Address;
  id: Hex;
  key: PoolKey;
  config: Record<string, unknown> & { token: Address; creatorVault: Address; tokenIs0: boolean; dividendToken: Address };
};

export type PoolView = {
  token: Address;
  poolId: Hex;
  name: string;
  symbol: string;
  quote: Address;
  creatorVault: Address;
  graduated: boolean;
  tokensSold: string;
  quoteRaised: string;
  /** Price of one token in the quote, and the market cap of the whole supply at it. */
  price: string;
  marketCap: string;
  tick: number;
  /** The circuit breaker: the band this transaction's swaps may move the price in (null: off). */
  band: { lower: number; upper: number } | null;
  buyTaxBps: number;
  sellTaxBps: number;
  antiSnipeBps: number;
  maxBuy: string | null;
  dividendToken: Address | null;
  launchedAt: string;
  airdrop: { round: number; open: boolean; amount: string; claimed: string; endsAt: string | null; available: string; nextRoundAmount: string };
  creatorShares: { recipient: Address; bps: number }[];
  /** The launch's rules as OstraHook and the token keep them (times in ISO 8601, null when the rule is off). */
  rules: {
    quoteDecimals: number;
    supply: string;
    taxEndsAt: string | null;
    postBuyTaxBps: number;
    postSellTaxBps: number;
    /** Where the taxes go, in bps of each tax. */
    buckets: { creator: number; dividend: number; burn: number; lp: number; floor: number };
    antiSnipeEndsAt: string | null;
    maxWallet: string | null;
    limitsEndAt: string | null;
    limitsReleased: boolean;
    antiFarmerEndsAt: string | null;
    graduation: { kind: "tokens_sold" | "quote_raised"; threshold: string };
    volatilityFee: boolean;
    stockQuote: boolean;
    maxTxMoveTicks: number;
  };
};

type HookConfig = {
  tokenIs0: boolean;
  creatorVault: Address;
  postBuyTaxBps: number;
  postSellTaxBps: number;
  taxEndAt: number;
  creatorBucketBps: number;
  dividendBucketBps: number;
  burnBucketBps: number;
  lpBucketBps: number;
  floorBucketBps: number;
  antiSnipeBps: number;
  antiSnipeDuration: number;
  maxBuy: bigint;
  limitsEndAt: number;
  antiFarmerEndAt: number;
  graduationKind: number;
  graduationThreshold: bigint;
  launchedAt: number;
  dividendToken: Address;
  stockQuote: boolean;
  volatilityFee: boolean;
  maxTxMoveTicks: number;
};

function iso(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

/** `text` as a checksummed address; throws naming `what` when it is not one. */
export function launchedTokenAddress(text: string, what = "token"): Address {
  if (!isAddress(text, { strict: false })) throw new RangeError(`${what} ${text} is not an address`);
  return getAddress(text);
}

/** The pool of `tokenText`, a token the Ostra launchpad `lp` launched. */
export async function readLaunchedPool(client: PublicClient, lp: LaunchpadDeployment, tokenText: string): Promise<LaunchedPool> {
  const token = launchedTokenAddress(tokenText);
  const id = (await client.readContract({ address: lp.launchpad, abi: ostraLaunchpadAbi, functionName: "poolOf", args: [token] })) as Hex;
  if (BigInt(id) === 0n) throw new Error(`${token} is not a token the Ostra launchpad launched`);
  const [key, config] = await Promise.all([
    client.readContract({ address: lp.hook, abi: ostraHookAbi, functionName: "poolKey", args: [id] }) as Promise<PoolKey>,
    client.readContract({ address: lp.hook, abi: ostraHookAbi, functionName: "poolConfig", args: [id] }) as Promise<LaunchedPool["config"]>,
  ]);
  return { token, id, key, config };
}

/** The pool's quote currency (address(0): ETH). */
export function quoteOfPool(pool: LaunchedPool): Address {
  return getAddress(pool.config.tokenIs0 ? pool.key.currency1 : pool.key.currency0);
}

/** A launched token's pool: price, rules, circuit breaker, airdrop round and creator shares. */
export async function readPoolView(client: PublicClient, lp: LaunchpadDeployment, tokenText: string): Promise<PoolView> {
  const pool = await readLaunchedPool(client, lp, tokenText);
  const c = pool.config as unknown as HookConfig;
  const quote = quoteOfPool(pool);
  const quoteDecimals = quote === zeroAddress ? 18 : await tokenDecimals(client, quote);
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
  const [state, rates, tick, name, symbol, round, available, nextAmount, shares, maxWallet, limitsReleased] = await Promise.all([
    read<{ graduated: boolean; supply: bigint; tokensSold: bigint; quoteRaised: bigint }>(lp.hook, ostraHookAbi, "poolState", [pool.id]),
    read<readonly [bigint, bigint, bigint]>(lp.hook, ostraHookAbi, "rates", [pool.id]),
    poolTick(client, pool.id),
    read<string>(pool.token, ostraTokenAbi, "name"),
    read<string>(pool.token, ostraTokenAbi, "symbol"),
    read<{ amount: bigint; claimed: bigint; endsAt: number; number: number; open: boolean }>(lp.airdrop, ostraAirdropAbi, "round", [pool.id]),
    read<bigint>(lp.airdrop, ostraAirdropAbi, "available", [pool.id]),
    read<bigint>(lp.airdrop, ostraAirdropAbi, "nextRoundAmount", [pool.id]),
    read<readonly [readonly Address[], readonly number[]]>(lp.creatorSplit, ostraCreatorSplitAbi, "recipients", [pool.id]),
    read<bigint>(pool.token, ostraTokenAbi, "MAX_WALLET"),
    read<boolean>(pool.token, ostraTokenAbi, "limitsReleased"),
  ]);
  const band = c.maxTxMoveTicks === 0 ? null : await read<readonly [number, number]>(lp.hook, ostraHookAbi, "txMoveBand", [pool.id]);
  // The tick prices currency0 in currency1, raw unit for raw unit.
  const raw = Math.pow(1.0001, tick);
  const perRaw = c.tokenIs0 ? raw : 1 / raw;
  const price = (perRaw * 10 ** 18) / 10 ** quoteDecimals;
  const supply = Number(state.supply) / 1e18;
  const fmtQuote = (v: bigint) => formatUnitsAmount(v < 0n ? 0n : v, quoteDecimals);
  const at = (seconds: number) => (seconds === 0 ? null : iso(BigInt(seconds)));
  return {
    token: pool.token,
    poolId: pool.id,
    name,
    symbol,
    quote,
    creatorVault: getAddress(c.creatorVault),
    graduated: state.graduated,
    tokensSold: formatUnitsAmount(state.tokensSold < 0n ? 0n : state.tokensSold, 18),
    quoteRaised: fmtQuote(state.quoteRaised),
    price: price.toPrecision(6),
    marketCap: (price * supply).toFixed(2),
    tick,
    band: band === null ? null : { lower: band[0], upper: band[1] },
    buyTaxBps: Number(rates[0]),
    sellTaxBps: Number(rates[1]),
    antiSnipeBps: Number(rates[2]),
    maxBuy: c.maxBuy === 0n ? null : formatUnitsAmount(c.maxBuy, 18),
    dividendToken: getAddress(c.dividendToken) === zeroAddress ? null : getAddress(c.dividendToken),
    launchedAt: iso(BigInt(c.launchedAt)),
    airdrop: {
      round: round.number,
      open: round.open,
      amount: formatUnitsAmount(round.amount, 18),
      claimed: formatUnitsAmount(round.claimed, 18),
      endsAt: round.number === 0 ? null : iso(BigInt(round.endsAt)),
      available: formatUnitsAmount(available, 18),
      nextRoundAmount: formatUnitsAmount(nextAmount, 18),
    },
    creatorShares: shares[0].map((recipient, i) => ({ recipient: getAddress(recipient), bps: Number(shares[1][i]) })),
    rules: {
      quoteDecimals,
      supply: formatUnitsAmount(state.supply, 18),
      taxEndsAt: at(c.taxEndAt),
      postBuyTaxBps: c.postBuyTaxBps,
      postSellTaxBps: c.postSellTaxBps,
      buckets: { creator: c.creatorBucketBps, dividend: c.dividendBucketBps, burn: c.burnBucketBps, lp: c.lpBucketBps, floor: c.floorBucketBps },
      antiSnipeEndsAt: c.antiSnipeBps === 0 || c.antiSnipeDuration === 0 ? null : iso(BigInt(c.launchedAt) + BigInt(c.antiSnipeDuration)),
      maxWallet: maxWallet === 0n ? null : formatUnitsAmount(maxWallet, 18),
      limitsEndAt: at(c.limitsEndAt),
      limitsReleased,
      antiFarmerEndsAt: at(c.antiFarmerEndAt),
      graduation: {
        kind: c.graduationKind === 2 ? "quote_raised" : "tokens_sold",
        threshold: c.graduationKind === 2 ? fmtQuote(c.graduationThreshold) : String(c.graduationThreshold),
      },
      volatilityFee: c.volatilityFee,
      stockQuote: c.stockQuote,
      maxTxMoveTicks: c.maxTxMoveTicks,
    },
  };
}
