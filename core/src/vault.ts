// The agent's own vaults: open one, read it, withdraw from it, open channels
// from it, change its crank.
//
// Vaults per (chain, token), all derived from the master seed, each with its
// own WOTS keychain (key index = the vault's on-chain nonce), so they never
// sign with the same one-time key:
//   * the buyer vault: keychain vaultKeychainId(chain, token), no crank;
//     it pays (withdraw, open_channel);
//   * the seller vault: keychain sellerKeychainId(chain, token), created by
//     accept_payments with the keeper crank (the crank it was created with is
//     part of its CREATE2 address, kept in the seller record, see seller.ts);
//     payments to the seller land in it. It does not open channels;
//   * private vault `index`: keychain privateVaultKeychainId(chain, token,
//     index), no crank, created by unshield together with the leaf spent
//     into it (unshield.ts); it pays like the buyer vault, with its own
//     relayer channels and records (keys.forPrivateVault).
// Every vault spend is signed only after the checks that could make it fail
// on-chain have passed, because a signed message that never lands blocks the
// vault until it is sent (see pending.ts). With the relayer paying (relay.ts),
// that includes a relayer channel with unused deposit for its price, kept
// for it until it is sent; the buyer vault opens the relayer channels.
//
// On Robinhood Chain (design v0.4) a vault is a beacon proxy at a CREATE2
// address of (token, initial key root, initial crank) and holds its tokens
// itself (no token account, no rent); a channel is an x402 batch-settlement
// channel whose id is fixed by its config, so an open is sent once (on Solana
// each send of an open had its own slot and channel address).
//
// Recovery (design v0.4, when the device and the seed are lost): the owner
// sets the vault's guardians and policy (setGuardian, setRecoveryPolicy); a
// guardian vault supports moving another vault to a new seed's key
// (supportRecovery); the new device adopts the vault (requestRecovery) and
// gives its guardians the key root to support. Once the delay is over, the
// new seed's first spend finishes the recovery on-chain, and the vault is
// this seed's from then on. Any spend by the current key cancels a recovery.

import { bytesToHex, encodeAbiParameters, encodeFunctionData, getAddress, isAddress, keccak256, zeroAddress, type Address, type Hash, type Hex, type PrivateKeyAccount, type PublicClient, type Transport } from "viem";
import {
  LAUNCHPAD,
  VAULT_ACTION,
  channelId as computeChannelId,
  decodeDevBuyParams,
  decodeLaunch,
  decodeLaunchFromVaultData,
  decodeVaultSpendMessage,
  encodeLaunch,
  launchFromVaultData,
  launchHash,
  reservedSwapGas,
  type DevBuyTerms,
  type LaunchParams,
  fromHex,
  openChannelParams,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  readRecovery,
  readVault,
  setRecoveryPolicyParams,
  signVaultOpenChannel,
  signVaultSetCrankKey,
  signVaultSetGuardian,
  signVaultSetRecoveryPolicy,
  signVaultSupportRecovery,
  signVaultTransfer,
  setCrankParams,
  transferParams,
  usdgAbi,
  WotsKeyMismatchError,
  vaultAddress as computeVaultAddress,
  vaultChannelConfig,
  type ChannelConfig,
  type OpenChannelParams,
  type RelayCall,
  type SignedSpend,
  type VaultState,
  type WotsKeychain,
} from "@ostraagent/sdk";
import { formatEth, formatTokenAmount, parseTokenAmount, TOKEN_DECIMALS } from "./amount.ts";
import { chainTime, ethBalance, tokenBalance, tokenDecimals } from "./chain.ts";
import { VAULT_SOFT_LIMIT, type Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import { decodeVaultOpenChannelMessage, decodeVaultSetCrankKeyMessage, decodeVaultSpendHeader, decodeVaultTransferMessage } from "./pending.ts";
import { randomBytes } from "./random.ts";
import { LocalSender, PendingSpendUnpaidError, VAULT_SPEND_GAS, type OpenRelayerChannel, type RelayerChannelTerms, type Reservation, type Sender, type SendOptions } from "./relay.ts";

/** Gas a createVault uses: 240,969 measured on the fork (17 Oct 2026), rounded up. */
const CREATE_VAULT_GAS = 300_000n;
/**
 * Gas a vault-funded launch with a dev buy is reserved for when it is sent
 * again without a quote (a launch signed earlier): 2.95 million measured on
 * the fork (18 Oct 2026, three tiers, a vesting), with room for more tiers.
 * A new launch is reserved for what its quote measured (launchpad.ts).
 */
export const DEV_BUY_LAUNCH_GAS = 4_500_000n;
/** The local fee payer must hold this many times a transaction's gas at the current gas price (as the keeper funds its crank: 2x). */
const ETH_HEADROOM = 2n;
const BACKUP_REMINDER =
  "no encrypted backup of the master seed has been exported from this machine; the owner should run `npx -y @ostraagent/mcp backup export <file>` (from source: `node src/backup-cli.ts export <file>`) in a terminal and keep the file and passphrase off this machine";

export type OpenVaultResult = {
  vault: Address;
  token: Address;
  nonce: string;
  created: boolean;
  txHash?: Hash;
  softLimit: string;
  backupReminder?: string;
  note?: string;
};

export type PendingWithdrawal = { destination: Address; amount: string };
export type PendingChannelOpen = { channel: Hex; receiver: Address; receiverAuthorizer: Address; deposit: string; voucherKey: Address };
/** A crank change signed and not landed; `crank` null removes the crank. */
export type PendingCrankChange = { crank: Address | null };

/**
 * buyer: the vault that pays; seller: the vault payments to the seller land
 * in; private: a vault unshield created; creator: the vault a launch pays its
 * creator's share to (OstraLaunchpad creatorVault), with its own records and
 * relayer client (Keys.forCreatorVault), so paying the relayer for it does
 * not tie it to the buyer vault; token: the vault of a token other than the
 * relayer's (a token the launchpad launched, WETH) with keychain
 * vaultKeychainId(chain, that token), which receives what the buyer vault buys
 * and spends only through `operate` (swap, transfer, claim dividend), its
 * relayer requests paid by the buyer vault (launchpad.ts).
 */
export type VaultKind = "buyer" | "seller" | "private" | "creator" | "token";

export type BalanceResult = {
  chainId: number;
  token: Address;
  vault: Address;
  vaultExists: boolean;
  balance: string;
  nonce: string | null;
  softLimit: string;
  overSoftLimit: boolean;
  pendingWithdrawal: PendingWithdrawal | null;
  pendingChannelOpen: PendingChannelOpen | null;
  /** Another vault operation (swap, pool settings, dividends, recovery) signed and not landed: its spend action. */
  pendingOperation?: { action: number };
  /** Seller vault only: the crank now on the vault (null: none) and a crank change not landed yet. */
  crank?: Address | null;
  pendingCrankChange?: PendingCrankChange | null;
  feePayer: Address;
  feePayerEth: string;
  backupExported: boolean;
  backupReminder?: string;
};

/** A vault spend signed earlier under the current nonce, sent before a new request. */
export type ResentSpend =
  | { operation: "withdraw"; txHash: Hash; destination: Address; amount: string }
  | { operation: "open_channel"; txHash: Hash; channel: Hex; receiverAuthorizer: Address; deposit: string }
  | { operation: "set_crank"; txHash: Hash; crank: Address | null }
  /** Any other spend action (swap, pool settings, dividends, recovery), sent again as it was signed. */
  | { operation: "vault_spend"; txHash: Hash; action: number };

export type WithdrawResult =
  | { status: "sent"; txHash: Hash; destination: Address; amount: string; vaultNonce: string }
  | { status: "resent_pending"; resent: ResentSpend; vaultNonce: string; note: string };

export type VaultChannelOpenResult =
  | { status: "sent"; txHash: Hash; channel: Hex; config: ChannelConfig; vaultNonce: string }
  | { status: "resent_pending"; resent: ResentSpend; vaultNonce: string; note: string };

export type CrankChangeResult =
  | { status: "sent"; txHash: Hash; crank: Address | null; vaultNonce: string }
  | { status: "unchanged"; crank: Address | null; vaultNonce: string }
  | { status: "resent_pending"; resent: ResentSpend; vaultNonce: string; note: string };

/** The result of a recovery spend (guardian, policy, support). */
export type RecoverySpendResult =
  | { status: "sent"; txHash: Hash; vaultNonce: string }
  | { status: "unchanged"; vaultNonce: string }
  | { status: "resent_pending"; resent: ResentSpend; vaultNonce: string; note: string };

/** A vault's guardian recovery as read from the chain. */
export type RecoveryInfo = {
  vault: Address;
  guardianCount: number;
  /** 0: recovery off. */
  threshold: number;
  delaySeconds: number;
  /** The recovery waiting in the vault's current round; `mine`: it moves the vault to this seed's key. */
  pending: { newKeyRoot: Hex; executableAt: string; ready: boolean; mine: boolean } | null;
};

/** What a new device that lost the old seed does to recover a vault (requestRecovery). */
export type RecoveryRequest = {
  vault: Address;
  /** recovered: the vault's key is this seed's; the others say what is still needed. */
  status: "waiting_for_guardians" | "other_recovery_pending" | "waiting_for_delay" | "ready" | "recovered";
  /** The key root the guardians support: this seed's key at the vault's current nonce. */
  newKeyRoot: Hex;
  nonce: string;
  recovery: RecoveryInfo;
  note: string;
};

/** A signed channel open about to be sent (new or resent): its params, its config and its channel id. */
export type ChannelOpening = { open: OpenChannelParams; config: ChannelConfig; channel: Hex };

/**
 * A vault operation built outside this file (launchpad.ts: swaps, pool
 * settings, airdrops, dividends, launches): `build` runs its checks once any
 * spend signed earlier was sent, then signs with `keychain` at `v` as the
 * last step and returns the calls to send.
 */
export type VaultOperation = {
  /** Gas the transaction is reserved for before it is signed. */
  gas: bigint;
  /** ETH the transaction sends (a vault-funded launch's fee: the relayer fronts it and charges it). */
  value?: bigint;
  /** What the spend moves out of this vault (a relayer channel opened for it leaves that much in the vault). */
  moves?: bigint;
  /** What the operation is, for messages. */
  what: string;
  build: (a: { v: VaultState; vault: Address; keychain: WotsKeychain; chainId: number }) => Promise<RelayCall[]>;
};

export type VaultOperationResult =
  | { status: "sent"; txHash: Hash; vaultNonce: string }
  | { status: "resent_pending"; resent: ResentSpend; vaultNonce: string; note: string };

/** The gas a vault spend is reserved for: VAULT_SPEND_GAS, plus the swapGas a Swap among `calls` reserves (sdk reservedSwapGas). */
export function spendGas(calls: readonly RelayCall[]): bigint {
  return calls.reduce((gas, c) => gas + reservedSwapGas(c), VAULT_SPEND_GAS);
}

/** The calldata of OstraVault.spend for a signed spend. */
export function spendCall(vault: Address, s: { action: number; nextKeyRoot: Hex; params: Hex; signature: Hex }): RelayCall {
  return { to: vault, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [s.action, s.nextKeyRoot, s.params, s.signature] }) };
}

