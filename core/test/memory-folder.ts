// A Folder kept in memory, for tests and the chain checks: the same contract
// as the MCP package's disk folder (atomic write, exclusive create and
// createSecret), without a disk.

import type { Folder } from "../src/storage.ts";

type Node = { entries: Map<string, string>; secrets: Map<string, Uint8Array>; folders: Map<string, Node>; ensured: boolean };

function node(): Node {
  return { entries: new Map(), secrets: new Map(), folders: new Map(), ensured: false };
}

export class MemoryFolder implements Folder {
  readonly #node: Node;

  constructor(n: Node = node()) {
    this.#node = n;
  }

  folder(name: string): Folder {
    let child = this.#node.folders.get(name);
    if (child === undefined) {
      child = node();
      this.#node.folders.set(name, child);
    }
    return new MemoryFolder(child);
  }

  async ensure(): Promise<void> {
    this.#node.ensured = true;
  }

  async read(name: string): Promise<string | undefined> {
    return this.#node.entries.get(name);
  }

  async write(name: string, text: string): Promise<void> {
    this.#node.entries.set(name, text);
  }

  async create(name: string, text: string): Promise<void> {
    if (this.#node.entries.has(name)) throw new Error(`${name} exists`);
    this.#node.entries.set(name, text);
  }

  async append(name: string, text: string): Promise<void> {
    this.#node.entries.set(name, (this.#node.entries.get(name) ?? "") + text);
  }

  async remove(name: string): Promise<void> {
    this.#node.entries.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.#node.entries.keys(), ...[...this.#node.secrets.keys()]].sort();
  }

  async createSecret(name: string, secret: Uint8Array): Promise<void> {
    if (secret.length !== 32) throw new RangeError("a secret is 32 bytes");
    if (this.#node.secrets.has(name)) throw new Error(`${name} exists`);
    this.#node.secrets.set(name, secret.slice());
  }

  async readSecret(name: string): Promise<Uint8Array> {
    const secret = this.#node.secrets.get(name);
    if (secret === undefined) throw new Error(`no secret ${name}`);
    return secret.slice();
  }
}
