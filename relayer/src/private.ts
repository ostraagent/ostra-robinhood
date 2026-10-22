// Private spends of Ostra Swap (ostra-swap src/OstraPrivatePool.sol: privateSwap and unshield), relayed for the fee
// their proof pays the relayer (decided 21 Oct 2026). An agent spends a private note without any wallet of its own: the
// proof names this relayer's account as s.relayer and a fee in the note's token, which the pool pays it when the call
// lands. No x402 voucher is involved and nothing is owed: the fee is in the call itself, so the request is relayed when
// the fee covers what the transaction costs the relayer, and refused otherwise (422 fee_too_low, with the fee that
// would do). A spend is relayed alone; it carries no WOTS signature.
//
// Which tokens (decided 21 Oct 2026, narrowed after the independent review the same day): the note's token and a
// private swap's tokenOut must be FEE_TOKENS (USDG, WETH, OSTRA and the listed stock tokens, sdk pairs.ts), and a
// private swap's legs must be legs the swap SDK builds (legFor) on the pools it routes through (hubPools: Uniswap v3
// and v4 pools of the pair with a routable hook) via a hub. So every contract a relayed spend runs is known code: a
// token or hook an agent made could otherwise take a fee "worth" anything in a pool of its own and never sell, or
// revert only when sent, after the relayer paid ~14M gas of proof verification. WETH counts one to one, USDG at
// Chainlink ETH/USD (as relayer.ts prices the relayer's own quotes), the others at what their sale to WETH through
// OstraRouter quotes now (@ostraagent/swap findRoute, at the router's base fee), less FEE_HAIRCUT_BPS for the price to
// move before the fee is sold (sweep.ts).
//
// A spend that reverts on-chain costs the relayer its gas and pays nothing, and no bond pays for it. With known code
// only, what reverts one is the market (a private swap's minOut missed) or a race on the chain (the change note's
// commitment shielded first, the same nullifier spent first, the pool's price moved on purpose), which a relayer
// without a bond cannot rule out: it is bounded instead. A note (its nullifier, the ledger's privateReverts) whose
// spends reverted NOTE_REVERTS times in REVERT_WINDOW_MS is not relayed again in that window, nor anything from an IP
// address with IP_REVERTS reverted spends in it; GLOBAL_REVERTS reverted spends within GLOBAL_PAUSE_MS pause private
// relaying until they are older; one IP address gets PRIVATE_RELAYS_PER_IP_HOUR requests an hour. The deadline is
// checked when the request comes and again just before the transaction is signed (send.ts notAfter), so a spend is
// not sent to revert Expired.
//
// The price an agent proves with (GET /v1/private/price, kept PRICE_CACHE_MS per token and kind): the gas a spend of
// that kind uses with headroom (PRIVATE_GAS), at the gas price now, with the relayer margin and PRICE_HEADROOM_BPS for
// the gas price to move, in the token. Robinhood Chain prices L1 data at 0 (measured 18 Oct 2026), so the price has
// no L1 component; the relay itself is priced by simulating the transaction with it (estimateRelay) and sent with a
// gas limit of at most what it was priced at (relayGasCap), so a spend that would cost more than its fee is not sent.

import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector, type AbiFunction, type Address, type Hex, type PublicClient } from "viem";
import { LAUNCH_PAIRS, RelaySimulationError, USDG_DECIMALS, estimateRelay, relayGasCap, relayPriceWei, weiToTokenUnits, withMargin, type EthUsd, type EthUsdSource } from "@ostraagent/sdk";
import { HUBS, NO_LEG, NoRouteError, PRIVATE_SWAP_FEE_BPS, USDG, WETH, findRoute, hubPools, legFor, ostraPrivatePoolAbi, type Leg, type PoolIndex } from "@ostraagent/swap";
import type { Answer, Log } from "./gate.ts";
import type { Ledger } from "./ledger.ts";
import { NotSentError, SendUnknownError, type Landed } from "./send.ts";
import type { RelayTx } from "./calls.ts";

