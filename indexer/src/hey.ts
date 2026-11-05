// A token's builder status from HEY Research Lab (heyresearch.xyz), the public record of building on Robinhood
// Chain: its Partner Card (GET /api/v1/builder?chain=4663&token=<address>), read with Ostra's key and passed on as
// HEY gives it, for the Ostra MCP to show beside a swap. It is builder evidence, never a rating or a trading signal.
//
// HEY's rules of use (heyresearch.xyz/developers/partners, read 5 Nov 2026), which this module keeps:
//   - project_link is always carried (the one condition of use);
//   - HEY's own words: hey_status_label, never another word for the status; meaningful_ships_30d, never a release
//     count; null stays null (not measured), never 0;
//   - when activity_applies_to_token is false (token_verification MISMATCH) the project's own site names another
//     contract: the activity is never given as this token's, so only the project and its link are passed on;
//   - a 404 means HEY has not published a project for the contract (its scan_url is offered); on 429, 5xx or any
//     other failure nothing is said about the builder;
//   - an answer is kept 60 seconds at most.
// The key (an account's free key: 120 a minute, 10,000 a month) never leaves the server. A running index makes at
// most `dailyCalls` calls to HEY a UTC day, of which at most `otherDailyCalls` about tokens outside `allowed` (USDG's
// pair tokens and the launched tokens): since MCP 0.1.20 Ostra Swap trades any ERC-20 that passes its token check, and
// anyone can ask the index about any address, so those calls cannot use up the day of the listed tokens (anyone
// can use up the other tokens' calls of a day: then those answer "unavailable" until the next UTC day). None are
// made for a minute after HEY gave no answer (or for retry-after on a 429), nor for the rest of the UTC day once HEY
// says fewer than HEY_MONTH_RESERVE of the key's month remain; then the answer is "unavailable".
// HEY's text is a third party's data shown to AI agents: each string is cut to HEY_TEXT_MAX characters, without
// control or bidirectional characters.

import { getAddress, isAddress, type Address } from "viem";

export const HEY_API = "https://heyresearch.xyz";
/** Robinhood Chain, the one chain HEY indexes. */
export const HEY_CHAIN = 4663;
/** HEY's rule: an answer is kept 60 seconds at most. */
export const HEY_CACHE_MS = 60_000;
/** Calls to HEY a UTC day: 300 keeps a month under the free key's 10,000. */
export const HEY_DAILY_CALLS = 300;
/** Of HEY_DAILY_CALLS, the most about tokens outside `allowed`. */
export const HEY_OTHER_DAILY_CALLS = 100;
/** The name Ostra declares on its calls (x-hey-integration), so HEY credits the integration. */
export const HEY_INTEGRATION = "ostra";
/** Below this many calls left in the key's month (x-hey-monthly-remaining), no more are made that UTC day. */
export const HEY_MONTH_RESERVE = 500;
/** The longest string of HEY's passed on. */
export const HEY_TEXT_MAX = 200;
/** HEY's answer is read up to this many bytes. */
const BODY_MAX = 256 * 1024;

/** The Partner Card's fields passed on, under HEY's own names (heyresearch.xyz/developers/partners). */
export type HeyCard = {
  hey_project_name: string;
  project_link: string;
  hey_status_label: string;
  hey_status_help: string | null;
  activity_measured: boolean;
  verified_builder: boolean;
  token_verification: string;
  meaningful_ships_30d: number | null;
  latest_meaningful_ship: { title: string; timestamp: string; evidence_link: string } | null;
  as_of: string | null;
};

export type HeyBuilder =
  | { source: "HEY Research Lab"; state: "published"; card: HeyCard; disclaimer: string }
  | { source: "HEY Research Lab"; state: "project_only"; hey_project_name: string; project_link: string; note: string; disclaimer: string }
  | { source: "HEY Research Lab"; state: "not_published"; scan_url: string | null; note: string }
  | { source: "HEY Research Lab"; state: "unavailable"; note: string };

const SOURCE = "HEY Research Lab" as const;
const UNAVAILABLE: HeyBuilder = { source: SOURCE, state: "unavailable", note: "HEY did not answer: nothing is said about the builder" };

