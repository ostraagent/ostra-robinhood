// Ostra Bot's pieces that need no chain (remote-telegram.ts): a Mini App's initData checked against Telegram's
// signature, with the example the Telegram Mini Apps documentation publishes (docs.telegram-mini-apps.com,
// platform/init-data: its bot token, its init data and its hash, which the HMAC here reproduces); the Telegram homes'
// names; messages cut for Telegram; the tools offered to the model; a model call's max_price; Ostra AI's answers
// as the ostra_ai tool returns them, built from the two streams a model sent on 16 Oct 2026 (core/test/fixtures); a
// model's Markdown as Telegram entities (answers written the way Ostra Bot's model writes them); the chat's AI cost in
// the system prompt; and a bindings table from before that cost was kept, given its columns.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { getAddress } from "viem";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { textStreamAnswer } from "@ostraagent/core";
import {
  MAX_INIT_AGE_SECONDS,
  RemoteTelegram,
  balanceFences,
  callCap,
  formatForTelegram,
  readAiAnswer,
  splitMessage,
  systemPrompt,
  telegramHomeId,
  toolsForModel,
  verifyInitData,
  type TelegramEntity,
  type TelegramOptions,
} from "../src/remote-telegram.ts";

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

/** Telegram's nesting rules hold: two entities share characters only when one holds the other, and code and pre hold none and sit in none. */
function nests(text: string, entities: readonly TelegramEntity[]): void {
  for (const e of entities) assert.ok(e.offset >= 0 && e.length > 0 && e.offset + e.length <= text.length, `entity inside the text: ${JSON.stringify(e)}`);
  for (const a of entities)
    for (const b of entities) {
      if (a === b) continue;
      const overlap = Math.min(a.offset + a.length, b.offset + b.length) - Math.max(a.offset, b.offset);
      if (overlap <= 0) continue;
      const aInB = a.offset >= b.offset && a.offset + a.length <= b.offset + b.length;
      const bInA = b.offset >= a.offset && b.offset + b.length <= a.offset + a.length;
      assert.ok(aInB || bInA, `entities cross: ${JSON.stringify([a, b])}`);
      assert.ok(!["code", "pre"].includes(a.type) && !["code", "pre"].includes(b.type), `code or pre nested: ${JSON.stringify([a, b])}`);
    }
}
const span = (text: string, e: TelegramEntity) => text.slice(e.offset, e.offset + e.length);

test("a model's Markdown as Telegram entities: answers as Ostra Bot's model writes them, nesting as Telegram allows", () => {
  // A balance answer.
  const a = formatForTelegram("The vault's USDG balance is **12.5 USDG**.");
  assert.equal(a.text, "The vault's USDG balance is 12.5 USDG.");
  assert.deepEqual(a.entities, [{ type: "bold", offset: 28, length: 9 }]);

  // An answer with a list.
  const b = formatForTelegram(
    "What I can see on the vault:\n- **Relayer channel:** 0.04 USDG spent on relayer fees, with 0.96 USDG unused.\n- **Nonce:** 7, which counts the vault's operations overall.\n\nIf you want the full history, the Ostra web app (app.ostraagent.xyz) shows the vault's transactions.",
  );
  assert.equal(
    b.text,
    "What I can see on the vault:\n• Relayer channel: 0.04 USDG spent on relayer fees, with 0.96 USDG unused.\n• Nonce: 7, which counts the vault's operations overall.\n\nIf you want the full history, the Ostra web app (app.ostraagent.xyz) shows the vault's transactions.",
  );
  assert.deepEqual(b.entities.map((e) => [e.type, span(b.text, e)]), [["bold", "Relayer channel:"], ["bold", "Nonce:"]]);

  // Headings, a link, code inside bold (cut around it), italic inside a link, a fence with its language.
  const c = formatForTelegram("## Next\nRun **the `balance` tool** then see [*the* app](https://app.ostraagent.xyz).\n```json\n{\"a\": 1}\n```\n~~old~~ done");
  assert.equal(c.text, "Next\nRun the balance tool then see the app.\n{\"a\": 1}\nold done");
  nests(c.text, c.entities);
  assert.deepEqual(
    c.entities.map((e) => [e.type, span(c.text, e), e.url ?? e.language ?? null]),
    [
      ["bold", "Next", null],
      ["bold", "the ", null],
      ["code", "balance", null],
      ["bold", " tool", null],
      ["text_link", "the app", "https://app.ostraagent.xyz"],
      ["italic", "the", null],
      ["pre", "{\"a\": 1}", "json"],
      ["strikethrough", "old", null],
    ],
  );

  // What is not Markdown stays as written.
  for (const plain of ["2*3*4 = 24", "a * b * c", "open_channel and agent_key_set", "x__y__z and a__b", "**not closed", "costs $5 [see](ftp://x)", "price `", "x**y**z stays"])
    if (plain === "x**y**z stays") assert.equal(formatForTelegram(plain).text, "xyz stays");
    else assert.deepEqual(formatForTelegram(plain), { text: plain, entities: [] }, plain);
  assert.deepEqual(formatForTelegram("\\*not italic\\*"), { text: "*not italic*", entities: [] });

  // UTF-16 offsets, and the white space Telegram drops moved out with the entities.
  const d = formatForTelegram("\n\n  - 😀 **ok** and *fine*\n\n---\n");
  assert.equal(d.text, "• 😀 ok and fine");
  nests(d.text, d.entities);
  assert.deepEqual(d.entities.map((e) => [e.type, e.offset, span(d.text, e)]), [["bold", 5, "ok"], ["italic", 12, "fine"]]);

  // A heading that is bold already: one bold entity, not two over the same characters.
  assert.deepEqual(formatForTelegram("## **Balance**"), { text: "Balance", entities: [{ type: "bold", offset: 0, length: 7 }] });
  assert.deepEqual(formatForTelegram("__bold__, then x"), { text: "bold, then x", entities: [{ type: "bold", offset: 0, length: 4 }] });

  // An unclosed fence: the rest is code.
  const e = formatForTelegram("Here:\n```\nline 1\nline 2");
  assert.equal(e.text, "Here:\nline 1\nline 2");
  assert.deepEqual(e.entities, [{ type: "pre", offset: 6, length: 13 }]);
});

