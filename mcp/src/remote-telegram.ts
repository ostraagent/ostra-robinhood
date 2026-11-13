// Ostra Bot (Ostra Cloud stage A, design 13 Nov 2026): the remote gateway (remote.ts) as a Telegram bot. A Telegram
// user connects one vault through the web app, then talks with that vault's agent in a private chat; the agent is the
// same agent server the gateway runs for MCP sessions (a child per home, in its sandbox, its seed in the signer), and
// the model is Ostra AI's text task with tool calling, paid from the vault (the child's ostra_ai tool).
//
// Connecting. The Mini App (the web app's /tg page, opened from the bot) proves who the Telegram user is with its
// initData, signed by Telegram with the bot's token (HMAC-SHA-256, "WebAppData"; verifyInitData), and asks POST
// /tg/link for a one-time link to the web app's /connect page. That page, in the browser that holds the vault, shows
// which Telegram account asks, gets the agent key root this link hands out (POST /tg/connect/agent-key: a new key of
// the home of this Telegram user and this vault, telegramHomeId), signs the policy, the allowlist and the key with the
// owner's seed, and asks POST /tg/connect/complete: the chain must show the owner installed that very root
// (AgentKeySet since the root was handed out, the key in force now or waiting, that installation's expiry). Only then
// is the Telegram user bound to the vault, and told so in the chat. The link is the only secret of the page's calls
// (the gateway is on another site than the web app: no cookie can bind them); it lives LINK_SECONDS, extended while
// the page waits, never past LINK_MAX_SECONDS, and only the web app's origin may call these routes.
//
// A binding lives while its installation is the vault's agent key, named by the key's expiry (the agent's spends move
// the root on, never the expiry; as remote-auth.ts's grants): a later install (another connection, Telegram or a
// Claude app) or a revoke ends it, found at the next message or Mini App read. At most `quota` Telegram users are
// bound at once; a link whose key was handed out holds a place ISSUED_HOLD_SECONDS (anyone can ask a root for a
// vault that is not theirs: only the owner's install binds, so an unanswered one frees its place), and each user may
// have AGENT_KEYS_PER_DAY roots handed out a day. The next user is told the bot is full.
//
// Chatting. A message of a bound user runs one turn at a time per user: the home's child is started if it is not
// running (and kept KEEP after the turn), its tools are listed (the owner's tools, the agent key tools and Ostra AI's
// own are not offered: the owner's are answered with where the owner does them), and Ostra AI is asked with the
// conversation and the tools, its tool calls run in the child, up to MAX_STEPS model calls. The owner's per-message
// budget (USDG, set in the Mini App; `defaultBudget` until then) bounds what the model calls of one message may cost:
// each call's max_price is at most half of it, and what the calls cost (Ostra AI's `paid.cost`) is counted against
// it. The conversation is kept in memory only (HISTORY entries per home), never on disk.
//
// The bot reads its updates by long polling (getUpdates through the enclave's egress, Node's proxy support); the last
// update id taken is kept, so an update is handled at most once across restarts. The token is never logged.
//
// Everything kept is one SQLite file: links (the secret by its SHA-256), bindings, and the update offset.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAddress, isAddress, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { formatTokenAmount, parseTokenAmount } from "@ostraagent/core";
import { getLogsChunked, readV5, readVault, type Deployment } from "@ostraagent/sdk";
import { OWNER_TOOLS, REMOTE_REFUSED_TOOLS } from "./remote-auth.ts";

/** How old a Mini App's initData may be (s): a Mini App is opened again past it. */
export const MAX_INIT_AGE_SECONDS = 4 * 3_600;
const LINK_SECONDS = 1_800;
const LINK_MAX_SECONDS = 7_200;
/** Per vault, one agent key handed out per this many seconds (as for a Claude app's connection). */
const ISSUE_INTERVAL_SECONDS = 20;
/** Per Telegram user: a link at most every LINK_INTERVAL_SECONDS, at most LINKS_PER_DAY a day. */
const LINK_INTERVAL_SECONDS = 10;
const LINKS_PER_DAY = 30;
/** A link whose agent key was handed out holds a quota place this long (s) without the owner's install. */
const ISSUED_HOLD_SECONDS = 900;
/** Agent key roots handed out per Telegram user a day, at most. */
const AGENT_KEYS_PER_DAY = 10;
/** A vault's agent key as read from the chain is used this long (ms). */
const KEY_STATE_MS = 15_000;
const MAX_BODY = 16 * 1024;
/** Model calls per message at most; tool calls run per model call at most. */
export const MAX_STEPS = 6;
const MAX_CALLS_PER_STEP = 8;
/** The model's answer per call (tokens). */
const MAX_TOKENS = 1_500;
/** A model call below this max_price (base units) is not made: the budget is spent. */
const MIN_CALL_UNITS = 1_000n;
/** The per-message budget the owner may set (base units: 0.001 to 5 USDG). */
export const MIN_BUDGET_UNITS = 1_000n;
export const MAX_BUDGET_UNITS = 5_000_000n;
/** How long a model call and a tool call may take (ms): Ostra AI's own limit is 11 minutes. */
const AI_CALL_MS = 700_000;
const TOOL_CALL_MS = 120_000;
/** A tool's answer passed to the model at most (characters). */
const MAX_TOOL_CHARS = 8_000;
/** Conversation entries kept per home (user and assistant turns), each at most HISTORY_CHARS. */
const HISTORY = 20;
const HISTORY_CHARS = 4_000;
/** Telegram's limit on a message is 4096 characters; parts are cut a little shorter. */
export const MESSAGE_CHARS = 4_000;
/** Messages a user may send a minute (more are ignored, with one notice). */
const MESSAGES_PER_MINUTE = 20;
const POLL_TIMEOUT_SECONDS = 50;
const API_MS = 20_000;
const TOOLS_CACHE_MS = 600_000;
/** Ostra AI's own tools, never offered to the model of the chat (it is the model; videos are not sent to Telegram). */
const AI_TOOLS = new Set(["ostra_ai", "ostra_ai_job"]);
const AGENT_KEY_SET = parseAbiItem("event AgentKeySet(bytes32 indexed root, uint64 from, uint64 expiry)");
const SECURITY_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

