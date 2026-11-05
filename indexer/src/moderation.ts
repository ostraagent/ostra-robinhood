// Ostrapad's content rules in the index (design "Ostrapad", decided by Edu on 30 Oct 2026): each listing is checked
// once by a model behind an OpenAI-compatible API, and checked again only when what it lists changes; a listing found
// to sell prohibited work is left out of the listings (MCP's pad_search) and the board, its reason kept with the
// agent. Several APIs can be configured, asked in order: when one gives no answer, the next is asked (sdk
// failover.ts). The rules and the answer's shape: sdk pad-rules.ts.

import { sha256, stringToHex, type Hex } from "viem";
import { FAILOVER_COOLDOWN_MS, PAD_MODERATION_PROMPT, failover, numberedSettings, parsePadModeration, type PadModeration, type PadModerationInput } from "@ostraagent/sdk";

/**
 * A listing's verdict; null when the model answered with something that is not a verdict (a paid call); "unreached"
 * when no answer came (no response, or an error status: not paid). The listing is checked again later.
 */
export type Moderator = (listing: PadModerationInput) => Promise<PadModeration | null | "unreached">;

/** What a listing's check depends on: its name, description and offers. A change of any of them checks it again. */
export function moderationKey(l: Omit<PadModerationInput, "agentId">): Hex {
  return sha256(stringToHex(JSON.stringify({ name: l.name, description: l.description, offers: l.offers.map((o) => ({ id: o.id, title: o.title, description: o.description, input: o.input, price: o.price })) })));
}

/** Why a model's provider refused a request rather than answer it (finish_reason "content_filter", or a refusal and no content), or null. */
export function providerRefusal(body: unknown): string | null {
  const choice = (body as { choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }[] } | null)?.choices?.[0];
  if (choice === undefined) return null;
  const refusal = choice.message?.refusal;
  if (choice.finish_reason === "content_filter") return typeof refusal === "string" && refusal !== "" ? refusal.slice(0, 300) : "content_filter";
  if (typeof choice.message?.content !== "string" && typeof refusal === "string" && refusal !== "") return refusal.slice(0, 300);
  return null;
}

/** The verdict when every model the moderator may ask refused the listing under its provider's usage policy. */
export const REFUSED_LISTING: PadModeration = { prohibited: true, category: null, reason: "The checking models' providers refused to read this listing under their usage policies, which Ostrapad's content rules treat as prohibited work." };

/**
 * A moderator behind POST <url>/chat/completions at temperature 0; an answer of another shape is null, no answer (no
 * response, an error status) "unreached". When the model's provider refuses the request under its usage policy (seen
 * on 31 Oct 2026 for anthropic/claude-sonnet-5.5 on phishing content), `fallbackModel` (another provider's, on the same
 * API) is asked; if that one refuses too, or there is none, the listing is prohibited (REFUSED_LISTING); if it gives no
 * answer, the result is null (the refusal was a paid call). It runs
 * inside the index's pass: 20 seconds at most a call, 5 listings a pass.
 */
export function openAiModerator(o: { url: string; model: string; apiKey: string; fallbackModel?: string; fetch?: typeof fetch; timeoutMs?: number }): Moderator {
  const f = o.fetch ?? fetch;
  const once = async (model: string, listing: PadModerationInput): Promise<PadModeration | null | "unreached" | "refused"> => {
    let res: Response;
    try {
      res = await f(`${o.url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 800,
          messages: [
            { role: "system", content: PAD_MODERATION_PROMPT },
            { role: "user", content: JSON.stringify(listing) },
          ],
        }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      });
    } catch {
      return "unreached";
    }
    if (!res.ok) return "unreached";
    try {
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      if (providerRefusal(body) !== null) return "refused";
      const text = body.choices?.[0]?.message?.content;
      return typeof text === "string" ? parsePadModeration(text) : null;
    } catch {
      return null;
    }
  };
  return async (listing) => {
    const first = await once(o.model, listing);
    if (first !== "refused") return first;
    if (o.fallbackModel === undefined) return REFUSED_LISTING;
    const second = await once(o.fallbackModel, listing);
    // The first model answered (a refusal is a paid call): no answer from the fallback leaves an answer of another
    // shape (null), checked again later on this API, never passed on to another one.
    return second === "refused" ? REFUSED_LISTING : second === "unreached" ? null : second;
  };
}

/** One API the moderator may ask: its base URL, model, key and, optionally, a fallback model on the same API. */
export type ModerationProvider = { url: string; model: string; apiKey: string; fallbackModel?: string };

const MODERATION_SETTINGS = ["OSTRA_PAD_MODERATION_URL", "OSTRA_PAD_MODERATION_MODEL", "OSTRA_PAD_MODERATION_KEY_FILE"] as const;

/**
 * The moderation APIs the environment names, in the order they are asked: OSTRA_PAD_MODERATION_URL, _MODEL,
 * _KEY_FILE (all three) and _FALLBACK_MODEL (optional) for the first, the same names ending in _2, _3 ... for the next
 * ones (sdk numberedSettings, over the first three: a fallback model alone names no API and is ignored, as it was).
 * None: an empty list (listings are served unchecked). `readKey` reads a key file (refusing one others can read).
 */
export function moderationProviders(env: Record<string, string | undefined>, readKey: (path: string) => string): ModerationProvider[] {
  return numberedSettings(env, MODERATION_SETTINGS).map((s, i) => {
    const n = i === 0 ? "" : `_${i + 1}`;
    const url = s.OSTRA_PAD_MODERATION_URL;
    const model = s.OSTRA_PAD_MODERATION_MODEL;
    const keyFile = s.OSTRA_PAD_MODERATION_KEY_FILE;
    if (url === undefined || model === undefined || keyFile === undefined) throw new Error(`OSTRA_PAD_MODERATION_URL${n}, OSTRA_PAD_MODERATION_MODEL${n} and OSTRA_PAD_MODERATION_KEY_FILE${n} go together`);
    if (!/^https?:\/\//i.test(url)) throw new Error(`OSTRA_PAD_MODERATION_URL${n} must be an http(s) URL`);
    const apiKey = readKey(keyFile);
    if (apiKey === "") throw new Error(`${keyFile} (OSTRA_PAD_MODERATION_KEY_FILE${n}) is empty`);
    const fallbackModel = env[`OSTRA_PAD_MODERATION_FALLBACK_MODEL${n}`] || undefined;
    return { url, model, apiKey, ...(fallbackModel === undefined ? {} : { fallbackModel }) };
  });
}

/** A provider's name in the logs: its API's host and model (never its key). */
export function moderationProviderName(p: ModerationProvider): string {
  return `${new URL(p.url).host} ${p.model}`;
}

/** The moderator over `providers`, asked in order (sdk failover: an API that gives no answer is left aside a while). */
export function failoverModerator(providers: readonly ModerationProvider[], o: { log?: (event: string, fields: Record<string, unknown>) => void; fetch?: typeof fetch; timeoutMs?: number; cooldownMs?: number } = {}): Moderator {
  const extra = { ...(o.fetch === undefined ? {} : { fetch: o.fetch }), ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) };
  return failover(
    providers.map((p) => ({ name: moderationProviderName(p), call: openAiModerator({ ...p, ...extra }) })),
    { cooldownMs: o.cooldownMs ?? FAILOVER_COOLDOWN_MS, ...(o.log === undefined ? {} : { log: o.log }) },
  );
}
