// The encrypted backup of the master seed, run by the owner in a terminal
// (never by the agent: the passphrase is typed, hidden, and never passes
// through the MCP server).
//
//   node src/backup-cli.ts export <file>   writes the seed of OSTRA_HOME to
//                                           <file>, encrypted under a passphrase
//   node src/backup-cli.ts import <file>   writes the seed in <file> to a new
//                                           OSTRA_HOME (one without a seed)
//
// From the npm package: `npx -y @ostraagent/mcp backup export <file>` (bin.ts).
//
// The file is JSON {version, kdf: scrypt (N 2^17, r 8, p 1), salt, iv,
// ciphertext, tag}: AES-256-GCM of the 32-byte seed under the scrypt key of the
// passphrase, with "OSTRA/SEED-BACKUP/v1" as associated data. With the seed
// and the relayer's signature escrow, a new machine recovers every vault.

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { DiskFolder, ensurePrivateDir } from "./disk.ts";
import { BACKUP_MARKER, MASTER_FILE } from "./keys.ts";
import { packaged } from "./packaged.ts";

const AAD = Buffer.from("OSTRA/SEED-BACKUP/v1", "utf8");
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const MIN_PASSPHRASE = 12;

function scrypt(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(passphrase, salt, 32, SCRYPT as ScryptOptions, (err, key) => (err === null ? resolve(key) : reject(err))));
}

export async function sealSeedWithPassphrase(seed: Uint8Array, passphrase: string): Promise<string> {
  if (seed.length !== 32) throw new RangeError("the seed is 32 bytes");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return `${JSON.stringify({ version: 1, kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, salt: salt.toString("hex"), iv: iv.toString("hex"), ciphertext: ciphertext.toString("hex"), tag: cipher.getAuthTag().toString("hex") })}\n`;
}

export async function openSeedWithPassphrase(text: string, passphrase: string): Promise<Uint8Array> {
  const b = JSON.parse(text) as { version?: unknown; kdf?: { name?: unknown; N?: unknown; r?: unknown; p?: unknown }; salt?: unknown; iv?: unknown; ciphertext?: unknown; tag?: unknown };
  if (b.version !== 1 || b.kdf?.name !== "scrypt" || b.kdf.N !== SCRYPT.N || b.kdf.r !== SCRYPT.r || b.kdf.p !== SCRYPT.p) throw new Error("not an Ostra seed backup (version 1)");
  for (const f of [b.salt, b.iv, b.ciphertext, b.tag]) if (typeof f !== "string" || !/^[0-9a-f]+$/.test(f)) throw new Error("not an Ostra seed backup");
  const key = await scrypt(passphrase, Buffer.from(b.salt as string, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv as string, "hex"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(b.tag as string, "hex"));
  let seed: Buffer;
  try {
    seed = Buffer.concat([decipher.update(Buffer.from(b.ciphertext as string, "hex")), decipher.final()]);
  } catch {
    throw new Error("the passphrase does not open this backup");
  }
  if (seed.length !== 32) throw new Error("the backup does not hold a 32-byte seed");
  return new Uint8Array(seed);
}

/** Reads a line from the terminal without echoing it. */
function hidden(prompt: string): Promise<string> {
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

export async function runBackup(args: string[]): Promise<void> {
  const [command, file] = args;
  const home = process.env.OSTRA_HOME !== undefined && process.env.OSTRA_HOME !== "" ? process.env.OSTRA_HOME : join(homedir(), ".ostra");
  if ((command !== "export" && command !== "import") || file === undefined) {
    throw new Error(`usage: ${packaged === null ? "node src/backup-cli.ts" : "npx -y @ostraagent/mcp backup"} export <file> | import <file>   (OSTRA_HOME: the agent's directory)`);
  }
  if (command === "export") {
    const folder = new DiskFolder(home);
    const seed = await folder.readSecret(MASTER_FILE);
    const a = await hidden("passphrase (at least 12 characters): ");
    if (a.length < MIN_PASSPHRASE) throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
    if ((await hidden("the same passphrase again: ")) !== a) throw new Error("the passphrases differ");
    await writeFile(file, await sealSeedWithPassphrase(seed, a), { mode: 0o600, flag: "wx" });
    await folder.write(BACKUP_MARKER, `${new Date().toISOString()}\n`);
    process.stderr.write(`the encrypted seed is in ${file}; keep it and the passphrase off this machine\n`);
    return;
  }
  await ensurePrivateDir(home);
  try {
    await stat(join(home, MASTER_FILE));
    throw new Error(`${home} already holds a seed; import into a new OSTRA_HOME`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const seed = await openSeedWithPassphrase(await readFile(file, "utf8"), await hidden("passphrase: "));
  const folder = new DiskFolder(home);
  await folder.createSecret(MASTER_FILE, seed);
  await folder.write(BACKUP_MARKER, `${new Date().toISOString()} (imported)\n`);
  process.stderr.write(`the seed is in ${join(home, MASTER_FILE)}; the MCP server recovers the vaults from it (the relayer's signature escrow sends any signature still in flight)\n`);
}

// Run as a script from source; the npm package runs it from bin.ts.
if (packaged === null && import.meta.url === `file://${process.argv[1]}`) {
  runBackup(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
