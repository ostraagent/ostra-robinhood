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
//   * the creator vault launches. For a USDG pool it is the USDG creator vault
//     (its own records and relayer client); for a pool paired with a stock
//     token or ETH (pairs.ts: the only pairs offered), the creator vault in
//     that token (WETH for ETH), keychain creatorKeychainId(chain, token), its
//     requests paid by the buyer vault (`payer`) like a token vault's. Each
//     one:
//     OstraDevBuy.launchFromVault with one DevBuy spend (action 9) that pays
//     the dev buy from the vault inside the launch it signed; the relayer
//     fronts the 0.0002 ETH launch fee and charges it in USDG. The dev buy's
//     tokens vest to the creator's token vault. The creator vault also owns
//     the pool: settings (only in the traders' favour), creator shares,
//     airdrop rounds (it buys the round into OstraAirdrop, then sets the
//     amount and starts it with the tree's root), and it receives the
//     creator payouts (OstraCreatorSplit.release).
// Trading a pool paired with a stock token pays from (buys) and into (sells)
// the agent's token vault of that stock token; a pool paired with ETH is not
// traded from a vault (a vault holds one ERC-20; an ETH pool takes native ETH),
// only from a wallet (wallet-swap.ts). A launch's market cap is given in US
// dollars and set in the pair's token at its price now (pairs.ts: USDG one
// dollar, ETH and stocks from Chainlink).
//
// Public calls (airdrop claim and close, vesting release and dividends,
// referral claims, split releases) are sent for the buyer vault as payer.
//
// Records, in the agent's `launchpad` folder (no secrets):
//   launch-<token>.json        a launch this agent made: pool, vesting, tx
//   airdrop-<pool>-<round>.json the round's entries and proofs, so claims
//                              can be sent for any of its accounts
//   agent.json                 the ERC-8004 identity the creator vault registered
//   token-index.json           every Ostra launch read from the launchpad's
//                              Launched events so far, and the block read up to
//
// The creator vault is also the agent's public identity (vault version 2): it
// sets the agent's profile in OstraRegistry, registers the agent in the
// ERC-8004 Identity Registry (owning the identity and receiving as its
// agentWallet), and sets the metadata of the tokens it launched; a token's
// page links to its creator's profile through the pool's creator vault.

import { bytesToHex, decodeEventLog, encodeFunctionData, getAddress, isAddress, parseAbiItem, zeroAddress, type Address, type Hash, type Hex, type PublicClient, type Transport } from "viem";
import {
  AIRDROP,
  CREATOR_SPLIT,
  WETH,
  DEV_BUY,
  LAUNCHPAD,
  NO_DEV_BUY,
  POOL_SETTING,
  QUOTE_DEFAULT_SLIPPAGE_BPS,
  VAULT_ACTION,
  VAULT_SWAP_GAS_RESERVE,
  VAULT_VERSION,
  LAUNCH_PAIRS,
  airdropRoundAmountParams,
  findLaunchPair,
  launchPair,
  quoteUnitsToUsd,
  readPairUsdPrice,
  usdToQuoteUnits,
  airdropTree,
  checkUri,
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
  ostraRegistryAbi,
  ostraTokenAbi,
  ostraVaultAbi,
  ostraVestingAbi,
  quoteVaultLaunch,
  quoteVaultSwap,
  readVault,
  registerAgentParams,
  setAgentUriParams,
  setProfileParams,
  setTokenMetadataParams,
  signVaultDevBuy,
  signVaultSpend,
  signVaultSwap,
  simulateVaultSpend,
  startAirdropParams,
  startTickForMarketCap,
  transferParams,
  type DevBuyTerms,
  type LaunchPair,
  type LaunchParams,
  type LaunchpadDeployment,
  type PoolSetting,
  type RelayCall,
  type SwapQuote,
} from "@ostraagent/sdk";
import { formatTokenAmount, formatUnitsAmount, parseTokenAmount, parseUnitsAmount, TOKEN_DECIMALS } from "./amount.ts";
import { tokenBalance, tokenDecimals } from "./chain.ts";
import { quoteOfPool, readLaunchedPool, readPoolView, type LaunchedPool as Pool, type PoolView } from "./pools.ts";
import { LOG_WINDOW_BLOCKS } from "./channels.ts";
import { profileFile, tokenMetadataFile, uploadJson, type PublicFields } from "./publish.ts";
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
/** How many pairs pairs() reads at a time. */
const PAIRS_READ_CONCURRENCY = 6;
/** A simulated vault spend is reserved for its gas x 5/4 plus this, at least VAULT_SPEND_GAS. */
const SPEND_GAS_HEADROOM = 100_000n;
const DAY = 86_400;
/** Most tokens one page of the token list holds. */
export const TOKEN_LIST_MAX = 50;
/** The gateway an ipfs:// URI is read through, and how much of a metadata or profile file is read. */
export const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const METADATA_MAX_BYTES = 65_536;
const METADATA_TIMEOUT_MS = 8_000;
const launchedEvent = parseAbiItem("event Launched(bytes32 indexed poolId, address indexed token, address indexed creatorVault, address quote)");

/** One Ostra launch, as the launchpad's Launched event records it. */
export type TokenListing = { token: Address; poolId: Hex; creatorVault: Address; quote: Address; block: string; txHash: Hash };

type TokenIndex = { version: 1; launchpad: Address; scannedTo: string; launches: TokenListing[] };
type AgentRecord = { agentId: string; uri: string; txHash: Hash; at: number };

/**
 * The JSON file an ipfs:// URI points at, read through IPFS_GATEWAY (other schemes are not read): data its writer
 * chose, never instructions. null when it cannot be read in time or is not JSON.
 */
