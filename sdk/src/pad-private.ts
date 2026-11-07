// Ostrapad private jobs (design "Ostrapad: private job", revision 7, decided by Edu on 6 and 7 Nov 2026): the order,
// the delivery and the evaluator's reason of a private job are encrypted files, readable only by the job's client,
// provider, evaluator and appeal panel. OstraPad does not change: a job's bytes32 description, deliverable or reason
// is the sha256 of the encrypted file, as for a public job.
//
// This module is the byte-exact part every reader and writer shares (the MCP, the evaluator bot, the indexer and the
// uploader): the job key K and its commitment, the ML-KEM-768 key wraps, the derivations of the parties' KEM and
// posting keys, the binary file format with its segmented AES-256-GCM, and the messages the parties sign. It runs in a
// browser too (noble only, no Node modules).
//
//   * K: 32 random bytes per job, made by the client. The order file's header carries
//     keyCommit = sha256(HKDF-SHA256(K, salt empty, "OSTRA/PAD/KEY-COMMIT/v1", 32)); a reader takes keyCommit only from
//     the order file whose sha256 is the job's on-chain description, and checks K against it before it decrypts.
//   * A wrap of K for one recipient: (ct, ss) = ML-KEM-768.encapsulate(pk, m), m derived from K and the wrap's job, round
//     and recipient (wrapM), so a holder of K can recompute any wrap;
//     kek = HKDF-SHA256(ss, salt = sha256(ct), "OSTRA/PAD/WRAP/v1" || recipient || sha256(pk), 32);
//     wrapped = AES-256-GCM(kek, nonce 12 zero bytes, K, aad = recipient || sha256(pk)) (48 bytes).
//   * A file: header (magic, kind, salt, plaintext length, segment size; an order also keyCommit, the two posting
//     addresses and up to 4 wraps), then the plaintext in 1 MiB segments, each sealed with
//     fileKey = HKDF-SHA256(K, salt, "OSTRA/PAD/FILE/v1" || kind, 32), nonce = segment number (11 bytes, big-endian)
//     || last flag (1 byte), aad = sha256(header). A missing, swapped, cut or extended segment fails authentication.
//   * The plaintext: manifest length (u32 big-endian), the manifest (JSON), then each attachment's bytes in order.

import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 as sha256Hash } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { bytesToHex, encodeAbiParameters, getAddress, hexToBytes, isAddress, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sha256, utf8 } from "./hash.ts";

/** The file magic: "OSTRAPAD-ENC1" (13 bytes). */
export const PAD_ENC_MAGIC = utf8("OSTRAPAD-ENC1");
/** The kinds of encrypted file. */
export const PAD_ENC_KIND = { order: 1, delivery: 2, reason: 3 } as const;
export type PadEncKind = (typeof PAD_ENC_KIND)[keyof typeof PAD_ENC_KIND];
/** Every segment is exactly 1 MiB of plaintext, except the last (which may be shorter, or empty for an empty file). */
export const PAD_ENC_SEGMENT = 1_048_576;
/** The largest plaintext of one file: 100,000,000 bytes (decided by Edu, 6 Nov 2026). */
export const PAD_ENC_MAX_PLAINTEXT = 100_000_000;
/** The largest encrypted file: the largest plaintext, 16 bytes of tag per segment and the largest header. */
export const PAD_ENC_MAX_FILE = 100_100_000;
/** The most key wraps an order header carries (the client, the provider; a fixed evaluator is the client). */
export const PAD_ENC_MAX_WRAPS = 4;
/** The most attachments a manifest lists. */
export const PAD_ENC_MAX_ATTACHMENTS = 64;
/** The longest manifest (JSON bytes). */
export const PAD_ENC_MAX_MANIFEST = 65_536;

/** ML-KEM-768 sizes: public key, ciphertext. */
export const PAD_KEM_PUBLIC_KEY_BYTES = 1184;
export const PAD_KEM_CIPHERTEXT_BYTES = 1088;
/** A wrap's AES-GCM output: K (32) and its tag (16). */
export const PAD_WRAPPED_BYTES = 48;
/** One wrap in an order header: recipient (20), sha256(pk) (32), ct (1088), wrapped (48). */
export const PAD_WRAP_BYTES = 20 + 32 + PAD_KEM_CIPHERTEXT_BYTES + PAD_WRAPPED_BYTES;

const TAG = 16;
const BASE_HEADER = PAD_ENC_MAGIC.length + 1 + 32 + 8 + 4;
const ORDER_FIXED = 32 + 20 + 20 + 1;
const EMPTY = new Uint8Array(0);
const SECP256K1_N = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_fffe_baae_dce6_af48_a03b_bfd2_5e8c_d036_4141n;

