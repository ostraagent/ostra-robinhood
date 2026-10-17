// src/abi.ts must be exactly what scripts/abi.ts writes from the Foundry build
// in ../out, so the SDK never calls a contract with a stale ABI and derives
// vault addresses from the BeaconProxy code the factory really uses.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { abiSource } from "../scripts/abi.ts";
import { OUT_DIR } from "./fork.ts";

test("src/abi.ts matches the Foundry build", () => {
  assert.equal(readFileSync(new URL("../src/abi.ts", import.meta.url), "utf8"), abiSource(OUT_DIR));
});
