// Channels from this agent's vault to another Ostra vault (design v0.3,
// tools `open_channel` and `close_channel`; on Robinhood Chain, design v0.4,
// x402 batch-settlement channels).
//
// The vault opens a channel with one WOTS signature (the OpenChannel spend)
// that covers its whole config: the voucher key (payerAuthorizer), the
// receiver (the seller's OstraSplit for the splits the seller asked for), the
// receiverAuthorizer (the seller's vault, whose crank claims), the grace
// period (withdrawDelay), the salt and the deposit. The voucher key is derived
// from the master seed and the salt, which is part of the config, so the seed
// alone recovers it. Closing takes steps that depend on time:
//   1. requestClose on the vault, signed by the voucher key (EIP-712
//      CloseRequest): the vault starts the timed withdrawal of the unclaimed
//      escrow (status closing). The seller's keeper sees it, claims its last
//      voucher and refunds the rest to the vault at once;
//   2. otherwise, once the grace period has passed, finalizeWithdraw (anyone
//      may call it): the unclaimed escrow goes back to the vault.
// What the seller claimed is paid out by the seller's keeper (settle to its
// OstraSplit, distribute, release); on Solana the payer side also ran seal,
// distribute and reclaim, which an x402 channel does not have.
// Every step is paid by the sender (relay.ts): the relayer, or the local fee payer.
// `close_channel` runs every step that is possible now and says what is next;
// the server's periodic sweep carries on with channels whose close was asked for.
//
// `pay` opens channels here too: a seller whose x402 batch-settlement payee
// is an Ostra vault is paid from a channel of this vault (design v0.3, payment
// route: vault to vault). Such a record carries `pay`: the paid route, the
// vouchers signed so far and the end of its life. Every channel this vault
// opens is recorded here before its open is signed, the relayer channels too.
//
// Entries, in the agent's `channels` folder (on disk OSTRA_HOME/channels,
// 0700), no secrets: <salt>.json (the channel config, its id, close steps
// sent). On Solana a second entry listed every send of an open, because the
// channel address depended on the open slot; an x402 channel id is fixed by
// its config.

import { bytesToHex, decodeFunctionData, encodeFunctionData, getAddress, isAddress, parseAbiItem, type Address, type Hash, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import type { BatchSettlementClientContext } from "@x402/evm/batch-settlement/client";
import {
  MULTICALL3,
  ROBINHOOD_PUBLIC_RPC,
  VAULT_ACTION,
  X402_MAX_WITHDRAW_DELAY,
  X402_MIN_WITHDRAW_DELAY,
  channelId as computeChannelId,
  closeDigest,
  decodeOpenChannelParams,
  multicall3Abi,
  ostraSplitFactoryAbi,
  ostraVaultAbi,
  readChannel,
  readVault,
  robinhoodClient,
  vaultChannelConfig,
  type ChannelConfig,
  type ChannelState,
  type OpenChannelParams,
} from "@ostraagent/sdk";
import { formatTokenAmount, parseTokenAmount } from "./amount.ts";
import { chainTime } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import { randomBytes } from "./random.ts";
import { VAULT_SPEND_GAS, type Sender } from "./relay.ts";
import type { SessionPayment } from "./sessions.ts";
import type { Folder } from "./storage.ts";
import type { ChannelOpening, ResentSpend, VaultService } from "./vault.ts";

export const CHANNELS_DIR = "channels";
const BPS_DENOMINATOR = 10_000;
/** OstraSplit.MAX_RECIPIENTS (on Solana, Payment Channels' 32 recipients). */
export const MAX_SPLIT_RECIPIENTS = 32;
/** Upper bound on close steps in one call (each step changes the channel's state). */
const MAX_STEPS_PER_CALL = 4;
/** How long a close request signed by the voucher key stays valid. */
const CLOSE_REQUEST_TTL_SECONDS = 3_600n;

const channelOpenedEvent = parseAbiItem("event ChannelOpened(bytes32 indexed channelId, uint128 amount)");

/**
 * Blocks one eth_getLogs request spans when a channel is recovered: the most
 * the public Robinhood Chain RPC allows (measured 18 Oct 2026; more is refused
 * with "only 10000000 are allowed"), about 11.8 days at 0.1 s a block.
 */
export const LOG_WINDOW_BLOCKS = 10_000_000n;

/** The ChannelOpened logs of `channel` from `vault` between `fromBlock` and `toBlock`, read in windows of LOG_WINDOW_BLOCKS. */
async function channelOpenedLogs(client: PublicClient, vault: Address, channel: Hex, fromBlock: bigint, toBlock: bigint) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_WINDOW_BLOCKS) {
    const to = from + LOG_WINDOW_BLOCKS - 1n < toBlock ? from + LOG_WINDOW_BLOCKS - 1n : toBlock;
    out.push(...(await client.getLogs({ address: vault, event: channelOpenedEvent, args: { channelId: channel }, fromBlock: from, toBlock: to })));
  }
  return out;
}

