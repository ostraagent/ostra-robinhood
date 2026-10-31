// Ostrapad's content rules in the index (design "Ostrapad", decided by Edu on 30 Oct 2026): each listing is checked
// once by a model behind an OpenAI-compatible API (Raeto, the evaluator bot's account), and checked again only when
// what it lists changes; a listing found to sell prohibited work is left out of the listings (MCP's pad_search) and
// the board, its reason kept with the agent. The rules and the answer's shape: sdk pad-rules.ts.

import { sha256, stringToHex, type Hex } from "viem";
import { PAD_MODERATION_PROMPT, parsePadModeration, type PadModeration, type PadModerationInput } from "@ostraagent/sdk";

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
 * API) is asked; if that one refuses too, or there is none, the listing is prohibited (REFUSED_LISTING). It runs
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
    return second === "refused" ? REFUSED_LISTING : second;
  };
}
