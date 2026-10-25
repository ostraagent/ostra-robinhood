// The trading capital (design "Modal kerja trading", decided by Edu on 24 Oct 2026): USDG of the agent's vault set
// aside for swaps the agent decides, with Ostra's limits on it, which an agent may only tighten (strategy-rules
// tradingLimits): a position at most 25% of the capital and at most the size whose quote moves the price 1%; buys stop
// for the day after a 5% loss of the capital that day, and for the week after 10% that week. "Keputusan beli-jual
// diambil agent; Ostra memberi porsi, pagar dan quote."
//
// The ledger, kept on this machine with the strategies' records, holds the capital's USDG (`cash`, in the USDG vault:
// the strategies' plans keep it out of the cash vaults) and the tokens its buys bought (`positions`, in the agent's
// vaults of those tokens). Its value now is the cash, each position at the quote of selling it (no more than its vault
// holds), and what its open orders hold. Trades are Ostra Swap orders between USDG and one token (swap.ts): a buy is
// refused while buys are stopped, past the cash, or when the position after it (with what open buys of it hold) would
// pass its limit; a sell is at most the position and is never refused for the limits (it lowers the risk). A large
// trade is split by its quote's impact like any swap (swap.ts). The cash counts at most what the USDG vault holds: a
// swap outside the capital (ostra_swap) that spends it is a loss of the capital.
//
// Each trade is kept as pending from before its first Transfer is signed (swap.ts onOrder, or onSplit for a split
// trade) until it finished, so a process that stops in between loses nothing: what it spent and received is read back
// from the chain (SwapService.orderResult, splitResult). While a trade is open, the USDG of the capital it has not
// spent (a buy) or has received (a sell) stays reserved in the USDG vault, and the tokens a sell has not sold stay the
// capital's (the strategies do not lend them).

import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { USDG } from "@ostraagent/sdk";
import { formatUnitsAmount, parseUnitsAmount, TOKEN_DECIMALS } from "./amount.ts";
import { chainTime, tokenBalance, tokenDecimals } from "./chain.ts";
import type { Folder } from "./storage.ts";
import { BPS, DAY, buysAllowed, impactLimitedSize, positionMax, tradingLimits, type TradingLimits } from "./strategy-rules.ts";
import type { OstraSwapResult, SwapService } from "./swap.ts";
import type { VaultService } from "./vault.ts";

/** The ledger's file, in the strategies' folder. */
export const TRADING_LEDGER = "trading-ledger.json";
/**
 * The day and the week in which buys were stopped by a loss, kept apart from the ledger: ending the capital and
 * setting it again does not lift a stop before its day or week is over.
 */
export const TRADING_STOPS = "trading-stops.json";
/** More than any balance: an open buy's token is left whole to the capital. */
const ALL = 1n << 255n;

type LimitsJson = { positionMaxBps: string; maxImpactBps: string; dailyLossBps: string; weeklyLossBps: string };

/**
 * A trade of the capital not finished yet (its input left the ledger when it began): an order (`order`, with a block
 * before it and its escrow) or a split swap (`split`, its id).
 */
type Pending = { order: Hex; side: "buy" | "sell"; token: Address; amountIn: string } & ({ kind?: "order"; fromBlock: string; escrow: Address } | { kind: "split" });

type Ledger = {
  version: 1;
  /** USDG base units set aside when the capital was set. */
  capital: string;
  /** USDG base units of the capital in the USDG vault. */
  cash: string;
  /** Base units of each token the capital holds, by token address. */
  positions: Record<string, string>;
  limits: LimitsJson;
  /** The day and the week (from Monday) the start values were taken in, and the capital's value then. */
  day: string;
  dayStart: string;
  week: string;
  weekStart: string;
  pending: Pending[];
};

export type TradingParts = {
  client: PublicClient;
  /** Ostra Swap (null: not configured here; then nothing can be traded). */
  swap: SwapService | null;
  buyer: VaultService;
  tokenVault: (token: Address) => VaultService;
  /** The strategies' folder. */
  folder: Folder;
  /** The ERC-8004 gate of Ostra's strategies (StrategyService.gate): setting a capital and buying need it. */
  gate: () => Promise<unknown>;
};

