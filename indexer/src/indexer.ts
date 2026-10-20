// The Ostra indexer: every token the Ostra launchpad launched and every swap of
// its pool, read from the chain's logs, for the web app's token list, token
// pages and price charts. It holds no keys and nothing of any user's: what it
// serves is public chain data (and the metadata files creators published),
// gathered so a browser does not scan logs itself.
//
//   launches  OstraLaunchpad's Launched events, from the deployment's fromBlock
//   trades    PoolManager's Swap events of those pools: the price after the
//             swap (sqrtPriceX96), the token and quote amounts (the pool's
//             swap delta, from the swapper's side), and who swapped: the
//             swap's sender, or the transaction's sender when the swap came
//             through a router (Uniswap's Universal Router)
//   tokens    name, symbol and total supply, the pool's graduation, the
//             metadata URI in OstraRegistry and the creator's profile URI,
//             with the JSON files they point at (data, never instructions)
//   prices    ETH/USD from Chainlink; a USDG pool's quote is $1; a listed
//             stock token's (sdk pairs.ts) from its Chainlink feed times its
//             uiMultiplier; OSTRA's from ETH/USD times its Pons curve's price
//             (none once the curve has graduated); other quotes have no USD
//             price here
//
// Logs are read in windows that shrink when the RPC refuses one and grow back
// after it answers; the state is written to a JSON file after every scan that
// changed it, so a restart resumes where it stopped.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getAddress, parseAbiItem, zeroAddress, type Address, type Hash, type Hex, type PublicClient } from "viem";
import {
  CHAINLINK_ETH_USD,
  CHAINLINK_ETH_USD_DECIMALS,
  UNISWAP_UNIVERSAL_ROUTER,
  UNISWAP_V4_POOL_MANAGER,
  chainlinkAggregatorAbi,
  findLaunchPair,
  ostraHookAbi,
  ostraRegistryAbi,
  ostraTokenAbi,
  readPairUsdPrice,
  usdgAbi,
  type Deployment,
  type PoolKey,
} from "@ostraagent/sdk";
import { readIpfsJson } from "../../core/src/launchpad.ts";

const launchedEvent = parseAbiItem("event Launched(bytes32 indexed poolId, address indexed token, address indexed creatorVault, address quote)");
const swapEvent = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");

/** Uniswap's Universal Routers on chain 4663 (the one Ostra's web app uses, and version 2.1.2): a swap through one is the transaction sender's. */
export const ROUTERS: ReadonlySet<Address> = new Set([UNISWAP_UNIVERSAL_ROUTER, getAddress("0x204FAca1764B154221e35c0d20aBb3c525710498")]);

/** The first log window, and its bounds. */
const WINDOW_START = 200_000n;
const WINDOW_MIN = 500n;
const WINDOW_MAX = 2_000_000n;
/** Pool ids per eth_getLogs topic list. */
const POOLS_PER_QUERY = 100;
/** How often the token details (supply, graduation, metadata URIs) and the ETH price are read again. */
const DETAILS_EVERY_MS = 60_000;
/** A metadata or profile file is fetched again when its URI changes, or after this long. */
const FILE_REFRESH_MS = 30 * 60_000;
/** Most trades kept per pool (the oldest go first); candles over a longer history come from what is kept. */
const MAX_TRADES_PER_POOL = 50_000;

export type Launch = {
  token: Address;
  poolId: Hex;
  creatorVault: Address;
  /** address(0): ETH. */
  quote: Address;
  block: string;
  txHash: Hash;
  /** Unix seconds. */
  time: number;
};

export type Trade = {
  block: string;
  logIndex: number;
  txHash: Hash;
  time: number;
  side: "buy" | "sell";
  /** Who swapped: the swap's sender, or the transaction's sender through a router. */
  trader: Address;
  /** "router" (the trader is the transaction's sender), "contract" (an Ostra vault, or another contract, swapped itself), "dev_buy" or "protocol" (the dispatcher's buyback and floor bid). */
  via: "router" | "contract" | "dev_buy" | "protocol";
  /** Base units, positive. */
  tokenAmount: string;
  quoteAmount: string;
  /** Price of one whole token in whole quote units after the swap. */
  price: number;
};

