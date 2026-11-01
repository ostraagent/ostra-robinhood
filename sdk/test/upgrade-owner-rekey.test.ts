// scripts/upgrade-owner.ts rekey, run as on the VPS (no chain needed): the owner seed `init` made is sealed again
// under a new passphrase. The seed file is opened here apart from the script (scrypt and AES-256-GCM, as the file
// names them): after rekey the new passphrase opens it to the very same seed, the old one no longer does, the old file
// is kept beside it (0600) and still opens with the old passphrase, and the key 0 the state records for the owner's
// deployment comes out the same. A wrong current passphrase, a short or mistyped new one, the current one again, a
// seed that is not the recorded owner's, or a seed file named through a symbolic link change nothing. Nothing secret
// is printed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createDecipheriv, scryptSync } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bytesToHex, encodePacked, getAddress, hexToBytes, keccak256, type Address } from "viem";
import { ROBINHOOD_CHAIN_ID } from "../src/constants.ts";
import { FileWotsStore } from "../src/wots-file.ts";
import { WotsKeychain } from "../src/wots.ts";

const script = fileURLToPath(new URL("../scripts/upgrade-owner.ts", import.meta.url));
const OLD = "a long test passphrase";
const NEW = "another long test passphrase";
/** An owner contract address, for the keychain id of a recorded deployment. */
const OWNER: Address = getAddress("0x00000000000000000000000000000000000000c1");

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ostra-upgrade-owner-rekey-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The seed in an owner seed file, opened as the file says (version 1: scrypt, AES-256-GCM, its AAD). */
function open(text: string, passphrase: string): Buffer {
  const b = JSON.parse(text) as { version: number; kdf: { name: string; N: number; r: number; p: number }; salt: string; iv: string; ciphertext: string; tag: string };
  assert.equal(b.version, 1);
  assert.equal(b.kdf.name, "scrypt");
  const key = scryptSync(passphrase, Buffer.from(b.salt, "hex"), 32, { N: b.kdf.N, r: b.kdf.r, p: b.kdf.p, maxmem: 256 * 1024 * 1024 });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv, "hex"));
  d.setAAD(Buffer.from("OSTRA/OWNER-SEED/v1", "utf8"));
  d.setAuthTag(Buffer.from(b.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(b.ciphertext, "hex")), d.final()]);
}

/** Key 0 of the owner keychain for `owner` (scripts/upgrade-owner.ts ownerKeychainId). */
function keyRoot0(seed: Uint8Array, owner: Address): string {
  const id = hexToBytes(keccak256(encodePacked(["string", "uint256", "address"], ["OSTRA/OWNER/KEYCHAIN/EVM/v1", BigInt(ROBINHOOD_CHAIN_ID), owner])));
  return bytesToHex(new WotsKeychain(seed, id, new FileWotsStore(join(dir, "unused-wots"))).keyRoot(0n));
}

