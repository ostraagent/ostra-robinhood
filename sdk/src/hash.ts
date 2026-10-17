// Hash primitives matching the contracts: original Keccak-256 (the EVM
// keccak256, not SHA3-256) and SHA-256 over concatenated parts (the 0x02
// precompile), and the byte encodings the SDK uses (hex, u64 LE). Nothing here
// depends on Node, so the SDK runs in a browser too.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 as sha256Hash } from "@noble/hashes/sha2.js";

export function keccak256(parts: readonly Uint8Array[]): Uint8Array {
  const h = keccak_256.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

export function sha256(parts: readonly Uint8Array[]): Uint8Array {
  const h = sha256Hash.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  return out;
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) {
    throw new Error("invalid hex string");
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function u64Le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError("u64 out of range");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}
