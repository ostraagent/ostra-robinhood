// Relayed transactions and their price (design v0.3, decided 15 Oct 2026; on
// Robinhood Chain, design v0.4), shared by the Ostra relayer gate and the
// agents it serves, so an agent checks a quote with exactly the rules the
// relayer charges by.
//
//   request   one to MAX_RELAY_CALLS calls to Ostra's contracts, each
//             {to, data} with no ETH value. The relayer sends one call as
//             it is and several through Multicall3 aggregate3 (every call
//             must succeed). The request hash, keccak256(to || data) of that
//             transaction, is what a quote and a payment are bound to.
//   ETH/USD   Chainlink ETH/USD (8 decimals), at most ETH_USD_MAX_AGE_SECONDS
//             old by the chain's own latest block time.
//   wei       eth_estimateGas of the transaction from the relayer (on
//             Robinhood Chain it includes the L1 data component) times
//             eth_gasPrice at the quote. There is no rent and nothing comes
//             back to the relayer, so nothing is refunded.
//   price     wei + RELAYER_MARGIN_BPS, at the Chainlink price +
//             ETH_USD_DEVIATION_BPS (the feed's deviation threshold), rounded
//             up to the token's smallest unit. The token is a USD stablecoin,
//             counted as 1 USD.

import { concat, encodeFunctionData, getAddress, hexToBytes, isAddress, isHex, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { CHAINLINK_ETH_USD, CHAINLINK_ETH_USD_DECIMALS, MULTICALL3 } from "./constants.ts";
import { chainlinkAggregatorAbi, multicall3Abi } from "./external-abi.ts";

// ---------------------------------------------------------------------------
// Decided numbers (design v0.3; Robinhood Chain values decided 17 Oct 2026)
// ---------------------------------------------------------------------------

/** Relayer margin: gas cost + 10% (design v0.3, "Margin fee relayer"). */
export const RELAYER_MARGIN_BPS = 1_000n;
/** How far above its own price an agent still pays a relayer quote (decided 15 Oct 2026): 2%. */
export const RELAYER_QUOTE_TOLERANCE_BPS = 200n;
/** ETH/USD is priced 0.5% high, Chainlink's deviation threshold for the feed (decided 17 Oct 2026). */
export const ETH_USD_DEVIATION_BPS = 50n;
/**
 * Oldest ETH/USD answer accepted, in seconds (decided 17 Oct 2026): the
 * feed's 86,400 s heartbeat plus one hour. Within the heartbeat the answer is
 * within the 0.5% deviation threshold of the market; an older one means the
 * feed stopped.
 */
export const ETH_USD_MAX_AGE_SECONDS = 90_000n;
/** Most calls in one relay request (decided 17 Oct 2026). */
export const MAX_RELAY_CALLS = 8;

const BPS = 10_000n;
const WEI_PER_ETH_EXP = 18;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** One call of a relay request. */
export type RelayCall = { to: Address; data: Hex };

/** Checks and normalizes the calls of a relay request: 1..MAX_RELAY_CALLS calls, each an address and calldata of at least a selector. */
export function relayCalls(value: unknown): RelayCall[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("calls must be a non-empty array of {to, data}");
  if (value.length > MAX_RELAY_CALLS) throw new Error(`at most ${MAX_RELAY_CALLS} calls are relayed in one request`);
  return value.map((entry: unknown, i) => {
    const e = entry as { to?: unknown; data?: unknown; value?: unknown } | null;
    if (e === null || typeof e !== "object") throw new Error(`calls[${i}] must be {to, data}`);
    if (e.value !== undefined) throw new Error(`calls[${i}]: the relayer sends no ETH value`);
    if (typeof e.to !== "string" || !isAddress(e.to, { strict: false })) throw new Error(`calls[${i}].to is not an address`);
    if (typeof e.data !== "string" || !isHex(e.data, { strict: true }) || e.data.length % 2 !== 0 || e.data.length < 10) {
      throw new Error(`calls[${i}].data must be hex calldata of at least a 4-byte selector`);
    }
    return { to: getAddress(e.to), data: e.data.toLowerCase() as Hex };
  });
}

/** The transaction the relayer sends for `calls`: the call itself, or Multicall3 aggregate3 of all of them (none may fail). */
export function relayTransaction(calls: readonly RelayCall[]): { to: Address; data: Hex } {
  if (calls.length === 0) throw new Error("no calls");
  if (calls.length === 1) {
    const only = calls[0] as RelayCall;
    return { to: getAddress(only.to), data: only.data.toLowerCase() as Hex };
  }
  return {
    to: MULTICALL3,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls.map((c) => ({ target: getAddress(c.to), allowFailure: false, callData: c.data }))] }),
  };
}

/** keccak256(to || data) of the transaction relayTransaction(calls) builds: what a quote and a payment are bound to (lowercase hex). */
export function relayRequestHash(calls: readonly RelayCall[]): Hex {
  const tx = relayTransaction(calls);
  return keccak256(concat([hexToBytes(tx.to), hexToBytes(tx.data)]), "hex").toLowerCase() as Hex;
}

// ---------------------------------------------------------------------------
// ETH/USD
// ---------------------------------------------------------------------------

export type EthUsd = {
  /** USD per ETH in units of 10^-8 (the feed's decimals). */
  answer: bigint;
  roundId: bigint;
  /** Unix seconds of the answer. */
  updatedAt: bigint;
};

