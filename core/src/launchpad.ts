// The Ostra launchpad as this agent uses it (design v0.4, D2), with no ETH:
// every transaction goes through the agent's sender (the relayer, paid in
// USDG; or the local fee payer), and every vault spend is quoted or simulated
// with a throwaway key before the agent's own key signs it (sdk quote.ts), so
// nothing is signed that fails now.
//
// Vaults:
//   * the buyer vault (USDG) buys: a Swap of USDG into the token's pool whose
//     recipient is the agent's token vault for that token (created in the
//     same request if it does not exist yet);
//   * a token vault (VaultService kind "token", keychain
//     vaultKeychainId(chain, token)) holds what was bought or vested and
//     sells it (a Swap back to the buyer vault), transfers it and claims its
//     dividends; its requests are paid by the buyer vault (`payer`);
//   * the creator vault (USDG, its own records and relayer client) launches:
//     OstraDevBuy.launchFromVault with one DevBuy spend (action 9) that pays
//     the dev buy from the vault inside the launch it signed; the relayer
//     fronts the 0.0002 ETH launch fee and charges it in USDG. The dev buy's
//     tokens vest to the creator's token vault. The creator vault also owns
//     the pool: settings (only in the traders' favour), creator shares,
//     airdrop rounds (it buys the round into OstraAirdrop, then sets the
//     amount and starts it with the tree's root), and it receives the
//     creator payouts (OstraCreatorSplit.release).
// Public calls (airdrop claim and close, vesting release and dividends,
// referral claims, split releases) are sent for the buyer vault as payer.
//
// Records, in the agent's `launchpad` folder (no secrets):
//   launch-<token>.json        a launch this agent made: pool, vesting, tx
//   airdrop-<pool>-<round>.json the round's entries and proofs, so claims
//                              can be sent for any of its accounts

import { bytesToHex, decodeEventLog, encodeFunctionData, getAddress, isAddress, zeroAddress, type Address, type Hash, type Hex, type PublicClient, type Transport } from "viem";
import {
  AIRDROP,
  CREATOR_SPLIT,
  DEV_BUY,
  LAUNCHPAD,
  NO_DEV_BUY,
  POOL_SETTING,
  QUOTE_DEFAULT_SLIPPAGE_BPS,
  VAULT_ACTION,
  VAULT_SWAP_GAS_RESERVE,
  airdropRoundAmountParams,
  airdropTree,
  claimDividendParams,
  configurePoolParams,
  creatorShareParams,
  launchFromVaultData,
  launchParams as defaultLaunchParams,
  ostraAirdropAbi,
  ostraCreatorSplitAbi,
  ostraDevBuyAbi,
  ostraDispatcherAbi,
  ostraHookAbi,
  ostraLaunchpadAbi,
  ostraTokenAbi,
  ostraVaultAbi,
  ostraVestingAbi,
  poolTick,
  quoteVaultLaunch,
  quoteVaultSwap,
  signVaultDevBuy,
  signVaultSpend,
  signVaultSwap,
  simulateVaultSpend,
  startAirdropParams,
  startTickForMarketCap,
  transferParams,
  type DevBuyTerms,
  type LaunchParams,
  type LaunchpadDeployment,
  type PoolKey,
  type PoolSetting,
  type RelayCall,
  type SwapQuote,
} from "@ostraagent/sdk";
import { formatTokenAmount, formatUnitsAmount, parseTokenAmount, parseUnitsAmount, TOKEN_DECIMALS } from "./amount.ts";
import { tokenBalance, tokenDecimals } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import { randomBytes } from "./random.ts";
import { VAULT_SPEND_GAS, type Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import { spendCall, VaultService, type VaultOperationResult } from "./vault.ts";

export const LAUNCHPAD_DIR = "launchpad";
/** Gas a createVault uses (vault.ts CREATE_VAULT_GAS). */
const CREATE_VAULT_GAS = 300_000n;
/** A launch is reserved for its quoted gas x 5/4 plus this (the L1 data component, a moving price). */
const LAUNCH_GAS_HEADROOM = 300_000n;
/** A simulated vault spend is reserved for its gas x 5/4 plus this, at least VAULT_SPEND_GAS. */
const SPEND_GAS_HEADROOM = 100_000n;
const DAY = 86_400;

/** The settings a creator changes after the launch, by name (OstraHook.configure fields; only in the traders' favour). */
export const POOL_SETTING_NAMES: Readonly<Record<string, PoolSetting>> = {
  buy_tax: POOL_SETTING.BUY_TAX,
  sell_tax: POOL_SETTING.SELL_TAX,
  post_buy_tax: POOL_SETTING.POST_BUY_TAX,
  post_sell_tax: POOL_SETTING.POST_SELL_TAX,
  tax_end_at: POOL_SETTING.TAX_END_AT,
  anti_snipe: POOL_SETTING.ANTI_SNIPE,
  max_buy: POOL_SETTING.MAX_BUY,
  release_limits: POOL_SETTING.RELEASE_LIMITS,
  volatility_fee: POOL_SETTING.VOLATILITY_FEE,
  max_tx_move: POOL_SETTING.MAX_TX_MOVE,
};

/** The parts of a launch an agent sets beyond its name, symbol and starting price (raw LaunchParams fields; Ostra's defaults otherwise). */
export type LaunchOptions = Partial<Omit<LaunchParams, "name" | "symbol" | "salt" | "quote" | "creatorVault" | "startTick">>;

export type LaunchInput = {
  name: string;
  symbol: string;
  /** The starting market cap in USDG (the whole supply at the starting price); or `startTick`. */
  marketCap?: string;
  startTick?: number;
  /** The creator's dev buy in the launch, paid from the creator vault in USDG, vesting to the creator's token vault. */
  devBuy?: { amount: string; cliffDays?: number; vestingDays?: number };
  options?: LaunchOptions;
};

export type LaunchResult =
  | {
      status: "launched";
      txHash: Hash;
      token: Address;
      poolId: Hex;
      creatorVault: Address;
      tokenVault: Address;
      devBuy: { paid: string; tokens: string; vesting: Address; cliffEnd: string; vestingEnd: string } | null;
      note: string;
    }
  | { status: "resent_pending"; resent: unknown; vaultNonce: string; note: string };

export type SwapResult =
  | {
      status: "sent";
      txHash: Hash;
      swapped: boolean;
      amountIn: string;
      amountOut: string;
      minOut: string;
      from: Address;
      to: Address;
      /** Ostra pools: the share of the circuit breaker's room in the swap's direction the quote used, in %. */
      bandUsedPercent: number | null;
      note?: string;
    }
  | { status: "resent_pending"; resent: unknown; vaultNonce: string; note: string };

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
};

