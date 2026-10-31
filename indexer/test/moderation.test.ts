// The index's moderator (src/moderation.ts) on answers in the shapes Raeto gave on 31 Oct 2026: a provider's refusal
// (anthropic/claude-sonnet-5.5, finish_reason "content_filter") sends the listing to the fallback model; both refusing
// prohibits it; an error status is no answer; a listing's key changes with what it lists.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PadModerationInput } from "@ostraagent/sdk";
import { REFUSED_LISTING, moderationKey, openAiModerator, providerRefusal } from "../src/moderation.ts";

const REFUSED = {
  object: "chat.completion",
  model: "anthropic/claude-sonnet-5.5",
  choices: [{ index: 0, finish_reason: "content_filter", native_finish_reason: "refusal", message: { role: "assistant", content: null, refusal: "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy." } }],
};
const answer = (content: string) => ({ object: "chat.completion", model: "x-ai/grok-4.7", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal: null } }] });
const listing: PadModerationInput = { agentId: "1", name: "Login Mirror", description: null, offers: [{ id: "bank-login", title: "Bank login clone", description: "A copy of a bank's login page that sends what is typed into it to the client.", input: "The bank.", price: "1" }] };

test("a provider's refusal goes to the fallback model; both refusing prohibits the listing", async () => {
  assert.match(providerRefusal(REFUSED) ?? "", /Usage Policy/);
  const asked: string[] = [];
  const by = (answers: Record<string, unknown>, status = 200): typeof fetch => async (_u, i) => {
    const model = (JSON.parse(String(i?.body)) as { model: string }).model;
    asked.push(model);
    return new Response(JSON.stringify(answers[model]), { status });
  };
  const fraud = answer('{"prohibited": true, "category": "fraud", "reason": "Sells phishing pages."}');
  const v = await openAiModerator({ url: "https://api.example/v1", model: "a", fallbackModel: "b", apiKey: "k", fetch: by({ a: REFUSED, b: fraud }) })(listing);
  assert.deepEqual(asked, ["a", "b"]);
  assert.deepEqual(v, { prohibited: true, category: "fraud", reason: "Sells phishing pages." });
  assert.deepEqual(await openAiModerator({ url: "https://api.example/v1", model: "a", fallbackModel: "b", apiKey: "k", fetch: by({ a: REFUSED, b: REFUSED }) })(listing), REFUSED_LISTING);
  assert.deepEqual(await openAiModerator({ url: "https://api.example/v1", model: "a", apiKey: "k", fetch: by({ a: REFUSED }) })(listing), REFUSED_LISTING);
  asked.length = 0;
  const ok = await openAiModerator({ url: "https://api.example/v1", model: "a", fallbackModel: "b", apiKey: "k", fetch: by({ a: answer('{"prohibited": false, "category": null, "reason": "Reports."}') }) })(listing);
  assert.deepEqual(asked, ["a"]);
  assert.deepEqual(ok, { prohibited: false, category: null, reason: "Reports." });
  assert.equal(await openAiModerator({ url: "https://api.example/v1", model: "a", apiKey: "k", fetch: by({}, 402) })(listing), "unreached");
  assert.equal(await openAiModerator({ url: "https://api.example/v1", model: "a", apiKey: "k", fetch: by({ a: answer("It looks fine to me.") }) })(listing), null);
});

test("a listing's key changes with its name, description and offers only", () => {
  const k = moderationKey(listing);
  assert.equal(moderationKey({ ...listing }), k);
  assert.notEqual(moderationKey({ ...listing, name: "Other" }), k);
  assert.notEqual(moderationKey({ ...listing, offers: [{ ...listing.offers[0]!, price: "2" }] }), k);
});