/**
 * Gas a private spend is priced at for GET /v1/private/price, per kind (receipt gas measured on a mainnet fork on 21 Oct
 * 2026: an unshield about 13.9M with its ~75 KB proof's calldata, a USDG to NVDA private swap 15.5-15.6M), with room
 * for swap legs through pools that cost more. The relay itself is priced by simulating the transaction.
 */
export const PRIVATE_GAS = { unshield: 16_000_000n, swap: 19_000_000n } as const;
/** The gas price may move between the price and the relay: the price an agent proves with is this much above. */
export const PRICE_HEADROOM_BPS = 2_500n;
/** A fee in a token other than WETH and USDG counts this much below its sale quote now (it is sold later). */
export const FEE_HAIRCUT_BPS = 300n;
/** The least time a spend's deadline leaves when it is relayed, in seconds (checked again before signing: send.ts DEADLINE_SPARE_SECONDS). */
export const MIN_DEADLINE_SECONDS = 300n;
/** How long a reverted private spend counts against its note and its IP address. */
export const REVERT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Reverted spends of one note in REVERT_WINDOW_MS after which it is not relayed in that window. */
export const NOTE_REVERTS = 2;
/** Reverted spends from one IP address in REVERT_WINDOW_MS after which it gets no private spend relayed in that window. */
export const IP_REVERTS = 2;
/** Reverted private spends of everyone within GLOBAL_PAUSE_MS that pause private relaying until they are older. */
export const GLOBAL_REVERTS = 4;
export const GLOBAL_PAUSE_MS = 30 * 60 * 1000;
/** Private relay requests one IP address may make in an hour. */
export const PRIVATE_RELAYS_PER_IP_HOUR = 30;
/** How long a price is kept for its token and kind. */
export const PRICE_CACHE_MS = 15_000;
const HOUR_MS = 60 * 60 * 1000;

/** The tokens a relayed spend may move (see the file comment): USDG, WETH, OSTRA and the listed stock tokens. */
export const FEE_TOKENS: ReadonlySet<Address> = new Set([USDG, WETH, ...LAUNCH_PAIRS.filter((p) => p.kind === "ostra" || p.kind === "stock").map((p) => getAddress(p.address))]);

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export type PrivateKind = keyof typeof PRIVATE_GAS;

const SELECTORS = new Map<Hex, PrivateKind>();
for (const [name, kind] of [
  ["privateSwap", "swap"],
  ["unshield", "unshield"],
] as const) {
  const item = ostraPrivatePoolAbi.find((x) => x.type === "function" && x.name === name);
  if (item === undefined) throw new Error(`ostraPrivatePoolAbi has no ${name}`);
  SELECTORS.set(toFunctionSelector(item as AbiFunction).toLowerCase() as Hex, kind);
}

/** The terms of a spend the relayer reads (OstraPrivatePool.SpendTerms). */
type SpendTerms = { asset: Address; v: bigint; fee: bigint; nullifier: Hex; root: Hex; changeCommitment: Hex; relayer: Address; deadline: bigint };
/** A private swap's terms (OstraPrivatePool.SwapTerms). */
type SwapTerms = { tokenOut: Address; minOut: bigint; outTag: Hex; hub: Address; legIn: Leg; legOut: Leg };

const sameLeg = (a: Leg, b: Leg) => a.commands.toLowerCase() === b.commands.toLowerCase() && a.inputs.length === b.inputs.length && a.inputs.every((x, i) => x.toLowerCase() === (b.inputs[i] as Hex).toLowerCase());

function json(status: number, body: unknown): Answer {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body };
}

export type PrivateRelayOptions = {
  client: PublicClient;
  /** Serves eth_getLogs over 10,000,000 blocks (Robinhood Chain's public RPC): finds the v4 pools a fee token sells in. */
  logsClient: PublicClient;
  index: PoolIndex;
  /** OstraPrivatePool. */
  pool: Address;
  ledger: Ledger;
  sender: { readonly address: Address; send(tx: { to: Address; data: `0x${string}` }, o?: { maxGas?: bigint; notAfter?: bigint }): Promise<Landed> };
  ethUsd: EthUsdSource;
  log: Log;
};