const KEY_COMMIT_INFO = utf8("OSTRA/PAD/KEY-COMMIT/v1");
const WRAP_INFO = utf8("OSTRA/PAD/WRAP/v1");
const FILE_INFO = utf8("OSTRA/PAD/FILE/v1");
/** The KEM seed domains: an MCP agent's (from its master seed) and the evaluator bot's (from each account's key). */
export const PAD_KEM_DOMAIN = { mcp: "OSTRA/MCP/PAD-KEM/EVM/v1", keeper: "OSTRA/KEEPER/PAD-KEM/EVM/v1" } as const;
const POST_INFO = utf8("OSTRA/MCP/PAD-POST/EVM/v1");

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** The chain ID as 32 bytes, big-endian (as core keys.ts chainBytes). */
function chainBytes(chainId: number): Uint8Array {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError("chainId must be a positive integer");
  return hexToBytes(`0x${BigInt(chainId).toString(16).padStart(64, "0")}`);
}

function addressBytes(a: Address): Uint8Array {
  if (!isAddress(a, { strict: false })) throw new RangeError(`not an address: ${a}`);
  return hexToBytes(getAddress(a));
}

function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length = 32): Uint8Array {
  return hkdf(sha256Hash, ikm, salt, info, length);
}

function key32(k: Uint8Array, what: string): void {
  if (!(k instanceof Uint8Array) || k.length !== 32) throw new RangeError(`${what} must be 32 bytes`);
}

// ---------------------------------------------------------------------------------------------------------------- K

/** A new job key K (32 random bytes). */
export function padNewJobKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** keyCommit of K: sha256(HKDF-SHA256(K, salt empty, "OSTRA/PAD/KEY-COMMIT/v1", 32)). */
export function padKeyCommit(k: Uint8Array): Uint8Array {
  key32(k, "K");
  return sha256([hkdf32(k, EMPTY, KEY_COMMIT_INFO)]);
}

/** True when K matches keyCommit. */
export function padKeyMatches(k: Uint8Array, keyCommit: Uint8Array): boolean {
  return k.length === 32 && keyCommit.length === 32 && equal(padKeyCommit(k), keyCommit);
}

// ---------------------------------------------------------------------------------------------------------------- keys

/** The 64-byte ML-KEM-768 seed of `ikm`: HKDF-SHA256(ikm, salt empty, domain || chainId (32) || OstraPad (20), 64). */
export function padKemSeed(ikm: Uint8Array, domain: (typeof PAD_KEM_DOMAIN)[keyof typeof PAD_KEM_DOMAIN], chainId: number, pad: Address): Uint8Array {
  if (ikm.length !== 32) throw new RangeError("the KEM seed's input key must be 32 bytes");
  return hkdf32(ikm, EMPTY, concat([utf8(domain), chainBytes(chainId), addressBytes(pad)]), 64);
}

export type PadKemKeys = { publicKey: Uint8Array; secretKey: Uint8Array };

/** The ML-KEM-768 key pair of a 64-byte seed (d = its first 32 bytes, z = its last 32); the seed is wiped. */
export function padKemKeys(seed64: Uint8Array): PadKemKeys {
  if (seed64.length !== 64) throw new RangeError("the KEM seed must be 64 bytes");
  try {
    const { publicKey, secretKey } = ml_kem768.keygen(seed64);
    return { publicKey, secretKey };
  } finally {
    seed64.fill(0);
  }
}

/** sha256 of an ML-KEM-768 public key, after checking it is one (the length and FIPS 203's modulus check). */
export function padKemKeyHash(pk: Uint8Array): Uint8Array {
  padCheckKemPublicKey(pk);
  return sha256([pk]);
}

/** Throws unless `pk` is a well-formed ML-KEM-768 public key (a trial encapsulation runs FIPS 203's modulus check). */
export function padCheckKemPublicKey(pk: Uint8Array): void {
  if (!(pk instanceof Uint8Array) || pk.length !== PAD_KEM_PUBLIC_KEY_BYTES) throw new RangeError(`an ML-KEM-768 public key is ${PAD_KEM_PUBLIC_KEY_BYTES} bytes`);
  const { sharedSecret } = ml_kem768.encapsulate(pk);
  sharedSecret.fill(0);
}

/**
 * The posting key of a master seed (secp256k1): HKDF-SHA256(seed, salt empty, "OSTRA/MCP/PAD-POST/EVM/v1" || chainId (32)
 * || OstraPad (20) || counter (1), 32), the first counter from 0 whose value is in 1..n-1.
 */
export function padPostingAccount(master: Uint8Array, chainId: number, pad: Address): PrivateKeyAccount {
  if (master.length !== 32) throw new RangeError("the master seed must be 32 bytes");
  const base = concat([POST_INFO, chainBytes(chainId), addressBytes(pad)]);
  for (let counter = 0; counter < 256; counter++) {
    const secret = hkdf32(master, EMPTY, concat([base, Uint8Array.of(counter)]));
    const k = BigInt(bytesToHex(secret));
    if (k > 0n && k < SECP256K1_N) return privateKeyToAccount(bytesToHex(secret));
  }
  throw new Error("no posting key in 256 counters");
}

