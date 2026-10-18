// Token amounts as agents write them ("1.25") and as the chain stores them
// (base units of a 6-decimal token such as USDG).

export const TOKEN_DECIMALS = 6;
const UNIT = 1_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;

/** "1.25" -> 1_250_000n. Plain decimals only: no sign, exponent, spaces or more than 6 decimals. */
export function parseTokenAmount(text: string): bigint {
  if (!DECIMAL.test(text)) {
    throw new RangeError(`invalid amount "${text}": use a plain decimal with at most 6 decimals, e.g. "1.25"`);
  }
  const [whole, fraction = ""] = text.split(".");
  const units = BigInt(whole!) * UNIT + BigInt(fraction.padEnd(TOKEN_DECIMALS, "0"));
  if (units > U64_MAX) throw new RangeError(`amount "${text}" is too large`);
  return units;
}

/** 1_250_000n -> "1.25". */
export function formatTokenAmount(units: bigint): string {
  if (units < 0n) throw new RangeError("amount must not be negative");
  const whole = units / UNIT;
  const fraction = (units % UNIT).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** Wei -> ETH as a decimal string (on Solana: lamports -> SOL, formatSol). */
export function formatEth(wei: bigint): string {
  if (wei < 0n) throw new RangeError("amount must not be negative");
  const whole = wei / WEI_PER_ETH;
  const fraction = (wei % WEI_PER_ETH).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** "1.5" in a token of `decimals` decimals -> base units. Plain decimals only, at most `decimals` of them; at most 2^128 - 1. */
export function parseUnitsAmount(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError("decimals must be 0..36");
  const pattern = decimals === 0 ? /^(0|[1-9][0-9]*)$/ : new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`);
  if (!pattern.test(text)) throw new RangeError(`invalid amount "${text}": use a plain decimal with at most ${decimals} decimals, e.g. "1.25"`);
  const [whole, fraction = ""] = text.split(".");
  const units = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units >= 1n << 128n) throw new RangeError(`amount "${text}" is too large`);
  return units;
}

/** Base units of a token of `decimals` decimals -> "1.5". */
export function formatUnitsAmount(units: bigint, decimals: number): string {
  if (units < 0n) throw new RangeError("amount must not be negative");
  if (decimals === 0) return units.toString();
  const unit = 10n ** BigInt(decimals);
  const fraction = (units % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? (units / unit).toString() : `${units / unit}.${fraction}`;
}
