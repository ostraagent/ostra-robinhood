// Who pays for this agent's transactions (design v0.3, decided 15 Oct 2026,
// the MCP package using the relayer; on Robinhood Chain, design v0.4).
//
//   LocalSender    the agent's own fee payer (on disk OSTRA_HOME/fee-payer.key) sends
//                  the transactions and pays their gas in ETH, as in Fase 1. Used
//                  without OSTRA_RELAYER_URL (tests), and by settle_self and
//                  rotate_crank when the relayer cannot be reached.
//   RelayerClient  the Ostra relayer sends them (OSTRA_RELAYER_URL): every
//                  request goes to its gate (POST /v1/relay) as calls to
//                  Ostra's contracts, and the agent holds no ETH. The gate
//                  answers 402 with an x402 batch-settlement offer for that
//                  request; it is paid with a voucher from a channel of the
//                  buyer vault to the relayer (its terms from GET /v1/relayer),
//                  after the agent has checked the offer: paid to the relayer's
//                  split with the relayer's vault as receiverAuthorizer, in
//                  this token and chain, and at most RELAYER_QUOTE_TOLERANCE_BPS
//                  above the price the agent computes itself with the
//                  relayer's rules (its own simulation of the gas used plus
//                  the L1 data component, and the same Chainlink ETH/USD
//                  feed, @ostraagent/sdk relayer.ts).
//
// The relayer channel: opened from the buyer vault on the relayer's terms
// (receiver the relayer's split, receiverAuthorizer its vault, withdrawDelay
// its grace period) with RELAYER_CHANNEL_DEPOSIT, or more when its first
// voucher (the open's price plus the vault's debt) and the payment at hand
// need more, and never more than the vault holds. A new one is opened only
// when no open channel has enough unused deposit. Its first voucher pays its
// open and the vault's debt (a createVault relayed before payment). The
// relayer closes it after it has been idle and the rest of the deposit goes
// back to the vault; this package stops using a channel after
// SESSION_MAX_AGE_SECONDS and closes it on the payer path if it still holds
// escrow then (sweep). Vouchers are signed by the stock x402 batch-settlement
// client (@x402/evm) with the channel's voucher key, as the relayer's own
// check runs it; its state per channel is kept in this package's records.
//
// Before a vault spend is signed, `reserve` makes sure a channel has unused
// deposit for it and keeps that amount for it until it is sent, so a signed
// one-time key can always be relayed. Every request names the buyer vault as
// `payer`: the relayer takes that vault's credit off the price (a voucher of
// at least one base unit authorizing it). On Solana the relayer also fronted
// rent and credited lamports paid back to it; an EVM chain has no rent.
//
// Records, in the agent's `relayer` folder (on disk OSTRA_HOME/relayer), entry
// <chain>-<token>-<relayer vault>.json (no secrets): each relayer channel's
// config, deposit, highest voucher, the x402 client's state and age.

