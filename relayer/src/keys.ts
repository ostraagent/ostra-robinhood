// Relayer secrets, in OSTRA_RELAYER_SECRETS (mode 0700):
//
//   merchant.key     the relayer's merchant key, and
//   facilitator.key  its x402 facilitator's account (merchant/src/keys.ts):
//                    the relayer is an Ostra seller paid to its vault;
//   relayer.key      32-byte secp256k1 private key (hex, mode 0600): the
//                    account that sends every relayed transaction and pays
//                    its gas (the Kora fee payer on Solana). It holds ETH and
//                    nothing else, and no Ostra contract gives it any role.
//
// All three are created on first start and never printed.

import { randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, hexToBytes, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ensurePrivateDir, isPrivateKey } from "../../merchant/src/keys.ts";

export const RELAYER_KEY_FILE = "relayer.key";

async function checkPrivate(path: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} is accessible by other users (mode ${mode.toString(8)}); chmod 600 it`);
}

/** The relayer's sending account from OSTRA_RELAYER_SECRETS/relayer.key, created (0600) on first use. */
export async function openRelayerAccount(dir: string): Promise<PrivateKeyAccount> {
  await ensurePrivateDir(dir);
  const path = join(dir, RELAYER_KEY_FILE);
  try {
    await checkPrivate(path);
    const text = (await readFile(path, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path}: expected 32 bytes of hex`);
    const key = hexToBytes(`0x${text}`);
    if (!isPrivateKey(key)) throw new Error(`${path} is not a valid secp256k1 private key`);
    return privateKeyToAccount(bytesToHex(key));
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
  return privateKeyToAccount(bytesToHex(key));
}
