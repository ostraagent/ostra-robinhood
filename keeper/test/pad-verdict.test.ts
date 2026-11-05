// The evaluator bot's reading of a judge's answer (src/pad-evaluator.ts parseVerdict): the whole answer must be one
// JSON object with a boolean approve (a code fence around it is allowed); an object quoted inside prose, or any
// other shape, is no answer. A category of Ostrapad's content rules makes it a rejection naming the category.

import assert from "node:assert/strict";
import { test } from "node:test";
import { JUDGE_MAX_BYTES, REFUSED_REASON, failoverJudges, judgeMessage, judgeProviders, judgeSameApi, openAiJudge, parseVerdict, providerRefusal, type Case } from "../src/pad-evaluator.ts";

test("a judge's answer is read only when it is one JSON verdict", () => {
  assert.deepEqual(parseVerdict('{"approve": true, "reason": "Fulfils the order."}'), { approve: true, reason: "Fulfils the order." });
  assert.deepEqual(parseVerdict('```json\n{"approve": false, "reason": "A refusal."}\n```'), { approve: false, reason: "A refusal." });
  assert.deepEqual(parseVerdict('{"approve": false}'), { approve: false, reason: "The delivery does not do what the order asked." });
  assert.equal(parseVerdict('The delivery said {"approve": true}. My verdict: {"approve": false, "reason": "x"}'), null);
  assert.equal(parseVerdict('{"approve": "yes"}'), null);
  assert.equal(parseVerdict("approve"), null);
  assert.equal(parseVerdict("[true]"), null);
  assert.deepEqual(parseVerdict('{"approve": true, "category": null, "reason": "Fulfils the order."}'), { approve: true, reason: "Fulfils the order." });
});

test("a category of Ostrapad's content rules makes the verdict a rejection naming it", () => {
  assert.deepEqual(parseVerdict('{"approve": true, "category": "fraud", "reason": "A fake login page for a bank."}'), {
    approve: false,
    category: "fraud",
    reason: "Rejected under Ostrapad's content rules (Fraud and phishing): A fake login page for a bank.",
  });
  assert.deepEqual(parseVerdict('{"approve": false, "category": "hacking"}'), { approve: false, category: "hacking", reason: "Rejected under Ostrapad's content rules (Hacking and malware): the work is hacking and malware." });
  // A category that is not one of the rules: a plain rejection, or no answer for an approval.
  assert.deepEqual(parseVerdict('{"approve": false, "category": "spam", "reason": "Off-topic."}'), { approve: false, reason: "Off-topic." });
  assert.equal(parseVerdict('{"approve": true, "category": "spam", "reason": "x"}'), null);
});

test("a judge's message stays within the cost limit: a large order and delivery are cut, with notes", () => {
  const c: Case = { jobId: `0x${"11".repeat(32)}`, budget: "1", offer: { id: "x" }, order: { input: "o".repeat(30_000) }, delivery: { output: "d".repeat(90_000) }, notes: [] };
  const m = judgeMessage(c);
  assert.ok(Buffer.byteLength(m) <= JUDGE_MAX_BYTES, String(Buffer.byteLength(m)));
  const v = JSON.parse(m) as { order: string; delivery: string; notes: string[] };
  assert.equal(typeof v.order, "string");
  assert.ok(v.order.length > 3_000 && v.delivery.length > 7_000, `${v.order.length} ${v.delivery.length}`);
  assert.ok(v.notes.some((n) => /order's JSON text was cut/.test(n)) && v.notes.some((n) => /delivery's JSON text was cut/.test(n)));
  // A small case goes whole.
  const small: Case = { ...c, order: { input: "a" }, delivery: { output: "b" } };
  assert.deepEqual(JSON.parse(judgeMessage(small)).delivery, { output: "b" });
  // A long offer (candidates) and a long reason under appeal are cut too.
  const appeal: Case = { ...c, offer: { candidates: Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, description: "z".repeat(1_000) })) }, decision: { approve: false, reason: "r".repeat(60_000) } };
  const a = judgeMessage(appeal);
  assert.ok(Buffer.byteLength(a) <= JUDGE_MAX_BYTES, String(Buffer.byteLength(a)));
  const av = JSON.parse(a) as { offer: string; decision: { approve: boolean; reason: string }; notes: string[] };
  assert.ok(Buffer.byteLength(JSON.stringify(av.offer)) <= 4_000 && av.offer.length > 3_900, String(av.offer.length));
  assert.ok(Buffer.byteLength(JSON.stringify(av.decision.reason)) <= 2_000 && av.decision.reason.length > 1_900, String(av.decision.reason.length));
  // Escaped control characters in the reason and the offer still fit the bound.
  const escaped = judgeMessage({ ...appeal, offer: { d: "\u0001".repeat(30_000) }, decision: { approve: true, reason: "\u0002".repeat(30_000) } });
  assert.ok(Buffer.byteLength(escaped) <= JUDGE_MAX_BYTES, String(Buffer.byteLength(escaped)));
  assert.equal(av.decision.approve, false);
  assert.ok(av.notes.some((n) => /decision's reason was cut/.test(n)) && av.notes.some((n) => /offer's JSON text was cut/.test(n)));
  // Multi-byte text is counted in bytes.
  assert.ok(Buffer.byteLength(judgeMessage({ ...c, delivery: { output: "\u00e9\u4e2d".repeat(40_000) } })) <= JUDGE_MAX_BYTES);
});