// ---------------------------------------------------------------------------------------------------------------- wraps

export type PadWrap = { recipient: Address; pkHash: Uint8Array; ct: Uint8Array; wrapped: Uint8Array };

function wrapKek(ss: Uint8Array, ct: Uint8Array, recipient: Uint8Array, pkHash: Uint8Array): Uint8Array {
  return hkdf32(ss, sha256([ct]), concat([WRAP_INFO, recipient, pkHash]));
}

const ZERO_NONCE = new Uint8Array(12);
const WRAP_M_INFO = utf8("OSTRA/PAD/WRAP-M/v1");

/** Where a wrap is used: the job and its round (0 in the order header, the evaluator's round, or PAD_PANEL_ROUND). */
export type PadWrapContext = { chainId: number; pad: Address; jobId: Hex; round: number };

/**
 * The encapsulation randomness of a wrap (revision 8): m = HKDF-SHA256(K, salt empty, "OSTRA/PAD/WRAP-M/v1" || chainId
 * (32) || OstraPad (20) || jobId (32) || round (u32) || recipient (20) || sha256(pk), 32). It makes a wrap deterministic,
 * so anyone holding K can recompute it byte for byte (padVerifyWrap); only holders of K can derive m. This departs from
 * FIPS 203's "m from an approved RBG": m is a KDF output of K, 32 random bytes used for one job (recorded in the design).
 */
function wrapM(k: Uint8Array, ctx: PadWrapContext, recipient: Uint8Array, pkHash: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(ctx.round) || ctx.round < 0 || ctx.round > 0xffff_ffff) throw new RangeError("round out of range");
  if (!/^0x[0-9a-fA-F]{64}$/.test(ctx.jobId)) throw new RangeError("jobId is 32 bytes");
  const round = new Uint8Array(4);
  new DataView(round.buffer).setUint32(0, ctx.round, false);
  return hkdf32(k, EMPTY, concat([WRAP_M_INFO, chainBytes(ctx.chainId), addressBytes(ctx.pad), hexToBytes(ctx.jobId), round, recipient, pkHash]));
}

/** Wraps K for `recipient`'s ML-KEM-768 public key `pk`, deterministically for its job and round (wrapM). */
export function padWrapKey(k: Uint8Array, ctx: PadWrapContext, recipient: Address, pk: Uint8Array): PadWrap {
  key32(k, "K");
  const pkHash = padKemKeyHash(pk);
  const r = addressBytes(recipient);
  const m = wrapM(k, ctx, r, pkHash);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(pk, m);
  m.fill(0);
  const kek = wrapKek(sharedSecret, cipherText, r, pkHash);
  sharedSecret.fill(0);
  const wrapped = gcm(kek, ZERO_NONCE, concat([r, pkHash])).encrypt(k);
  kek.fill(0);
  return { recipient: getAddress(recipient), pkHash, ct: cipherText, wrapped };
}

/**
 * True when `w` is exactly the wrap of K for `recipient`'s key `pk` in `ctx` (recomputed byte for byte), with K first
 * checked against keyCommit. Ostra's panel counts a provider's wrap only when this holds (revision 8).
 */
export function padVerifyWrap(k: Uint8Array, keyCommit: Uint8Array, w: PadWrap, recipient: Address, pk: Uint8Array, ctx: PadWrapContext): boolean {
  if (!padKeyMatches(k, keyCommit)) return false;
  let again: PadWrap;
  try {
    again = padWrapKey(k, ctx, recipient, pk);
  } catch {
    return false;
  }
  return getAddress(w.recipient) === again.recipient && equal(w.pkHash, again.pkHash) && equal(w.ct, again.ct) && equal(w.wrapped, again.wrapped);
}

/**
 * K from a wrap for `recipient` under its key pair, or null when the wrap is not for this key (another pkHash), does
 * not open (a wrong or forged wrap fails GCM authentication; decapsulation uses ML-KEM's implicit reject), or opens to a
 * key that does not match the job's keyCommit (so no reader ever decrypts under a key the client did not commit to).
 */
export function padUnwrapKey(w: PadWrap, recipient: Address, keys: PadKemKeys, keyCommit: Uint8Array): Uint8Array | null {
  if (getAddress(w.recipient) !== getAddress(recipient)) return null;
  if (w.ct.length !== PAD_KEM_CIPHERTEXT_BYTES || w.wrapped.length !== PAD_WRAPPED_BYTES || w.pkHash.length !== 32) return null;
  const pkHash = sha256([keys.publicKey]);
  if (!equal(pkHash, w.pkHash)) return null;
  const r = addressBytes(recipient);
  const ss = ml_kem768.decapsulate(w.ct, keys.secretKey);
  const kek = wrapKek(ss, w.ct, r, pkHash);
  ss.fill(0);
  let k: Uint8Array;
  try {
    k = gcm(kek, ZERO_NONCE, concat([r, pkHash])).decrypt(w.wrapped);
  } catch {
    return null;
  } finally {
    kek.fill(0);
  }
  if (!padKeyMatches(k, keyCommit)) {
    k.fill(0);
    return null;
  }
  return k;
}

