// Seller secrets, in OSTRA_MERCHANT_SECRETS (mode 0700):
//
//   merchant.key     32-byte secp256k1 private key (hex, mode 0600): the
//                    merchant key. The keeper derives this seller's crank from
//                    its address, and the seller's server signs its close
//                    requests with it. It never holds funds.
//   facilitator.key  32-byte secp256k1 private key (hex, mode 0600): the
//                    account of this server's own x402 facilitator, which sends
//                    the deposit transactions of buyers who open or top up a
//                    channel with an EIP-3009 authorization. It needs ETH for
//                    gas and nothing else.
//
// Both are created on first start and never printed. (On Solana the second
// file was the MPP challenge HMAC secret; x402 challenges are not bound by a
// server secret.)

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, encodePacked, hexToBytes, stringToHex, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const MERCHANT_KEY_FILE = "merchant.key";
export const FACILITATOR_KEY_FILE = "facilitator.key";

/** The keeper's close-request domain (keeper/src/keys.ts). */
const CLOSE_DOMAIN = stringToHex("OSTRA/KEEPER/CLOSE/EVM/v1"); // bytes25
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

async function readOrCreateKey(path: string): Promise<Uint8Array> {
  try {
    await checkPrivate(path);
    const text = (await readFile(path, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path}: expected 32 bytes of hex`);
    const key = hexToBytes(`0x${text}`);
    if (!isPrivateKey(key)) throw new Error(`${path} is not a valid secp256k1 private key`);
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let key: Uint8Array;
  do key = new Uint8Array(randomBytes(32));
  while (!isPrivateKey(key));
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${Buffer.from(key).toString("hex")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return key;
}

/** "OSTRA/KEEPER/CLOSE/EVM/v1" || chainid (32) || channel id (32): what the keeper verifies before closing. */
export function closeRequestMessage(chainId: number, channelId: Hex): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(channelId)) throw new RangeError("a channel id is 32 bytes");
  return hexToBytes(encodePacked(["bytes25", "uint256", "bytes32"], [CLOSE_DOMAIN, BigInt(chainId), channelId]));
}

export class MerchantKeys {
  /** The merchant key's address. */
  readonly merchant: Address;
  /** The facilitator's account (sends buyers' deposit transactions). */
  readonly facilitator: PrivateKeyAccount;
  readonly #key: PrivateKeyAccount;

  private constructor(key: PrivateKeyAccount, facilitator: PrivateKeyAccount) {
    this.#key = key;
    this.merchant = key.address;
    this.facilitator = facilitator;
  }

  /** Opens OSTRA_MERCHANT_SECRETS, creating the keys on first use. */
  static async open(dir: string): Promise<MerchantKeys> {
    await ensurePrivateDir(dir);
    const merchant = await readOrCreateKey(join(dir, MERCHANT_KEY_FILE));
    const facilitator = await readOrCreateKey(join(dir, FACILITATOR_KEY_FILE));
    return new MerchantKeys(privateKeyToAccount(bytesToHex(merchant)), privateKeyToAccount(bytesToHex(facilitator)));
  }

  /** The merchant key's EIP-191 signature of a close request for `channelId` (65 bytes, hex). */
  signCloseRequest(chainId: number, channelId: Hex): Promise<Hex> {
    return this.#key.signMessage({ message: { raw: closeRequestMessage(chainId, channelId) } });
  }
}
