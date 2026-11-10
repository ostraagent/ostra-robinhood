// Adds a user to the remote MCP gateway's users file (remote.ts, OSTRA_REMOTE_USERS), stage 1 of the remote MCP:
//
//   node scripts/remote-user.ts <users file> add <id> <vault>
//
// It makes a new bearer token, keeps only its SHA-256 in the file (0600), and prints the token once on stdout: the
// user's connector sends it. Adding an id again gives it a new token (the old one stops working) and the vault given.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { getAddress, isAddress } from "viem";
import { parseUsers } from "../src/remote.ts";

const [file, verb, id, vault] = process.argv.slice(2);
if (file === undefined || verb !== "add" || id === undefined || vault === undefined) {
  process.stderr.write("usage: node scripts/remote-user.ts <users file> add <id> <vault>\n");
  process.exit(2);
}
if (!isAddress(vault, { strict: false })) {
  process.stderr.write("the vault is an address\n");
  process.exit(2);
}
// One run at a time (an update must not be lost): a lock file next to the users file.
const lock = `${file}.lock`;
try {
  writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
} catch {
  process.stderr.write(`${lock} exists: another run is going on (remove it if none is)\n`);
  process.exit(1);
}
process.on("exit", () => rmSync(lock, { force: true }));
const text = existsSync(file) ? readFileSync(file, "utf8") : '{"users":[]}';
parseUsers(text);
const raw = JSON.parse(text) as { users: { id: string; tokenSha256: string; vault: string }[] };
const token = randomBytes(32).toString("base64url");
const entry = { id, tokenSha256: createHash("sha256").update(token).digest("hex"), vault: getAddress(vault) };
const users = [...raw.users.filter((u) => u.id !== id), entry];
const next = JSON.stringify({ users }, null, 2);
parseUsers(next);
rmSync(`${file}.tmp`, { force: true });
writeFileSync(`${file}.tmp`, `${next}\n`, { flag: "wx", mode: 0o600 });
renameSync(`${file}.tmp`, file);
process.stdout.write(`${token}\n`);
