// Session keys for paying sellers whose payment is a signed transfer from the
// payer's own key: x402 `exact` (EIP-3009) and `upto` (Permit2), and MPP
// `charge` (EIP-3009).
//
// A session is a plain secp256k1 key that holds a small budget for one seller
// (design v0.3, "Siklus session key"): one WOTS transfer from the vault funds
// it, then every payment to that seller is signed by the session key, so one
// post-quantum signature covers many small payments. The session ends when
// its budget no longer covers a price or its maximum age is reached; what is
// left goes back to the vault.
//
// On Robinhood Chain (design v0.4) a seller paid through a channel (x402
// batch-settlement) is paid from a channel of the vault itself (payer the
// vault, the channel's voucher key signing; channels.ts), not from a channel
// of the session key: the open is a WOTS spend, as for an Ostra seller. So a
// session holds no channel deposit, and nothing has to come back from a
// channel before it ends (on Solana: upto.ts, batch.ts, mpp.ts). EIP-3009 and
// Permit2 payments are submitted by the seller's facilitator, so a session
// key needs no ETH.
//
// Entries, in the agent's `sessions` folder (on disk OSTRA_HOME/sessions, 0700):
//   <address>.key   32-byte private key (a secret entry; on disk hex, 0600), written before funding
//   <address>.json  record: seller, budget, times, payments (no secrets)

import { bytesToHex, getAddress, isAddress, type Address, type Hash, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isPrivateKey } from "./keys.ts";
import { randomBytes } from "./random.ts";
import type { Folder } from "./storage.ts";

export const SESSIONS_DIR = "sessions";

export type SessionPayment = { url: string; amount: string; transaction: string; at: number };

export type SessionRecord = {
  version: 1;
  address: Address;
  chainId: number;
  token: Address;
  /** The seller's payTo; one session per seller at a time. */
  payTo: Address;
  /** Base units moved from the vault into the session. */
  budget: string;
  createdAt: number;
  expiresAt: number;
  status: "active" | "closed";
  fundTxHash?: Hash;
  closeTxHash?: Hash;
  payments: SessionPayment[];
};

export class SessionStore {
  readonly #folder: Folder;

  /** `folder`: the agent's `sessions` folder (SESSIONS_DIR in its folder). */
  constructor(folder: Folder) {
    this.#folder = folder;
  }

  async #ensureDir(): Promise<void> {
    await this.#folder.ensure();
  }

  /**
   * Creates a session key and its record (status active, no budget moved yet).
   * The key is stored before any token can reach it.
   */
  async create(a: { chainId: number; token: Address; payTo: Address; budget: bigint; now: number; maxAgeSeconds: number }): Promise<SessionRecord> {
    await this.#ensureDir();
    let secret: Uint8Array;
    do secret = randomBytes(32);
    while (!isPrivateKey(secret));
    const signer = privateKeyToAccount(bytesToHex(secret));
    await this.#folder.createSecret(`${signer.address}.key`, secret);
    const record: SessionRecord = {
      version: 1,
      address: signer.address,
      chainId: a.chainId,
      token: getAddress(a.token),
      payTo: getAddress(a.payTo),
      budget: a.budget.toString(),
      createdAt: a.now,
      expiresAt: a.now + a.maxAgeSeconds,
      status: "active",
      payments: [],
    };
    await this.save(record);
    return record;
  }

  async save(record: SessionRecord): Promise<void> {
    await this.#ensureDir();
    await this.#folder.write(`${record.address}.json`, `${JSON.stringify(record, null, 2)}\n`);
  }

  async signer(record: SessionRecord): Promise<PrivateKeyAccount> {
    const secret = await this.#folder.readSecret(`${record.address}.key`);
    if (!isPrivateKey(secret)) throw new Error(`session key file of ${record.address} is not a valid secp256k1 private key`);
    const signer = privateKeyToAccount(bytesToHex(secret));
    if (signer.address !== record.address) throw new Error(`session key file does not match ${record.address}`);
    return signer;
  }

  /** Every session record of this chain and token, oldest first. */
  async list(chainId: number, token: Address): Promise<SessionRecord[]> {
    await this.#ensureDir();
    const out: SessionRecord[] = [];
    for (const name of await this.#folder.list()) {
      if (!name.endsWith(".json")) continue;
      const text = await this.#folder.read(name);
      if (text === undefined) continue;
      const record = JSON.parse(text) as SessionRecord;
      if (record.version !== 1 || `${record.address}.json` !== name || !isAddress(record.address, { strict: true })) throw new Error(`corrupt session record ${name}`);
      if (record.chainId === chainId && getAddress(record.token) === getAddress(token)) out.push(record);
    }
    return out.sort((x, y) => x.createdAt - y.createdAt);
  }
}