const now = () => Math.floor(Date.now() / 1000);
const token = (bytes: number) => randomBytes(bytes).toString("base64url");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const LINK = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{32})$/;

export class TelegramHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type TelegramUser = { id: string; name: string; username: string | null };

/** Control characters and the like out of a name Telegram gave (shown on pages and in logs never). */
function cleanName(text: unknown, max: number): string {
  return typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, max) : "";
}

/**
 * The Telegram user a Mini App's initData names, once its hash is Telegram's (core.telegram.org/bots/webapps,
 * "Validating data received via the Mini App"): every field but `hash`, as `key=value` with the value decoded, sorted
 * by key and joined by newlines, HMAC-SHA-256 under the key HMAC-SHA-256("WebAppData", bot token). Refused: no or a
 * wrong hash, a field twice, no auth_date, one older than `maxAge` seconds or from the future, no user, a bot.
 */
export function verifyInitData(initData: unknown, botToken: string, at: number, maxAge = MAX_INIT_AGE_SECONDS): TelegramUser {
  const bad = (why: string) => new TelegramHttpError(401, "bad_init_data", why);
  if (typeof initData !== "string" || initData === "" || initData.length > 8_192) throw bad("the Mini App's initData is missing: open the Mini App from Ostra Bot");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (hash === null || !/^[0-9a-f]{64}$/.test(hash)) throw bad("the Mini App's initData has no hash");
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const [k, v] of params) {
    if (seen.has(k)) throw bad(`the Mini App's initData names ${k.slice(0, 32)} twice`);
    seen.add(k);
    if (k !== "hash") pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const want = createHmac("sha256", secret).update(pairs.map(([k, v]) => `${k}=${v}`).join("\n")).digest();
  if (!timingSafeEqual(want, Buffer.from(hash, "hex"))) throw bad("the Mini App's initData is not signed for this bot");
  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) throw bad("the Mini App's initData has no auth_date");
  if (at - authDate > maxAge) throw bad("the Mini App was opened too long ago: close it and open it again from Ostra Bot");
  if (authDate - at > 300) throw bad("the Mini App's initData is dated in the future");
  let user: Record<string, unknown>;
  try {
    user = JSON.parse(params.get("user") ?? "") as Record<string, unknown>;
  } catch {
    throw bad("the Mini App's initData names no user");
  }
  if (typeof user !== "object" || user === null || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) throw bad("the Mini App's initData names no user");
  if (user.is_bot === true) throw bad("a bot cannot connect a vault");
  const name = [cleanName(user.first_name, 64), cleanName(user.last_name, 64)].filter((s) => s !== "").join(" ").slice(0, 64);
  const username = typeof user.username === "string" && /^[A-Za-z0-9_]{1,64}$/.test(user.username) ? user.username : null;
  return { id: String(user.id), name: name === "" ? `user ${user.id}` : name, username };
}

/** The home of Telegram user `user` with vault `vault`: "t" and 40 hex digits, not telling either. */
export function telegramHomeId(key: Buffer, user: string, vault: Address): string {
  return `t${createHmac("sha256", key).update(`telegram\u0000${user}\u0000${getAddress(vault)}`).digest("hex").slice(0, 40)}`;
}

/** `text` in parts of at most `max` characters, cut at a paragraph, a line or a space when one is near, never inside a surrogate pair. */
export function splitMessage(text: string, max = MESSAGE_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = -1;
    for (const sep of ["\n\n", "\n", " "]) {
      const at = rest.lastIndexOf(sep, max);
      if (at >= max / 2) {
        cut = at;
        break;
      }
    }
    if (cut < 0) {
      cut = max;
      const c = rest.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
    }
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "") out.push(rest);
  return out.length === 0 ? ["(empty)"] : out;
}

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
export type ModelTool = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

