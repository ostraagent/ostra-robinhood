// FileWotsStore: the WotsStore that keeps every WOTS signature record on disk
// (Node only). Exported by the SDK's Node entry (src/index.ts), not by its
// browser entry (src/browser.ts); a browser keeps its records elsewhere.

import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fromHex, toHex, u64Le } from "./hash.ts";
import type { WotsSignatureRecord, WotsStore } from "./wots.ts";

/**
 * File-system store: one JSON file per (keychain, index) under `dir`.
 * Records are written to a temporary file, fsynced, then hard-linked into
 * place; `link` fails if the target exists, which makes the claim atomic
 * across processes. Records hold no secrets (signatures are public once sent).
 */
export class FileWotsStore implements WotsStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  #path(keychainId: Uint8Array, index: bigint): { folder: string; file: string } {
    if (keychainId.length !== 32) throw new RangeError("keychainId must be 32 bytes");
    const folder = join(this.dir, toHex(keychainId));
    u64Le(index);
    return { folder, file: join(folder, `${index.toString().padStart(20, "0")}.json`) };
  }

  async load(keychainId: Uint8Array, index: bigint): Promise<WotsSignatureRecord | undefined> {
    const { file } = this.#path(keychainId, index);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const record = JSON.parse(text) as WotsSignatureRecord;
    if (record.version !== 1 || record.keychain !== toHex(keychainId) || record.index !== index.toString()) {
      throw new Error(`corrupt WOTS store record: ${file}`);
    }
    return record;
  }

  async saveIfAbsent(record: WotsSignatureRecord): Promise<boolean> {
    const { folder, file } = this.#path(fromHex(record.keychain), BigInt(record.index));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const tmp = join(folder, `.tmp-${process.pid}-${toHex(randomBytes(8))}`);
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    let created = true;
    try {
      await link(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      created = false;
    }
    await unlink(tmp);
    if (created) {
      const dirHandle = await open(folder, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    }
    return created;
  }
}