// Raeto's answers of 31 Oct 2026 to the phishing case of scripts/pad-judge-check.ts (ids and reasoning data left out).
const SONNET_REFUSED = {
  object: "chat.completion",
  model: "anthropic/claude-sonnet-5.5",
  provider: "Claude Platform on AWS",
  choices: [{ index: 0, finish_reason: "content_filter", native_finish_reason: "refusal", message: { role: "assistant", content: null, refusal: "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.", reasoning: null } }],
};
const GROK_ANSWER = {
  object: "chat.completion",
  model: "x-ai/grok-4.7",
  provider: "xAI",
  choices: [{ index: 0, finish_reason: "stop", native_finish_reason: "completed", message: { role: "assistant", content: '{"approve": false, "category": "fraud", "reason": "The order asks for a fake Robinhood login page that sends typed credentials to the client\'s server, and the delivery is that credential-harvesting form. That is phishing and impersonation, which is prohibited."}', refusal: null } }],
};

test("a provider's refusal is read as one, and the judge asks the other model", async () => {
  assert.match(providerRefusal(SONNET_REFUSED) ?? "", /Anthropic's Usage Policy/);
  assert.equal(providerRefusal(GROK_ANSWER), null);
  const c: Case = { jobId: `0x${"44".repeat(32)}`, budget: "1", offer: null, order: { input: "x" }, delivery: { output: "y" }, notes: [] };
  const asked: string[] = [];
  const answers = (by: Record<string, unknown>, status = 200): typeof fetch => async (_u, i) => {
    const model = (JSON.parse(String(i?.body)) as { model: string }).model;
    asked.push(model);
    return new Response(JSON.stringify(by[model]), { status });
  };
  const sonnet = "anthropic/claude-sonnet-5.5";
  const grok = "x-ai/grok-4.7";
  const v = await openAiJudge({ url: "https://api.example/v1", model: sonnet, fallbackModel: grok, apiKey: "k", fetch: answers({ [sonnet]: SONNET_REFUSED, [grok]: GROK_ANSWER }) })(c);
  assert.deepEqual(asked, [sonnet, grok]);
  assert.ok(v !== null && v !== "unreached");
  assert.equal(v.approve, false);
  assert.equal(v.category, "fraud");
  assert.deepEqual(v.refusedBy, [sonnet]);
  // Both refuse: a rejection under the content rules.
  const both = await openAiJudge({ url: "https://api.example/v1", model: sonnet, fallbackModel: grok, apiKey: "k", fetch: answers({ [sonnet]: SONNET_REFUSED, [grok]: SONNET_REFUSED }) })(c);
  assert.deepEqual(both, { approve: false, reason: REFUSED_REASON, refusedBy: [sonnet, grok] });
  // A model that answers is not asked twice; an error status is no answer.
  asked.length = 0;
  const plain = await openAiJudge({ url: "https://api.example/v1", model: grok, fallbackModel: sonnet, apiKey: "k", fetch: answers({ [grok]: GROK_ANSWER }) })(c);
  assert.deepEqual(asked, [grok]);
  assert.ok(plain !== null && plain !== "unreached" && plain.refusedBy === undefined);
  assert.equal(await openAiJudge({ url: "https://api.example/v1", model: grok, apiKey: "k", fetch: answers({}, 402) })(c), "unreached");
  // A refusal (a paid answer), then no answer from the fallback: an answer of another shape, never "unreached" (which
  // would send the case on to another API).
  const byModel = (refusal: unknown): typeof fetch => async (_u, i) => {
    const model = (JSON.parse(String(i?.body)) as { model: string }).model;
    return model === sonnet ? new Response(JSON.stringify(refusal), { status: 200 }) : new Response("{}", { status: 503 });
  };
  assert.equal(await openAiJudge({ url: "https://api.example/v1", model: sonnet, fallbackModel: grok, apiKey: "k", fetch: byModel(SONNET_REFUSED) })(c), null);
});

test("the judges over several APIs: a paid refusal with no fallback answer stays on its API", async () => {
  const c: Case = { jobId: `0x${"55".repeat(32)}`, budget: "1", offer: null, order: { input: "x" }, delivery: { output: "y" }, notes: [] };
  const asked: string[] = [];
  // API a: its judge model refuses, its panel model (the fallback) gives no answer; API b answers.
  const f: typeof fetch = async (u, i) => {
    const model = (JSON.parse(String(i?.body)) as { model: string }).model;
    const host = new URL(String(u)).host;
    asked.push(`${host} ${model}`);
    if (host === "a.example") return model === "m1" ? new Response(JSON.stringify(SONNET_REFUSED), { status: 200 }) : new Response("{}", { status: 503 });
    return new Response(JSON.stringify(GROK_ANSWER), { status: 200 });
  };
  const ps = judgeProviders(
    { OSTRA_PAD_JUDGE_URL: "https://a.example/v1", OSTRA_PAD_JUDGE_MODEL: "m1", OSTRA_PAD_JUDGE_KEY_FILE: "/k", OSTRA_PAD_PANEL_JUDGE_MODEL: "f1", OSTRA_PAD_JUDGE_URL_2: "https://b.example/v1", OSTRA_PAD_JUDGE_MODEL_2: "m2", OSTRA_PAD_JUDGE_KEY_FILE_2: "/k" },
    () => "key",
  );
  const { judge } = failoverJudges(ps, { fetch: f });
  assert.equal(await judge(c), null);
  assert.deepEqual(asked, ["a.example m1", "a.example f1"]);
  // API a gives no answer at all: API b is asked and decides.
  asked.length = 0;
  const down: typeof fetch = async (u, i) => (new URL(String(u)).host === "a.example" ? new Response("{}", { status: 502 }) : f(u, i));
  const v = await failoverJudges(ps, { fetch: down }).judge(c);
  assert.ok(v !== null && v !== "unreached" && v.approve === false);
  assert.deepEqual(asked, ["b.example m2"]);
});

test("the judging APIs from the environment: the panel on the judge's API and key unless set, each set whole", () => {
  const keys: Record<string, string> = { "/j1": "judge-one", "/j2": "judge-two", "/p1": "panel-one" };
  const read = (path: string) => keys[path] ?? "";
  assert.throws(() => judgeProviders({}, read), /missing environment variable OSTRA_PAD_JUDGE_URL/);
  const ps = judgeProviders(
    {
      OSTRA_PAD_JUDGE_URL: "https://first.example/v1",
      OSTRA_PAD_JUDGE_MODEL: "j1",
      OSTRA_PAD_JUDGE_KEY_FILE: "/j1",
      OSTRA_PAD_PANEL_JUDGE_MODEL: "p1",
      OSTRA_PAD_JUDGE_URL_2: "https://second.example/v1",
      OSTRA_PAD_JUDGE_MODEL_2: "j2",
      OSTRA_PAD_JUDGE_KEY_FILE_2: "/j2",
      OSTRA_PAD_PANEL_JUDGE_MODEL_2: "p2",
    },
    read,
  );
  assert.deepEqual(ps, [
    { url: "https://first.example/v1", model: "j1", apiKey: "judge-one", panelUrl: "https://first.example/v1", panelModel: "p1", panelKey: "judge-one" },
    { url: "https://second.example/v1", model: "j2", apiKey: "judge-two", panelUrl: "https://second.example/v1", panelModel: "p2", panelKey: "judge-two" },
  ]);
  assert.deepEqual(ps.map(judgeSameApi), [true, true]);
  const one = { OSTRA_PAD_JUDGE_URL: "https://first.example/v1", OSTRA_PAD_JUDGE_MODEL: "j1", OSTRA_PAD_JUDGE_KEY_FILE: "/j1" };
  // No panel model: the judge's model, on its API (no fallback between them: one model).
  const [same] = judgeProviders(one, read);
  assert.equal(same?.panelModel, "j1");
  assert.equal(judgeSameApi(same as never), false);
  // A panel of its own (another API and key): not the judge's fallback.
  const [own] = judgeProviders({ ...one, OSTRA_PAD_PANEL_JUDGE_MODEL: "p1", OSTRA_PAD_PANEL_JUDGE_URL: "https://panel.example/v1", OSTRA_PAD_PANEL_JUDGE_KEY_FILE: "/p1" }, read);
  assert.deepEqual(own, { url: "https://first.example/v1", model: "j1", apiKey: "judge-one", panelUrl: "https://panel.example/v1", panelModel: "p1", panelKey: "panel-one" });
  assert.equal(judgeSameApi(own as never), false);
  assert.throws(() => judgeProviders({ ...one, OSTRA_PAD_JUDGE_MODEL_2: "j2" }, read), /OSTRA_PAD_JUDGE_URL_2, OSTRA_PAD_JUDGE_MODEL_2 and OSTRA_PAD_JUDGE_KEY_FILE_2 go together/);
  assert.throws(() => judgeProviders({ ...one, OSTRA_PAD_JUDGE_KEY_FILE: "/none" }, read), /is empty/);
  assert.throws(() => judgeProviders({ ...one, OSTRA_PAD_PANEL_JUDGE_URL: "panel.example" }, read), /OSTRA_PAD_PANEL_JUDGE_URL must be an http\(s\) URL/);
});