export type ChannelRecipient = { recipient: Address; bps: number };

/**
 * open: no withdrawal started; closing: a timed withdrawal runs; closed:
 * nothing of the escrow is left unclaimed (a withdrawal the payee's refund
 * cut down to what it claimed stays recorded on-chain, but has nothing left
 * to return; as the keeper reads it).
 */
export type ChannelStatus = "open" | "closing" | "closed";

export type ChannelStep = { step: string; txHash: Hash; at: number };

/** An x402 batch-settlement voucher as it goes on the wire. */
export type X402Voucher = { channelId: Hex; maxClaimableAmount: string; signature: Hex };

/** What `pay` keeps for a channel it opened to an Ostra seller (pay.ts). */
export type PayChannelState = {
  /** The paid route and its HTTP method. */
  url: string;
  method: string;
  /** Unix seconds when `pay` ends the channel (the session maximum age). */
  expiresAt: number;
  /** Highest cumulative amount the voucher key signed (base units). */
  cumulative: string;
  /** That voucher (null before the first one). */
  voucher: X402Voucher | null;
  /** The cooperative refund was asked for (once). */
  closeSent: boolean;
  payments: SessionPayment[];
  /** The stock x402 batch-settlement client's state of this channel. */
  x402?: BatchSettlementClientContext | null;
};

export type ChannelRecord = {
  version: 1;
  /** The channel config's salt (32 bytes); the voucher key derives from it. */
  salt: Hex;
  chainId: number;
  token: Address;
  vault: Address;
  /** The x402 channel id. */
  channel: Hex;
  config: ChannelConfig;
  /** The seller's vault (the channel's receiverAuthorizer). */
  payee: Address;
  voucherKey: Address;
  deposit: string;
  gracePeriod: number;
  /** The splits the receiver (the seller's OstraSplit) was derived from; null when the record was rebuilt from the chain. */
  recipients: ChannelRecipient[] | null;
  createdAt: number;
  openTxHash?: Hash;
  closeRequested: boolean;
  /** Nothing of the escrow is left unclaimed and no withdrawal runs: nothing left to do. */
  finished: boolean;
  steps: ChannelStep[];
  /** Set when `pay` opened the channel. */
  pay?: PayChannelState;
};

/** Splits as the seller asked for them, checked against the OstraSplit rules. */
export function parseRecipients(input: readonly { recipient: string; bps: number }[]): ChannelRecipient[] {
  if (input.length > MAX_SPLIT_RECIPIENTS) throw new RangeError(`at most ${MAX_SPLIT_RECIPIENTS} recipients`);
  const seen = new Set<string>();
  let sum = 0;
  const out: ChannelRecipient[] = [];
  for (const r of input) {
    if (!isAddress(r.recipient, { strict: false })) throw new RangeError(`${r.recipient} is not an address`);
    const recipient = getAddress(r.recipient);
    if (BigInt(recipient) === 0n) throw new RangeError("a recipient must not be the zero address");
    if (!Number.isInteger(r.bps) || r.bps < 1 || r.bps > BPS_DENOMINATOR) throw new RangeError(`the bps of ${recipient} must be an integer from 1 to ${BPS_DENOMINATOR}`);
    if (seen.has(recipient)) throw new RangeError(`${recipient} is listed twice`);
    seen.add(recipient);
    sum += r.bps;
    out.push({ recipient, bps: r.bps });
  }
  if (sum > BPS_DENOMINATOR) throw new RangeError(`the splits add up to ${sum} bps, more than ${BPS_DENOMINATOR}`);
  return out;
}

