// Which deposits go into the next batch, and the shuffle of their leaves.
// Pure functions, so the rules can be tested without a chain.

import { randomInt } from "node:crypto";
import { MAX_LEAVES_PER_BATCH } from "@ostraagent/sdk";
import { FRESH_SECONDS, MAX_DEPOSITS_PER_BATCH, MIN_ANONYMITY_DEPOSITS } from "./config.ts";
import type { DepositRecord } from "./store.ts";

/** True when the depositor polled within the last FRESH_SECONDS. */
export function isFresh(record: DepositRecord, now: number): boolean {
  return record.polledAt !== null && now - record.polledAt <= FRESH_SECONDS;
}

/**
 * The deposits of the next batch: fresh deposits with a leaf set, in queue order (oldest
 * first), as many as fit in MAX_DEPOSITS_PER_BATCH deposits and
 * MAX_LEAVES_PER_BATCH leaves; a deposit that does not fit is skipped for a
 * later one that does. Null when fewer than MIN_ANONYMITY_DEPOSITS would go
 * in: a batch is never built below the minimum anonymity.
 */
export function selectDeposits(records: readonly DepositRecord[], now: number): DepositRecord[] | null {
  const queue = records
    // A deposit waiting for a new leaf set (rekey) has none to offer.
    .filter((r) => isFresh(r, now) && r.leaves.length > 0)
    .sort((a, b) => a.queuedAt - b.queuedAt || (a.deposit < b.deposit ? -1 : a.deposit > b.deposit ? 1 : 0));
  const picked: DepositRecord[] = [];
  let leaves = 0;
  for (const r of queue) {
    if (picked.length === MAX_DEPOSITS_PER_BATCH) break;
    if (leaves + r.leaves.length > MAX_LEAVES_PER_BATCH) continue;
    picked.push(r);
    leaves += r.leaves.length;
  }
  return picked.length >= MIN_ANONYMITY_DEPOSITS ? picked : null;
}

/** Fisher-Yates shuffle with a cryptographic random source; returns a new array. */
export function shuffle<T>(items: readonly T[], random: (bound: number) => number = (bound) => randomInt(bound)): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = random(i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
