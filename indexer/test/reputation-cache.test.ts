// Which answers of OstraReputation.verify the index keeps for the epoch (pad.ts cacheableVerdict): a valid proof and
// RepVerifier's genuine rejection only; a refusal that can heal (UnknownRoot on a node behind the tree) and an answer
// without a verdict are asked again on the next read.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheableVerdict } from "../src/pad.ts";

test("only a valid proof and RepVerifier's rejection are kept; refusals and no verdict are asked again", () => {
  assert.equal(cacheableVerdict({ valid: true, reverted: null, unverifiable: null }), true);
  assert.equal(cacheableVerdict({ valid: false, reverted: null, unverifiable: null }), true, "RepVerifier rejects the proof: final for these inputs");
  for (const reverted of ["UnknownRoot", "NotCanonical", "BadThresholds", "BadThresholds (maxFailPermille is at most 1000)"]) {
    assert.equal(cacheableVerdict({ valid: false, reverted, unverifiable: null }), false, reverted);
  }
  for (const unverifiable of ["InsufficientGas", "VerifierHalted", "fetch failed"]) {
    assert.equal(cacheableVerdict({ valid: false, reverted: null, unverifiable }), false, unverifiable);
  }
});