/** A string of HEY's as passed on: no control or bidirectional characters, at most HEY_TEXT_MAX characters; null when empty. */
const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ").trim();
  if (s === "") return null;
  const chars = [...s];
  return chars.length <= HEY_TEXT_MAX ? s : `${chars.slice(0, HEY_TEXT_MAX - 3).join("")}...`;
};
/** A response's body as text, read up to BODY_MAX bytes; null (the read stopped) when it is longer. */
async function bodyText(res: Response): Promise<string | null> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/** An https URL of HEY's (whole, never cut), or null. */
const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 2_048 || /[\s\u0000-\u001f\u007f]/.test(v)) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};

/**
 * The answer passed on for a Partner Card HEY returned with status 200, or null when it lacks what HEY's rules need
 * (a project name, project_link, hey_status_label, activity_measured): then nothing is said.
 */
export function cardOf(body: Record<string, unknown>): HeyBuilder | null {
  const name = str(body.hey_project_name);
  const link = httpsUrl(body.project_link);
  const label = str(body.hey_status_label);
  const disclaimer = str(body.disclaimer) ?? "HEY reports what a team shipped and how it knows. It is not a rating, not a verdict, and says nothing about what a token will do.";
  if (name === null || link === null) return null;
  // HEY's own example for a token whose project names another contract: the project and its link, with a note that
  // the research is about the project, never its activity as the token's.
  if (body.activity_applies_to_token === false || body.token_verification === "MISMATCH") {
    return { source: SOURCE, state: "project_only", hey_project_name: name, project_link: link, note: "HEY's research is about the project, not this token: the project's own site names another contract", disclaimer };
  }
  // Activity is passed on as the token's only when HEY says it applies to the token.
  if (body.activity_applies_to_token !== true || label === null || typeof body.activity_measured !== "boolean") return null;
  const ships = body.meaningful_ships_30d;
  const s = body.latest_meaningful_ship;
  let latest: HeyCard["latest_meaningful_ship"] = null;
  if (s !== null && typeof s === "object" && !Array.isArray(s)) {
    const o = s as Record<string, unknown>;
    const title = str(o.title);
    const timestamp = str(o.timestamp);
    const evidence = httpsUrl(o.evidence_link);
    if (title !== null && timestamp !== null && evidence !== null) latest = { title, timestamp, evidence_link: evidence };
  }
  return {
    source: SOURCE,
    state: "published",
    card: {
      hey_project_name: name,
      project_link: link,
      hey_status_label: label,
      hey_status_help: str(body.hey_status_help),
      activity_measured: body.activity_measured,
      verified_builder: body.verified_builder === true,
      token_verification: str(body.token_verification) ?? "UNVERIFIED",
      meaningful_ships_30d: typeof ships === "number" && Number.isInteger(ships) && ships >= 0 ? ships : null,
      latest_meaningful_ship: latest,
      as_of: str(body.as_of),
    },
    disclaimer,
  };
}

export type HeyOptions = {
  /** HEY's key (an account's key, sent as a bearer token); never logged. */
  key: string;
  /** The tokens HEY is asked about first (USDG's pair tokens, the launched tokens); others share otherDailyCalls. */
  allowed: (token: Address) => boolean;
  log: (event: string, fields?: Record<string, unknown>) => void;
  api?: string;
  cacheMs?: number;
  dailyCalls?: number;
  otherDailyCalls?: number;
  timeoutMs?: number;
  now?: () => number;
};

export class HeyBuilders {
  readonly #key: string;
  readonly #allowed: (token: Address) => boolean;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  readonly #api: string;
  readonly #cacheMs: number;
  readonly #dailyCalls: number;
  readonly #otherDailyCalls: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; answer: HeyBuilder }>();
  readonly #inFlight = new Map<string, Promise<HeyBuilder>>();
  #day = "";
  #calls = 0;
  #otherCalls = 0;
  #pausedUntil = 0;
  /** The UTC day no more calls are made, as HEY said the key's month is nearly used. */
  #stoppedDay = "";
  /** Calls made to HEY since the start (the live check reads it). */
  callsMade = 0;