/** The tools offered to the model: the child's, but the owner's, the agent key ones and Ostra AI's own, as OpenAI functions. */
export function toolsForModel(tools: readonly McpTool[]): ModelTool[] {
  return tools
    .filter((t) => typeof t.name === "string" && !OWNER_TOOLS.has(t.name) && !REMOTE_REFUSED_TOOLS.has(t.name) && !AI_TOOLS.has(t.name))
    .map((t) => {
      const { $schema: _schema, ...parameters } = (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;
      return { type: "function", function: { name: t.name, description: t.description ?? "", parameters } };
    });
}

/** A model call's max_price (base units): half of the message's budget, or what is left of it when less. */
export function callCap(budget: bigint, spent: bigint): bigint {
  const left = budget - spent;
  const half = budget / 2n;
  return left < half ? left : half;
}

type ToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
type AiMessage = { role: string; content: string | null; tool_calls?: ToolCall[] };
/** What one ostra_ai call came to: the model's message and what it cost (base units), or why there is none. */
export type AiOutcome = { ok: true; message: AiMessage; cost: bigint } | { ok: false; text: string; cost: bigint };

/** The text of an MCP tools/call answer (its text parts), and whether it is an error. */
function callText(m: JSONRPCMessage): { text: string; isError: boolean } {
  if ("error" in m) return { text: String((m.error as { message?: unknown }).message ?? "error"), isError: true };
  const r = (m as { result?: { isError?: boolean; content?: { type?: string; text?: string }[] } }).result ?? {};
  const text = (r.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n");
  return { text, isError: r.isError === true };
}

/** An ostra_ai tools/call answer read: `cap` is counted as its cost when the answer does not tell (a task that ran). */
export function readAiAnswer(m: JSONRPCMessage, cap: bigint): AiOutcome {
  const { text, isError } = callText(m);
  if (isError) return { ok: false, text: `Ostra AI was not asked: ${text.slice(0, 600)}`, cost: 0n };
  let r: { status?: unknown; answer?: unknown; note?: unknown };
  try {
    r = JSON.parse(text) as typeof r;
  } catch {
    return { ok: false, text: `Ostra AI's answer could not be read: ${text.slice(0, 300)}`, cost: cap };
  }
  const a = (r.answer ?? {}) as { error?: unknown; message?: unknown; paid?: { cost?: unknown }; reasons?: unknown };
  const costOf = (fallback: bigint) => (typeof a.paid?.cost === "string" && /^[0-9]{1,30}$/.test(a.paid.cost) ? BigInt(a.paid.cost) : fallback);
  if (r.status !== 200) {
    const why = typeof a.message === "string" ? a.message : typeof a.error === "string" ? a.error : JSON.stringify(r.answer ?? null);
    const reasons = Array.isArray(a.reasons) ? ` (${a.reasons.slice(0, 4).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ")})` : "";
    return { ok: false, text: `Ostra AI refused this message (${String(r.status)}): ${why.slice(0, 400)}${reasons.slice(0, 400)}`, cost: costOf(0n) };
  }
  if (typeof a.error === "string") return { ok: false, text: `Ostra AI's model failed on this message (${a.error}${typeof a.message === "string" ? `: ${a.message.slice(0, 300)}` : ""}). What it was charged stays the vault's credit with Ostra AI.`, cost: costOf(cap) };
  const msg = a.message as AiMessage | undefined;
  if (msg === undefined || typeof msg !== "object" || msg === null) return { ok: false, text: "Ostra AI's answer held no message", cost: costOf(cap) };
  return { ok: true, message: { role: "assistant", content: typeof msg.content === "string" ? msg.content : null, ...(Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? { tool_calls: msg.tool_calls } : {}) }, cost: costOf(cap) };
}

export function systemPrompt(vault: Address): string {
  return [
    `You are the Ostra agent of the vault ${vault} on Robinhood Chain, talking with the vault's owner in a private Telegram chat (Ostra Bot).`,
    "You act only through the tools you are given. Every spend you make is held on chain to the policy the owner set: the actions allowed, the most per spend and per day, the recipients allowed.",
    "Changing the policy, the allowlist or the agent key is the owner's alone, in the Ostra web app (app.ostraagent.xyz, the vault page's Agent tab): you cannot do it, so say where it is done.",
    "Never ask for, accept or repeat a seed phrase, a private key or a password.",
    "Before a spend, a trade or anything that cannot be undone, do it only when the owner asked for it in this chat, and say what you did with the transaction's hash when there is one.",
    "Answer briefly, in the owner's language, as plain text (Telegram shows no Markdown here).",
  ].join(" ");
}

export type AskChild = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<JSONRPCMessage>;

export type TelegramOptions = {
  /** The bot's token (BotFather). */
  token: string;
  /** The web app's origin: its /tg page is the Mini App, its /connect page connects, and only it calls /tg/*. */
  appUrl: string;
  dbPath: string;
  /** Telegram users bound at once, at most. */
  quota: number;
  /** A message's AI budget until its owner sets one (base units). */
  defaultBudget: bigint;
  /** Long polling on (off: the HTTP routes only). */
  poll: boolean;
  client: PublicClient;
  logsClient: PublicClient;
  deployment: Deployment;
  /** The key that names homes (remote.ts home-id.key). */
  homeKey: Buffer;
  /** A new agent key root from the home `home` of vault `vault` (remote.ts, under that home's lock). */
  issueAgentKey: (home: string, vault: Address) => Promise<{ root: Hex; index: string }>;
  /** Runs `fn` with the home's child (started if needed), kept while `fn` runs and a while after. */
  withHome: <T>(home: string, vault: Address, fn: (ask: AskChild) => Promise<T>) => Promise<T>;
  /** Ends the home's child if it runs. */
  endHome: (home: string, why: string) => Promise<void>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Text never shown or logged as it is (the RPC URLs, with their keys): an error's message is cleaned of it. */
  redact: readonly string[];
};

type LinkRow = { id: string; secret: string; tg_user: string; tg_name: string; tg_username: string | null; created: number; expires: number; status: string; vault: string | null; root: string | null; from_block: string | null; issued_at: number | null };
type Binding = { tg_user: string; vault: string; home: string; root: string; key_expiry: number; budget: string; created: number };
type Message = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new TelegramHttpError(415, "invalid_request", "application/json");
  const length = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY) throw new TelegramHttpError(413, "invalid_request", "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new TelegramHttpError(413, "invalid_request", "body too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new TelegramHttpError(400, "invalid_request", "the body is a JSON object");
  }
}

export class RemoteTelegram {
  readonly #o: TelegramOptions;
  readonly #db: DatabaseSync;
  readonly #miniApp: string;
  readonly #abort = new AbortController();
  /** Each vault's agent key as last read: root and expiry (0: none), when (ms). */
  readonly #keys = new Map<string, { at: number; root: string; expiry: number }>();
  /** The conversation of each home, in memory only. */
  readonly #history = new Map<string, Message[]>();
  /** Each home's tools as last listed (ms). */
  readonly #tools = new Map<string, { at: number; model: ModelTool[]; names: Set<string> }>();
  /** Users with a turn running. */
  readonly #busy = new Set<string>();
  /** Each user's messages of the last minute (ms), and whether they were told to slow down. */
  readonly #rate = new Map<string, { times: number[]; told: boolean }>();

