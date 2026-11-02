// The reputation service's pure parts (src/reputation.ts): a verifier's thresholds as the tools take them (the 30-day
// record age by default), and the prover adapter (any ostra-prove command passed through; a build without the
// reputation commands named plainly). The service end to end runs on a mainnet fork: mcp/test/reputation.fork.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prover } from "@ostraagent/swap";
import type { Folder } from "../src/storage.ts";
import { REP_DEFAULT_MIN_AGE_DAYS } from "@ostraagent/sdk";
import { ReputationService, repProverOf } from "../src/reputation.ts";

test("thresholds: open by default with the record 30 days old; the age refused before OstraReputation has such records; ranges checked", () => {
  assert.equal(REP_DEFAULT_MIN_AGE_DAYS, 30);
  assert.deepEqual(ReputationService.thresholds({}, 36n), { minCompleted: 0, minClients: 0, minVolume: 0n, maxFailPermille: 1000, minTier: 0, maxFirstDay: 6 });
  assert.deepEqual(ReputationService.thresholds({ minCompleted: 3, minClients: 2, minVolume: "12.5", maxFailPermille: 50, minTier: 1, minAgeDays: 7 }, 36n), { minCompleted: 3, minClients: 2, minVolume: 12_500_000n, maxFailPermille: 50, minTier: 1, maxFirstDay: 29 });
  // A verifier's exact maxFirstDay wins over the age.
  assert.equal(ReputationService.thresholds({ maxFirstDay: 2, minAgeDays: 1 }, 36n).maxFirstDay, 2);
  assert.equal(ReputationService.thresholds({ minAgeDays: 0 }, 0n).maxFirstDay, 0);
  assert.throws(() => ReputationService.thresholds({}, 29n), /no record is 30 days old yet/);
  assert.throws(() => ReputationService.thresholds({ maxFailPermille: 1001 }, 40n), /out of range/);
  assert.throws(() => ReputationService.thresholds({ minTier: 4 }, 40n), /out of range/);
  assert.throws(() => ReputationService.thresholds({ minAgeDays: -1 }, 40n), RangeError);
  assert.throws(() => ReputationService.thresholds({ minVolume: "1.1234567" }, 40n));
});

test("the prover adapter passes every command through; a build without the reputation commands is named", async () => {
  const seen: string[] = [];
  const current = (async (command: string) => {
    seen.push(command);
    return { ok: command };
  }) as unknown as Prover;
  const p = repProverOf(current);
  assert.deepEqual(await p("rep-id", { sk: [] }), { ok: "rep-id" });
  assert.deepEqual(await p("secret"), { ok: "secret" });
  assert.deepEqual(seen, ["rep-id", "secret"]);
  const old = (async () => {
    throw new Error("ostra-prove rep-id failed (1): ostra-prove: usage: ostra-prove secret | note|path|prove < request.json");
  }) as unknown as Prover;
  await assert.rejects(repProverOf(old)("rep-id", {}), /this prover build has no reputation commands/);
  const other = (async () => {
    throw new Error("ostra-prove rep-prove failed (1): ostra-prove: the record does not meet the thresholds");
  }) as unknown as Prover;
  await assert.rejects(repProverOf(other)("rep-prove", {}), /does not meet the thresholds/);
});

// ---------------------------------------------------------------------------------------------
// The keyring: the secret in force, a rotation's waiting one, and the atomic switch (native ostra-prove)
// ---------------------------------------------------------------------------------------------

const PROVER = process.env.OSTRA_TEST_PROVER ?? new URL("../../../ostra-swap/privacy/target/release/ostra-prove", import.meta.url).pathname;

test("the keyring: drawn once, a rotation kept beside the secret in force, switched only when the new idc is in force", async (t) => {
  const { existsSync } = await import("node:fs");
  if (!existsSync(PROVER)) return t.skip(`no ostra-prove at ${PROVER}`);
  const { cliProver } = await import("@ostraagent/swap/cli-prover");
  const { MemoryFolder } = await import("./memory-folder.ts");
  const { RepKeyring } = await import("../src/reputation.ts");
  const prover = repProverOf(cliProver(PROVER));
  const folder = new MemoryFolder();
  const keys = new RepKeyring(folder, () => prover);
  assert.equal(await keys.current(), null);
  await assert.rejects(keys.beginRotation(), /no reputation secret to rotate/);
  const first = await keys.ensure();
  assert.equal(first.secret, "sk");
  assert.deepEqual(await keys.ensure(), first, "drawn once");
  const next = await keys.beginRotation();
  assert.notEqual(next.idc, first.idc);
  assert.notEqual(next.secret, first.secret);
  assert.deepEqual(await keys.beginRotation(), next, "called again: the same waiting secret");
  assert.deepEqual(await keys.current(), first, "the secret in force stays until the new one is in force on chain");
  assert.deepEqual(await keys.forIdc(first.idc), first);
  assert.deepEqual(await keys.forIdc(next.idc), next);
  assert.equal(await keys.settle(first.idc), false);
  assert.equal(await keys.settle(`0x${"01".repeat(32)}`), false);
  assert.equal(await keys.settle(next.idc), true);
  assert.deepEqual(await keys.current(), next);
  assert.equal(await keys.next(), null);
  assert.equal(await keys.forIdc(first.idc), null, "the old secret is no longer named");
  // A folder from before keys.json: its lone `sk` is the secret in force.
  const legacy = new MemoryFolder();
  await legacy.createSecret("sk", (await import("viem")).hexToBytes(first.sk));
  const migrated = await new RepKeyring(legacy, () => prover).current();
  assert.deepEqual(migrated, first);
});

test("the keyring: a rotation whose record cannot be written loses nothing; the next call draws again", async (t) => {
  const { existsSync } = await import("node:fs");
  if (!existsSync(PROVER)) return t.skip(`no ostra-prove at ${PROVER}`);
  const { cliProver } = await import("@ostraagent/swap/cli-prover");
  const { MemoryFolder } = await import("./memory-folder.ts");
  const { RepKeyring } = await import("../src/reputation.ts");
  const prover = repProverOf(cliProver(PROVER));
  const inner = new MemoryFolder();
  let failWrites = 0;
  // The test's folder: the memory folder, its writes failing while failWrites is above zero.
  const folder: Folder = {
    folder: (name) => inner.folder(name),
    ensure: () => inner.ensure(),
    read: (name) => inner.read(name),
    write: async (name, text) => {
      if (failWrites > 0) {
        failWrites--;
        throw new Error("disk full");
      }
      return inner.write(name, text);
    },
    create: (name, text) => inner.create(name, text),
    append: (name, text) => inner.append(name, text),
    remove: (name) => inner.remove(name),
    list: () => inner.list(),
    createSecret: (name, secret) => inner.createSecret(name, secret),
    readSecret: (name) => inner.readSecret(name),
  };
  const keys = new RepKeyring(folder, () => prover);
  const first = await keys.ensure();
  failWrites = 1;
  await assert.rejects(keys.beginRotation(), /disk full/);
  assert.deepEqual(await keys.current(), first, "the secret in force is untouched");
  assert.equal(await keys.next(), null);
  const next = await keys.beginRotation();
  assert.notEqual(next.idc, first.idc);
  // A failed switch leaves the record as it was: both secrets still named.
  failWrites = 1;
  await assert.rejects(keys.settle(next.idc), /disk full/);
  assert.deepEqual(await keys.current(), first);
  assert.deepEqual(await keys.next(), next);
  assert.equal(await keys.settle(next.idc), true);
  assert.deepEqual(await keys.current(), next);
});