  constructor(o: HeyOptions) {
    if (!/^hey_[\x21-\x7e]+$/.test(o.key)) throw new Error("the HEY key must start with hey_ and hold no spaces");
    this.#key = o.key;
    this.#allowed = o.allowed;
    this.#log = o.log;
    this.#api = (o.api ?? HEY_API).replace(/\/+$/, "");
    this.#cacheMs = o.cacheMs ?? HEY_CACHE_MS;
    if (!(this.#cacheMs >= 0 && this.#cacheMs <= HEY_CACHE_MS)) throw new Error(`cacheMs must be 0 to ${HEY_CACHE_MS}`);
    this.#dailyCalls = o.dailyCalls ?? HEY_DAILY_CALLS;
    this.#otherDailyCalls = o.otherDailyCalls ?? HEY_OTHER_DAILY_CALLS;
    this.#timeoutMs = o.timeoutMs ?? 4_000;
    this.#now = o.now ?? Date.now;
  }

  /** The builder answer for `tokenText`, or null when it is not an address. */
  async builder(tokenText: string): Promise<HeyBuilder | null> {
    if (!isAddress(tokenText, { strict: false })) return null;
    const token = getAddress(tokenText);
    const k = token.toLowerCase();
    const hit = this.#cache.get(k);
    if (hit !== undefined && this.#now() - hit.at < this.#cacheMs) return hit.answer;
    const running = this.#inFlight.get(k);
    if (running !== undefined) return running;
    const p = this.#ask(token, this.#allowed(token)).finally(() => this.#inFlight.delete(k));
    this.#inFlight.set(k, p);
    return p;
  }

  async #ask(token: Address, listed: boolean): Promise<HeyBuilder> {
    const now = this.#now();
    if (now < this.#pausedUntil) return UNAVAILABLE;
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#calls = 0;
      this.#otherCalls = 0;
    }
    if (this.#calls >= this.#dailyCalls) return UNAVAILABLE;
    if (!listed && this.#otherCalls >= this.#otherDailyCalls) return UNAVAILABLE;
    if (this.#stoppedDay === day) return UNAVAILABLE;
    this.#calls += 1;
    if (!listed) {
      this.#otherCalls += 1;
      if (this.#otherCalls === this.#otherDailyCalls) this.#log("hey_other_daily_calls_reached", { day, calls: this.#otherCalls });
    }
    this.callsMade += 1;
    if (this.#calls === this.#dailyCalls) this.#log("hey_daily_calls_reached", { day, calls: this.#calls });
    let status = 0;
    let body: Record<string, unknown> | null = null;
    try {
      const res = await fetch(`${this.#api}/api/v1/builder?chain=${HEY_CHAIN}&token=${token}`, {
        headers: { authorization: `Bearer ${this.#key}`, "x-hey-integration": HEY_INTEGRATION, accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
      status = res.status;
      if (status === 429) {
        const wait = Number(res.headers.get("retry-after"));
        this.#pausedUntil = this.#now() + (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 3_600) : 60) * 1_000;
      }
      const left = res.headers.get("x-hey-monthly-remaining");
      if (left !== null && /^[0-9]+$/.test(left) && Number(left) < HEY_MONTH_RESERVE && this.#stoppedDay !== day) {
        this.#stoppedDay = day;
        this.#log("hey_month_reserve", { day, monthlyRemaining: Number(left) });
      }
      const text = await bodyText(res);
      try {
        const parsed = text === null ? null : (JSON.parse(text) as unknown);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = null;
      }
    } catch (err) {
      this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + 60_000);
      this.#log("hey_unanswered", { token, reason: (err as Error).name });
      return UNAVAILABLE;
    }
    let answer: HeyBuilder | null = null;
    if (status === 200 && body !== null) answer = cardOf(body);
    else if (status === 404 && body !== null && body.error === "not_found") {
      answer = { source: SOURCE, state: "not_published", scan_url: httpsUrl(body.scan_url), note: "HEY has not published a project for this contract: that is a statement about HEY's index, not about the token" };
    }
    if (answer === null) {
      if (status >= 500 || status === 0) this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + 60_000);
      this.#log("hey_unanswered", { token, status });
      return UNAVAILABLE;
    }
    this.#cache.set(token.toLowerCase(), { at: this.#now(), answer });
    if (this.#cache.size > 2_000) {
      const cutoff = this.#now() - this.#cacheMs;
      for (const [k, v] of this.#cache) if (v.at <= cutoff) this.#cache.delete(k);
    }
    return answer;
  }
}
