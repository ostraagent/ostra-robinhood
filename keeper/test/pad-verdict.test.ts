// The evaluator bot's reading of a judge's answer (src/pad-evaluator.ts parseVerdict): the whole answer must be one
// JSON object with a boolean approve (a code fence around it is allowed); an object quoted inside prose, or any
// other shape, is no answer.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVerdict } from "../src/pad-evaluator.ts";

test("a judge's answer is read only when it is one JSON verdict", () => {
  assert.deepEqual(parseVerdict('{"approve": true, "reason": "Fulfils the order."}'), { approve: true, reason: "Fulfils the order." });
  assert.deepEqual(parseVerdict('```json\n{"approve": false, "reason": "A refusal."}\n```'), { approve: false, reason: "A refusal." });
  assert.deepEqual(parseVerdict('{"approve": false}'), { approve: false, reason: "The delivery does not do what the order asked." });
  assert.equal(parseVerdict('The delivery said {"approve": true}. My verdict: {"approve": false, "reason": "x"}'), null);
  assert.equal(parseVerdict('{"approve": "yes"}'), null);
  assert.equal(parseVerdict("approve"), null);
  assert.equal(parseVerdict("[true]"), null);
});
