// The passkey backup of the master seed (design v0.4, recovery when a device
// is lost, layer 1; the relayer side is relayer/src/backups.ts, the signed
// write sdk backup.ts).
//
// The web app asks the passkey for its WebAuthn PRF output with
// PASSKEY_PRF_INPUT (extensions.prf.eval.first, the same on every device, so
// a synced passkey gives the same output on a new one). That output never
// leaves the device: the seed is encrypted with AES-256-GCM under
// HKDF-SHA-256(PRF output, a random salt, PASSKEY_SEED_INFO), and only the
// ciphertext goes to the relayer, named by the SHA-256 of the credential id
// (backupName), with the backup name as associated data. Blob, before
// base64url: version (1) || HKDF salt (32) || IV (12) || ciphertext of the
// 32-byte seed with its 16-byte tag (48); 93 bytes, 124 characters.
//
// A new device signs in with the passkey (a discoverable credential, so it
// learns the credential id), gets the same PRF output, reads the backup by
// name and decrypts it; a wrong passkey or a changed blob fails the GCM tag.
// Writes to the relayer are signed by the seed's backup key (Keys.backupSigner),
// which the relayer binds to the name on the first write.
//
// Web Crypto only (globalThis.crypto.subtle), so this runs in the browser.

import { bytesToHex, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BACKUP_OP_DELETE, BACKUP_OP_PUT, sha256, signBackupWrite, utf8, type BackupView } from "@ostraagent/sdk";
import { fromBase64Url } from "./encoding.ts";
import type { Keys } from "./keys.ts";
import { randomBytes } from "./random.ts";
import { RelayerError, RelayerUnavailableError } from "./relay.ts";

export const PASSKEY_BACKUP_VERSION = 1;
/** The PRF input every device evaluates (extensions.prf.eval.first): SHA-256 of "OSTRA/PASSKEY-PRF/v1". */
export const PASSKEY_PRF_INPUT: Uint8Array = sha256([utf8("OSTRA/PASSKEY-PRF/v1")]);
const PASSKEY_SEED_INFO = utf8("OSTRA/PASSKEY-SEED/v1");
const BACKUP_KEY_DOMAIN = utf8("OSTRA/MCP/PASSKEY-BACKUP-KEY/EVM/v1");
/** secp256k1 group order: a private key must be in 1..n-1. */
const SECP256K1_N = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_fffe_baae_dce6_af48_a03b_bfd2_5e8c_d036_4141n;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const SEED_BYTES = 32;
const TAG_BYTES = 16;
const BLOB_BYTES = 1 + SALT_BYTES + IV_BYTES + SEED_BYTES + TAG_BYTES;
/** A request to the relayer's backups waits at most this long. */
export const BACKUP_TIMEOUT_MS = 30_000;

/** The seed's backup key: it signs the seed's writes to the relayer's backups (one key per seed, every chain). */
export function backupSignerOf(master: Uint8Array): PrivateKeyAccount {
  if (master.length !== SEED_BYTES) throw new RangeError("the master seed must be 32 bytes");
  const secret = sha256([BACKUP_KEY_DOMAIN, master]);
  const k = BigInt(bytesToHex(secret));
  if (k === 0n || k >= SECP256K1_N) throw new Error("the derived secret is not a valid secp256k1 private key");
  return privateKeyToAccount(bytesToHex(secret));
}

/** The backup's name at the relayer: SHA-256 of the passkey's credential id (rawId). */
export function backupName(credentialId: Uint8Array): Hex {
  if (credentialId.length === 0) throw new RangeError("the credential id is empty");
  return bytesToHex(sha256([credentialId]));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function checkPrf(prf: Uint8Array): void {
  if (prf.length !== 32) throw new RangeError("the PRF output must be 32 bytes (WebAuthn prf results.first)");
}

async function seedKey(prf: Uint8Array, salt: Uint8Array) {
  const subtle = globalThis.crypto.subtle;
  const ikm = await subtle.importKey("raw", prf.slice(), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: salt.slice(), info: PASSKEY_SEED_INFO.slice() }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function associatedData(name: Hex): Uint8Array {
  const name32 = Uint8Array.from(name.slice(2).match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  const out = new Uint8Array(PASSKEY_SEED_INFO.length + name32.length);
  out.set(PASSKEY_SEED_INFO, 0);
  out.set(name32, PASSKEY_SEED_INFO.length);
  return out;
}

/** Encrypts `master` under the passkey's PRF output, for the backup named after `credentialId`; base64url. */
export async function sealSeed(master: Uint8Array, prf: Uint8Array, credentialId: Uint8Array): Promise<string> {
  if (master.length !== SEED_BYTES) throw new RangeError("the master seed must be 32 bytes");
  checkPrf(prf);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await seedKey(prf, salt);
  const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.slice(), additionalData: associatedData(backupName(credentialId)).slice(), tagLength: 128 }, key, master.slice()));
  const blob = new Uint8Array(BLOB_BYTES);
  blob[0] = PASSKEY_BACKUP_VERSION;
  blob.set(salt, 1);
  blob.set(iv, 1 + SALT_BYTES);
  blob.set(sealed, 1 + SALT_BYTES + IV_BYTES);
  return toBase64Url(blob);
}