export type TokenDetails = {
  name: string;
  symbol: string;
  quoteSymbol: string;
  quoteDecimals: number;
  tokenIs0: boolean;
  totalSupply: string;
  graduated: boolean;
  metadataUri: string | null;
  metadata: unknown;
  metadataAt: number;
  profileUri: string | null;
  profile: unknown;
  profileAt: number;
  /** Unix ms of the last details read. */
  readAt: number;
};

export type IndexerState = {
  version: 1;
  chainId: number;
  launchpad: Address;
  scannedTo: string;
  launches: Launch[];
  trades: Record<Hex, Trade[]>;
  tokens: Record<Address, TokenDetails>;
};

export type TokenSummary = {
  token: Address;
  poolId: Hex;
  name: string;
  symbol: string;
  creatorVault: Address;
  quote: { address: Address; symbol: string; decimals: number; usd: number | null };
  createdAt: number;
  launchTx: Hash;
  graduated: boolean;
  /** From the token's metadata file, when it has one (strings only, as published). */
  image: string | null;
  description: string | null;
  links: { website: string | null; x: string | null; telegram: string | null };
  price: number | null;
  priceUsd: number | null;
  marketCap: number | null;
  marketCapUsd: number | null;
  volume24h: number;
  volume24hUsd: number | null;
  change24h: number | null;
  trades24h: number;
  lastTradeAt: number | null;
};

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export const CANDLE_INTERVALS: ReadonlySet<number> = new Set([60, 300, 900, 3_600, 14_400, 86_400]);

/** Candles of `interval` seconds from `trades` (oldest first), volume in whole quote units. */
export function candlesOf(trades: readonly Trade[], interval: number, quoteDecimals: number, limit = 500): Candle[] {
  const out: Candle[] = [];
  for (const t of trades) {
    const start = Math.floor(t.time / interval) * interval;
    const v = Number(t.quoteAmount) / 10 ** quoteDecimals;
    const last = out[out.length - 1];
    if (last !== undefined && last.t === start) {
      last.h = Math.max(last.h, t.price);
      last.l = Math.min(last.l, t.price);
      last.c = t.price;
      last.v += v;
    } else {
      const open = last?.c ?? t.price;
      out.push({ t: start, o: open, h: Math.max(open, t.price), l: Math.min(open, t.price), c: t.price, v });
    }
  }
  return out.slice(-limit);
}

/** A string field of a metadata or profile file, trimmed and capped; null when absent. */
function textField(file: unknown, key: string, max: number): string | null {
  if (file === null || typeof file !== "object") return null;
  const v = (file as Record<string, unknown>)[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t.slice(0, max);
}

/** A link of a metadata file: the field itself, or the same name inside its "links" object. */
function linkField(file: unknown, key: string): string | null {
  const direct = textField(file, key, 200);
  if (direct !== null) return direct;
  if (file === null || typeof file !== "object") return null;
  return textField((file as Record<string, unknown>).links, key, 200);
}

/** The price of one whole token in whole quote units, from a pool's sqrtPriceX96. */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIs0: boolean, quoteDecimals: number): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const raw = s * s; // currency1 per currency0, base unit for base unit
  const perToken = tokenIs0 ? raw : raw === 0 ? 0 : 1 / raw;
  return (perToken * 10 ** 18) / 10 ** quoteDecimals;
}