/** Grace period in seconds: x402 batch-settlement's withdrawDelay, 900 seconds to 30 days. */
export function parseGracePeriod(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < X402_MIN_WITHDRAW_DELAY || seconds > X402_MAX_WITHDRAW_DELAY) {
    throw new RangeError(`gracePeriod must be a whole number of seconds from ${X402_MIN_WITHDRAW_DELAY} to ${X402_MAX_WITHDRAW_DELAY}`);
  }
  return seconds;
}

/** The seller's OstraSplit for `vault` and `recipients` (OstraSplitFactory.splitAddress): the receiver of its channels. */
export async function splitAddress(client: PublicClient, config: Config, vault: Address, recipients: readonly ChannelRecipient[]): Promise<Address> {
  const d = config.deployment;
  return getAddress(
    await client.readContract({
      address: d.splitFactory,
      abi: ostraSplitFactoryAbi,
      functionName: "splitAddress",
      args: [d.token, vault, recipients.map((r) => r.recipient), recipients.map((r) => r.bps)],
    }),
  );
}

/** The status of a channel from its on-chain state. */
export function channelStatus(ch: ChannelState): ChannelStatus {
  if (ch.balance <= ch.totalClaimed) return "closed";
  return ch.pendingWithdrawal === null ? "open" : "closing";
}

/** Whether the channel moved on-chain between two reads: someone else took a step (the seller's keeper claims and refunds). */
export function channelMoved(before: ChannelState, after: ChannelState): boolean {
  return (
    after.balance !== before.balance ||
    after.totalClaimed !== before.totalClaimed ||
    (after.pendingWithdrawal === null) !== (before.pendingWithdrawal === null) ||
    after.pendingWithdrawal?.initiatedAt !== before.pendingWithdrawal?.initiatedAt ||
    after.pendingWithdrawal?.amount !== before.pendingWithdrawal?.amount
  );
}

/** Unused deposit of a channel `pay` opened: deposit minus what its vouchers signed. */
export function payCapacity(record: ChannelRecord): bigint {
  if (record.pay === undefined) return 0n;
  const left = BigInt(record.deposit) - BigInt(record.pay.cumulative);
  return left > 0n ? left : 0n;
}

/**
 * The config of channel `channel` that `vault` opened, read back from the
 * chain (after a restore from the seed, when no record of it is here): the
 * vault's ChannelOpened event gives the transaction, and the OpenChannel
 * spend in it (sent alone or through Multicall3) gives the config.
 * The logs are read from the agent's RPC; one that refuses the window (Alchemy
 * Free allows 10 blocks a request) is replaced, for the logs only, by the
 * public RPC. A config is returned only if it hashes to `channel`, so the log
 * source needs no trust.
 */