/** A wrap as its 1,188 bytes (recipient, sha256(pk), ct, wrapped), as in an order header and the indexer's wrap posts. */
export function padWrapBytes(w: PadWrap): Uint8Array {
  if (w.pkHash.length !== 32 || w.ct.length !== PAD_KEM_CIPHERTEXT_BYTES || w.wrapped.length !== PAD_WRAPPED_BYTES) throw new RangeError("malformed wrap");
  return concat([addressBytes(w.recipient), w.pkHash, w.ct, w.wrapped]);
}

/** The wrap in 1,188 bytes. */
export function padWrapFromBytes(b: Uint8Array): PadWrap {
  if (b.length !== PAD_WRAP_BYTES) throw new RangeError(`a wrap is ${PAD_WRAP_BYTES} bytes`);
  return {
    recipient: getAddress(bytesToHex(b.subarray(0, 20))),
    pkHash: b.slice(20, 52),
    ct: b.slice(52, 52 + PAD_KEM_CIPHERTEXT_BYTES),
    wrapped: b.slice(52 + PAD_KEM_CIPHERTEXT_BYTES),
  };
}

// ---------------------------------------------------------------------------------------------------------------- file format

export type PadOrderHeaderPart = { keyCommit: Uint8Array; clientPosting: Address; providerPosting: Address; wraps: PadWrap[] };

export type PadEncHeader = {
  kind: PadEncKind;
  salt: Uint8Array;
  /** The plaintext's length in bytes. */
  plaintextLength: number;
  /** The order's extra part (kind 1 only). */
  order: PadOrderHeaderPart | null;
};

/** The header's bytes. */
export function padEncodeHeader(h: PadEncHeader): Uint8Array {
  if (h.salt.length !== 32) throw new RangeError("the salt is 32 bytes");
  if (!Number.isSafeInteger(h.plaintextLength) || h.plaintextLength < 0 || h.plaintextLength > PAD_ENC_MAX_PLAINTEXT) throw new RangeError("plaintext length out of range");
  const base = new Uint8Array(BASE_HEADER);
  base.set(PAD_ENC_MAGIC, 0);
  base[13] = h.kind;
  base.set(h.salt, 14);
  const view = new DataView(base.buffer);
  view.setBigUint64(46, BigInt(h.plaintextLength), false);
  view.setUint32(54, PAD_ENC_SEGMENT, false);
  if (h.kind !== PAD_ENC_KIND.order) {
    if (h.order) throw new RangeError("only an order header has an order part");
    if (h.kind !== PAD_ENC_KIND.delivery && h.kind !== PAD_ENC_KIND.reason) throw new RangeError("unknown kind");
    return base;
  }
  const o = h.order;
  if (!o) throw new RangeError("an order header needs its order part");
  if (o.keyCommit.length !== 32) throw new RangeError("keyCommit is 32 bytes");
  if (o.wraps.length < 1 || o.wraps.length > PAD_ENC_MAX_WRAPS) throw new RangeError(`an order carries 1 to ${PAD_ENC_MAX_WRAPS} wraps`);
  const seen = new Set<string>();
  for (const w of o.wraps) {
    const r = getAddress(w.recipient);
    if (seen.has(r)) throw new RangeError("two wraps for one recipient");
    seen.add(r);
  }
  return concat([base, o.keyCommit, addressBytes(o.clientPosting), addressBytes(o.providerPosting), Uint8Array.of(o.wraps.length), ...o.wraps.map(padWrapBytes)]);
}

/** The length of the header that starts `bytes`, or null when `bytes` holds less of it than needed to tell. */
export function padHeaderLength(bytes: Uint8Array): number | null {
  if (bytes.length < BASE_HEADER) return null;
  if (!equal(bytes.subarray(0, 13), PAD_ENC_MAGIC)) throw new Error("not an Ostrapad encrypted file (magic)");
  const kind = bytes[13];
  if (kind === PAD_ENC_KIND.delivery || kind === PAD_ENC_KIND.reason) return BASE_HEADER;
  if (kind !== PAD_ENC_KIND.order) throw new Error(`unknown kind ${kind}`);
  if (bytes.length < BASE_HEADER + ORDER_FIXED) return null;
  const n = bytes[BASE_HEADER + ORDER_FIXED - 1]!;
  if (n < 1 || n > PAD_ENC_MAX_WRAPS) throw new Error(`an order carries 1 to ${PAD_ENC_MAX_WRAPS} wraps, not ${n}`);
  return BASE_HEADER + ORDER_FIXED + n * PAD_WRAP_BYTES;
}

