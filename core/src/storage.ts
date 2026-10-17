// Where the agent's records are kept. Every service of this package keeps its
// records in a Folder: named text entries, and named 32-byte secrets (session
// keys). The MCP package keeps them on disk, one directory per folder under
// OSTRA_HOME (mcp/src/disk.ts); the web app keeps them in the browser.
//
// An implementation must make `write` atomic (a reader sees the old text or
// the new text, never part of it) and `create` and `createSecret` exclusive
// (they fail when the entry exists, so a key or record is never replaced).

export interface Folder {
  /** The folder `name` inside this one. */
  folder(name: string): Folder;
  /** Creates the folder if it is missing; on disk, refuses one other users can access. */
  ensure(): Promise<void>;
  /** The text of entry `name`, or undefined when there is none. */
  read(name: string): Promise<string | undefined>;
  /** Writes entry `name` atomically, replacing it if it exists. */
  write(name: string, text: string): Promise<void>;
  /** Creates entry `name`; fails when it exists. */
  create(name: string, text: string): Promise<void>;
  /** Appends `text` to entry `name`, creating it if it is missing. */
  append(name: string, text: string): Promise<void>;
  /** Removes entry `name` if it exists. */
  remove(name: string): Promise<void>;
  /** The names of the entries in this folder (not of the folders in it). */
  list(): Promise<string[]>;
  /** Stores a new 32-byte secret as entry `name`; fails when it exists. */
  createSecret(name: string, secret: Uint8Array): Promise<void>;
  /** The 32-byte secret stored as entry `name`; fails when there is none. */
  readSecret(name: string): Promise<Uint8Array>;
}
