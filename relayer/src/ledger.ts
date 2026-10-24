// The relayer's records, one JSON file in OSTRA_RELAYER_DATA (0700), written
// atomically (temporary file, fsync, rename) and changed under one lock:
//
//   quotes   per request hash (sdk relayRequestHash): the price, the
//            transaction the relayer sends and the vaults it acts for, for
//            QUOTE_RETENTION_MS
//   paid     per request hash: the landed transaction, so a paid request
//            sent again is answered without a second charge (kept
//            QUOTE_RETENTION_MS)
//   debts    per vault: CreateVault and SpendLeaf transactions relayed
//            before payment (alone, or together for unshield)
//   opens    per vault: the relayer-channel open relayed before payment, and
//            what its first voucher owes (that open's price and the debt)
//   credits  per vault: what the agent paid for a transaction that then
//            could not be sent; taken off its later quotes (creditPlan). On
//            Solana lamports of the agent's own paid back to the relayer were
//            credited too; on Robinhood Chain nothing comes back to the
//            relayer, so there are no refunds.
//   createVaults  per IP address: times of CreateVault relayed before payment
//   feeTokens     tokens private spends paid their fee in (private.ts), sold
//                 to ETH by sweep.ts
//   privateReverts  per nullifier: the private spends of that note that
//                 reverted on-chain when relayed, in the last 24 hours
//   privateIpReverts  per IP address: times of its private spends that
//                 reverted, in the last 24 hours
//   privateRecentReverts  times of everyone's reverted private spends, in the
//                 last 30 minutes (private.ts pauses private relaying on them)

import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/** Rolling window and count of CreateVault relayed before payment per IP (design v0.3, 15 Oct 2026). */
export const CREATE_VAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CREATE_VAULTS_PER_IP = 3;
/**
 * How long a quote and a paid record are kept (the Solana value, 300 s,
 * kept on Robinhood Chain, decided 17 Oct 2026). On Solana it was the age at
 * which a quote's blockhash had certainly expired; an EVM transaction has no
 * expiry, but every relayed call is spent by landing (a WOTS key rotates, a
 * nonce or status moves on, a vault exists), so the same request sent again
 * later is priced again and its simulation refuses it. The price also follows
 * the gas price, so a quote is not held longer. The MCP package waits the same
 * 300 s for a signed transaction that is not on-chain (OPEN_PENDING_SECONDS).
 */
export const QUOTE_RETENTION_MS = 300_000;

export type QuoteKind = "create_vault" | "open_relayer_channel" | "spend_leaf" | "unshield_vault" | "finish_recovery" | "other";

export type Quote = {
  /** Price in base units of the token, margin included. */
  amount: string;
  /** Wei charged before the margin: the priced gas x gas price at the quote. */
  wei: string;
  /** ETH the transaction sends (a vault-funded launch's fee), charged without the margin; absent: 0. */
  value?: string;
  gas: string;
  gasPrice: string;
  /** The Chainlink ETH/USD answer the price was converted at (8 decimals, before the deviation). */
  ethUsd: string;
  /** The transaction the relayer sends (sdk relayTransaction). */
  to: string;
  data: string;
  kind: QuoteKind;
  vaults: string[];
  createdAt: number;
};

/** `token`: a private spend's fee token (private.ts); absent: the vault's channel token. */
export type Paid = { txHash: string; amount: string; at: number; token?: string };
export type Debt = { amount: string; txs: string[] };
/** `calls`: the relayed open's request, sent again with the first voucher to pay it. */
export type PendingOpen = { hash: string; txHash: string; channel: string; amount: string; at: number; calls: { to: string; data: string }[] };

type LedgerData = {
  version: 1;
  quotes: Record<string, Quote>;
  paid: Record<string, Paid>;
  debts: Record<string, Debt>;
  opens: Record<string, PendingOpen>;
  credits: Record<string, string>;
  createVaults: Record<string, number[]>;
  /** Tokens private spends paid fees in, which sweep.ts sells to ETH (absent in ledgers from before 21 Oct 2026). */
  feeTokens?: string[];
  /** Per nullifier (lowercase hex): the private spends of that note that reverted when relayed in the last 24 hours (private.ts). */
  privateReverts?: Record<string, { txHash: string; at: number }[]>;
  /** Per IP address: times of its private spends that reverted when relayed in the last 24 hours (absent before 22 Oct 2026). */
  privateIpReverts?: Record<string, number[]>;
  /** Times of everyone's private spends that reverted when relayed in the last GLOBAL_PAUSE_MS (absent before 22 Oct 2026). */
  privateRecentReverts?: number[];
};