export class VaultService {
  readonly kind: VaultKind;
  /** The token the vault holds: the deployment's (USDG), or a token vault's own. */
  readonly token: Address;
  /** The private vault's number (kind "private"), else null. */
  readonly privateIndex: bigint | null;
  readonly #client: PublicClient;
  readonly #transport: Transport;
  readonly #config: Config;
  readonly #keys: Keys;
  readonly #keychain: WotsKeychain;
  readonly #sender: Sender;
  /** The crank the vault was created with (part of its address); unknown for a seller vault until setInitCrank. */
  #initCrank: Address | null;
  /** A vault this seed recovered (requestRecovery) instead of the one it creates; undefined until read. */
  #adopted: Address | null | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #onChannelOpening: ((opening: ChannelOpening) => Promise<void>) | null = null;

  constructor(client: PublicClient, transport: Transport, config: Config, keys: Keys, sender: Sender, kind: VaultKind = "buyer", privateIndex: bigint | null = null, vaultToken: Address | null = null) {
    if ((kind === "private") !== (privateIndex !== null)) throw new Error("a private vault, and only a private vault, has an index");
    // A token vault names its token; a creator vault may name a pair's token (a stock token, WETH for ETH) instead of USDG.
    if (kind === "token" && vaultToken === null) throw new Error("a token vault names its token");
    if (vaultToken !== null && kind !== "token" && kind !== "creator") throw new Error("only a token vault or a creator vault names its token");
    if (vaultToken !== null && getAddress(vaultToken) === config.deployment.token) throw new Error(`the vault in ${vaultToken} is the ${kind === "creator" ? "USDG creator vault, named without a token" : "buyer vault, not a token vault"}`);
    this.kind = kind;
    this.token = vaultToken === null ? config.deployment.token : getAddress(vaultToken);
    this.privateIndex = privateIndex;
    this.#client = client;
    this.#transport = transport;
    this.#config = config;
    this.#keys = keys;
    this.#sender = sender;
    const token = this.token;
    this.#keychain =
      kind === "buyer" || kind === "token"
        ? keys.vaultKeychain(config.chainId, token)
        : kind === "seller"
          ? keys.sellerKeychain(config.chainId, token)
          : kind === "creator"
            ? keys.creatorKeychain(config.chainId, token)
            : keys.privateVaultKeychain(config.chainId, token, privateIndex as bigint);
    this.#initCrank = kind === "seller" ? null : zeroAddress;
  }

  /** Seller vault: the crank it is (or will be) created with, which is part of its address. */
  setInitCrank(crank: Address): void {
    if (this.kind !== "seller") throw new Error(`the ${this.kind} vault is created without a crank`);
    if (!isAddress(crank, { strict: false })) throw new RangeError("a crank is an address");
    this.#initCrank = getAddress(crank);
  }