import { decodeFunctionData, getAddress, isAddress, type Address, type Hash, type Hex, type PrivateKeyAccount, type PublicClient, type Transport } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme, type BatchSettlementClientContext, type ClientChannelStorage } from "@x402/evm/batch-settlement/client";
import {
  CHAINLINK_ETH_USD,
  MAX_RELAY_CALLS,
  X402_MIN_WITHDRAW_DELAY,
  chainlinkEthUsd,
  channelId as computeChannelId,
  decodeOpenChannelParams,
  estimateRelay,
  maxAcceptedQuote,
  ostraSplitFactoryAbi,
  ostraVaultAbi,
  readChannel,
  readVault,
  relayTransaction,
  vaultChannelConfig,
  weiToTokenUnits,
  withMargin,
  RelaySimulationError,
  VAULT_ACTION,
  type ChannelConfig,
  type EthUsdSource,
  type RelayCall,
} from "@ostraagent/sdk";
import { formatTokenAmount, TOKEN_DECIMALS } from "./amount.ts";
import { sendCalls, tokenBalance } from "./chain.ts";
import { BATCH_MAX_WITHDRAW_DELAY_SECONDS, RELAYER_CHANNEL_DEPOSIT, SESSION_MAX_AGE_SECONDS, type Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import type { Folder } from "./storage.ts";

export const RELAYER_DIR = "relayer";
/**
 * Gas a vault spend is priced at before it is signed (its quote comes only
 * once it is signed): the open of a channel measured on the fork, 275,668 gas
 * (the most a vault spend uses), plus the most WOTS verification adds over a
 * typical signature (about 50,000), rounded up (decided 17 Oct 2026).
 */
export const VAULT_SPEND_GAS = 400_000n;
const REQUEST_TIMEOUT_MS = 240_000;
/** Answers to one relay request before it is given up (each one pays, opens or settles a debt). */
const MAX_STEPS = 8;
/** Sends of one request after the relayer could not land it (409 not_sent; what was paid is credit). */
const MAX_RESENDS = 3;
/** How long a transaction the relayer reports is waited for on this RPC. */
const LANDED_TIMEOUT_MS = 60_000;
const BPS_DENOMINATOR = 10_000;

const now = () => Math.floor(Date.now() / 1000);

/** A channel to the relayer on its terms: its split as receiver, its vault as receiverAuthorizer, its grace period, and the deposit (base units). */
export type RelayerChannelTerms = { receiver: Address; receiverAuthorizer: Address; withdrawDelay: number; amount: bigint };

/** Opens a relayer channel from the buyer vault. */
export type OpenRelayerChannel = (terms: RelayerChannelTerms) => Promise<unknown>;

/** Unused deposit of one relayer channel kept for one vault spend until it is sent. */
export type Reservation = { channel: Hex; amount: bigint };

export type SendOptions = {
  /** A createVault paid up front instead of becoming the vault's debt (the seller vault). */
  prepay?: boolean;
  /** How a relayer channel is opened when one is needed; inside the buyer vault's queue, its unqueued opener. */
  openChannel?: OpenRelayerChannel;
  /** The reservation made before the vault spend in this request was signed. */
  reservation?: Reservation | null;
  /**
   * Relayed even if a vault Swap in it fails now (SwapFailed: it moves
   * nothing and uses the key); the relayer refuses such a request otherwise
   * (422 swap_fails). For a Swap signed earlier that must land before the
   * key can sign anything else.
   */
  allowFailedSwaps?: boolean;
};

export interface Sender {
  /** True when the relayer pays. */
  readonly relayed: boolean;
  /** The account that sends the transactions and pays their gas (the relayer's account or the local fee payer). */
  payer(): Promise<Address>;
  /** Sends `calls` (one transaction; several through Multicall3) and waits for its receipt; resolves with the transaction hash. */
  send(calls: RelayCall[], options?: SendOptions): Promise<Hash>;
  /**
   * Before a vault spend of about `gas` is signed: makes sure it can be
   * paid. `keep` is what that spend moves out of the buyer vault, which a new
   * relayer channel leaves in it. Release it once it was sent.
   */
  reserve(gas: bigint, openChannel?: OpenRelayerChannel, keep?: bigint): Promise<Reservation | null>;
  release(reservation: Reservation | null): void;
}

/** Escrows the WOTS signatures of calls before they are sent (escrow.ts SignatureEscrowClient). */
export type CallEscrow = { escrow(calls: readonly RelayCall[]): Promise<void> };

/**
 * The agent's own fee payer sends and pays the gas (Fase 1). With the
 * relayer's signature escrow, the WOTS signatures in the calls are escrowed
 * first, as the relayer escrows the calls it relays; nothing is sent when that
 * fails.
 */
export class LocalSender implements Sender {
  readonly relayed = false;
  readonly #client: PublicClient;
  readonly #transport: Transport;
  readonly #feePayer: PrivateKeyAccount;
  readonly #escrow: CallEscrow | null;

  constructor(client: PublicClient, transport: Transport, feePayer: PrivateKeyAccount, escrow: CallEscrow | null = null) {
    this.#client = client;
    this.#transport = transport;
    this.#feePayer = feePayer;
    this.#escrow = escrow;
  }

  async payer(): Promise<Address> {
    return this.#feePayer.address;
  }

  async send(calls: RelayCall[]): Promise<Hash> {
    if (this.#escrow !== null) await this.#escrow.escrow(calls);
    return sendCalls(this.#client, this.#transport, this.#feePayer, calls);
  }

  async reserve(): Promise<Reservation | null> {
    return null;
  }

  release(): void {}
}

/** The relayer could not be reached or could not serve now (network, 5xx, no ETH/USD price). */
export class RelayerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerUnavailableError";
  }
}

/**
 * A vault spend signed earlier waits to be sent and no relayer channel can
 * pay for it: a new relayer channel cannot be opened before it, since the open
 * needs the same one-time key (vault.ts sends it with the local fee payer).
 */
export class PendingSpendUnpaidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingSpendUnpaidError";
  }
}

/** The relayer refused the request, or its answer could not be accepted. */
export class RelayerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RelayerError";
    this.status = status;
    this.code = code;
  }
}

export type RelayerSplit = { recipient: Address; bps: number };

/** The relayer's terms (GET /v1/relayer), checked. */
export type RelayerFacts = {
  /** The account that sends the relayed transactions. */
  feePayer: Address;
  /** The relayer's vault: receiverAuthorizer of its channels. */
  vault: Address;
  /** The relayer's OstraSplit: receiver of its channels. */
  split: Address;
  gracePeriodSeconds: number;
  splits: RelayerSplit[];
};

/** An open to the relayer relayed before payment, with the calls that pay it when sent again. */
export type UnpaidOpen = { channel: Hex; amount: bigint; txHash: Hash; calls: RelayCall[] };

/** What the relayer holds for a vault (GET /v1/vaults/<vault>). */
export type RelayerVaultState = { debt: bigint; credit: bigint; unpaidOpen: UnpaidOpen | null };

export type RelayerChannel = {
  /** The x402 channel id. */
  channel: Hex;
  config: ChannelConfig;
  deposit: string;
  /** Highest cumulative amount a voucher of this channel signed (base units). */
  cumulative: string;
  /** The stock x402 client's state of this channel (PAYMENT-RESPONSE and recovery). */
  x402: BatchSettlementClientContext | null;
  openedAt: number;
  lastUsedAt: number;
  /** No longer used for payments (past SESSION_MAX_AGE_SECONDS, or no longer open on-chain). */
  retired: boolean;
};

type RelayerRecord = { version: 1; chainId: number; token: Address; relayer: Address; vault: Address; channels: RelayerChannel[] };

type Answer = { status: number; body: Record<string, unknown> | null; headers: Headers };

function address(value: unknown, what: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`${what} is not an address`);
  return getAddress(value);
}