export async function recoverChannelConfig(client: PublicClient, config: Config, vault: Address, channel: Hex): Promise<ChannelConfig | null> {
  const d = config.deployment;
  const latest = await client.getBlockNumber();
  let logs;
  try {
    logs = await channelOpenedLogs(client, vault, channel, BigInt(d.fromBlock), latest);
  } catch {
    logs = await channelOpenedLogs(robinhoodClient(ROBINHOOD_PUBLIC_RPC), vault, channel, BigInt(d.fromBlock), latest);
  }
  for (const log of logs) {
    if (log.transactionHash === null) continue;
    const tx = await client.getTransaction({ hash: log.transactionHash });
    const calls: { to: Address; data: Hex }[] = [];
    if (tx.to !== null && tx.to !== undefined && getAddress(tx.to) === getAddress(vault)) calls.push({ to: vault, data: tx.input });
    if (tx.to !== null && tx.to !== undefined && getAddress(tx.to) === MULTICALL3) {
      try {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: tx.input });
        const inner = decoded.args[0] as readonly { target: Address; callData: Hex }[];
        for (const c of inner) if (getAddress(c.target) === getAddress(vault)) calls.push({ to: vault, data: c.callData });
      } catch {
        // not an aggregate3 call
      }
    }
    for (const c of calls) {
      let decoded;
      try {
        decoded = decodeFunctionData({ abi: ostraVaultAbi, data: c.data });
      } catch {
        continue;
      }
      if (decoded.functionName !== "spend") continue;
      const [action, , params] = decoded.args as readonly [number, Hex, Hex, Hex];
      if (action !== VAULT_ACTION.OPEN_CHANNEL) continue;
      const cfg = vaultChannelConfig(vault, d.token, decodeOpenChannelParams(params));
      if (computeChannelId(cfg, config.chainId, d.batchSettlement).toLowerCase() === channel.toLowerCase()) return cfg;
    }
  }
  return null;
}

export class ChannelStore {
  readonly #folder: Folder;

  /** `folder`: the agent's `channels` folder (CHANNELS_DIR in its folder). */
  constructor(folder: Folder) {
    this.#folder = folder;
  }

  #name(salt: Hex): string {
    if (!/^0x[0-9a-f]{64}$/.test(salt)) throw new Error(`a channel salt must be 32 bytes of lowercase hex, not ${salt}`);
    return `${salt.slice(2)}.json`;
  }

  /** Writes a new record; refuses to replace one. */
  async create(record: ChannelRecord): Promise<void> {
    await this.#folder.ensure();
    await this.#folder.create(this.#name(record.salt), `${JSON.stringify(record, null, 2)}\n`);
  }

  async save(record: ChannelRecord): Promise<void> {
    await this.#folder.ensure();
    await this.#folder.write(this.#name(record.salt), `${JSON.stringify(record, null, 2)}\n`);
  }

  async load(salt: Hex): Promise<ChannelRecord | null> {
    const name = this.#name(salt);
    const text = await this.#folder.read(name);
    if (text === undefined) return null;
    return this.#check(JSON.parse(text) as ChannelRecord, name);
  }

  /** Removes a record whose open was never signed. */
  async remove(salt: Hex): Promise<void> {
    await this.#folder.remove(this.#name(salt));
  }

  /** Every record of this chain and token, oldest first. */
  async list(chainId: number, token: Address): Promise<ChannelRecord[]> {
    await this.#folder.ensure();
    const out: ChannelRecord[] = [];
    for (const name of await this.#folder.list()) {
      if (!name.endsWith(".json")) continue;
      const text = await this.#folder.read(name);
      if (text === undefined) continue;
      const record = this.#check(JSON.parse(text) as ChannelRecord, name);
      if (record.chainId === chainId && getAddress(record.token) === getAddress(token)) out.push(record);
    }
    return out.sort((x, y) => x.createdAt - y.createdAt);
  }

  #check(record: ChannelRecord, name: string): ChannelRecord {
    if (record.version !== 1 || this.#name(record.salt) !== name || !/^0x[0-9a-f]{64}$/.test(record.channel)) throw new Error(`corrupt channel record ${name}`);
    for (const a of [record.vault, record.payee, record.voucherKey, record.token]) {
      if (!isAddress(a, { strict: false })) throw new Error(`corrupt channel record ${name}`);
    }
    return record;
  }
}

export type OpenChannelInput = {
  payee: string;
  deposit: string;
  gracePeriod: number;
  recipients?: { recipient: string; bps: number }[] | undefined;
  /** Set by `pay`. */
  pay?: PayChannelState | undefined;
};