  constructor(o: TelegramOptions) {
    this.#o = o;
    this.#miniApp = `${o.appUrl}/tg`;
    this.#db = new DatabaseSync(o.dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, secret TEXT NOT NULL, tg_user TEXT NOT NULL, tg_name TEXT NOT NULL, tg_username TEXT, created INTEGER NOT NULL,
        expires INTEGER NOT NULL, status TEXT NOT NULL, vault TEXT, root TEXT UNIQUE, from_block TEXT, issued_at INTEGER);
      CREATE INDEX IF NOT EXISTS links_user ON links (tg_user, status);
      CREATE INDEX IF NOT EXISTS links_vault ON links (vault, issued_at);
      CREATE TABLE IF NOT EXISTS bindings (tg_user TEXT PRIMARY KEY, vault TEXT NOT NULL, home TEXT NOT NULL, root TEXT NOT NULL,
        key_expiry INTEGER NOT NULL, budget TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  /** Starts the bot (its menu button, then long polling), unless polling is off. */
  start(): void {
    if (!this.#o.poll) return;
    void (async () => {
      try {
        const me = (await this.#api("getMe", {})) as { username?: string; id?: number };
        this.#o.log("telegram_bot", { username: me.username ?? null, id: me.id ?? null });
        await this.#api("setChatMenuButton", { menu_button: { type: "web_app", text: "Ostra", web_app: { url: this.#miniApp } } });
      } catch (err) {
        this.#o.log("telegram_setup_failed", { error: this.#safe(err) });
      }
      await this.#poll();
    })();
  }

  stop(): void {
    this.#abort.abort();
    this.#db.close();
  }

  // --- the Bot API ---------------------------------------------------------------------------------------------------

  /** An error's message with the token and the RPC URLs taken out (an error of fetch or viem names its URL), for the log. */
  #safe(err: unknown): string {
    let text = err instanceof Error ? err.message : String(err);
    text = text.split(this.#o.token).join("<token>");
    for (const r of this.#o.redact) if (r !== "") text = text.split(r).join("<rpc>");
    return text.slice(0, 300);
  }

  async #api(method: string, body: Record<string, unknown>, timeoutMs = API_MS): Promise<unknown> {
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(timeoutMs)]);
    const res = await fetch(`https://api.telegram.org/bot${this.#o.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const out = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as { ok?: boolean; result?: unknown; description?: string; error_code?: number };
    if (out.ok !== true) throw Object.assign(new Error(`${method}: ${String(out.description ?? res.status).slice(0, 200)}`), { code: out.error_code ?? res.status });
    return out.result;
  }

  #button(text = "Open Ostra"): Record<string, unknown> {
    return { inline_keyboard: [[{ text, web_app: { url: this.#miniApp } }]] };
  }

  async #send(chat: number | string, text: string, button = false): Promise<void> {
    // Polling off: the routes only, nothing sent to Telegram.
    if (!this.#o.poll) return;
    const parts = splitMessage(text);
    for (const [i, part] of parts.entries()) {
      await this.#api("sendMessage", { chat_id: chat, text: part, link_preview_options: { is_disabled: true }, ...(button && i === parts.length - 1 ? { reply_markup: this.#button() } : {}) }).catch((err: unknown) =>
        this.#o.log("telegram_send_failed", { error: this.#safe(err) }),
      );
    }
  }

  async #poll(): Promise<void> {
    let wait = 0;
    while (!this.#abort.signal.aborted) {
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (this.#abort.signal.aborted) return;
      const row = this.#db.prepare("SELECT v FROM state WHERE k = 'offset'").get() as { v: string } | undefined;
      const offset = row === undefined ? 0 : Number(row.v);
      let updates: { update_id: number; message?: Record<string, unknown> }[];
      try {
        updates = (await this.#api("getUpdates", { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ["message"] }, (POLL_TIMEOUT_SECONDS + 15) * 1000)) as typeof updates;
        wait = 0;
      } catch (err) {
        if (this.#abort.signal.aborted) return;
        const code = (err as { code?: unknown }).code;
        this.#o.log("telegram_poll_failed", { code: typeof code === "number" ? code : null, error: this.#safe(err) });
        // A wrong token stops the bot; another poller or a webhook (409) and network errors are waited out.
        if (code === 401 || code === 404) return;
        wait = code === 409 ? 30_000 : Math.min(60_000, Math.max(2_000, wait * 2));
        continue;
      }
      if (!Array.isArray(updates) || updates.length === 0) continue;
      const last = Math.max(...updates.map((u) => u.update_id));
      // Taken before they are handled: an update is handled at most once, even across a restart.
      this.#db.prepare("INSERT INTO state (k, v) VALUES ('offset', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(String(last + 1));
      for (const u of updates) if (u.message !== undefined) void this.#onMessage(u.message).catch((err: unknown) => this.#o.log("telegram_message_failed", { error: this.#safe(err) }));
    }
  }

  async #onMessage(m: Record<string, unknown>): Promise<void> {
    const chat = m.chat as { id?: unknown; type?: unknown } | undefined;
    const from = m.from as { id?: unknown; is_bot?: unknown } | undefined;
    if (chat?.type !== "private" || typeof chat.id !== "number" || typeof from?.id !== "number" || from.is_bot === true) return;
    const user = String(from.id);
    const r = this.#rate.get(user) ?? { times: [], told: false };
    const t = Date.now();
    r.times = r.times.filter((x) => t - x < 60_000);
    if (r.times.length >= MESSAGES_PER_MINUTE) {
      if (!r.told) await this.#send(chat.id, "Too many messages this minute: the next ones are read again in a minute.");
      r.told = true;
      this.#rate.set(user, r);
      return;
    }
    r.times.push(t);
    r.told = false;
    this.#rate.set(user, r);
    const text = typeof m.text === "string" ? m.text.trim() : null;
    if (text === null || text === "") return this.#send(chat.id, "Ostra Bot reads text messages only.");
    if (text === "/start" || text.startsWith("/start ") || text === "/help") {
      const b = this.#binding(user);
      return this.#send(
        chat.id,
        b === null
          ? "Ostra Bot runs your Ostra agent in Ostra Cloud, inside a TEE, and you talk with it here.\n\nOpen Ostra below: it shows the enclave's attestation, then connects your vault. The agent spends only within the policy you sign, and you stop it any time from the vault page."
          : `Your vault ${b.vault} is connected. Send a message to talk with its agent. Open Ostra to see the enclave's attestation, set the AI budget of a message, or disconnect.`,
        true,
      );
    }
    const b = this.#binding(user);
    if (b === null) return this.#send(chat.id, "Connect your vault first: open Ostra below.", true);
    if (this.#busy.has(user)) return this.#send(chat.id, "Still working on your previous message.");
    this.#busy.add(user);
    try {
      await this.#turn(b, chat.id, text);
    } finally {
      this.#busy.delete(user);
    }
  }

  // --- a chat turn ---------------------------------------------------------------------------------------------------

  async #turn(b: Binding, chat: number, text: string): Promise<void> {
    const typing = () => void this.#api("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
    typing();
    const timer = setInterval(typing, 4_500);
    try {
      if (!(await this.#lives(b))) {
        await this.#unbind(b, "key_replaced");
        return this.#send(chat, "This vault's agent key was replaced, revoked or has expired, so this chat is no longer connected to it. Open Ostra to connect again.", true);
      }
      const vault = getAddress(b.vault);
      const reply = await this.#o.withHome(b.home, vault, (ask) => this.#chat(ask, b, text));
      await this.#send(chat, reply);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      this.#o.log("telegram_turn_failed", { user: b.home, status: typeof status === "number" ? status : null, error: this.#safe(err) });
      // The user gets no error text (it may name a service's URL): the log has it, cleaned.
      await this.#send(chat, status === 503 || status === 429 ? "Ostra Cloud is busy right now. Send the message again shortly." : "The agent could not answer this message (an error in Ostra Cloud). Send it again shortly.");
    } finally {
      clearInterval(timer);
    }
  }

  async #modelTools(ask: AskChild, home: string): Promise<{ model: ModelTool[]; names: Set<string> }> {
    const c = this.#tools.get(home);
    if (c !== undefined && Date.now() - c.at < TOOLS_CACHE_MS) return c;
    const m = await ask("tools/list", {}, 30_000);
    if ("error" in m) throw new Error(`the agent's tools could not be listed: ${String((m.error as { message?: unknown }).message)}`);
    const model = toolsForModel(((m as { result?: { tools?: McpTool[] } }).result?.tools ?? []) as McpTool[]);
    const out = { at: Date.now(), model, names: new Set(model.map((t) => t.function.name)) };
    this.#tools.set(home, out);
    return out;
  }

