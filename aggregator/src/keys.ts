// The aggregator key, in OSTRA_AGGREGATOR_SECRETS (mode 0700):
//
//   aggregator.key  32-byte secp256k1 private key (hex, mode 0600). Its
//                   account is the batch aggregator on-chain (the only one
//                   that may append leaves to, seal or abandon its batches)
//                   and pays their gas in ETH. It can never move pool funds:
//                   sealBatch only succeeds when the leaves match the
//                   depositors' commitments and every depositor approved the
//                   batch.
//
// Created on first start and never printed.

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fromHex, toHex } from "@ostraagent/sdk";

export const AGGREGATOR_KEY_FILE = "aggregator.key";

/** secp256k1 group order: a private key must be in 1..n-1. */
const SECP256K1_N = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_fffe_baae_dce6_af48_a03b_bfd2_5e8c_d036_4141n;

async function checkPrivate(path: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} is accessible by other users (mode ${mode.toString(8)}); restrict it to the owner (chmod 700 for a directory, 600 for a file)`);
  }
}

/** Creates `dir` (0700) if missing and refuses one other users can access. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkPrivate(dir);
}

/** True when `secret` is a valid secp256k1 private key. */
export function isPrivateKey(secret: Uint8Array): boolean {
  if (secret.length !== 32) return false;
  const k = BigInt(bytesToHex(secret));
  return k > 0n && k < SECP256K1_N;
}

async function readSecret(path: string): Promise<Uint8Array> {
  await checkPrivate(path);
  const bytes = fromHex((await readFile(path, "utf8")).trim());
  if (bytes.length !== 32) throw new Error(`${path}: expected 32 bytes`);
  return bytes;
}

async function readOrCreateSecret(path: string): Promise<Uint8Array> {
  try {
    return await readSecret(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let secret: Uint8Array;
  do secret = new Uint8Array(randomBytes(32));
  while (!isPrivateKey(secret));
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${toHex(secret)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return secret;
}

/** Opens OSTRA_AGGREGATOR_SECRETS, creating the aggregator key on first use. */
export async function openAggregatorKey(dir: string): Promise<PrivateKeyAccount> {
  await ensurePrivateDir(dir);
  const secret = await readOrCreateSecret(join(dir, AGGREGATOR_KEY_FILE));
  if (!isPrivateKey(secret)) throw new Error(`${AGGREGATOR_KEY_FILE} is not a valid secp256k1 private key`);
  return privateKeyToAccount(bytesToHex(secret));
}
