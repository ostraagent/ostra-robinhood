// A text task's stream from Ostra AI put together into one answer (ai.ts textStreamAnswer). The fixtures are two
// streams a model sent on 16 Oct 2026, one plain and one calling a tool, as Ostra AI's gateway passes them on (its
// chunk allow-list applied, its keep-alive comments, its `event: ostra` with what the task was charged, [DONE]).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { textStreamAnswer } from "../src/ai.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("a plain answer: content, reasoning, the closing event's model, usage and paid", () => {
  const a = textStreamAnswer(fixture("ai-text-stream.sse"));
  assert.deepEqual(a.message, { role: "assistant", content: "Blue", reasoning: "The user asks for a one-word answer about the color of a clear daytime sky. The answer is blue." });
  assert.equal(a.model, "inclusionai/ling-3.0-flash");
  assert.equal(a.finish_reason, "stop");
  assert.equal(a.task, "4863bea77ef9bb8d434f377c");
  assert.deepEqual(a.paid, { charged: "40", from_voucher: "40", channel: "0x7077e33ce22cce9365cc32c91e13660a56f94d62f519f8105eb624a5524edd7e", from_credit: "0", cost: "8", credited: "32", credit: "95", unit: "base units (0.000001 per unit)" });
  assert.equal(a.object, undefined);
});

test("a tool call: its id, name and arguments put together from the pieces", () => {
  const a = textStreamAnswer(fixture("ai-text-stream-tools.sse"));
  const m = a.message as { content: string; tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] };
  assert.equal(m.content, "");
  assert.deepEqual(m.tool_calls, [{ id: "call_642d4d295f6f4630b70bc03c", type: "function", function: { name: "get_weather", arguments: '{"city": "Jakarta"}' } }]);
  assert.deepEqual(JSON.parse(m.tool_calls[0]?.function.arguments ?? ""), { city: "Jakarta" });
  assert.equal(a.finish_reason, "tool_calls");
});

test("a stream the model broke off: the gateway's error and message kept, what came as partial", () => {
  const whole = fixture("ai-text-stream.sse");
  const at = whole.indexOf("event: ostra");
  const closing = JSON.stringify({ object: "ostra.task", task: "4863bea77ef9bb8d434f377c", error: "upstream_failed", message: "the model's answer stream failed", model: "inclusionai/ling-3.0-flash", paid: { charged: "40", from_voucher: "40", from_credit: "0", cost: "0", credited: "40", credit: "103" } });
  const a = textStreamAnswer(`${whole.slice(0, at)}event: ostra\ndata: ${closing}\n\ndata: [DONE]\n\n`);
  assert.equal(a.error, "upstream_failed");
  assert.equal(a.message, "the model's answer stream failed");
  assert.equal((a.partial as { content: string }).content, "Blue");
  assert.equal((a.paid as { credited: string }).credited, "40");
});

test("a stream cut before the closing event says so and keeps what came", () => {
  const whole = fixture("ai-text-stream.sse");
  const a = textStreamAnswer(whole.slice(0, whole.indexOf("event: ostra")));
  assert.equal(a.error, "stream_incomplete");
  assert.equal((a.partial as { content: string }).content, "Blue");
});
