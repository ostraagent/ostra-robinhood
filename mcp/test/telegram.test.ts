// Ostra Bot's pieces that need no chain (remote-telegram.ts): a Mini App's initData checked against Telegram's
// signature, with the example the Telegram Mini Apps documentation publishes (docs.telegram-mini-apps.com,
// platform/init-data: its bot token, its init data and its hash, which the HMAC here reproduces); the Telegram homes'
// names; messages cut for Telegram; the tools offered to the model; a model call's max_price; and Ostra AI's answers
// as the ostra_ai tool returns them, built from the two streams a model sent on 16 Oct 2026 (core/test/fixtures).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getAddress } from "viem";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { textStreamAnswer } from "@ostraagent/core";
import { MAX_INIT_AGE_SECONDS, callCap, readAiAnswer, splitMessage, telegramHomeId, toolsForModel, verifyInitData } from "../src/remote-telegram.ts";

const TOKEN = "5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8";
const AUTH_DATE = 1662771648;
const USER = JSON.stringify({ id: 279058397, first_name: "Vladislav", last_name: "Kibenko", username: "vdkfrost", language_code: "ru", is_premium: true });
const HASH = "c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2";
const initData = (fields: [string, string][]) => new URLSearchParams(fields).toString();
const EXAMPLE = initData([
  ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"],
  ["user", USER],
  ["auth_date", String(AUTH_DATE)],
  ["hash", HASH],
]);

test("initData: the documented example is Telegram's for its bot, and names its user", () => {
  const u = verifyInitData(EXAMPLE, TOKEN, AUTH_DATE + 60);
  assert.deepEqual(u, { id: "279058397", name: "Vladislav Kibenko", username: "vdkfrost" });
  // The fields in another order: the same check (they are sorted by key).
  const shuffled = initData([
    ["hash", HASH],
    ["auth_date", String(AUTH_DATE)],
    ["user", USER],
    ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"],
  ]);
  assert.equal(verifyInitData(shuffled, TOKEN, AUTH_DATE).id, "279058397");
});

test("initData: refused when changed, for another bot, old, from the future, doubled or incomplete", () => {
  const refused = (data: unknown, at = AUTH_DATE + 60, token = TOKEN) =>
    assert.throws(() => verifyInitData(data, token, at), (err: Error & { status?: number }) => err.status === 401);
  refused(EXAMPLE.replace("Vladislav", "Vladimir"));
  refused(EXAMPLE, AUTH_DATE + 60, "5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx9");
  refused(EXAMPLE, AUTH_DATE + MAX_INIT_AGE_SECONDS + 1);
  assert.equal(verifyInitData(EXAMPLE, TOKEN, AUTH_DATE + MAX_INIT_AGE_SECONDS).id, "279058397");
  refused(EXAMPLE, AUTH_DATE - 301);
  refused(`${EXAMPLE}&auth_date=${AUTH_DATE}`);
  refused(EXAMPLE.replace(`&hash=${HASH}`, ""));
  refused(EXAMPLE.replace(HASH, HASH.toUpperCase()));
  refused("");
  refused(undefined);
  refused("x".repeat(8_193));
});

test("Telegram homes: t and 40 hex digits, one per user and vault, the same each time", () => {
  const key = Buffer.alloc(32, 7);
  const a = getAddress("0x00000000000000000000000000000000000C0D81");
  const b = getAddress("0x00000000000000000000000000000000000C0D82");
  const h = telegramHomeId(key, "279058397", a);
  assert.match(h, /^t[0-9a-f]{40}$/);
  assert.equal(telegramHomeId(key, "279058397", a.toLowerCase() as typeof a), h);
  assert.notEqual(telegramHomeId(key, "279058397", b), h);
  assert.notEqual(telegramHomeId(key, "279058398", a), h);
  assert.notEqual(telegramHomeId(Buffer.alloc(32, 8), "279058397", a), h);
});

test("messages cut for Telegram: parts within the limit, at a line or a space, never inside a surrogate pair", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
  assert.deepEqual(splitMessage("   "), ["(empty)"]);
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const parts = splitMessage(lines, 1_000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1_000 && p.length > 0);
  assert.equal(parts.join("\n"), lines);
  const emoji = "\u{1F600}".repeat(600);
  const cut = splitMessage(emoji, 1_001);
  for (const p of cut) {
    assert.ok(p.length <= 1_001);
    assert.equal(p.length % 2, 0, "no half of a pair");
  }
  assert.equal(cut.join(""), emoji);
});