/** The largest header (an order with PAD_ENC_MAX_WRAPS wraps): read this much to parse any header. */
export const PAD_ENC_MAX_HEADER = BASE_HEADER + ORDER_FIXED + PAD_ENC_MAX_WRAPS * PAD_WRAP_BYTES;

/** The header that starts `bytes` (all of it must be there), checked byte by byte; throws on anything else. */
export function padParseHeader(bytes: Uint8Array): { header: PadEncHeader; length: number } {
  const length = padHeaderLength(bytes);
  if (length === null || bytes.length < length) throw new Error("the header is cut short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = bytes[13] as PadEncKind;
  const salt = bytes.slice(14, 46);
  const plain = view.getBigUint64(46, false);
  if (plain > BigInt(PAD_ENC_MAX_PLAINTEXT)) throw new Error("plaintext length over the limit");
  if (view.getUint32(54, false) !== PAD_ENC_SEGMENT) throw new Error("the segment size must be 1,048,576");
  let order: PadOrderHeaderPart | null = null;
  if (kind === PAD_ENC_KIND.order) {
    let o = BASE_HEADER;
    const keyCommit = bytes.slice(o, o + 32);
    o += 32;
    const clientPosting = getAddress(bytesToHex(bytes.subarray(o, o + 20)));
    o += 20;
    const providerPosting = getAddress(bytesToHex(bytes.subarray(o, o + 20)));
    o += 20;
    const n = bytes[o]!;
    o += 1;
    const wraps: PadWrap[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const w = padWrapFromBytes(bytes.subarray(o, o + PAD_WRAP_BYTES));
      if (seen.has(w.recipient)) throw new Error("two wraps for one recipient");
      seen.add(w.recipient);
      wraps.push(w);
      o += PAD_WRAP_BYTES;
    }
    order = { keyCommit, clientPosting, providerPosting, wraps };
  }
  return { header: { kind, salt, plaintextLength: Number(plain), order }, length };
}

/** The number of segments of a plaintext of `n` bytes (an empty plaintext is one empty segment). */
export function padSegmentCount(n: number): number {
  return n === 0 ? 1 : Math.ceil(n / PAD_ENC_SEGMENT);
}

/** The length of the encrypted file with a header of `headerLength` bytes and a plaintext of `n` bytes. */
export function padEncryptedLength(headerLength: number, n: number): number {
  return headerLength + n + padSegmentCount(n) * TAG;
}

/** The key that seals a file's segments: HKDF-SHA256(K, salt, "OSTRA/PAD/FILE/v1" || kind, 32). */
export function padFileKey(k: Uint8Array, salt: Uint8Array, kind: PadEncKind): Uint8Array {
  key32(k, "K");
  if (salt.length !== 32) throw new RangeError("the salt is 32 bytes");
  return hkdf32(k, salt, concat([FILE_INFO, Uint8Array.of(kind)]));
}

function segmentNonce(index: number, last: boolean): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("segment number out of range");
  const nonce = new Uint8Array(12);
  let v = BigInt(index);
  for (let i = 10; i >= 0; i--) {
    nonce[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  nonce[11] = last ? 1 : 0;
  return nonce;
}

/** Segment `index` sealed (plaintext || tag); `aad` is sha256 of the header. */
export function padSealSegment(fileKey: Uint8Array, aad: Uint8Array, index: number, last: boolean, plaintext: Uint8Array): Uint8Array {
  if (plaintext.length > PAD_ENC_SEGMENT || (!last && plaintext.length !== PAD_ENC_SEGMENT)) throw new RangeError("a segment is 1 MiB, the last at most 1 MiB");
  return gcm(fileKey, segmentNonce(index, last), aad).encrypt(plaintext);
}

/** Segment `index` opened; throws when it does not authenticate. */
export function padOpenSegment(fileKey: Uint8Array, aad: Uint8Array, index: number, last: boolean, sealed: Uint8Array): Uint8Array {
  if (sealed.length < TAG || sealed.length > PAD_ENC_SEGMENT + TAG || (!last && sealed.length !== PAD_ENC_SEGMENT + TAG)) throw new Error("segment of the wrong length");
  try {
    return gcm(fileKey, segmentNonce(index, last), aad).decrypt(sealed);
  } catch {
    throw new Error(`segment ${index} does not authenticate`);
  }
}

/** A new random 32-byte salt. */
export function padNewSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** An encrypted file in memory (header, then every segment sealed). For large files, seal segment by segment instead. */
export function padEncryptFile(k: Uint8Array, header: PadEncHeader, plaintext: Uint8Array): Uint8Array {
  if (plaintext.length !== header.plaintextLength) throw new RangeError("the header's plaintext length differs");
  const head = padEncodeHeader(header);
  const aad = sha256([head]);
  const fk = padFileKey(k, header.salt, header.kind);
  const count = padSegmentCount(plaintext.length);
  const parts: Uint8Array[] = [head];
  for (let i = 0; i < count; i++) parts.push(padSealSegment(fk, aad, i, i === count - 1, plaintext.subarray(i * PAD_ENC_SEGMENT, (i + 1) * PAD_ENC_SEGMENT)));
  fk.fill(0);
  return concat(parts);
}

/**
 * The header and plaintext of an encrypted file in memory; throws on a K that does not match the job's keyCommit (taken
 * from the order file the job's on-chain description names) and on any malformed, cut, extended or forged byte.
 */
export function padDecryptFile(k: Uint8Array, keyCommit: Uint8Array, file: Uint8Array): { header: PadEncHeader; plaintext: Uint8Array } {
  if (!padKeyMatches(k, keyCommit)) throw new Error("K does not match the job's keyCommit");
  const { header, length } = padParseHeader(file);
  if (file.length !== padEncryptedLength(length, header.plaintextLength)) throw new Error("the file's length does not match its header");
  const aad = sha256([file.subarray(0, length)]);
  const fk = padFileKey(k, header.salt, header.kind);
  const count = padSegmentCount(header.plaintextLength);
  const out = new Uint8Array(header.plaintextLength);
  let o = length;
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const plain = last ? header.plaintextLength - i * PAD_ENC_SEGMENT : PAD_ENC_SEGMENT;
    const seg = padOpenSegment(fk, aad, i, last, file.subarray(o, o + plain + TAG));
    out.set(seg, i * PAD_ENC_SEGMENT);
    o += plain + TAG;
  }
  fk.fill(0);
  return { header, plaintext: out };
}

/** Bytes read by offset: a file on disk, a download kept on disk, or bytes in memory (padBytesSource). */
export type PadByteSource = { size: number; read(offset: number, length: number): Promise<Uint8Array> };

/** A byte source over bytes in memory. */
export function padBytesSource(bytes: Uint8Array): PadByteSource {
  return { size: bytes.length, read: async (o, n) => bytes.subarray(o, o + n) };
}

async function readExact(src: PadByteSource, offset: number, length: number): Promise<Uint8Array> {
  const b = await src.read(offset, length);
  if (b.length !== length) throw new Error("the file is cut short");
  return b;
}

/**
 * Opens an encrypted file segment by segment (for files up to 100 MB the bot and the MCP read from disk): K is checked
 * against keyCommit first, the header is parsed, the source's size must be exactly what the header gives, and each
 * segment is authenticated before its plaintext is yielded (an error ends the reading; what was yielded before is from
 * segments that authenticated, and the reader discards it when the file does not finish).
 */
export async function padOpenFile(k: Uint8Array, keyCommit: Uint8Array, src: PadByteSource): Promise<{ header: PadEncHeader; headerLength: number; segments: () => AsyncGenerator<Uint8Array> }> {
  if (!padKeyMatches(k, keyCommit)) throw new Error("K does not match the job's keyCommit");
  const first = await src.read(0, Math.min(PAD_ENC_MAX_HEADER, src.size));
  const { header, length } = padParseHeader(first);
  if (src.size !== padEncryptedLength(length, header.plaintextLength)) throw new Error("the file's length does not match its header");
  const aad = sha256([first.subarray(0, length)]);
  const kk = k.slice();
  async function* segments(): AsyncGenerator<Uint8Array> {
    const fk = padFileKey(kk, header.salt, header.kind);
    try {
      const count = padSegmentCount(header.plaintextLength);
      let o = length;
      for (let i = 0; i < count; i++) {
        const last = i === count - 1;
        const plain = last ? header.plaintextLength - i * PAD_ENC_SEGMENT : PAD_ENC_SEGMENT;
        yield padOpenSegment(fk, aad, i, last, await readExact(src, o, plain + TAG));
        o += plain + TAG;
      }
    } finally {
      fk.fill(0);
      kk.fill(0);
    }
  }
  return { header, headerLength: length, segments };
}

/** The encrypted file of `plaintext` (read segment by segment), yielded as the header and then each sealed segment. */
export async function* padSealFile(k: Uint8Array, header: PadEncHeader, plaintext: PadByteSource): AsyncGenerator<Uint8Array> {
  if (plaintext.size !== header.plaintextLength) throw new RangeError("the header's plaintext length differs");
  const head = padEncodeHeader(header);
  yield head;
  const aad = sha256([head]);
  const fk = padFileKey(k, header.salt, header.kind);
  try {
    const count = padSegmentCount(header.plaintextLength);
    for (let i = 0; i < count; i++) {
      const last = i === count - 1;
      const n = last ? header.plaintextLength - i * PAD_ENC_SEGMENT : PAD_ENC_SEGMENT;
      yield padSealSegment(fk, aad, i, last, await readExact(plaintext, i * PAD_ENC_SEGMENT, n));
    }
  } finally {
    fk.fill(0);
  }
}

/** Throws unless every salt of one job's files (its order, deliveries and reasons) differs from every other. */
export function padCheckSalts(salts: readonly Uint8Array[]): void {
  const seen = new Set<string>();
  for (const s of salts) {
    const h = bytesToHex(s);
    if (seen.has(h)) throw new Error("two files of one job share a salt");
    seen.add(h);
  }
}

// ---------------------------------------------------------------------------------------------------------------- plaintext

export type PadAttachment = { name: string; size: number; sha256: Hex; type: "text" | "binary" };

/** The plaintext's prefix: the manifest's length (u32 big-endian) and the manifest. */
export function padPlaintextPrefix(manifest: Record<string, unknown>): Uint8Array {
  const json = utf8(JSON.stringify(manifest));
  if (json.length > PAD_ENC_MAX_MANIFEST) throw new RangeError(`the manifest is over ${PAD_ENC_MAX_MANIFEST} bytes`);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.length, false);
  return concat([len, json]);
}

