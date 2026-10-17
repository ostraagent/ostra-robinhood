// Keccak-256 and SHA-256 against the golden cases of the Solana program crate
// (ostraagent/ostra e4a4153, program-tests/tests/vectors.rs; the hash cases of
// its vectors/core.json). The contracts use the same two hashes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fromHex, keccak256, sha256, toHex } from "../src/hash.ts";

type HashCase = { name: string; parts: string[]; keccak256: string; sha256: string };
const v = JSON.parse(readFileSync(new URL("./vectors/hashes.json", import.meta.url), "utf8")) as { hashes: HashCase[] };

test("keccak256 and sha256 match the program crate", () => {
  assert.equal(v.hashes.length, 4);
  for (const c of v.hashes) {
    const parts = c.parts.map(fromHex);
    assert.equal(toHex(keccak256(parts)), c.keccak256, `keccak256 ${c.name}`);
    assert.equal(toHex(sha256(parts)), c.sha256, `sha256 ${c.name}`);
  }
});
