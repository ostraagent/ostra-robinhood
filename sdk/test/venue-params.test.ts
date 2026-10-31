// The version 4 spend params (SetVenue, Enter, Exit, Forward) and guard op 5 and 6, byte for byte against the
// abi.encode layouts OstraVault and OstraVaultModuleV4 decode (one 32-byte word per field, uint8 and bool right
// aligned, an address in the low 20 bytes), and what is refused before signing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { GUARD_OP, RAETO_NVDA_VAULT, RAETO_USDG_VAULT, SPARK_SAVINGS_USDG, USDG, VAULT_ACTION, VENUE_KIND } from "../src/constants.ts";
import {
  SPEND_PARAMS_LENGTHS,
  checkSpendParamsLength,
  decodeEnterParams,
  decodeExitParams,
  decodeForwardParams,
  decodeGuardParams,
  decodeSetVenueParams,
  enterParams,
  exitParams,
  forwardParams,
  guardCallParams,
  guardParams,
  setVenueParams,
} from "../src/messages.ts";

/** One ABI word: `v` as 32 bytes, big-endian. */
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const addrWord = (a: Address) => word(BigInt(a));
const hex = (...words: string[]) => `0x${words.join("")}` as Hex;
const OTHER_VAULT = getAddress("0x00000000000000000000000000000000000000aa");
const WITHDRAWAL = getAddress("0x00000000000000000000000000000000000000bb");
const ZERO: Address = "0x0000000000000000000000000000000000000000";

test("the version 4 spends' params lengths are the ones OstraVault checks", () => {
  assert.deepEqual(SPEND_PARAMS_LENGTHS[VAULT_ACTION.SET_VENUE], [96]);
  assert.deepEqual(SPEND_PARAMS_LENGTHS[VAULT_ACTION.ENTER], [128]);
  assert.deepEqual(SPEND_PARAMS_LENGTHS[VAULT_ACTION.EXIT], [128]);
  assert.deepEqual(SPEND_PARAMS_LENGTHS[VAULT_ACTION.FORWARD], [64]);
  assert.throws(() => checkSpendParamsLength(VAULT_ACTION.ENTER, hex(word(1n), word(2n), word(3n))), RangeError);
});

test("SetVenue: abi.encode(uint8 kind, address venue, bool enabled), and back", () => {
  const on = setVenueParams({ kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, enabled: true });
  assert.equal(on, hex(word(3n), addrWord(SPARK_SAVINGS_USDG), word(1n)).toLowerCase());
  assert.deepEqual(decodeSetVenueParams(on), { kind: 3, venue: SPARK_SAVINGS_USDG, enabled: true });
  const off = setVenueParams({ kind: VENUE_KIND.RAETO_USDG, venue: RAETO_USDG_VAULT, enabled: false });
  assert.equal(off, hex(word(1n), addrWord(RAETO_USDG_VAULT), word(0n)).toLowerCase());
  assert.throws(() => setVenueParams({ kind: 4 as never, venue: SPARK_SAVINGS_USDG, enabled: true }), /venue kind/);
  assert.throws(() => setVenueParams({ kind: 0 as never, venue: SPARK_SAVINGS_USDG, enabled: true }), /venue kind/);
  assert.throws(() => setVenueParams({ kind: VENUE_KIND.ERC4626, venue: ZERO, enabled: true }), RangeError);
});

test("Enter and Exit: abi.encode(uint8 kind, address venue, uint256 amount, uint256 bound), and back", () => {
  const enter = enterParams({ kind: VENUE_KIND.RAETO_STOCK, venue: RAETO_NVDA_VAULT, amount: 10n ** 18n, minPosition: 10n ** 18n - 10n });
  assert.equal(enter, hex(word(2n), addrWord(RAETO_NVDA_VAULT), word(10n ** 18n), word(10n ** 18n - 10n)).toLowerCase());
  assert.deepEqual(decodeEnterParams(enter), { kind: 2, venue: RAETO_NVDA_VAULT, amount: 10n ** 18n, minPosition: 10n ** 18n - 10n });
  const exit = exitParams({ kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 5_000_000n, minOut: 4_999_999n });
  assert.equal(exit, hex(word(3n), addrWord(SPARK_SAVINGS_USDG), word(5_000_000n), word(4_999_999n)).toLowerCase());
  assert.deepEqual(decodeExitParams(exit), { kind: 3, venue: SPARK_SAVINGS_USDG, amount: 5_000_000n, minOut: 4_999_999n });
  // A RAETO_STOCK Exit of 0 claims what a liquidation left; any other zero amount is refused, as the module does.
  assert.equal(exitParams({ kind: VENUE_KIND.RAETO_STOCK, venue: RAETO_NVDA_VAULT, amount: 0n, minOut: 0n }), hex(word(2n), addrWord(RAETO_NVDA_VAULT), word(0n), word(0n)).toLowerCase());
  assert.throws(() => exitParams({ kind: VENUE_KIND.RAETO_USDG, venue: RAETO_USDG_VAULT, amount: 0n, minOut: 0n }), /greater than zero/);
  assert.throws(() => enterParams({ kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 0n, minPosition: 0n }), /greater than zero/);
  assert.throws(() => enterParams({ kind: 9 as never, venue: SPARK_SAVINGS_USDG, amount: 1n, minPosition: 0n }), /venue kind/);
  assert.throws(() => exitParams({ kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 1n, minOut: -1n }), RangeError);
});