  /** A vault in the deployment's token (USDG); else a token vault or a pair's creator vault, paid for by the buyer vault. */
  #inUsdg(): boolean {
    return this.token === this.#config.deployment.token;
  }

  #missing(): string {
    if (this.kind === "private") return `private vault ${this.privateIndex} does not exist yet; unshield creates it`;
    if (this.kind === "creator") return `this agent has no creator vault${this.#inUsdg() ? "" : ` in ${this.token}`} yet; open it before a launch names it`;
    if (this.kind === "token") return `this agent has no vault in ${this.token} yet; buying the token creates it`;
    return this.kind === "buyer" ? "this agent has no vault yet; call open_vault first" : "this agent has no seller vault yet; call accept_payments first";
  }

  /** Runs vault operations one at a time (each reads the nonce it signs with). */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = () => fn().catch(async (err: unknown) => {
      throw await this.#explain(err);
    });
    const run = this.#queue.then(guarded, guarded);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** A key mismatch on a vault this seed is recovering: the recovery is not past its delay yet. */
  async #explain(err: unknown): Promise<unknown> {
    if (!(err instanceof WotsKeyMismatchError)) return err;
    const adopted = await this.#adoptedVault().catch(() => null);
    if (adopted === null) return err;
    return new Error(`this seed is recovering ${adopted}: the vault's key becomes this seed's once the guardians' recovery is past its delay (requestRecovery says what it still needs); nothing was signed`, { cause: err });
  }

  /** The record of the vault this seed recovered, kept with this vault's records. */
  #adoptedName(): string {
    return this.kind === "token" ? `adopted-token-vault-${this.token.toLowerCase()}.json` : `adopted-${this.kind}-vault.json`;
  }

  async #adoptedVault(): Promise<Address | null> {
    if (this.#adopted !== undefined) return this.#adopted;
    const text = await this.#keys.folder.read(this.#adoptedName());
    if (text === undefined) {
      this.#adopted = null;
      return null;
    }
    const r = JSON.parse(text) as { chainId?: unknown; token?: unknown; vault?: unknown };
    if (r.chainId !== this.#config.chainId || typeof r.token !== "string" || getAddress(r.token) !== this.token || typeof r.vault !== "string" || !isAddress(r.vault, { strict: false })) {
      throw new Error(`${this.#adoptedName()} is not a recovered vault of chain ${this.#config.chainId} in ${this.token}`);
    }
    this.#adopted = getAddress(r.vault);
    return this.#adopted;
  }

  async vaultAddress(): Promise<Address> {
    const adopted = await this.#adoptedVault();
    if (adopted !== null) return adopted;
    if (this.#initCrank === null) throw new Error(this.#missing());
    const d = this.#config.deployment;
    return computeVaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: this.token, initialKeyRoot: this.#keyRoot(0n), initialCrank: this.#initCrank });
  }

  #keyRoot(index: bigint): Hex {
    return bytesToHex(this.#keychain.keyRoot(index));
  }

  /**
   * The vault's state, with the key this seed signs with: the vault's key
   * root, or, for a vault this seed is recovering, the recovery's new key root
   * once its delay is over (the next spend finishes the recovery).
   */
  async #read(vault: Address): Promise<VaultState | null> {
    const v = await readVault(this.#client, this.#config.deployment, vault);
    if (v === null) return null;
    const mine = this.#keyRoot(v.nonce).toLowerCase();
    if (v.keyRoot.toLowerCase() === mine) return v;
    const r = await readRecovery(this.#client, vault);
    if (r.pending !== null && r.pending.newKeyRoot.toLowerCase() === mine && r.pending.executableAt <= (await chainTime(this.#client))) {
      return { ...v, keyRoot: mine as Hex };
    }
    return v;
  }

  async #checkToken(): Promise<void> {
    if (this.kind === "token") throw new Error(`the vault in ${this.token} spends only through its token operations (sell, transfer, claim dividends)`);
    // A pair's creator vault (in a stock token or WETH) is spent from only through the launchpad: the launch, its pool's
    // settings and paying its payouts out; it neither withdraws USDG nor opens channels.
    if (!this.#inUsdg()) throw new Error(`the creator vault in ${this.token} spends only through the launchpad (launch, pool settings, creator_withdraw)`);
    const decimals = await tokenDecimals(this.#client, this.#config.deployment.token);
    if (decimals !== TOKEN_DECIMALS) throw new Error(`token ${this.#config.deployment.token} has ${decimals} decimals; this package supports ${TOKEN_DECIMALS}`);
  }

  /** USDG refuses transfers from and to a frozen address: a spend that moves tokens there would never land. */
  async #notFrozen(account: Address, what: string): Promise<void> {
    if (await this.#client.readContract({ address: this.#config.deployment.token, abi: usdgAbi, functionName: "isFrozen", args: [account] })) {
      throw new Error(`${what} ${account} is frozen by the token issuer; the token refuses transfers from and to it`);
    }
  }

  /**
   * Called before every send of a channel open (new or resent), so the
   * channel is recorded before it can land.
   */
  setChannelOpeningListener(listener: (opening: ChannelOpening) => Promise<void>): void {
    this.#onChannelOpening = listener;
  }

  /**
   * The local fee payer must hold the ETH for a transaction of `gas` (twice
   * its price now) when it pays; with the relayer paying there is nothing to
   * check.
   */
  async requireEth(gas: bigint, purpose: string, sender: Sender = this.#sender, value = 0n): Promise<void> {
    if (sender.relayed) return;
    const need = gas * (await this.#client.getGasPrice()) * ETH_HEADROOM + value;
    const have = await ethBalance(this.#client, this.#keys.feePayer.address);
    if (have < need) {
      throw new Error(
        `the fee payer ${this.#keys.feePayer.address} has ${formatEth(have)} ETH and needs at least ${formatEth(need)} ETH to ${purpose}; ` +
          "send ETH to that address first, or set OSTRA_RELAYER_URL so the Ostra relayer pays",
      );
    }
  }

  /**
   * How a relayer channel is opened when a payment needs one: the buyer vault
   * and a private vault open it in place (their callers already hold their
   * queue); the seller vault leaves it to the buyer vault's queued opener.
   */
  #opener(): OpenRelayerChannel | undefined {
    return this.#paysRelayer() ? (terms) => this.#openRelayerChannelLocked(terms) : undefined;
  }

  /** The vaults that open relayer channels and pay their own requests: the buyer, a private and the creator vault (not the seller vault nor a token vault). */
  #paysRelayer(): boolean {
    return this.kind !== "seller" && this.kind !== "token" && this.#inUsdg();
  }

  #options(extra: SendOptions = {}): SendOptions {
    const openChannel = this.#opener();
    return openChannel === undefined ? extra : { openChannel, ...extra };
  }

  /** The createVault call of this vault (unshield sends it together with the leaf spent into it). */
  async createCall(): Promise<RelayCall> {
    if (this.#initCrank === null) throw new Error(this.#missing());
    const d = this.#config.deployment;
    return { to: d.vaultFactory, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [this.token, this.#keyRoot(0n), this.#initCrank] }) };
  }

  /** Gas the local fee payer needs to create this vault. */
  createGas(): bigint {
    return CREATE_VAULT_GAS;
  }

  open(): Promise<OpenVaultResult> {
    return this.#serial(async () => {
      if (this.kind === "private") throw new Error("a private vault is created by unshield, together with the leaf spent into it");
      if (this.kind !== "token" && this.#inUsdg()) await this.#checkToken();
      const vault = await this.vaultAddress();
      const token = this.token;
      const softLimit = formatTokenAmount(VAULT_SOFT_LIMIT);
      const existing = await this.#read(vault);
      if (existing !== null) {
        const found: OpenVaultResult = { vault, token, nonce: existing.nonce.toString(), created: false, softLimit };
        if (!(await this.#keys.backupExported())) found.backupReminder = BACKUP_REMINDER;
        return found;
      }
      await this.requireEth(CREATE_VAULT_GAS, "open the vault");
      // The relayer creates the buyer vault before payment (a debt of the vault); the seller vault, a token vault and a
      // pair's creator vault (in another token than USDG) are paid up front by the buyer vault.
      const txHash = await this.#sender.send([await this.createCall()], this.#options({ prepay: this.kind === "seller" || !this.#paysRelayer() }));
      const result: OpenVaultResult = { vault, token, nonce: "0", created: true, txHash, softLimit };
      if (this.#sender.relayed && (this.kind === "buyer" || this.kind === "creator") && this.#paysRelayer()) {
        result.note =
          "the Ostra relayer paid the vault's creation; the vault owes that price, paid with the first voucher of its channel to the relayer, " +
          "which this server opens from the vault once it holds tokens (nothing else is relayed for the vault until then)";
      }
      if (!(await this.#keys.backupExported())) result.backupReminder = BACKUP_REMINDER;
      return result;
    });
  }

  /** The record of the launch the vault's DevBuy spend under `nonce` signs (written before it is signed). */
  #launchName(vault: Address, nonce: bigint): string {
    return `launch-${vault.toLowerCase()}-${nonce}.json`;
  }

  /**
   * Keeps `launch` with `dev` before the vault's DevBuy spend under `nonce`
   * signs it: a DevBuy is sent inside OstraDevBuy.launchFromVault, whose
   * params the signed message only hashes (launchHash), so they are needed to
   * send it again. A device restored from the seed reads the call from the
   * relayer's signature escrow instead.
   */
  async keepLaunch(nonce: bigint, launch: LaunchParams, dev: DevBuyTerms): Promise<void> {
    const vault = await this.vaultAddress();
    await this.#keys.folder.write(this.#launchName(vault, nonce), `${JSON.stringify({ version: 1, vault, nonce: nonce.toString(), launchHash: launchHash(launch, dev), encoded: encodeLaunch(launch, dev) })}\n`);
  }

  /** The launch the DevBuy spend under `nonce` signed, from this device's record or the escrow's call; checked against `hash`. */
  async #signedLaunch(vault: Address, nonce: bigint, hash: Hex): Promise<{ launch: LaunchParams; dev: DevBuyTerms }> {
    const text = await this.#keys.folder.read(this.#launchName(vault, nonce));
    if (text !== undefined) {
      const r = JSON.parse(text) as { encoded?: unknown };
      if (typeof r.encoded === "string" && /^0x[0-9a-fA-F]*$/.test(r.encoded)) {
        const l = decodeLaunch(r.encoded as Hex);
        if (launchHash(l.launch, l.dev).toLowerCase() === hash.toLowerCase()) return l;
      }
    }
    const escrow = this.#keys.escrow;
    if (escrow !== null) {
      const held = await escrow.call(bytesToHex(this.#keychain.keyRoot(nonce)));
      if (held !== null && /^0x/.test(held.data)) {
        const l = decodeLaunchFromVaultData(held.data as Hex);
        if (launchHash(l.launch, l.dev).toLowerCase() === hash.toLowerCase()) return { launch: l.launch, dev: l.dev };
      }
    }
    throw new Error(`the vault signed a launch (launch hash ${hash}) whose params are neither in this device's records nor in the relayer's signature escrow; it cannot be sent from here`);
  }

  /** The spend signed under `nonce` and not landed: this device's record, or the relayer escrow's (keys.ts). */
  async #pending(nonce: bigint): Promise<{ message: string; signature: string } | null> {
    const record = await this.#keychain.signed(nonce);
    return record === undefined ? null : record;
  }

  status(): Promise<BalanceResult> {
    return this.#serial(async () => {
      if (this.kind === "token") throw new Error(`the vault in ${this.token} is read with its token's tools (token_vault)`);
      if (!this.#inUsdg()) throw new Error(`the creator vault in ${this.token} is read with the launchpad's pair tools`);
      const vault = await this.vaultAddress();
      const token = this.#config.deployment.token;
      const v = await this.#read(vault);
      const balance = await tokenBalance(this.#client, token, vault);
      let pendingWithdrawal: PendingWithdrawal | null = null;
      let pendingChannelOpen: PendingChannelOpen | null = null;
      let pendingCrankChange: PendingCrankChange | null = null;
      let pendingOperation: { action: number } | undefined;
      if (v !== null) {
        const p = await this.#pending(v.nonce);
        if (p !== null) {
          const message = fromHex(p.message);
          const header = decodeVaultSpendHeader(message);
          if (header.action === VAULT_ACTION.TRANSFER) {
            const t = decodeVaultTransferMessage(message);
            pendingWithdrawal = { destination: t.to, amount: formatTokenAmount(t.amount) };
          } else if (header.action === VAULT_ACTION.OPEN_CHANNEL) {
            const o = decodeVaultOpenChannelMessage(message).open;
            const config = vaultChannelConfig(vault, token, o);
            pendingChannelOpen = {
              channel: computeChannelId(config, this.#config.chainId, this.#config.deployment.batchSettlement).toLowerCase() as Hex,
              receiver: o.receiver,
              receiverAuthorizer: o.receiverAuthorizer,
              deposit: formatTokenAmount(o.amount),
              voucherKey: o.payerAuthorizer,
            };
          } else if (header.action === VAULT_ACTION.SET_CRANK_KEY) {
            pendingCrankChange = { crank: decodeVaultSetCrankKeyMessage(message).crank };
          } else {
            pendingOperation = { action: header.action };
          }
        }
      }
      const backupExported = await this.#keys.backupExported();
      const status: BalanceResult = {
        chainId: this.#config.chainId,
        token,
        vault,
        vaultExists: v !== null,
        balance: formatTokenAmount(balance),
        nonce: v === null ? null : v.nonce.toString(),
        softLimit: formatTokenAmount(VAULT_SOFT_LIMIT),
        overSoftLimit: balance > VAULT_SOFT_LIMIT,
        pendingWithdrawal,
        pendingChannelOpen,
        ...(pendingOperation === undefined ? {} : { pendingOperation }),
        ...(this.kind === "seller" ? { crank: v === null ? null : v.crank, pendingCrankChange } : {}),
        feePayer: this.#keys.feePayer.address,
        feePayerEth: formatEth(await ethBalance(this.#client, this.#keys.feePayer.address)),
        backupExported,
      };
      if (!backupExported) status.backupReminder = BACKUP_REMINDER;
      return status;
    });
  }

  /**
   * Sends the vault spend signed earlier under the vault's current nonce, if
   * there is one (see pending.ts). Returns what was sent, or null.
   */
  async #sendPending(vault: Address, v: VaultState, sender: Sender, reservation: Reservation | null): Promise<ResentSpend | null> {
    const p = await this.#pending(v.nonce);
    if (p === null) return null;
    const message = fromHex(p.message);
    const signature = `0x${p.signature}` as Hex;
    const header = decodeVaultSpendHeader(message);
    if (header.vault !== vault || header.nonce !== v.nonce || header.chainId !== this.#config.chainId || header.nextKeyRoot.toLowerCase() !== this.#keyRoot(v.nonce + 1n).toLowerCase()) {
      throw new Error("the stored signature does not belong to this vault and nonce");
    }
    const token = this.#config.deployment.token;
    if (header.action === VAULT_ACTION.TRANSFER && this.#inUsdg()) {
      const t = decodeVaultTransferMessage(message);
      await this.#notFrozen(t.to, "the destination of a withdrawal signed earlier,");
      const params = transferParams({ to: t.to, amount: t.amount });
      const txHash = await sender.send([spendCall(vault, { action: VAULT_ACTION.TRANSFER, nextKeyRoot: t.nextKeyRoot, params, signature })], { reservation });
      return { operation: "withdraw", txHash, destination: t.to, amount: formatTokenAmount(t.amount) };
    }
    if (header.action === VAULT_ACTION.OPEN_CHANNEL) {
      const { open, nextKeyRoot } = decodeVaultOpenChannelMessage(message);
      const config = vaultChannelConfig(vault, token, open);
      const channel = computeChannelId(config, this.#config.chainId, this.#config.deployment.batchSettlement).toLowerCase() as Hex;
      if (this.#onChannelOpening !== null) await this.#onChannelOpening({ open, config, channel });
      const params = openChannelParams(open);
      const txHash = await sender.send([spendCall(vault, { action: VAULT_ACTION.OPEN_CHANNEL, nextKeyRoot, params, signature })], { reservation });
      return { operation: "open_channel", txHash, channel, receiverAuthorizer: open.receiverAuthorizer, deposit: formatTokenAmount(open.amount) };
    }
    if (header.action === VAULT_ACTION.SET_CRANK_KEY) {
      const { crank, nextKeyRoot } = decodeVaultSetCrankKeyMessage(message);
      const params = setCrankParams(crank ?? zeroAddress);
      const txHash = await sender.send([spendCall(vault, { action: VAULT_ACTION.SET_CRANK_KEY, nextKeyRoot, params, signature })], { reservation });
      return { operation: "set_crank", txHash, crank };
    }
    if (header.action === VAULT_ACTION.DEV_BUY) {
      // A DevBuy lands only inside the launch it signed (OstraDevBuy.launchFromVault), with the launch fee.
      const s = decodeVaultSpendMessage(message);
      const { devBuy, launchHash: hash } = decodeDevBuyParams(s.params);
      const lp = this.#config.deployment.launchpad;
      if (lp === undefined || getAddress(devBuy) !== lp.devBuy) throw new Error(`the vault signed a DevBuy for ${devBuy}, not this deployment's OstraDevBuy`);
      const l = await this.#signedLaunch(vault, v.nonce, hash);
      const call = { to: lp.devBuy, data: launchFromVaultData(l.launch, l.dev, { nextKeyRoot: s.nextKeyRoot, signature }) };
      const txHash = await sender.send([call], { reservation, value: LAUNCHPAD.FEE_WEI });
      return { operation: "vault_spend", txHash, action: s.action };
    }
    // Any other action: the same signed bytes again. A Swap among them is sent even if it fails now: the key
    // already signed it, so nothing else can be signed with it until it lands.
    const s = decodeVaultSpendMessage(message);
    const txHash = await sender.send([spendCall(vault, { action: s.action, nextKeyRoot: s.nextKeyRoot, params: s.params, signature })], { reservation, allowFailedSwaps: true });
    return { operation: "vault_spend", txHash, action: s.action };
  }

  /**
   * Runs `fn` with what a vault spend needs to be paid. With the relayer: a
   * reservation of unused relayer channel deposit for its price (a channel is
   * opened first if none has room), released once `fn` is done. When a spend
   * signed earlier waits and no relayer channel can pay for it, the local fee
   * payer sends it if it holds the ETH. `moves` is what the spend takes out
   * of this vault: a relayer channel opened from the buyer vault for it
   * leaves that much in the buyer vault.
   */
  async #paidSpend<T>(sender: Sender, fn: (sender: Sender, reservation: Reservation | null) => Promise<T>, moves = 0n, gas = VAULT_SPEND_GAS, extraWei = 0n): Promise<T> {
    // A spend signed earlier is sent first: the reservation covers it too.
    const pending = await this.#pendingCost();
    if (pending.gas > gas) gas = pending.gas;
    if (pending.extraWei > extraWei) extraWei = pending.extraWei;
    let reservation: Reservation | null;
    try {
      reservation = await sender.reserve(gas, sender === this.#sender ? this.#opener() : undefined, this.#paysRelayer() ? moves : 0n, extraWei);
    } catch (err) {
      if (!(err instanceof PendingSpendUnpaidError)) throw err;
      const local = new LocalSender(this.#client, this.#transport, this.#keys.feePayer, this.#keys.escrow);
      const need = gas * (await this.#client.getGasPrice()) * ETH_HEADROOM + extraWei;
      if ((await ethBalance(this.#client, this.#keys.feePayer.address)) < need) {
        throw new Error(`${err.message}; send at least ${formatEth(need)} ETH to the fee payer ${this.#keys.feePayer.address} and call again: it sends that operation itself`);
      }
      return fn(local, null);
    }
    try {
      return await fn(sender, reservation);
    } finally {
      sender.release(reservation);
    }
  }

  /** What sending the spend signed under the vault's current nonce needs: its gas and the ETH it sends (none signed: nothing). */
  async #pendingCost(): Promise<{ gas: bigint; extraWei: bigint }> {
    const none = { gas: 0n, extraWei: 0n };
    const vault = await this.vaultAddress().catch(() => null);
    if (vault === null) return none;
    const v = await this.#read(vault);
    if (v === null) return none;
    const p = await this.#pending(v.nonce);
    if (p === null) return none;
    const s = decodeVaultSpendMessage(fromHex(p.message));
    if (s.action === VAULT_ACTION.DEV_BUY) return { gas: DEV_BUY_LAUNCH_GAS, extraWei: LAUNCHPAD.FEE_WEI };
    return { gas: spendGas([spendCall(vault, { ...s, signature: `0x${p.signature}` })]), extraWei: 0n };
  }

  #balance(vault: Address): Promise<bigint> {
    return tokenBalance(this.#client, this.token, vault);
  }

  /**
   * Runs `op` from this vault: a spend signed earlier is sent first (and `op`
   * is not), then `op` builds and signs its spend and it is sent. `via`
   * sends it another way than this vault's sender.
   */
  operate(op: VaultOperation, via?: Sender): Promise<VaultOperationResult> {
    return this.#serial(async () => {
      const vault = await this.vaultAddress();
      if ((await this.#read(vault)) === null) throw new Error(this.#missing());
      const chosen = via ?? this.#sender;
      await this.requireEth(op.gas, `send ${op.what}`, chosen, op.value ?? 0n);
      return this.#paidSpend(
        chosen,
        async (sender, reservation) => {
          const v = await this.#read(vault);
          if (v === null) throw new Error(this.#missing());
          const resent = await this.#sendPending(vault, v, sender, reservation);
          if (resent !== null) {
            return { status: "resent_pending", resent, vaultNonce: (v.nonce + 1n).toString(), note: `an earlier signed vault operation had not landed and was sent now; ${op.what} was not, call again for it` };
          }
          const calls = await op.build({ v, vault, keychain: this.#keychain, chainId: this.#config.chainId });
          let txHash: Hash;
          try {
            txHash = await sender.send(calls, { reservation, ...(op.value === undefined ? {} : { value: op.value }) });
          } catch (err) {
            throw new Error(`${(err as Error).message}\nthe signed ${op.what} is kept; the next call on this vault sends it again before anything else`);
          }
          return { status: "sent", txHash, vaultNonce: (v.nonce + 1n).toString() };
        },
        op.moves ?? 0n,
        op.gas,
        op.value ?? 0n,
      );
    });
  }

  /** "the vault holds X, less than Y", with where tokens in a relayer channel are when the relayer pays. */
  #short(balance: bigint, what: string): Error {
    const held = this.#sender.relayed ? " (a deposit in a channel to the relayer comes back to the vault when the relayer closes that channel, a few minutes after its last use)" : "";
    return new Error(`the vault holds ${formatTokenAmount(balance)}, less than ${what}${held}`);
  }

  withdraw(destinationText: string, amountText: string, via?: Sender): Promise<WithdrawResult> {
    return this.#serial(async () => {
      const amount = parseTokenAmount(amountText);
      if (amount === 0n) throw new RangeError("amount must be greater than zero");
      if (!isAddress(destinationText, { strict: false })) throw new RangeError(`${destinationText} is not an address`);
      const destination = getAddress(destinationText);
      if (destination === zeroAddress) throw new RangeError("the destination must not be the zero address");
      await this.#checkToken();
      const vault = await this.vaultAddress();
      if ((await this.#read(vault)) === null) throw new Error(this.#missing());
      const chosen = via ?? this.#sender;
      await this.requireEth(VAULT_SPEND_GAS, "send the withdrawal", chosen);

      return this.#paidSpend(chosen, async (sender, reservation) => {
        // Read after the reservation: opening a relayer channel uses the vault's next one-time key.
        const v = await this.#read(vault);
        if (v === null) throw new Error(this.#missing());
        // A spend signed earlier under the current nonce must be sent first.
        const resent = await this.#sendPending(vault, v, sender, reservation);
        if (resent !== null) {
          const vaultNonce = (v.nonce + 1n).toString();
          if (resent.operation === "withdraw" && parseTokenAmount(resent.amount) === amount && resent.destination === destination) {
            return { status: "sent", txHash: resent.txHash, destination, amount: resent.amount, vaultNonce };
          }
          return {
            status: "resent_pending",
            resent,
            vaultNonce,
            note: "an earlier signed vault operation had not landed and was sent now; this withdrawal was not executed, call withdraw again for it",
          };
        }
        if (destination === vault) throw new Error("the destination is the vault itself");
        await this.#notFrozen(vault, "the vault");
        await this.#notFrozen(destination, "the destination");
        const balance = await this.#balance(vault);
        if (balance < amount) throw this.#short(balance, formatTokenAmount(amount));

        const signed: SignedSpend = await signVaultTransfer(this.#keychain, v, { chainId: this.#config.chainId, to: destination, amount });
        let txHash: Hash;
        try {
          txHash = await sender.send([spendCall(vault, signed)], { reservation });
        } catch (err) {
          throw new Error(`${(err as Error).message}\nthe signed withdrawal is kept; the next withdraw or open_channel call sends it again before anything else`);
        }
        return { status: "sent", txHash, destination, amount: formatTokenAmount(amount), vaultNonce: (v.nonce + 1n).toString() };
      }, amount);
    });
  }

  /**
   * OpenChannel spend from this vault: an x402 batch-settlement channel with
   * this vault as payer. `beforeSign` runs once every check has passed, just
   * before the one-time key signs; it must record the channel. A spend signed
   * earlier and not landed is sent instead, and this channel is not opened.
   */
  openChannel(open: OpenChannelParams, beforeSign: (opening: ChannelOpening) => Promise<void>): Promise<VaultChannelOpenResult> {
    return this.#serial(async () => {
      if (this.kind === "seller") throw new Error("channels are not opened from the seller vault");
      await this.#checkToken();
      const vault = await this.vaultAddress();
      if (getAddress(open.receiverAuthorizer) === vault || getAddress(open.receiver) === vault) throw new Error("the channel would pay this agent's own vault");
      if ((await this.#read(vault)) === null) throw new Error(this.#missing());
      await this.requireEth(VAULT_SPEND_GAS, "send the vault operation");

      return this.#paidSpend(this.#sender, async (sender, reservation) => {
        const v = await this.#read(vault);
        if (v === null) throw new Error(this.#missing());
        const resent = await this.#sendPending(vault, v, sender, reservation);
        if (resent !== null) {
          return {
            status: "resent_pending",
            resent,
            vaultNonce: (v.nonce + 1n).toString(),
            note: "an earlier signed vault operation had not landed and was sent now; this channel was not opened, call open_channel again for it",
          };
        }
        await this.#notFrozen(vault, "the vault");
        const balance = await this.#balance(vault);
        if (balance < open.amount) throw this.#short(balance, `the deposit of ${formatTokenAmount(open.amount)}`);
        const config = vaultChannelConfig(vault, this.#config.deployment.token, open);
        const channel = computeChannelId(config, this.#config.chainId, this.#config.deployment.batchSettlement).toLowerCase() as Hex;
        const opening = { open, config, channel };
        await beforeSign(opening);
        const signed = await signVaultOpenChannel(this.#keychain, v, { chainId: this.#config.chainId, open });
        if (this.#onChannelOpening !== null) await this.#onChannelOpening(opening);
        let txHash: Hash;
        try {
          txHash = await sender.send([spendCall(vault, signed)], { reservation });
        } catch (err) {
          throw new Error(`${(err as Error).message}\nthe signed channel open is kept; the next open_channel or withdraw call sends it again before anything else`);
        }
        return { status: "sent", txHash, channel, config, vaultNonce: (v.nonce + 1n).toString() };
      }, open.amount);
    });
  }

  /**
   * Opens a channel from the buyer vault to the relayer on the relayer's
   * terms (relay.ts): the relayer sends it before payment, and its first
   * voucher pays for it. Callers already inside this vault's queue use the
   * unqueued variant (#opener).
   */
  openRelayerChannel(terms: RelayerChannelTerms): Promise<void> {
    return this.#serial(() => this.#openRelayerChannelLocked(terms));
  }

  async #openRelayerChannelLocked(terms: RelayerChannelTerms): Promise<void> {
    if (!this.#paysRelayer()) throw new Error(`relayer channels are not opened from the ${this.kind} vault`);
    await this.#checkToken();
    const vault = await this.vaultAddress();
    const v = await this.#read(vault);
    if (v === null) throw new Error(this.#missing());
    if ((await this.#pending(v.nonce)) !== null) {
      throw new PendingSpendUnpaidError("a vault operation signed earlier waits to be sent and no channel to the relayer has deposit left to pay for it");
    }
    await this.#notFrozen(vault, "the vault");
    const balance = await this.#balance(vault);
    if (balance < terms.amount) throw this.#short(balance, `the relayer channel deposit of ${formatTokenAmount(terms.amount)}`);
    const salt = bytesToHex(randomBytes(32));
    const voucher: PrivateKeyAccount = this.#keys.channelVoucherSigner(this.#config.chainId, this.#config.deployment.token, salt);
    const open: OpenChannelParams = { payerAuthorizer: voucher.address, receiver: terms.receiver, receiverAuthorizer: terms.receiverAuthorizer, withdrawDelay: terms.withdrawDelay, salt, amount: terms.amount };
    const config = vaultChannelConfig(vault, this.#config.deployment.token, open);
    const channel = computeChannelId(config, this.#config.chainId, this.#config.deployment.batchSettlement).toLowerCase() as Hex;
    const signed = await signVaultOpenChannel(this.#keychain, v, { chainId: this.#config.chainId, open });
    if (this.#onChannelOpening !== null) await this.#onChannelOpening({ open, config, channel });
    await this.#sender.send([spendCall(vault, signed)], {});
  }

  /**
   * SetCrankKey spend: installs `crank` (the zero address removes the crank).
   * A spend signed earlier and not landed is sent first; if it was this same
   * crank change, its result is returned. `via` sends it another way than
   * this vault's sender (settle_self and rotate_crank without the relayer).
   */
  setCrankKey(crankText: Address, via?: Sender): Promise<CrankChangeResult> {
    return this.#serial(async () => {
      if (!isAddress(crankText, { strict: false })) throw new RangeError("a crank is an address");
      const crank = getAddress(crankText);
      const target = crank === zeroAddress ? null : crank;
      const vault = await this.vaultAddress();
      if ((await this.#read(vault)) === null) throw new Error(this.#missing());
      const chosen = via ?? this.#sender;
      await this.requireEth(VAULT_SPEND_GAS, "send the vault operation", chosen);

      return this.#paidSpend(chosen, async (sender, reservation) => {
        const v = await this.#read(vault);
        if (v === null) throw new Error(this.#missing());
        const resent = await this.#sendPending(vault, v, sender, reservation);
        if (resent !== null) {
          const vaultNonce = (v.nonce + 1n).toString();
          if (resent.operation === "set_crank" && resent.crank === target) return { status: "sent", txHash: resent.txHash, crank: target, vaultNonce };
          return {
            status: "resent_pending",
            resent,
            vaultNonce,
            note: "an earlier signed vault operation had not landed and was sent now; the crank was not changed, call again for it",
          };
        }
        if (v.crank === target) return { status: "unchanged", crank: target, vaultNonce: v.nonce.toString() };

        const signed = await signVaultSetCrankKey(this.#keychain, v, { chainId: this.#config.chainId, crank });
        let txHash: Hash;
        try {
          txHash = await sender.send([spendCall(vault, signed)], { reservation });
        } catch (err) {
          throw new Error(`${(err as Error).message}\nthe signed crank change is kept; the next call on this vault sends it again before anything else`);
        }
        return { status: "sent", txHash, crank: target, vaultNonce: (v.nonce + 1n).toString() };
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  async #recoveryOf(vault: Address): Promise<RecoveryInfo> {
    const r = await readRecovery(this.#client, vault);
    let pending: RecoveryInfo["pending"] = null;
    if (r.pending !== null) {
      const v = await readVault(this.#client, this.#config.deployment, vault);
      const mine = v !== null && r.pending.newKeyRoot.toLowerCase() === this.#keyRoot(v.nonce).toLowerCase();
      pending = { newKeyRoot: r.pending.newKeyRoot, executableAt: r.pending.executableAt.toString(), ready: r.pending.executableAt <= (await chainTime(this.#client)), mine };
    }
    return { vault, guardianCount: r.guardianCount, threshold: r.threshold, delaySeconds: r.delay, pending };
  }

  /** This vault's guardian recovery: its guardians, policy and the recovery waiting, if any. */
  recovery(): Promise<RecoveryInfo> {
    return this.#serial(async () => {
      const vault = await this.vaultAddress();
      if ((await this.#read(vault)) === null) throw new Error(this.#missing());
      return this.#recoveryOf(vault);
    });
  }

  /**
   * A recovery spend from this vault: a spend signed earlier is sent first
   * (and this one is not); `unchanged` answers without signing when there is
   * nothing to change.
   */
  #recoverySpend(sign: (v: VaultState) => Promise<SignedSpend>, unchanged: (v: VaultState, vault: Address) => Promise<boolean>, via?: Sender): Promise<RecoverySpendResult> {
    return this.#serial(async () => {
      const vault = await this.vaultAddress();
      if ((await this.#read(vault)) === null) throw new Error(this.#missing());
      const chosen = via ?? this.#sender;
      await this.requireEth(VAULT_SPEND_GAS, "send the vault operation", chosen);
      return this.#paidSpend(chosen, async (sender, reservation) => {
        const v = await this.#read(vault);
        if (v === null) throw new Error(this.#missing());
        const resent = await this.#sendPending(vault, v, sender, reservation);
        if (resent !== null) {
          return { status: "resent_pending", resent, vaultNonce: (v.nonce + 1n).toString(), note: "an earlier signed vault operation had not landed and was sent now; this one was not, call again for it" };
        }
        if (await unchanged(v, vault)) return { status: "unchanged", vaultNonce: v.nonce.toString() };
        const signed = await sign(v);
        let txHash: Hash;
        try {
          txHash = await sender.send([spendCall(vault, signed)], { reservation });
        } catch (err) {
          throw new Error(`${(err as Error).message}\nthe signed operation is kept; the next call on this vault sends it again before anything else`);
        }
        return { status: "sent", txHash, vaultNonce: (v.nonce + 1n).toString() };
      });
    });
  }

  /** Adds (enabled) or removes a guardian of this vault: another Ostra vault keeps the recovery post-quantum. */
  async setGuardian(guardianText: string, enabled: boolean, via?: Sender): Promise<RecoverySpendResult> {
    if (!isAddress(guardianText, { strict: false })) throw new RangeError(`${guardianText} is not an address`);
    const guardian = getAddress(guardianText);
    if (guardian === zeroAddress) throw new RangeError("a guardian is not the zero address");
    return this.#recoverySpend(
      (v) => signVaultSetGuardian(this.#keychain, v, { chainId: this.#config.chainId, guardian, enabled }),
      async (_v, vault) => {
        if (guardian === vault) throw new Error("a vault cannot be its own guardian");
        const now = (await this.#client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "isGuardian", args: [guardian] })) as boolean;
        if (now === enabled) return true;
        const r = await readRecovery(this.#client, vault);
        if (enabled && r.guardianCount === 255) throw new Error("the vault has the most guardians it can hold (255)");
        if (!enabled && r.guardianCount - 1 < r.threshold) throw new Error(`removing it would leave ${r.guardianCount - 1} guardians, fewer than the threshold of ${r.threshold}; lower the threshold first`);
        return false;
      },
      via,
    );
  }

  /** Sets how many guardians must support a recovery and how long it then waits (threshold 0 and delay 0: off). */
  async setRecoveryPolicy(threshold: number, delaySeconds: number, via?: Sender): Promise<RecoverySpendResult> {
    setRecoveryPolicyParams({ threshold, delay: delaySeconds });
    return this.#recoverySpend(
      (v) => signVaultSetRecoveryPolicy(this.#keychain, v, { chainId: this.#config.chainId, threshold, delay: delaySeconds }),
      async (_v, vault) => {
        const r = await readRecovery(this.#client, vault);
        if (threshold > r.guardianCount) throw new Error(`the vault has ${r.guardianCount} guardians, fewer than a threshold of ${threshold}`);
        return r.threshold === threshold && r.delay === delaySeconds;
      },
      via,
    );
  }

  /**
   * Cancels a recovery of this vault that waits (the owner still holds the
   * key): any spend does; this one sets the same policy again.
   */
  async cancelRecovery(via?: Sender): Promise<RecoverySpendResult | { status: "nothing_to_cancel" }> {
    const vault = await this.vaultAddress();
    const r = await readRecovery(this.#client, vault);
    if (r.pending === null) return { status: "nothing_to_cancel" };
    return this.#recoverySpend(
      (v) => signVaultSetRecoveryPolicy(this.#keychain, v, { chainId: this.#config.chainId, threshold: r.threshold, delay: r.delay }),
      async () => false,
      via,
    );
  }

  /** As a guardian (this vault), supports moving `vaultText` to `newKeyRootText` (the key root its owner's new device gave). */
  async supportRecovery(vaultText: string, newKeyRootText: string, via?: Sender): Promise<RecoverySpendResult> {
    if (!isAddress(vaultText, { strict: false })) throw new RangeError(`${vaultText} is not an address`);
    const target = getAddress(vaultText);
    if (!/^0x[0-9a-fA-F]{64}$/.test(newKeyRootText) || /^0x0{64}$/.test(newKeyRootText)) throw new RangeError("the new key root is 32 bytes of 0x hex, not zero");
    const newKeyRoot = newKeyRootText.toLowerCase() as Hex;
    return this.#recoverySpend(
      (v) => signVaultSupportRecovery(this.#keychain, v, { chainId: this.#config.chainId, vault: target, newKeyRoot }),
      async (_v, vault) => {
        if (target === vault) throw new Error("a vault cannot support its own recovery");
        const t = await readVault(this.#client, this.#config.deployment, target);
        if (t === null) throw new Error(`${target} is not an Ostra vault`);
        const read = (functionName: string, args: readonly unknown[] = []) => this.#client.readContract({ address: target, abi: ostraVaultAbi, functionName: functionName as never, args: args as never });
        if (!((await read("isGuardian", [vault])) as boolean)) throw new Error(`this vault ${vault} is not a guardian of ${target}`);
        const r = await readRecovery(this.#client, target);
        if (r.threshold === 0) throw new Error(`${target} has recovery turned off`);
        const proposal = keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "bytes32" }], [r.round, newKeyRoot]));
        return (await read("supportedBy", [proposal, vault])) as boolean;
      },
      via,
    );
  }

  /**
   * On a new device that lost the old seed: adopts `vaultText` as this seed's
   * vault of this kind and says what the recovery still needs. The guardians
   * support `newKeyRoot`; once the delay is over, the next operation on the
   * vault finishes the recovery.
   */
  requestRecovery(vaultText: string): Promise<RecoveryRequest> {
    return this.#serial(async () => {
      if (this.kind === "private") throw new Error("a private vault is recovered with the seed that unshielded it");
      if (!isAddress(vaultText, { strict: false })) throw new RangeError(`${vaultText} is not an address`);
      const vault = getAddress(vaultText);
      const v = await readVault(this.#client, this.#config.deployment, vault);
      if (v === null || v.token !== this.token) throw new Error(`${vault} is not an Ostra vault in ${this.token}`);
      const adopted = await this.#adoptedVault();
      if (adopted !== null && adopted !== vault) throw new Error(`this seed already recovers ${adopted} as its ${this.kind} vault`);
      const newKeyRoot = this.#keyRoot(v.nonce).toLowerCase() as Hex;
      const recovery = await this.#recoveryOf(vault);
      if (v.keyRoot.toLowerCase() !== newKeyRoot && recovery.threshold === 0) throw new Error(`${vault} has no guardian recovery set; it cannot be recovered without its seed`);
      if (adopted === null) {
        await this.#keys.folder.write(this.#adoptedName(), `${JSON.stringify({ chainId: this.#config.chainId, token: this.token, vault })}\n`);
        this.#adopted = vault;
      }
      let status: RecoveryRequest["status"];
      let note: string;
      if (v.keyRoot.toLowerCase() === newKeyRoot) {
        status = "recovered";
        note = "the vault's key is this seed's";
      } else if (recovery.pending?.mine === true) {
        status = recovery.pending.ready ? "ready" : "waiting_for_delay";
        note = recovery.pending.ready ? "the next operation on this vault finishes the recovery" : `the recovery waits until ${recovery.pending.executableAt} (unix seconds); any spend by the old key cancels it`;
      } else if (recovery.pending !== null) {
        status = "other_recovery_pending";
        note = `the guardians started a recovery to another key root (${recovery.pending.newKeyRoot}); only a spend by the vault's current key cancels it, so ask the guardians which device it is for`;
      } else {
        status = "waiting_for_guardians";
        note = `give this key root to the vault's guardians: ${recovery.threshold} of ${recovery.guardianCount} must support it; it changes if the vault's nonce moves`;
      }
      return { vault, status, newKeyRoot, nonce: v.nonce.toString(), recovery, note };
    });
  }

  /**
   * The vault's address, whether it exists, its nonce, its balance in base
   * units and the action of a spend signed and not landed (any kind).
   */
  state(): Promise<{ vault: Address; exists: boolean; nonce: bigint | null; balance: bigint; pendingAction: number | null }> {
    return this.#serial(async () => {
      const vault = await this.vaultAddress();
      const v = await this.#read(vault);
      const balance = await this.#balance(vault);
      let pendingAction: number | null = null;
      if (v !== null) {
        const p = await this.#pending(v.nonce);
        if (p !== null) pendingAction = decodeVaultSpendHeader(fromHex(p.message)).action;
      }
      return { vault, exists: v !== null, nonce: v === null ? null : v.nonce, balance, pendingAction };
    });
  }

  /** The crank now on the vault (null: none), or undefined when the vault does not exist. */
  async currentCrank(): Promise<Address | null | undefined> {
    const v = await this.#read(await this.vaultAddress());
    return v === null ? undefined : v.crank;
  }
}