export type OpenChannelResult =
  | {
      status: "open";
      channel: Hex;
      /** The channel's config, as vouchers and close requests carry it. */
      config: ChannelConfig;
      payee: Address;
      receiver: Address;
      deposit: string;
      gracePeriod: number;
      recipients: ChannelRecipient[];
      voucherKey: Address;
      txHash: Hash | null;
      vaultNonce: string | null;
      note?: string;
    }
  | { status: "not_opened"; resent: ResentSpend; vaultNonce: string; note: string };

export type ChannelView = {
  channel: Hex;
  status: ChannelStatus | "opening";
  payee: Address;
  receiver: Address;
  /** Escrow in the channel (deposits less what came back). */
  deposit: string;
  /** Claimed by the payee side with vouchers; null while opening. */
  claimed: string | null;
  gracePeriod: number;
  voucherKey: Address;
  closeRequested: boolean;
  /** For a channel `pay` opened: unused deposit, end of its life and payments made from it. */
  pay?: { capacity: string; expiresAt: string; payments: number };
};

export type CloseChannelResult = {
  channel: Hex;
  status: ChannelStatus;
  deposit: string;
  /** Claimed by the payee side by vouchers. */
  claimed: string;
  sent: { step: string; txHash: Hash }[];
  next?: string;
  note?: string;
};

function randomSalt(): Hex {
  return bytesToHex(randomBytes(32));
}

export class ChannelService {
  readonly #client: PublicClient;
  readonly #config: Config;
  readonly #keys: Keys;
  readonly #vault: VaultService;
  readonly #sender: Sender;
  readonly #store: ChannelStore;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(client: PublicClient, config: Config, keys: Keys, vault: VaultService, sender: Sender) {
    this.#client = client;
    this.#config = config;
    this.#keys = keys;
    this.#vault = vault;
    this.#sender = sender;
    this.#store = new ChannelStore(keys.folder.folder(CHANNELS_DIR));
    vault.setChannelOpeningListener((opening) => this.#recordOpening(opening));
  }