/** Splits as a relayer lists them: bps 1..10,000 each, no recipient twice, at most 10,000 in all. */
export function checkSplits(raw: unknown, what: string): RelayerSplit[] {
  if (!Array.isArray(raw)) throw new Error(`${what} are not a list`);
  let sum = 0;
  const seen = new Set<string>();
  return (raw as { recipient?: unknown; bps?: unknown }[]).map((s) => {
    const bps = s.bps;
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 1 || bps > BPS_DENOMINATOR) throw new Error(`${what}: a split has an invalid bps`);
    const recipient = address(s.recipient, `${what}: a recipient`);
    if (seen.has(recipient)) throw new Error(`${what} list ${recipient} twice`);
    seen.add(recipient);
    sum += bps;
    if (sum > BPS_DENOMINATOR) throw new Error(`${what} add up to more than ${BPS_DENOMINATOR} bps`);
    return { recipient, bps };
  });
}

/**
 * Checks the relayer's terms: this chain and token, 6 decimals, the
 * Chainlink feed the agent reads too, its call limit, a grace period the
 * agent accepts (x402's 900 s to BATCH_MAX_WITHDRAW_DELAY_SECONDS), valid
 * splits.
 */
export function checkRelayerFacts(raw: unknown, want: { chainId: number; token: Address }): RelayerFacts {
  const f = raw as Record<string, unknown> | null;
  if (f === null || typeof f !== "object") throw new Error("the relayer's terms are not an object");
  if (f.chainId !== want.chainId) throw new Error(`the relayer serves chain ${String(f.chainId)}, not ${want.chainId}`);
  if (address(f.token, "the relayer's token") !== getAddress(want.token)) throw new Error(`the relayer serves token ${String(f.token)}, not ${want.token}`);
  if (f.decimals !== TOKEN_DECIMALS) throw new Error(`the relayer's token has ${String(f.decimals)} decimals, not ${TOKEN_DECIMALS}`);
  if (address(f.priceFeed, "the relayer's price feed") !== CHAINLINK_ETH_USD) throw new Error(`the relayer prices from ${String(f.priceFeed)}, not the Chainlink ETH/USD feed ${CHAINLINK_ETH_USD}`);
  if (f.maxCalls !== MAX_RELAY_CALLS) throw new Error(`the relayer takes ${String(f.maxCalls)} calls per request, not ${MAX_RELAY_CALLS}`);
  const grace = f.gracePeriodSeconds;
  if (typeof grace !== "number" || !Number.isInteger(grace) || grace < X402_MIN_WITHDRAW_DELAY || grace > BATCH_MAX_WITHDRAW_DELAY_SECONDS) {
    throw new Error(`the relayer's grace period ${String(grace)} is not ${X402_MIN_WITHDRAW_DELAY} to ${BATCH_MAX_WITHDRAW_DELAY_SECONDS} s`);
  }
  return {
    feePayer: address(f.feePayer, "the relayer's account"),
    vault: address(f.vault, "the relayer's vault"),
    split: address(f.split, "the relayer's split"),
    gracePeriodSeconds: grace,
    splits: checkSplits(f.splits, "the relayer's splits"),
  };
}

/**
 * Deposit of a new relayer channel: RELAYER_CHANNEL_DEPOSIT, or `needed`
 * (what its first voucher owes plus the payment at hand) when that is more,
 * and never more than the vault holds beyond `keep` (what the vault spend
 * being paid for moves out of it). Throws when that is less than `needed`.
 */
export function relayerChannelDeposit(needed: bigint, vaultBalance: bigint, keep = 0n): bigint {
  const available = vaultBalance - keep;
  if (available < needed) {
    const moves = keep > 0n ? `, of which this operation moves ${formatTokenAmount(keep)}` : "";
    throw new Error(`the vault holds ${formatTokenAmount(vaultBalance)}${moves}: less than the ${formatTokenAmount(needed)} a relayer channel needs now is left; fund the vault first`);
  }
  const want = needed > RELAYER_CHANNEL_DEPOSIT ? needed : RELAYER_CHANNEL_DEPOSIT;
  return want < available ? want : available;
}

/**
 * Why a relayer's 402 offer cannot be paid from the relayer channel
 * `config`, or null: x402 batch-settlement on this chain, in the token, paid
 * to the relayer's split with its vault as receiverAuthorizer and its grace
 * period, for at most `maxAmount`.
 */
export function relayerOfferProblem(r: PaymentRequirements, want: { network: string; config: ChannelConfig; maxAmount: bigint }): string | null {
  if (r.scheme !== "batch-settlement") return `the offer is ${r.scheme}, not batch-settlement`;
  if (r.network !== want.network) return `the offer is on ${r.network}, not ${want.network}`;
  if (!isAddress(r.asset, { strict: false }) || getAddress(r.asset) !== getAddress(want.config.token)) return `the offer is in ${r.asset}, not ${want.config.token}`;
  if (!isAddress(r.payTo, { strict: false }) || getAddress(r.payTo) !== getAddress(want.config.receiver)) return `the offer pays ${r.payTo}, not the relayer's split ${want.config.receiver}`;
  const extra = r.extra ?? {};
  if (typeof extra.receiverAuthorizer !== "string" || !isAddress(extra.receiverAuthorizer, { strict: false }) || getAddress(extra.receiverAuthorizer) !== getAddress(want.config.receiverAuthorizer)) {
    return `the offer's receiverAuthorizer is ${String(extra.receiverAuthorizer)}, not the relayer's vault ${want.config.receiverAuthorizer}`;
  }
  if (extra.withdrawDelay !== want.config.withdrawDelay) return `the offer's withdrawDelay is ${String(extra.withdrawDelay)}, not the relayer's ${want.config.withdrawDelay} s`;
  if (!/^[1-9][0-9]*$/.test(r.amount)) return `the offer's amount ${r.amount} is not a positive integer`;
  const amount = BigInt(r.amount);
  if (amount > want.maxAmount) {
    return `the relayer asks ${formatTokenAmount(amount)}, more than ${formatTokenAmount(want.maxAmount)} (the price computed here plus the tolerance)`;
  }
  return null;
}