/** Refuses an answer older than ETH_USD_MAX_AGE_SECONDS at `nowSeconds` (chain time), or one from the future. */
export function checkFresh(p: EthUsd, nowSeconds: bigint, maxAgeSeconds: bigint = ETH_USD_MAX_AGE_SECONDS): void {
  const age = nowSeconds - p.updatedAt;
  if (age > maxAgeSeconds) throw new Error(`the ETH/USD answer is ${age} s old (at most ${maxAgeSeconds} s)`);
  if (age < -maxAgeSeconds) throw new Error("the ETH/USD answer is from the future");
}

/** Where ETH/USD comes from: a checked, fresh answer, or a throw saying why there is none. */
export type EthUsdSource = () => Promise<EthUsd>;

/** ETH/USD from the Chainlink feed `feed` (default: the chain's ETH/USD), its age measured against the latest block's timestamp. */
export function chainlinkEthUsd(client: PublicClient, feed: Address = CHAINLINK_ETH_USD): EthUsdSource {
  return async () => {
    const [decimals, round] = await client.multicall({
      contracts: [
        { address: feed, abi: chainlinkAggregatorAbi, functionName: "decimals" },
        { address: feed, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" },
      ],
      allowFailure: false,
    });
    if (Number(decimals) !== CHAINLINK_ETH_USD_DECIMALS) throw new Error(`the ETH/USD feed has ${decimals} decimals, not ${CHAINLINK_ETH_USD_DECIMALS}`);
    const [roundId, answer, , updatedAt] = round as readonly [bigint, bigint, bigint, bigint, bigint];
    if (answer <= 0n) throw new Error("the ETH/USD answer is not positive");
    if (updatedAt === 0n) throw new Error("the ETH/USD round is not complete");
    const block = await client.getBlock({ blockTag: "latest" });
    const p = { answer, roundId, updatedAt };
    checkFresh(p, block.timestamp);
    return p;
  };
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

/** `wei` plus the margin, rounded up. */
export function withMargin(wei: bigint): bigint {
  return ceilDiv(wei * (BPS + RELAYER_MARGIN_BPS), BPS);
}

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError("decimals must be 0..18");
}

/**
 * Base units of a `decimals`-decimal USD stablecoin worth `wei` at the
 * Chainlink answer + ETH_USD_DEVIATION_BPS, rounded up (at least 1 for a
 * positive amount).
 */
export function weiToTokenUnits(wei: bigint, p: EthUsd, decimals: number): bigint {
  checkDecimals(decimals);
  if (wei <= 0n) return 0n;
  if (p.answer <= 0n) throw new RangeError("the ETH/USD answer must be positive");
  // units = wei / 10^18 * answer / 10^8 * (1 + deviation) * 10^decimals
  const numerator = wei * p.answer * (BPS + ETH_USD_DEVIATION_BPS) * 10n ** BigInt(decimals);
  const denominator = BPS * 10n ** BigInt(WEI_PER_ETH_EXP + CHAINLINK_ETH_USD_DECIMALS);
  const units = ceilDiv(numerator, denominator);
  return units > 0n ? units : 1n;
}

/** The most an agent pays for a quote whose price it computed as `expected` (RELAYER_QUOTE_TOLERANCE_BPS above, rounded up). */
export function maxAcceptedQuote(expected: bigint): bigint {
  if (expected < 0n) throw new RangeError("expected must not be negative");
  return ceilDiv(expected * (BPS + RELAYER_QUOTE_TOLERANCE_BPS), BPS);
}

// ---------------------------------------------------------------------------
// Measuring a transaction
// ---------------------------------------------------------------------------

/** A request the chain could not price: its transaction reverts. */
export class RelaySimulationError extends Error {
  readonly code: "simulation_failed";
  constructor(message: string) {
    super(message);
    this.name = "RelaySimulationError";
    this.code = "simulation_failed";
  }
}

export type RelayMeasure = { gas: bigint; gasPrice: bigint; wei: bigint };

/**
 * The gas of `tx` sent from `relayer` (eth_estimateGas, which reverts for a
 * transaction that would revert), the current gas price, and their product:
 * what the relayer pays for it. The relayer gate prices with it; an agent
 * checks a quote with it.
 */
export async function estimateRelay(client: PublicClient, a: { relayer: Address; to: Address; data: Hex }): Promise<RelayMeasure> {
  let gas: bigint;
  try {
    gas = await client.estimateGas({ account: a.relayer, to: a.to, data: a.data, value: 0n });
  } catch (err) {
    const e = err as { shortMessage?: string; message?: string };
    throw new RelaySimulationError(`the transaction reverts: ${e.shortMessage ?? e.message ?? String(err)}`);
  }
  const gasPrice = await client.getGasPrice();
  return { gas, gasPrice, wei: gas * gasPrice };
}

/** The request bytes of `calls` as an agent posts them: {"calls": [{"to", "data"}, ...]} (plus prepay and payer when set). */
export function relayRequestBody(calls: readonly RelayCall[], o: { prepay?: boolean; payer?: Address } = {}): string {
  const body: Record<string, unknown> = { calls: calls.map((c) => ({ to: getAddress(c.to), data: c.data })) };
  if (o.prepay !== undefined) body.prepay = o.prepay;
  if (o.payer !== undefined) body.payer = getAddress(o.payer);
  return JSON.stringify(body);
}