  /** One channel operation at a time: close steps of a channel must not race. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #token(): Address {
    return this.#config.deployment.token;
  }

  #newRecord(vault: Address, opening: ChannelOpening, recipients: ChannelRecipient[] | null): ChannelRecord {
    const o = opening.open;
    return {
      version: 1,
      salt: o.salt.toLowerCase() as Hex,
      chainId: this.#config.chainId,
      token: this.#token(),
      vault,
      channel: opening.channel,
      config: opening.config,
      payee: getAddress(o.receiverAuthorizer),
      voucherKey: getAddress(o.payerAuthorizer),
      deposit: o.amount.toString(),
      gracePeriod: o.withdrawDelay,
      recipients,
      createdAt: Math.floor(Date.now() / 1000),
      closeRequested: false,
      finished: false,
      steps: [],
    };
  }

  /**
   * Records a channel open before it can land: one this service opens has its
   * record already; another (a relayer channel, or an open resent after the
   * machine was restored from the seed) gets one now from its config.
   */
  async #recordOpening(opening: ChannelOpening): Promise<void> {
    const salt = opening.open.salt.toLowerCase() as Hex;
    if ((await this.#store.load(salt)) !== null) return;
    await this.#store.create(this.#newRecord(await this.#vault.vaultAddress(), opening, null));
  }

  async #read(channel: Hex): Promise<ChannelState> {
    return readChannel(this.#client, this.#config.deployment.batchSettlement, channel);
  }

  /**
   * True while the channel's open is signed and waits to be sent: the
   * channel holds nothing yet and the vault's pending spend is its open. (A
   * channel that held its deposit and gave it all back also holds nothing;
   * its open is no longer pending.)
   */
  async #opening(record: ChannelRecord, ch: ChannelState): Promise<boolean> {
    if (ch.balance !== 0n || ch.totalClaimed !== 0n || ch.pendingWithdrawal !== null) return false;
    return (await this.#vault.status()).pendingChannelOpen?.channel === record.channel;
  }

  open(input: OpenChannelInput): Promise<OpenChannelResult> {
    return this.#serial(async () => {
      if (!isAddress(input.payee, { strict: false })) throw new RangeError(`${input.payee} is not an address`);
      const payee = getAddress(input.payee);
      const deposit = parseTokenAmount(input.deposit);
      if (deposit === 0n) throw new RangeError("deposit must be greater than zero");
      const gracePeriod = parseGracePeriod(input.gracePeriod);
      const recipients = parseRecipients(input.recipients ?? []);
      const payeeVault = await readVault(this.#client, this.#config.deployment, payee);
      if (payeeVault === null) throw new Error(`${payee} is not an Ostra vault; open_channel pays Ostra vaults only (pay other sellers with pay)`);
      if (payeeVault.token !== this.#token()) throw new Error(`the payee vault holds ${payeeVault.token}, not ${this.#token()}`);
      const receiver = await splitAddress(this.#client, this.#config, payee, recipients);

      const salt = randomSalt();
      const voucher: PrivateKeyAccount = this.#keys.channelVoucherSigner(this.#config.chainId, this.#token(), salt);
      const open: OpenChannelParams = { payerAuthorizer: voucher.address, receiver, receiverAuthorizer: payee, withdrawDelay: gracePeriod, salt, amount: deposit };
      const vault = await this.#vault.vaultAddress();
      const opened = { status: "open" as const, payee, receiver, deposit: formatTokenAmount(deposit), gracePeriod, recipients, voucherKey: voucher.address };

      let record: ChannelRecord | null = null;
      let result;
      try {
        result = await this.#vault.openChannel(open, async (opening) => {
          record = this.#newRecord(vault, opening, recipients);
          if (input.pay !== undefined) record.pay = input.pay;
          await this.#store.create(record);
        });
      } catch (err) {
        const stored = await this.#store.load(salt);
        if (stored === null) throw err;
        const ch = await this.#read(stored.channel);
        if (ch.balance > 0n) {
          return { ...opened, channel: stored.channel, config: stored.config, txHash: null, vaultNonce: null, note: `the channel is open; its confirmation was not seen (${(err as Error).message})` };
        }
        const pending = (await this.#vault.status()).pendingChannelOpen;
        if (pending?.channel !== stored.channel) await this.#store.remove(salt);
        throw err;
      }
      if (result.status === "resent_pending") {
        return { status: "not_opened", resent: result.resent, vaultNonce: result.vaultNonce, note: result.note };
      }
      const saved = (await this.#store.load(salt)) ?? record;
      if (saved === null) throw new Error("the channel record was not written before the open was signed");
      saved.openTxHash = result.txHash;
      await this.#store.save(saved);
      return { ...opened, channel: result.channel, config: result.config, txHash: result.txHash, vaultNonce: result.vaultNonce };
    });
  }

  /** Channels opened from this vault that are not finished, with their on-chain state. */
  list(): Promise<ChannelView[]> {
    return this.#serial(async () => {
      const out: ChannelView[] = [];
      for (const record of await this.#store.list(this.#config.chainId, this.#token())) {
        if (record.finished) continue;
        const view = {
          channel: record.channel,
          payee: record.payee,
          receiver: getAddress(record.config.receiver),
          gracePeriod: record.gracePeriod,
          voucherKey: record.voucherKey,
          closeRequested: record.closeRequested,
          ...(record.pay === undefined
            ? {}
            : { pay: { capacity: formatTokenAmount(payCapacity(record)), expiresAt: new Date(record.pay.expiresAt * 1000).toISOString(), payments: record.pay.payments.length } }),
        };
        const ch = await this.#read(record.channel);
        if (await this.#opening(record, ch)) {
          out.push({ ...view, status: "opening", deposit: formatTokenAmount(BigInt(record.deposit)), claimed: null });
          continue;
        }
        const status = channelStatus(ch);
        if (status === "closed") {
          record.finished = true;
          await this.#store.save(record);
          continue;
        }
        out.push({ ...view, status, deposit: formatTokenAmount(ch.balance), claimed: formatTokenAmount(ch.totalClaimed) });
      }
      return out;
    });
  }