/** The manifest's length from the plaintext's first 4 bytes. */
export function padManifestLength(first4: Uint8Array): number {
  if (first4.length < 4) throw new Error("the plaintext is cut short");
  const n = new DataView(first4.buffer, first4.byteOffset, 4).getUint32(0, false);
  if (n > PAD_ENC_MAX_MANIFEST) throw new Error("the manifest is over the limit");
  return n;
}

/**
 * The manifest of a plaintext, with its attachments checked: at most PAD_ENC_MAX_ATTACHMENTS, each with a safe base name
 * no other has (also case- and NFC-folded), a size and a sha256, and the sizes add up to exactly what follows the
 * manifest. Each attachment's own sha256 is checked by whoever reads its bytes.
 */
export function padParseManifest(plaintextLength: number, manifestBytes: Uint8Array, o: { pool?: boolean } = {}): { manifest: Record<string, unknown>; attachments: PadAttachment[] } {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error("the manifest is not JSON");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw new Error("the manifest is not an object");
  const m = manifest as Record<string, unknown>;
  if ("files" in m) throw new Error("a private manifest has no public files");
  const raw = m.attachments ?? [];
  if (!Array.isArray(raw) || raw.length > PAD_ENC_MAX_ATTACHMENTS) throw new Error(`at most ${PAD_ENC_MAX_ATTACHMENTS} attachments`);
  const attachments: PadAttachment[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const a of raw as unknown[]) {
    if (typeof a !== "object" || a === null) throw new Error("an attachment is not an object");
    const { name, size, sha256: hash, type } = a as Record<string, unknown>;
    if (typeof name !== "string" || !padSafeAttachmentName(name)) throw new Error(`unsafe attachment name ${JSON.stringify(name)}`);
    const folded = name.normalize("NFC").toLowerCase();
    if (names.has(folded)) throw new Error(`two attachments named ${name}`);
    names.add(folded);
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new Error(`attachment ${name}: bad size`);
    if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/.test(hash)) throw new Error(`attachment ${name}: bad sha256`);
    if (type !== "text" && type !== "binary") throw new Error(`attachment ${name}: type must be text or binary`);
    if (o.pool === true && type !== "text") throw new Error(`attachment ${name}: a job judged by the pool takes text attachments only`);
    total += size;
    attachments.push({ name, size, sha256: hash as Hex, type });
  }
  if (4 + manifestBytes.length + total !== plaintextLength) throw new Error("the attachments' sizes do not add up to the plaintext");
  return { manifest: m, attachments };
}