export class PrivateRelay {
  readonly #o: PrivateRelayOptions;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #prices = new Map<string, { at: number; answer: Answer }>();
  readonly #perIp = new Map<string, number[]>();
  /** Times of reverted private spends, of everyone and per IP address. */
  #reverts: number[] = [];
  readonly #ipReverts = new Map<string, number[]>();

  constructor(o: PrivateRelayOptions) {
    this.#o = o;
  }

  get pool(): Address {
    return this.#o.pool;
  }

  /** The kind of private spend `tx` is (one call to the pool), or null. */
  kindOf(tx: RelayTx): PrivateKind | null {
    if (tx.calls.length !== 1) return null;
    const call = tx.calls[0] as { to: Address; data: Hex };
    if (getAddress(call.to) !== this.#o.pool) return null;
    return SELECTORS.get(call.data.slice(0, 10).toLowerCase() as Hex) ?? null;
  }

  /** What `amount` of `token` is worth in wei, counted low (see the file comment); null without a route to WETH. */
  async valueInWei(token: Address, amount: bigint, price?: EthUsd): Promise<bigint | null> {
    const t = getAddress(token);
    if (!FEE_TOKENS.has(t)) return null;
    if (amount <= 0n) return 0n;
    if (t === WETH) return amount;
    if (t === USDG) {
      const p = price ?? (await this.#o.ethUsd());
      // The inverse of weiToTokenUnits, rounded down: the ETH/USD answer plus its deviation makes the fee worth less.
      return (amount * BPS * 10n ** 26n) / (p.answer * (BPS + 50n) * 10n ** BigInt(USDG_DECIMALS));
    }
    try {
      const route = await findRoute({ client: this.#o.client, logsClient: this.#o.logsClient, index: this.#o.index, tokenIn: t, tokenOut: WETH, amountIn: amount, feeBps: PRIVATE_SWAP_FEE_BPS, slippageBps: 0 });
      return (route.expectedOut * (BPS - FEE_HAIRCUT_BPS)) / BPS;
    } catch (err) {
      if (err instanceof NoRouteError) return null;
      throw err;
    }
  }

  /** The least amount of `token` worth `wei` (valueInWei); null without a route. */
  async tokenFor(token: Address, wei: bigint): Promise<bigint | null> {
    const t = getAddress(token);
    if (!FEE_TOKENS.has(t)) return null;
    if (wei <= 0n) return 0n;
    if (t === WETH) return wei;
    if (t === USDG) {
      const price = await this.#o.ethUsd();
      // Rounded up past the inverse's rounding down.
      let units = weiToTokenUnits(wei, price, USDG_DECIMALS);
      while (((await this.valueInWei(t, units, price)) ?? 0n) < wei) units += 1n;
      return units;
    }
    let guess: bigint;
    try {
      guess = (await findRoute({ client: this.#o.client, logsClient: this.#o.logsClient, index: this.#o.index, tokenIn: WETH, tokenOut: t, amountIn: wei, feeBps: 0, slippageBps: 0 })).expectedOut;
    } catch (err) {
      if (err instanceof NoRouteError) return null;
      throw err;
    }
    for (let i = 0; i < 4 && guess > 0n; i++) {
      const worth = await this.valueInWei(t, guess);
      if (worth === null) return null;
      if (worth >= wei) return guess;
      guess = ceilDiv(guess * wei, worth > 0n ? worth : 1n) + guess / 100n + 1n;
    }
    return null;
  }

  /** GET /v1/private/price: the fee in `token` a spend of `kind` is relayed for now (see the file comment). */
  async price(token: Address, kind: PrivateKind): Promise<Answer> {
    const t = getAddress(token);
    if (!FEE_TOKENS.has(t)) return json(422, { error: "fee_unpriced", message: `${t} is not a token the relayer takes fees in (USDG, WETH, OSTRA or a listed stock token)` });
    const key = `${t}:${kind}`;
    const cached = this.#prices.get(key);
    if (cached !== undefined && Date.now() - cached.at < PRICE_CACHE_MS) return cached.answer;
    const answer = await this.#price(t, kind);
    if (answer.status === 200) this.#prices.set(key, { at: Date.now(), answer });
    return answer;
  }

  async #price(token: Address, kind: PrivateKind): Promise<Answer> {
    const gas = PRIVATE_GAS[kind];
    let gasPrice: bigint;
    let fee: bigint | null;
    try {
      gasPrice = await this.#o.client.getGasPrice();
      const wei = ceilDiv(withMargin(gas * gasPrice) * (BPS + PRICE_HEADROOM_BPS), BPS);
      fee = await this.tokenFor(token, wei);
    } catch (err) {
      return json(503, { error: "price_unavailable", message: `no price now: ${(err as Error).message}` });
    }
    if (fee === null) return json(422, { error: "fee_unpriced", message: `${token} has no Uniswap route to WETH the relayer prices a fee with now` });
    return json(200, { token: getAddress(token), kind, fee: fee.toString(), relayer: this.#o.sender.address, pool: this.#o.pool, gas: gas.toString(), gasPrice: gasPrice.toString(), minDeadlineSeconds: MIN_DEADLINE_SECONDS.toString() });
  }

  /** POST /v1/relay with a private spend (kindOf not null) from `ip`. */
  relay(tx: RelayTx, ip: string): Promise<Answer> {
    const now = Date.now();
    const recent = (this.#perIp.get(ip) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= PRIVATE_RELAYS_PER_IP_HOUR) return Promise.resolve(json(429, { error: "private_relay_limit", message: `at most ${PRIVATE_RELAYS_PER_IP_HOUR} private spends are relayed per IP address an hour` }));
    this.#perIp.set(ip, [...recent, now]);
    if (this.#perIp.size > 10_000) for (const [k, v] of this.#perIp) if (v.every((t) => now - t >= HOUR_MS)) this.#perIp.delete(k);
    const prev = this.#locks.get(tx.hash) ?? Promise.resolve();
    const next = prev.then(
      () => this.#relay(tx, ip),
      () => this.#relay(tx, ip),
    );
    const tail = next.catch(() => undefined);
    this.#locks.set(tx.hash, tail);
    return next.finally(() => {
      if (this.#locks.get(tx.hash) === tail) this.#locks.delete(tx.hash);
    });
  }

  async #relay(tx: RelayTx, ip: string): Promise<Answer> {
    const done = this.#o.ledger.view().paid[tx.hash];
    if (done !== undefined) return json(200, { txHash: done.txHash, fee: done.amount, token: done.token, repeated: true });
    const call = tx.calls[0] as { to: Address; data: Hex };
    let s: SpendTerms;
    let swap: SwapTerms | null = null;
    try {
      const d = decodeFunctionData({ abi: ostraPrivatePoolAbi, data: call.data });
      const args = d.args as readonly unknown[];
      s = args[0] as SpendTerms;
      if (d.functionName === "privateSwap") swap = args[1] as SwapTerms;
    } catch {
      return json(400, { error: "bad_transaction", message: "malformed private spend calldata" });
    }
    const now = Date.now();
    const noteReverts = (this.#o.ledger.view().privateReverts?.[s.nullifier.toLowerCase()] ?? []).filter((r) => now - r.at < REVERT_WINDOW_MS);
    if (noteReverts.length >= NOTE_REVERTS) {
      return json(409, { error: "reverted_before", message: `spends of this note reverted ${noteReverts.length} times when relayed; it is not relayed again for 24 hours after the last`, txHashes: noteReverts.map((r) => r.txHash) });
    }
    if ((this.#ipReverts.get(ip) ?? []).filter((t) => now - t < REVERT_WINDOW_MS).length >= IP_REVERTS) {
      return json(403, { error: "reverts_limit", message: `${IP_REVERTS} private spends from this IP address reverted when relayed in 24 hours; none is relayed for it until then` });
    }
    this.#reverts = this.#reverts.filter((t) => now - t < GLOBAL_PAUSE_MS);
    if (this.#reverts.length >= GLOBAL_REVERTS) return json(503, { error: "private_paused", message: "private spends are not relayed for now; try again within half an hour" });
    const relayer = this.#o.sender.address;
    if (getAddress(s.relayer) !== relayer) return json(422, { error: "not_relayer_fee", message: `the spend pays its fee to ${getAddress(s.relayer)}, not this relayer's account ${relayer}: prove it with relayer ${relayer}` });
    if (s.fee <= 0n) return json(422, { error: "fee_too_low", message: "the spend pays the relayer no fee" });
    const asset = getAddress(s.asset);
    if (!FEE_TOKENS.has(asset)) return json(422, { error: "token_not_relayed", message: `${asset} is not a token the relayer relays private spends of (USDG, WETH, OSTRA or a listed stock token)` });
    const unavailable = (err: unknown) => json(503, { error: "unavailable", message: `the chain could not be read: ${(err as Error).message}` });
    try {
      const chainNow = (await this.#o.client.getBlock({ blockTag: "latest" })).timestamp;
      if (s.deadline < chainNow + MIN_DEADLINE_SECONDS) return json(422, { error: "deadline_too_close", message: `the spend's deadline must leave at least ${MIN_DEADLINE_SECONDS} s` });
      if (swap !== null) {
        const problem = await this.#swapProblem(asset, swap);
        if (problem !== null) return json(422, { error: "route_not_relayed", message: problem });
      }
    } catch (err) {
      return unavailable(err);
    }

    let m: Awaited<ReturnType<typeof estimateRelay>>;
    try {
      m = await estimateRelay(this.#o.client, { relayer, to: tx.to, data: tx.data });
    } catch (err) {
      if (err instanceof RelaySimulationError) return json(err.code === "simulation_unavailable" ? 503 : 422, { error: err.code, message: err.message });
      return unavailable(err);
    }
    const need = relayPriceWei(m);
    let worth: bigint | null;
    try {
      worth = await this.valueInWei(s.asset, s.fee);
    } catch (err) {
      return json(503, { error: "price_unavailable", message: `no price now: ${(err as Error).message}` });
    }
    if (worth === null) return json(422, { error: "fee_unpriced", message: `${asset} has no Uniswap route to WETH the relayer prices a fee with now` });
    if (worth < need) {
      // What the agent proves with next: the spend's own cost with the price's headroom.
      const required = await this.tokenFor(asset, ceilDiv(need * (BPS + PRICE_HEADROOM_BPS), BPS)).catch(() => null);
      return json(422, { error: "fee_too_low", message: `the fee is worth ${worth} wei; the spend costs ${need} wei to send now`, required: required?.toString() ?? null, token: asset });
    }

    // Kept before sending: a send whose outcome is not known yet may still pay this fee.
    try {
      await this.#o.ledger.update((data) => {
        const tokens = data.feeTokens ?? [];
        if (!tokens.includes(asset)) data.feeTokens = [...tokens, asset];
      });
    } catch (err) {
      this.#o.log("ledger_write_failed", { request: tx.hash, error: (err as Error).message });
      return json(503, { error: "unavailable", message: "the relayer could not keep its records; nothing was sent, try again" });
    }
    let landed: Landed;
    try {
      landed = await this.#o.sender.send({ to: tx.to, data: tx.data }, { maxGas: relayGasCap(m.gas), notAfter: s.deadline });
    } catch (err) {
      if (err instanceof SendUnknownError) {
        this.#o.log("send_unknown", { request: tx.hash, txHash: err.txHash, error: err.message });
        return json(503, { error: "send_unknown", txHash: err.txHash, message: `${err.message}; it may still land: check the transaction before sending the request again` });
      }
      if (err instanceof NotSentError) {
        this.#o.log("private_not_sent", { request: tx.hash, spentWei: err.spentWei, txHash: err.txHash, error: err.message });
        if (err.spentWei > 0n) {
          // It reverted on-chain, and the relayer paid its gas: it counts against the note, the IP address and everyone.
          const at = Date.now();
          this.#reverts.push(at);
          this.#ipReverts.set(ip, [...(this.#ipReverts.get(ip) ?? []).filter((t) => at - t < REVERT_WINDOW_MS), at]);
          const key = s.nullifier.toLowerCase();
          await this.#o.ledger
            .update((data) => {
              const all = data.privateReverts ?? {};
              for (const [n, list] of Object.entries(all)) if (list.every((r) => at - r.at >= REVERT_WINDOW_MS)) delete all[n];
              all[key] = [...(all[key] ?? []).filter((r) => at - r.at < REVERT_WINDOW_MS), { txHash: err.txHash ?? "", at }];
              data.privateReverts = all;
            })
            .catch((e: unknown) => this.#o.log("ledger_write_failed", { request: tx.hash, error: (e as Error).message }));
        }
        return json(409, { error: "not_sent", message: err.message });
      }
      throw err;
    }
    try {
      await this.#o.ledger.update((data) => {
        data.paid[tx.hash] = { txHash: landed.txHash, amount: s.fee.toString(), at: Date.now(), token: asset };
      });
    } catch (err) {
      // It landed: the answer says so even when the record could not be kept (sent again, the simulation refuses it).
      this.#o.log("ledger_write_failed", { request: tx.hash, txHash: landed.txHash, error: (err as Error).message });
    }
    this.#o.log("private_relayed", { request: tx.hash, kind: this.kindOf(tx), txHash: landed.txHash, gasUsed: landed.gasUsed, effectiveGasPrice: landed.effectiveGasPrice, token: asset, fee: s.fee, worthWei: worth, needWei: need });
    return json(200, { txHash: landed.txHash, fee: s.fee.toString(), token: asset });
  }

  /**
   * Why a private swap of `asset` along `t` is not relayed, or null: its tokenOut must be a FEE_TOKENS token, its hub
   * USDG or WETH, and each leg one the swap SDK builds (legFor) on a pool hubPools finds for that pair, or no leg
   * where the token is the hub.
   */
  async #swapProblem(asset: Address, t: SwapTerms): Promise<string | null> {
    const out = getAddress(t.tokenOut);
    const hub = getAddress(t.hub);
    if (!FEE_TOKENS.has(out)) return `the swap's tokenOut ${out} is not a token the relayer relays (USDG, WETH, OSTRA or a listed stock token)`;
    if (!(HUBS as readonly Address[]).includes(hub)) return `the swap's hub ${hub} is not USDG or WETH`;
    if (out === asset) return "the swap's tokenOut is its tokenIn";
    const legOk = async (leg: Leg, token: Address, tokenIn: Address, tokenOut: Address): Promise<boolean> => {
      if (token === hub) return sameLeg(leg, NO_LEG);
      const pools = await hubPools(this.#o.client, this.#o.logsClient, this.#o.index, token, hub);
      return pools.some((p) => {
        try {
          return sameLeg(leg, legFor(p, tokenIn, tokenOut));
        } catch {
          return false;
        }
      });
    };
    if (!(await legOk(t.legIn, asset, asset, hub))) return `the swap's leg in is not a leg on a Uniswap pool of ${asset} and ${hub} the relayer routes through`;
    if (!(await legOk(t.legOut, out, hub, out))) return `the swap's leg out is not a leg on a Uniswap pool of ${hub} and ${out} the relayer routes through`;
    return null;
  }
}

/** WETH.withdraw calldata (sweep.ts unwraps WETH fees). */
export function wethWithdrawData(amount: bigint): Hex {
  return encodeFunctionData({ abi: [{ type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] }] as const, functionName: "withdraw", args: [amount] });
}
