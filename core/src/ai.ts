// Ostra AI: text, image and video tasks at the gateway (config.aiUrl), paid
// with `pay` (pay.ts) from the agent's vault: an x402 batch-settlement channel
// of the vault to the gateway's Ostra vault, opened when needed, its unused
// deposit back to the vault when it closes. A task names its parameters and a
// max_price, never a model: the gateway chooses the model by its quality
// rating within max_price. The vault is named as the task's payer, so what a
// task did not cost (the gateway keeps it as the vault's credit) pays part of
// the next one. Nothing here depends on Node.
//
//   text   POST /v1/ai/text   { messages, max_tokens, quality?, privacy?, temperature?, ... }: asked as a stream
//          (the gateway's keep-alives hold the connection open however long the model takes; a plain answer
//          slower than Cloudflare's 100 s would be cut) and put together here into one answer
//   image  POST /v1/ai/image  { prompt, n?, quality?, aspect_ratio?, resolution?, ... }: the images inline (base64)
//   video  POST /v1/ai/video  { prompt, duration, quality?, resolution?, ... }: a job, read with job()
//   GET /v1/ai/video/<job>, /v1/ai/video/<job>/content, /v1/ai/credits/<payer> need no payment.

import { getAddress } from "viem";
import { parseTokenAmount } from "./amount.ts";
import type { Config } from "./config.ts";
import type { PayService } from "./pay.ts";
import type { VaultService } from "./vault.ts";

export const AI_TASK_KINDS = ["text", "image", "video"] as const;
export type AiTaskKind = (typeof AI_TASK_KINDS)[number];

/** The longest answer read: an image task answers its images inline, in base64. */
export const AI_MAX_BODY_CHARS = 48 * 1024 * 1024;
/** Request fields ostra_ai sets itself. */
const SET_HERE = ["task", "max_price", "payer", "stream"] as const;
const REQUEST_TIMEOUT_MS = 60_000;
/** A paid task may take this long, its answer read to the end (the gateway allows the upstream 10 minutes). */
const TASK_TIMEOUT_MS = 660_000;
/** An answer that is neither JSON nor a stream is returned cut to this. */
const RAW_ANSWER_CHARS = 4_000;

type ToolCall = { id?: string; type: string; function: { name: string; arguments: string } };

/**
 * A text task's stream (server-sent events: `data: {chunk}`, keep-alive comments, `event: ostra` with the task, the
 * model, usage and `paid`, then `data: [DONE]`) as one answer, in the shape of a plain text answer.
 */
export function textStreamAnswer(sse: string): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  const calls: ToolCall[] = [];
  let closing: Record<string, unknown> | null = null;
  let finish: unknown = null;
  for (const event of sse.split(/\r?\n\r?\n/)) {
    const lines = event.split(/\r?\n/).filter((l) => l !== "" && !l.startsWith(":"));
    if (lines.length === 0) continue;
    const named = lines[0]?.startsWith("event: ") ? lines[0].slice("event: ".length) : null;
    const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice("data: ".length)).join("\n");
    if (data === "" || data === "[DONE]") continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (named === "ostra" || json.object === "ostra.task") {
      closing = json;
      continue;
    }
    const choice = (json.choices as { delta?: Record<string, unknown>; finish_reason?: unknown }[] | undefined)?.[0];
    if (choice === undefined) continue;
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish = choice.finish_reason;
    const d = choice.delta ?? {};
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning === "string") reasoning += d.reasoning;
    for (const tc of (d.tool_calls as { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[] | undefined) ?? []) {
      const i = typeof tc.index === "number" ? tc.index : 0;
      const cur = calls[i] ?? (calls[i] = { type: "function", function: { name: "", arguments: "" } });
      if (typeof tc.id === "string") cur.id = tc.id;
      if (typeof tc.type === "string") cur.type = tc.type;
      if (typeof tc.function?.name === "string") cur.function.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") cur.function.arguments += tc.function.arguments;
    }
  }
  const message = { role: "assistant", content, reasoning: reasoning === "" ? null : reasoning, ...(calls.length === 0 ? {} : { tool_calls: calls.filter((c) => c !== undefined) }) };
  if (closing === null) return { error: "stream_incomplete", message: "the answer's stream ended before what it was charged was told", partial: message };
  const { object: _object, ...rest } = closing;
  // The model's stream failed after it began: the closing event says so (error, message), and what the task was charged
  // is the payer's credit; what came before the failure is kept as `partial`.
  if (typeof rest.error === "string") return { ...rest, partial: message };
  return { ...rest, message, finish_reason: rest.finish_reason ?? finish };
}

