// Ostra Swap from the agent's vaults (decided 22 Oct 2026: agents swap through MCP): any pair of the tokens an Ostra
// vault can hold and the relayer serves (USDG, WETH, OSTRA, the listed stock tokens, tokens the Ostra launchpad
// launched), routed through Uniswap v3 and v4 against USDG or WETH by @ostraagent/swap (findRoute), at the fee of the
// vault the output goes to (OstraStake.feeBps: lower with OSTRA locked for it).
//
// A vault can transfer but not approve, so a swap is an escrow order of OstraRouter (an immediate order): the vault
// of the input token signs one Transfer of the input to the order's escrow address (CREATE2 of the order's terms:
// tokens, amount, minOut, recipient, refund address, deadline, route), and the relayer sends that spend together
// with OstraRouter.executeEscrow in one transaction. The router swaps along the route the order names for at least
// minOut, paid to the agent's vault of the output token, or sends the input back to the vault it came from. Nobody
// can change where the tokens go: every term is in the escrow's address.
//
// The order is kept before its spend is signed: a spend that is signed and lands later on its own (the vault sends a
// signed spend again before anything else, maybe days later) leaves the input in the escrow, and finishPending
// executes it (or, past its deadline, has it refunded) once the escrow holds it. A record is dropped only once the
// vault's nonce has passed the signed Transfer and the escrow is empty: the order's terms (its salt among them) are
// what executes or refunds an escrow, and they are kept nowhere else.
//
// A large swap is split (design: "Swap besar dipecah menurut dampak harga dari quote, dengan batas dampak per bagian"):
// when its quote moves the price more than the limit (DEFAULT_SWAP_MAX_IMPACT_BPS unless the caller sets another), the
// parts double until one part's quote is within it (strategy-rules splitByImpact), and the parts are swapped one at a
// time, SPLIT_INTERVAL_SECONDS apart, each an immediate escrow order like any swap (its own signed Transfer, executed
// in the same transaction, so nobody else can choose when it runs or move the price around it). The parts are spaced
// so that arbitrage can bring the pool back between them: back to back, they would move the price as far as one swap.
// Right before it is signed, a part is quoted again: it waits while it would move the price more than the limit, or pay
// less than the first part was quoted at less the slippage (the price has not come back), and it pays at least that.
// The input stays in the vault until each part is signed. This agent runs the parts (runSplits, each minute in the
// MCP's sweep); a split ends when its last part landed, at its deadline (what was not swapped stays in the vault), or
// when it is cancelled. Its record is kept from before its first part, with each part's order before it is signed.

