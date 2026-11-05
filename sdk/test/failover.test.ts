// failover.ts: providers asked in order, one with no answer left aside for the cooldown, an answer (or an answer of
// another shape, null) final; when every provider is aside, the one whose time aside ends first is still asked; the
// settings numbered _2 to _5 without gaps. The live checks (indexer scripts/pad-moderation-check.ts, keeper
// scripts/pad-judge-check.ts) run the same code against real APIs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILOVER_MAX, failover, numberedSettings, type FailoverProvider } from "../src/failover.ts";

/** A provider whose answers are given in turn ("unreached", a value or null), each call recorded. */
function provider(name: string, answers: (string | null | "unreached")[], calls: string[]): FailoverProvider<string, string | null> {
  let n = 0;
  return {
    name,
    call: async (input) => {
      calls.push(`${name}:${input}`);
      const a = answers[Math.min(n, answers.length - 1)] as string | null | "unreached";
      n += 1;
      return a;
    },
  };
}

test("the first provider that answers decides; one with no answer is left aside for the cooldown", async () => {
  let t = 1_000;
  const calls: string[] = [];
  const events: [string, Record<string, unknown>][] = [];
  const ask = failover([provider("a", ["unreached", "unreached", "A"], calls), provider("b", ["B"], calls)], { cooldownMs: 300, now: () => t, log: (e, f) => events.push([e, f]) });
  assert.equal(await ask("1"), "B");
  assert.deepEqual(calls, ["a:1", "b:1"]);
  assert.deepEqual(events, [["ai_provider_unreached", { provider: "a", asideForMs: 300, next: "b" }]]);
  // Within the cooldown, a is not asked.
  t += 299;
  assert.equal(await ask("2"), "B");
  assert.deepEqual(calls.slice(2), ["b:2"]);
  // After it, a is asked again; still no answer, so it is left aside again and b answers.
  t += 1;
  assert.equal(await ask("3"), "B");
  assert.deepEqual(calls.slice(3), ["a:3", "b:3"]);
  // a answers again after its next cooldown: it decides, and the log says it answers.
  t += 300;
  assert.equal(await ask("4"), "A");
  assert.deepEqual(calls.slice(5), ["a:4"]);
  assert.deepEqual(events.at(-1), ["ai_provider_answering", { provider: "a" }]);
});

test("an answer of another shape (null) is final: the next provider is not asked", async () => {
  const calls: string[] = [];
  const ask = failover([provider("a", [null], calls), provider("b", ["B"], calls)], { cooldownMs: 300 });
  assert.equal(await ask("1"), null);
  assert.deepEqual(calls, ["a:1"]);
});

test("every provider with no answer: unreached; when all are aside, the one whose time aside ends first is asked", async () => {
  let t = 0;
  const calls: string[] = [];
  const ask = failover([provider("a", ["unreached"], calls), provider("b", ["unreached", "B"], calls)], { cooldownMs: 100, now: () => t });
  assert.equal(await ask("1"), "unreached");
  assert.deepEqual(calls, ["a:1", "b:1"]);
  // Both aside: a's time ends first (it was left aside first, at the same clock: the first in order), so a alone is asked.
  t = 50;
  assert.equal(await ask("2"), "unreached");
  assert.deepEqual(calls.slice(2), ["a:2"]);
  // Now b's time aside ends first (a was left aside again at 50): b is asked and answers.
  t = 60;
  assert.equal(await ask("3"), "B");
  assert.deepEqual(calls.slice(3), ["b:3"]);
});

test("a single provider is asked on every call, as a single API was", async () => {
  const calls: string[] = [];
  const ask = failover([provider("a", ["unreached", "unreached", "A"], calls)], { cooldownMs: 60_000 });
  assert.equal(await ask("1"), "unreached");
  assert.equal(await ask("2"), "unreached");
  assert.equal(await ask("3"), "A");
  assert.deepEqual(calls, ["a:1", "a:2", "a:3"]);
});

test("a provider left aside by one call while another call waited on it is asked again once that call gets its answer", async () => {
  let release: (v: string) => void = () => {};
  let n = 0;
  const calls: string[] = [];
  const slow: FailoverProvider<string, string | null> = {
    name: "a",
    call: (input) => {
      calls.push(`a:${input}`);
      n += 1;
      return n === 1 ? new Promise<string>((r) => (release = r)) : Promise.resolve("unreached" as const);
    },
  };
  const ask = failover([slow, provider("b", ["B"], calls)], { cooldownMs: 60_000 });
  const first = ask("1");
  // While the first call waits on a, a second call finds no answer there and leaves it aside.
  assert.equal(await ask("2"), "B");
  release("A");
  assert.equal(await first, "A");
  // a answered: it is no longer aside.
  n = 0;
  const third = ask("3");
  release("A3");
  assert.equal(await third, "A3");
  assert.deepEqual(calls, ["a:1", "a:2", "b:2", "a:3"]);
});

test("failover refuses no provider and a bad cooldown", () => {
  assert.throws(() => failover([], { cooldownMs: 1 }), /at least one provider/);
  assert.throws(() => failover([provider("a", ["A"], [])], { cooldownMs: -1 }), /cooldownMs/);
  assert.throws(() => failover([provider("a", ["A"], [])], { cooldownMs: Number.NaN }), /cooldownMs/);
});

test("numbered settings: the first without a number, then _2 to _5, in order, without gaps", () => {
  const names = ["X_URL", "X_MODEL"] as const;
  assert.deepEqual(numberedSettings({}, names), []);
  assert.deepEqual(numberedSettings({ X_URL: "", OTHER: "1" }, names), []);
  assert.deepEqual(numberedSettings({ X_URL: "u1", X_MODEL: "m1", X_URL_2: "u2", X_MODEL_3: "m3" }, names), [
    { X_URL: "u1", X_MODEL: "m1" },
    { X_URL: "u2", X_MODEL: undefined },
    { X_URL: undefined, X_MODEL: "m3" },
  ]);
  // A name that only starts like a setting is not one of them.
  assert.deepEqual(numberedSettings({ X_URL: "u", X_URL_OLD: "o", X_MODELS: "s" }, names), [{ X_URL: "u", X_MODEL: undefined }]);
  assert.throws(() => numberedSettings({ X_URL_2: "u2" }, names), /provider 1 has none of X_URL, X_MODEL/);
  assert.throws(() => numberedSettings({ X_URL: "u", X_URL_3: "u3" }, names), /provider 2 has none/);
  assert.throws(() => numberedSettings({ X_URL: "u", X_URL_1: "u1" }, names), /numbered _2 to _5/);
  assert.throws(() => numberedSettings({ X_URL: "u", X_URL_02: "u" }, names), /numbered _2 to _5/);
  assert.throws(() => numberedSettings({ X_URL: "u", [`X_URL_${FAILOVER_MAX + 1}`]: "u" }, names), /numbered _2 to _5/);
});
