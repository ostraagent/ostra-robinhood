import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyedLimiter, TokenBucket } from "../src/limits.ts";

test("a bucket allows a burst of its rate, then refills over time", () => {
  let now = 1_000_000;
  const bucket = new TokenBucket(10, () => now);
  for (let i = 0; i < 10; i++) assert.equal(bucket.take(), true, `request ${i}`);
  assert.equal(bucket.take(), false);
  now += 99;
  assert.equal(bucket.take(), false);
  now += 1;
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  now += 10_000;
  assert.equal(bucket.full(), true);
  for (let i = 0; i < 10; i++) assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
});

test("keys are limited separately and full buckets are pruned", () => {
  let now = 0;
  const limiter = new KeyedLimiter(2, () => now);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), false);
  assert.equal(limiter.take("b"), true);
  assert.equal(limiter.size, 2);
  limiter.prune();
  assert.equal(limiter.size, 2);
  now += 1_000;
  limiter.prune();
  assert.equal(limiter.size, 0);
  assert.throws(() => new TokenBucket(0), /positive integer/);
});
