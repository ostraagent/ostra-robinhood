// The passphrase backup of the master seed, in the format of the MCP package's
// backup command (mcp/src/backup-cli.ts), so one backup file restores in either
// place (design, web app, "Kunci dan backup"): JSON
//
//   {version: 1, kdf: {name: "scrypt", N: 2^17, r: 8, p: 1}, salt, iv, ciphertext, tag}
//
// with hex fields: AES-256-GCM of the 32-byte seed under the scrypt key of the
// passphrase (UTF-8), "OSTRA/SEED-BACKUP/v1" as associated data, a 16-byte
// salt and a 12-byte IV. Written with Web Crypto and @noble/hashes, so the web
// app seals and opens the same files in a browser as the MCP package does with
// node:crypto. The web app also keeps its seed in the browser only in this
// form. mcp/test/disk.test.ts checks that each side opens what the other seals.

import { scryptAsync } from "@noble/hashes/scrypt.js";

/** Shortest passphrase a backup is sealed with (the MCP package's MIN_PASSPHRASE). */
export const SEED_BACKUP_MIN_PASSPHRASE = 12;
const SCRYPT = { N: 1 << 17, r: 8, p: 1 } as const;
const AAD = new TextEncoder().encode("OSTRA/SEED-BACKUP/v1");
/** scrypt's memory at these parameters is 128 * N * r bytes (128 MiB); the limit leaves room for it. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** The AES-256-GCM key of `passphrase` with `salt` (scrypt N 2^17, r 8, p 1). `onProgress` gets 0 to 1. */
async function keyOf(passphrase: string, salt: Uint8Array, onProgress?: (done: number) => void) {
  const raw = await scryptAsync(new TextEncoder().encode(passphrase), salt, { ...SCRYPT, dkLen: 32, maxmem: SCRYPT_MAXMEM, asyncTick: 25, ...(onProgress === undefined ? {} : { onProgress }) });
  try {
    return await globalThis.crypto.subtle.importKey("raw", raw.slice(), "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

/** The backup of `seed` under `passphrase` (at least SEED_BACKUP_MIN_PASSPHRASE characters), as the file's text. */
export async function sealSeedBackup(seed: Uint8Array, passphrase: string, onProgress?: (done: number) => void): Promise<string> {
  if (seed.length !== 32) throw new RangeError("the seed is 32 bytes");
  if (passphrase.length < SEED_BACKUP_MIN_PASSPHRASE) throw new RangeError(`the passphrase must be at least ${SEED_BACKUP_MIN_PASSPHRASE} characters`);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await keyOf(passphrase, salt, onProgress);
  const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.slice(), additionalData: AAD.slice(), tagLength: 128 }, key, seed.slice()));
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  return `${JSON.stringify({ version: 1, kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, salt: toHex(salt), iv: toHex(iv), ciphertext: toHex(ciphertext), tag: toHex(tag) })}\n`;
}

/** The seed in backup `text`; throws when it is not a version 1 backup or the passphrase does not open it. */
export async function openSeedBackup(text: string, passphrase: string, onProgress?: (done: number) => void): Promise<Uint8Array> {
  let b: { version?: unknown; kdf?: { name?: unknown; N?: unknown; r?: unknown; p?: unknown }; salt?: unknown; iv?: unknown; ciphertext?: unknown; tag?: unknown };
  try {
    b = JSON.parse(text) as typeof b;
  } catch {
    throw new Error("not an Ostra seed backup");
  }
  if (typeof b !== "object" || b === null || b.version !== 1 || b.kdf?.name !== "scrypt" || b.kdf.N !== SCRYPT.N || b.kdf.r !== SCRYPT.r || b.kdf.p !== SCRYPT.p) throw new Error("not an Ostra seed backup (version 1)");
  const fields = [b.salt, b.iv, b.ciphertext, b.tag];
  for (const f of fields) if (typeof f !== "string" || f.length % 2 !== 0 || !/^[0-9a-f]+$/.test(f)) throw new Error("not an Ostra seed backup");
  const [salt, iv, ciphertext, tag] = (fields as string[]).map(fromHex) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  if (iv.length !== 12 || tag.length !== 16) throw new Error("not an Ostra seed backup");
  const key = await keyOf(passphrase, salt, onProgress);
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);
  let seed: Uint8Array;
  try {
    seed = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.slice(), additionalData: AAD.slice(), tagLength: 128 }, key, sealed.slice()));
  } catch {
    throw new Error("the passphrase does not open this backup");
  }
  if (seed.length !== 32) throw new Error("the backup does not hold a 32-byte seed");
  return seed;
}