/** The OpenChannel spend among `calls` to `vault` (a vault in `token`), decoded into its channel config, or null. */
export function openChannelCall(calls: readonly RelayCall[], vault: Address, token: Address): { config: ChannelConfig; amount: bigint } | null {
  for (const c of calls) {
    if (getAddress(c.to) !== getAddress(vault)) continue;
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: ostraVaultAbi, data: c.data });
    } catch {
      continue;
    }
    if (decoded.functionName !== "spend") continue;
    const [action, , params] = decoded.args as readonly [number, Hex, Hex, Hex];
    if (action !== VAULT_ACTION.OPEN_CHANNEL) continue;
    const open = decodeOpenChannelParams(params);
    return { config: vaultChannelConfig(vault, token, open), amount: open.amount };
  }
  return null;
}

class RelayerStore {
  readonly #folder: Folder;
  readonly #name: string;

  constructor(agentFolder: Folder, chainId: number, token: Address, relayerVault: Address) {
    this.#folder = agentFolder.folder(RELAYER_DIR);
    this.#name = `${chainId}-${getAddress(token)}-${getAddress(relayerVault)}.json`;
  }

  async load(): Promise<RelayerChannel[]> {
    const text = await this.#folder.read(this.#name);
    if (text === undefined) return [];
    const record = JSON.parse(text) as RelayerRecord;
    if (record.version !== 1) throw new Error(`corrupt relayer record ${this.#name}`);
    return record.channels;
  }

  async save(record: Omit<RelayerRecord, "version">): Promise<void> {
    await this.#folder.ensure();
    await this.#folder.write(this.#name, `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`);
  }
}

/** The buyer vault, as the relayer client needs it. */
export type BuyerVault = {
  vaultAddress(): Promise<Address>;
  /** Opens a relayer channel (queued with the vault's other operations). */
  openRelayerChannel(terms: RelayerChannelTerms): Promise<unknown>;
};

export class RelayerClient implements Sender {
  readonly relayed = true;
  readonly url: string;
  readonly #client: PublicClient;
  readonly #config: Config;
  readonly #keys: Keys;
  readonly #ethUsd: EthUsdSource;
  #facts: RelayerFacts | null = null;
  #store: RelayerStore | null = null;
  #channels: RelayerChannel[] | null = null;
  #buyer: BuyerVault | null = null;
  /** The buyer vault, once it exists on-chain (the payer every request names). */
  #payerVault: Address | null = null;
  readonly #reserved = new Map<string, bigint>();
  #lock: Promise<unknown> = Promise.resolve();

  constructor(client: PublicClient, config: Config, keys: Keys, url: string, ethUsd?: EthUsdSource) {
    this.#client = client;
    this.#config = config;
    this.#keys = keys;
    this.url = url;
    this.#ethUsd = ethUsd ?? chainlinkEthUsd(client, CHAINLINK_ETH_USD);
  }

  /** The buyer vault opens the relayer channels and is the payer every request names. */
  attachBuyerVault(buyer: BuyerVault): void {
    this.#buyer = buyer;
  }