  /**
   * Closes `channelText` on the payer path. A channel of this vault with no
   * record here (the machine was restored from the seed) is adopted from
   * `config` when given, else from its open read back from the chain.
   */
  close(channelText: string, config?: ChannelConfig): Promise<CloseChannelResult> {
    return this.#serial(async () => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(channelText)) throw new RangeError(`${channelText} is not a channel id (32 bytes of hex)`);
      const channel = channelText.toLowerCase() as Hex;
      const vault = await this.#vault.vaultAddress();
      let record = (await this.#store.list(this.#config.chainId, this.#token())).find((r) => r.channel === channel) ?? null;
      if (record === null) {
        const cfg = config ?? (await recoverChannelConfig(this.#client, this.#config, vault, channel));
        if (cfg === null) throw new Error(`channel ${channel} was not opened by this agent's vault`);
        const d = this.#config.deployment;
        if (computeChannelId(cfg, this.#config.chainId, d.batchSettlement).toLowerCase() !== channel || getAddress(cfg.payer) !== vault || getAddress(cfg.token) !== d.token) {
          throw new Error(`channel ${channel} was not opened by this agent's vault`);
        }
        const voucher = this.#keys.channelVoucherSigner(this.#config.chainId, d.token, cfg.salt);
        if (voucher.address !== getAddress(cfg.payerAuthorizer)) throw new Error(`channel ${channel} uses a voucher key this machine cannot derive`);
        const ch = await this.#read(channel);
        const open: OpenChannelParams = {
          payerAuthorizer: cfg.payerAuthorizer,
          receiver: cfg.receiver,
          receiverAuthorizer: cfg.receiverAuthorizer,
          withdrawDelay: cfg.withdrawDelay,
          salt: cfg.salt,
          amount: ch.balance > 0n ? ch.balance : 1n,
        };
        record = this.#newRecord(vault, { open, config: cfg, channel }, null);
        record.deposit = ch.balance.toString();
        await this.#store.create(record);
      }
      if (!record.closeRequested) {
        record.closeRequested = true;
        await this.#store.save(record);
      }
      return this.#advance(record);
    });
  }

  /** Channels `pay` opened that are not finished. */
  payRecords(): Promise<ChannelRecord[]> {
    return this.#serial(async () => (await this.#store.list(this.#config.chainId, this.#token())).filter((r) => r.pay !== undefined && !r.finished));
  }

  /**
   * Changes the stored record of a channel `pay` opened: `mutate` gets the
   * record as it is on disk now (a close may have changed it since it was
   * listed), and the result is saved and returned.
   */
  updatePayRecord(salt: Hex, mutate: (record: ChannelRecord & { pay: PayChannelState }) => void): Promise<ChannelRecord & { pay: PayChannelState }> {
    return this.#serial(async () => {
      const record = await this.#store.load(salt);
      if (record === null || record.pay === undefined) throw new Error(`no channel record of pay with salt ${salt}`);
      const withPay = record as ChannelRecord & { pay: PayChannelState };
      mutate(withPay);
      await this.#store.save(withPay);
      return withPay;
    });
  }

  /** The voucher key of a channel, derived again from the master seed and the channel salt. */
  voucherSigner(record: ChannelRecord): PrivateKeyAccount {
    return this.#keys.channelVoucherSigner(record.chainId, record.token, record.salt);
  }

