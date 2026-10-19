// The agent's keys on disk, in OSTRA_HOME (0700):
//   master.key        the 32-byte master seed (hex, 0600), created on first use:
//                     every vault, channel, deposit and leaf key derives from it
//                     (core keys.ts), so it alone recovers the agent. Back it up
//                     with `npx -y @ostraagent/mcp backup export <file>` (from
//                     source: `node src/backup-cli.ts export <file>`).
//   fee-payer.key     a secp256k1 key (hex, 0600) that pays gas in ETH when no
//                     relayer is set; it never holds tokens.
//   wots/             the WOTS store: every one-time signature, written before
//                     it is used (sdk FileWotsStore).
//   backup-exported   present once an encrypted backup of the seed was exported.
// Nothing here is ever printed or sent anywhere.

import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore } from "@ostraagent/sdk";
import { Keys, isPrivateKey, type SignatureEscrowClient } from "@ostraagent/core";
import { DiskFolder, ensurePrivateDir } from "./disk.ts";

export const MASTER_FILE = "master.key";
export const FEE_PAYER_FILE = "fee-payer.key";
export const WOTS_DIR = "wots";
export const BACKUP_MARKER = "backup-exported";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** A secret entry of `folder`, created with `make` when it is missing. */
async function secret(folder: DiskFolder, name: string, make: () => Uint8Array): Promise<{ value: Uint8Array; created: boolean }> {
  if (await exists(join(folder.dir, name))) return { value: await folder.readSecret(name), created: false };
  const value = make();
  try {
    await folder.createSecret(name, value);
    return { value, created: true };
  } catch (err) {
    // Another process created it first: use that one.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return { value: await folder.readSecret(name), created: false };
    throw err;
  }
}

function newPrivateKey(): Uint8Array {
  for (;;) {
    const k = new Uint8Array(randomBytes(32));
    if (isPrivateKey(k)) return k;
  }
}

/** Opens (or creates) the agent's keys in `home`. */
export async function openKeys(home: string, escrow: SignatureEscrowClient | null): Promise<Keys<FileWotsStore>> {
  await ensurePrivateDir(home);
  const folder = new DiskFolder(home);
  await folder.ensure();
  const master = await secret(folder, MASTER_FILE, () => new Uint8Array(randomBytes(32)));
  const fee = await secret(folder, FEE_PAYER_FILE, newPrivateKey);
  if (!isPrivateKey(fee.value)) throw new Error(`${join(home, FEE_PAYER_FILE)} is not a valid secp256k1 private key`);
  await ensurePrivateDir(join(home, WOTS_DIR));
  return new Keys({
    master: master.value,
    feePayer: privateKeyToAccount(bytesToHex(fee.value)),
    store: new FileWotsStore(join(home, WOTS_DIR)),
    folder,
    masterCreated: master.created,
    backupExported: () => exists(join(home, BACKUP_MARKER)),
    escrow,
  });
}
