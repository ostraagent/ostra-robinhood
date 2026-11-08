// The vault's payment wallet (decided 8 Nov 2026, for Autonomo's gateways): a plain secp256k1 account that pays APIs
// whose x402 offer is `exact` in USDG on Robinhood Chain, a transferWithAuthorization (EIP-3009) signed by the payer's
// own key that the seller's facilitator settles, paying the gas. A vault signs no EIP-3009 itself: its EIP-1271 answer
// is an ApproveHash spend, which costs about what one such call does and which an agent key never makes. So each vault
// pays these APIs from a wallet holding a small balance:
//   * its key comes from the master seed and the vault's address (keys.ts paymentWalletSigner): the seed recovers it,
//     and only this machine holds it;
//   * it holds at most PAYMENT_WALLET_MAX (5 USDG), enforced here: a top-up, a vault Transfer to it (the owner's, or on
//     version 5 the agent key's within the policy, with the agent's own wallet, which its seed derives, on the vault's
//     recipient allowlist: the owner puts it there), never leaves it holding more. The MCP's withdraw and PAY orders
//     refuse this wallet as their recipient; for an agent key, the vault's policy (perTx, daily) bounds what it can move
//     there in any case;
//   * a payment signs one authorization for exactly the offer's price to the offer's payTo, valid for the offer's
//     maxTimeoutSeconds (PAYMENT_WALLET_MIN_TIMEOUT_SECONDS to PAYMENT_WALLET_MAX_TIMEOUT_SECONDS), after checking the
//     offer's EIP-712 domain against USDG's on chain; it is recorded before the request carrying it is sent, and counts
//     against the balance until the chain shows it used or its validBefore passes;
//   * what is left goes back to the vault by an authorization the wallet signs to the vault, sent through the relayer
//     (its rule for a USDG transferWithAuthorization into the vault that pays for it) or by the local fee payer; it is
//     recorded before it is sent and counts against the balance like a payment.
// The vault itself stays post-quantum: only this small balance sits behind an ordinary key.
//
// Entries, in the agent's `payment-wallet` folder: <vault>.json, the wallet's record (its address, its payments, its
// top-ups and withdrawals; no secret).

