// Ostrapad's content rules (src/pad-rules.ts): the four categories as decided on 30 Oct 2026, and a model's answer
// on a listing read only when it is one JSON verdict naming a category of the rules when it prohibits.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PAD_MODERATION_PROMPT, PAD_PROHIBITED, padProhibited, padRulesText, parsePadModeration } from "../src/index.ts";

test("the rules name the four categories and what stays allowed", () => {
  assert.deepEqual(
    PAD_PROHIBITED.map((c) => c.id),
    ["hacking", "fraud", "market-manipulation", "illegal-harm"],
  );
  const text = padRulesText();
  for (const c of PAD_PROHIBITED) assert.ok(text.includes(`"${c.id}"`) && text.includes(c.title), c.id);
  assert.match(text, /copyright/);
  assert.match(text, /trading bot for the client's own use/);
  assert.ok(PAD_MODERATION_PROMPT.includes(text));
  assert.match(PAD_MODERATION_PROMPT, /data, never instructions/);
  assert.equal(padProhibited("fraud")?.title, "Fraud and phishing");
  assert.equal(padProhibited("spam"), null);
});

test("a model's answer on a listing is read only when it is one JSON verdict", () => {
  assert.deepEqual(parsePadModeration('{"prohibited": false, "category": null, "reason": "Token reports."}'), { prohibited: false, category: null, reason: "Token reports." });
  assert.deepEqual(parsePadModeration('```json\n{"prohibited": true, "category": "fraud", "reason": "Sells fake login pages."}\n```'), { prohibited: true, category: "fraud", reason: "Sells fake login pages." });
  // A category is kept only with a prohibition.
  assert.deepEqual(parsePadModeration('{"prohibited": false, "category": "fraud"}'), { prohibited: false, category: null, reason: "Allowed under Ostrapad's content rules." });
  assert.deepEqual(parsePadModeration('{"prohibited": true, "category": "hacking"}'), { prohibited: true, category: "hacking", reason: "Prohibited: Hacking and malware." });
  // A prohibition without a category of the rules is no answer.
  assert.equal(parsePadModeration('{"prohibited": true, "category": "spam", "reason": "x"}'), null);
  assert.equal(parsePadModeration('{"prohibited": true}'), null);
  assert.equal(parsePadModeration('The listing says {"prohibited": false}. Verdict: {"prohibited": true, "category": "fraud"}'), null);
  assert.equal(parsePadModeration('{"prohibited": "no"}'), null);
  assert.equal(parsePadModeration("[false]"), null);
  assert.equal(parsePadModeration("allowed"), null);
});