const empty = (): LedgerData => ({ version: 1, quotes: {}, paid: {}, debts: {}, opens: {}, credits: {}, createVaults: {} });

export class Ledger {
  readonly #path: string;
  #data: LedgerData;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(path: string, data: LedgerData) {
    this.#path = path;
    this.#data = data;
  }

  /** Opens (or creates) the ledger in `dir`, which must be private to its owner. */
  static async open(dir: string): Promise<Ledger> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mode = (await stat(dir)).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`${dir} is accessible by other users (mode ${mode.toString(8)}); chmod 700 it`);
    const path = join(dir, "relayer-ledger.json");
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as LedgerData;
      if (data.version !== 1) throw new Error(`${path}: unknown ledger version ${String(data.version)}`);
      return new Ledger(path, data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return new Ledger(path, empty());
  }

  /** A deep copy of the current records (for reads outside `update`). */
  view(): LedgerData {
    return structuredClone(this.#data);
  }

  /**
   * Runs `mutate` on a copy under the lock and saves the result before
   * resolving; a throwing `mutate` changes nothing. Returns `mutate`'s value.
   */
  update<T>(mutate: (data: LedgerData) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const next = structuredClone(this.#data);
      const result = await mutate(next);
      await this.#save(next);
      this.#data = next;
      return result;
    };
    const p = this.#tail.then(run, run);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  async #save(data: LedgerData): Promise<void> {
    const tmp = `${this.#path}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 1)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.#path);
  }
}

/** Drops quotes and paid records older than QUOTE_RETENTION_MS. */
export function pruneQuotes(data: LedgerData, now: number): void {
  for (const [hash, q] of Object.entries(data.quotes)) {
    if (now - q.createdAt > QUOTE_RETENTION_MS) delete data.quotes[hash];
  }
  for (const [hash, p] of Object.entries(data.paid)) {
    if (now - p.at > QUOTE_RETENTION_MS) delete data.paid[hash];
  }
}

const recentCreateVaults = (data: LedgerData, ip: string, now: number) => (data.createVaults[ip] ?? []).filter((t) => now - t < CREATE_VAULT_WINDOW_MS);

/** The refusal `ip` gets when it has used every CreateVault slot of the window, or null. */
export function createVaultLimitReached(data: LedgerData, ip: string, now: number): LedgerRefusal | null {
  if (recentCreateVaults(data, ip, now).length < CREATE_VAULTS_PER_IP) return null;
  return new LedgerRefusal("create_vault_limit", `at most ${CREATE_VAULTS_PER_IP} vaults are created before payment per IP address in 24 hours`);
}

/** Takes one CreateVault slot for `ip`, or throws when the IP has used all of them in the window. */
export function takeCreateVaultSlot(data: LedgerData, ip: string, now: number): void {
  const refusal = createVaultLimitReached(data, ip, now);
  if (refusal !== null) throw refusal;
  data.createVaults[ip] = [...recentCreateVaults(data, ip, now), now];
}

/** Gives back the slot `ip` took at `at` (its CreateVault was not sent). */
export function returnCreateVaultSlot(data: LedgerData, ip: string, at: number): void {
  const slots = data.createVaults[ip] ?? [];
  const i = slots.indexOf(at);
  if (i >= 0) slots.splice(i, 1);
  if (slots.length > 0) data.createVaults[ip] = slots;
  else delete data.createVaults[ip];
}

/** What `vault` still owes for CreateVault transactions relayed before payment. */
export function debtOf(data: LedgerData, vault: string): bigint {
  return BigInt(data.debts[vault]?.amount ?? "0");
}

export function creditOf(data: LedgerData, vault: string): bigint {
  return BigInt(data.credits[vault] ?? "0");
}

/**
 * How a vault's credit pays a transaction priced `price` (design v0.3,
 * decided 15 Oct 2026). A transaction that acts for that vault alone is
 * authorized by the vault's own signature, so credit may pay all of it.
 * Otherwise credit is used only when a voucher from a channel of that vault
 * pays the rest, at least one base unit, which authorizes its use.
 */
export function creditPlan(a: { price: bigint; credit: bigint; actsForCreditVault: boolean }): { used: bigint; owed: bigint; voucherFromCreditVault: boolean } {
  if (a.price < 1n || a.credit < 0n) throw new RangeError("price must be positive and credit not negative");
  const cap = a.actsForCreditVault ? a.price : a.price - 1n;
  const used = a.credit < cap ? a.credit : cap;
  return { used, owed: a.price - used, voucherFromCreditVault: !a.actsForCreditVault && used > 0n };
}

/** A request the relayer's rules refuse (answered 403). */
export class LedgerRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LedgerRefusal";
    this.code = code;
  }
}

export type { LedgerData };