export type AiTaskResult = {
  /** The gateway's answer: 200 (done, or a video job started), 4xx when refused (nothing paid unless `paid` says so). */
  status: number;
  /** What this task paid from the channel (USDG), or null when nothing was asked. */
  paid: string | null;
  channel: string | null;
  /** The channel's unused deposit after this task. */
  channelLeft: string | null;
  /** The gateway's answer: the result, what it charged, cost and credited (`paid`), or why it refused. */
  answer: unknown;
  note?: string;
};

export class AiService {
  readonly #url: string;
  readonly #payments: PayService;
  readonly #vault: VaultService;

  constructor(config: Config, payments: PayService, vault: VaultService) {
    if (config.aiUrl === null) throw new Error("Ostra AI is not configured here (OSTRA_AI_URL)");
    this.#url = config.aiUrl.replace(/\/+$/, "");
    this.#payments = payments;
    this.#vault = vault;
  }

  /** Runs a `kind` task with `request`'s parameters, paying at most `maxPrice` USDG from a channel of the vault. */
  async task(kind: AiTaskKind, request: Record<string, unknown>, maxPrice: string, deposit?: string): Promise<AiTaskResult> {
    if (!AI_TASK_KINDS.includes(kind)) throw new RangeError(`the task is one of ${AI_TASK_KINDS.join(", ")}`);
    for (const key of SET_HERE) if (key in request) throw new RangeError(`${key} is set by ostra_ai: leave it out of request`);
    const units = parseTokenAmount(maxPrice);
    if (units <= 0n) throw new RangeError("maxPrice must be positive");
    const payer = getAddress(await this.#vault.vaultAddress());
    const body = JSON.stringify({ ...request, task: kind, max_price: units.toString(), payer, ...(kind === "text" ? { stream: true } : {}) });
    const r = await this.#payments.pay({
      url: `${this.#url}/v1/ai/${kind}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      maxPrice,
      maxBodyChars: AI_MAX_BODY_CHARS,
      timeoutMs: TASK_TIMEOUT_MS,
      ...(deposit === undefined ? {} : { deposit }),
    });
    let answer: unknown;
    const head = r.body.trimStart();
    if (r.status === 200 && kind === "text" && (head.startsWith("data:") || head.startsWith(":") || head.startsWith("event:"))) answer = textStreamAnswer(r.body);
    else {
      try {
        answer = JSON.parse(r.body);
      } catch {
        answer = r.body.slice(0, RAW_ANSWER_CHARS);
      }
    }
    const failed = answer !== null && typeof answer === "object" && typeof (answer as { error?: unknown }).error === "string";
    const notes = [r.note, r.truncated ? "the answer was longer than ostra_ai reads and was cut" : undefined, r.status === 200 && failed ? "the task failed after it began (answer.error): what it was charged is the vault's credit with Ostra AI" : undefined].filter((x): x is string => x !== undefined);
    return { status: r.status, paid: r.paid, channel: r.channel, channelLeft: r.channelLeft, answer, ...(notes.length === 0 ? {} : { note: notes.join("; ") }) };
  }

  /** A video job's status; the first final one settles its cost and credits the rest. */
  async job(id: string): Promise<{ status: number; answer: unknown }> {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new RangeError("job is the 32 hex characters ostra_ai gave");
    const res = await fetch(`${this.#url}/v1/ai/video/${id}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    try {
      return { status: res.status, answer: JSON.parse(text) };
    } catch {
      return { status: res.status, answer: text.slice(0, 2_000) };
    }
  }

  /** Where a finished video job's content is read (no payment). */
  contentUrl(id: string): string {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new RangeError("job is the 32 hex characters ostra_ai gave");
    return `${this.#url}/v1/ai/video/${id}/content`;
  }

  /** The vault's credit with Ostra AI (USDG base units). */
  async credit(): Promise<unknown> {
    const payer = getAddress(await this.#vault.vaultAddress());
    const res = await fetch(`${this.#url}/v1/ai/credits/${payer}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Ostra AI answered ${res.status} for the vault's credit`);
    return res.json();
  }
}
