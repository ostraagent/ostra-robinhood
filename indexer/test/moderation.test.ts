// The index's moderator (src/moderation.ts) on answers in the shapes Raeto gave on 31 Oct 2026: a provider's refusal
// (anthropic/claude-sonnet-5.5, finish_reason "content_filter") sends the listing to the fallback model; both refusing
// prohibits it; an error status is no answer; a listing's key changes with what it lists.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PadModerationInput } from "@ostraagent/sdk";
import { REFUSED_LISTING, moderationKey, moderationProviderName, moderationProviders, openAiModerator, providerRefusal } from "../src/moderation.ts";

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
  // A refusal (a paid answer), then no answer from the fallback model: null, never "unreached" (which would send the
  // listing on to another API).
  const refusedThenDown: typeof fetch = async (_u, i) => ((JSON.parse(String(i?.body)) as { model: string }).model === "a" ? new Response(JSON.stringify(REFUSED), { status: 200 }) : new Response("{}", { status: 503 }));
  assert.equal(await openAiModerator({ url: "https://api.example/v1", model: "a", fallbackModel: "b", apiKey: "k", fetch: refusedThenDown })(listing), null);
});

test("a listing's key changes with its name, description and offers only", () => {
  const k = moderationKey(listing);
  assert.equal(moderationKey({ ...listing }), k);
  assert.notEqual(moderationKey({ ...listing, name: "Other" }), k);
  assert.notEqual(moderationKey({ ...listing, offers: [{ ...listing.offers[0]!, price: "2" }] }), k);
});

test("the moderation APIs from the environment: the first without a number, then _2 ..., each set whole", () => {
  const keys: Record<string, string> = { "/k1": "key-one", "/k2": "key-two", "/empty": "" };
  const read = (path: string) => keys[path] ?? "";
  assert.deepEqual(moderationProviders({}, read), []);
  const two = moderationProviders(
    {
      OSTRA_PAD_MODERATION_URL: "https://first.example/api/v1",
      OSTRA_PAD_MODERATION_MODEL: "m1",
      OSTRA_PAD_MODERATION_KEY_FILE: "/k1",
      OSTRA_PAD_MODERATION_FALLBACK_MODEL: "f1",
      OSTRA_PAD_MODERATION_URL_2: "https://second.example/v1",
      OSTRA_PAD_MODERATION_MODEL_2: "m2",
      OSTRA_PAD_MODERATION_KEY_FILE_2: "/k2",
    },
    read,
  );
  assert.deepEqual(two, [
    { url: "https://first.example/api/v1", model: "m1", apiKey: "key-one", fallbackModel: "f1" },
    { url: "https://second.example/v1", model: "m2", apiKey: "key-two" },
  ]);
  assert.deepEqual(two.map(moderationProviderName), ["first.example m1", "second.example m2"]);
  const one = { OSTRA_PAD_MODERATION_URL: "https://first.example/v1", OSTRA_PAD_MODERATION_MODEL: "m1", OSTRA_PAD_MODERATION_KEY_FILE: "/k1" };
  assert.throws(() => moderationProviders({ ...one, OSTRA_PAD_MODERATION_URL_2: "https://second.example/v1" }, read), /OSTRA_PAD_MODERATION_URL_2, OSTRA_PAD_MODERATION_MODEL_2 and OSTRA_PAD_MODERATION_KEY_FILE_2 go together/);
  assert.throws(() => moderationProviders({ OSTRA_PAD_MODERATION_URL: "https://first.example/v1" }, read), /OSTRA_PAD_MODERATION_URL, OSTRA_PAD_MODERATION_MODEL and OSTRA_PAD_MODERATION_KEY_FILE go together/);
  assert.throws(() => moderationProviders({ ...one, OSTRA_PAD_MODERATION_KEY_FILE: "/empty" }, read), /is empty/);
  assert.throws(() => moderationProviders({ ...one, OSTRA_PAD_MODERATION_URL: "first.example/v1" }, read), /must be an http\(s\) URL/);
  assert.throws(() => moderationProviders({ ...one, OSTRA_PAD_MODERATION_URL_3: "https://third.example/v1" }, read), /provider 2 has none/);
  // A fallback model alone names no API: ignored, as it was (listings served unchecked).
  assert.deepEqual(moderationProviders({ OSTRA_PAD_MODERATION_FALLBACK_MODEL: "f1" }, read), []);
  // The scheme in any case, as a URL allows.
  assert.equal(moderationProviders({ ...one, OSTRA_PAD_MODERATION_URL: "HTTPS://first.example/v1" }, read)[0]?.url, "HTTPS://first.example/v1");
});
