// What the relayer (relayer/src/backups.ts) and the agent (core passkey.ts)
// share for the passkey backup of a master seed (design v0.4, recovery when a
// device is lost, layer 1).
//
// The seed is encrypted on the device with a key from the passkey's WebAuthn
// PRF output; the relayer keeps the ciphertext (the "blob"), which it cannot
// open. A backup is named by the SHA-256 of the passkey's credential id, so
// the relayer never learns the credential id. A new device signs in with the
// synced passkey, reads the backup by that name and decrypts it.
//
// Writes are signed by the seed's backup key (a secp256k1 key derived from the
// master seed): the first write binds the name to that key, and only that key
// changes or deletes it afterwards. The signature is EIP-191 over
//   "OSTRA/PASSKEY-BACKUP/EVM/v1" || op (u8: 1 put, 2 delete) || chainid
//   || name || keccak256(blob) (zero for a delete) || at (u64, unix seconds)
// and `at` must be later than the last write the relayer accepted for the
// name, so an old write can never be replayed.

import { bytesToHex, encodePacked, hexToBytes, keccak256, stringToHex, verifyMessage, zeroHash, type Address, type Hex, type LocalAccount } from "viem";

const BACKUP_DOMAIN = stringToHex("OSTRA/PASSKEY-BACKUP/EVM/v1"); // bytes27
const U64_MAX = (1n << 64n) - 1n;

/** Longest blob the relayer keeps (characters of base64url): an encrypted 32-byte seed takes about 200. */
export const MAX_BACKUP_BLOB_CHARS = 2048;
/** How far a write's `at` may be from the relayer's clock. */
export const BACKUP_SIGNATURE_WINDOW_SECONDS = 300;

export const BACKUP_OP_PUT = 1;
export const BACKUP_OP_DELETE = 2;
export type BackupOp = typeof BACKUP_OP_PUT | typeof BACKUP_OP_DELETE;

/** A backup's name: 32 bytes of lowercase 0x hex. */
export function isBackupName(text: string): text is Hex {
  return /^0x[0-9a-f]{64}$/.test(text);
}

/** A blob: base64url without padding, 1 to MAX_BACKUP_BLOB_CHARS characters. */
export function isBackupBlob(text: string): boolean {
  return text.length > 0 && text.length <= MAX_BACKUP_BLOB_CHARS && /^[A-Za-z0-9_-]+$/.test(text);
}

export type BackupWrite = { op: BackupOp; chainId: number; name: Hex; blob: string | null; at: bigint };

/** The message the backup key signs for a write. */
export function backupWriteMessage(w: BackupWrite): Uint8Array {
  if (w.op !== BACKUP_OP_PUT && w.op !== BACKUP_OP_DELETE) throw new RangeError("op must be put (1) or delete (2)");
  if (!Number.isSafeInteger(w.chainId) || w.chainId <= 0) throw new RangeError("chainId must be a positive integer");
  if (!isBackupName(w.name)) throw new RangeError("name must be 32 bytes of lowercase 0x hex");
  if (w.at < 0n || w.at > U64_MAX) throw new RangeError("at out of range");
  let blobHash: Hex = zeroHash;
  if (w.op === BACKUP_OP_PUT) {
    if (w.blob === null || !isBackupBlob(w.blob)) throw new RangeError(`a put carries a blob of base64url, at most ${MAX_BACKUP_BLOB_CHARS} characters`);
    blobHash = keccak256(stringToHex(w.blob));
  } else if (w.blob !== null) {
    throw new RangeError("a delete carries no blob");
  }
  return hexToBytes(encodePacked(["bytes27", "uint8", "uint256", "bytes32", "bytes32", "uint64"], [BACKUP_DOMAIN, w.op, BigInt(w.chainId), w.name, blobHash, w.at]));
}

/** The backup key's signature of a write (65 bytes, EIP-191). */
export function signBackupWrite(signer: LocalAccount, w: BackupWrite): Promise<Hex> {
  return signer.signMessage({ message: { raw: backupWriteMessage(w) } });
}

/** True when `signature` is `owner`'s signature of the write. */
export async function verifyBackupWrite(owner: Address, w: BackupWrite, signature: Hex): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    return await verifyMessage({ address: owner, message: { raw: bytesToHex(backupWriteMessage(w)) }, signature });
  } catch {
    return false;
  }
}

/** GET /v1/backups/<name>: the backup the relayer keeps. */
export type BackupView = { name: Hex; owner: Address; blob: string; updatedAt: number };