test("the tools offered to the model: none of the owner's, the agent key's or Ostra AI's own; $schema dropped", () => {
  const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { amount: { type: "string" } }, required: ["amount"] };
  const tools = toolsForModel(
    ["balance", "withdraw", "policy_set", "allow_set", "agent_key_revoke", "agent_key_request", "agent_key_set", "ostra_ai", "ostra_ai_job", "ostra_ai_credit"].map((name) => ({ name, description: `${name} does it`, inputSchema: schema })),
  );
  assert.deepEqual(
    tools.map((t) => t.function.name),
    ["balance", "withdraw", "ostra_ai_credit"],
  );
  assert.deepEqual(tools[0], { type: "function", function: { name: "balance", description: "balance does it", parameters: { type: "object", properties: { amount: { type: "string" } }, required: ["amount"] } } });
});

test("a model call's max_price: half the budget, or what is left of it", () => {
  assert.equal(callCap(50_000n, 0n), 25_000n);
  assert.equal(callCap(50_000n, 20_000n), 25_000n);
  assert.equal(callCap(50_000n, 30_000n), 20_000n);
  assert.equal(callCap(50_000n, 50_000n), 0n);
});

/** An ostra_ai answer as tools.ts returns it (core AiService.task's result, as JSON text). */
const toolAnswer = (r: unknown, isError = false): JSONRPCMessage =>
  ({ jsonrpc: "2.0", id: "x", result: { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: isError ? String(r) : JSON.stringify(r, null, 2) }] } }) as JSONRPCMessage;
const fixture = (name: string) => readFileSync(new URL(`../../core/test/fixtures/${name}`, import.meta.url), "utf8");

test("Ostra AI's answers read: a tool call, a plain answer, its cost; a refusal, a failed stream, a tool error", () => {
  const tools = readAiAnswer(toolAnswer({ status: 200, paid: "0.00004", channel: "0x01", channelLeft: "0.9", answer: textStreamAnswer(fixture("ai-text-stream-tools.sse")) }), 25_000n);
  assert.equal(tools.ok, true);
  if (tools.ok) {
    assert.deepEqual(tools.message.tool_calls, [{ id: "call_642d4d295f6f4630b70bc03c", type: "function", function: { name: "get_weather", arguments: '{"city": "Jakarta"}' } }]);
  }
  const plain = readAiAnswer(toolAnswer({ status: 200, paid: "0.00004", channel: "0x01", channelLeft: "0.9", answer: textStreamAnswer(fixture("ai-text-stream.sse")) }), 25_000n);
  assert.deepEqual(plain, { ok: true, message: { role: "assistant", content: "Blue" }, cost: 8n });

  const refused = readAiAnswer(toolAnswer({ status: 402, paid: null, channel: null, channelLeft: null, answer: { error: "no_model", message: "no model can do this task within max_price" } }), 25_000n);
  assert.equal(refused.ok, false);
  assert.equal(refused.cost, 0n);
  assert.match((refused as { text: string }).text, /^Ostra AI refused this message \(402\): no model can do this task within max_price/);

  const whole = fixture("ai-text-stream.sse");
  const at = whole.indexOf("event: ostra");
  const closing = JSON.stringify({ object: "ostra.task", task: "4863bea77ef9bb8d434f377c", error: "upstream_failed", message: "the model's answer stream failed", paid: { charged: "40", from_voucher: "40", from_credit: "0", cost: "0", credited: "40", credit: "103" } });
  const failed = readAiAnswer(toolAnswer({ status: 200, paid: "0.00004", answer: textStreamAnswer(`${whole.slice(0, at)}event: ostra\ndata: ${closing}\n\ndata: [DONE]\n\n`) }), 25_000n);
  assert.deepEqual([failed.ok, failed.cost], [false, 0n], "a failed stream costs what its closing event tells");
  assert.match((failed as { text: string }).text, /upstream_failed/);

  const cut = readAiAnswer(toolAnswer({ status: 200, paid: "0.00004", answer: textStreamAnswer(whole.slice(0, at)) }), 25_000n);
  assert.deepEqual([cut.ok, cut.cost], [false, 25_000n], "a stream cut before its cost was told counts as its max_price");

  const error = readAiAnswer(toolAnswer("ostra_ai: the agent key's policy does not allow open_channel", true), 25_000n);
  assert.deepEqual([error.ok, error.cost], [false, 0n]);
  assert.match((error as { text: string }).text, /^Ostra AI was not asked: ostra_ai: the agent key's policy/);

  const rpcError = readAiAnswer({ jsonrpc: "2.0", id: "x", error: { code: -32000, message: "the session's server ended" } } as JSONRPCMessage, 25_000n);
  assert.equal(rpcError.ok, false);
});