  /** Continues every close that was asked for; returns one message per channel that failed. */
  continueClosing(): Promise<string[]> {
    return this.#serial(async () => {
      const failures: string[] = [];
      for (const record of await this.#store.list(this.#config.chainId, this.#token())) {
        if (record.finished || !record.closeRequested) continue;
        try {
          await this.#advance(record);
        } catch (err) {
          failures.push(`channel ${record.channel}: ${(err as Error).message}`);
        }
      }
      return failures;
    });
  }

  async #send(record: ChannelRecord, sent: { step: string; txHash: Hash }[], step: string, call: { to: Address; data: Hex }): Promise<void> {
    await this.#vault.requireEth(VAULT_SPEND_GAS, `send ${step}`, this.#sender);
    const txHash = await this.#sender.send([call]);
    sent.push({ step, txHash });
    record.steps.push({ step, txHash, at: Math.floor(Date.now() / 1000) });
    await this.#store.save(record);
  }

  /** Runs every close step that is possible now. */
  async #advance(record: ChannelRecord): Promise<CloseChannelResult> {
    const sent: { step: string; txHash: Hash }[] = [];
    const channel = record.channel;
    const report = (ch: ChannelState, extra: { next?: string; note?: string } = {}): CloseChannelResult => ({
      channel,
      status: channelStatus(ch),
      deposit: formatTokenAmount(ch.balance),
      claimed: formatTokenAmount(ch.totalClaimed),
      sent,
      ...extra,
    });
    if (getAddress(record.config.payer) !== getAddress(record.vault)) throw new Error(`channel ${channel} does not belong to this vault's record`);
    for (let i = 0; i < MAX_STEPS_PER_CALL; i++) {
      const ch = await this.#read(channel);
      const status = channelStatus(ch);
      if (status === "closed") {
        if (await this.#opening(record, ch)) {
          return report(ch, { next: "the channel's open is signed and not landed yet; the next open_channel or withdraw call sends it, and the close goes on after it" });
        }
        record.finished = true;
        await this.#store.save(record);
        return report(ch, { note: "nothing of the deposit is left unclaimed: what the payee did not claim is back in the vault, and the payee's keeper pays out what it claimed" });
      }
      try {
        if (status === "open") {
          const voucher = this.voucherSigner(record);
          if (voucher.address !== getAddress(record.config.payerAuthorizer)) throw new Error(`the voucher key of channel ${channel} could not be derived`);
          const amount = ch.balance - ch.totalClaimed;
          const closeNonce = await this.#client.readContract({ address: record.vault, abi: ostraVaultAbi, functionName: "closeNonce", args: [channel] });
          const deadline = (await chainTime(this.#client)) + CLOSE_REQUEST_TTL_SECONDS;
          const signature = await voucher.sign({ hash: closeDigest({ chainId: this.#config.chainId, vault: record.vault, channelId: channel, amount, nonce: closeNonce, deadline }) });
          const data = encodeFunctionData({ abi: ostraVaultAbi, functionName: "requestClose", args: [record.config, amount, deadline, signature] });
          await this.#send(record, sent, "request_close", { to: record.vault, data });
          continue;
        }
        // closing: a timed withdrawal runs.
        const pending = ch.pendingWithdrawal as NonNullable<ChannelState["pendingWithdrawal"]>;
        const finalizeAt = pending.initiatedAt + BigInt(record.config.withdrawDelay);
        const now = await chainTime(this.#client);
        if (now < finalizeAt) {
          return report(ch, {
            next: `the grace period ends at ${new Date(Number(finalizeAt) * 1000).toISOString()}; the payee's keeper can still claim its last voucher and refund the rest until then, and the server finishes the close after it`,
          });
        }
        const data = encodeFunctionData({ abi: ostraVaultAbi, functionName: "finalizeWithdraw", args: [record.config] });
        await this.#send(record, sent, "finalize_withdraw", { to: record.vault, data });
      } catch (err) {
        // The channel can move between the read above and the step chosen from it: the payee's keeper
        // claims and refunds as soon as it sees the close request, which can make this vault's own
        // finalizeWithdraw fail. A step that failed on a channel that moved is read again and the close
        // goes on from where the channel stands; a failure on a channel that did not move is reported.
        if (!channelMoved(ch, await this.#read(channel))) throw err;
      }
    }
    return report(await this.#read(channel), { next: "more steps remain; call close_channel again" });
  }
}