/** Throws unless `bytes` are valid UTF-8 (a text attachment; on a pool job every attachment is text). */
export function padCheckText(bytes: Uint8Array, name: string): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`attachment ${name} is not valid UTF-8 text`);
  }
}

/**
 * Throws unless a manifest belongs where it was found (revisions 3 and 4): an order's type is ostrapad-order-v1 and names
 * the job's client and provider on this chain; a delivery's (ostrapad-delivery-v1) and a reason's (ostrapad-decision-v1)
 * name this job, so a file cannot be carried over to another job, even one sharing the order file.
 */
export function padCheckManifest(m: Record<string, unknown>, kind: PadEncKind, job: { id: Hex; client: Address; provider: Address; chainId: number }): void {
  const caip = (a: Address) => `eip155:${job.chainId}:${getAddress(a)}`.toLowerCase();
  if (kind === PAD_ENC_KIND.order) {
    if (m.type !== "ostrapad-order-v1") throw new Error("not an order manifest");
    if (typeof m.client !== "string" || m.client.toLowerCase() !== caip(job.client)) throw new Error("the order names another client");
    if (typeof m.provider !== "string" || m.provider.toLowerCase() !== caip(job.provider)) throw new Error("the order names another provider");
    return;
  }
  if (m.type !== (kind === PAD_ENC_KIND.delivery ? "ostrapad-delivery-v1" : "ostrapad-decision-v1")) throw new Error(`not a ${kind === PAD_ENC_KIND.delivery ? "delivery" : "reason"} manifest`);
  if (typeof m.job !== "string" || m.job.toLowerCase() !== job.id.toLowerCase()) throw new Error("the file names another job");
  if (kind === PAD_ENC_KIND.delivery && m.chain !== `eip155:${job.chainId}`) throw new Error("the delivery names another chain");
}

