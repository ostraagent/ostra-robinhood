// Winternitz one-time signatures, byte-compatible with src/Wots.sol (and the
// Solana program's wots.rs)
// (w = 16, Keccak-256 truncated to 28 bytes, 64 message + 3 checksum chains).
//
// A WOTS key must never sign two different messages: two signatures from one
// key let anyone forge a third. This module therefore never exposes a raw
// "sign" call. Signing goes through WotsKeychain, which:
//   1. derives every key deterministically from (master, keychain, index), so
//      the key behind any on-chain key_root can always be recomputed;
//   2. writes the signature to a durable store BEFORE returning it, so a
//      transaction that fails to land is retried with the identical bytes;
//   3. refuses to sign a different message with an index that already signed;
//   4. with a signature escrow (WotsSignatureLookup: the Ostra relayer keeps
//      every WOTS signature it receives until the chain shows its key used),
//      asks it before signing with a key the local store has no record of, so
//      a device restored from the seed resends a signature still in flight
//      instead of signing a second message with the same key, and refuses to
//      sign while the escrow cannot be read.
//
// This module does not depend on Node: the durable store is the WotsStore
// interface. FileWotsStore (wots-file.ts, Node only) keeps records on disk.

import { keccak256, sha256, toHex, fromHex, u64Le, utf8 } from "./hash.ts";

export const WOTS_N = 28;
export const WOTS_SALT_LEN = 16;
export const WOTS_MSG_CHAINS = 64;
export const WOTS_CHECKSUM_CHAINS = 3;
export const WOTS_CHAINS = WOTS_MSG_CHAINS + WOTS_CHECKSUM_CHAINS;
export const WOTS_CHAIN_END = 15;
export const WOTS_SIGNATURE_LEN = WOTS_SALT_LEN + WOTS_CHAINS * WOTS_N;
/** Worst-case number of hash steps the on-chain verifier performs. */
export const WOTS_MAX_VERIFIER_STEPS = 990;

const DOMAIN_MSG = utf8("OSTRA/WOTS/MSG/v1");
const DOMAIN_PK = utf8("OSTRA/WOTS/PK/v1");
const DOMAIN_SK = utf8("OSTRA/WOTS/SK/v1");
const DOMAIN_SALT = utf8("OSTRA/WOTS/SALT/v1");
const DOMAIN_DERIVE = utf8("OSTRA/WOTS/DERIVE/v1");

