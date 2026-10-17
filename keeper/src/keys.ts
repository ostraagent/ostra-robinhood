// Keeper keys, in OSTRA_KEEPER_SECRETS (mode 0700):
//
//   crank-master.key  32-byte seed (hex, mode 0600). Every seller gets its own
//                     crank key, derived from this seed, the chain and the
//                     seller's merchant key (decided 14 Oct 2026, design
//                     v0.3). The seller installs that crank on its vault with
//                     a WOTS-signed SetCrankKey, which binds the vault to the
//                     merchant key on-chain. A crank can only claim vouchers
//                     and refund unclaimed escrow on channels paid to its
//                     vault; it can never move the vault's funds.
//   fee-payer.key     32-byte secp256k1 private key (hex, mode 0600) of the
//                     account that pays the keeper's gas, including the ETH
//                     each crank needs for its own transactions.
//
// Both are created on first start and never printed.
//
// A seller's server proves it holds the merchant key with an EIP-191
// signature of "OSTRA/KEEPER/CLOSE/EVM/v1" || chainid (32) || channel id (32)
// for every close request. Replaying one is harmless: closing a closed
// channel changes nothing.

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, encodePacked, getAddress, hexToBytes, stringToHex, verifyMessage, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fromHex, sha256, toHex, utf8 } from "@ostraagent/sdk";

export const CRANK_MASTER_FILE = "crank-master.key";
export const FEE_PAYER_FILE = "fee-payer.key";

const CRANK_DOMAIN = utf8("OSTRA/KEEPER/CRANK/EVM/v1");
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

async function readSecret(path: string): Promise<Uint8Array> {
  await checkPrivate(path);
  const bytes = fromHex((await readFile(path, "utf8")).trim());
  if (bytes.length !== 32) throw new Error(`${path}: expected 32 bytes`);
  return bytes;
}

async function readOrCreateSecret(path: string, valid: (secret: Uint8Array) => boolean): Promise<Uint8Array> {
  try {
    return await readSecret(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let secret: Uint8Array;
  do secret = new Uint8Array(randomBytes(32));
  while (!valid(secret));
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${toHex(secret)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return secret;
}

/** True when `secret` is a valid secp256k1 private key. */
export function isPrivateKey(secret: Uint8Array): boolean {
  if (secret.length !== 32) return false;
  const k = BigInt(bytesToHex(secret));
  return k > 0n && k < SECP256K1_N;
}

/** Message a seller's merchant key signs (EIP-191) to ask the keeper to close `channelId`. */
export function closeRequestMessage(chainId: number, channelId: Hex): Uint8Array {
  return hexToBytes(encodePacked(["bytes25", "uint256", "bytes32"], [CLOSE_DOMAIN, BigInt(chainId), channelId]));
}

/** True when `signature` is `merchant`'s EIP-191 signature of the close request for `channelId`. */
export async function verifyCloseRequest(merchant: Address, chainId: number, channelId: Hex, signature: Hex): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    return await verifyMessage({ address: merchant, message: { raw: closeRequestMessage(chainId, channelId) }, signature });
  } catch {
    return false;
  }
}

export class KeeperKeys {
  readonly feePayer: PrivateKeyAccount;
  readonly #crankMaster: Uint8Array;
  readonly #chainId: number;
  readonly #cranks = new Map<Address, PrivateKeyAccount>();

  private constructor(chainId: number, crankMaster: Uint8Array, feePayer: PrivateKeyAccount) {
    this.#chainId = chainId;
    this.#crankMaster = crankMaster;
    this.feePayer = feePayer;
  }

  /** Opens OSTRA_KEEPER_SECRETS, creating the keys on first use. */
  static async open(dir: string, chainId: number): Promise<KeeperKeys> {
    await ensurePrivateDir(dir);
    const crankMaster = await readOrCreateSecret(join(dir, CRANK_MASTER_FILE), (s) => s.length === 32);
    const feePayerKey = await readOrCreateSecret(join(dir, FEE_PAYER_FILE), isPrivateKey);
    if (!isPrivateKey(feePayerKey)) throw new Error(`${FEE_PAYER_FILE} is not a valid secp256k1 private key`);
    return new KeeperKeys(chainId, crankMaster, privateKeyToAccount(bytesToHex(feePayerKey)));
  }

  /**
   * The crank key of the seller holding `merchant`:
   * sha256("OSTRA/KEEPER/CRANK/EVM/v1" || crank master || chainid (32) || merchant (20)).
   */
  crankFor(merchant: Address): PrivateKeyAccount {
    const key = getAddress(merchant);
    let crank = this.#cranks.get(key);
    if (crank === undefined) {
      const seed = sha256([CRANK_DOMAIN, this.#crankMaster, hexToBytes(encodePacked(["uint256", "address"], [BigInt(this.#chainId), key]))]);
      // A SHA-256 output outside 1..n-1 has probability below 2^-127; it would be refused, never altered.
      if (!isPrivateKey(seed)) throw new Error(`the crank seed of merchant ${key} is not a valid secp256k1 key`);
      crank = privateKeyToAccount(bytesToHex(seed));
      this.#cranks.set(key, crank);
    }
    return crank;
  }
}