/** A safe attachment name: the MCP's record-name rule (mcp/src/disk.ts): [A-Za-z0-9] then up to 200 of [A-Za-z0-9._-], no "..". */
export function padSafeAttachmentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name) && !name.includes("..");
}

// ---------------------------------------------------------------------------------------------------------------- signed messages

/** The tag of every message a party signs (EIP-191 over keccak256(abi.encode(tag, ...)): signMessage({ message: { raw } })). */
export const PAD_MSG_TAG = { wrap: "OSTRAPAD-WRAP-v1", upload: "OSTRAPAD-UPLOAD-v1", kem: "OSTRAPAD-KEM-v1", reserve: "OSTRAPAD-RESERVE-v1" } as const;
/** The round a panel wrap names: above every evaluator round (uint8), so a panel slot never meets an evaluator's. */
export const PAD_PANEL_ROUND = 256;

function b32(b: Uint8Array): Hex {
  if (b.length !== 32) throw new RangeError("32 bytes expected");
  return bytesToHex(b);
}

/** keccak256(abi.encode("OSTRAPAD-WRAP-v1", chainId, OstraPad, jobId, round, recipient, sha256(pk), keccak256(ct || wrapped), seq)). */
export function padWrapMessage(o: { chainId: number; pad: Address; jobId: Hex; round: number; wrap: PadWrap; seq: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
      [PAD_MSG_TAG.wrap, BigInt(o.chainId), getAddress(o.pad), o.jobId, o.round, getAddress(o.wrap.recipient), b32(o.wrap.pkHash), keccak256(concat([o.wrap.ct, o.wrap.wrapped])), o.seq],
    ),
  );
}

/** The signer of an EIP-191 signature over a message hash (signMessage({ message: { raw: hash } })); null for a malformed signature. */
export async function padRecoverSigner(hash: Hex, signature: Hex): Promise<Address | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    return getAddress(await recoverMessageAddress({ message: { raw: hash }, signature }));
  } catch {
    return null;
  }
}

/** keccak256(abi.encode("OSTRAPAD-UPLOAD-v1", chainId, OstraPad, jobId, kind, sha256 of the file, size)). */
export function padUploadMessage(o: { chainId: number; pad: Address; jobId: Hex; kind: PadEncKind; sha256: Hex; size: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint64" }],
      [PAD_MSG_TAG.upload, BigInt(o.chainId), getAddress(o.pad), o.jobId, o.kind, o.sha256, o.size],
    ),
  );
}

/** keccak256(abi.encode("OSTRAPAD-KEM-v1", chainId, OstraPad, member, sha256(pk), posting address, issuedAt)). */
export function padKemMessage(o: { chainId: number; pad: Address; member: Address; pkHash: Uint8Array; posting: Address; issuedAt: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint64" }],
      [PAD_MSG_TAG.kem, BigInt(o.chainId), getAddress(o.pad), getAddress(o.member), b32(o.pkHash), getAddress(o.posting), o.issuedAt],
    ),
  );
}

/** keccak256(abi.encode("OSTRAPAD-RESERVE-v1", chainId, OstraPad, jobId, bytes, seq)). */
export function padReserveMessage(o: { chainId: number; pad: Address; jobId: Hex; bytes: bigint; seq: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }],
      [PAD_MSG_TAG.reserve, BigInt(o.chainId), getAddress(o.pad), o.jobId, o.bytes, o.seq],
    ),
  );
}

/** The most bytes a job's order file may hold and be kept past a day: 20 MB per USDG of budget, at least 5 MB, at most 100 MB (revision 8). */
export function padOrderByteAllowance(budget: bigint): number {
  if (budget < 0n) throw new RangeError("budget is negative");
  const n = (budget * 20_000_000n) / 1_000_000n;
  return Number(n < 5_000_000n ? 5_000_000n : n > BigInt(PAD_ENC_MAX_FILE) ? BigInt(PAD_ENC_MAX_FILE) : n);
}

/** The most delivery files one job may upload. */
export const PAD_ENC_MAX_DELIVERIES = 3;
/** The most bytes one job's delivery files may take: 20 MB per USDG of budget (6 decimals), at least 5 MB, at most 300 MB. Each file is also at most PAD_ENC_MAX_FILE. */
export function padJobByteAllowance(budget: bigint): number {
  if (budget < 0n) throw new RangeError("budget is negative");
  const n = (budget * 20_000_000n) / 1_000_000n;
  return Number(n < 5_000_000n ? 5_000_000n : n > 300_000_000n ? 300_000_000n : n);
}