  async #runTool(ask: AskChild, names: Set<string>, call: ToolCall): Promise<string> {
    const name = call.function?.name ?? "";
    if (OWNER_TOOLS.has(name)) return `${name} is the vault owner's to do, in the Ostra web app (app.ostraagent.xyz, the vault page's Agent tab). Nothing was changed.`;
    if (!names.has(name)) return `There is no tool ${name.slice(0, 64)} here.`;
    let args: unknown;
    try {
      args = JSON.parse(call.function?.arguments === undefined || call.function.arguments === "" ? "{}" : call.function.arguments);
    } catch {
      return `The arguments of ${name} are not JSON: nothing was run.`;
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) return `The arguments of ${name} are not a JSON object: nothing was run.`;
    const m = await ask("tools/call", { name, arguments: args }, TOOL_CALL_MS).catch((err: unknown) => ({ jsonrpc: "2.0", id: 0, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }) as JSONRPCMessage);
    const { text, isError } = callText(m);
    const out = isError ? `error: ${text}` : text;
    return out.length > MAX_TOOL_CHARS ? `${out.slice(0, MAX_TOOL_CHARS)}\n[cut: the answer was ${out.length} characters]` : out;
  }

  async #chat(ask: AskChild, b: Binding, text: string): Promise<string> {
    const vault = getAddress(b.vault);
    const tools = await this.#modelTools(ask, b.home);
    const history = this.#history.get(b.home) ?? [];
    const messages: Message[] = [{ role: "system", content: systemPrompt(vault) }, ...history, { role: "user", content: text }];
    const budget = BigInt(b.budget);
    let spent = 0n;
    let steps = 0;
    let final: string | null = null;
    let failed = false;
    let partial = "";
    while (final === null && steps < MAX_STEPS) {
      const cap = callCap(budget, spent);
      if (cap < MIN_CALL_UNITS) break;
      steps++;
      const m = await ask(
        "tools/call",
        { name: "ostra_ai", arguments: { task: "text", request: { messages, max_tokens: MAX_TOKENS, tools: tools.model, tool_choice: "auto" }, maxPrice: formatTokenAmount(cap) } },
        AI_CALL_MS,
      );
      const out = readAiAnswer(m, cap);
      spent += out.cost;
      if (!out.ok) {
        final = out.text;
        failed = true;
        break;
      }
      const calls = out.message.tool_calls ?? [];
      if (out.message.content !== null && out.message.content.trim() !== "") partial = out.message.content.trim();
      if (calls.length === 0) {
        final = out.message.content?.trim() || "(the model gave no answer)";
        break;
      }
      const ids = calls.map((c, i) => (typeof c.id === "string" && c.id !== "" ? c.id : `call_${steps}_${i}`));
      messages.push({ role: "assistant", content: out.message.content ?? "", tool_calls: calls.map((c, i) => ({ ...c, id: ids[i] as string, type: "function" })) });
      for (const [i, c] of calls.entries()) {
        const content = i < MAX_CALLS_PER_STEP ? await this.#runTool(ask, tools.names, c) : "Not run: too many tool calls at once.";
        messages.push({ role: "tool", tool_call_id: ids[i] as string, content });
      }
    }
    if (final === null)
      final =
        steps >= MAX_STEPS
          ? `${partial === "" ? "" : `${partial}\n\n`}Stopped after ${MAX_STEPS} steps of the model for this message. Ask again to go on.`
          : `${partial === "" ? "" : `${partial}\n\n`}This message's AI budget (${formatTokenAmount(budget)} USDG) is spent. Raise it in Ostra (the Mini App) to let the agent do more per message.`;
    // A message Ostra AI did not answer is not kept: the conversation holds what the model said only. Nor one whose
    // binding ended meanwhile (unlinked, connected again): its conversation was dropped with it.
    if (!failed && this.#binding(b.tg_user)?.home === b.home) {
      const keep = [...history, { role: "user", content: text.slice(0, HISTORY_CHARS) }, { role: "assistant", content: final.slice(0, HISTORY_CHARS) }];
      this.#history.set(b.home, keep.slice(-HISTORY));
    }
    return `${final}\n\nAI cost: ${formatTokenAmount(spent)} USDG`;
  }

  // --- bindings and the chain ----------------------------------------------------------------------------------------

  #binding(user: string): Binding | null {
    return (this.#db.prepare("SELECT * FROM bindings WHERE tg_user = ?").get(user) as Binding | undefined) ?? null;
  }

  /** The vault's agent key as the chain has it now (cached KEY_STATE_MS unless `fresh`). */
  async #key(vault: Address, fresh = false): Promise<{ root: string; expiry: number }> {
    const c = this.#keys.get(vault);
    if (c !== undefined && !fresh && Date.now() - c.at < KEY_STATE_MS) return c;
    const v5 = await readV5(this.#o.client, vault);
    const root = v5 === null ? "0x" : v5.agentKey.root.toLowerCase();
    const k = { at: Date.now(), root, expiry: v5 === null || BigInt(v5.agentKey.root) === 0n ? 0 : Number(v5.agentKey.expiry) };
    this.#keys.set(vault, k);
    return k;
  }

  /**
   * Whether binding `b` lives: its installation is the vault's agent key, not expired. The installation is named by
   * its expiry: every spend of the agent moves the root on (OstraVaultModuleV5), never the expiry; a revoke zeroes it.
   */
  async #lives(b: Binding, fresh = false): Promise<boolean> {
    if (b.key_expiry <= now()) return false;
    const k = await this.#key(getAddress(b.vault), fresh);
    return k.expiry !== 0 && k.expiry === b.key_expiry;
  }

  async #unbind(b: Binding, why: string): Promise<void> {
    this.#db.prepare("DELETE FROM bindings WHERE tg_user = ? AND home = ?").run(b.tg_user, b.home);
    this.#history.delete(b.home);
    this.#tools.delete(b.home);
    this.#o.log("telegram_unbound", { user: b.home, why });
    await this.#o.endHome(b.home, why).catch(() => {});
  }

  /**
   * The places taken: bindings that live (dead ones found here are dropped), and the Telegram users not bound whose
   * link's key was handed out less than ISSUED_HOLD_SECONDS ago. `except`'s own place is not counted.
   */
  async #placesTaken(except: string): Promise<number> {
    const all = this.#db.prepare("SELECT * FROM bindings").all() as Binding[];
    let n = 0;
    for (const b of all) {
      if (b.tg_user === except) continue;
      let live = true;
      try {
        live = await this.#lives(b);
      } catch {
        // unknown: it keeps its place
      }
      if (live) n++;
      else await this.#unbind(b, "key_replaced");
    }
    const t = now();
    const held = this.#db
      .prepare("SELECT COUNT(DISTINCT tg_user) AS n FROM links WHERE status IN ('issuing', 'issued') AND expires > ? AND issued_at > ? AND tg_user != ? AND tg_user NOT IN (SELECT tg_user FROM bindings)")
      .get(t, t - ISSUED_HOLD_SECONDS, except) as { n: number };
    return n + held.n;
  }

  // --- HTTP ----------------------------------------------------------------------------------------------------------

  /** Answers the request if it is one of /tg/*; false otherwise. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
    if (!path.startsWith("/tg/")) return false;
    // The web app's pages only: the origin is checked here (CORS only keeps other pages from reading the answer).
    if (req.headers.origin !== this.#o.appUrl) {
      json(res, 403, { error: "origin_not_allowed" });
      return true;
    }
    const cors = { "access-control-allow-origin": this.#o.appUrl, vary: "origin" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      res.end();
      return true;
    }
    try {
      let body: unknown;
      if (path === "/tg/me" && req.method === "POST") body = await this.#me(await readJson(req));
      else if (path === "/tg/link" && req.method === "POST") body = await this.#link(await readJson(req));
      else if (path === "/tg/budget" && req.method === "POST") body = await this.#budget(await readJson(req));
      else if (path === "/tg/unlink" && req.method === "POST") body = await this.#unlinkCall(await readJson(req));
      else if (path === "/tg/connect/request" && req.method === "GET") body = this.#connectInfo(url.searchParams.get("link"));
      else if (path === "/tg/connect/agent-key" && req.method === "POST") body = await this.#connectAgentKey(await readJson(req));
      else if (path === "/tg/connect/complete" && req.method === "POST") body = await this.#connectComplete(await readJson(req));
      else if (path === "/tg/connect/extend" && req.method === "POST") body = this.#connectExtend(await readJson(req));
      else if (path === "/tg/connect/cancel" && req.method === "POST") body = this.#connectCancel(await readJson(req));
      else throw new TelegramHttpError(404, "not_found", "no such route");
      json(res, 200, body, cors);
    } catch (err) {
      if (err instanceof TelegramHttpError) json(res, err.status, { error: err.code, error_description: err.message }, cors);
      else {
        this.#o.log("telegram_http_failed", { path, error: this.#safe(err) });
        if (!res.headersSent) json(res, 500, { error: "server_error" }, cors);
      }
    }
    return true;
  }

  #user(b: Record<string, unknown>): TelegramUser {
    return verifyInitData(b.initData, this.#o.token, now());
  }

  async #me(b: Record<string, unknown>): Promise<unknown> {
    const u = this.#user(b);
    let bound = this.#binding(u.id);
    if (bound !== null && !(await this.#lives(bound, true))) {
      await this.#unbind(bound, "key_replaced");
      bound = null;
    }
    const taken = (await this.#placesTaken(u.id)) + (bound === null ? 0 : 1);
    return {
      user: { id: u.id, name: u.name, username: u.username },
      bound: bound === null ? null : { vault: getAddress(bound.vault), keyExpiresAt: new Date(bound.key_expiry * 1000).toISOString(), budget: formatTokenAmount(BigInt(bound.budget)), since: new Date(bound.created * 1000).toISOString() },
      quota: { taken, max: this.#o.quota },
      defaultBudget: formatTokenAmount(this.#o.defaultBudget),
    };
  }

  async #link(b: Record<string, unknown>): Promise<unknown> {
    const u = this.#user(b);
    const t = now();
    const last = this.#db.prepare("SELECT MAX(created) AS t, SUM(CASE WHEN created > ? THEN 1 ELSE 0 END) AS day FROM links WHERE tg_user = ?").get(t - 86_400, u.id) as { t: number | null; day: number | null };
    if (last.t !== null && t - last.t < LINK_INTERVAL_SECONDS) throw new TelegramHttpError(429, "slow_down", `one link per ${LINK_INTERVAL_SECONDS} s: try again shortly`);
    if ((last.day ?? 0) >= LINKS_PER_DAY) throw new TelegramHttpError(429, "slow_down", `${LINKS_PER_DAY} links were made today: try again tomorrow`);
    if (this.#binding(u.id) === null && (await this.#placesTaken(u.id)) >= this.#o.quota) throw new TelegramHttpError(403, "quota_full", `Ostra Cloud serves ${this.#o.quota} agents for now and all places are taken: try again later`);
    // One open link per user: the ones not yet answered end (a link whose key is being signed goes on).
    this.#db.prepare("UPDATE links SET status = 'cancelled' WHERE tg_user = ? AND status = 'open'").run(u.id);
    const id = token(12);
    const secret = token(24);
    this.#db.prepare("INSERT INTO links (id, secret, tg_user, tg_name, tg_username, created, expires, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')").run(id, sha(secret), u.id, u.name, u.username, t, t + LINK_SECONDS);
    this.#o.log("telegram_link", { link: id });
    return { link: `${this.#o.appUrl}/connect?tg=${id}.${secret}`, expiresAt: new Date((t + LINK_SECONDS) * 1000).toISOString() };
  }

  async #budget(b: Record<string, unknown>): Promise<unknown> {
    const u = this.#user(b);
    const bound = this.#binding(u.id);
    if (bound === null) throw new TelegramHttpError(409, "not_connected", "connect a vault first");
    let units: bigint;
    try {
      units = parseTokenAmount(String(b.budget ?? ""));
    } catch {
      throw new TelegramHttpError(400, "invalid_request", "budget: USDG, at most 6 decimals");
    }
    if (units < MIN_BUDGET_UNITS || units > MAX_BUDGET_UNITS) throw new TelegramHttpError(400, "invalid_request", `budget: from ${formatTokenAmount(MIN_BUDGET_UNITS)} to ${formatTokenAmount(MAX_BUDGET_UNITS)} USDG a message`);
    this.#db.prepare("UPDATE bindings SET budget = ? WHERE tg_user = ?").run(units.toString(), u.id);
    return { budget: formatTokenAmount(units) };
  }

  async #unlinkCall(b: Record<string, unknown>): Promise<unknown> {
    const u = this.#user(b);
    const bound = this.#binding(u.id);
    if (bound !== null) await this.#unbind(bound, "unlinked");
    return { unlinked: bound !== null };
  }

  /** The link `text` names (`id.secret`), its secret checked. */
  #linkRow(text: unknown): LinkRow {
    const m = typeof text === "string" ? LINK.exec(text) : null;
    if (m === null) throw new TelegramHttpError(400, "invalid_request", "link");
    const row = this.#db.prepare("SELECT * FROM links WHERE id = ?").get(m[1] as string) as LinkRow | undefined;
    // Unknown, or the secret wrong: the same answer.
    if (row === undefined || !timingSafeEqual(Buffer.from(sha(m[2] as string), "hex"), Buffer.from(row.secret, "hex"))) throw new TelegramHttpError(404, "unknown_link", "this link is not known: open Ostra in Telegram and connect again");
    if (row.expires <= now() && row.status !== "done") throw new TelegramHttpError(410, "expired", "this link has expired: open Ostra in Telegram and connect again");
    return row;
  }

  /**
   * Who a link is for, as Telegram vouched (initData): the account's id and username, which nobody else can have, and
   * its name, which the account chose (the page shows it as such: a name can look like another account's).
   */
  #telegramOf(r: LinkRow): { id: string; username: string | null; name: string } {
    return { id: r.tg_user, username: r.tg_username, name: r.tg_name };
  }

  #connectInfo(link: string | null): unknown {
    const r = this.#linkRow(link);
    return { telegram: this.#telegramOf(r), status: r.status, vault: r.vault, root: r.root, createdAt: new Date(r.created * 1000).toISOString(), expiresAt: new Date(r.expires * 1000).toISOString() };
  }

  async #connectAgentKey(b: Record<string, unknown>): Promise<unknown> {
    const r = this.#linkRow(b.link);
    if (typeof b.vault !== "string" || !isAddress(b.vault, { strict: false })) throw new TelegramHttpError(400, "invalid_request", "vault");
    const vault = getAddress(b.vault);
    if (r.status === "issued" && r.vault === vault && r.root !== null) return { root: r.root, vault, maxDays: 90, reused: true };
    if (r.status !== "open") throw new TelegramHttpError(409, "conflict", `this link is ${r.status}`);
    const bound = this.#binding(r.tg_user);
    if ((bound === null || getAddress(bound.vault) !== vault) && (await this.#placesTaken(r.tg_user)) >= this.#o.quota)
      throw new TelegramHttpError(403, "quota_full", `Ostra Cloud serves ${this.#o.quota} agents for now and all places are taken: try again later`);
    if ((await readVault(this.#o.client, this.#o.deployment, vault)) === null) throw new TelegramHttpError(400, "invalid_request", "this address is not an Ostra vault of this deployment");
    if ((await readV5(this.#o.client, vault)) === null) throw new TelegramHttpError(400, "invalid_request", "this vault does not run version 5");
    const t = now();
    const mine = this.#db.prepare("SELECT COUNT(*) AS n FROM links WHERE tg_user = ? AND issued_at > ?").get(r.tg_user, t - 86_400) as { n: number };
    if (mine.n >= AGENT_KEYS_PER_DAY) throw new TelegramHttpError(429, "slow_down", `${AGENT_KEYS_PER_DAY} agent keys were handed out to this Telegram account today: try again tomorrow`);
    const last = this.#db.prepare("SELECT MAX(issued_at) AS t FROM links WHERE vault = ?").get(vault) as { t: number | null };
    if (last.t !== null && t - last.t < ISSUE_INTERVAL_SECONDS) throw new TelegramHttpError(429, "slow_down", `one agent key per ${ISSUE_INTERVAL_SECONDS} s for a vault: try again shortly`);
    const claimed = this.#db.prepare("UPDATE links SET status = 'issuing', vault = ?, issued_at = ? WHERE id = ? AND status = 'open'").run(vault, t, r.id);
    if (claimed.changes !== 1) throw new TelegramHttpError(409, "conflict", "this link is being answered already");
    let key: { root: Hex; index: string };
    let fromBlock: bigint;
    try {
      fromBlock = await this.#o.logsClient.getBlockNumber({ cacheTime: 0 });
      key = await this.#o.issueAgentKey(telegramHomeId(this.#o.homeKey, r.tg_user, vault), vault);
      if (!/^0x[0-9a-fA-F]{64}$/.test(key.root)) throw new Error("the home gave no root");
    } catch (err) {
      // The index taken (if any) is not handed out again: issued_at stays, for the vault's interval.
      this.#db.prepare("UPDATE links SET status = 'failed' WHERE id = ? AND status = 'issuing'").run(r.id);
      const status = (err as { status?: unknown }).status;
      if (status === 503 || status === 429 || status === 409) throw new TelegramHttpError(status, "unavailable", this.#safe(err));
      throw err;
    }
    const issued = this.#db
      .prepare("UPDATE links SET status = 'issued', root = ?, from_block = ?, expires = MAX(expires, ?) WHERE id = ? AND status = 'issuing'")
      .run(key.root.toLowerCase(), fromBlock.toString(), Math.min(now() + LINK_SECONDS, r.created + LINK_MAX_SECONDS), r.id);
    if (issued.changes !== 1) throw new TelegramHttpError(409, "conflict", "this link was cancelled");
    this.#o.log("telegram_key_issued", { link: r.id, index: key.index });
    return { root: key.root, vault, maxDays: 90 };
  }

  async #connectComplete(b: Record<string, unknown>): Promise<unknown> {
    const r = this.#linkRow(b.link);
    if (r.status === "done" && r.vault !== null) return { done: true, vault: getAddress(r.vault), telegram: this.#telegramOf(r), again: true };
    if (r.status !== "issued" || r.vault === null || r.root === null || r.from_block === null) throw new TelegramHttpError(409, "conflict", `this link is ${r.status}`);
    const vault = getAddress(r.vault);
    // The owner installed this link's root after it was handed out (its AgentKeySet), and that installation is the
    // vault's agent key now (in force or waiting the lock's delay), not revoked nor replaced since.
    const tip = await this.#o.logsClient.getBlockNumber({ cacheTime: 0 });
    const sets = await getLogsChunked(this.#o.logsClient, { address: vault, event: AGENT_KEY_SET, args: { root: r.root as Hex }, fromBlock: BigInt(r.from_block), toBlock: tip });
    const set = sets.at(-1);
    if (set === undefined) throw new TelegramHttpError(409, "not_installed", "the vault's owner has not installed this link's agent key yet");
    const keyExpiry = Number((set as unknown as { args: { expiry: bigint } }).args.expiry);
    const k = await this.#key(vault, true);
    if (k.expiry === 0 || k.expiry !== keyExpiry) throw new TelegramHttpError(409, "not_in_force", "this link's agent key was installed, then revoked or replaced: connect again from Ostra in Telegram");
    // A place held past ISSUED_HOLD_SECONDS was let go: taken again only if one is free (the owner's install stays, and
    // complete can be asked again while the link lives).
    const boundNow = this.#binding(r.tg_user);
    if (boundNow === null && r.issued_at !== null && now() - r.issued_at >= ISSUED_HOLD_SECONDS && (await this.#placesTaken(r.tg_user)) >= this.#o.quota)
      throw new TelegramHttpError(403, "quota_full", `Ostra Cloud serves ${this.#o.quota} agents for now and all places are taken: press Connect again later, the key you installed stays`);
    const done = this.#db.prepare("UPDATE links SET status = 'done' WHERE id = ? AND status = 'issued'").run(r.id);
    if (done.changes !== 1) throw new TelegramHttpError(409, "conflict", "this link is done already");
    const home = telegramHomeId(this.#o.homeKey, r.tg_user, vault);
    const before = this.#binding(r.tg_user);
    if (before !== null && before.home !== home) await this.#unbind(before, "vault_changed");
    const budget = before?.budget ?? this.#o.defaultBudget.toString();
    this.#db
      .prepare(
        "INSERT INTO bindings (tg_user, vault, home, root, key_expiry, budget, created) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tg_user) DO UPDATE SET vault = excluded.vault, home = excluded.home, root = excluded.root, key_expiry = excluded.key_expiry, created = excluded.created",
      )
      .run(r.tg_user, vault, home, r.root, keyExpiry, budget, now());
    // Another Telegram user bound to this vault before: its key was replaced by this one.
    for (const other of this.#db.prepare("SELECT * FROM bindings WHERE vault = ? AND tg_user != ?").all(vault, r.tg_user) as Binding[]) await this.#unbind(other, "key_replaced");
    this.#o.log("telegram_bound", { link: r.id, user: home });
    void this.#send(r.tg_user, `Connected: your vault ${vault} now has an agent in Ostra Cloud. Send a message to talk with it.`);
    return { done: true, vault, telegram: this.#telegramOf(r) };
  }

  #connectExtend(b: Record<string, unknown>): unknown {
    const r = this.#linkRow(b.link);
    if (r.status !== "open" && r.status !== "issued") throw new TelegramHttpError(409, "conflict", `this link is ${r.status}`);
    const until = Math.min(now() + LINK_SECONDS, r.created + LINK_MAX_SECONDS);
    this.#db.prepare("UPDATE links SET expires = ? WHERE id = ? AND status IN ('open', 'issued') AND expires < ?").run(until, r.id, until);
    return { expiresAt: new Date(Math.max(until, r.expires) * 1000).toISOString() };
  }

  #connectCancel(b: Record<string, unknown>): unknown {
    const r = this.#linkRow(b.link);
    if (r.status === "done") throw new TelegramHttpError(409, "conflict", "this link is done");
    this.#db.prepare("UPDATE links SET status = 'cancelled' WHERE id = ? AND status != 'done'").run(r.id);
    return { cancelled: true };
  }
}