  /** Payments (voucher signing and the request that carries it) one at a time. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => undefined);
    return run;
  }

  async #http(method: "GET" | "POST", path: string, body?: string, headers: Record<string, string> = {}): Promise<Answer> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new RelayerUnavailableError(`the relayer at ${this.url} cannot be reached: ${(err as Error).message}`);
    }
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /** The relayer's terms, read once and checked (its vault and split on-chain too). */
  async facts(): Promise<RelayerFacts> {
    if (this.#facts !== null) return this.#facts;
    const answer = await this.#http("GET", "/v1/relayer");
    if (answer.status >= 500) throw new RelayerUnavailableError(`GET /v1/relayer answered ${answer.status}`);
    if (answer.status !== 200) throw new RelayerError(answer.status, "terms", `GET /v1/relayer answered ${answer.status}`);
    const d = this.#config.deployment;
    const facts = checkRelayerFacts(answer.body, { chainId: this.#config.chainId, token: d.token });
    const vault = await readVault(this.#client, d, facts.vault);
    if (vault === null || vault.token !== d.token) throw new Error(`the relayer's vault ${facts.vault} is not an Ostra vault in ${d.token}`);
    const split = await this.#client.readContract({
      address: d.splitFactory,
      abi: ostraSplitFactoryAbi,
      functionName: "splitAddress",
      args: [d.token, facts.vault, facts.splits.map((s) => s.recipient), facts.splits.map((s) => s.bps)],
    });
    if (getAddress(split) !== facts.split) throw new Error(`the relayer's split ${facts.split} is not the OstraSplit of its vault and splits (${split})`);
    this.#facts = facts;
    this.#store = new RelayerStore(this.#keys.folder, this.#config.chainId, d.token, facts.vault);
    return facts;
  }

  async payer(): Promise<Address> {
    return (await this.facts()).feePayer;
  }

  /** What the relayer holds for `vault`. */
  async vaultState(vault: Address): Promise<RelayerVaultState> {
    const answer = await this.#http("GET", `/v1/vaults/${vault}`);
    const b = answer.body;
    if (answer.status >= 500) throw new RelayerUnavailableError(`GET /v1/vaults/${vault} answered ${answer.status}`);
    if (answer.status !== 200 || b === null) throw new RelayerError(answer.status, "vault_state", `GET /v1/vaults/${vault} answered ${answer.status}`);
    const open = b.unpaidOpen as { channel?: unknown; amount?: unknown; txHash?: unknown; calls?: unknown } | null;
    return {
      debt: BigInt(String(b.debt)),
      credit: BigInt(String(b.credit)),
      unpaidOpen:
        open === null || open === undefined
          ? null
          : {
              channel: String(open.channel).toLowerCase() as Hex,
              amount: BigInt(String(open.amount)),
              txHash: String(open.txHash) as Hash,
              calls: Array.isArray(open.calls) ? (open.calls as RelayCall[]).map((c) => ({ to: getAddress(c.to), data: c.data })) : [],
            },
    };
  }

  async #records(): Promise<RelayerChannel[]> {
    await this.facts();
    if (this.#channels === null) this.#channels = await (this.#store as RelayerStore).load();
    return this.#channels;
  }

  async #save(): Promise<void> {
    const facts = await this.facts();
    await (this.#store as RelayerStore).save({ chainId: this.#config.chainId, token: this.#config.deployment.token, relayer: facts.feePayer, vault: facts.vault, channels: await this.#records() });
  }

  #buyerVault(): BuyerVault {
    if (this.#buyer === null) throw new Error("the relayer client has no buyer vault");
    return this.#buyer;
  }

  /** The buyer vault's address once it exists on-chain, else null (its own createVault names no payer). */
  async #payer(): Promise<Address | null> {
    if (this.#payerVault !== null) return this.#payerVault;
    const vault = await this.#buyerVault().vaultAddress();
    if ((await readVault(this.#client, this.#config.deployment, vault)) === null) return null;
    this.#payerVault = vault;
    return vault;
  }

  /** Relayer channels in use, with their unused deposit (reservations of others taken off). */
  async channels(): Promise<{ channel: Hex; deposit: string; spent: string; unused: string; openedAt: string; retired: boolean }[]> {
    const out = [];
    for (const c of await this.#records()) {
      const unused = BigInt(c.deposit) - BigInt(c.cumulative);
      out.push({ channel: c.channel, deposit: formatTokenAmount(BigInt(c.deposit)), spent: formatTokenAmount(BigInt(c.cumulative)), unused: formatTokenAmount(unused > 0n ? unused : 0n), openedAt: new Date(c.openedAt * 1000).toISOString(), retired: c.retired });
    }
    return out;
  }

  /** Unused deposit of `c` left for a payment, `reservation` (its own) excepted. */
  #free(c: RelayerChannel, reservation: Reservation | null): bigint {
    const reserved = this.#reserved.get(c.channel) ?? 0n;
    const own = reservation !== null && reservation.channel === c.channel ? reservation.amount : 0n;
    return BigInt(c.deposit) - BigInt(c.cumulative) - reserved + own;
  }

  /** A relayer channel that can pay `amount` now: the reservation's, else any open one with room. */
  async #channelFor(amount: bigint, reservation: Reservation | null): Promise<RelayerChannel | null> {
    const facts = await this.facts();
    const payer = await this.#payer();
    const records = await this.#records();
    const ordered = reservation === null ? records : [...records.filter((c) => c.channel === reservation.channel), ...records.filter((c) => c.channel !== reservation.channel)];
    for (const c of ordered) {
      if (c.retired || this.#free(c, reservation) < amount) continue;
      if (now() >= c.openedAt + SESSION_MAX_AGE_SECONDS) {
        c.retired = true;
        await this.#save();
        continue;
      }
      const ch = await readChannel(this.#client, this.#config.deployment.batchSettlement, c.channel);
      const usable =
        payer !== null &&
        getAddress(c.config.payer) === payer &&
        getAddress(c.config.receiverAuthorizer) === facts.vault &&
        getAddress(c.config.receiver) === facts.split &&
        ch.pendingWithdrawal === null &&
        ch.balance - BigInt(c.cumulative) >= amount;
      if (!usable) {
        c.retired = true;
        await this.#save();
        continue;
      }
      return c;
    }
    return null;
  }

  /** Base units a transaction of `wei` comes to at the Chainlink price, margin included (the relayer's rule). */
  async #amountFor(wei: bigint): Promise<bigint> {
    return weiToTokenUnits(withMargin(wei), await this.#ethUsd(), TOKEN_DECIMALS);
  }

  /** The most a vault spend (VAULT_SPEND_GAS at the current gas price) can be quoted, tolerance included. */
  async #spendBound(): Promise<bigint> {
    return maxAcceptedQuote(await this.#amountFor(VAULT_SPEND_GAS * (await this.#client.getGasPrice())));
  }

  /** The most this agent pays for `calls`: its own price for them (the gas they use, simulated from the relayer's account, plus the L1 data component; Chainlink) plus the tolerance. */
  async #maxAmount(calls: readonly RelayCall[]): Promise<bigint> {
    const facts = await this.facts();
    try {
      const m = await estimateRelay(this.#client, { relayer: facts.feePayer, ...relayTransaction(calls) });
      return maxAcceptedQuote(await this.#amountFor(m.wei));
    } catch (err) {
      if (err instanceof RelaySimulationError) throw new RelayerError(err.reverted ? 422 : 503, err.code, err.message);
      throw err;
    }
  }

  /**
   * Makes sure a relayer channel can pay `need` (base units): pays an open
   * relayed before payment, uses a channel with room, or opens one (leaving
   * `keep` in the vault).
   */
  async #ensureChannel(need: bigint, openChannel: OpenRelayerChannel | undefined, reservation: Reservation | null, keep = 0n): Promise<void> {
    const facts = await this.facts();
    const vault = await this.#buyerVault().vaultAddress();
    const state = await this.vaultState(vault);
    if (state.unpaidOpen !== null) await this.#payUnpaidOpen(state.unpaidOpen, state.debt);
    if ((await this.#channelFor(need, reservation)) !== null) return;
    if ((await readVault(this.#client, this.#config.deployment, vault)) === null) throw new Error("this agent has no vault yet; call open_vault first (the vault pays the relayer)");
    // The open is one vault spend; its first voucher also pays the vault's debt.
    const owedFirst = (await this.vaultState(vault)).debt + (await this.#spendBound());
    const balance = await tokenBalance(this.#client, this.#config.deployment.token, vault);
    const terms: RelayerChannelTerms = { receiver: facts.split, receiverAuthorizer: facts.vault, withdrawDelay: facts.gracePeriodSeconds, amount: relayerChannelDeposit(owedFirst + need, balance, keep) };
    await (openChannel ?? ((t: RelayerChannelTerms) => this.#buyerVault().openRelayerChannel(t)))(terms);
  }

  async reserve(gas: bigint, openChannel?: OpenRelayerChannel, keep = 0n): Promise<Reservation | null> {
    const amount = maxAcceptedQuote(await this.#amountFor(gas * (await this.#client.getGasPrice())));
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = await this.#serial(async () => {
        const found = await this.#channelFor(amount, null);
        if (found !== null) this.#reserved.set(found.channel, (this.#reserved.get(found.channel) ?? 0n) + amount);
        return found;
      });
      if (c !== null) return { channel: c.channel, amount };
      await this.#ensureChannel(amount, openChannel, null, keep);
    }
    throw new Error("no relayer channel has room for the vault operation after opening one");
  }

  release(reservation: Reservation | null): void {
    if (reservation === null) return;
    const left = (this.#reserved.get(reservation.channel) ?? 0n) - reservation.amount;
    if (left > 0n) this.#reserved.set(reservation.channel, left);
    else this.#reserved.delete(reservation.channel);
  }

  async #post(calls: readonly RelayCall[], extra: { prepay?: boolean; payer: Address | null; allowFailedSwaps?: boolean }, headers: Record<string, string> = {}): Promise<Answer> {
    const body: Record<string, unknown> = { calls: calls.map((c) => ({ to: getAddress(c.to), data: c.data })) };
    if (extra.prepay === true) body.prepay = true;
    if (extra.payer !== null) body.payer = extra.payer;
    if (extra.allowFailedSwaps === true) body.allowFailedSwaps = true;
    return this.#http("POST", "/v1/relay", JSON.stringify(body), headers);
  }

  /** The x402 HTTP client of relayer channel `c`: the stock batch-settlement client, the vault as payer, the channel's voucher key signing, never depositing. */
  #x402(c: RelayerChannel): x402HTTPClient {
    const voucherKey = this.#keys.channelVoucherSigner(this.#config.chainId, this.#config.deployment.token, c.config.salt);
    if (voucherKey.address !== getAddress(c.config.payerAuthorizer)) throw new Error(`the voucher key of relayer channel ${c.channel} is not derived from this machine's master seed`);
    const client = this.#client;
    // The vault is the payer and signs nothing but WOTS spends; it only reads the chain here.
    const payer = {
      address: getAddress(c.config.payer),
      signTypedData: () => Promise.reject(new Error("a vault never signs typed data")),
      readContract: (args: Parameters<PublicClient["readContract"]>[0]) => client.readContract(args),
    };
    const storage: ClientChannelStorage = {
      get: async (key) => (key === c.channel ? (c.x402 ?? undefined) : undefined),
      set: async (key, context) => {
        if (key !== c.channel) return;
        c.x402 = context;
        await this.#save();
      },
      delete: async (key) => {
        if (key !== c.channel) return;
        c.x402 = null;
        await this.#save();
      },
    };
    const scheme = new BatchSettlementEvmScheme(payer as never, {
      voucherSigner: toClientEvmSigner(voucherKey, client as never),
      payerAuthorizer: voucherKey.address,
      salt: c.config.salt,
      storage,
      depositStrategy: () => false,
    });
    const x = new x402Client().register(this.#config.x402Network as `${string}:${string}`, scheme);
    x.setSpendControls({ allowedAssets: [{ network: this.#config.x402Network as `${string}:${string}`, asset: this.#config.deployment.token }] });
    return new x402HTTPClient(x);
  }

  /** The 402's offer, parsed. */
  #required(http: x402HTTPClient, answer: Answer): PaymentRequired {
    try {
      return http.getPaymentRequiredResponse((name) => answer.headers.get(name), answer.body);
    } catch (err) {
      throw new RelayerError(402, "no_offer", `the relayer's 402 carries no readable x402 offer: ${(err as Error).message}`);
    }
  }

  /**
   * Pays the 402 `answer` for `calls` from relayer channel `c` with at most
   * `maxAmount` and posts the request again with the voucher; returns the
   * relayer's answer to that. A corrective 402 (the relayer charged that
   * channel more than this machine knew) is reconciled by the stock client
   * and paid once more.
   */
  async #payFrom(c: RelayerChannel, calls: readonly RelayCall[], answer: Answer, maxAmount: bigint, prepay: boolean, allowFailedSwaps = false): Promise<Answer> {
    let current = answer;
    for (let attempt = 0; attempt < 2; attempt++) {
      const http = this.#x402(c);
      const required = this.#required(http, current);
      const offer = required.accepts.find((r) => r.scheme === "batch-settlement");
      if (offer === undefined) throw new RelayerError(402, "no_offer", "the relayer's 402 has no batch-settlement offer");
      const problem = relayerOfferProblem(offer, { network: this.#config.x402Network, config: c.config, maxAmount });
      if (problem !== null) throw new RelayerError(402, "offer", `the relayer's offer cannot be paid: ${problem}`);
      const payload: PaymentPayload = await http.createPaymentPayload({ ...required, accepts: [offer] });
      const voucher = (payload.payload as { voucher?: { channelId?: string; maxClaimableAmount?: string } }).voucher;
      if (voucher?.channelId?.toLowerCase() !== c.channel || voucher.maxClaimableAmount === undefined) throw new Error(`the x402 client signed a voucher for another channel than ${c.channel}`);
      const signed = BigInt(voucher.maxClaimableAmount);
      if (signed > BigInt(c.deposit)) throw new Error(`relayer channel ${c.channel} cannot cover a voucher of ${signed}`);
      // The signed voucher authorizes the relayer whatever it answers: it is recorded first.
      if (signed > BigInt(c.cumulative)) c.cumulative = signed.toString();
      c.lastUsedAt = now();
      await this.#save();
      const paid = await this.#post(calls, { prepay, payer: await this.#payer(), allowFailedSwaps }, http.encodePaymentSignatureHeader(payload));
      const result = await http.processPaymentResult(payload, (name) => paid.headers.get(name), paid.status);
      if (paid.status === 402 && result.recovered) {
        current = paid;
        continue;
      }
      if (paid.status === 402) {
        // The voucher was not taken: a channel that no longer holds escrow for it is not used again.
        const ch = await readChannel(this.#client, this.#config.deployment.batchSettlement, c.channel);
        if (ch.pendingWithdrawal !== null || ch.balance < signed) {
          c.retired = true;
          await this.#save();
        }
      }
      return paid;
    }
    throw new RelayerError(402, "unpaid", `the relayer did not take a voucher of channel ${c.channel} after resyncing it`);
  }

  /**
   * A relayer channel open the relayer sent before payment: checks it is this
   * vault's open on the relayer's terms with a voucher key from this seed,
   * records it, and pays the open and the vault's debt with its first
   * voucher (the same request sent again).
   */
  async #payOpen(calls: readonly RelayCall[], channel: Hex, paymentDue: bigint, debt: bigint): Promise<Hash> {
    const facts = await this.facts();
    const d = this.#config.deployment;
    const vault = await this.#buyerVault().vaultAddress();
    const found = openChannelCall(calls, vault, d.token);
    if (found === null) throw new Error(`the relayer reports an open of channel ${channel} that is not in this vault's request`);
    const config = found.config;
    const id = computeChannelId(config, this.#config.chainId, d.batchSettlement).toLowerCase() as Hex;
    if (id !== channel.toLowerCase()) throw new Error(`the relayer reports channel ${channel}, but the open in the request is channel ${id}`);
    if (getAddress(config.receiver) !== facts.split || getAddress(config.receiverAuthorizer) !== facts.vault || config.withdrawDelay !== facts.gracePeriodSeconds) {
      throw new Error(`channel ${channel} is not on the relayer's terms`);
    }
    const voucherKey = this.#keys.channelVoucherSigner(this.#config.chainId, d.token, config.salt);
    if (voucherKey.address !== getAddress(config.payerAuthorizer)) throw new Error(`the voucher key of relayer channel ${channel} is not derived from this machine's master seed`);
    const ch = await readChannel(this.#client, d.batchSettlement, id);
    if (ch.balance !== found.amount || ch.pendingWithdrawal !== null) throw new Error(`relayer channel ${channel} does not hold its deposit of ${found.amount}`);
    const most = debt + (await this.#spendBound());
    if (paymentDue > most) throw new Error(`the relayer asks ${formatTokenAmount(paymentDue)} for the open of channel ${channel}, more than an open's price and the vault's debt (${formatTokenAmount(most)})`);
    if (paymentDue > found.amount) throw new Error(`the open of channel ${channel} owes more than its deposit`);
    return this.#serial(async () => {
      const records = await this.#records();
      let c = records.find((r) => r.channel === id);
      if (c === undefined) {
        c = { channel: id, config, deposit: found.amount.toString(), cumulative: "0", x402: null, openedAt: now(), lastUsedAt: now(), retired: false };
        records.push(c);
        await this.#save();
      }
      const payer = await this.#payer();
      const first = await this.#post(calls, { payer });
      if (first.status === 200 && first.body?.repeated === true && typeof first.body.txHash === "string") return first.body.txHash as Hash;
      if (first.status !== 402) throw new RelayerError(first.status, String(first.body?.error ?? "open"), `paying the open of channel ${channel}: the relayer answered ${first.status}: ${String(first.body?.message ?? "")}`);
      const paid = await this.#payFrom(c, calls, first, paymentDue, false);
      if (paid.status !== 200 || typeof paid.body?.txHash !== "string") {
        throw new RelayerError(paid.status, String(paid.body?.error ?? "open"), `the relayer did not take the first voucher of channel ${channel} (${paid.status}): ${String(paid.body?.message ?? "")}`);
      }
      return paid.body.txHash as Hash;
    });
  }

  /** Pays an open the relayer sent before payment that this machine did not pay (it stopped, or was restored from the seed). */
  async #payUnpaidOpen(unpaid: UnpaidOpen, debt: bigint): Promise<void> {
    if (unpaid.calls.length === 0) throw new Error(`the relayer holds an unpaid open of channel ${unpaid.channel} without its calls; it cannot be paid from here`);
    await this.#landed(await this.#payOpen(unpaid.calls, unpaid.channel, unpaid.amount, debt));
  }

  /** Waits until `hash` has a successful receipt on this RPC. */
  async #landed(hash: Hash): Promise<void> {
    let receipt;
    try {
      receipt = await this.#client.waitForTransactionReceipt({ hash, timeout: LANDED_TIMEOUT_MS });
    } catch (err) {
      throw new Error(`the relayer reported ${hash}, but this RPC shows no receipt for it: ${(err as Error).message}`);
    }
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on-chain`);
  }

  /**
   * Pays the 402 `answer` for `calls` with a voucher of a relayer channel and
   * sends the request again with it; returns the relayer's answer to that.
   */
  async #pay(calls: readonly RelayCall[], answer: Answer, options: SendOptions): Promise<Answer> {
    const maxAmount = await this.#maxAmount(calls);
    const offered = (() => {
      try {
        const r = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((name) => answer.headers.get(name), answer.body);
        return BigInt(r.accepts.find((a) => a.scheme === "batch-settlement")?.amount ?? "0");
      } catch {
        return 0n;
      }
    })();
    if (offered <= 0n) throw new RelayerError(402, "no_offer", "the relayer's 402 carries no batch-settlement amount");
    if (offered > maxAmount) {
      throw new RelayerError(402, "offer", `the relayer asks ${formatTokenAmount(offered)}, more than ${formatTokenAmount(maxAmount)} (the price computed here plus the tolerance)`);
    }
    const reservation = options.reservation ?? null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const sent = await this.#serial(async () => {
        const c = await this.#channelFor(offered, reservation);
        if (c === null) return null;
        return this.#payFrom(c, calls, answer, maxAmount, options.prepay === true, options.allowFailedSwaps === true);
      });
      if (sent !== null) return sent;
      if (reservation !== null) throw new Error("the reserved relayer channel can no longer pay this vault operation");
      await this.#ensureChannel(offered, options.openChannel, null);
    }
    throw new Error("no relayer channel can pay this request after opening one");
  }

  async send(calls: RelayCall[], options: SendOptions = {}): Promise<Hash> {
    await this.facts();
    for (let resend = 0; resend < MAX_RESENDS; resend++) {
      let answer = await this.#post(calls, { prepay: options.prepay === true, payer: await this.#payer(), allowFailedSwaps: options.allowFailedSwaps === true });
      let again = false;
      for (let step = 0; step < MAX_STEPS && !again; step++) {
        const b = answer.body;
        const error = typeof b?.error === "string" ? b.error : "";
        if (answer.status === 200 && typeof b?.txHash === "string") {
          // An open to the relayer's vault, relayed before payment: its first voucher pays it now.
          const hash =
            typeof b.paymentDue === "string" && typeof b.channel === "string"
              ? await this.#payOpen(calls, b.channel as Hex, BigInt(b.paymentDue), (await this.vaultState(await this.#buyerVault().vaultAddress())).debt)
              : (b.txHash as Hash);
          await this.#landed(hash);
          return hash;
        }
        if (answer.status === 402) {
          answer = await this.#pay(calls, answer, options);
          continue;
        }
        if (answer.status === 403 && (error === "vault_in_debt" || error === "open_unpaid")) {
          if (options.reservation !== undefined && options.reservation !== null) throw new RelayerError(403, error, String(b?.message ?? error));
          await this.#ensureChannel(1n, options.openChannel, null);
          answer = await this.#post(calls, { prepay: options.prepay === true, payer: await this.#payer(), allowFailedSwaps: options.allowFailedSwaps === true });
          continue;
        }
        if (answer.status === 409 && error === "not_sent") {
          // Not landed: any payment for it is credit of the vault; the same request is sent again.
          again = true;
          continue;
        }
        if (answer.status === 503 && error === "send_unknown" && typeof b?.txHash === "string") {
          // The relayer sent it and could not tell whether it landed: it may still land.
          try {
            await this.#landed(b.txHash as Hash);
            return b.txHash as Hash;
          } catch {
            throw new RelayerUnavailableError(`the relayer sent ${b.txHash} and could not tell whether it landed; it may still land: ${String(b.message ?? "")}`);
          }
        }
        if (answer.status >= 500) {
          throw new RelayerUnavailableError(`the relayer answered ${answer.status}${error === "" ? "" : ` ${error}`}: ${String(b?.message ?? "")}`);
        }
        throw new RelayerError(answer.status, error === "" ? String(answer.status) : error, `the relayer answered ${answer.status}: ${String(b?.message ?? error)}`);
      }
      if (!again) throw new Error(`the relayer did not relay the request after ${MAX_STEPS} answers`);
    }
    throw new Error(`the relayer could not land the request in ${MAX_RESENDS} attempts`);
  }

  /**
   * Relayer channels past SESSION_MAX_AGE_SECONDS stop paying; returns those
   * that still hold unclaimed escrow (to close on the payer path, with their
   * config) and forgets channels that hold nothing any more.
   */
  async sweep(): Promise<{ channel: Hex; config: ChannelConfig }[]> {
    const records = await this.#records();
    const open: { channel: Hex; config: ChannelConfig }[] = [];
    const keep: RelayerChannel[] = [];
    for (const c of records) {
      const ch = await readChannel(this.#client, this.#config.deployment.batchSettlement, c.channel);
      // Nothing left unclaimed (a refunded channel keeps a withdrawal cut down to what was claimed): forgotten.
      if (ch.balance <= ch.totalClaimed) continue;
      if (!c.retired && now() >= c.openedAt + SESSION_MAX_AGE_SECONDS) c.retired = true;
      if (c.retired) open.push({ channel: c.channel, config: c.config });
      keep.push(c);
    }
    this.#channels = keep;
    await this.#save();
    return open;
  }
}