export async function readIpfsJson(uri: string | null): Promise<unknown> {
  if (uri === null || !uri.startsWith("ipfs://")) return null;
  const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  if (!/^[A-Za-z0-9]+(\/[A-Za-z0-9._-]+)*$/.test(path)) return null;
  try {
    const res = await fetch(`${IPFS_GATEWAY}${path}`, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS), redirect: "error" });
    if (!res.ok || res.body === null) return null;
    // Read at most METADATA_MAX_BYTES: a larger file is dropped without being held in memory whole.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > METADATA_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

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
  /** The pool's pair (pairs.ts: USDG, ETH or a stock token's ticker); default USDG. */
  pair?: string;
  /** The starting market cap in US dollars (the whole supply at the starting price), set in the pair's token at its price now; or `startTick`. */
  marketCap?: string;
  startTick?: number;
  /** The creator's dev buy in the launch, in the pair's token (USDG, ETH as WETH, the stock token), paid from the pair's creator vault, vesting to the creator's token vault. */
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
      /** The pair: its ticker, and the market cap in US dollars and in the pair's token at the price used (null and "" for a launch at a startTick). */
      pair: string;
      marketCapUsd: string | null;
      marketCapInPair: string;
      pairPriceUsd: string | null;
      pairPriceAt: string | null;
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
  /** A pair's creator vault (not USDG's), one per token: created once, so its operations share one queue. */
  readonly #pairCreators = new Map<Address, Promise<VaultService>>();

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

  /**
   * Refuses to pay `paid` to an Ostra vault (of this deployment) in another
   * token: a vault only ever moves its own token, so what it is paid in
   * another stays there for good. A vault not created yet cannot be told
   * from any other address.
   */
  async #notStranded(to: Address, paid: Address, what: string): Promise<void> {
    const v = await readVault(this.#client, this.#config.deployment, to);
    if (v !== null && v.token !== getAddress(paid)) {
      throw new Error(`${to} is an Ostra vault in ${v.token}: a vault only moves its own token, so ${what} in ${getAddress(paid)} would be stuck there for good; nothing was signed`);
    }
  }

  /** The token a pair's vaults hold: the pair's own; WETH for ETH. */
  #pairToken(pair: LaunchPair): Address {
    return pair.kind === "eth" ? WETH : pair.address;
  }

  /**
   * The agent's creator vault for `pairText` and the sender of its operations:
   * for USDG the USDG creator vault and its own relayer client; for a stock
   * token or ETH, the creator vault in that token (WETH for ETH), paid for by
   * the buyer vault.
   */
  async pairCreator(pairText: string): Promise<{ pair: LaunchPair; vault: VaultService; sender: Sender }> {
    const pair = launchPair(pairText);
    if (pair.kind === "usdg") return { pair, vault: this.#creator, sender: this.#creatorSender };
    const token = this.#pairToken(pair);
    let made = this.#pairCreators.get(token);
    if (made === undefined) {
      made = this.#keys.forCreatorVault(this.#config.chainId, token).then((keys) => new VaultService(this.#client, this.#transport, this.#config, keys, this.#buyerSender, "creator", null, token));
      this.#pairCreators.set(token, made);
      // A failure (its records' folder, say) is not kept: the next call tries again.
      made.catch(() => {
        if (this.#pairCreators.get(token) === made) this.#pairCreators.delete(token);
      });
    }
    return { pair, vault: await made, sender: this.#buyerSender };
  }

  /**
   * The pairs a launch can take, with this agent's vaults for each: its
   * creator vault (what a launch's dev buy is paid from) and its vault of the
   * pair's token (what it buys that pair's pools with); with `prices`, each
   * pair's USD price now.
   */
  async pairs(a: { prices?: boolean } = {}): Promise<
    {
      symbol: string;
      name: string;
      kind: LaunchPair["kind"];
      token: Address;
      decimals: number;
      creatorVault: Address;
      creatorBalance: string;
      tradingVault: Address | null;
      priceUsd?: string | null;
      priceAt?: string | null;
    }[]
  > {
    type Row = Awaited<ReturnType<LaunchpadService["pairs"]>>[number];
    // Each pair's reads are independent: six pairs at a time, the rows in the list's order (measured 19 Oct 2026 on
    // mainnet: 0.4 s through an archive RPC, 6.6 s through the public RPC).
    const out: Row[] = new Array(LAUNCH_PAIRS.length);
    let next = 0;
    const worker = async () => {
      while (next < LAUNCH_PAIRS.length) {
        const i = next++;
        out[i] = await this.#pairRow(LAUNCH_PAIRS[i] as LaunchPair, a.prices === true);
      }
    };
    await Promise.all(Array.from({ length: PAIRS_READ_CONCURRENCY }, worker));
    return out;
  }

  /** One row of pairs(). */
  async #pairRow(pair: LaunchPair, prices: boolean): Promise<Awaited<ReturnType<LaunchpadService["pairs"]>>[number]> {
    const { vault } = await this.pairCreator(pair.symbol);
    const s = await vault.state();
    const token = this.#pairToken(pair);
    const row: Awaited<ReturnType<LaunchpadService["pairs"]>>[number] = {
      symbol: pair.symbol,
      name: pair.name,
      kind: pair.kind,
      token: pair.address,
      decimals: pair.decimals,
      creatorVault: s.vault,
      creatorBalance: formatUnitsAmount(s.balance, pair.decimals),
      tradingVault: pair.kind === "eth" ? null : await this.tokenVault(token).vaultAddress(),
    };
    if (prices) {
      try {
        const price = await readPairUsdPrice(this.#client, pair);
        row.priceUsd = formatUnitsAmount(price.priceE8, 8);
        row.priceAt = new Date(price.updatedAt * 1000).toISOString();
      } catch {
        row.priceUsd = null;
        row.priceAt = null;
      }
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** The pool of `tokenText`, a token the Ostra launchpad launched. */
  #pool(tokenText: string): Promise<Pool> {
    return readLaunchedPool(this.#client, this.#lp(), tokenText);
  }

  /** The pool's quote currency (address(0): ETH). */
  #quoteOf(pool: Pool): Address {
    return quoteOfPool(pool);
  }

  /** A launched token's pool: price, rules, circuit breaker, airdrop round and creator shares. */
  poolInfo(tokenText: string): Promise<PoolView> {
    return readPoolView(this.#client, this.#lp(), tokenText);
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
    if (quote === zeroAddress) {
      throw new Error(`the pool of ${pool.token} trades against ETH: an Ostra vault holds one ERC-20 and cannot pay or take native ETH, so this pool is traded from a wallet; nothing was signed`);
    }
    const pair = findLaunchPair(quote);
    if (pair === null) throw new Error(`the pool of ${pool.token} trades against ${quote}, not a pair Ostra offers (USDG, ETH or a listed stock token); nothing was signed`);
    const referrer = a.referrer === undefined ? undefined : address(a.referrer, "referrer");
    const quoteIs0 = getAddress(pool.key.currency0) === quote;
    const buying = a.side === "buy";
    // The vault of the pool's pair pays a buy and takes a sale: the buyer vault for USDG, else the token vault of the stock token.
    const quoteVault = this.tokenVault(quote);
    const from = buying ? quoteVault : this.tokenVault(pool.token);
    const fromVault = await from.vaultAddress();
    const to = buying ? await this.tokenVault(pool.token).vaultAddress() : await quoteVault.vaultAddress();
    const amountIn = buying ? parseUnitsAmount(a.amount, pair.decimals) : parseUnitsAmount(a.amount, 18);
    if (amountIn === 0n) throw new RangeError("amount must be greater than zero");
    const state = await from.state();
    if (!state.exists && from === this.#buyer) throw new Error("this agent has no vault yet; call open_vault first");
    if (state.balance < amountIn) {
      const what = from === this.#buyer ? "vault" : `vault in ${buying ? pair.symbol : pool.token}`;
      throw new Error(`the ${what} holds ${formatUnitsAmount(state.balance, buying ? pair.decimals : 18)}, less than ${a.amount}`);
    }
    const sender = this.#buyerSender;
    // A token vault that holds tokens but was never created (they were sent to its address) is created first, paid by the buyer vault.
    if (!state.exists) {
      if (!create) throw new Error(`the vault in ${buying ? pair.symbol : pool.token} holds tokens but is not created yet; ${a.side} creates it, then quotes`);
      await from.open();
    }
    const q = await quoteVaultSwap(this.#client, this.#config.deployment, {
      vault: fromVault,
      relayer: await sender.payer(),
      swap: { key: pool.key, zeroForOne: buying ? quoteIs0 : !quoteIs0, amountIn, recipient: to, ...(referrer === undefined ? {} : { referrer }) },
      slippageBps: slippage(a.slippageBps),
    });
    return { q, pool, from, fromVault, to, inDecimals: buying ? pair.decimals : 18, outDecimals: buying ? 18 : pair.decimals, sender };
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

  /** Buys `token` with `amount` of its pool's pair (USDG from the buyer vault, a stock token from its token vault), into the agent's token vault. */
  buy(a: { token: string; amount: string; slippageBps?: number; referrer?: string }): Promise<SwapResult> {
    return this.#swap({ ...a, side: "buy" });
  }

  /** Sells `amount` of `token` from the agent's token vault for its pool's pair, into the agent's vault of the pair (the buyer vault for USDG). */
  sell(a: { token: string; amount: string; slippageBps?: number; referrer?: string }): Promise<SwapResult> {
    return this.#swap({ ...a, side: "sell" });
  }

  async #swap(a: { side: "buy" | "sell"; token: string; amount: string; slippageBps?: number; referrer?: string }): Promise<SwapResult> {
    const { q, pool, from, fromVault, to, inDecimals, outDecimals } = await this.#swapQuote(a, true);
    const buying = a.side === "buy";
    const tokenVault = this.tokenVault(pool.token);
    const createTokenVault = buying && !(await tokenVault.state()).exists;
    const inToken = buying ? this.#quoteOf(pool) : pool.token;
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
    await this.#notStranded(destination, token, "the transfer");
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

  /**
   * Moves `amount` into the creator vault of `pairText` (default USDG): USDG
   * from the buyer vault (a launch's dev buy and the USDG creator vault's
   * relayer requests are paid from it); a stock token or WETH from the
   * agent's token vault of it (what a dev buy in that pair is paid from). The
   * creator vault is created first when it does not exist yet.
   */
  async fundCreatorVault(amount: string, pairText = "USDG"): Promise<unknown> {
    const { pair, vault: creator } = await this.pairCreator(pairText);
    const to = await creator.vaultAddress();
    if (pair.kind === "usdg") {
      if ((await creator.state()).exists === false) await creator.open();
      return this.#buyer.withdraw(to, amount);
    }
    const units = parseUnitsAmount(amount, pair.decimals);
    if (units === 0n) throw new RangeError("amount must be greater than zero");
    const token = this.#pairToken(pair);
    const from = this.tokenVault(token);
    const s = await from.state();
    const tokenName = pair.kind === "eth" ? "WETH" : pair.symbol;
    if (s.balance < units) {
      throw new Error(
        `this agent's vault in ${tokenName} (${s.vault}) holds ${formatUnitsAmount(s.balance, pair.decimals)}, less than ${amount}; ` +
          `send ${tokenName} to it, or straight to the ${pair.symbol} creator vault ${to}; nothing was signed`,
      );
    }
    if (!s.exists) await from.open();
    if ((await creator.state()).exists === false) await creator.open();
    return this.#simulatedSpend(from, this.#buyerSender, VAULT_ACTION.TRANSFER, transferParams({ to, amount: units }), `${tokenName} transfer to the ${pair.symbol} creator vault`);
  }

  /** Sends `amount` from the creator vault of `pair` (default USDG) to `destination` (default: the agent's vault of that token; for ETH, required). */
  async creatorWithdraw(a: { amount: string; destination?: string; pair?: string }): Promise<unknown> {
    const { pair, vault: creator, sender } = await this.pairCreator(a.pair ?? "USDG");
    const token = this.#pairToken(pair);
    if (pair.kind !== "usdg" && pair.kind !== "stock" && a.destination === undefined) throw new RangeError(`a ${pair.symbol} creator vault holds WETH: name the destination`);
    const destination = a.destination === undefined ? await this.tokenVault(token).vaultAddress() : address(a.destination, "destination");
    await this.#notStranded(destination, token, `the ${pair.symbol} creator vault's transfer`);
    if (pair.kind === "usdg") return creator.withdraw(destination, a.amount);
    if (destination === zeroAddress) throw new RangeError("the destination must not be the zero address");
    const units = parseUnitsAmount(a.amount, pair.decimals);
    if (units === 0n) throw new RangeError("amount must be greater than zero");
    const s = await creator.state();
    if (!s.exists) throw new Error(`this agent has no ${pair.symbol} creator vault yet`);
    if (destination === s.vault) throw new Error("the destination is the vault itself");
    if (s.balance < units) throw new Error(`the ${pair.symbol} creator vault holds ${formatUnitsAmount(s.balance, pair.decimals)}, less than ${a.amount}`);
    return this.#simulatedSpend(creator, sender, VAULT_ACTION.TRANSFER, transferParams({ to: destination, amount: units }), `${pair.symbol} creator vault transfer`);
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
    if ((input.marketCap === undefined) === (input.startTick === undefined)) throw new RangeError("give the starting marketCap (US dollars) or the startTick, one of them");
    const { pair, vault: creator, sender } = await this.pairCreator(input.pair ?? "USDG");
    // The market cap in US dollars, in the pair's token at its price now (USDG: one dollar); a launch at a startTick needs no price.
    const marketCapUsd = input.marketCap === undefined ? null : parseTokenAmount(input.marketCap);
    const price = marketCapUsd === null ? null : await readPairUsdPrice(this.#client, pair);
    const marketCapUnits = marketCapUsd === null || price === null ? null : usdToQuoteUnits(marketCapUsd, price.priceE8, pair.decimals);
    if (marketCapUnits === 0n) throw new RangeError(`a market cap of ${input.marketCap} USD is less than one base unit of ${pair.symbol}`);
    const startTick = input.startTick ?? startTickForMarketCap(marketCapUnits as bigint);
    if (!Number.isInteger(startTick) || startTick % LAUNCHPAD.TICK_SPACING !== 0) throw new RangeError(`the start tick must be a multiple of ${LAUNCHPAD.TICK_SPACING}`);
    const vaultToken = this.#pairToken(pair);
    const pairUnits = (x: bigint) => formatUnitsAmount(x, pair.decimals);

    let creatorState = await creator.state();
    if (!creatorState.exists) {
      await creator.open();
      creatorState = await creator.state();
    }
    const creatorVault = creatorState.vault;
    const p = defaultLaunchParams({
      ...(input.options ?? {}),
      name: input.name,
      symbol: input.symbol,
      salt: bytesToHex(randomBytes(32)),
      quote: pair.address,
      creatorVault,
      startTick,
    });
    const token = getAddress((await this.#client.readContract({ address: lp.devBuy, abi: ostraDevBuyAbi, functionName: "tokenAddressFromVault", args: [p] })) as Address);
    const tokenVault = await this.tokenVault(token).vaultAddress();
    let dev: DevBuyTerms = NO_DEV_BUY;
    if (input.devBuy !== undefined) {
      const quoteIn = parseUnitsAmount(input.devBuy.amount, pair.decimals);
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
          `the ${pair.symbol} creator vault ${creatorVault} holds ${pairUnits(creatorState.balance)}, less than the dev buy of ${input.devBuy.amount}; ` +
            (pair.kind === "usdg"
              ? "fund it first with fund_creator_vault (the dev buy plus about 1 USDG for its relayer channel)"
              : `fund it first with fund_creator_vault (pair ${pair.symbol}), or send ${pair.kind === "eth" ? "WETH" : pair.symbol} straight to it`),
        );
      }
    }
    const q = await quoteVaultLaunch(this.#client, this.#config.deployment, { relayer: await sender.payer(), launch: p, dev });
    const result = await creator.operate({
      gas: (q.gasUsed * 5n) / 4n + LAUNCH_GAS_HEADROOM,
      value: LAUNCHPAD.FEE_WEI,
      moves: dev.quoteIn,
      what: "launch",
      build: async ({ v, keychain, chainId }) => {
        if (dev.quoteIn !== 0n) {
          const balance = await tokenBalance(this.#client, vaultToken, creatorVault);
          if (balance < dev.quoteIn) throw new Error(`the creator vault holds ${pairUnits(balance)} now, less than the dev buy; nothing was signed`);
        }
        // Kept before signing: the signed DevBuy only hashes the launch, which is needed to send it again.
        await creator.keepLaunch(v.nonce, p, dev);
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
    await this.#folder.write(this.#launchName(token), `${JSON.stringify({ version: 1, token, poolId, txHash: result.txHash, vesting: bought?.vesting ?? null, pair: pair.symbol, creatorVault, at: Math.floor(Date.now() / 1000) })}\n`);
    return {
      status: "launched",
      txHash: result.txHash,
      token,
      poolId,
      creatorVault,
      tokenVault,
      pair: pair.symbol,
      marketCapUsd: marketCapUsd === null ? null : formatTokenAmount(marketCapUsd),
      marketCapInPair: marketCapUnits === null ? "" : pairUnits(marketCapUnits),
      pairPriceUsd: price === null ? null : formatUnitsAmount(price.priceE8, 8),
      pairPriceAt: price === null ? null : new Date(price.updatedAt * 1000).toISOString(),
      devBuy:
        bought === null
          ? null
          : { paid: pairUnits(bought.quotePaid), tokens: formatUnitsAmount(bought.tokens, 18), vesting: bought.vesting, cliffEnd: nowIso(bought.cliffEnd), vestingEnd: nowIso(bought.vestingEnd) },
      note:
        (bought === null
          ? `the token is live; the ${pair.symbol} creator vault owns the pool (settings, creator shares, airdrops) and receives the creator payouts`
          : `the token is live; the dev buy's tokens vest to this agent's token vault (vesting_release after the cliff); the ${pair.symbol} creator vault owns the pool and receives the creator payouts`) +
        (pair.kind === "usdg" ? "" : `, in ${pair.kind === "eth" ? "WETH" : pair.symbol}; publish_profile again shows this agent's profile on the pool`),
    };
  }

  /** The pool's pair (null: a quote Ostra does not offer). */
  #pairOf(pool: Pool): LaunchPair | null {
    return findLaunchPair(this.#quoteOf(pool));
  }

  /** The pool's creator vault must be this agent's creator vault of the pool's pair: the pool, that vault and its sender. */
  async #ownPool(tokenText: string): Promise<{ pool: Pool; pair: LaunchPair; creator: VaultService; sender: Sender }> {
    const pool = await this.#pool(tokenText);
    const pair = this.#pairOf(pool);
    if (pair === null) throw new Error(`the pool of ${pool.token} trades against ${this.#quoteOf(pool)}, not a pair Ostra offers; no creator vault of this agent owns it`);
    const { vault: creator, sender } = await this.pairCreator(pair.symbol);
    const creatorVault = await creator.vaultAddress();
    if (getAddress(pool.config.creatorVault) !== creatorVault) throw new Error(`the pool of ${pool.token} belongs to the creator vault ${pool.config.creatorVault}, not this agent's ${pair.symbol} creator vault ${creatorVault}`);
    return { pool, pair, creator, sender };
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
    const { pool, creator, sender } = await this.#ownPool(a.token);
    const params = configurePoolParams({ hook: this.#lp().hook, poolId: pool.id, field, value: BigInt(a.value) });
    return this.#simulatedSpend(creator, sender, VAULT_ACTION.CONFIGURE_POOL, params, "pool setting");
  }

  /** Sets `recipient`'s share (bps; 0 removes it) of the pool's creator payouts; the creator vault keeps the rest. */
  async setCreatorShare(a: { token: string; recipient: string; bps: number }): Promise<VaultOperationResult> {
    if (!Number.isInteger(a.bps) || a.bps < 0 || a.bps > CREATOR_SPLIT.BPS) throw new RangeError(`bps must be 0..${CREATOR_SPLIT.BPS}`);
    const { pool, creator, sender } = await this.#ownPool(a.token);
    const params = creatorShareParams({ split: this.#lp().creatorSplit, poolId: pool.id, recipient: address(a.recipient, "recipient"), bps: a.bps });
    return this.#simulatedSpend(creator, sender, VAULT_ACTION.CONFIGURE_POOL, params, "creator share");
  }

  /** Pays out what the creator split owes `account` (default: this agent's creator vault of the pool's pair) for the pool. */
  async releaseCreatorPayout(a: { token: string; account?: string }): Promise<{ txHash: Hash; account: Address; amount: string }> {
    const lp = this.#lp();
    const pool = await this.#pool(a.token);
    const pair = this.#pairOf(pool);
    const own = pair === null ? this.#creator : (await this.pairCreator(pair.symbol)).vault;
    const account = a.account === undefined ? await own.vaultAddress() : address(a.account, "account");
    const owed = (await this.#client.readContract({ address: lp.creatorSplit, abi: ostraCreatorSplitAbi, functionName: "owedOf", args: [pool.id, account] })) as bigint;
    if (owed === 0n) throw new Error(`the creator split owes ${account} nothing for this pool now`);
    const txHash = await this.#public({ to: lp.creatorSplit, data: encodeFunctionData({ abi: ostraCreatorSplitAbi, functionName: "release", args: [pool.id, account] }) }, "release the creator payout");
    return { txHash, account, amount: formatUnitsAmount(owed, pair === null ? await tokenDecimals(this.#client, this.#quoteOf(pool)) : pair.decimals) };
  }

  /** A call anyone may make, sent for the buyer vault (its relayer channel pays). */
  async #public(call: RelayCall, purpose: string): Promise<Hash> {
    await this.#buyer.requireEth(VAULT_SPEND_GAS, purpose, this.#buyerSender);
    return this.#buyerSender.send([call]);
  }

  // ---------------------------------------------------------------------------
  // Airdrops
  // ---------------------------------------------------------------------------

  /** Buys `amount` of the pool's pair worth of the token from its creator vault into OstraAirdrop, for the pool's next round (USDG and stock pools). */
  async airdropFund(a: { token: string; amount: string; slippageBps?: number }): Promise<SwapResult> {
    const lp = this.#lp();
    const { pool, pair, creator, sender } = await this.#ownPool(a.token);
    if (pair.kind === "eth") throw new Error("an ETH pool's airdrop is bought from a wallet: a vault cannot pay native ETH; nothing was signed");
    const amountIn = parseUnitsAmount(a.amount, pair.decimals);
    if (amountIn === 0n) throw new RangeError("amount must be greater than zero");
    const s = await creator.state();
    if (s.balance < amountIn) throw new Error(`the ${pair.symbol} creator vault holds ${formatUnitsAmount(s.balance, pair.decimals)}, less than ${a.amount}; fund it with fund_creator_vault`);
    const quoteIs0 = getAddress(pool.key.currency0) === pair.address;
    const q = await quoteVaultSwap(this.#client, this.#config.deployment, {
      vault: s.vault,
      relayer: await sender.payer(),
      swap: { key: pool.key, zeroForOne: quoteIs0, amountIn, recipient: lp.airdrop },
      slippageBps: slippage(a.slippageBps),
    });
    const result = await creator.operate({
      gas: swapSpendGas(q.swap.swapGas),
      moves: amountIn,
      what: "airdrop purchase",
      build: async ({ v, vault, keychain, chainId }) => [spendCall(vault, await signVaultSwap(keychain, v, { chainId, token: pair.address, swap: q.swap }))],
    });
    if (result.status !== "sent") return result;
    const outcome = await this.#swapOutcome(result.txHash, s.vault);
    return {
      status: "sent",
      txHash: result.txHash,
      swapped: outcome.swapped,
      amountIn: formatUnitsAmount(outcome.amountIn, pair.decimals),
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
    const { pool, creator, sender } = await this.#ownPool(a.token);
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
      const r = await this.#simulatedSpend(creator, sender, VAULT_ACTION.CONFIGURE_POOL, params, what);
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

  /** Claims what swaps that named `referrer` earned it in the pair `pair` (default USDG; referrer default: this agent's vault of that token), paid in that token (WETH for ETH). */
  async claimReferral(a: { referrer?: string; pair?: string } = {}): Promise<{ txHash: Hash; referrer: Address; amount: string; pair: string }> {
    const lp = this.#lp();
    const pair = launchPair(a.pair ?? "USDG");
    if (pair.kind === "eth" && a.referrer === undefined) throw new RangeError("ETH referral earnings are paid in WETH: name the referrer they are owed to");
    const referrer = a.referrer === undefined ? await this.tokenVault(pair.address).vaultAddress() : address(a.referrer, "referrer");
    await this.#notStranded(referrer, this.#pairToken(pair), "the referral earnings");
    const owed = (await this.#client.readContract({ address: lp.hook, abi: ostraHookAbi, functionName: "referralOwed", args: [referrer, pair.address] })) as bigint;
    if (owed === 0n) throw new Error(`${referrer} has no referral earnings in ${pair.symbol} to claim`);
    const txHash = await this.#public({ to: lp.dispatcher, data: encodeFunctionData({ abi: ostraDispatcherAbi, functionName: "claimReferral", args: [referrer, pair.address] }) }, "claim the referral earnings");
    return { txHash, referrer, amount: formatUnitsAmount(owed, pair.decimals), pair: pair.symbol };
  }

  // ---------------------------------------------------------------------------
  // The token list (every Ostra launch, for any buyer)
  // ---------------------------------------------------------------------------

  /** Reads the launchpad's Launched events past the indexed block into token-index.json and returns the index. */
  async #tokenIndex(): Promise<TokenIndex> {
    const lp = this.#lp();
    await this.#folder.ensure();
    const text = await this.#folder.read("token-index.json");
    let index: TokenIndex = text === undefined ? { version: 1, launchpad: lp.launchpad, scannedTo: (BigInt(this.#config.deployment.fromBlock) - 1n).toString(), launches: [] } : (JSON.parse(text) as TokenIndex);
    if (getAddress(index.launchpad) !== getAddress(lp.launchpad)) index = { version: 1, launchpad: lp.launchpad, scannedTo: (BigInt(this.#config.deployment.fromBlock) - 1n).toString(), launches: [] };
    const latest = await this.#client.getBlockNumber();
    let from = BigInt(index.scannedTo) + 1n;
    if (from > latest) return index;
    for (; from <= latest; from += LOG_WINDOW_BLOCKS) {
      const to = from + LOG_WINDOW_BLOCKS - 1n < latest ? from + LOG_WINDOW_BLOCKS - 1n : latest;
      const logs = await this.#client.getLogs({ address: lp.launchpad, event: launchedEvent, fromBlock: from, toBlock: to });
      for (const l of logs) {
        if (l.args.token === undefined || l.args.poolId === undefined || l.args.creatorVault === undefined || l.args.quote === undefined || l.transactionHash === null || l.blockNumber === null) continue;
        index.launches.push({ token: getAddress(l.args.token), poolId: l.args.poolId, creatorVault: getAddress(l.args.creatorVault), quote: getAddress(l.args.quote), block: l.blockNumber.toString(), txHash: l.transactionHash });
      }
      index.scannedTo = to.toString();
    }
    await this.#folder.write("token-index.json", JSON.stringify(index, null, 2));
    return index;
  }

  /** The metadata URI of `token` in OstraRegistry; null when none or before the registry exists. */
  async #metadataUri(token: Address): Promise<string | null> {
    const r = this.#config.deployment.registry;
    if (r === undefined) return null;
    const uri = (await this.#client.readContract({ address: r, abi: ostraRegistryAbi, functionName: "tokenMetadataOf", args: [token] })) as string;
    return uri === "" ? null : uri;
  }

  /** The profile URI `account` set in OstraRegistry; null when none or before the registry exists. */
  async #profileUri(account: Address): Promise<string | null> {
    const r = this.#config.deployment.registry;
    if (r === undefined) return null;
    const uri = (await this.#client.readContract({ address: r, abi: ostraRegistryAbi, functionName: "profileOf", args: [account] })) as string;
    return uri === "" ? null : uri;
  }

  /** Every token the Ostra launchpad launched, newest first: name, symbol, creator vault, quote and metadata URI. */
  async tokens(a: { offset?: number; limit?: number } = {}): Promise<{ total: number; offset: number; tokens: (TokenListing & { name: string; symbol: string; metadataUri: string | null })[] }> {
    const offset = a.offset ?? 0;
    const limit = a.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError("offset must be a whole number");
    if (!Number.isInteger(limit) || limit < 1 || limit > TOKEN_LIST_MAX) throw new RangeError(`limit must be 1 to ${TOKEN_LIST_MAX}`);
    const index = await this.#tokenIndex();
    const page = [...index.launches].reverse().slice(offset, offset + limit);
    const tokens = await Promise.all(
      page.map(async (l) => {
        const [name, symbol, metadataUri] = await Promise.all([
          this.#client.readContract({ address: l.token, abi: ostraTokenAbi, functionName: "name" }) as Promise<string>,
          this.#client.readContract({ address: l.token, abi: ostraTokenAbi, functionName: "symbol" }) as Promise<string>,
          this.#metadataUri(l.token),
        ]);
        return { ...l, name, symbol, metadataUri };
      }),
    );
    return { total: index.launches.length, offset, tokens };
  }

  /** A launched token for a buyer: its pool (price, rules, airdrop, creator shares), its metadata and its creator's profile, read from IPFS as data. */
  async tokenInfo(tokenText: string): Promise<PoolView & { metadata: { uri: string | null; content: unknown }; creator: { vault: Address; profileUri: string | null; profile: unknown } }> {
    const view = await this.poolInfo(tokenText);
    const [metadataUri, profileUri] = await Promise.all([this.#metadataUri(view.token), this.#profileUri(view.creatorVault)]);
    const [metadata, profile] = await Promise.all([readIpfsJson(metadataUri), readIpfsJson(profileUri)]);
    return { ...view, metadata: { uri: metadataUri, content: metadata }, creator: { vault: view.creatorVault, profileUri, profile } };
  }

  // ---------------------------------------------------------------------------
  // The agent's identity: profile, ERC-8004 registration, token metadata (vault version 2)
  // ---------------------------------------------------------------------------

  /** Throws before anything is signed when the deployment record has no OstraRegistry (vault version 2 not executed yet). */
  #requireRegistry(): void {
    if (this.#config.deployment.registry === undefined) {
      throw new Error(`this deployment record has no OstraRegistry: profiles, token metadata and agent identity open once the vaults run version ${VAULT_VERSION} (the upgrade waits its public delay in OstraUpgradeOwner); nothing was signed`);
    }
  }

  /** The creator vault, once it exists and runs vault version 2 with OstraRegistry in the deployment record; else throws before anything is signed. */
  async #identityVault(): Promise<Address> {
    this.#requireRegistry();
    const s = await this.#creator.state();
    if (!s.exists) throw new Error("the creator vault, the agent's identity, does not exist yet: fund it first (fund_creator_vault); nothing was signed");
    let version = 1;
    try {
      version = Number(await this.#client.readContract({ address: s.vault, abi: ostraVaultAbi, functionName: "VERSION" }));
    } catch {
      version = 1;
    }
    if (version < VAULT_VERSION) throw new Error(`the creator vault runs version ${version}, not ${VAULT_VERSION}; nothing was signed`);
    return s.vault;
  }

  async #agentRecord(): Promise<AgentRecord | null> {
    await this.#folder.ensure();
    const text = await this.#folder.read("agent.json");
    return text === undefined ? null : (JSON.parse(text) as AgentRecord);
  }

  /** The agent's identity: its creator vault, the profile URI it set and its ERC-8004 agent id; or, given `account`, that account's profile URI. */
  async profile(accountText?: string): Promise<{ account: Address; profileUri: string | null; profile: unknown; agentId: string | null }> {
    const account = accountText === undefined ? await this.#creator.vaultAddress() : address(accountText, "account");
    const profileUri = await this.#profileUri(account);
    const record = accountText === undefined ? await this.#agentRecord() : null;
    return { account, profileUri, profile: await readIpfsJson(profileUri), agentId: record?.agentId ?? null };
  }

  /** Sets the agent's profile (a URI to its JSON: name, description, image, links) in OstraRegistry, from the creator vault. */
  async setProfile(uri: string): Promise<VaultOperationResult> {
    checkUri(uri);
    await this.#identityVault();
    return this.#simulatedSpend(this.#creator, this.#creatorSender, VAULT_ACTION.SET_PROFILE, setProfileParams(uri), "profile");
  }

  /** Registers the creator vault as an agent in the ERC-8004 Identity Registry, its registration file at `uri`; the vault owns the identity and is its agentWallet. */
  async registerAgent(uri: string): Promise<VaultOperationResult & { agentId?: string }> {
    checkUri(uri);
    const vault = await this.#identityVault();
    const existing = await this.#agentRecord();
    if (existing !== null) throw new Error(`this agent is registered already as agent ${existing.agentId}: update it with set_agent_uri; nothing was signed`);
    const r = await this.#simulatedSpend(this.#creator, this.#creatorSender, VAULT_ACTION.REGISTER_AGENT, registerAgentParams(uri), "agent registration");
    if (r.status !== "sent") return r;
    const receipt = await this.#client.getTransactionReceipt({ hash: r.txHash });
    let agentId: string | undefined;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== vault) continue;
      try {
        const e = decodeEventLog({ abi: ostraVaultAbi, data: log.data, topics: log.topics });
        if (e.eventName === "AgentRegistered") agentId = (e.args as { agentId: bigint }).agentId.toString();
      } catch {
        // another event of the vault
      }
    }
    if (agentId === undefined) throw new Error(`the registration ${r.txHash} landed without an AgentRegistered event`);
    const record: AgentRecord = { agentId, uri, txHash: r.txHash, at: Math.floor(Date.now() / 1000) };
    await this.#folder.write("agent.json", JSON.stringify(record, null, 2));
    return { ...r, agentId };
  }

  /** Points the agent's ERC-8004 identity at a new registration file. */
  async setAgentUri(uri: string): Promise<VaultOperationResult> {
    checkUri(uri);
    await this.#identityVault();
    const record = await this.#agentRecord();
    if (record === null) throw new Error("this agent has no ERC-8004 identity yet: register_agent first; nothing was signed");
    const r = await this.#simulatedSpend(this.#creator, this.#creatorSender, VAULT_ACTION.SET_AGENT_URI, setAgentUriParams({ agentId: BigInt(record.agentId), uri }), "agent registration file");
    if (r.status === "sent") await this.#folder.write("agent.json", JSON.stringify({ ...record, uri, at: Math.floor(Date.now() / 1000) }, null, 2));
    return r;
  }

  /** Sets the metadata (a URI to its JSON: image, description, links) of a token this agent launched, from the creator vault of its pair. */
  async setTokenMetadata(a: { token: string; uri: string }): Promise<VaultOperationResult> {
    checkUri(a.uri);
    this.#requireRegistry();
    const { pool, creator, sender } = await this.#ownPool(a.token);
    await this.#registryVersion(creator);
    return this.#simulatedSpend(creator, sender, VAULT_ACTION.SET_TOKEN_METADATA, setTokenMetadataParams({ token: pool.token, poolId: pool.id, uri: a.uri }), "token metadata");
  }

  /** `vault` runs vault version VAULT_VERSION (OstraRegistry's writers); else throws before anything is signed. */
  async #registryVersion(vault: VaultService): Promise<void> {
    const s = await vault.state();
    if (!s.exists) throw new Error(`the creator vault ${s.vault} does not exist yet; nothing was signed`);
    let version = 1;
    try {
      version = Number(await this.#client.readContract({ address: s.vault, abi: ostraVaultAbi, functionName: "VERSION" }));
    } catch {
      version = 1;
    }
    if (version < VAULT_VERSION) throw new Error(`the creator vault ${s.vault} runs version ${version}, not ${VAULT_VERSION}; nothing was signed`);
  }

  /**
   * Publishes the agent's profile: builds its ERC-8004 registration file (name, description, image, links, the
   * creator vault as its agentWallet, its registration once it has one), pins it through the uploader, sets it in
   * OstraRegistry, and points the ERC-8004 identity at it too when the agent is registered.
   */
  async publishProfile(p: PublicFields & { name: string }): Promise<{
    uri: string;
    profile: VaultOperationResult;
    agentUri: VaultOperationResult | null;
    pairCreators: { pair: string; vault: Address; result?: VaultOperationResult; error?: string }[];
  }> {
    const vault = await this.#identityVault();
    const record = await this.#agentRecord();
    const file = profileFile({ ...p, vault, agentId: record?.agentId ?? null });
    const uri = await uploadJson(this.#config.relayerUrl, file);
    const profile = await this.setProfile(uri);
    // A token's page shows the profile of its pool's creator vault: the creator vaults of the other pairs this agent
    // launched from (a stock token's, WETH's) carry the same profile.
    const pairCreators: { pair: string; vault: Address; result?: VaultOperationResult; error?: string }[] = [];
    if (profile.status === "sent") {
      const pairs = new Set((await this.launches()).map((l) => (l as { pair?: string }).pair ?? "USDG").filter((x) => x !== "USDG"));
      for (const symbol of pairs) {
        const { vault: creator, sender } = await this.pairCreator(symbol);
        const at = await creator.vaultAddress();
        try {
          await this.#registryVersion(creator);
          pairCreators.push({ pair: symbol, vault: at, result: await this.#simulatedSpend(creator, sender, VAULT_ACTION.SET_PROFILE, setProfileParams(uri), `${symbol} creator vault profile`) });
        } catch (err) {
          pairCreators.push({ pair: symbol, vault: at, error: (err as Error).message });
        }
      }
    }
    if (profile.status !== "sent" || record === null) return { uri, profile, agentUri: null, pairCreators };
    return { uri, profile, agentUri: await this.setAgentUri(uri), pairCreators };
  }

  /** Publishes the metadata of a token this agent launched (description, image, links), pins it and sets it in OstraRegistry. */
  async publishTokenMetadata(a: PublicFields & { token: string }): Promise<{ uri: string; result: VaultOperationResult }> {
    this.#requireRegistry();
    const { pool, creator } = await this.#ownPool(a.token);
    await this.#registryVersion(creator);
    const vault = await creator.vaultAddress();
    const [name, symbol] = await Promise.all([
      this.#client.readContract({ address: pool.token, abi: ostraTokenAbi, functionName: "name" }) as Promise<string>,
      this.#client.readContract({ address: pool.token, abi: ostraTokenAbi, functionName: "symbol" }) as Promise<string>,
    ]);
    const { token: _token, ...fields } = a;
    const uri = await uploadJson(this.#config.relayerUrl, tokenMetadataFile({ ...fields, token: pool.token, name, symbol, creatorVault: vault }));
    return { uri, result: await this.setTokenMetadata({ token: pool.token, uri }) };
  }
}