test("rekey: the same seed under a new passphrase; the old one no longer opens the file; the old file kept beside it", () => {
  const seedFile = join(dir, "owner-seed.json");
  const state = join(dir, "owner-state");
  const env = { PATH: process.env.PATH ?? "", OSTRA_OWNER_SEED_FILE: seedFile, OSTRA_OWNER_STATE: state };
  const secrets: string[] = [OLD, NEW];
  const run = (args: string[], input: string, extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, input, encoding: "utf8", timeout: 300_000 });
    for (const s of secrets) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), "nothing secret is printed");
    return r;
  };
  const init = run(["init"], `${OLD}\n${OLD}\n`);
  assert.equal(init.status, 0, init.stderr);
  const original = readFileSync(seedFile, "utf8");
  const seed = open(original, OLD);
  assert.equal(seed.length, 32);
  secrets.push(seed.toString("hex"));
  const others = () => readdirSync(dir).filter((n) => n.startsWith("owner-seed.json") && n !== "owner-seed.json");

  // Refused, nothing changed: a wrong current passphrase, a short or mistyped new one, the current one again.
  for (const [input, why] of [
    [`not the passphrase at all\n${NEW}\n${NEW}\n`, /does not open/],
    [`${OLD}\nshort\nshort\n`, /at least 16 characters/],
    [`${OLD}\n${NEW}\n${NEW}x\n`, /passphrases differ/],
    [`${OLD}\n${OLD}\n${OLD}\n`, /is the current one/],
  ] as const) {
    const r = run(["rekey"], input);
    assert.notEqual(r.status, 0, input.split("\n")[1]);
    assert.match(r.stderr, why);
    assert.equal(readFileSync(seedFile, "utf8"), original);
    assert.deepEqual(others(), [], "no new file and no backup left");
  }
  // The seed file named through a symbolic link: refused, the file and the link as they were.
  const link = join(dir, "owner-seed-link.json");
  symlinkSync(seedFile, link);
  const linked = run(["rekey"], `${OLD}\n${NEW}\n${NEW}\n`, { OSTRA_OWNER_SEED_FILE: link });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /is a symbolic link/);
  assert.equal(readFileSync(seedFile, "utf8"), original);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("owner-seed-link.json") && n !== "owner-seed-link.json"), [], "nothing written beside the link");
  rmSync(link);
  assert.deepEqual(others(), [], "no new file and no backup left");
  // The state records a deployment whose key 0 is not this seed's: refused.
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const deploy = { version: 1, chainId: ROBINHOOD_CHAIN_ID, payer: OWNER, payerNonce: 0, owner: OWNER, keyRoot0: keyRoot0(new Uint8Array(32).fill(9), OWNER) };
  writeFileSync(join(state, "deploy.json"), JSON.stringify(deploy), { mode: 0o600 });
  const notOwner = run(["rekey"], `${OLD}\n${NEW}\n${NEW}\n`);
  assert.notEqual(notOwner.status, 0);
  assert.match(notOwner.stderr, /is not the seed of the owner/);
  assert.equal(readFileSync(seedFile, "utf8"), original);

  // The recorded owner's: rekeyed.
  writeFileSync(join(state, "deploy.json"), JSON.stringify({ ...deploy, keyRoot0: keyRoot0(seed, OWNER) }), { mode: 0o600 });
  const r = run(["rekey"], `${OLD}\n${NEW}\n${NEW}\n`);
  assert.equal(r.status, 0, r.stderr);
  const event = JSON.parse(r.stdout.split("\n")[0]!) as { event: string; seedFile: string; backup: string; keyRoot0Checked: boolean };
  assert.equal(event.event, "rekeyed");
  assert.equal(event.keyRoot0Checked, true);
  const rekeyed = readFileSync(seedFile, "utf8");
  assert.notEqual(rekeyed, original);
  assert.equal(statSync(seedFile).mode & 0o777, 0o600);
  assert.deepEqual(open(rekeyed, NEW), seed, "the new passphrase opens the same seed");
  assert.throws(() => open(rekeyed, OLD), "the old passphrase no longer opens the seed file");
  assert.equal(keyRoot0(open(rekeyed, NEW), OWNER), keyRoot0(seed, OWNER), "the same key 0 of the owner");
  // The old file, beside it: the only other file, 0600, as it was.
  assert.deepEqual(others(), [event.backup.slice(dir.length + 1)]);
  assert.equal(statSync(event.backup).mode & 0o777, 0o600);
  assert.equal(readFileSync(event.backup, "utf8"), original);
  assert.deepEqual(open(readFileSync(event.backup, "utf8"), OLD), seed);
  assert.equal(readdirSync(state).includes("lock"), false, "the lock is removed");
  // The script itself: the old passphrase is refused now, the new one opens it.
  const stale = run(["rekey"], `${OLD}\n${OLD}x long enough\n${OLD}x long enough\n`);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /does not open/);
  assert.equal(readFileSync(seedFile, "utf8"), rekeyed);
});