import { bytesToHex, domainSeparator, encodeFunctionData, getAddress, isAddress, parseSignature, zeroAddress, type Address, type Hash, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ALLOW_KIND, VAULT_ACTION, agentMayUse, allowValue, readAllowEntry, readV5, readVault, usdgAbi } from "@ostraagent/sdk";
import { formatTokenAmount, parseTokenAmount } from "./amount.ts";
import { chainTime, tokenBalance } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import { randomBytes } from "./random.ts";
import type { Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import type { V5Change, V5Service } from "./v5.ts";
import type { VaultService } from "./vault.ts";

export const PAYMENT_WALLET_DIR = "payment-wallet";
/** The most the payment wallet holds (5 USDG). */
export const PAYMENT_WALLET_MAX = 5_000_000n;
/** What one top-up from the vault moves, unless a price needs more (1 USDG). */
export const PAYMENT_WALLET_TOP_UP = 1_000_000n;
/** The shortest and longest validity of an authorization the wallet signs for an offer (maxTimeoutSeconds). */
export const PAYMENT_WALLET_MIN_TIMEOUT_SECONDS = 30;
export const PAYMENT_WALLET_MAX_TIMEOUT_SECONDS = 3_600;
/** How long the wallet's authorization of a withdrawal to the vault stays valid (the relayer quotes, is paid, sends). */
const WITHDRAW_VALID_SECONDS = 1_800n;
/** The payments a record keeps beyond those still counted against the balance. */
const KEEP_PAYMENTS = 200;
const KEEP_MOVES = 200;
const BALANCE_READS = 10;
const BALANCE_READ_INTERVAL_MS = 1_000;
/** USDG's EIP-712 version (its DOMAIN_SEPARATOR, checked against name, this version, chain 4663 and its address, 8 Nov 2026). */
const USDG_DOMAIN_VERSION = "1";

/** EIP-3009's TransferWithAuthorization (the type USDG hashes). */
const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export type WalletPayment = {
  url: string;
  payTo: Address;
  /** Base units. */
  amount: string;
  /** The authorization's nonce and validBefore (unix seconds). */
  nonce: Hex;
  validBefore: number;
  at: number;
  /** The seller's HTTP status; null until it answered. */
  status: number | null;
  /** The settlement transaction the seller named (PAYMENT-RESPONSE), or null. */
  transaction: string | null;
};

export type WalletMove = { kind: "top_up" | "withdraw"; amount: string; txHash: Hash; at: number };

/** An authorization the wallet signed to send its balance back to the vault: counted against it until used or expired. */
export type WalletWithdrawal = { amount: string; nonce: Hex; validBefore: number; at: number };

export type PaymentWalletRecord = {
  version: 1;
  chainId: number;
  token: Address;
  vault: Address;
  address: Address;
  createdAt: number;
  payments: WalletPayment[];
  withdrawals: WalletWithdrawal[];
  moves: WalletMove[];
};

/**
 * Whether the vault's agent key can top this wallet up (version 5): the wallet on the recipient allowlist (in force, or
 * waiting for the withdrawal lock's delay), Transfer in the policy.
 */
export type AgentTopUp = { allowlisted: boolean; waiting: boolean; effectiveAt: string | null; transferAllowed: boolean };

export type PaymentWalletStatus = {
  vault: Address;
  address: Address;
  setUp: boolean;
  role: "owner" | "agent key";
  balance: string;
  /** Signed authorizations not used yet and still valid: they may still be settled. */
  reserved: string;
  available: string;
  max: string;
  topUp: string;
  /** As the agent key on version 5: what its top-ups need; else null. */
  agentTopUp: AgentTopUp | null;
  payments: number;
  recent: (Omit<WalletPayment, "amount" | "validBefore" | "at"> & { amount: string; validBefore: string; at: string })[];
};

export type PaymentWalletParts = {
  client: PublicClient;
  config: Config;
  keys: Keys;
  buyer: VaultService;
  v5: V5Service;
  sender: Sender;
  /** The agent's `payment-wallet` folder (PAYMENT_WALLET_DIR in its folder). */
  folder: Folder;
};

export type ExactPayment = {
  url: string;
  required: PaymentRequired;
  offer: PaymentRequirements;
  maxPrice: bigint;
  /** Sends the request again with these headers. */
  send: (headers: Record<string, string>) => Promise<Response>;
};

export type ExactPaid = { answer: Response; paid: bigint | null; address: Address; left: bigint; note?: string };

/** A top-up was sent and landed, but this RPC does not show the wallet's balance yet. */
class TopUpLandedError extends Error {}

const now = () => Math.floor(Date.now() / 1000);
const iso = (seconds: bigint | number) => new Date(Number(seconds) * 1000).toISOString();
const usdg = (units: bigint) => formatTokenAmount(units);

/** Why `r` is not an offer the payment wallet pays (x402 exact, EIP-3009, in `token` on `network`), or null. */
export function exactOfferProblem(r: PaymentRequirements, network: string, token: Address): string | null {
  if (r.scheme !== "exact") return `${r.scheme} (the payment wallet pays exact)`;
  if (r.network !== network) return `exact on ${r.network} (the payment wallet pays on ${network})`;
  if (!isAddress(r.asset, { strict: false }) || getAddress(r.asset) !== token) return `exact in ${r.asset} (the payment wallet pays in ${token})`;
  const extra = r.extra ?? {};
  const method = extra.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") return `exact through ${String(method)} (the payment wallet signs EIP-3009)`;
  if (typeof extra.name !== "string" || typeof extra.version !== "string") return "exact without the token's EIP-712 name and version";
  return null;
}

export class PaymentWallet {
  readonly #p: PaymentWalletParts;
  readonly #domains = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(p: PaymentWalletParts) {
    this.#p = p;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  get #token(): Address {
    return this.#p.config.deployment.token;
  }

  /** The buyer vault, which must exist. */
  async #vault(): Promise<Address> {
    const vault = getAddress(await this.#p.buyer.vaultAddress());
    if ((await readVault(this.#p.client, this.#p.config.deployment, vault)) === null) throw new Error("this agent has no vault yet (open_vault); nothing was signed");
    return vault;
  }

  #signer(vault: Address): PrivateKeyAccount {
    return this.#p.keys.paymentWalletSigner(this.#p.config.chainId, this.#token, vault);
  }

  /** The wallet's address for the buyer vault (nothing is created). */
  async address(): Promise<Address> {
    return this.#signer(await this.#vault()).address;
  }

  async #load(vault: Address, address: Address): Promise<PaymentWalletRecord | null> {
    await this.#p.folder.ensure();
    const text = await this.#p.folder.read(`${vault}.json`);
    if (text === undefined) return null;
    const r = JSON.parse(text) as PaymentWalletRecord;
    if (r.version !== 1 || r.chainId !== this.#p.config.chainId || getAddress(r.token) !== this.#token || getAddress(r.vault) !== vault || getAddress(r.address) !== address) {
      throw new Error(`the payment wallet record ${vault}.json is not this vault's wallet on this chain and token`);
    }
    r.withdrawals ??= [];
    return r;
  }

  async #save(r: PaymentWalletRecord): Promise<void> {
    const t = now();
    const live = r.payments.filter((p) => p.validBefore > t);
    const old = r.payments.filter((p) => p.validBefore <= t).slice(-KEEP_PAYMENTS);
    r.payments = [...old, ...live].sort((x, y) => x.at - y.at);
    r.withdrawals = r.withdrawals.filter((w) => w.validBefore > t);
    r.moves = r.moves.slice(-KEEP_MOVES);
    await this.#p.folder.ensure();
    await this.#p.folder.write(`${r.vault}.json`, `${JSON.stringify(r, null, 2)}\n`);
  }

  async #record(vault: Address, address: Address): Promise<{ r: PaymentWalletRecord; created: boolean }> {
    const r = await this.#load(vault, address);
    if (r !== null) return { r, created: false };
    const fresh: PaymentWalletRecord = { version: 1, chainId: this.#p.config.chainId, token: this.#token, vault, address, createdAt: now(), payments: [], withdrawals: [], moves: [] };
    await this.#save(fresh);
    return { r: fresh, created: true };
  }

  /** What the wallet's signed authorizations still valid and not used yet may take (payments, withdrawals to the vault). */
  async #reserved(r: PaymentWalletRecord): Promise<bigint> {
    const t = await chainTime(this.#p.client);
    let reserved = 0n;
    for (const p of [...r.payments, ...r.withdrawals]) {
      if (BigInt(p.validBefore) <= t) continue;
      const used = (await this.#p.client.readContract({ address: this.#token, abi: usdgAbi, functionName: "authorizationState", args: [r.address, p.nonce] })) as boolean;
      if (!used) reserved += BigInt(p.amount);
    }
    return reserved;
  }

  async #balance(address: Address): Promise<bigint> {
    return tokenBalance(this.#p.client, this.#token, address);
  }

  /** Waits until the RPC shows `address` holding at least `want` (a top-up just landed). */
  async #balanceAtLeast(address: Address, want: bigint): Promise<void> {
    for (let i = 0; i < BALANCE_READS; i++) {
      if ((await this.#balance(address)) >= want) return;
      await new Promise((resolve) => setTimeout(resolve, BALANCE_READ_INTERVAL_MS));
    }
    throw new TopUpLandedError(`the top-up landed, but this RPC does not show the payment wallet ${address} holding ${usdg(want)} yet; call again`);
  }

  async #notFrozen(account: Address, what: string): Promise<void> {
    if ((await this.#p.client.readContract({ address: this.#token, abi: usdgAbi, functionName: "isFrozen", args: [account] })) as boolean) {
      throw new Error(`${what} ${account} is frozen by USDG's issuer; nothing was signed`);
    }
  }

  /** Refuses an EIP-712 domain that is not USDG's on this chain (an authorization signed for it would not be USDG's). */
  async #domainOk(name: string, version: string): Promise<void> {
    const key = `${name}\u0000${version}`;
    if (this.#domains.has(key)) return;
    const onChain = (await this.#p.client.readContract({ address: this.#token, abi: usdgAbi, functionName: "DOMAIN_SEPARATOR" })) as Hex;
    const asked = domainSeparator({ domain: { name, version, chainId: this.#p.config.chainId, verifyingContract: this.#token } });
    if (onChain.toLowerCase() !== asked.toLowerCase()) {
      throw new Error(`the EIP-712 domain name ${JSON.stringify(name)}, version ${JSON.stringify(version)} is not that of ${this.#token} on chain ${this.#p.config.chainId}: nothing was signed`);
    }
    this.#domains.add(key);
  }

  /** As the agent key on version 5: whether it can top the wallet up; null as the owner or before version 5. */
  async #agentTopUp(vault: Address, address: Address): Promise<AgentTopUp | null> {
    if (this.#p.buyer.agentKey === null) return null;
    const s = await readV5(this.#p.client, vault);
    if (s === null) return null;
    const e = await readAllowEntry(this.#p.client, vault, ALLOW_KIND.RECIPIENT, allowValue(ALLOW_KIND.RECIPIENT, address));
    const waiting = !e.inForce && e.from > (await chainTime(this.#p.client));
    return { allowlisted: e.inForce, waiting, effectiveAt: e.from === 0n ? null : iso(e.from), transferAllowed: agentMayUse(s.policy, VAULT_ACTION.TRANSFER) };
  }

  /** Moves `amount` from the vault to the wallet (a vault Transfer), never past PAYMENT_WALLET_MAX. */
  async #topUp(r: PaymentWalletRecord, amount: bigint): Promise<{ txHash: Hash; amount: string }> {
    const before = await this.#balance(r.address);
    if (before + amount > PAYMENT_WALLET_MAX) {
      throw new RangeError(`the payment wallet holds ${usdg(before)}: ${usdg(amount)} more would be above its limit of ${usdg(PAYMENT_WALLET_MAX)}; nothing was signed`);
    }
    const w = await this.#p.buyer.withdraw(r.address, usdg(amount));
    if (w.status !== "sent") throw new Error(`${w.note}; the payment wallet was not topped up`);
    r.moves.push({ kind: "top_up", amount: amount.toString(), txHash: w.txHash, at: now() });
    await this.#save(r);
    await this.#balanceAtLeast(r.address, before + amount);
    return { txHash: w.txHash, amount: usdg(amount) };
  }

  async #statusOf(vault: Address, address: Address, r: PaymentWalletRecord | null): Promise<PaymentWalletStatus> {
    const [balance, reserved, agentTopUp] = await Promise.all([this.#balance(address), r === null ? Promise.resolve(0n) : this.#reserved(r), this.#agentTopUp(vault, address)]);
    const payments = r?.payments ?? [];
    return {
      vault,
      address,
      setUp: r !== null,
      role: this.#p.buyer.agentKey === null ? "owner" : "agent key",
      balance: usdg(balance),
      reserved: usdg(reserved),
      available: usdg(balance > reserved ? balance - reserved : 0n),
      max: usdg(PAYMENT_WALLET_MAX),
      topUp: usdg(PAYMENT_WALLET_TOP_UP),
      agentTopUp,
      payments: payments.length,
      recent: payments.slice(-10).map((p) => ({ ...p, amount: usdg(BigInt(p.amount)), validBefore: iso(p.validBefore), at: iso(p.at) })),
    };
  }

  async status(): Promise<PaymentWalletStatus> {
    const vault = await this.#vault();
    const address = this.#signer(vault).address;
    return this.#statusOf(vault, address, await this.#load(vault, address));
  }

  /**
   * Sets the wallet up: its record, then a first top-up of `amountText` (default PAYMENT_WALLET_TOP_UP while less than
   * that is free in it, never past PAYMENT_WALLET_MAX, and none by default with `agentWalletText`; "0" for none). As the
   * owner on version 5, `agentWalletText` (the wallet an agent key's own server reports: its seed derives it) goes on
   * the vault's recipient allowlist, which that agent key's top-ups need (under the withdrawal lock after its delay). As
   * the agent key, the allowlist entry and Transfer in the policy are the owner's to set: reported, with no top-up by
   * default until they are in force.
   */
  setup(amountText?: string, agentWalletText?: string): Promise<PaymentWalletStatus & { created: boolean; allowlist?: V5Change | { status: "listed"; inForce: boolean; effectiveAt: string }; toppedUp?: { txHash: Hash; amount: string }; note?: string }> {
    return this.#serial(async () => {
      const vault = await this.#vault();
      const address = this.#signer(vault).address;
      const agent = this.#p.buyer.agentKey !== null;
      // The agent's wallet, checked before anything is created or signed.
      let agentWallet: Address | null = null;
      if (agentWalletText !== undefined) {
        if (agent) throw new Error("the agent key's wallet goes on the allowlist from the owner's server (payment_wallet_setup with agentWallet there); nothing was signed");
        if (!isAddress(agentWalletText, { strict: false })) throw new RangeError(`${agentWalletText} is not an address`);
        agentWallet = getAddress(agentWalletText);
        if (agentWallet === address || agentWallet === vault || agentWallet === zeroAddress) {
          throw new RangeError(`agentWallet is the wallet an agent key's own server reports, not ${agentWallet === address ? "this server's own wallet (the owner tops it up without the allowlist)" : agentWallet === vault ? "the vault" : "the zero address"}; nothing was signed`);
        }
        if ((await readV5(this.#p.client, vault)) === null) throw new Error(`the vault ${vault} does not run version 5 yet: an agent key and its allowlist open with it; nothing was signed`);
      }
      const { r, created } = await this.#record(vault, address);
      const notes: string[] = [];
      let allowlist: V5Change | { status: "listed"; inForce: boolean; effectiveAt: string } | undefined;
      if (agentWallet !== null) {
        const e = await readAllowEntry(this.#p.client, vault, ALLOW_KIND.RECIPIENT, allowValue(ALLOW_KIND.RECIPIENT, agentWallet));
        // Allowed when it was never listed, or listed and dropped since (a cancel or a recovery); kept while in force or waiting.
        if (!e.inForce && (e.from === 0n || (await chainTime(this.#p.client)) >= e.from)) {
          allowlist = await this.#p.v5.setAllow("recipient", agentWallet, true);
          if (allowlist.status !== "sent") {
            const s = await this.#statusOf(vault, address, r);
            return { ...s, created, allowlist, note: "an earlier signed vault operation was sent first; call payment_wallet_setup again for the allowlist and the top-up" };
          }
        } else {
          allowlist = { status: "listed", inForce: e.inForce, effectiveAt: iso(e.from) };
        }
      }
      let ready = true;
      if (agent) {
        const t = await this.#agentTopUp(vault, address);
        ready = t !== null && t.allowlisted && t.transferAllowed;
        if (!ready) {
          const missing = [
            ...(t === null || !t.allowlisted ? [`payment_wallet_setup with agentWallet ${address} on the owner's server${t !== null && t.waiting ? ` (listed already, in force at ${t.effectiveAt})` : ""}`] : []),
            ...(t === null || !t.transferAllowed ? ["transfer among the policy's actions (policy_set)"] : []),
          ];
          notes.push(`the agent key tops this wallet up once the owner sets: ${missing.join("; ")}`);
        }
      }
      const balance = await this.#balance(address);
      const reserved = await this.#reserved(r);
      const free = balance > reserved ? balance - reserved : 0n;
      let amount: bigint;
      if (amountText !== undefined) amount = parseTokenAmount(amountText);
      // With agentWallet the call is the allowlist entry: no top-up of this server's own wallet unless amount asks.
      else if (!ready || agentWallet !== null || free >= PAYMENT_WALLET_TOP_UP) amount = 0n;
      else {
        const room = PAYMENT_WALLET_MAX > balance ? PAYMENT_WALLET_MAX - balance : 0n;
        amount = room < PAYMENT_WALLET_TOP_UP ? room : PAYMENT_WALLET_TOP_UP;
        if (amount === 0n) notes.push(`no top-up: the wallet holds ${usdg(balance)} (${usdg(reserved)} held by authorizations still valid), its limit`);
      }
      let toppedUp: { txHash: Hash; amount: string } | undefined;
      if (amount > 0n) {
        try {
          toppedUp = await this.#topUp(r, amount);
        } catch (err) {
          const sent = allowlist !== undefined && allowlist.status === "sent" ? ` (the allowlist entry for ${String(agentWallet)} was sent: ${allowlist.txHash})` : "";
          throw new Error(`${(err as Error).message}${sent}`);
        }
      }
      const s = await this.#statusOf(vault, address, r);
      return { ...s, created, ...(allowlist === undefined ? {} : { allowlist }), ...(toppedUp === undefined ? {} : { toppedUp }), ...(notes.length === 0 ? {} : { note: notes.join("; ") }) };
    });
  }

  /**
   * Pays `a.offer` (an exact USDG offer: exactOfferProblem null) from the wallet, topped up from the vault first when
   * what is free in it does not cover the price, and sends the request again with the payment. The authorization is
   * recorded before it is sent.
   */
  payExact(a: ExactPayment): Promise<ExactPaid> {
    return this.#serial(async () => {
      const { offer } = a;
      const vault = await this.#vault();
      const signer = this.#signer(vault);
      const r = await this.#load(vault, signer.address);
      if (r === null) throw new Error(`${a.url} is paid by a USDG transfer signed by the payer's own key (x402 exact), which this agent pays from its payment wallet: none is set up yet (payment_wallet_setup); nothing was paid`);
      if (!/^[1-9][0-9]*$/.test(offer.amount)) throw new Error(`the offer's amount ${offer.amount} is not a positive integer; nothing was paid`);
      const price = BigInt(offer.amount);
      if (price > a.maxPrice) throw new Error(`${a.url} asks ${usdg(price)}, more than maxPrice ${usdg(a.maxPrice)}; nothing was paid`);
      if (price > PAYMENT_WALLET_MAX) throw new Error(`${a.url} asks ${usdg(price)}, more than the payment wallet ever holds (${usdg(PAYMENT_WALLET_MAX)}); nothing was paid`);
      if (!isAddress(offer.payTo, { strict: false })) throw new Error("the offer's payTo is not an address; nothing was paid");
      const payTo = getAddress(offer.payTo);
      if (payTo === zeroAddress || payTo === signer.address || payTo === vault) throw new Error(`the offer's payTo ${payTo} is not a seller (the zero address, the payment wallet or the vault); nothing was paid`);
      const timeout = offer.maxTimeoutSeconds;
      if (!Number.isInteger(timeout) || timeout < PAYMENT_WALLET_MIN_TIMEOUT_SECONDS || timeout > PAYMENT_WALLET_MAX_TIMEOUT_SECONDS) {
        throw new Error(`the offer's maxTimeoutSeconds ${String(timeout)} is not ${PAYMENT_WALLET_MIN_TIMEOUT_SECONDS}..${PAYMENT_WALLET_MAX_TIMEOUT_SECONDS}; nothing was paid`);
      }
      const extra = offer.extra as { name: string; version: string };
      await this.#domainOk(extra.name, extra.version);
      await this.#notFrozen(signer.address, "the payment wallet");
      await this.#notFrozen(payTo, "the seller's payTo");

      const notes: string[] = [];
      const balance = await this.#balance(signer.address);
      const reserved = await this.#reserved(r);
      const available = balance > reserved ? balance - reserved : 0n;
      if (available < price) {
        const need = price - available;
        let amount = need > PAYMENT_WALLET_TOP_UP ? need : PAYMENT_WALLET_TOP_UP;
        if (balance + amount > PAYMENT_WALLET_MAX) amount = PAYMENT_WALLET_MAX - balance;
        if (amount < need) {
          throw new Error(`the payment wallet has ${usdg(available)} free (${usdg(reserved)} held by authorizations still valid): a top-up covering ${usdg(price)} would take it above its limit of ${usdg(PAYMENT_WALLET_MAX)}; nothing was paid`);
        }
        let t: { txHash: Hash; amount: string };
        try {
          t = await this.#topUp(r, amount);
        } catch (err) {
          if (err instanceof TopUpLandedError) throw new Error(`${err.message}; nothing was paid`);
          throw new Error(`the payment wallet needs ${usdg(need)} more and was not topped up from the vault: ${(err as Error).message}; nothing was paid`);
        }
        notes.push(`the payment wallet was topped up with ${t.amount} USDG from the vault (${t.txHash})`);
      }

      const network = this.#p.config.x402Network as `${string}:${string}`;
      const x = new x402Client().register(network, new ExactEvmScheme(toClientEvmSigner(signer, this.#p.client as never)));
      x.setSpendControls({ allowedAssets: [{ network, asset: this.#token, maxAmountPerPayment: price.toString() }] });
      const http = new x402HTTPClient(x);
      let payload: Awaited<ReturnType<x402HTTPClient["createPaymentPayload"]>>;
      try {
        payload = await http.createPaymentPayload({ ...a.required, accepts: [offer] });
      } catch (err) {
        throw new Error(`the x402 client could not sign for the offer: ${(err as Error).message}; nothing was paid${notes.length === 0 ? "" : ` (${notes.join("; ")}: it stays in the wallet)`}`);
      }
      const auth = (payload.payload as { authorization?: { from?: string; to?: string; value?: string; validAfter?: string; validBefore?: string; nonce?: string } }).authorization;
      const signedOk =
        auth !== undefined &&
        typeof auth.from === "string" && isAddress(auth.from, { strict: false }) && getAddress(auth.from) === signer.address &&
        typeof auth.to === "string" && isAddress(auth.to, { strict: false }) && getAddress(auth.to) === payTo &&
        auth.value === price.toString() &&
        auth.validAfter === "0" &&
        typeof auth.validBefore === "string" && /^[0-9]{1,12}$/.test(auth.validBefore) && Number(auth.validBefore) <= now() + timeout + 60 &&
        typeof auth.nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(auth.nonce);
      if (!signedOk) throw new Error("the x402 client signed another authorization than the offer's (payer, payTo, amount or validity); it was not sent");
      const entry: WalletPayment = { url: a.url, payTo, amount: price.toString(), nonce: auth.nonce as Hex, validBefore: Number(auth.validBefore), at: now(), status: null, transaction: null };
      // The signed authorization lets the seller take the price until validBefore, whatever it answers: recorded first.
      r.payments.push(entry);
      await this.#save(r);
      let answer: Response;
      try {
        answer = await a.send(http.encodePaymentSignatureHeader(payload));
      } catch (err) {
        throw new Error(`${(err as Error).message}; the authorization signed for it (${usdg(price)} to ${payTo}) stays counted against the payment wallet until ${iso(entry.validBefore)} or until the chain shows it used`);
      }
      entry.status = answer.status;
      if (answer.headers.get("payment-response") !== null) {
        try {
          const settled = http.getPaymentSettleResponse((name) => answer.headers.get(name));
          if (typeof settled.transaction === "string" && settled.transaction !== "") entry.transaction = settled.transaction;
        } catch {
          // A settlement header that does not read: the chain still tells (authorizationState).
        }
      }
      await this.#save(r);
      const paid = entry.transaction !== null || answer.status < 400 ? price : null;
      if (paid === null) notes.push(`the seller answered ${answer.status} and named no settlement; the authorization stays counted against the payment wallet until ${iso(entry.validBefore)} or until the chain shows it used`);
      const after = await this.#balance(signer.address);
      const held = await this.#reserved(r);
      return { answer, paid, address: signer.address, left: after > held ? after - held : 0n, ...(notes.length === 0 ? {} : { note: notes.join("; ") }) };
    });
  }

  /**
   * Sends `amountText` (default all that is free: the balance less the authorizations still valid and not used) from
   * the wallet back to the vault: an authorization the wallet signs to the vault, sent by the agent's sender (the
   * relayer, paid from the vault's relayer channel, or the local fee payer).
   */
  withdraw(amountText?: string): Promise<{ status: "sent"; txHash: Hash; destination: Address; amount: string; left: string }> {
    return this.#serial(async () => {
      const vault = await this.#vault();
      const signer = this.#signer(vault);
      const { r } = await this.#record(vault, signer.address);
      const balance = await this.#balance(signer.address);
      const reserved = await this.#reserved(r);
      const free = balance > reserved ? balance - reserved : 0n;
      const amount = amountText === undefined ? free : parseTokenAmount(amountText);
      if (amountText !== undefined && amount === 0n) throw new RangeError("amount must be greater than zero");
      if (amount === 0n) throw new RangeError(`the payment wallet has nothing free to withdraw (balance ${usdg(balance)}, held by authorizations still valid ${usdg(reserved)}); nothing was signed`);
      if (amount > free) throw new RangeError(`the payment wallet has ${usdg(free)} free (balance ${usdg(balance)}, held by authorizations still valid ${usdg(reserved)}), less than ${usdg(amount)}; nothing was signed`);
      await this.#notFrozen(signer.address, "the payment wallet");
      await this.#notFrozen(vault, "the vault");
      const name = (await this.#p.client.readContract({ address: this.#token, abi: usdgAbi, functionName: "name" })) as string;
      await this.#domainOk(name, USDG_DOMAIN_VERSION);
      const validBefore = (await chainTime(this.#p.client)) + WITHDRAW_VALID_SECONDS;
      const nonce = bytesToHex(randomBytes(32));
      const signature = await signer.signTypedData({
        domain: { name, version: USDG_DOMAIN_VERSION, chainId: this.#p.config.chainId, verifyingContract: this.#token },
        types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
        primaryType: "TransferWithAuthorization",
        message: { from: signer.address, to: vault, value: amount, validAfter: 0n, validBefore, nonce },
      });
      const sig = parseSignature(signature);
      const v = sig.v !== undefined ? Number(sig.v) : sig.yParity + 27;
      const data = encodeFunctionData({ abi: usdgAbi, functionName: "transferWithAuthorization", args: [signer.address, vault, amount, 0n, validBefore, nonce, v, sig.r, sig.s] });
      // Whoever holds the signed authorization can send it until validBefore: recorded first, counted until used.
      r.withdrawals.push({ amount: amount.toString(), nonce, validBefore: Number(validBefore), at: now() });
      await this.#save(r);
      let txHash: Hash;
      try {
        txHash = await this.#p.sender.send([{ to: this.#token, data }]);
      } catch (err) {
        throw new Error(`${(err as Error).message}; the authorization signed for it (${usdg(amount)} to the vault) stays counted against the payment wallet until ${iso(validBefore)} or until the chain shows it used`);
      }
      r.moves.push({ kind: "withdraw", amount: amount.toString(), txHash, at: now() });
      await this.#save(r);
      const left = await this.#balance(signer.address);
      return { status: "sent", txHash, destination: vault, amount: usdg(amount), left: usdg(left) };
    });
  }
}