export type TradingStatus = {
  capital: string;
  cash: string;
  /** The capital's value now (USDG): its cash, its positions at the quote of selling them, what its open orders hold. */
  value: string;
  positions: { token: Address; amount: string; value: string }[];
  pendingOrders: number;
  limits: LimitsJson;
  buys: { ok: boolean; reason: string };
  dayStart: string;
  weekStart: string;
  /** For `token`: the most its position may be (USDG), and what may still be bought. */
  position?: { token: Address; max: string; held: string; room: string };
};

const usd = (x: bigint) => formatUnitsAmount(x < 0n ? 0n : x, TOKEN_DECIMALS);
const limitsOf = (l: LimitsJson): TradingLimits => ({ positionMaxBps: BigInt(l.positionMaxBps), maxImpactBps: BigInt(l.maxImpactBps), dailyLossBps: BigInt(l.dailyLossBps), weeklyLossBps: BigInt(l.weeklyLossBps) });
const limitsJson = (l: TradingLimits): LimitsJson => ({ positionMaxBps: l.positionMaxBps.toString(), maxImpactBps: l.maxImpactBps.toString(), dailyLossBps: l.dailyLossBps.toString(), weeklyLossBps: l.weeklyLossBps.toString() });

export class TradingService {
  readonly #p: TradingParts;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(p: TradingParts) {
    this.#p = p;
  }

  /** Runs `fn` after the ledger changes queued before it (one at a time). */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #swap(): SwapService {
    if (this.#p.swap === null) throw new Error("Ostra Swap is not configured here (OSTRA_SWAP_DEPLOYMENT): nothing can be traded");
    return this.#p.swap;
  }

  async #read(): Promise<Ledger | null> {
    const text = await this.#p.folder.read(TRADING_LEDGER);
    if (text === undefined) return null;
    return JSON.parse(text) as Ledger;
  }

  async #write(l: Ledger): Promise<void> {
    await this.#p.folder.ensure();
    await this.#p.folder.write(TRADING_LEDGER, `${JSON.stringify(l)}\n`);
  }

  #add(l: Ledger, token: Address, delta: bigint): void {
    const k = getAddress(token);
    const v = BigInt(l.positions[k] ?? "0") + delta;
    if (v === 0n) delete l.positions[k];
    else l.positions[k] = v.toString();
  }

  /** Books an order that finished: what it did not spend comes back where it came from, what it received goes in. */
  #book(l: Ledger, p: Pending, spent: bigint, received: bigint): void {
    const back = BigInt(p.amountIn) - spent;
    if (p.side === "buy") {
      l.cash = (BigInt(l.cash) + back).toString();
      this.#add(l, p.token, received);
    } else {
      this.#add(l, p.token, back);
      l.cash = (BigInt(l.cash) + received).toString();
    }
    l.pending = l.pending.filter((x) => x.order !== p.order);
  }

  /** Books the pending trades that finished; returns the open ones with what they did so far. */
  async #settle(l: Ledger): Promise<{ p: Pending; spent: bigint; received: bigint }[]> {
    const open = [];
    for (const p of [...l.pending]) {
      const r = p.kind === "split" ? await this.#swap().splitResult(p.order) : await this.#swap().orderResult(p.order, BigInt(p.fromBlock), p.escrow);
      if (r.open) open.push({ p, spent: r.spent, received: r.received });
      else this.#book(l, p, r.spent, r.received);
    }
    return open;
  }

  /** What `amount` of `token` sells for now (USDG base units); 0 for nothing. */
  async #sellValue(token: Address, amount: bigint): Promise<bigint> {
    return amount === 0n ? 0n : this.#swap().expectedOut(token, USDG, amount);
  }

  /**
   * The capital's value now (its cash, no more than the USDG vault holds; each position, no more than its vault holds,
   * at the quote of selling it; what open trades hold), after booking what finished; and what open buys hold, by token.
   */
  async #value(l: Ledger): Promise<{ total: bigint; positions: { token: Address; amount: bigint; value: bigint }[]; openBuys: Map<Address, bigint> }> {
    const open = await this.#settle(l);
    const vaultUsdg = await tokenBalance(this.#p.client, USDG, await this.#p.buyer.vaultAddress());
    let total = BigInt(l.cash) < vaultUsdg ? BigInt(l.cash) : vaultUsdg;
    const positions = [];
    for (const [k, v] of Object.entries(l.positions)) {
      const token = getAddress(k);
      const held = await tokenBalance(this.#p.client, token, await this.#p.tokenVault(token).vaultAddress());
      const amount = BigInt(v) < held ? BigInt(v) : held;
      const value = await this.#sellValue(token, amount);
      positions.push({ token, amount, value });
      total += value;
    }
    const openBuys = new Map<Address, bigint>();
    for (const o of open) {
      const left = BigInt(o.p.amountIn) - o.spent;
      if (o.p.side === "buy") {
        const v = left + (await this.#sellValue(o.p.token, o.received));
        total += v;
        openBuys.set(getAddress(o.p.token), (openBuys.get(getAddress(o.p.token)) ?? 0n) + v);
      } else total += (await this.#sellValue(o.p.token, left)) + o.received;
    }
    return { total, positions, openBuys };
  }

  /** Takes the day's and the week's start values when a new day or week began (weeks start on Monday). */
  async #roll(l: Ledger, value: bigint): Promise<void> {
    const day = (await chainTime(this.#p.client)) / DAY;
    const week = (day + 3n) / 7n; // 1 Jan 1970 was a Thursday
    if (l.day !== day.toString()) [l.day, l.dayStart] = [day.toString(), value.toString()];
    if (l.week !== week.toString()) [l.week, l.weekStart] = [week.toString(), value.toString()];
  }

  /** The most a position in `token` may be now: positionMaxBps of the capital's value, at most the size whose buy quote moves the price maxImpactBps. */
  async #positionMax(l: Ledger, token: Address, value: bigint): Promise<bigint> {
    const lim = limitsOf(l.limits);
    const byCapital = (value * lim.positionMaxBps) / BPS;
    return positionMax(lim, value, await impactLimitedSize(byCapital, lim.maxImpactBps, (x) => this.#swap().impactOf(USDG, token, x)));
  }

  async #status(l: Ledger, token?: Address): Promise<TradingStatus> {
    const v = await this.#value(l);
    await this.#roll(l, v.total);
    await this.#write(l);
    const out: TradingStatus = {
      capital: usd(BigInt(l.capital)),
      cash: usd(BigInt(l.cash)),
      value: usd(v.total),
      positions: await Promise.all(
        v.positions.map(async (x) => ({ token: x.token, amount: formatUnitsAmount(x.amount, await tokenDecimals(this.#p.client, x.token)), value: usd(x.value) })),
      ),
      pendingOrders: l.pending.length,
      limits: l.limits,
      buys: await this.#buys(l, v.total),
      dayStart: usd(BigInt(l.dayStart)),
      weekStart: usd(BigInt(l.weekStart)),
    };
    if (token !== undefined) {
      const t = getAddress(token);
      const max = await this.#positionMax(l, t, v.total);
      const held = (v.positions.find((x) => x.token === t)?.value ?? 0n) + (v.openBuys.get(t) ?? 0n);
      out.position = { token: t, max: usd(max), held: usd(held), room: usd(max > held ? max - held : 0n) };
    }
    return out;
  }

  /**
   * Whether buys may happen now: the day's and the week's loss limits on the capital's value, and a stop taken earlier
   * this day or week (kept in TRADING_STOPS, which ending and setting the capital again do not clear). A stop seen now
   * is kept there.
   */
  async #buys(l: Ledger, value: bigint): Promise<{ ok: boolean; reason: string }> {
    const lim = limitsOf(l.limits);
    const dayStart = BigInt(l.dayStart);
    const weekStart = BigInt(l.weekStart);
    const dayLost = dayStart > 0n && (dayStart - value) * BPS >= dayStart * lim.dailyLossBps;
    const weekLost = weekStart > 0n && (weekStart - value) * BPS >= weekStart * lim.weeklyLossBps;
    const text = await this.#p.folder.read(TRADING_STOPS);
    const kept = text === undefined ? { day: "-1", week: "-1" } : (JSON.parse(text) as { day: string; week: string });
    if (dayLost || weekLost) {
      const next = { day: dayLost ? l.day : kept.day, week: weekLost ? l.week : kept.week };
      if (next.day !== kept.day || next.week !== kept.week) await this.#p.folder.write(TRADING_STOPS, `${JSON.stringify(next)}\n`);
    }
    if (dayLost || kept.day === l.day) return { ok: false, reason: `the trading capital lost ${lim.dailyLossBps} bps or more today` };
    if (weekLost || kept.week === l.week) return { ok: false, reason: `the trading capital lost ${lim.weeklyLossBps} bps or more this week` };
    return buysAllowed(lim, { dayStart, weekStart, now: value });
  }

  /**
   * Before the capital is ended or set again: its loss today and this week, read now, kept as stops (#buys) so that a
   * new capital does not start with them lifted. Refused when its value cannot be read now.
   */
  async #recordStops(l: Ledger): Promise<void> {
    if (this.#p.swap === null) return;
    let value: bigint;
    try {
      value = (await this.#value(l)).total;
    } catch (e) {
      throw new Error(`the trading capital's value could not be read now (${(e as Error).message.split("\n")[0]}): its loss limits must be read before it is ended or set again; try again`);
    }
    await this.#roll(l, value);
    await this.#buys(l, value);
  }

  /** The capital after a trade, or why it could not be read now: a trade that landed is never reported as an error. */
  async #statusAfter(l: Ledger, token?: Address): Promise<{ trading?: TradingStatus; tradingNote?: string }> {
    try {
      return { trading: await this.#status(l, token) };
    } catch (e) {
      return { tradingNote: `the trade is booked; the capital could not be read now: ${(e as Error).message.split("\n")[0]}` };
    }
  }

  /**
   * USDG the strategies keep in the USDG vault for the capital (0 without one), after booking what finished: its cash,
   * what open buys have not spent yet (an order in flight holds it in its escrow: kept as well) and what open sells
   * have received.
   */
  async reservedCash(): Promise<bigint> {
    return this.#serial(async () => {
      const l = await this.#read();
      if (l === null) return 0n;
      let reserved = BigInt(l.cash);
      if (this.#p.swap !== null && l.pending.length > 0) {
        const open = await this.#settle(l);
        await this.#write(l);
        reserved = BigInt(l.cash);
        for (const o of open) reserved += o.p.side === "buy" ? BigInt(o.p.amountIn) - o.spent : o.received;
      } else for (const p of l.pending) if (p.side === "buy") reserved += BigInt(p.amountIn);
      return reserved;
    });
  }

  /**
   * The tokens of the capital (no chain read): its positions and what its open sells may not have sold yet, by token
   * address; while a buy of a token is open, all of that token (what it bought so far is not known without the chain).
   * The strategies leave them in their vaults.
   */
  async heldTokens(): Promise<Map<Address, bigint>> {
    const l = await this.#read();
    const out = new Map<Address, bigint>();
    if (l === null) return out;
    for (const [k, v] of Object.entries(l.positions)) out.set(getAddress(k), BigInt(v));
    for (const p of l.pending) {
      const t = getAddress(p.token);
      if (p.side === "buy") out.set(t, ALL);
      else if (out.get(t) !== ALL) out.set(t, (out.get(t) ?? 0n) + BigInt(p.amountIn));
    }
    return out;
  }

  /** The capital's limits and amounts as kept (no chain read), or null without a capital. */
  async kept(): Promise<{ capital: bigint; cash: bigint; limits: LimitsJson } | null> {
    const l = await this.#read();
    return l === null ? null : { capital: BigInt(l.capital), cash: BigInt(l.cash), limits: l.limits };
  }

  /**
   * Sets the trading capital: `capital` USDG of the USDG vault, with Ostra's limits or tighter ones. Refused while the
   * capital holds a position or an order is open (sell first), and for more USDG than the vault holds.
   */
  set(a: { capital: string; limits?: Partial<TradingLimits> }): Promise<TradingStatus> {
    return this.#serial(async () => {
      await this.#p.gate();
      const lim = tradingLimits(a.limits);
      const capital = parseUnitsAmount(a.capital, TOKEN_DECIMALS);
      if (capital === 0n) throw new RangeError("the capital must be more than 0");
      const old = await this.#read();
      if (old !== null) {
        if (this.#p.swap !== null) await this.#settle(old);
        if (old.pending.length > 0 || Object.keys(old.positions).length > 0) throw new Error("the trading capital holds positions or open orders: sell them (trading sell) before setting it again");
        await this.#recordStops(old);
      }
      const held = await tokenBalance(this.#p.client, USDG, await this.#p.buyer.vaultAddress());
      if (held < capital) throw new RangeError(`the USDG vault holds ${usd(held)} USDG, less than ${a.capital}`);
      const l: Ledger = { version: 1, capital: capital.toString(), cash: capital.toString(), positions: {}, limits: limitsJson(lim), day: "-1", dayStart: "0", week: "-1", weekStart: "0", pending: [] };
      await this.#roll(l, capital);
      await this.#write(l);
      return this.#status(l);
    });
  }

  /** The capital now: its value, positions, whether buys may happen and, for `token`, the most its position may be. */
  status(token?: Address): Promise<TradingStatus> {
    return this.#serial(async () => {
      const l = await this.#read();
      if (l === null) throw new Error("no trading capital is set: trading set");
      this.#swap();
      return this.#status(l, token);
    });
  }

  /** Ends the trading capital: its USDG goes back to the strategies; refused while an order is open. Positions stay in their vaults. */
  end(): Promise<{ ended: true; untracked: { token: Address; amount: string }[] }> {
    return this.#serial(async () => {
      const l = await this.#read();
      if (l === null) throw new Error("no trading capital is set");
      if (this.#p.swap !== null) await this.#settle(l);
      if (l.pending.length > 0) {
        await this.#write(l);
        throw new Error(`${l.pending.length} order(s) of the trading capital are still open: end it once they finish`);
      }
      await this.#recordStops(l);
      await this.#p.folder.remove(TRADING_LEDGER);
      return { ended: true, untracked: Object.entries(l.positions).map(([k, v]) => ({ token: getAddress(k), amount: v })) };
    });
  }

  /** Books `r` when it finished in its transaction (an order in one swap); a split trade stays pending until it ends. */
  #bookResult(l: Ledger, r: OstraSwapResult, order: Hex | null, outDecimals: number, inDecimals: number): void {
    if (r.status !== "sent" || order === null || r.outcome === "unknown") return;
    const p = l.pending.find((x) => x.order === order);
    if (p === undefined) return;
    this.#book(l, p, r.swapped ? parseUnitsAmount(r.amountIn, inDecimals) : 0n, parseUnitsAmount(r.amountOut, outDecimals));
  }

  /**
   * Buys `token` with `amount` USDG of the capital, after its checks: buys not stopped, the cash covers it, and the
   * position after it within its limit (quotes now). The quote and the swap are Ostra Swap's.
   */
  buy(a: { token: Address; amount: string; slippageBps?: number }): Promise<OstraSwapResult & { trading?: TradingStatus; tradingNote?: string }> {
    return this.#serial(async () => {
      await this.#p.gate();
      const swap = this.#swap();
      const l = await this.#read();
      if (l === null) throw new Error("no trading capital is set: trading set");
      const token = getAddress(a.token);
      if (token === getAddress(USDG)) throw new RangeError("the capital is USDG: buy another token with it");
      await swap.checkToken(token);
      const amount = parseUnitsAmount(a.amount, TOKEN_DECIMALS);
      if (amount === 0n) throw new RangeError("amount must be more than 0");
      const v = await this.#value(l);
      await this.#roll(l, v.total);
      await this.#write(l);
      const lim = limitsOf(l.limits);
      const buys = await this.#buys(l, v.total);
      if (!buys.ok) throw new Error(`buys are stopped: ${buys.reason}; nothing was signed`);
      if (amount > BigInt(l.cash)) throw new RangeError(`the capital's cash is ${usd(BigInt(l.cash))} USDG, less than ${a.amount}; nothing was signed`);
      const max = await this.#positionMax(l, token, v.total);
      // The position now with what open buys of it hold.
      const held = (v.positions.find((x) => x.token === token)?.value ?? 0n) + (v.openBuys.get(token) ?? 0n);
      if (held + amount > max) {
        throw new RangeError(
          `the position would be ${usd(held + amount)} USDG, over its limit of ${usd(max)} (${lim.positionMaxBps} bps of the capital's ${usd(v.total)}, and no more than a buy whose quote moves the price ${lim.maxImpactBps} bps); nothing was signed`,
        );
      }
      const tokenDec = await tokenDecimals(this.#p.client, token);
      let order: Hex | null = null;
      const r = await swap.swap(
        { tokenIn: USDG, tokenOut: token, amount: a.amount, ...(a.slippageBps === undefined ? {} : { slippageBps: a.slippageBps }), maxImpactBps: Number(lim.maxImpactBps) },
        {
          onOrder: async (h, fromBlock, escrow) => {
            order = h;
            l.pending.push({ order: h, side: "buy", token, amountIn: amount.toString(), fromBlock: fromBlock.toString(), escrow });
            l.cash = (BigInt(l.cash) - amount).toString();
            await this.#write(l);
          },
          onSplit: async (id) => {
            l.pending.push({ order: id, kind: "split", side: "buy", token, amountIn: amount.toString() });
            l.cash = (BigInt(l.cash) - amount).toString();
            await this.#write(l);
          },
        },
      );
      this.#bookResult(l, r, order, tokenDec, TOKEN_DECIMALS);
      await this.#write(l);
      return r.status === "resent_pending" ? r : { ...r, ...(await this.#statusAfter(l, token)) };
    });
  }

  /** Sells `amount` (or "all") of the capital's position in `token` for USDG, split by its quote's impact when it is large. */
  sell(a: { token: Address; amount: string; slippageBps?: number }): Promise<OstraSwapResult & { trading?: TradingStatus; tradingNote?: string }> {
    return this.#serial(async () => {
      const swap = this.#swap();
      const l = await this.#read();
      if (l === null) throw new Error("no trading capital is set");
      const token = getAddress(a.token);
      await this.#settle(l);
      const dec = await tokenDecimals(this.#p.client, token);
      const vaultHeld = await tokenBalance(this.#p.client, token, await this.#p.tokenVault(token).vaultAddress());
      const position = BigInt(l.positions[token] ?? "0");
      const sellable = position < vaultHeld ? position : vaultHeld;
      const amount = a.amount === "all" ? sellable : parseUnitsAmount(a.amount, dec);
      if (amount === 0n) throw new RangeError(`the capital holds no ${token} to sell${position > 0n ? " (its vault holds none now)" : ""}`);
      if (amount > sellable) throw new RangeError(`the capital's position in ${token} is ${formatUnitsAmount(sellable, dec)}, less than ${a.amount}; nothing was signed`);
      let order: Hex | null = null;
      const r = await swap.swap(
        { tokenIn: token, tokenOut: USDG, amount: formatUnitsAmount(amount, dec), ...(a.slippageBps === undefined ? {} : { slippageBps: a.slippageBps }), maxImpactBps: Number(l.limits.maxImpactBps) },
        {
          onOrder: async (h, fromBlock, escrow) => {
            order = h;
            l.pending.push({ order: h, side: "sell", token, amountIn: amount.toString(), fromBlock: fromBlock.toString(), escrow });
            this.#add(l, token, -amount);
            await this.#write(l);
          },
          onSplit: async (id) => {
            l.pending.push({ order: id, kind: "split", side: "sell", token, amountIn: amount.toString() });
            this.#add(l, token, -amount);
            await this.#write(l);
          },
        },
      );
      this.#bookResult(l, r, order, TOKEN_DECIMALS, dec);
      await this.#write(l);
      return r.status === "resent_pending" ? r : { ...r, ...(await this.#statusAfter(l)) };
    });
  }
}