type Pool = { token: Address; id: Hex; key: PoolKey; config: Record<string, unknown> & { token: Address; creatorVault: Address; tokenIs0: boolean; dividendToken: Address } };

function nowIso(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

function address(text: string, what: string): Address {
  if (!isAddress(text, { strict: false })) throw new RangeError(`${what} ${text} is not an address`);
  return getAddress(text);
}

function slippage(bps: number | undefined): number {
  const s = bps ?? QUOTE_DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(s) || s < 0 || s > 1_000) throw new RangeError("slippage must be 0..1000 bps");
  return s;
}

/** The gas a vault Swap with `swapGas` is reserved for (relayer.ts reservedSwapGas). */
function swapSpendGas(swapGas: bigint): bigint {
  return VAULT_SPEND_GAS + swapGas + swapGas / 63n + 1n + BigInt(VAULT_SWAP_GAS_RESERVE);
}

/** The gas a simulated spend is reserved for. */
function simulatedGas(gasUsed: bigint): bigint {
  const g = (gasUsed * 5n) / 4n + SPEND_GAS_HEADROOM;
  return g > VAULT_SPEND_GAS ? g : VAULT_SPEND_GAS;
}

export type LaunchpadParts = {
  client: PublicClient;
  transport: Transport;
  config: Config;
  /** The agent's keys (its own folder). */
  keys: Keys;
  buyer: VaultService;
  buyerSender: Sender;
  creator: VaultService;
  creatorSender: Sender;
};

export class LaunchpadService {
  readonly #client: PublicClient;
  readonly #transport: Transport;
  readonly #config: Config;
  readonly #keys: Keys;
  readonly #buyer: VaultService;
  readonly #buyerSender: Sender;
  readonly #creator: VaultService;
  readonly #creatorSender: Sender;
  readonly #folder: Folder;
  readonly #tokenVaults = new Map<Address, VaultService>();

  constructor(p: LaunchpadParts) {
    if (p.creator.kind !== "creator" || p.buyer.kind !== "buyer") throw new Error("the launchpad takes the agent's buyer and creator vaults");
    this.#client = p.client;
    this.#transport = p.transport;
    this.#config = p.config;
    this.#keys = p.keys;
    this.#buyer = p.buyer;
    this.#buyerSender = p.buyerSender;
    this.#creator = p.creator;
    this.#creatorSender = p.creatorSender;
    this.#folder = p.keys.folder.folder(LAUNCHPAD_DIR);
  }