/** Decrypts a blob sealSeed made; throws when the passkey (PRF output), the credential or the blob is not the one it was made with. */
export async function openSeed(blob: string, prf: Uint8Array, credentialId: Uint8Array): Promise<Uint8Array> {
  checkPrf(prf);
  const bytes = fromBase64Url(blob);
  if (bytes.length !== BLOB_BYTES || bytes[0] !== PASSKEY_BACKUP_VERSION) throw new Error(`not a version ${PASSKEY_BACKUP_VERSION} passkey backup`);
  const salt = bytes.slice(1, 1 + SALT_BYTES);
  const iv = bytes.slice(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES);
  const sealed = bytes.slice(1 + SALT_BYTES + IV_BYTES);
  const key = await seedKey(prf, salt);
  try {
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: associatedData(backupName(credentialId)).slice(), tagLength: 128 }, key, sealed));
  } catch {
    throw new Error("this passkey does not open this backup (another passkey, or the backup was changed)");
  }
}

/** The relayer's passkey backups (GET and POST /v1/backups/<name>), as this agent uses them. */
export class PasskeyBackupClient {
  readonly url: string;
  readonly chainId: number;

  constructor(url: string, chainId: number) {
    this.url = url.replace(/\/+$/, "");
    this.chainId = chainId;
  }

  async #fetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(BACKUP_TIMEOUT_MS) });
    } catch (err) {
      throw new RelayerUnavailableError(`the relayer at ${this.url} cannot be reached (${(err as Error).message})`);
    }
    let body: Record<string, unknown> | null = null;
    try {
      const value: unknown = await res.json();
      if (value !== null && typeof value === "object" && !Array.isArray(value)) body = value as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  async #write(name: Hex, body: Record<string, unknown>): Promise<{ name: Hex; owner: Address; updatedAt: number; deleted: boolean }> {
    const { status, body: answer } = await this.#fetch(`/v1/backups/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (status === 200 && answer !== null) return answer as { name: Hex; owner: Address; updatedAt: number; deleted: boolean };
    const message = typeof answer?.message === "string" ? answer.message : `POST /v1/backups answered ${status}`;
    if (status >= 500) throw new RelayerUnavailableError(message);
    throw new RelayerError(status, typeof answer?.error === "string" ? answer.error : "backup", message);
  }

  /** The backup under `name`, or null, and when its last write was accepted (also for a deleted one). */
  async #read(name: Hex): Promise<{ view: BackupView | null; updatedAt: number | null }> {
    const { status, body } = await this.#fetch(`/v1/backups/${name}`, { headers: { accept: "application/json" } });
    if (status === 404 && body?.error === "no_backup") return { view: null, updatedAt: typeof body.updatedAt === "number" ? body.updatedAt : null };
    if (status >= 500) throw new RelayerUnavailableError(`GET /v1/backups/${name} answered ${status}`);
    if (status !== 200 || body === null || typeof body.blob !== "string" || typeof body.owner !== "string" || typeof body.updatedAt !== "number") {
      throw new RelayerError(status, "backup", `GET /v1/backups/${name} answered ${status}`);
    }
    return { view: body as BackupView, updatedAt: body.updatedAt };
  }

  /** The time a new write to `name` signs: now, or just after the last write the relayer accepted. */
  async #nextAt(name: Hex): Promise<number> {
    const { updatedAt } = await this.#read(name);
    const now = Math.floor(Date.now() / 1000);
    return updatedAt !== null && updatedAt >= now ? updatedAt + 1 : now;
  }

  /** The backup kept for the passkey `credentialId`, or null. */
  async get(credentialId: Uint8Array): Promise<BackupView | null> {
    return (await this.#read(backupName(credentialId))).view;
  }

  /** Encrypts this seed under the passkey's PRF output and keeps it at the relayer (replacing this seed's earlier backup for that passkey). */
  async save(keys: Keys, credentialId: Uint8Array, prf: Uint8Array): Promise<{ name: Hex; updatedAt: number }> {
    const name = backupName(credentialId);
    const blob = await keys.passkeyBackup(prf, credentialId);
    const signer = keys.backupSigner();
    const at = await this.#nextAt(name);
    const signature = await signBackupWrite(signer, { op: BACKUP_OP_PUT, chainId: this.chainId, name, blob, at: BigInt(at) });
    const r = await this.#write(name, { op: "put", owner: signer.address, blob, at, signature });
    return { name: r.name, updatedAt: r.updatedAt };
  }

  /** Deletes this seed's backup for the passkey `credentialId` (the name stays bound to this seed). */
  async remove(keys: Keys, credentialId: Uint8Array): Promise<void> {
    const name = backupName(credentialId);
    const signer = keys.backupSigner();
    const at = await this.#nextAt(name);
    const signature = await signBackupWrite(signer, { op: BACKUP_OP_DELETE, chainId: this.chainId, name, blob: null, at: BigInt(at) });
    await this.#write(name, { op: "delete", owner: signer.address, at, signature });
  }

  /**
   * On a new device: the master seed from the backup of the passkey
   * `credentialId`, decrypted with its PRF output; null when the relayer keeps
   * no backup for it. The seed's backup key must be the backup's owner.
   */
  async restore(credentialId: Uint8Array, prf: Uint8Array): Promise<Uint8Array | null> {
    const view = await this.get(credentialId);
    if (view === null) return null;
    const master = await openSeed(view.blob, prf, credentialId);
    if (backupSignerOf(master).address !== view.owner) throw new Error("the decrypted seed's backup key is not the backup's owner");
    return master;
  }
}