test("fenced code cut between two message parts is closed in the first and opened again in the second", () => {
  const md = `Result:\n\`\`\`json\n${'{"k": 1}\n'.repeat(120)}\`\`\`\nDone **ok**.`;
  const parts = balanceFences(splitMessage(md, 300));
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  for (const [i, part] of parts.entries()) {
    assert.ok(part.length <= 300 + 12, `part ${i} is ${part.length} characters`);
    const f = formatForTelegram(part);
    nests(f.text, f.entities);
    const fences = part.split("\n").filter((l) => l.trim().startsWith("```")).length;
    assert.equal(fences % 2, 0, `part ${i} has its fences paired`);
    if (i > 0 && i < parts.length - 1) assert.ok(part.startsWith("```json\n") && part.endsWith("\n```"), `part ${i} is code, opened and closed`);
  }
  const last = formatForTelegram(parts.at(-1) as string);
  assert.ok(last.text.endsWith("Done ok."));
  assert.deepEqual(last.entities.at(-1), { type: "bold", offset: last.text.length - 3, length: 2 });
  assert.deepEqual(balanceFences(["no code here", "nor here"]), ["no code here", "nor here"]);
});

test("the system prompt tells the model what the chat's AI cost so far, when it is given", () => {
  const vault = getAddress("0x1111111111111111111111111111111111111111");
  const bare = systemPrompt(vault);
  assert.doesNotMatch(bare, /cost, paid from the vault/);
  const p = systemPrompt(vault, { spent: 12_244n, messages: 2, since: 1_794_580_440, budget: 50_000n });
  assert.match(p, /since this Telegram account connected the vault \(2026-11-13T14:34:00\.000Z\): 0\.012244 USDG over 2 messages, not counting the message being answered/);
  assert.match(p, /AI budget of a message: at most 0\.05 USDG/);
  assert.match(systemPrompt(vault, { spent: 0n, messages: 1, since: 1_794_580_440, budget: 10_000n }), /0 USDG over 1 message, /);
});

test("a bindings table from before the chat's AI cost was kept gets its columns, its bindings counting from 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "ostra-tg-db-"));
  try {
    const path = join(dir, "telegram.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE bindings (tg_user TEXT PRIMARY KEY, vault TEXT NOT NULL, home TEXT NOT NULL, root TEXT NOT NULL,
      key_expiry INTEGER NOT NULL, budget TEXT NOT NULL, created INTEGER NOT NULL)`);
    old.prepare("INSERT INTO bindings VALUES (?, ?, ?, ?, ?, ?, ?)").run("1", "0x1111111111111111111111111111111111111111", `t${"a".repeat(40)}`, `0x${"1".repeat(64)}`, 1_797_172_380, "10000", 1_794_580_440);
    old.close();
    // The constructor reads only the database path and the web app's origin; polling is off.
    for (let i = 0; i < 2; i++) {
      const bot = new RemoteTelegram({ dbPath: path, appUrl: "https://app.example.test", poll: false } as unknown as TelegramOptions);
      bot.stop();
    }
    const db = new DatabaseSync(path);
    const cols = (db.prepare("PRAGMA table_info(bindings)").all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ["tg_user", "vault", "home", "root", "key_expiry", "budget", "created", "ai_spent", "ai_messages"]);
    assert.deepEqual({ ...(db.prepare("SELECT budget, ai_spent, ai_messages FROM bindings WHERE tg_user = '1'").get() as object) }, { budget: "10000", ai_spent: 0, ai_messages: 0 });
    db.prepare("UPDATE bindings SET ai_spent = ai_spent + ?, ai_messages = ai_messages + 1 WHERE tg_user = ? AND home = ?").run(5_970n, "1", `t${"a".repeat(40)}`);
    assert.deepEqual({ ...(db.prepare("SELECT ai_spent, ai_messages FROM bindings").get() as object) }, { ai_spent: 5_970, ai_messages: 1 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