export type IndexerOptions = {
  client: PublicClient;
  /**
   * The client eth_getLogs goes to (the reads' client by default): an RPC that serves wide block ranges, since a
   * free plan may cap them (Alchemy Free: 10 blocks a request).
   */
  logsClient?: PublicClient;
  /** The deployment record, read again on every scan (it gains `registry` once vault version 2 is recorded). */
  deployment: () => Deployment;
  statePath: string;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Reads a metadata or profile file (core's readIpfsJson by default). */
  readFile?: (uri: string | null) => Promise<unknown>;
  now?: () => number;
};

export class Indexer {
  readonly #client: PublicClient;
  readonly #logsClient: PublicClient;
  readonly #deployment: () => Deployment;
  readonly #statePath: string;
  readonly #log: IndexerOptions["log"];
  readonly #readFile: (uri: string | null) => Promise<unknown>;
  readonly #now: () => number;
  #state: IndexerState;
  #window = WINDOW_START;
  #ethUsd: number | null = null;
  #ethUsdAt = 0;
  /** The USD price of each listed pair token (OSTRA or a stock token) a launched pool pairs with. */
  #pairUsd = new Map<Address, number>();
  #latest = 0n;
  #blockTimes = new Map<bigint, number>();
  #running = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #tokenIndex = new Map<Address, Launch>();
  /** Summaries, computed once per sync (and at most a minute apart, as the 24-hour window moves). */
  #summaries: { at: number; byToken: Map<Address, TokenSummary> } | null = null;

  constructor(o: IndexerOptions) {
    this.#client = o.client;
    this.#logsClient = o.logsClient ?? o.client;
    this.#deployment = o.deployment;
    this.#statePath = o.statePath;
    this.#log = o.log;
    this.#readFile = o.readFile ?? readIpfsJson;
    this.#now = o.now ?? Date.now;
    const d = this.#deployment();
    const lp = this.#launchpadOf(d);
    const fresh: IndexerState = { version: 1, chainId: d.chainId, launchpad: lp, scannedTo: (BigInt(d.fromBlock) - 1n).toString(), launches: [], trades: {}, tokens: {} };
    if (existsSync(this.#statePath)) {
      const saved = JSON.parse(readFileSync(this.#statePath, "utf8")) as IndexerState;
      this.#state = saved.version === 1 && saved.chainId === d.chainId && getAddress(saved.launchpad) === lp ? saved : fresh;
    } else {
      this.#state = fresh;
    }
    for (const l of this.#state.launches) this.#tokenIndex.set(getAddress(l.token), l);
  }

  #launchpadOf(d: Deployment): Address {
    if (d.launchpad === undefined) throw new Error("the deployment has no launchpad");
    return getAddress(d.launchpad.launchpad);
  }

  get scannedTo(): bigint {
    return BigInt(this.#state.scannedTo);
  }

  get latest(): bigint {
    return this.#latest;
  }

  /** Scans until the latest block, then reads the details that are due. True when anything changed. */
  async sync(): Promise<boolean> {
    const d = this.#deployment();
    const lp = d.launchpad;
    if (lp === undefined) throw new Error("the deployment has no launchpad");
    this.#latest = await this.#client.getBlockNumber();
    let changed = false;
    let from = BigInt(this.#state.scannedTo) + 1n;
    while (from <= this.#latest) {
      const to = from + this.#window - 1n < this.#latest ? from + this.#window - 1n : this.#latest;
      try {
        changed = (await this.#scan(d, from, to)) || changed;
      } catch (err) {
        if (this.#window <= WINDOW_MIN) throw err;
        this.#window = this.#window / 2n < WINDOW_MIN ? WINDOW_MIN : this.#window / 2n;
        this.#log("window_shrunk", { window: this.#window.toString(), reason: (err as Error).message.slice(0, 200) });
        continue;
      }
      this.#state.scannedTo = to.toString();
      changed = true;
      from = to + 1n;
      if (this.#window < WINDOW_MAX) this.#window = this.#window * 2n > WINDOW_MAX ? WINDOW_MAX : this.#window * 2n;
    }
    changed = (await this.#refreshDetails(d)) || changed;
    if (changed) {
      this.#save();
      this.#summaries = null;
    }
    return changed;
  }

  /** Reads the launches and swaps of blocks `from`..`to`; true when it found any. */
  async #scan(d: Deployment, from: bigint, to: bigint): Promise<boolean> {
    const lp = d.launchpad;
    if (lp === undefined) return false;
    const launched = await this.#logsClient.getLogs({ address: lp.launchpad, event: launchedEvent, fromBlock: from, toBlock: to });
    const fresh: Launch[] = [];
    for (const l of launched) {
      const a = l.args;
      if (a.token === undefined || a.poolId === undefined || a.creatorVault === undefined || a.quote === undefined || l.blockNumber === null || l.transactionHash === null) continue;
      const token = getAddress(a.token);
      if (this.#tokenIndex.has(token)) continue;
      const launch: Launch = { token, poolId: a.poolId, creatorVault: getAddress(a.creatorVault), quote: getAddress(a.quote), block: l.blockNumber.toString(), txHash: l.transactionHash, time: await this.#blockTime(l.blockNumber) };
      fresh.push(launch);
    }
    // A launch is kept only once its details are read: a failed read fails the window, which is read again.
    for (const launch of fresh) {
      await this.#readDetails(d, launch, true);
      this.#state.launches.push(launch);
      this.#tokenIndex.set(launch.token, launch);
      this.#state.trades[launch.poolId] ??= [];
    }
    const ids = this.#state.launches.filter((l) => BigInt(l.block) <= to).map((l) => l.poolId);
    let found = fresh.length > 0;
    for (let i = 0; i < ids.length; i += POOLS_PER_QUERY) {
      const chunk = ids.slice(i, i + POOLS_PER_QUERY);
      const logs = await this.#logsClient.getLogs({ address: UNISWAP_V4_POOL_MANAGER, event: swapEvent, args: { id: chunk }, fromBlock: from, toBlock: to });
      for (const log of logs) {
        if (await this.#addTrade(d, log)) found = true;
      }
    }
    return found;
  }

  async #addTrade(
    d: Deployment,
    log: { args: { id?: Hex; sender?: Address; amount0?: bigint; amount1?: bigint; sqrtPriceX96?: bigint }; blockNumber: bigint | null; logIndex: number | null; transactionHash: Hash | null },
  ): Promise<boolean> {
    const a = log.args;
    if (a.id === undefined || a.sender === undefined || a.amount0 === undefined || a.amount1 === undefined || a.sqrtPriceX96 === undefined) return false;
    if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) return false;
    const launch = this.#state.launches.find((l) => l.poolId === a.id);
    if (launch === undefined) return false;
    const details = this.#state.tokens[launch.token];
    if (details === undefined) return false;
    const trades = (this.#state.trades[launch.poolId] ??= []);
    const block = log.blockNumber.toString();
    // Windows never overlap and each query returns a pool's logs in order: a log at or before the last kept is seen.
    const last = trades[trades.length - 1];
    if (last !== undefined && (BigInt(last.block) > log.blockNumber || (BigInt(last.block) === log.blockNumber && last.logIndex >= log.logIndex))) return false;
    const tokenDelta = details.tokenIs0 ? a.amount0 : a.amount1;
    const quoteDelta = details.tokenIs0 ? a.amount1 : a.amount0;
    const abs = (v: bigint) => (v < 0n ? -v : v);
    const sender = getAddress(a.sender);
    const lp = d.launchpad;
    let via: Trade["via"] = "contract";
    let trader = sender;
    if (lp !== undefined && sender === getAddress(lp.dispatcher)) via = "protocol";
    else if (lp !== undefined && sender === getAddress(lp.devBuy)) {
      via = "dev_buy";
      trader = launch.creatorVault;
    } else if (ROUTERS.has(sender)) {
      via = "router";
      const tx = await this.#client.getTransaction({ hash: log.transactionHash });
      trader = getAddress(tx.from);
    }
    trades.push({
      block,
      logIndex: log.logIndex,
      txHash: log.transactionHash,
      time: await this.#blockTime(log.blockNumber),
      side: tokenDelta > 0n ? "buy" : "sell",
      trader,
      via,
      tokenAmount: abs(tokenDelta).toString(),
      quoteAmount: abs(quoteDelta).toString(),
      price: priceFromSqrt(a.sqrtPriceX96, details.tokenIs0, details.quoteDecimals),
    });
    if (trades.length > MAX_TRADES_PER_POOL) trades.splice(0, trades.length - MAX_TRADES_PER_POOL);
    return true;
  }

  async #blockTime(block: bigint): Promise<number> {
    const known = this.#blockTimes.get(block);
    if (known !== undefined) return known;
    const b = await this.#client.getBlock({ blockNumber: block });
    const t = Number(b.timestamp);
    if (this.#blockTimes.size > 20_000) this.#blockTimes.clear();
    this.#blockTimes.set(block, t);
    return t;
  }

  /** Reads a token's details; `first` also reads what never changes (name, symbol, the quote's). */
  async #readDetails(d: Deployment, launch: Launch, first: boolean): Promise<boolean> {
    const lp = d.launchpad;
    if (lp === undefined) return false;
    const now = this.#now();
    const old = this.#state.tokens[launch.token];
    const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
      this.#client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
    let base: Pick<TokenDetails, "name" | "symbol" | "quoteSymbol" | "quoteDecimals" | "tokenIs0">;
    if (first || old === undefined) {
      const eth = launch.quote === zeroAddress;
      const [name, symbol, quoteSymbol, quoteDecimals, key] = await Promise.all([
        read<string>(launch.token, ostraTokenAbi, "name"),
        read<string>(launch.token, ostraTokenAbi, "symbol"),
        eth ? Promise.resolve("ETH") : read<string>(launch.quote, usdgAbi, "symbol"),
        eth ? Promise.resolve(18) : read<number>(launch.quote, usdgAbi, "decimals").then(Number),
        read<PoolKey>(lp.hook, ostraHookAbi, "poolKey", [launch.poolId]),
      ]);
      base = { name, symbol, quoteSymbol, quoteDecimals, tokenIs0: getAddress(key.currency0) === launch.token };
    } else {
      base = { name: old.name, symbol: old.symbol, quoteSymbol: old.quoteSymbol, quoteDecimals: old.quoteDecimals, tokenIs0: old.tokenIs0 };
    }
    const registry = d.registry;
    const [totalSupply, state, metadataUri, profileUri] = await Promise.all([
      read<bigint>(launch.token, ostraTokenAbi, "totalSupply"),
      read<{ graduated: boolean }>(lp.hook, ostraHookAbi, "poolState", [launch.poolId]),
      registry === undefined ? Promise.resolve("") : read<string>(registry, ostraRegistryAbi, "tokenMetadataOf", [launch.token]),
      registry === undefined ? Promise.resolve("") : read<string>(registry, ostraRegistryAbi, "profileOf", [launch.creatorVault]),
    ]);
    const mUri = metadataUri === "" ? null : metadataUri;
    const pUri = profileUri === "" ? null : profileUri;
    let metadata: unknown = old?.metadata ?? null;
    let metadataAt = old?.metadataAt ?? 0;
    if (mUri !== (old?.metadataUri ?? null) || (mUri !== null && now - metadataAt > FILE_REFRESH_MS)) {
      metadata = mUri === null ? null : await this.#readFile(mUri);
      metadataAt = now;
    }
    let profile: unknown = old?.profile ?? null;
    let profileAt = old?.profileAt ?? 0;
    if (pUri !== (old?.profileUri ?? null) || (pUri !== null && now - profileAt > FILE_REFRESH_MS)) {
      profile = pUri === null ? null : await this.#readFile(pUri);
      profileAt = now;
    }
    const next: TokenDetails = { ...base, totalSupply: totalSupply.toString(), graduated: state.graduated, metadataUri: mUri, metadata, metadataAt, profileUri: pUri, profile, profileAt, readAt: now };
    const changed = old === undefined || JSON.stringify({ ...old, readAt: 0 }) !== JSON.stringify({ ...next, readAt: 0 });
    this.#state.tokens[launch.token] = next;
    return changed;
  }

  async #refreshDetails(d: Deployment): Promise<boolean> {
    const now = this.#now();
    let changed = false;
    if (now - this.#ethUsdAt > DETAILS_EVERY_MS) {
      try {
        const [, answer] = (await this.#client.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
        this.#ethUsd = Number(answer) / 10 ** CHAINLINK_ETH_USD_DECIMALS;
        this.#ethUsdAt = now;
      } catch (err) {
        this.#log("eth_usd_failed", { reason: (err as Error).message.slice(0, 200) });
      }
      for (const quote of new Set(this.#state.launches.map((l) => getAddress(l.quote)))) {
        const pair = findLaunchPair(quote);
        if (pair === null || (pair.kind !== "stock" && pair.kind !== "ostra")) continue;
        try {
          const price = await readPairUsdPrice(this.#client, pair);
          this.#pairUsd.set(pair.address, Number(price.priceE8) / 1e8);
        } catch (err) {
          // A feed older than readPairUsdPrice accepts, or OSTRA's graduated curve: no USD value rather than an old one.
          // Other failures keep the last price.
          if (/last updated|graduated/.test((err as Error).message)) this.#pairUsd.delete(pair.address);
          this.#log("pair_usd_failed", { quote, reason: (err as Error).message.slice(0, 200) });
        }
      }
    }
    for (const launch of this.#state.launches) {
      const details = this.#state.tokens[launch.token];
      if (details !== undefined && now - details.readAt < DETAILS_EVERY_MS) continue;
      try {
        changed = (await this.#readDetails(d, launch, details === undefined)) || changed;
      } catch (err) {
        this.#log("details_failed", { token: launch.token, reason: (err as Error).message.slice(0, 200) });
      }
    }
    return changed;
  }

  #save(): void {
    const tmp = `${this.#statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.#state), { mode: 0o644 });
    renameSync(tmp, this.#statePath);
  }

  /** Runs sync every `everyMs` until stop(). */
  start(everyMs: number): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async () => {
      try {
        await this.sync();
      } catch (err) {
        this.#log("sync_failed", { reason: (err as Error).message.slice(0, 300) });
      }
      if (this.#running) this.#timer = setTimeout(() => void tick(), everyMs);
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
  }

  // ---------------------------------------------------------------------------
  // Queries (the HTTP API)
  // ---------------------------------------------------------------------------

  /** Every token's summary, from the cache while it is fresh. */
  #allSummaries(): Map<Address, TokenSummary> {
    const now = this.#now();
    if (this.#summaries !== null && now - this.#summaries.at < 60_000) return this.#summaries.byToken;
    const d = this.#deployment();
    const nowSec = Math.floor(now / 1000);
    const byToken = new Map<Address, TokenSummary>();
    for (const l of this.#state.launches) {
      const s = this.#summary(l, d, nowSec);
      if (s !== null) byToken.set(l.token, s);
    }
    this.#summaries = { at: now, byToken };
    return byToken;
  }

  #quoteUsd(quote: Address, d: Deployment): number | null {
    if (quote === zeroAddress) return this.#ethUsd;
    if (getAddress(quote) === getAddress(d.token)) return 1;
    return this.#pairUsd.get(getAddress(quote)) ?? null;
  }

  #summary(launch: Launch, d: Deployment, nowSec: number): TokenSummary | null {
    const details = this.#state.tokens[launch.token];
    if (details === undefined) return null;
    const trades = this.#state.trades[launch.poolId] ?? [];
    const last = trades[trades.length - 1];
    const dayAgo = nowSec - 86_400;
    let volume = 0;
    let count = 0;
    let before: Trade | undefined;
    for (const t of trades) {
      if (t.time >= dayAgo) {
        volume += Number(t.quoteAmount) / 10 ** details.quoteDecimals;
        count++;
      } else {
        before = t;
      }
    }
    const price = last?.price ?? null;
    const supply = Number(details.totalSupply) / 1e18;
    const usd = this.#quoteUsd(launch.quote, d);
    const first24 = trades.find((t) => t.time >= dayAgo);
    const ref = before ?? first24;
    const change = price !== null && ref !== undefined && ref.price > 0 && ref !== last ? ((price - ref.price) / ref.price) * 100 : null;
    const m = details.metadata;
    return {
      token: launch.token,
      poolId: launch.poolId,
      name: details.name,
      symbol: details.symbol,
      creatorVault: launch.creatorVault,
      quote: { address: launch.quote, symbol: details.quoteSymbol, decimals: details.quoteDecimals, usd },
      createdAt: launch.time,
      launchTx: launch.txHash,
      graduated: details.graduated,
      image: textField(m, "image", 300),
      description: textField(m, "description", 2_000),
      links: { website: linkField(m, "website"), x: linkField(m, "x"), telegram: linkField(m, "telegram") },
      price,
      priceUsd: price !== null && usd !== null ? price * usd : null,
      marketCap: price !== null ? price * supply : null,
      marketCapUsd: price !== null && usd !== null ? price * supply * usd : null,
      volume24h: volume,
      volume24hUsd: usd !== null ? volume * usd : null,
      change24h: change,
      trades24h: count,
      lastTradeAt: last?.time ?? null,
    };
  }

  /** The token list: newest first, or by market cap, 24-hour volume or last trade; `q` matches name, symbol or address. */
  tokens(a: { sort: "new" | "marketcap" | "volume" | "active"; q: string | null; offset: number; limit: number }): { total: number; tokens: TokenSummary[] } {
    let list = [...this.#allSummaries().values()];
    if (a.q !== null && a.q !== "") {
      const q = a.q.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q) || s.token.toLowerCase() === q || s.creatorVault.toLowerCase() === q);
    }
    const usdOr = (usd: number | null, raw: number | null) => usd ?? raw ?? 0;
    // Launches in the same second (blocks come every 0.1 s): the later one in the chain first.
    const newer = this.#newerFirst();
    if (a.sort === "new") list.sort((x, y) => y.createdAt - x.createdAt || newer(x.token, y.token));
    else if (a.sort === "marketcap") list.sort((x, y) => usdOr(y.marketCapUsd, y.marketCap) - usdOr(x.marketCapUsd, x.marketCap));
    else if (a.sort === "volume") list.sort((x, y) => usdOr(y.volume24hUsd, y.volume24h) - usdOr(x.volume24hUsd, x.volume24h));
    // Two trades can share a block's second: the newer launch first then, so the order is stable.
    else list.sort((x, y) => (y.lastTradeAt ?? y.createdAt) - (x.lastTradeAt ?? x.createdAt) || y.createdAt - x.createdAt || newer(x.token, y.token));
    return { total: list.length, tokens: list.slice(a.offset, a.offset + a.limit) };
  }

  token(tokenText: string): (TokenSummary & { metadataUri: string | null; metadata: unknown; creator: { vault: Address; profileUri: string | null; profile: unknown } }) | null {
    const launch = this.#tokenIndex.get(getAddress(tokenText));
    if (launch === undefined) return null;
    const s = this.#allSummaries().get(launch.token) ?? null;
    const details = this.#state.tokens[launch.token];
    if (s === null || details === undefined) return null;
    return { ...s, metadataUri: details.metadataUri, metadata: details.metadata, creator: { vault: launch.creatorVault, profileUri: details.profileUri, profile: details.profile } };
  }

  /** The newest trades of a token, newest first; `before` is "block:logIndex" of the last trade a page ended at. */
  trades(tokenText: string, a: { limit: number; before: { block: bigint; logIndex: number } | null }): Trade[] | null {
    const launch = this.#tokenIndex.get(getAddress(tokenText));
    if (launch === undefined) return null;
    const all = this.#state.trades[launch.poolId] ?? [];
    const out: Trade[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < a.limit; i--) {
      const t = all[i] as Trade;
      if (a.before !== null) {
        const b = BigInt(t.block);
        if (b > a.before.block || (b === a.before.block && t.logIndex >= a.before.logIndex)) continue;
      }
      out.push(t);
    }
    return out;
  }

  candles(tokenText: string, interval: number): Candle[] | null {
    const launch = this.#tokenIndex.get(getAddress(tokenText));
    if (launch === undefined) return null;
    const details = this.#state.tokens[launch.token];
    if (details === undefined) return [];
    return candlesOf(this.#state.trades[launch.poolId] ?? [], interval, details.quoteDecimals);
  }

  /** A comparator putting the token launched later in the chain first: launches are kept in the order they were scanned (block, then log). */
  #newerFirst(): (x: Address, y: Address) => number {
    const order = new Map(this.#state.launches.map((l, i) => [l.token, i] as const));
    return (x, y) => (order.get(y) ?? -1) - (order.get(x) ?? -1);
  }

  /** An agent (a creator vault): its profile and the tokens it launched. */
  agent(vaultText: string): { vault: Address; profileUri: string | null; profile: unknown; tokens: TokenSummary[] } {
    const vault = getAddress(vaultText);
    const all = this.#allSummaries();
    const launches = this.#state.launches.filter((l) => l.creatorVault === vault);
    const newer = this.#newerFirst();
    const tokens = launches.map((l) => all.get(l.token)).filter((s): s is TokenSummary => s !== undefined).sort((x, y) => y.createdAt - x.createdAt || newer(x.token, y.token));
    const withProfile = launches.map((l) => this.#state.tokens[l.token]).find((t) => t !== undefined && t.profileUri !== null);
    return { vault, profileUri: withProfile?.profileUri ?? null, profile: withProfile?.profile ?? null, tokens };
  }

  /** The index's progress and the launchpad's totals over the last 24 hours (USD where the quote has a USD price). */
  health(): { chainId: number; scannedTo: string; latest: string; tokens: number; ethUsd: number | null; volume24hUsd: number; trades24h: number } {
    let volume24hUsd = 0;
    let trades24h = 0;
    for (const s of this.#allSummaries().values()) {
      volume24hUsd += s.volume24hUsd ?? 0;
      trades24h += s.trades24h;
    }
    return { chainId: this.#state.chainId, scannedTo: this.#state.scannedTo, latest: this.#latest.toString(), tokens: this.#state.launches.length, ethUsd: this.#ethUsd, volume24hUsd, trades24h };
  }
}