  #lp(): LaunchpadDeployment {
    const lp = this.#config.deployment.launchpad;
    if (lp === undefined) throw new Error("this deployment has no launchpad");
    return lp;
  }

  #usdg(): Address {
    return this.#config.deployment.token;
  }

  /** The agent's vault for `token` (a token vault; the buyer vault for USDG). */
  tokenVault(tokenText: string): VaultService {
    const token = address(tokenText, "token");
    if (token === this.#usdg()) return this.#buyer;
    let v = this.#tokenVaults.get(token);
    if (v === undefined) {
      v = new VaultService(this.#client, this.#transport, this.#config, this.#keys, this.#buyerSender, "token", null, token);
      this.#tokenVaults.set(token, v);
    }
    return v;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** The pool of `tokenText`, a token the Ostra launchpad launched. */
  async #pool(tokenText: string): Promise<Pool> {
    const lp = this.#lp();
    const token = address(tokenText, "token");
    const id = (await this.#client.readContract({ address: lp.launchpad, abi: ostraLaunchpadAbi, functionName: "poolOf", args: [token] })) as Hex;
    if (BigInt(id) === 0n) throw new Error(`${token} is not a token the Ostra launchpad launched`);
    const [key, config] = await Promise.all([
      this.#client.readContract({ address: lp.hook, abi: ostraHookAbi, functionName: "poolKey", args: [id] }) as Promise<PoolKey>,
      this.#client.readContract({ address: lp.hook, abi: ostraHookAbi, functionName: "poolConfig", args: [id] }) as Promise<Pool["config"]>,
    ]);
    return { token, id, key, config };
  }

  /** The pool's quote currency (address(0): ETH). */
  #quoteOf(pool: Pool): Address {
    return getAddress(pool.config.tokenIs0 ? pool.key.currency1 : pool.key.currency0);
  }

  /** A launched token's pool: price, rules, circuit breaker, airdrop round and creator shares. */
  async poolInfo(tokenText: string): Promise<PoolView> {
    const lp = this.#lp();
    const pool = await this.#pool(tokenText);
    const c = pool.config as unknown as {
      tokenIs0: boolean;
      creatorVault: Address;
      maxBuy: bigint;
      dividendToken: Address;
      launchedAt: number;
      maxTxMoveTicks: number;
    };
    const quote = this.#quoteOf(pool);
    const quoteDecimals = quote === zeroAddress ? 18 : await tokenDecimals(this.#client, quote);
    const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
      this.#client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
    const [state, rates, tick, name, symbol, round, available, nextAmount, shares] = await Promise.all([
      read<{ graduated: boolean; supply: bigint; tokensSold: bigint; quoteRaised: bigint }>(lp.hook, ostraHookAbi, "poolState", [pool.id]),
      read<readonly [bigint, bigint, bigint]>(lp.hook, ostraHookAbi, "rates", [pool.id]),
      poolTick(this.#client, pool.id),
      read<string>(pool.token, ostraTokenAbi, "name"),
      read<string>(pool.token, ostraTokenAbi, "symbol"),
      read<{ amount: bigint; claimed: bigint; endsAt: number; number: number; open: boolean }>(lp.airdrop, ostraAirdropAbi, "round", [pool.id]),
      read<bigint>(lp.airdrop, ostraAirdropAbi, "available", [pool.id]),
      read<bigint>(lp.airdrop, ostraAirdropAbi, "nextRoundAmount", [pool.id]),
      read<readonly [readonly Address[], readonly number[]]>(lp.creatorSplit, ostraCreatorSplitAbi, "recipients", [pool.id]),
    ]);
    const band = c.maxTxMoveTicks === 0 ? null : await read<readonly [number, number]>(lp.hook, ostraHookAbi, "txMoveBand", [pool.id]);
    // The tick prices currency0 in currency1, raw unit for raw unit.
    const raw = Math.pow(1.0001, tick);
    const perRaw = c.tokenIs0 ? raw : 1 / raw;
    const price = (perRaw * 10 ** 18) / 10 ** quoteDecimals;
    const supply = Number(state.supply) / 1e18;
    const fmtQuote = (v: bigint) => formatUnitsAmount(v < 0n ? 0n : v, quoteDecimals);
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
      launchedAt: nowIso(BigInt(c.launchedAt)),
      airdrop: {
        round: round.number,
        open: round.open,
        amount: formatUnitsAmount(round.amount, 18),
        claimed: formatUnitsAmount(round.claimed, 18),
        endsAt: round.number === 0 ? null : nowIso(BigInt(round.endsAt)),
        available: formatUnitsAmount(available, 18),
        nextRoundAmount: formatUnitsAmount(nextAmount, 18),
      },
      creatorShares: shares[0].map((recipient, i) => ({ recipient: getAddress(recipient), bps: Number(shares[1][i]) })),
    };
  }

  /** The agent's vault for a launched token: its address, whether it exists, the balance and the dividends it can claim. */
  async tokenVaultInfo(tokenText: string): Promise<{ token: Address; vault: Address; exists: boolean; balance: string; dividends: string | null; pendingOperation: number | null }> {
    const pool = await this.#pool(tokenText);
    const s = await this.tokenVault(pool.token).state();
    let dividends: string | null = null;
    if (getAddress(pool.config.dividendToken) !== zeroAddress) {
      const owed = (await this.#client.readContract({ address: pool.token, abi: ostraTokenAbi, functionName: "dividendOf", args: [s.vault] })) as bigint;
      const decimals = getAddress(pool.config.dividendToken) === this.#usdg() ? TOKEN_DECIMALS : await tokenDecimals(this.#client, getAddress(pool.config.dividendToken));
      dividends = formatUnitsAmount(owed, decimals);
    }
    return { token: pool.token, vault: s.vault, exists: s.exists, balance: formatUnitsAmount(s.balance, 18), dividends, pendingOperation: s.pendingAction };
  }

  // ---------------------------------------------------------------------------
  // Trading
  // ---------------------------------------------------------------------------

  /** The swap `side` of `amountText` as it would be signed now (nothing is signed). */
  async quote(a: { side: "buy" | "sell"; token: string; amount: string; slippageBps?: number; referrer?: string }): Promise<{ amountIn: string; expectedOut: string; minOut: string; swapGas: string; bandUsedPercent: number | null }> {
    const { q, inDecimals, outDecimals } = await this.#swapQuote(a, false);
    return {
      amountIn: formatUnitsAmount(q.amountIn, inDecimals),
      expectedOut: formatUnitsAmount(q.amountOut, outDecimals),
      minOut: formatUnitsAmount(q.swap.minOut, outDecimals),
      swapGas: q.swap.swapGas.toString(),
      bandUsedPercent: q.band === null ? null : q.band.usedBps / 100,
    };
  }

  async #swapQuote(a: { side: "buy" | "sell"; token: string; amount: string; slippageBps?: number; referrer?: string }, create: boolean): Promise<{
    q: SwapQuote;
    pool: Pool;
    from: VaultService;
    fromVault: Address;
    to: Address;
    inDecimals: number;
    outDecimals: number;
    sender: Sender;
  }> {
    const pool = await this.#pool(a.token);
    const quote = this.#quoteOf(pool);
    if (quote !== this.#usdg()) throw new Error(`the pool of ${pool.token} trades against ${quote === zeroAddress ? "ETH" : quote}; this agent trades USDG pools`);
    const referrer = a.referrer === undefined ? undefined : address(a.referrer, "referrer");
    const usdgIs0 = getAddress(pool.key.currency0) === this.#usdg();
    const buying = a.side === "buy";
    const from = buying ? this.#buyer : this.tokenVault(pool.token);
    const fromVault = await from.vaultAddress();
    const to = buying ? await this.tokenVault(pool.token).vaultAddress() : await this.#buyer.vaultAddress();
    const amountIn = buying ? parseTokenAmount(a.amount) : parseUnitsAmount(a.amount, 18);
    if (amountIn === 0n) throw new RangeError("amount must be greater than zero");
    const state = await from.state();
    if (!state.exists && buying) throw new Error("this agent has no vault yet; call open_vault first");
    if (state.balance < amountIn) {
      throw new Error(`the ${buying ? "vault" : `vault in ${pool.token}`} holds ${buying ? formatTokenAmount(state.balance) : formatUnitsAmount(state.balance, 18)}, less than ${a.amount}`);
    }
    const sender = this.#buyerSender;
    // A token vault that holds tokens but was never created (they were sent to its address) is created first, paid by the buyer vault.
    if (!state.exists) {
      if (!create) throw new Error(`the vault in ${pool.token} holds tokens but is not created yet; sell creates it, then quotes`);
      await from.open();
    }
    const q = await quoteVaultSwap(this.#client, this.#config.deployment, {
      vault: fromVault,
      relayer: await sender.payer(),
      swap: { key: pool.key, zeroForOne: buying ? usdgIs0 : !usdgIs0, amountIn, recipient: to, ...(referrer === undefined ? {} : { referrer }) },
      slippageBps: slippage(a.slippageBps),
    });
    return { q, pool, from, fromVault, to, inDecimals: buying ? TOKEN_DECIMALS : 18, outDecimals: buying ? 18 : TOKEN_DECIMALS, sender };
  }

  /** What the vault's Swap in `txHash` did: Swapped (in, out) or SwapFailed. */
  async #swapOutcome(txHash: Hash, vault: Address): Promise<{ swapped: boolean; amountIn: bigint; amountOut: bigint }> {
    const receipt = await this.#client.getTransactionReceipt({ hash: txHash });
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== vault) continue;
      try {
        const e = decodeEventLog({ abi: ostraVaultAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        if (e.eventName === "Swapped") {
          const args = e.args as unknown as { amountIn: bigint; amountOut: bigint };
          return { swapped: true, amountIn: args.amountIn, amountOut: args.amountOut };
        }
        if (e.eventName === "SwapFailed") return { swapped: false, amountIn: 0n, amountOut: 0n };
      } catch {
        // another event of the vault
      }
    }
    throw new Error(`transaction ${txHash} has no Swap of ${vault}`);
  }

  /** Buys `token` with `amount` USDG of the buyer vault, into the agent's token vault. */
  buy(a: { token: string; amount: string; slippageBps?: number; referrer?: string }): Promise<SwapResult> {
    return this.#swap({ ...a, side: "buy" });
  }

  /** Sells `amount` of `token` from the agent's token vault for USDG into the buyer vault. */
  sell(a: { token: string; amount: string; slippageBps?: number; referrer?: string }): Promise<SwapResult> {
    return this.#swap({ ...a, side: "sell" });
  }

  async #swap(a: { side: "buy" | "sell"; token: string; amount: string; slippageBps?: number; referrer?: string }): Promise<SwapResult> {
    const { q, pool, from, fromVault, to, inDecimals, outDecimals } = await this.#swapQuote(a, true);
    const buying = a.side === "buy";
    const tokenVault = this.tokenVault(pool.token);
    const createTokenVault = buying && !(await tokenVault.state()).exists;
    const inToken = buying ? this.#usdg() : pool.token;
    const result = await from.operate({
      gas: swapSpendGas(q.swap.swapGas) + (createTokenVault ? CREATE_VAULT_GAS : 0n),
      moves: q.amountIn,
      what: buying ? "buy" : "sell",
      build: async ({ v, vault, keychain, chainId }) => {
        const balance = await tokenBalance(this.#client, inToken, vault);
        if (balance < q.amountIn) throw new Error(`the vault holds ${formatUnitsAmount(balance, inDecimals)} now, less than ${formatUnitsAmount(q.amountIn, inDecimals)}; nothing was signed`);
        const signed = await signVaultSwap(keychain, v, { chainId, token: inToken, swap: q.swap });
        const calls: RelayCall[] = createTokenVault ? [await tokenVault.createCall()] : [];
        calls.push(spendCall(vault, signed));
        return calls;
      },
    });
    if (result.status !== "sent") return result;
    const outcome = await this.#swapOutcome(result.txHash, fromVault);
    return {
      status: "sent",
      txHash: result.txHash,
      swapped: outcome.swapped,
      amountIn: formatUnitsAmount(outcome.amountIn, inDecimals),
      amountOut: formatUnitsAmount(outcome.amountOut, outDecimals),
      minOut: formatUnitsAmount(q.swap.minOut, outDecimals),
      from: fromVault,
      to,
      bandUsedPercent: q.band === null ? null : q.band.usedBps / 100,
      ...(outcome.swapped ? {} : { note: "the price moved past the quote's minimum between the quote and the block: the swap moved nothing and used the vault's key; quote again" }),
    };
  }

  /**
   * A spend of `vault` (`action`, `params`) simulated with a throwaway key
   * first, then signed and sent: `what` names it in messages.
   */
  async #simulatedSpend(vault: VaultService, sender: Sender, action: number, params: Hex, what: string): Promise<VaultOperationResult> {
    const address = await vault.vaultAddress();
    const sim = await simulateVaultSpend(this.#client, this.#config.deployment, { relayer: await sender.payer(), vault: address, action, params });
    return vault.operate({
      gas: simulatedGas(sim.gasUsed),
      what,
      build: async ({ v, vault: at, keychain, chainId }) => [spendCall(at, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))],
    });
  }

  /** Sends `amount` of `token` from the agent's token vault to `destination`. */
  async transferToken(a: { token: string; destination: string; amount: string }): Promise<VaultOperationResult> {
    const token = address(a.token, "token");
    const destination = address(a.destination, "destination");
    if (destination === zeroAddress) throw new RangeError("the destination must not be the zero address");
    const v = this.tokenVault(token);
    if (v === this.#buyer) throw new Error("USDG is withdrawn with withdraw");
    const decimals = await tokenDecimals(this.#client, token);
    const amount = parseUnitsAmount(a.amount, decimals);
    if (amount === 0n) throw new RangeError("amount must be greater than zero");
    const s = await v.state();
    if (!s.exists) throw new Error(`this agent has no vault in ${token}`);
    if (s.balance < amount) throw new Error(`the vault in ${token} holds ${formatUnitsAmount(s.balance, decimals)}, less than ${a.amount}`);
    if (destination === s.vault) throw new Error("the destination is the vault itself");
    return this.#simulatedSpend(v, this.#buyerSender, VAULT_ACTION.TRANSFER, transferParams({ to: destination, amount }), "token transfer");
  }

  /** The agent's vault that receives `dividendToken`: the buyer vault for USDG, else the token vault of that token. */
  async #vaultFor(dividendToken: Address): Promise<Address> {
    return this.tokenVault(dividendToken).vaultAddress();
  }

  /** Claims the dividends the agent's token vault for `token` earned, into the agent's vault of the dividend token. */
  async claimDividends(tokenText: string): Promise<VaultOperationResult & { recipient?: Address }> {
    const pool = await this.#pool(tokenText);
    const dividendToken = getAddress(pool.config.dividendToken);
    if (dividendToken === zeroAddress) throw new Error(`the pool of ${pool.token} pays no dividends`);
    const v = this.tokenVault(pool.token);
    const s = await v.state();
    if (!s.exists) throw new Error(`this agent has no vault in ${pool.token}`);
    const owed = (await this.#client.readContract({ address: pool.token, abi: ostraTokenAbi, functionName: "dividendOf", args: [s.vault] })) as bigint;
    if (owed === 0n) throw new Error(`the vault in ${pool.token} has no dividends to claim now; nothing was signed`);
    const recipient = await this.#vaultFor(dividendToken);
    const r = await this.#simulatedSpend(v, this.#buyerSender, VAULT_ACTION.CLAIM_DIVIDEND, claimDividendParams(recipient), "dividend claim");
    return { ...r, recipient };
  }

  // ---------------------------------------------------------------------------
  // Launching (the creator vault)
  // ---------------------------------------------------------------------------

  #launchName(token: Address): string {
    return `launch-${token.toLowerCase()}.json`;
  }

  /** The launches this agent made, as recorded. */
  async launches(): Promise<{ token: Address; poolId: Hex; txHash: Hash; vesting: Address | null; at: number }[]> {
    await this.#folder.ensure();
    const out = [];
    for (const name of await this.#folder.list()) {
      if (!name.startsWith("launch-") || !name.endsWith(".json")) continue;
      const text = await this.#folder.read(name);
      if (text !== undefined) out.push(JSON.parse(text) as { token: Address; poolId: Hex; txHash: Hash; vesting: Address | null; at: number });
    }
    return out.sort((x, y) => x.at - y.at);
  }

  /** Moves `amount` USDG from the buyer vault into the creator vault (what a launch's dev buy and the creator's relayer requests are paid from). */
  async fundCreatorVault(amount: string): Promise<unknown> {
    const creator = await this.#creator.vaultAddress();
    if ((await this.#creator.state()).exists === false) await this.#creator.open();
    return this.#buyer.withdraw(creator, amount);
  }

  /**
   * Launches a token from the creator vault (OstraDevBuy.launchFromVault),
   * with the dev buy when asked: quoted first (the launch must pass now),
   * then the creator vault's DevBuy spend signs exactly that launch.
   */
  async launch(input: LaunchInput): Promise<LaunchResult> {
    const lp = this.#lp();
    if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 64) throw new RangeError("a name is 1..64 characters");
    if (typeof input.symbol !== "string" || !/^[A-Za-z0-9]{1,11}$/.test(input.symbol)) throw new RangeError("a symbol is 1..11 letters and digits");
    if ((input.marketCap === undefined) === (input.startTick === undefined)) throw new RangeError("give the starting marketCap (USDG) or the startTick, one of them");
    const startTick = input.startTick ?? startTickForMarketCap(parseTokenAmount(input.marketCap as string));
    if (!Number.isInteger(startTick) || startTick % LAUNCHPAD.TICK_SPACING !== 0) throw new RangeError(`the start tick must be a multiple of ${LAUNCHPAD.TICK_SPACING}`);

    let creatorState = await this.#creator.state();
    if (!creatorState.exists) {
      await this.#creator.open();
      creatorState = await this.#creator.state();
    }
    const creatorVault = creatorState.vault;
    const p = defaultLaunchParams({
      ...(input.options ?? {}),
      name: input.name,
      symbol: input.symbol,
      salt: bytesToHex(randomBytes(32)),
      quote: this.#usdg(),
      creatorVault,
      startTick,
    });
    const token = getAddress((await this.#client.readContract({ address: lp.devBuy, abi: ostraDevBuyAbi, functionName: "tokenAddressFromVault", args: [p] })) as Address);
    const tokenVault = await this.tokenVault(token).vaultAddress();
    let dev: DevBuyTerms = NO_DEV_BUY;
    if (input.devBuy !== undefined) {
      const quoteIn = parseTokenAmount(input.devBuy.amount);
      if (quoteIn === 0n) throw new RangeError("the dev buy amount must be greater than zero (leave devBuy out for none)");
      const cliff = Math.round((input.devBuy.cliffDays ?? DEV_BUY.MIN_CLIFF / DAY) * DAY);
      const duration = Math.round((input.devBuy.vestingDays ?? 0) * DAY);
      const dividendToken = getAddress(p.dividendToken);
      dev = {
        quoteIn,
        beneficiary: tokenVault,
        // The dividend token is the launched token itself, USDG or another token: the agent's vault of it.
        // (OstraLaunchpad takes "dividends in the token" as its own address: the token does not exist yet.)
        dividendRecipient: dividendToken === zeroAddress ? zeroAddress : dividendToken === lp.launchpad || dividendToken === token ? tokenVault : await this.#vaultFor(dividendToken),
        cliff,
        duration,
      };
      if (creatorState.balance < quoteIn) {
        throw new Error(
          `the creator vault ${creatorVault} holds ${formatTokenAmount(creatorState.balance)}, less than the dev buy of ${input.devBuy.amount}; ` +
            "fund it first with fund_creator_vault (the dev buy plus about 1 USDG for its relayer channel)",
        );
      }
    }
    const q = await quoteVaultLaunch(this.#client, this.#config.deployment, { relayer: await this.#creatorSender.payer(), launch: p, dev });
    const result = await this.#creator.operate({
      gas: (q.gasUsed * 5n) / 4n + LAUNCH_GAS_HEADROOM,
      value: LAUNCHPAD.FEE_WEI,
      moves: dev.quoteIn,
      what: "launch",
      build: async ({ v, keychain, chainId }) => {
        if (dev.quoteIn !== 0n) {
          const balance = await tokenBalance(this.#client, this.#usdg(), creatorVault);
          if (balance < dev.quoteIn) throw new Error(`the creator vault holds ${formatTokenAmount(balance)} now, less than the dev buy; nothing was signed`);
        }
        // Kept before signing: the signed DevBuy only hashes the launch, which is needed to send it again.
        await this.#creator.keepLaunch(v.nonce, p, dev);
        const signed = await signVaultDevBuy(keychain, v, { chainId, devBuy: lp.devBuy, launch: p, dev });
        return [{ to: lp.devBuy, data: launchFromVaultData(p, dev, signed) }];
      },
    });
    if (result.status !== "sent") return result;
    // The launch as it landed (the vesting's address depends on the block's time).
    const receipt = await this.#client.getTransactionReceipt({ hash: result.txHash });
    let poolId: Hex | null = null;
    let bought: { quotePaid: bigint; tokens: bigint; vesting: Address; cliffEnd: bigint; vestingEnd: bigint } | null = null;
    for (const log of receipt.logs) {
      try {
        if (getAddress(log.address) === lp.launchpad) {
          const e = decodeEventLog({ abi: ostraLaunchpadAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
          if (e.eventName === "Launched") poolId = (e.args as unknown as { poolId: Hex }).poolId;
        } else if (getAddress(log.address) === lp.devBuy) {
          const e = decodeEventLog({ abi: ostraDevBuyAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
          if (e.eventName === "DevBought") {
            const g = e.args as unknown as { quotePaid: bigint; tokens: bigint; vesting: Address; cliffEnd: bigint; vestingEnd: bigint };
            bought = { ...g, vesting: getAddress(g.vesting) };
          }
        }
      } catch {
        // another event
      }
    }
    if (poolId === null) throw new Error(`transaction ${result.txHash} landed without the launch`);
    await this.#folder.ensure();
    await this.#folder.write(this.#launchName(token), `${JSON.stringify({ version: 1, token, poolId, txHash: result.txHash, vesting: bought?.vesting ?? null, at: Math.floor(Date.now() / 1000) })}\n`);
    return {
      status: "launched",
      txHash: result.txHash,
      token,
      poolId,
      creatorVault,
      tokenVault,
      devBuy:
        bought === null
          ? null
          : { paid: formatTokenAmount(bought.quotePaid), tokens: formatUnitsAmount(bought.tokens, 18), vesting: bought.vesting, cliffEnd: nowIso(bought.cliffEnd), vestingEnd: nowIso(bought.vestingEnd) },
      note:
        bought === null
          ? "the token is live; the creator vault owns the pool (settings, creator shares, airdrops) and receives the creator payouts"
          : "the token is live; the dev buy's tokens vest to this agent's token vault (vesting_release after the cliff); the creator vault owns the pool and receives the creator payouts",
    };
  }

  /** The pool's creator vault must be this agent's. */
  async #ownPool(tokenText: string): Promise<Pool> {
    const pool = await this.#pool(tokenText);
    const creatorVault = await this.#creator.vaultAddress();
    if (getAddress(pool.config.creatorVault) !== creatorVault) throw new Error(`the pool of ${pool.token} belongs to the creator vault ${pool.config.creatorVault}, not this agent's ${creatorVault}`);
    return pool;
  }

  /**
   * Changes one of the pool's rules (POOL_SETTING_NAMES), only in the
   * traders' favour: lower taxes or anti-snipe, an earlier tax end, a higher
   * max buy or none (0), release_limits 0, volatility_fee 0, max_tx_move
   * looser or 0 (off for good).
   */
  async setPoolSetting(a: { token: string; setting: string; value: string }): Promise<VaultOperationResult> {
    const field = POOL_SETTING_NAMES[a.setting];
    if (field === undefined) throw new RangeError(`unknown setting ${a.setting}; one of ${Object.keys(POOL_SETTING_NAMES).join(", ")}`);
    if (!/^(0|[1-9][0-9]*)$/.test(a.value)) throw new RangeError("the value is a whole number (bps, unix seconds, ticks, or token base units for max_buy)");
    const pool = await this.#ownPool(a.token);
    const params = configurePoolParams({ hook: this.#lp().hook, poolId: pool.id, field, value: BigInt(a.value) });
    return this.#simulatedSpend(this.#creator, this.#creatorSender, VAULT_ACTION.CONFIGURE_POOL, params, "pool setting");
  }

  /** Sets `recipient`'s share (bps; 0 removes it) of the pool's creator payouts; the creator vault keeps the rest. */
  async setCreatorShare(a: { token: string; recipient: string; bps: number }): Promise<VaultOperationResult> {
    if (!Number.isInteger(a.bps) || a.bps < 0 || a.bps > CREATOR_SPLIT.BPS) throw new RangeError(`bps must be 0..${CREATOR_SPLIT.BPS}`);
    const pool = await this.#ownPool(a.token);
    const params = creatorShareParams({ split: this.#lp().creatorSplit, poolId: pool.id, recipient: address(a.recipient, "recipient"), bps: a.bps });
    return this.#simulatedSpend(this.#creator, this.#creatorSender, VAULT_ACTION.CONFIGURE_POOL, params, "creator share");
  }

  /** Pays out what the creator split owes `account` (default: this agent's creator vault) for the pool. */
  async releaseCreatorPayout(a: { token: string; account?: string }): Promise<{ txHash: Hash; account: Address; amount: string }> {
    const lp = this.#lp();
    const pool = await this.#pool(a.token);
    const account = a.account === undefined ? await this.#creator.vaultAddress() : address(a.account, "account");
    const owed = (await this.#client.readContract({ address: lp.creatorSplit, abi: ostraCreatorSplitAbi, functionName: "owedOf", args: [pool.id, account] })) as bigint;
    if (owed === 0n) throw new Error(`the creator split owes ${account} nothing for this pool now`);
    const txHash = await this.#public({ to: lp.creatorSplit, data: encodeFunctionData({ abi: ostraCreatorSplitAbi, functionName: "release", args: [pool.id, account] }) }, "release the creator payout");
    const quote = this.#quoteOf(pool);
    return { txHash, account, amount: formatUnitsAmount(owed, quote === this.#usdg() ? TOKEN_DECIMALS : 18) };
  }

  /** A call anyone may make, sent for the buyer vault (its relayer channel pays). */
  async #public(call: RelayCall, purpose: string): Promise<Hash> {
    await this.#buyer.requireEth(VAULT_SPEND_GAS, purpose, this.#buyerSender);
    return this.#buyerSender.send([call]);
  }

  // ---------------------------------------------------------------------------
  // Airdrops
  // ---------------------------------------------------------------------------

  /** Buys `amount` USDG of the token from the creator vault into OstraAirdrop, for the pool's next round. */
  async airdropFund(a: { token: string; amount: string; slippageBps?: number }): Promise<SwapResult> {
    const lp = this.#lp();
    const pool = await this.#ownPool(a.token);
    if (this.#quoteOf(pool) !== this.#usdg()) throw new Error("this agent funds airdrops of USDG pools");
    const amountIn = parseTokenAmount(a.amount);
    if (amountIn === 0n) throw new RangeError("amount must be greater than zero");
    const s = await this.#creator.state();
    if (s.balance < amountIn) throw new Error(`the creator vault holds ${formatTokenAmount(s.balance)}, less than ${a.amount}; fund it with fund_creator_vault`);
    const usdgIs0 = getAddress(pool.key.currency0) === this.#usdg();
    const q = await quoteVaultSwap(this.#client, this.#config.deployment, {
      vault: s.vault,
      relayer: await this.#creatorSender.payer(),
      swap: { key: pool.key, zeroForOne: usdgIs0, amountIn, recipient: lp.airdrop },
      slippageBps: slippage(a.slippageBps),
    });
    const result = await this.#creator.operate({
      gas: swapSpendGas(q.swap.swapGas),
      moves: amountIn,
      what: "airdrop purchase",
      build: async ({ v, vault, keychain, chainId }) => [spendCall(vault, await signVaultSwap(keychain, v, { chainId, token: this.#usdg(), swap: q.swap }))],
    });
    if (result.status !== "sent") return result;
    const outcome = await this.#swapOutcome(result.txHash, s.vault);
    return {
      status: "sent",
      txHash: result.txHash,
      swapped: outcome.swapped,
      amountIn: formatTokenAmount(outcome.amountIn),
      amountOut: formatUnitsAmount(outcome.amountOut, 18),
      minOut: formatUnitsAmount(q.swap.minOut, 18),
      from: s.vault,
      to: lp.airdrop,
      bandUsedPercent: q.band === null ? null : q.band.usedBps / 100,
    };
  }

  #airdropName(poolId: Hex, round: number): string {
    return `airdrop-${poolId.toLowerCase()}-${round}.json`;
  }

  /**
   * Starts the pool's next airdrop round sharing `entries` (account, amount
   * of the token): the round amount (their total), then the tree's root, two
   * spends of the creator vault. The tree is kept here, so airdrop_claim can
   * send any account's claim.
   */
  async airdropStart(a: { token: string; entries: { account: string; amount: string }[] }): Promise<{ round: number; root: Hex; total: string; accounts: number; endsAt: string; sent: Hash[] }> {
    const lp = this.#lp();
    const pool = await this.#ownPool(a.token);
    const entries = a.entries.map((e) => ({ account: address(e.account, "account"), amount: parseUnitsAmount(e.amount, 18) }));
    const read = <T>(functionName: string, args: readonly unknown[]) => this.#client.readContract({ address: lp.airdrop, abi: ostraAirdropAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
    const current = await read<{ number: number; open: boolean }>("round", [pool.id]);
    if (current.open) throw new Error(`round ${current.number} of this pool is still open; close it after its claim period first`);
    const round = current.number + 1;
    const tree = airdropTree(pool.id, BigInt(round), entries);
    const [available, max, next] = await Promise.all([read<bigint>("available", [pool.id]), read<bigint>("maxRoundAmount", [pool.id]), read<bigint>("nextRoundAmount", [pool.id])]);
    if (tree.total > max) throw new Error(`the round shares ${formatUnitsAmount(tree.total, 18)}, more than a round may hold (${formatUnitsAmount(max, 18)}, ${AIRDROP.MAX_ROUND_BPS / 100}% of the supply)`);
    if (available < tree.total) throw new Error(`OstraAirdrop holds ${formatUnitsAmount(available, 18)} of the token for this pool's rounds, less than ${formatUnitsAmount(tree.total, 18)}; buy more into it with airdrop_fund`);
    await this.#folder.ensure();
    const record = {
      version: 1,
      token: pool.token,
      poolId: pool.id,
      round,
      root: tree.root,
      total: tree.total.toString(),
      claims: [...tree.claims].map(([account, c]) => ({ account, amount: c.amount.toString(), proof: c.proof })),
    };
    await this.#folder.write(this.#airdropName(pool.id, round), `${JSON.stringify(record, null, 2)}\n`);
    const sent: Hash[] = [];
    const step = async (params: Hex, what: string) => {
      const r = await this.#simulatedSpend(this.#creator, this.#creatorSender, VAULT_ACTION.CONFIGURE_POOL, params, what);
      if (r.status !== "sent") throw new Error(`${r.note}; airdrop_start was not finished, call it again with the same entries`);
      sent.push(r.txHash);
    };
    if (next !== tree.total) await step(airdropRoundAmountParams({ airdrop: lp.airdrop, poolId: pool.id, amount: tree.total }), "airdrop round amount");
    await step(startAirdropParams({ airdrop: lp.airdrop, poolId: pool.id, root: tree.root }), "airdrop start");
    const started = await read<{ endsAt: number; number: number }>("round", [pool.id]);
    return { round: started.number, root: tree.root, total: formatUnitsAmount(tree.total, 18), accounts: entries.length, endsAt: nowIso(BigInt(started.endsAt)), sent };
  }

  /** Sends `account`'s claim of the pool's open round (from the tree kept by airdrop_start, or the amount and proof given). */
  async airdropClaim(a: { token: string; account: string; amount?: string; proof?: Hex[] }): Promise<{ txHash: Hash; account: Address; amount: string; round: number }> {
    const lp = this.#lp();
    const pool = await this.#pool(a.token);
    const account = address(a.account, "account");
    const r = (await this.#client.readContract({ address: lp.airdrop, abi: ostraAirdropAbi, functionName: "round", args: [pool.id] })) as { number: number; open: boolean; endsAt: number };
    if (!r.open) throw new Error("the pool has no open airdrop round");
    let amount: bigint;
    let proof: Hex[];
    if (a.amount !== undefined && a.proof !== undefined) {
      amount = parseUnitsAmount(a.amount, 18);
      proof = a.proof;
    } else {
      const text = await this.#folder.read(this.#airdropName(pool.id, r.number));
      if (text === undefined) throw new Error(`no tree of round ${r.number} is kept here; give the amount and proof`);
      const claim = (JSON.parse(text) as { claims: { account: Address; amount: string; proof: Hex[] }[] }).claims.find((c) => getAddress(c.account) === account);
      if (claim === undefined) throw new Error(`${account} is not in round ${r.number}`);
      amount = BigInt(claim.amount);
      proof = claim.proof;
    }
    if ((await this.#client.readContract({ address: lp.airdrop, abi: ostraAirdropAbi, functionName: "claimed", args: [pool.id, BigInt(r.number), account] })) as boolean) {
      throw new Error(`${account} has claimed round ${r.number} already`);
    }
    const txHash = await this.#public({ to: lp.airdrop, data: encodeFunctionData({ abi: ostraAirdropAbi, functionName: "claim", args: [pool.id, account, amount, proof] }) }, "send the airdrop claim");
    return { txHash, account, amount: formatUnitsAmount(amount, 18), round: r.number };
  }

  /** Closes the pool's round once its claim period is over (what was not claimed is burned). */
  async airdropClose(tokenText: string): Promise<{ txHash: Hash; round: number; burned: string }> {
    const lp = this.#lp();
    const pool = await this.#pool(tokenText);
    const r = (await this.#client.readContract({ address: lp.airdrop, abi: ostraAirdropAbi, functionName: "round", args: [pool.id] })) as { number: number; open: boolean; endsAt: number; amount: bigint; claimed: bigint };
    if (!r.open) throw new Error("the pool has no open airdrop round");
    const head = await this.#client.getBlock({ blockTag: "latest" });
    if (head.timestamp < BigInt(r.endsAt)) throw new Error(`round ${r.number} can be closed from ${nowIso(BigInt(r.endsAt))}`);
    const txHash = await this.#public({ to: lp.airdrop, data: encodeFunctionData({ abi: ostraAirdropAbi, functionName: "close", args: [pool.id] }) }, "close the airdrop round");
    return { txHash, round: r.number, burned: formatUnitsAmount(r.amount - r.claimed, 18) };
  }

  // ---------------------------------------------------------------------------
  // Vesting and referrals
  // ---------------------------------------------------------------------------

  /** The dev buy vesting of `tokenText`: the one given, else the one this agent's launch made. */
  async #vesting(tokenText: string, vestingText?: string): Promise<Address> {
    const lp = this.#lp();
    let vesting: Address;
    if (vestingText !== undefined) vesting = address(vestingText, "vesting");
    else {
      const token = address(tokenText, "token");
      const text = await this.#folder.read(this.#launchName(token));
      const v = text === undefined ? null : ((JSON.parse(text) as { vesting: Address | null }).vesting ?? null);
      if (v === null) throw new Error(`this agent's records hold no dev buy vesting of ${token}; give its address`);
      vesting = getAddress(v);
    }
    const id = (await this.#client.readContract({ address: lp.devBuy, abi: ostraDevBuyAbi, functionName: "vestingPool", args: [vesting] })) as Hex;
    if (BigInt(id) === 0n) throw new Error(`${vesting} is not an Ostra dev buy's vesting`);
    return vesting;
  }

  /** The vesting's schedule, what it holds and what it can release now. */
  async vestingInfo(a: { token: string; vesting?: string }): Promise<{ vesting: Address; beneficiary: Address; cliffEnd: string; end: string; held: string; releasable: string }> {
    const vesting = await this.#vesting(a.token, a.vesting);
    const read = <T>(functionName: string) => this.#client.readContract({ address: vesting, abi: ostraVestingAbi, functionName: functionName as never }) as Promise<T>;
    const [terms, schedule, releasable] = await Promise.all([read<{ token: Address; beneficiary: Address }>("terms"), read<readonly [bigint, bigint]>("schedule"), read<bigint>("releasable")]);
    const held = await tokenBalance(this.#client, getAddress(terms.token), vesting);
    return { vesting, beneficiary: getAddress(terms.beneficiary), cliffEnd: nowIso(schedule[0]), end: nowIso(schedule[1]), held: formatUnitsAmount(held, 18), releasable: formatUnitsAmount(releasable, 18) };
  }

  /** Releases what the vesting has vested to its beneficiary (this agent's token vault). */
  async vestingRelease(a: { token: string; vesting?: string }): Promise<{ txHash: Hash; amount: string }> {
    const vesting = await this.#vesting(a.token, a.vesting);
    const releasable = (await this.#client.readContract({ address: vesting, abi: ostraVestingAbi, functionName: "releasable" })) as bigint;
    if (releasable === 0n) throw new Error("nothing has vested beyond what was released; the cliff may not be over yet");
    const txHash = await this.#public({ to: vesting, data: encodeFunctionData({ abi: ostraVestingAbi, functionName: "release" }) }, "release the vesting");
    return { txHash, amount: formatUnitsAmount(releasable, 18) };
  }

  /** Claims the dividends the vesting's tokens earned, to its dividend recipient. */
  async vestingClaimDividends(a: { token: string; vesting?: string }): Promise<{ txHash: Hash }> {
    const vesting = await this.#vesting(a.token, a.vesting);
    const txHash = await this.#public({ to: vesting, data: encodeFunctionData({ abi: ostraVestingAbi, functionName: "claimDividends" }) }, "claim the vesting's dividends");
    return { txHash };
  }

  /** Claims what swaps that named `referrer` (default: this agent's buyer vault) earned it, in USDG. */
  async claimReferral(a: { referrer?: string } = {}): Promise<{ txHash: Hash; referrer: Address; amount: string }> {
    const lp = this.#lp();
    const referrer = a.referrer === undefined ? await this.#buyer.vaultAddress() : address(a.referrer, "referrer");
    const owed = (await this.#client.readContract({ address: lp.hook, abi: ostraHookAbi, functionName: "referralOwed", args: [referrer, this.#usdg()] })) as bigint;
    if (owed === 0n) throw new Error(`${referrer} has no referral earnings in USDG to claim`);
    const txHash = await this.#public({ to: lp.dispatcher, data: encodeFunctionData({ abi: ostraDispatcherAbi, functionName: "claimReferral", args: [referrer, this.#usdg()] }) }, "claim the referral earnings");
    return { txHash, referrer, amount: formatTokenAmount(owed) };
  }
}