test("Forward: abi.encode(address foreign, uint256 amount), and back", () => {
  const p = forwardParams({ token: USDG, amount: 1_234_567n });
  assert.equal(p, hex(addrWord(USDG), word(1_234_567n)).toLowerCase());
  assert.deepEqual(decodeForwardParams(p), { token: USDG, amount: 1_234_567n });
  assert.throws(() => forwardParams({ token: USDG, amount: 0n }), /greater than zero/);
  assert.throws(() => forwardParams({ token: ZERO, amount: 1n }), RangeError);
});

test("a Guard spend with op 5 or 6 packs bytes32(uint256(kind) << 160 | uint160(venue)) as its arg", () => {
  const p = guardParams(OTHER_VAULT, { op: GUARD_OP.EXIT, kind: VENUE_KIND.RAETO_STOCK, venue: RAETO_NVDA_VAULT, amount: 0n });
  const arg = `${"00".repeat(11)}02${RAETO_NVDA_VAULT.slice(2).toLowerCase()}`;
  assert.equal(arg, word((2n << 160n) | BigInt(RAETO_NVDA_VAULT)));
  assert.equal(p, hex(addrWord(OTHER_VAULT), word(5n), arg, word(0n)));
  // OstraVault routes it to OstraVaultModuleV4 by the op word's last byte (params[63]).
  assert.equal(p.slice(2 + 2 * 63, 2 + 2 * 64), "05");
  assert.deepEqual(decodeGuardParams(p), { vault: OTHER_VAULT, op: 5, arg: `0x${arg}`, amount: 0n });
  const some = guardParams(OTHER_VAULT, { op: GUARD_OP.EXIT, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 7n });
  assert.equal(some, hex(addrWord(OTHER_VAULT), word(5n), word((3n << 160n) | BigInt(SPARK_SAVINGS_USDG)), word(7n)));
  // Op 6: the same arg, and the expected withdrawal address as a uint160 in the amount word (the whole position).
  const sweep = guardParams(OTHER_VAULT, { op: GUARD_OP.EXIT_SWEEP, kind: VENUE_KIND.RAETO_USDG, venue: RAETO_USDG_VAULT, amount: 0n, expected: WITHDRAWAL });
  assert.equal(sweep, hex(addrWord(OTHER_VAULT), word(6n), `${"00".repeat(11)}01${RAETO_USDG_VAULT.slice(2).toLowerCase()}`, `${"00".repeat(12)}${WITHDRAWAL.slice(2).toLowerCase()}`));
  assert.equal(sweep.slice(2 + 2 * 63, 2 + 2 * 64), "06");
  assert.deepEqual(decodeGuardParams(sweep), { vault: OTHER_VAULT, op: 6, arg: `0x${word((1n << 160n) | BigInt(RAETO_USDG_VAULT))}`, amount: BigInt(WITHDRAWAL) });
  assert.throws(() => guardParams(OTHER_VAULT, { op: GUARD_OP.EXIT_SWEEP, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 1n, expected: WITHDRAWAL }), /whole position/);
  assert.throws(() => guardParams(OTHER_VAULT, { op: GUARD_OP.EXIT_SWEEP, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 0n, expected: ZERO }), RangeError);
  assert.throws(() => guardParams(OTHER_VAULT, { op: GUARD_OP.EXIT, kind: 0 as never, venue: SPARK_SAVINGS_USDG, amount: 0n }), /venue kind/);
  assert.throws(() => guardParams(OTHER_VAULT, { op: GUARD_OP.EXIT, kind: VENUE_KIND.ERC4626, venue: ZERO, amount: 0n }), RangeError);
});

test("guard ops 5 and 6 on the vault itself: abi.encode(kind, venue, amount) and abi.encode(kind, venue, amount, expected)", () => {
  assert.equal(
    guardCallParams({ op: GUARD_OP.EXIT, kind: VENUE_KIND.RAETO_USDG, venue: RAETO_USDG_VAULT, amount: 0n }),
    hex(word(1n), addrWord(RAETO_USDG_VAULT), word(0n)).toLowerCase(),
  );
  assert.equal(
    guardCallParams({ op: GUARD_OP.EXIT_SWEEP, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 9n, expected: WITHDRAWAL }),
    hex(word(3n), addrWord(SPARK_SAVINGS_USDG), word(9n), addrWord(WITHDRAWAL)).toLowerCase(),
  );
  assert.throws(() => guardCallParams({ op: GUARD_OP.EXIT_SWEEP, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 0n, expected: ZERO }), RangeError);
});