import { decodeErrorResult, decodeEventLog, getAbiItem, getAddress, type AbiEvent, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { LAUNCH_PAIRS, VAULT_ACTION, WETH, getLogsChunked, ostraLaunchpadAbi, signVaultTransfer, transferParams, type LaunchpadDeployment, type RelayCall } from "@ostraagent/sdk";
import {
  ETH,
  PoolIndex,
  bestLeg,
  escrowAddress,
  executeEscrowData,
  findRoute,
  orderFor,
  orderHash,
  ostraRouterAbi,
  ostraStakeAbi,
  randomSalt,
  type Order,
  type PoolIndexData,
  type Route,
  type SwapDeployment,
} from "@ostraagent/swap";
import { formatUnitsAmount, parseUnitsAmount } from "./amount.ts";
import { chainTime, hasCode, tokenBalance, tokenDecimals } from "./chain.ts";
import type { Config } from "./config.ts";
import { VAULT_SPEND_GAS, type Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import { impactBps, referenceQuote, splitByImpact } from "./strategy-rules.ts";
import { spendCall, type VaultOperationResult, type VaultService } from "./vault.ts";

/** The folder of Ostra Swap's records: the pool index, and each order until it is finished. */
export const SWAP_DIR = "ostra-swap";
/**
 * Gas an escrow swap is reserved for before it is signed: the vault's Transfer and executeEscrow priced at the gas
 * limit its swap needs (the relayer simulates it; measured on a fork 21 Oct 2026: about 570,000 for one Uniswap leg),
 * with room for two legs through hooks.
 */
export const ESCROW_SWAP_GAS = VAULT_SPEND_GAS + 1_600_000n;
/** Default and largest slippage of a swap, in bps. */
export const DEFAULT_SWAP_SLIPPAGE_BPS = 100;
export const MAX_SWAP_SLIPPAGE_BPS = 1_000;

/**
 * A swap whose quote moves the price more than this (bps) is split, unless the caller sets another limit: 1%, the
 * trading capital's impact limit (strategy-rules TRADE_MAX_IMPACT_BPS).
 */
export const DEFAULT_SWAP_MAX_IMPACT_BPS = 100;
/** The loosest impact limit a caller may set: 100% (a swap that is never split). */
export const MAX_SWAP_MAX_IMPACT_BPS = 10_000;
/** The most parts a swap is split into. */
export const SPLIT_MAX_PARTS = 16;
/** Seconds between the parts of a split swap: long enough for an arbitrage to bring the pool back between parts. */
export const SPLIT_INTERVAL_SECONDS = 60;
/** How long a split swap may wait after its last part's time (a part waits while the price has not come back). */
export const SPLIT_SLACK_SECONDS = 900;

const POOL_INDEX = "pool-index.json";
const ORDER_PREFIX = "order-";
const SPLIT_PREFIX = "split-";
const DONE_PREFIX = "done-";
/** Finished orders kept (ostra_swap_orders): beyond this many, the oldest are dropped. */
export const DONE_ORDERS_KEPT = 100;

/** A split swap, kept from before its first part (and never dropped: the trading capital's books read it). Amounts in base units. */
type SplitRecord = {
  version: 2;
  /** A random id. */
  id: Hex;
  tokenIn: Address;
  tokenOut: Address;
  inDecimals: number;
  outDecimals: number;
  amountIn: string;
  /** Each part's input (the last takes the rest) and how many parts. */
  part: string;
  parts: number;
  slippageBps: number;
  maxImpactBps: number;
  /** What one part was quoted to pay when the swap began: no part pays less than its share of it less the slippage. */
  partOut: string;
  /** The parts that swapped, what they spent and what they paid. */
  done: number;
  spent: string;
  received: string;
  /** Each part's order, kept before its Transfer is signed; `booked` once what it did is counted above. */
  orders: { order: Hex; fromBlock: string; escrow: Address; amountIn: string; booked: boolean }[];
  /** Unix seconds: when the next part may run, and after which no part runs. */
  nextAt: number;
  deadline: number;
  ended: boolean;
  /** Unix ms: when it began, and when it ended. */
  at: number;
  endedAt?: number;
  note?: string;
};

/** What an order did, from OstraRouter's events: the input it swapped and the output it paid; `open` while not finished. */
export type OrderResult = { open: boolean; spent: bigint; received: bigint };

/** A split swap now. Amounts in the tokens' units. */
export type SplitStatus = {
  id: Hex;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  parts: number;
  partsDone: number;
  spent: string;
  received: string;
  open: boolean;
  /** When the next part may run (unix seconds), or null once it ended. */
  nextAt: number | null;
  deadline: number;
  note?: string;
};

/** An order sent or about to be, kept until its escrow is finished. */
type OrderRecord = {
  version: 1;
  hash: Hex;
  escrow: Address;
  tokenIn: Address;
  amountIn: string;
  /** The vault nonce the Transfer into the escrow is signed under. */
  vaultNonce: string;
  deadline: string;
  /** OstraRouter.executeEscrow calldata along the order's route. */
  execute: Hex;
  at: number;
  /** From 0.1.12: a block before the order, where its events are searched from; the output token, the vaults and decimals. */
  fromBlock?: string;
  tokenOut?: Address;
  from?: Address;
  to?: Address;
  inDecimals?: number;
  outDecimals?: number;
};

/** A finished order, kept for ostra_swap_orders (the newest DONE_ORDERS_KEPT). Amounts in the tokens' units. */
export type DoneOrder = {
  version: 1;
  order: Hex;
  txHash: Hash;
  swapped: boolean;
  tokenIn: Address;
  tokenOut: Address | null;
  amountIn: string;
  amountOut: string;
  /** The least it could pay (null when it was finished by the sweep, which does not know it). */
  minOut: string | null;
  from: Address | null;
  to: Address | null;
  refusal?: string;
  /** Unix ms: when it finished here. */
  at: number;
};

/** An order kept here and not finished: signed or about to be (its Transfer may still land), or landed and being finished. */
export type OpenOrder = {
  order: Hex;
  tokenIn: Address;
  tokenOut: Address | null;
  amountIn: string;
  escrow: Address;
  /** "landed": its escrow swapped (what it spent and paid below) and the sweep finishes its record; "open": not finished yet. */
  state: "open" | "landed";
  spent?: string;
  received?: string;
  /** Unix ms: when its record was kept. */
  at: number;
};

export type SwapQuote = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  expectedOut: string;
  minOut: string;
  hub: Address;
  feeBps: number;
  fee: string;
  from: Address;
  to: Address;
};

export type OstraSwapResult =
  | (VaultOperationResult & { status: "resent_pending" })
  | {
      status: "sent";
      txHash: Hash;
      /** The order's hash (OstraRouter.orderHash): its events tell what it did. */
      order: Hex;
      swapped: boolean;
      /** "unknown": it landed but what it paid could not be read now (swapped and amountOut are not known yet). */
      outcome?: "unknown";
      amountIn: string;
      amountOut: string;
      minOut: string;
      from: Address;
      to: Address;
      /** The impact of the whole amount in one swap, in bps of the price of a small quote. */
      impactBps: string;
      /** Why the swap did not run when `swapped` is false (OstraRouter's EscrowRefunded reason, read). */
      refusal?: string;
      note?: string;
    }
  | {
      /** A split swap: its record kept and its first part tried at once (`first`, when it was sent). */
      status: "split";
      split: SplitStatus;
      impactBps: string;
      first?: { txHash: Hash; order: Hex; swapped: boolean; amountIn: string; amountOut: string; minOut: string; refusal?: string };
      note: string;
    };

/** A swap worked out before anything is signed. */
type Plan = { tokenIn: Address; tokenOut: Address; amountIn: bigint; inDecimals: number; outDecimals: number; from: VaultService; fromVault: Address; to: Address; route: Route };

export type SwapParts = {
  client: PublicClient;
  /** Serves eth_getLogs over the windows the pool index searches (Robinhood Chain's public RPC). */
  logsClient: PublicClient;
  config: Config;
  swap: SwapDeployment;
  /** The agent's vault for a token (the buyer vault for USDG). */
  vaultFor: (token: Address) => VaultService;
  /** Sends what finishes an order (executeEscrow alone), paid like the agent's other requests. */
  sender: Sender;
  folder: Folder;
};

const address = (text: string, what: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new RangeError(`${what} is not an address`);
  return getAddress(text);
};

export class SwapService {
  readonly #p: SwapParts;
  #index: PoolIndex | null = null;
  #splitQueue: Promise<unknown> = Promise.resolve();

  constructor(p: SwapParts) {
    this.#p = p;
  }

  async #poolIndex(): Promise<PoolIndex> {
    if (this.#index !== null) return this.#index;
    const text = await this.#p.folder.read(POOL_INDEX);
    this.#index = new PoolIndex(text === undefined ? undefined : (JSON.parse(text) as PoolIndexData));
    return this.#index;
  }

  async #saveIndex(): Promise<void> {
    if (this.#index !== null) await this.#p.folder.write(POOL_INDEX, JSON.stringify(this.#index.data()));
  }

  /**
   * Refuses a token an Ostra vault cannot hold through the relayer: USDG, WETH, OSTRA, the listed stock tokens and
   * the tokens the Ostra launchpad launched are served (relayer gate.ts), anything else would stay in its vault.
   */
  async checkToken(token: Address): Promise<void> {
    if (token === ETH) throw new RangeError("an Ostra vault holds WETH, not native ETH: swap WETH");
    if (token === this.#p.config.deployment.token || token === WETH) return;
    if (LAUNCH_PAIRS.some((p) => (p.kind === "ostra" || p.kind === "stock") && getAddress(p.address) === token)) return;
    const lp: LaunchpadDeployment | undefined = this.#p.config.deployment.launchpad;
    if (lp !== undefined) {
      const id = (await this.#p.client.readContract({ address: lp.launchpad, abi: ostraLaunchpadAbi, functionName: "poolOf", args: [token] })) as Hex;
      if (BigInt(id) !== 0n) return;
    }
    throw new RangeError(`${token} is not a token an Ostra vault swaps: USDG, WETH, OSTRA, a listed stock token or a token the Ostra launchpad launched`);
  }

  async #plan(a: { tokenIn: string; tokenOut: string; amount: string; slippageBps?: number }): Promise<Plan> {
    const tokenIn = address(a.tokenIn, "tokenIn");
    const tokenOut = address(a.tokenOut, "tokenOut");
    if (tokenIn === tokenOut) throw new RangeError("tokenIn and tokenOut are the same");
    await this.checkToken(tokenIn);
    await this.checkToken(tokenOut);
    const slippageBps = a.slippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SWAP_SLIPPAGE_BPS) throw new RangeError(`slippage must be 0 to ${MAX_SWAP_SLIPPAGE_BPS} bps`);
    const [inDecimals, outDecimals] = await Promise.all([tokenDecimals(this.#p.client, tokenIn), tokenDecimals(this.#p.client, tokenOut)]);
    const amountIn = parseUnitsAmount(a.amount, inDecimals);
    if (amountIn === 0n) throw new RangeError("amount must be greater than zero");
    const from = this.#p.vaultFor(tokenIn);
    const to = await this.#p.vaultFor(tokenOut).vaultAddress();
    const fromVault = await from.vaultAddress();
    // The fee is the recipient's: the agent's vault of the output token (OSTRA locked for it lowers it).
    const feeBps = Number(await this.#p.client.readContract({ address: this.#p.swap.stake, abi: ostraStakeAbi, functionName: "feeBps", args: [to] }));
    const index = await this.#poolIndex();
    const route = await findRoute({ client: this.#p.client, logsClient: this.#p.logsClient, index, tokenIn, tokenOut, amountIn, feeBps, slippageBps });
    await this.#saveIndex();
    return { tokenIn, tokenOut, amountIn, inDecimals, outDecimals, from, fromVault, to, route };
  }

  #summary(p: Plan): SwapQuote {
    const r = p.route;
    // The fee is taken in the hub, between the two legs.
    const hubDecimals = r.hub === this.#p.config.deployment.token ? 6 : 18;
    return {
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amountIn: formatUnitsAmount(p.amountIn, p.inDecimals),
      expectedOut: formatUnitsAmount(r.expectedOut, p.outDecimals),
      minOut: formatUnitsAmount(r.minOut, p.outDecimals),
      hub: r.hub,
      feeBps: r.feeBps,
      fee: formatUnitsAmount(r.fee, hubDecimals),
      from: p.fromVault,
      to: p.to,
    };
  }

  /** The impact limit a caller asked for, or the default. */
  #maxImpact(bps: number | undefined): number {
    const v = bps ?? DEFAULT_SWAP_MAX_IMPACT_BPS;
    if (!Number.isInteger(v) || v < 1 || v > MAX_SWAP_MAX_IMPACT_BPS) throw new RangeError(`maxImpactBps must be 1 to ${MAX_SWAP_MAX_IMPACT_BPS}`);
    return v;
  }

  /** The route of `amountIn` of the plan's tokens now, at the plan's fee and slippage. */
  async #routeOf(p: Plan, amountIn: bigint): Promise<Route> {
    const index = await this.#poolIndex();
    return findRoute({ client: this.#p.client, logsClient: this.#p.logsClient, index, tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn, feeBps: p.route.feeBps, slippageBps: p.route.slippageBps });
  }

  /** What `amountIn` pays along `route`'s own pools now (its hub, Ostra's fee between the legs), or null when a leg does not quote. */
  async #quoteAlong(route: Route, amountIn: bigint): Promise<bigint | null> {
    let hubAmount = amountIn;
    if (route.legIn !== null) {
      const q = await bestLeg(this.#p.client, [route.legIn.pool], route.tokenIn, route.hub, amountIn);
      if (q === null) return null;
      hubAmount = q.amountOut;
    }
    const net = hubAmount - (hubAmount * BigInt(route.feeBps)) / 10_000n;
    if (route.legOut === null) return net;
    const q = await bestLeg(this.#p.client, [route.legOut.pool], route.hub, route.tokenOut, net);
    return q === null ? null : q.amountOut;
  }

  /**
   * The quotes of the plan's tokens, kept for one measure (`out`), and the small quote an amount's impact is measured
   * against (`reference`): the amount's own route at a small size (sized by strategy-rules referenceQuote), so that the
   * impact is how far this swap moves the pools it trades on. The best small quote of the whole market can be in
   * another pool, whose price differs from these until an arbitrage closes the gap: measured against it, an amount
   * routed elsewhere could show no impact (seen on mainnet, 25 Oct 2026: 120,000 USDG to WETH through a v4 pool against
   * 120 USDG through a v3 pool), and the second part of a split would show the first part's move until the pools are
   * arbitraged. The best small quote is the reference only when a leg of the route does not quote at the small size.
   */
  #measure(p: Plan): { route: (x: bigint) => Promise<Route>; out: (x: bigint) => Promise<bigint>; reference: (x: bigint) => Promise<{ refIn: bigint; refOut: bigint }> } {
    const routes = new Map<bigint, Promise<Route>>([[p.amountIn, Promise.resolve(p.route)]]);
    const route = (x: bigint): Promise<Route> => {
      let r = routes.get(x);
      if (r === undefined) {
        r = this.#routeOf(p, x);
        routes.set(x, r);
      }
      return r;
    };
    const out = async (x: bigint) => (await route(x)).expectedOut;
    const reference = async (x: bigint) => {
      const small = await referenceQuote(x, out);
      const own = await this.#quoteAlong(await route(x), small.refIn);
      return own !== null && own > 0n ? { refIn: small.refIn, refOut: own } : small;
    };
    return { route, out, reference };
  }

  /**
   * How the plan's amount splits at `maxImpactBps` (strategy-rules splitByImpact over quotes of the routes now, each
   * part against the reference #measure gives), or why it cannot (`parts` null: even SPLIT_MAX_PARTS parts move the price more).
   */
  async #split(p: Plan, maxImpactBps: number): Promise<{ parts: number; part: bigint; impactBps: bigint; wholeImpactBps: bigint } | { parts: null; wholeImpactBps: bigint; reason: string }> {
    const m = this.#measure(p);
    try {
      return await splitByImpact(p.amountIn, BigInt(maxImpactBps), m.out, SPLIT_MAX_PARTS, m.reference);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return { parts: null, wholeImpactBps: impactBps({ amount: p.amountIn, out: p.route.expectedOut, ...(await m.reference(p.amountIn)) }), reason: e.message };
    } finally {
      await this.#saveIndex();
    }
  }

  /** How far `amountIn` of tokenIn moves the price now in one swap into the agent's vault of tokenOut, in bps (as #split measures it). */
  async impactOf(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    const dec = await tokenDecimals(this.#p.client, tokenIn);
    const p = await this.#plan({ tokenIn, tokenOut, amount: formatUnitsAmount(amountIn, dec) });
    try {
      return impactBps({ amount: amountIn, out: p.route.expectedOut, ...(await this.#measure(p).reference(amountIn)) });
    } finally {
      await this.#saveIndex();
    }
  }

  /**
   * The route and amounts a swap from the agent's vault of tokenIn to its vault of tokenOut would take now, the price
   * impact of the whole amount in one swap, and how many parts ostra_swap splits it into at `maxImpactBps` (null: it
   * refuses it, even SPLIT_MAX_PARTS parts move the price more). Nothing is signed.
   */
  async quote(a: { tokenIn: string; tokenOut: string; amount: string; slippageBps?: number; maxImpactBps?: number }): Promise<SwapQuote & { impactBps: string; parts: number | null; partAmount?: string; note?: string }> {
    const p = await this.#plan(a);
    const max = this.#maxImpact(a.maxImpactBps);
    const s = await this.#split(p, max);
    const q = { ...this.#summary(p), impactBps: s.wholeImpactBps.toString(), parts: s.parts };
    if (s.parts === null) return { ...q, note: `${s.reason}: ostra_swap refuses it at maxImpactBps ${max}` };
    if (s.parts === 1) return q;
    return {
      ...q,
      partAmount: formatUnitsAmount(s.part, p.inDecimals),
      note: `one swap moves the price ${s.wholeImpactBps} bps: ostra_swap splits it into ${s.parts} parts ${SPLIT_INTERVAL_SECONDS} s apart, each within ${max} bps (${s.impactBps} bps now), each its own signed swap`,
    };
  }

  /**
   * The output `amountIn` of tokenIn buys now into the agent's vault of tokenOut (its quote's expectedOut, after
   * Ostra's fee for that vault). Nothing is signed.
   */
  async expectedOut(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    const to = await this.#p.vaultFor(tokenOut).vaultAddress();
    const feeBps = Number(await this.#p.client.readContract({ address: this.#p.swap.stake, abi: ostraStakeAbi, functionName: "feeBps", args: [to] }));
    const index = await this.#poolIndex();
    try {
      return (await findRoute({ client: this.#p.client, logsClient: this.#p.logsClient, index, tokenIn, tokenOut, amountIn, feeBps, slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS })).expectedOut;
    } finally {
      await this.#saveIndex();
    }
  }

  /**
   * Swaps `amount` of tokenIn from the agent's vault of it to its vault of tokenOut (see the file comment): in one
   * escrow order when its quote moves the price at most `maxImpactBps`, else split. `onOrder` is called with the
   * order's hash, a block before it and its escrow once its record is kept, before its Transfer is signed; for a split
   * swap `onSplit` is called instead, with its id, once its record is kept, before its first part.
   */
  async swap(
    a: { tokenIn: string; tokenOut: string; amount: string; slippageBps?: number; maxImpactBps?: number },
    o: { onOrder?: (order: Hex, fromBlock: bigint, escrow: Address) => Promise<void>; onSplit?: (id: Hex) => Promise<void> } = {},
  ): Promise<OstraSwapResult> {
    const p = await this.#plan(a);
    const max = this.#maxImpact(a.maxImpactBps);
    const split = await this.#split(p, max);
    if (split.parts === null) throw new RangeError(`${split.reason} (in one swap it moves it ${split.wholeImpactBps} bps); nothing was signed: swap less, or allow more impact (maxImpactBps)`);
    const s = await p.from.state();
    if (!s.exists && p.from.kind === "buyer") throw new Error("this agent has no vault yet; call open_vault first");
    if (s.balance < p.amountIn) throw new Error(`the vault in ${p.tokenIn} (${p.fromVault}) holds ${formatUnitsAmount(s.balance, p.inDecimals)}, less than ${a.amount}; nothing was signed`);
    if (!s.exists) await p.from.open();
    if (split.parts === 1) return this.#immediate(p, a.amount, split.wholeImpactBps, o);
    return this.#startSplit(p, split, max, o);
  }

  /** One escrow order, executed in the transaction of the vault's Transfer. */
  async #immediate(p: Plan, amountText: string, wholeImpactBps: bigint, o: { onOrder?: (order: Hex, fromBlock: bigint, escrow: Address) => Promise<void> }): Promise<OstraSwapResult> {
    let order: Order | null = null;
    const result = await p.from.operate({
      gas: ESCROW_SWAP_GAS,
      moves: p.amountIn,
      what: "swap",
      build: async ({ v, vault, keychain, chainId }) => {
        const balance = await tokenBalance(this.#p.client, p.tokenIn, vault);
        if (balance < p.amountIn) throw new Error(`the vault holds ${formatUnitsAmount(balance, p.inDecimals)} now, less than ${amountText}; nothing was signed`);
        const fromBlock = await this.#p.client.getBlockNumber({ cacheTime: 0 });
        order = orderFor(p.route, vault, p.tokenIn, p.to, await chainTime(this.#p.client), randomSalt());
        const escrow = escrowAddress(this.#p.swap.router, order);
        const execute = executeEscrowData(order, p.route);
        await p.from.checkSpend(VAULT_ACTION.TRANSFER, transferParams({ to: escrow, amount: p.amountIn }), "the swap's transfer to its escrow", this.#p.sender);
        await this.#keep({
          version: 1,
          hash: orderHash(order),
          escrow,
          tokenIn: p.tokenIn,
          amountIn: p.amountIn.toString(),
          vaultNonce: v.nonce.toString(),
          deadline: order.deadline.toString(),
          execute,
          at: Date.now(),
          fromBlock: fromBlock.toString(),
          tokenOut: p.tokenOut,
          from: vault,
          to: p.to,
          inDecimals: p.inDecimals,
          outDecimals: p.outDecimals,
        });
        await o.onOrder?.(orderHash(order), fromBlock, escrow);
        const signed = await signVaultTransfer(keychain, v, { chainId, to: escrow, amount: p.amountIn });
        const calls: RelayCall[] = [spendCall(vault, signed), { to: this.#p.swap.router, data: execute }];
        return calls;
      },
    });
    if (result.status !== "sent") return result as OstraSwapResult;
    const placed = order as Order | null;
    if (placed === null) throw new Error("the swap was sent without its order");
    let outcome: { swapped: boolean; amountOut: bigint; why?: string };
    try {
      outcome = await this.#outcome(result.txHash, orderHash(placed), p.outDecimals);
    } catch (e) {
      // It landed (its receipt was waited for): what it paid is read from its events later (orderResult); its record stays.
      return {
        status: "sent",
        txHash: result.txHash,
        order: orderHash(placed),
        swapped: false,
        outcome: "unknown",
        amountIn: formatUnitsAmount(p.amountIn, p.inDecimals),
        amountOut: "0",
        minOut: formatUnitsAmount(p.route.minOut, p.outDecimals),
        from: p.fromVault,
        to: p.to,
        impactBps: wholeImpactBps.toString(),
        note: `the swap landed in ${result.txHash}; what it paid could not be read now (${(e as Error).message.split("\n")[0]}): do not send it again, its order ${orderHash(placed)} is read again later`,
      };
    }
    await this.#keepDone({
      version: 1,
      order: orderHash(placed),
      txHash: result.txHash,
      swapped: outcome.swapped,
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amountIn: formatUnitsAmount(p.amountIn, p.inDecimals),
      amountOut: formatUnitsAmount(outcome.amountOut, p.outDecimals),
      minOut: formatUnitsAmount(p.route.minOut, p.outDecimals),
      from: p.fromVault,
      to: p.to,
      ...(outcome.swapped ? {} : { refusal: outcome.why ?? "OstraRouter gave no reason" }),
      at: Date.now(),
    });
    await this.#p.folder.remove(`${ORDER_PREFIX}${orderHash(placed)}.json`);
    return {
      status: "sent",
      txHash: result.txHash,
      order: orderHash(placed),
      swapped: outcome.swapped,
      amountIn: formatUnitsAmount(p.amountIn, p.inDecimals),
      amountOut: formatUnitsAmount(outcome.amountOut, p.outDecimals),
      minOut: formatUnitsAmount(p.route.minOut, p.outDecimals),
      from: p.fromVault,
      to: p.to,
      impactBps: wholeImpactBps.toString(),
      ...(outcome.swapped ? {} : { refusal: outcome.why ?? "OstraRouter gave no reason", note: `the swap did not run (${outcome.why ?? "OstraRouter gave no reason"}): the input went back to the vault; quote again` }),
    };
  }

  /**
   * Runs `fn` after every split change queued before it: a split record is read, changed and written by one change at
   * a time (the sweep, a tool call and the swap that began it would otherwise each write an older copy, and a part
   * could be signed twice or a cancel undone).
   */
  #splitSerial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#splitQueue.then(fn, fn);
    this.#splitQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * A split swap: its record kept (and `onSplit` told, before anything is signed), then its first part at once. Once
   * the record is kept this never throws: what went wrong with the first part is in `note`, and the sweep goes on with
   * the parts (cancel it with ostra_swap_split).
   */
  async #startSplit(
    p: Plan,
    split: { parts: number; part: bigint; impactBps: bigint; wholeImpactBps: bigint },
    maxImpactBps: number,
    o: { onSplit?: (id: Hex) => Promise<void> },
  ): Promise<OstraSwapResult> {
    const partRoute = await this.#routeOf(p, split.part);
    await this.#saveIndex();
    const now = Number(await chainTime(this.#p.client));
    const r: SplitRecord = {
      version: 2,
      id: randomSalt(),
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      inDecimals: p.inDecimals,
      outDecimals: p.outDecimals,
      amountIn: p.amountIn.toString(),
      part: split.part.toString(),
      parts: split.parts,
      slippageBps: p.route.slippageBps,
      maxImpactBps,
      partOut: partRoute.expectedOut.toString(),
      done: 0,
      spent: "0",
      received: "0",
      orders: [],
      nextAt: now,
      deadline: now + split.parts * SPLIT_INTERVAL_SECONDS + SPLIT_SLACK_SECONDS,
      ended: false,
      at: Date.now(),
    };
    // The record and the caller's books in one step of the queue: no sweep runs a part before both are written.
    await this.#splitSerial(async () => {
      await this.#keepSplit(r);
      try {
        await o.onSplit?.(r.id);
      } catch (e) {
        // Not begun: nothing was signed, and no part ever will be.
        this.#end(r, `not begun: ${(e as Error).message.split("\n")[0]}`);
        await this.#keepSplit(r);
        throw e;
      }
    });
    let first: { ran: boolean; result?: OstraSwapResult; note?: string };
    let now2: SplitRecord = r;
    try {
      first = await this.#splitSerial(() => this.#runPartOf(r.id));
      now2 = (await this.#readSplit(r.id)) ?? r;
    } catch (e) {
      first = { ran: false, note: `the first part failed or could not be read back: ${(e as Error).message.split("\n")[0]}; ostra_swap_split list shows it, and the sweep goes on` };
    }
    const sent = first.result?.status === "sent" ? first.result : undefined;
    return {
      status: "split",
      split: this.#status(now2),
      impactBps: split.wholeImpactBps.toString(),
      ...(sent === undefined ? {} : { first: { txHash: sent.txHash, order: sent.order, swapped: sent.swapped, amountIn: sent.amountIn, amountOut: sent.amountOut, minOut: sent.minOut, ...(sent.refusal === undefined ? {} : { refusal: sent.refusal }) } }),
      note: `in one swap it would move the price ${split.wholeImpactBps} bps: split into ${split.parts} parts of ${formatUnitsAmount(split.part, p.inDecimals)}, ${SPLIT_INTERVAL_SECONDS} s apart, each within ${maxImpactBps} bps and paying at least the first part's quote less the slippage; the next parts run while the MCP server runs (ostra_swap_split shows them)${first.note === undefined ? "" : `; ${first.note}`}`,
    };
  }

  async #keepSplit(r: SplitRecord): Promise<void> {
    await this.#p.folder.ensure();
    await this.#p.folder.write(`${SPLIT_PREFIX}${r.id}.json`, `${JSON.stringify(r)}\n`);
  }

  async #readSplit(id: string): Promise<SplitRecord | null> {
    const text = await this.#p.folder.read(`${SPLIT_PREFIX}${id.toLowerCase()}.json`);
    return text === undefined ? null : (JSON.parse(text) as SplitRecord);
  }

  async #splitIds(): Promise<string[]> {
    return (await this.#p.folder.list()).filter((n) => n.startsWith(SPLIT_PREFIX) && n.endsWith(".json")).map((n) => n.slice(SPLIT_PREFIX.length, -".json".length));
  }

  /** Counts the parts whose orders finished since (a process that stopped after signing one): read from OstraRouter's events. Call within #splitSerial. */
  async #settleParts(r: SplitRecord): Promise<void> {
    let changed = false;
    for (const x of r.orders) {
      if (x.booked) continue;
      const res = await this.orderResult(x.order, BigInt(x.fromBlock), x.escrow);
      if (res.open) continue;
      x.booked = true;
      changed = true;
      if (res.spent > 0n) {
        r.done += 1;
        r.spent = (BigInt(r.spent) + res.spent).toString();
        r.received = (BigInt(r.received) + res.received).toString();
      }
    }
    if (changed) {
      if (r.done >= r.parts && !r.ended) this.#end(r, "every part swapped");
      await this.#keepSplit(r);
    }
  }

  #end(r: SplitRecord, note: string): void {
    r.ended = true;
    r.endedAt = Date.now();
    r.note = note;
  }

  /**
   * Split `id`'s next part when its time has come and it passes its checks now (see the file comment), or its end past
   * its deadline. Call within #splitSerial: it reads the record anew. `result`: the part's swap, when it was sent.
   */
  async #runPartOf(id: string): Promise<{ ran: boolean; result?: OstraSwapResult; note?: string }> {
    const r = await this.#readSplit(id);
    if (r === null || r.ended) return { ran: false };
    await this.#settleParts(r);
    if (r.ended) return { ran: false };
    const total = BigInt(r.amountIn);
    const part = BigInt(r.part);
    const now = Number(await chainTime(this.#p.client));
    const which = `part ${r.done + 1} of ${r.parts}`;
    if (r.orders.some((x) => !x.booked)) await this.#resendKept(r);
    if (now > r.deadline) {
      this.#end(r, `past its deadline: ${formatUnitsAmount(total - BigInt(r.spent), r.inDecimals)} was not swapped and stays in the vault${r.orders.some((x) => !x.booked) ? " (a part signed before is counted once its order finishes)" : ""}`);
      await this.#keepSplit(r);
      return { ran: false, note: r.note };
    }
    if (r.orders.some((x) => !x.booked)) return { ran: false, note: `${which}: the order of a part signed before has not finished yet` };
    if (now < r.nextAt) return { ran: false, note: `${which} runs from ${new Date(r.nextAt * 1000).toISOString()}` };
    const wait = async (note: string) => {
      r.nextAt = now + SPLIT_INTERVAL_SECONDS;
      r.note = note;
      await this.#keepSplit(r);
      return { ran: false, note };
    };
    const amount = r.done === r.parts - 1 ? total - part * BigInt(r.parts - 1) : part;
    const p = await this.#plan({ tokenIn: r.tokenIn, tokenOut: r.tokenOut, amount: formatUnitsAmount(amount, r.inDecimals), slippageBps: r.slippageBps });
    // Its impact now, against its own route's pools at a small size.
    const reference = await this.#measure(p).reference(amount);
    await this.#saveIndex();
    const impact = impactBps({ amount, out: p.route.expectedOut, ...reference });
    if (impact > BigInt(r.maxImpactBps)) return wait(`${which} waits: it would move the price ${impact} bps now, more than ${r.maxImpactBps}`);
    // At least what the first part was quoted at, less the slippage.
    const floor = (amount * BigInt(r.partOut) * BigInt(10_000 - r.slippageBps)) / (part * 10_000n);
    if (p.route.expectedOut < floor) {
      return wait(`${which} waits: it would pay ${formatUnitsAmount(p.route.expectedOut, r.outDecimals)} now, less than ${formatUnitsAmount(floor, r.outDecimals)} (the first part's quote less the slippage): the price has not come back`);
    }
    const held = (await p.from.state()).balance;
    if (held < amount) return wait(`${which} waits: the vault holds ${formatUnitsAmount(held, r.inDecimals)}, less than the part`);
    const route = p.route.minOut < floor ? { ...p.route, minOut: floor } : p.route;
    const res = await this.#immediate({ ...p, route }, formatUnitsAmount(amount, r.inDecimals), impact, {
      onOrder: async (order, fromBlock, escrow) => {
        r.orders.push({ order, fromBlock: fromBlock.toString(), escrow, amountIn: amount.toString(), booked: false });
        await this.#keepSplit(r);
      },
    });
    if (res.status !== "sent") return { ran: false, result: res, note: res.status === "resent_pending" ? res.note : undefined };
    if (res.outcome === "unknown") return { ran: false, result: res, note: `${which} landed; it is counted once its order's events are read` };
    const o = r.orders.find((x) => x.order === res.order);
    if (o !== undefined) o.booked = true;
    // The next part SPLIT_INTERVAL_SECONDS after this one landed (quoting and signing it took time too).
    r.nextAt = (await chainTime(this.#p.client).then(Number, () => now)) + SPLIT_INTERVAL_SECONDS;
    delete r.note;
    if (res.swapped) {
      r.done += 1;
      r.spent = (BigInt(r.spent) + amount).toString();
      r.received = (BigInt(r.received) + parseUnitsAmount(res.amountOut, r.outDecimals)).toString();
      if (r.done >= r.parts) this.#end(r, "every part swapped");
    } else r.note = `${which} did not run (${res.refusal ?? "OstraRouter gave no reason"}): its input went back to the vault; it is tried again`;
    await this.#keepSplit(r);
    return { ran: res.swapped, result: res, ...(r.note === undefined || res.swapped ? {} : { note: r.note }) };
  }

  /**
   * A part signed and not landed (its send failed): the vault sends its kept signed spend again (operate sends a
   * pending spend before anything else, and signs nothing new here). The Transfer lands alone; finishPending then
   * executes its escrow, or has it refunded past the order's deadline.
   */
  async #resendKept(r: SplitRecord): Promise<void> {
    const from = this.#p.vaultFor(r.tokenIn);
    if ((await from.state()).pendingAction === null) return;
    try {
      await from.operate({
        gas: ESCROW_SWAP_GAS,
        what: "the split's signed part",
        build: async () => {
          throw new Error("nothing new is signed here");
        },
      });
    } catch (e) {
      // Sent meanwhile by another operation of the vault (then nothing was pending any more): nothing to do.
      if (!/nothing new is signed here/.test((e as Error).message)) throw e;
    }
  }

  #status(r: SplitRecord): SplitStatus {
    return {
      id: r.id,
      tokenIn: r.tokenIn,
      tokenOut: r.tokenOut,
      amountIn: formatUnitsAmount(BigInt(r.amountIn), r.inDecimals),
      parts: r.parts,
      partsDone: r.done,
      spent: formatUnitsAmount(BigInt(r.spent), r.inDecimals),
      received: formatUnitsAmount(BigInt(r.received), r.outDecimals),
      open: !r.ended,
      nextAt: r.ended ? null : r.nextAt,
      deadline: r.deadline,
      ...(r.note === undefined ? {} : { note: r.note }),
    };
  }

  /** The split swaps kept here, each as it stands now. */
  splits(): Promise<SplitStatus[]> {
    return this.#splitSerial(async () => {
      const out: SplitStatus[] = [];
      for (const id of await this.#splitIds()) {
        const r = await this.#readSplit(id);
        if (r === null) continue;
        await this.#settleParts(r);
        out.push(this.#status(r));
      }
      return out;
    });
  }

  /**
   * What a split swap did so far (base units): `open` until it ended and every part's order finished. Records are
   * never dropped, so the trading capital's books always find theirs; throws for an id with no record here.
   */
  splitResult(id: Hex): Promise<OrderResult> {
    return this.#splitSerial(async () => {
      const r = await this.#readSplit(id);
      if (r === null) throw new Error(`no split swap ${id} is kept here`);
      await this.#settleParts(r);
      return { open: !r.ended || r.orders.some((x) => !x.booked), spent: BigInt(r.spent), received: BigInt(r.received) };
    });
  }

  /**
   * Runs the next part of each open split swap whose time has come, ends those past their deadline and counts the
   * parts whose orders finished. Returns what failed.
   */
  async runSplits(): Promise<{ split: string; error: string }[]> {
    const failures: { split: string; error: string }[] = [];
    for (const id of await this.#splitIds()) {
      try {
        await this.#splitSerial(async () => {
          const r = await this.#readSplit(id);
          if (r === null) return;
          if (!r.ended) await this.#runPartOf(id);
          else if (r.orders.some((x) => !x.booked)) {
            await this.#settleParts(r);
            if (r.orders.some((x) => !x.booked)) await this.#resendKept(r);
          }
        });
      } catch (err) {
        failures.push({ split: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }

  /** Ends a split swap: no further part is signed (a part already signed still finishes); what was not swapped stays in the vault. */
  cancelSplit(id: Hex): Promise<SplitStatus> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return Promise.reject(new RangeError("not a split swap id"));
    return this.#splitSerial(async () => {
      const r = await this.#readSplit(id);
      if (r === null) throw new Error(`no split swap ${id} is kept here`);
      if (!r.ended) {
        await this.#settleParts(r);
        if (!r.ended) {
          this.#end(r, `cancelled: ${formatUnitsAmount(BigInt(r.amountIn) - BigInt(r.spent), r.inDecimals)} was not swapped and stays in the vault`);
          await this.#keepSplit(r);
        }
      }
      return this.#status(r);
    });
  }

  /**
   * What an order of this agent did (OstraRouter's EscrowExecuted from `fromBlock`, and its Swapped). `open`: not
   * finished yet: its record is kept here (its Transfer may still land), or its escrow has been deployed by an
   * execution whose event the logs RPC does not serve yet. An execution that found the escrow empty (anyone may call
   * it once the order's terms are public, e.g. in a reverted transaction) is not final while the record is kept.
   * Not open and no event: its Transfer never landed.
   */
  async orderResult(order: Hex, fromBlock: bigint, escrow?: Address): Promise<OrderResult> {
    const toBlock = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
    const logs = await getLogsChunked(this.#p.logsClient, { address: this.#p.swap.router, event: getAbiItem({ abi: ostraRouterAbi, name: "EscrowExecuted" }) as AbiEvent, args: { orderHash: order }, fromBlock, toBlock });
    let spent = 0n;
    let received = 0n;
    let moved = false;
    for (const l of logs) {
      const got = (l.args as { received: bigint }).received;
      if (got === 0n) continue;
      moved = true;
      const o = await this.#outcome(l.transactionHash as Hash, order);
      if (o.swapped) {
        spent += got;
        received += o.amountOut;
      }
    }
    if (moved) return { open: false, spent, received };
    const h = order.toLowerCase();
    if ((await this.#p.folder.read(`${ORDER_PREFIX}${h}.json`)) !== undefined) return { open: true, spent, received };
    // No record kept: its Transfer landed and its escrow was emptied, so an execution that moved it exists, and the
    // logs RPC does not serve it yet when the escrow has code (an empty execution alone also deploys it).
    if (escrow !== undefined && (await hasCode(this.#p.client, escrow))) return { open: true, spent, received };
    return { open: false, spent, received };
  }

  async #keep(r: OrderRecord): Promise<void> {
    await this.#p.folder.ensure();
    await this.#p.folder.write(`${ORDER_PREFIX}${r.hash}.json`, `${JSON.stringify(r)}\n`);
  }

  /** What the order did in `txHash`: its EscrowExecuted and, when it swapped, the router's Swapped; when it did not, why (its EscrowRefunded reason, amounts in `outDecimals`). */
  async #outcome(txHash: Hash, hash: Hex, outDecimals = 18): Promise<{ swapped: boolean; amountOut: bigint; why?: string }> {
    const receipt = await this.#p.client.getTransactionReceipt({ hash: txHash });
    let swapped: boolean | null = null;
    let amountOut = 0n;
    let reason: Hex | null = null;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(this.#p.swap.router)) continue;
      try {
        const e = decodeEventLog({ abi: ostraRouterAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        const ours = (e.args as { orderHash?: Hex }).orderHash?.toLowerCase() === hash.toLowerCase();
        if (e.eventName === "EscrowExecuted" && ours) swapped = (e.args as { swapped: boolean }).swapped;
        if (e.eventName === "EscrowRefunded" && ours) reason = (e.args as { reason: Hex }).reason;
        if (e.eventName === "Swapped") amountOut = (e.args as { amountOut: bigint }).amountOut;
      } catch {
        // another event of the router
      }
    }
    if (swapped === null) throw new Error(`transaction ${txHash} has no EscrowExecuted for order ${hash}`);
    if (swapped) return { swapped, amountOut };
    return { swapped, amountOut: 0n, ...(reason === null ? {} : { why: refusalOf(reason, outDecimals) }) };
  }

  /** Keeps a finished order for ostra_swap_orders, and drops the oldest beyond DONE_ORDERS_KEPT. */
  async #keepDone(d: DoneOrder): Promise<void> {
    await this.#p.folder.ensure();
    await this.#p.folder.write(`${DONE_PREFIX}${d.order.toLowerCase()}.json`, `${JSON.stringify(d)}\n`);
    const names = (await this.#p.folder.list()).filter((n) => n.startsWith(DONE_PREFIX) && n.endsWith(".json"));
    if (names.length <= DONE_ORDERS_KEPT) return;
    const dated: { name: string; at: number }[] = [];
    for (const n of names) {
      const text = await this.#p.folder.read(n);
      dated.push({ name: n, at: text === undefined ? 0 : Number((JSON.parse(text) as DoneOrder).at) });
    }
    dated.sort((a, b) => a.at - b.at);
    for (const x of dated.slice(0, dated.length - DONE_ORDERS_KEPT)) await this.#p.folder.remove(x.name);
  }

  /**
   * Keeps what a kept order did once the sweep finishes it: from the transaction that executed it (`tx`), else from
   * OstraRouter's events from the record's block. Best effort: an order whose events cannot be read now is not kept
   * (a record from before 0.1.12 has no block to search from).
   */
  async #doneFrom(r: OrderRecord, tx: Hash | null): Promise<void> {
    try {
      let hash: Hash | null = tx;
      if (hash === null && r.fromBlock !== undefined) {
        const toBlock = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
        const logs = await getLogsChunked(this.#p.logsClient, { address: this.#p.swap.router, event: getAbiItem({ abi: ostraRouterAbi, name: "EscrowExecuted" }) as AbiEvent, args: { orderHash: r.hash }, fromBlock: BigInt(r.fromBlock), toBlock });
        const moved = logs.find((l) => (l.args as { received: bigint }).received !== 0n);
        hash = moved === undefined ? null : (moved.transactionHash as Hash);
      }
      if (hash === null) return;
      const inDecimals = r.inDecimals ?? (await tokenDecimals(this.#p.client, r.tokenIn));
      const outDecimals = r.outDecimals ?? (r.tokenOut === undefined ? 18 : await tokenDecimals(this.#p.client, r.tokenOut));
      const o = await this.#outcome(hash, r.hash, outDecimals);
      await this.#keepDone({
        version: 1,
        order: r.hash,
        txHash: hash,
        swapped: o.swapped,
        tokenIn: r.tokenIn,
        tokenOut: r.tokenOut ?? null,
        amountIn: formatUnitsAmount(BigInt(r.amountIn), inDecimals),
        amountOut: formatUnitsAmount(o.amountOut, outDecimals),
        minOut: null,
        from: r.from ?? null,
        to: r.to ?? null,
        ...(o.swapped ? {} : { refusal: o.why ?? "OstraRouter gave no reason" }),
        at: Date.now(),
      });
    } catch {
      // Its events could not be read now: the order is finished all the same.
    }
  }

  /**
   * The agent's orders kept here: those not finished (signed or about to be, or landed and being finished; oldest
   * first) and the finished ones (newest first, at most `limit`). With `order`, that order alone in either list.
   */
  async orders(o: { order?: Hex; limit?: number } = {}): Promise<{ open: OpenOrder[]; finished: DoneOrder[] }> {
    const want = o.order?.toLowerCase();
    const open: OpenOrder[] = [];
    const finished: DoneOrder[] = [];
    for (const name of await this.#p.folder.list()) {
      const isOrder = name.startsWith(ORDER_PREFIX);
      if ((!isOrder && !name.startsWith(DONE_PREFIX)) || !name.endsWith(".json")) continue;
      if (want !== undefined && name.slice((isOrder ? ORDER_PREFIX : DONE_PREFIX).length, -".json".length).toLowerCase() !== want) continue;
      const text = await this.#p.folder.read(name);
      if (text === undefined) continue;
      if (!isOrder) {
        finished.push(JSON.parse(text) as DoneOrder);
        continue;
      }
      const r = JSON.parse(text) as OrderRecord;
      const inDecimals = r.inDecimals ?? (await tokenDecimals(this.#p.client, r.tokenIn));
      const x: OpenOrder = { order: r.hash, tokenIn: r.tokenIn, tokenOut: r.tokenOut ?? null, amountIn: formatUnitsAmount(BigInt(r.amountIn), inDecimals), escrow: r.escrow, state: "open", at: r.at };
      if (r.fromBlock !== undefined) {
        const res = await this.orderResult(r.hash, BigInt(r.fromBlock), r.escrow);
        if (res.spent > 0n || res.received > 0n) {
          x.state = "landed";
          x.spent = formatUnitsAmount(res.spent, inDecimals);
          x.received = formatUnitsAmount(res.received, r.outDecimals ?? 18);
        }
      }
      open.push(x);
    }
    open.sort((a, b) => a.at - b.at);
    finished.sort((a, b) => b.at - a.at);
    return { open, finished: finished.slice(0, o.limit ?? 20) };
  }

  /**
   * Finishes the orders whose escrow was paid without being executed (a signed spend sent again on its own):
   * executeEscrow sends the input along the order's route, or back to its vault past the deadline. Records of orders
   * whose Transfer landed (the vault's nonce is past it) and whose escrow holds less than the order are dropped. Returns what failed.
   */
  async finishPending(): Promise<{ order: Hex; error: string }[]> {
    const failures: { order: Hex; error: string }[] = [];
    for (const name of await this.#p.folder.list()) {
      if (!name.startsWith(ORDER_PREFIX)) continue;
      const text = await this.#p.folder.read(name);
      if (text === undefined) continue;
      const r = JSON.parse(text) as OrderRecord;
      try {
        // The nonce first: read after the escrow, a Transfer landing in between would look executed.
        const nonce = (await this.#p.vaultFor(r.tokenIn).state()).nonce;
        const held = await tokenBalance(this.#p.client, r.tokenIn, r.escrow);
        if (held >= BigInt(r.amountIn)) {
          const tx = await this.#p.sender.send([{ to: this.#p.swap.router, data: r.execute }]);
          await this.#doneFrom(r, tx);
          await this.#p.folder.remove(name);
          continue;
        }
        // Landed and holding less than the order: executed (what is left was sent there by someone else).
        if (nonce !== null && nonce > BigInt(r.vaultNonce)) {
          await this.#doneFrom(r, null);
          await this.#p.folder.remove(name);
        }
      } catch (err) {
        failures.push({ order: r.hash, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }
}

/**
 * What OstraRouter's EscrowRefunded `reason` says, in words: the swap's revert data (at most 256 bytes; empty when it
 * ran out of gas or reverted without data) or the selector of why it was not tried.
 */
export function refusalOf(reason: Hex, outDecimals: number): string {
  if (reason === "0x") return "the swap reverted without a reason (out of gas, or a revert with no data)";
  try {
    const e = decodeErrorResult({ abi: ostraRouterAbi, data: reason });
    const args = (e.args ?? []) as readonly unknown[];
    switch (e.errorName as string) {
      case "TooLittleReceived":
        return `it would have paid ${formatUnitsAmount(args[1] as bigint, outDecimals)}, less than its minimum ${formatUnitsAmount(args[0] as bigint, outDecimals)}`;
      case "OrderExpired":
        return "its order was past its deadline";
      case "AmountMismatch":
        return `its escrow held ${(args[1] as bigint).toString()} base units, not the order's ${(args[0] as bigint).toString()}`;
      case "RouteMismatch":
        return "its legs were not the order's route";
      case "NotEnoughGas":
        return "the transaction left too little gas to run it";
      // Added by the decoder to every ABI: a pool's, a token's or the Universal Router's revert, not OstraRouter's.
      case "Error":
        return `the swap reverted: ${String(args[0])}`;
      case "Panic":
        return `the swap reverted with panic code ${String(args[0])}`;
      default:
        return `OstraRouter's ${e.errorName}${args.length === 0 ? "" : `(${args.map(String).join(", ")})`}`;
    }
  } catch {
    return `revert data ${reason.slice(0, 2 + 8 * 2)}${reason.length > 18 ? "…" : ""} (not one of OstraRouter's errors: from a pool or the Universal Router)`;
  }
}