function bytes32(value: Uint8Array, name: string): Uint8Array {
  if (value.length !== 32) throw new RangeError(`${name} must be 32 bytes`);
  return value;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** One tweaked chain step: keccak256(salt || chain || pos || x)[..28]. */
function step(salt: Uint8Array, chain: number, pos: number, x: Uint8Array): Uint8Array {
  const buf = new Uint8Array(WOTS_SALT_LEN + 2 + WOTS_N);
  buf.set(salt.subarray(0, WOTS_SALT_LEN), 0);
  buf[WOTS_SALT_LEN] = chain;
  buf[WOTS_SALT_LEN + 1] = pos;
  buf.set(x, WOTS_SALT_LEN + 2);
  return keccak256([buf]).slice(0, WOTS_N);
}

function walk(salt: Uint8Array, chain: number, from: number, to: number, start: Uint8Array): Uint8Array {
  let x = start;
  for (let pos = from; pos < to; pos++) x = step(salt, chain, pos, x);
  return x;
}

/** Base-16 digest digits (high nibble first) followed by 3 checksum digits. */
export function wotsDigits(salt: Uint8Array, message: Uint8Array): Uint8Array {
  if (salt.length !== WOTS_SALT_LEN) throw new RangeError(`salt must be ${WOTS_SALT_LEN} bytes`);
  const d = keccak256([DOMAIN_MSG, salt, message]);
  const out = new Uint8Array(WOTS_CHAINS);
  let checksum = 0;
  for (let i = 0; i < 32; i++) {
    const byte = d[i] as number;
    const hi = byte >> 4;
    const lo = byte & 0x0f;
    out[2 * i] = hi;
    out[2 * i + 1] = lo;
    checksum += WOTS_CHAIN_END - hi + (WOTS_CHAIN_END - lo);
  }
  out[WOTS_MSG_CHAINS] = (checksum >> 8) & 0x0f;
  out[WOTS_MSG_CHAINS + 1] = (checksum >> 4) & 0x0f;
  out[WOTS_MSG_CHAINS + 2] = checksum & 0x0f;
  return out;
}

/** Number of hash steps the on-chain verifier performs for this message. */
export function wotsVerifierSteps(salt: Uint8Array, message: Uint8Array): number {
  let steps = 0;
  for (const d of wotsDigits(salt, message)) steps += WOTS_CHAIN_END - d;
  return steps;
}

function keyRootFromEnds(salt: Uint8Array, ends: Uint8Array): Uint8Array {
  return keccak256([DOMAIN_PK, salt, ends]);
}

/** Key root committed by `signature` over `message` (what Wots.recoverKeyRoot recomputes). */
export function wotsRecoverKeyRoot(signature: Uint8Array, message: Uint8Array): Uint8Array {
  if (signature.length !== WOTS_SIGNATURE_LEN) {
    throw new RangeError(`signature must be ${WOTS_SIGNATURE_LEN} bytes`);
  }
  const salt = signature.subarray(0, WOTS_SALT_LEN);
  const digits = wotsDigits(salt, message);
  const ends = new Uint8Array(WOTS_CHAINS * WOTS_N);
  for (let i = 0; i < WOTS_CHAINS; i++) {
    const off = WOTS_SALT_LEN + i * WOTS_N;
    const end = walk(salt, i, digits[i] as number, WOTS_CHAIN_END, signature.slice(off, off + WOTS_N));
    ends.set(end, i * WOTS_N);
  }
  return keyRootFromEnds(salt, ends);
}

/** True iff `signature` over `message` verifies against `keyRoot` exactly as on-chain. */
export function wotsVerify(signature: Uint8Array, message: Uint8Array, keyRoot: Uint8Array): boolean {
  return equalBytes(wotsRecoverKeyRoot(signature, message), bytes32(keyRoot, "keyRoot"));
}

/** Per-key seed: keccak256("OSTRA/WOTS/DERIVE/v1" || master || keychain || index (u64 LE)). */
export function deriveWotsSeed(master: Uint8Array, keychainId: Uint8Array, index: bigint): Uint8Array {
  return keccak256([DOMAIN_DERIVE, bytes32(master, "master"), bytes32(keychainId, "keychainId"), u64Le(index)]);
}

// Raw signing with a key. Assigned inside WotsKey (it needs the private
// secrets) and deliberately not exported: only WotsKeychain.sign calls it.
let signWithKey!: (key: WotsKey, message: Uint8Array) => Uint8Array;

/**
 * A WOTS key derived from a 32-byte seed. Exposes only public data (salt and
 * key root); signing is reachable only through WotsKeychain.
 */
export class WotsKey {
  readonly #salt: Uint8Array;
  readonly #secrets: Uint8Array[];
  #keyRoot: Uint8Array | undefined;

  private constructor(salt: Uint8Array, secrets: Uint8Array[]) {
    this.#salt = salt;
    this.#secrets = secrets;
  }

  /** Per-key public salt (first 16 bytes of every signature). */
  get salt(): Uint8Array {
    return this.#salt.slice();
  }

  static fromSeed(seed: Uint8Array): WotsKey {
    bytes32(seed, "seed");
    const salt = keccak256([DOMAIN_SALT, seed]).slice(0, WOTS_SALT_LEN);
    const secrets: Uint8Array[] = [];
    for (let i = 0; i < WOTS_CHAINS; i++) {
      secrets.push(keccak256([DOMAIN_SK, seed, Uint8Array.of(i)]).slice(0, WOTS_N));
    }
    return new WotsKey(salt, secrets);
  }

  keyRoot(): Uint8Array {
    if (this.#keyRoot === undefined) {
      const ends = new Uint8Array(WOTS_CHAINS * WOTS_N);
      for (let i = 0; i < WOTS_CHAINS; i++) {
        ends.set(walk(this.#salt, i, 0, WOTS_CHAIN_END, this.#secret(i)), i * WOTS_N);
      }
      this.#keyRoot = keyRootFromEnds(this.#salt, ends);
    }
    return this.#keyRoot.slice();
  }

  #secret(i: number): Uint8Array {
    const s = this.#secrets[i];
    if (s === undefined) throw new RangeError("chain index out of range");
    return s;
  }

  static {
    signWithKey = (key: WotsKey, message: Uint8Array): Uint8Array => {
      const digits = wotsDigits(key.#salt, message);
      const sig = new Uint8Array(WOTS_SIGNATURE_LEN);
      sig.set(key.#salt, 0);
      for (let i = 0; i < WOTS_CHAINS; i++) {
        sig.set(walk(key.#salt, i, 0, digits[i] as number, key.#secret(i)), WOTS_SALT_LEN + i * WOTS_N);
      }
      return sig;
    };
  }
}

/** A signature that was released (or is about to be) for one (keychain, index). */
export type WotsSignatureRecord = {
  version: 1;
  keychain: string; // hex, 32 bytes
  index: string; // decimal u64
  keyRoot: string; // hex, 32 bytes
  messageSha256: string; // hex
  message: string; // hex
  signature: string; // hex, 1892 bytes
  createdAt: string; // ISO 8601
};

/**
 * Durable record of every signature a keychain has produced. Implementations
 * must make `saveIfAbsent` atomic: at most one record per (keychain, index)
 * can ever be stored, and a stored record must survive a crash.
 */
export interface WotsStore {
  load(keychainId: Uint8Array, index: bigint): Promise<WotsSignatureRecord | undefined>;
  /** Stores the record unless one already exists. Returns false if one existed. */
  saveIfAbsent(record: WotsSignatureRecord): Promise<boolean>;
}

/**
 * Where WOTS signatures that left this device are kept (the Ostra relayer's
 * escrow, GET /v1/signatures/<key root>): the message and signature held for
 * `keyRoot` (0x hex; the answer's bytes are hex too, with or without 0x),
 * null when none is held. Must throw when it cannot tell, so nothing is
 * signed then.
 */
export type WotsSignatureLookup = (keyRoot: string) => Promise<{ message: string; signature: string } | null>;

/** Thrown when an index that already signed is asked to sign a different message. */
export class WotsKeyReuseError extends Error {
  readonly index: bigint;
  constructor(index: bigint) {
    super(`WOTS key ${index} already signed a different message; refusing to sign again`);
    this.name = "WotsKeyReuseError";
    this.index = index;
  }
}

/** Thrown when the derived key does not match the key root the caller expects (e.g. on-chain). */
export class WotsKeyMismatchError extends Error {
  readonly index: bigint;
  constructor(index: bigint) {
    super(`WOTS key ${index} does not match the expected key root`);
    this.name = "WotsKeyMismatchError";
    this.index = index;
  }
}

/**
 * A chain of one-time keys derived from a client master secret. Use one
 * keychain id per on-chain object (a vault, a deposit's approval keys, a set
 * of leaves) and the object's own counter as the index (a vault's nonce).
 * The master secret never leaves the client; Ostra only ever sees key roots.
 */
export class WotsKeychain {
  readonly keychainId: Uint8Array;
  readonly #master: Uint8Array;
  readonly #store: WotsStore;
  readonly #lookup: WotsSignatureLookup | undefined;

  constructor(master: Uint8Array, keychainId: Uint8Array, store: WotsStore, lookup?: WotsSignatureLookup) {
    this.#master = bytes32(master, "master").slice();
    this.keychainId = bytes32(keychainId, "keychainId").slice();
    this.#store = store;
    this.#lookup = lookup;
  }

  #key(index: bigint): WotsKey {
    return WotsKey.fromSeed(deriveWotsSeed(this.#master, this.keychainId, index));
  }

  keyRoot(index: bigint): Uint8Array {
    return this.#key(index).keyRoot();
  }

  /**
   * The signature key `index` released, if any: the local record, or else the
   * one the signature escrow holds for its key root, which is checked (it must
   * verify against the key) and stored locally before it is returned.
   */
  async signed(index: bigint): Promise<WotsSignatureRecord | undefined> {
    const local = await this.#store.load(this.keychainId, index);
    if (local !== undefined || this.#lookup === undefined) return local;
    const keyRoot = this.#key(index).keyRoot();
    const held = await this.#lookup(`0x${toHex(keyRoot)}`);
    if (held === null) return undefined;
    const bare = (h: string) => (h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h).toLowerCase();
    const message = fromHex(bare(held.message));
    const signature = fromHex(bare(held.signature));
    if (!wotsVerify(signature, message, keyRoot)) throw new Error(`the escrowed signature for WOTS key ${index} does not verify against that key`);
    const record: WotsSignatureRecord = {
      version: 1,
      keychain: toHex(this.keychainId),
      index: index.toString(),
      keyRoot: toHex(keyRoot),
      messageSha256: toHex(sha256([message])),
      message: toHex(message),
      signature: toHex(signature),
      createdAt: new Date().toISOString(),
    };
    await this.#store.saveIfAbsent(record);
    return this.#store.load(this.keychainId, index);
  }

  /**
   * Signs `message` with key `index`, at most once per index.
   * - If this index already signed the same message, returns the stored
   *   signature (identical bytes, safe to resubmit).
   * - If it signed a different message, throws WotsKeyReuseError.
   * - Otherwise signs, persists the record, and only then returns.
   * Pass `expectedKeyRoot` (e.g. the vault's current on-chain key root) to
   * refuse signing with a key the contract would reject.
   */
  async sign(index: bigint, message: Uint8Array, expectedKeyRoot?: Uint8Array): Promise<Uint8Array> {
    const key = this.#key(index);
    const keyRoot = key.keyRoot();
    if (expectedKeyRoot !== undefined && !equalBytes(keyRoot, bytes32(expectedKeyRoot, "expectedKeyRoot"))) {
      throw new WotsKeyMismatchError(index);
    }
    for (;;) {
      const existing = await this.signed(index);
      if (existing !== undefined) return this.#reuse(existing, index, message, keyRoot);

      const signature = signWithKey(key, message);
      if (!wotsVerify(signature, message, keyRoot)) throw new Error("WOTS self-check failed");
      const record: WotsSignatureRecord = {
        version: 1,
        keychain: toHex(this.keychainId),
        index: index.toString(),
        keyRoot: toHex(keyRoot),
        messageSha256: toHex(sha256([message])),
        message: toHex(message),
        signature: toHex(signature),
        createdAt: new Date().toISOString(),
      };
      if (await this.#store.saveIfAbsent(record)) return signature;
      // Another writer claimed this index first: re-read and decide.
    }
  }

  #reuse(existing: WotsSignatureRecord, index: bigint, message: Uint8Array, keyRoot: Uint8Array): Uint8Array {
    if (existing.keyRoot !== toHex(keyRoot)) throw new Error("WOTS store record belongs to another master secret");
    if (existing.message !== toHex(message)) throw new WotsKeyReuseError(index);
    const signature = fromHex(existing.signature);
    if (!wotsVerify(signature, message, keyRoot)) throw new Error("stored WOTS signature does not verify");
    return signature;
  }
}

/** Fresh random 32-byte keychain id (or master secret) from the platform CSPRNG (Web Crypto, in Node and in browsers). */
export function randomBytes32(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}
