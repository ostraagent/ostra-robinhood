// Passkey backups of master seeds (design v0.4, recovery when a device is
// lost, layer 1; sdk backup.ts has the format and the signed message).
//
// The relayer keeps, per backup name (the SHA-256 of a passkey's credential
// id), the blob a device encrypted with its passkey's PRF output and the
// address of the seed's backup key that wrote it. It cannot open a blob. The
// first write binds the name to its backup key; only that key replaces or
// deletes it, with a write signed within BACKUP_SIGNATURE_WINDOW_SECONDS of
// the relayer's clock and later than the last write accepted for that name. A
// delete leaves the binding (a tombstone), so the name never passes to
// another key and no older write can be replayed after it. At most
// BACKUPS_PER_IP new names are taken per client IP address in 24 hours.
//
// Kept in OSTRA_RELAYER_DATA/relayer-backups.json (0600), written atomically.

import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  BACKUP_OP_DELETE,
  BACKUP_OP_PUT,
  BACKUP_SIGNATURE_WINDOW_SECONDS,
  MAX_BACKUP_BLOB_CHARS,
  isBackupBlob,
  isBackupName,
  verifyBackupWrite,
  type BackupOp,
  type BackupView,
} from "@ostraagent/sdk";

/** New backup names one client IP address may take in BACKUP_IP_WINDOW_MS. */
export const BACKUPS_PER_IP = 5;
export const BACKUP_IP_WINDOW_MS = 24 * 60 * 60 * 1000;

type BackupRecord = { owner: Address; blob: string | null; updatedAt: number };
type BackupData = { version: 1; records: Record<string, BackupRecord>; created: { ip: string; at: number }[] };

/** An answer to a backup request: an HTTP status and a JSON body. */
export type BackupAnswer = { status: number; body: Record<string, unknown> };

const refuse = (status: number, error: string, message: string): BackupAnswer => ({ status, body: { error, message } });

export class BackupStore {
  readonly #path: string;
  /** The chain the relayer serves: a write signed for another chain does not verify. */
  readonly #chainId: number;
  #data: BackupData;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(path: string, chainId: number, data: BackupData) {
    this.#path = path;
    this.#chainId = chainId;
    this.#data = data;
  }

  /** Opens (or creates) the backups of chain `chainId` in `dir`, which must be private to its owner. */
  static async open(dir: string, chainId: number): Promise<BackupStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mode = (await stat(dir)).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`${dir} is accessible by other users (mode ${mode.toString(8)}); chmod 700 it`);
    const path = join(dir, "relayer-backups.json");
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as BackupData;
      if (data.version !== 1) throw new Error(`${path}: unknown backup store version ${String(data.version)}`);
      return new BackupStore(path, chainId, data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return new BackupStore(path, chainId, { version: 1, records: {}, created: [] });
  }

  /** When the last write to `name` was accepted (its `at`), deleted or not; undefined for a name never written. */
  lastWrite(name: string): number | undefined {
    return this.#data.records[name]?.updatedAt;
  }

  /** The backup kept under `name` (0x hex), or undefined (none, or deleted). */
  get(name: string): BackupView | undefined {
    const r = this.#data.records[name];
    if (r === undefined || r.blob === null) return undefined;
    return { name: name as Hex, owner: r.owner, blob: r.blob, updatedAt: r.updatedAt };
  }

  /**
   * A write to `name` (POST /v1/backups/<name>), from client address `ip` at
   * `nowMs`: 200 {name, owner, updatedAt, deleted}; 400 bad_request or
   * stale_signature; 403 bad_signature; 404 no_backup (delete of a name never
   * written); 409 owner_mismatch or replayed; 429 backup_limit.
   */
  async write(name: string, body: unknown, ip: string, nowMs: number): Promise<BackupAnswer> {
    if (!isBackupName(name)) return refuse(400, "bad_request", "a backup name is 32 bytes of lowercase 0x hex");
    if (body === null || typeof body !== "object" || Array.isArray(body)) return refuse(400, "bad_request", "the body must be a JSON object");
    const b = body as Record<string, unknown>;
    const op: BackupOp | null = b.op === "put" ? BACKUP_OP_PUT : b.op === "delete" ? BACKUP_OP_DELETE : null;
    if (op === null) return refuse(400, "bad_request", 'op must be "put" or "delete"');
    if (typeof b.owner !== "string" || !isAddress(b.owner, { strict: false })) return refuse(400, "bad_request", "owner must be the backup key's address");
    const owner = getAddress(b.owner);
    let blob: string | null = null;
    if (op === BACKUP_OP_PUT) {
      if (typeof b.blob !== "string" || !isBackupBlob(b.blob)) return refuse(400, "bad_request", `blob must be base64url, 1 to ${MAX_BACKUP_BLOB_CHARS} characters`);
      blob = b.blob;
    } else if (b.blob !== undefined) {
      return refuse(400, "bad_request", "a delete carries no blob");
    }
    if (typeof b.at !== "number" || !Number.isSafeInteger(b.at) || b.at < 0) return refuse(400, "bad_request", "at must be unix seconds");
    const at = b.at;
    if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) return refuse(400, "bad_request", "signature must be 65 bytes of 0x hex");
    if (Math.abs(at - Math.floor(nowMs / 1000)) > BACKUP_SIGNATURE_WINDOW_SECONDS) {
      return refuse(400, "stale_signature", `at must be within ${BACKUP_SIGNATURE_WINDOW_SECONDS} seconds of the relayer's clock`);
    }
    const signature = b.signature as Hex;
    if (!(await verifyBackupWrite(owner, { op, chainId: this.#chainId, name, blob, at: BigInt(at) }, signature))) {
      return refuse(403, "bad_signature", "the signature is not the owner's signature of this write");
    }
    return this.#locked<BackupAnswer>(() => {
      const held = this.#data.records[name];
      if (held !== undefined && held.owner !== owner) return { next: null, result: refuse(409, "owner_mismatch", "this backup name belongs to another backup key") };
      if (held !== undefined && at <= held.updatedAt) return { next: null, result: refuse(409, "replayed", "a write as late or later was already accepted for this name") };
      if (held === undefined && op === BACKUP_OP_DELETE) return { next: null, result: refuse(404, "no_backup", "no backup has this name") };
      const next = structuredClone(this.#data);
      next.created = next.created.filter((c) => nowMs - c.at < BACKUP_IP_WINDOW_MS);
      if (held === undefined) {
        if (next.created.filter((c) => c.ip === ip).length >= BACKUPS_PER_IP) {
          return { next: null, result: refuse(429, "backup_limit", `at most ${BACKUPS_PER_IP} backups are created per IP address in 24 hours`) };
        }
        next.created.push({ ip, at: nowMs });
      }
      next.records[name] = { owner, blob, updatedAt: at };
      return { next, result: { status: 200, body: { name, owner, updatedAt: at, deleted: blob === null } } };
    });
  }

  /** Runs `change` under the lock; the data it returns (null: unchanged) is saved before it takes effect. */
  #locked<T>(change: () => { next: BackupData | null; result: T }): Promise<T> {
    const run = async (): Promise<T> => {
      const { next, result } = change();
      if (next !== null) {
        await this.#save(next);
        this.#data = next;
      }
      return result;
    };
    const p = this.#tail.then(run, run);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  async #save(data: BackupData): Promise<void> {
    const tmp = `${this.#path}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 1)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.#path);
  }
}
