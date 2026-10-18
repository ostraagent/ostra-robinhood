// The agent's records on disk (core storage.ts Folder): one directory per
// folder under OSTRA_HOME, mode 0700, owned by this user and refused when
// other users can access it; entries are files of mode 0600. A write goes to
// a temporary file that is synced and renamed over the entry, so a reader
// sees the old text or the new text, never part of it; create and
// createSecret open their file exclusively, so a key or record is never
// replaced. A secret entry is its 32 bytes in hex.

import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "viem";
import type { Folder } from "@ostraagent/core";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function checkName(name: string): void {
  if (!NAME.test(name) || name.includes("..")) throw new RangeError(`invalid record name ${name}`);
}

/** Throws unless `path` is this user's and no other user can access it. */
export async function checkPrivate(path: string): Promise<void> {
  const s = await stat(path);
  if ((s.mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by other users (chmod ${s.isDirectory() ? "700" : "600"} it)`);
  if (typeof process.getuid === "function" && s.uid !== process.getuid()) throw new Error(`${path} belongs to another user`);
}

/** Creates `dir` (0700) if it is missing and checks that it is private. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkPrivate(dir);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${bytesToHex(randomBytes(6)).slice(2)}.tmp`;
  const f = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await f.writeFile(text, "utf8");
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(tmp, path);
}

async function createExclusive(path: string, text: string): Promise<void> {
  const f = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await f.writeFile(text, "utf8");
    await f.sync();
  } finally {
    await f.close();
  }
}

export class DiskFolder implements Folder {
  readonly dir: string;
  #ensured = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  folder(name: string): Folder {
    checkName(name);
    return new DiskFolder(join(this.dir, name));
  }

  async ensure(): Promise<void> {
    if (this.#ensured) return;
    await ensurePrivateDir(this.dir);
    this.#ensured = true;
  }

  #path(name: string): string {
    checkName(name);
    return join(this.dir, name);
  }

  async read(name: string): Promise<string | undefined> {
    try {
      return await readFile(this.#path(name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async write(name: string, text: string): Promise<void> {
    await this.ensure();
    await writeAtomic(this.#path(name), text);
  }

  async create(name: string, text: string): Promise<void> {
    await this.ensure();
    await createExclusive(this.#path(name), text);
  }

  async append(name: string, text: string): Promise<void> {
    await this.ensure();
    const f = await open(this.#path(name), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
    try {
      await f.writeFile(text, "utf8");
      await f.sync();
    } finally {
      await f.close();
    }
  }

  async remove(name: string): Promise<void> {
    await rm(this.#path(name), { force: true });
  }

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return entries.filter((e) => e.isFile() && !e.name.endsWith(".tmp")).map((e) => e.name).sort();
  }

  async createSecret(name: string, secret: Uint8Array): Promise<void> {
    if (secret.length !== 32) throw new RangeError("a secret is 32 bytes");
    await this.create(name, `${bytesToHex(secret).slice(2)}\n`);
  }

  async readSecret(name: string): Promise<Uint8Array> {
    const path = this.#path(name);
    await checkPrivate(path);
    const text = (await readFile(path, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path}: expected 32 bytes of hex`);
    return hexToBytes(`0x${text}`);
  }
}
