// Several AI APIs behind one call, in order: the first that answers decides. Ostrapad's listing moderation (indexer)
// and its pool evaluator (keeper) ask a model through an OpenAI-compatible API; when one API gives no answer, the
// next one is asked, so a listing or a job does not wait on a single provider.

/** One provider of a call: a name for the logs (its API's host and model, never its key) and the call through it. */
export type FailoverProvider<I, O> = { name: string; call: (input: I) => Promise<O | "unreached"> };

/** How long a provider that gave no answer is left aside before it is asked again. */
export const FAILOVER_COOLDOWN_MS = 5 * 60_000;

/** At most this many providers in one list (settings numbered up to _5). */
export const FAILOVER_MAX = 5;

/**
 * The providers tried in order for each input. "unreached" (no response, or an error status: no answer, not paid)
 * moves on to the next provider and leaves the one that gave it aside for `cooldownMs`, so a provider that cannot be
 * reached does not hold every call up for its timeout; any other result (an answer, or null for an answer of another
 * shape) is final and returned as it is. When every provider is aside, the one whose time aside ends first is asked
 * all the same: a call always asks at least one provider, as a single API did, and never more providers than answer.
 * `log` is told when a provider is left aside and when it answers again.
 */
export function failover<I, O>(providers: readonly FailoverProvider<I, O>[], o: { cooldownMs: number; now?: () => number; log?: (event: string, fields: Record<string, unknown>) => void }): (input: I) => Promise<O | "unreached"> {
  if (providers.length === 0) throw new RangeError("failover needs at least one provider");
  if (!Number.isFinite(o.cooldownMs) || o.cooldownMs < 0) throw new RangeError("cooldownMs must be a number of milliseconds, 0 or more");
  const now = o.now ?? Date.now;
  const asideUntil = new Map<number, number>();
  const ask = async (i: number, input: I): Promise<O | "unreached"> => {
    const p = providers[i] as FailoverProvider<I, O>;
    const r = await p.call(input);
    if (r === "unreached") {
      asideUntil.set(i, now() + o.cooldownMs);
      o.log?.("ai_provider_unreached", { provider: p.name, asideForMs: o.cooldownMs, next: providers[i + 1]?.name ?? null });
    } else if (asideUntil.has(i)) {
      // Left aside before this call, or by another call while this one waited: it answers, so it is asked again.
      asideUntil.delete(i);
      o.log?.("ai_provider_answering", { provider: p.name });
    }
    return r;
  };
  return async (input) => {
    let asked = false;
    for (let i = 0; i < providers.length; i++) {
      const until = asideUntil.get(i);
      if (until !== undefined && now() < until) continue;
      asked = true;
      const r = await ask(i, input);
      if (r !== "unreached") return r;
    }
    if (asked) return "unreached";
    let soonest = 0;
    for (let i = 1; i < providers.length; i++) if ((asideUntil.get(i) ?? 0) < (asideUntil.get(soonest) ?? 0)) soonest = i;
    return ask(soonest, input);
  };
}

/**
 * Settings given once per provider: `<name>` for the first, then `<name>_2`, `<name>_3` ... up to FAILOVER_MAX, in
 * the order the providers are tried. Returns each provider's values (an empty value counts as not set). A provider
 * none of whose settings is given, between two that are, is refused, and so are `_1`, `_0` and numbers above
 * FAILOVER_MAX: a list never skips a provider without saying so.
 */
export function numberedSettings<N extends string>(env: Record<string, string | undefined>, names: readonly N[]): Record<N, string | undefined>[] {
  const given = new Set<number>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    for (const name of names) {
      if (key === name) given.add(1);
      else if (key.startsWith(`${name}_`)) {
        const n = key.slice(name.length + 1);
        if (!/^[0-9]+$/.test(n)) continue;
        if (!/^[2-9][0-9]*$/.test(n) || Number(n) > FAILOVER_MAX) throw new RangeError(`${key}: settings are numbered _2 to _${FAILOVER_MAX} (the first provider's have no number)`);
        given.add(Number(n));
      }
    }
  }
  const count = given.size === 0 ? 0 : Math.max(...given);
  const out: Record<N, string | undefined>[] = [];
  for (let n = 1; n <= count; n++) {
    if (!given.has(n)) throw new RangeError(`provider ${n} has none of ${names.map((x) => (n === 1 ? x : `${x}_${n}`)).join(", ")}, but provider ${count} has settings: providers are numbered without gaps`);
    const s = {} as Record<N, string | undefined>;
    for (const name of names) {
      const v = env[n === 1 ? name : `${name}_${n}`];
      s[name] = v === undefined || v === "" ? undefined : v;
    }
    out.push(s);
  }
  return out;
}
