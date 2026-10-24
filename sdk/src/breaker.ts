// OstraBreaker (src/OstraBreaker.sol), Strategy 3: an automatic way out of a Morpho Vault V2 for an Ostra vault that
// lends into one. The vault makes the breaker a guardian, approves its limits for the Vault V2 (an EIP-1271 approval,
// ApproveHash, of breakerLimitsHash) and turns its withdrawal lock on, in that order: guardians cannot change under
// the lock, turning the lock on drops earlier approvals, and an approval made under the lock waits its delay. Then
// anyone may call trip(vault, target), which redeems the vault's shares back into the vault when a limit is crossed
// on chain (ASSETS, UTILIZATION and LIQUIDITY only on state settled from an earlier block, so a flash loan cannot
// trip them; the first trip in a second keeps what it read, so every watching vault can leave in that second). These
// are the reads and the hash; signing and sending the spends is the agent's (core).

import { encodeAbiParameters, getAddress, keccak256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { ostraBreakerAbi } from "./abi.ts";

/** The limits a vault approves for one Vault V2, in basis points; 0 turns a limit off (OstraBreaker.Limits). */
export type BreakerLimits = {
  /** The share price fell more than this below its highest mark. */
  priceDropBps: number;
  /** The Vault V2's totalAssets fell more than this below its total when the limits were signed (assetsMarkCap): a run. */
  assetsDropBps: number;
  /** The liquidity market is used at least this much. */
  maxUtilizationBps: number;
  /** What the Vault V2 can pay out now is below this many basis points of the vault's position (20_000: twice it). */
  minLiquidityBps: number;
  /**
   * The assets mark, in the Vault V2's asset units (0 only with assetsDropBps 0): the vault signs its totalAssets
   * when it signs (breakerLimitsFor), so a run is measured from the signing and a deposit made only to raise the mark
   * cannot. An approval that was never sent stays valid at its nonce: before signing replacement limits, withdraw
   * the older approval (ApproveHash, false), or an old cap above today's total can be sent and trip the vault.
   */
  assetsMarkCap: bigint;
};

/**
 * The limits Ostra proposes (Strategy 3): a share price 0.1% below its mark (a realized loss: a Vault V2's price only
 * falls on a loss, or a management fee larger than its interest, which 0.1% leaves room for), a 20% run on the vault
 * since the limits were signed, the liquidity market at 99% use (the planner's own exit rule), and less than twice
 * the position payable now.
 */
export const DEFAULT_BREAKER_LIMITS: Readonly<Omit<BreakerLimits, "assetsMarkCap">> = { priceDropBps: 10, assetsDropBps: 2_000, maxUtilizationBps: 9_900, minLiquidityBps: 20_000 };

/** `limits` (default DEFAULT_BREAKER_LIMITS) with the assets mark capped at `totalAssets`, the Vault V2's total read when the vault signs. */
export function breakerLimitsFor(totalAssets: bigint, limits: Omit<BreakerLimits, "assetsMarkCap"> = DEFAULT_BREAKER_LIMITS): BreakerLimits {
  const l: BreakerLimits = { ...limits, assetsMarkCap: limits.assetsDropBps === 0 ? 0n : totalAssets };
  checkBreakerLimits(l);
  return l;
}

/** The reasons a trip reports (OstraBreaker.PRICE, ASSETS, UTILIZATION, LIQUIDITY). */
export const BREAKER_REASON = { PRICE: 1, ASSETS: 2, UTILIZATION: 4, LIQUIDITY: 8 } as const;

/** OstraBreaker's bounds on the limits. */
export const BREAKER_BPS = 10_000;
export const BREAKER_MAX_LIQUIDITY_BPS = 1_000_000;

const DOMAIN = stringToHex("OSTRA/BREAKER/EVM/v1", { size: 20 });

/** Throws unless `l` is limits OstraBreaker accepts (all four 0: stop watching). */
export function checkBreakerLimits(l: BreakerLimits): void {
  const whole = (x: number, max: number, what: string, inclusive: boolean) => {
    if (!Number.isSafeInteger(x) || x < 0 || (inclusive ? x > max : x >= max)) throw new RangeError(`${what} must be an integer from 0 to ${inclusive ? max : max - 1}`);
  };
  whole(l.priceDropBps, BREAKER_BPS, "priceDropBps", false);
  whole(l.assetsDropBps, BREAKER_BPS, "assetsDropBps", false);
  whole(l.maxUtilizationBps, BREAKER_BPS, "maxUtilizationBps", true);
  whole(l.minLiquidityBps, BREAKER_MAX_LIQUIDITY_BPS, "minLiquidityBps", true);
  if (typeof l.assetsMarkCap !== "bigint" || l.assetsMarkCap < 0n || l.assetsMarkCap >= 2n ** 128n) throw new RangeError("assetsMarkCap must be a uint128");
  if (l.assetsDropBps !== 0 && l.assetsMarkCap === 0n) throw new RangeError("a run limit (assetsDropBps) needs an assetsMarkCap");
}

/** The hash `vault` approves (ApproveHash) for `limits` on `target` at the nonce `nonce` of that vault and target (OstraBreaker.limitsHash). */
export function breakerLimitsHash(chainId: number, breaker: Address, vault: Address, target: Address, limits: BreakerLimits, nonce: bigint): Hex {
  checkBreakerLimits(limits);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes20" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "tuple", components: [{ type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "uint128" }] },
        { type: "uint64" },
      ],
      [DOMAIN, BigInt(chainId), breaker, vault, target, [limits.priceDropBps, limits.assetsDropBps, limits.maxUtilizationBps, limits.minLiquidityBps, limits.assetsMarkCap], nonce],
    ),
  );
}

/** What OstraBreaker.check reads now, with the vault's watch and nonce. */
export type BreakerState = {
  breaker: Address;
  vault: Address;
  target: Address;
  limits: BreakerLimits;
  watched: boolean;
  /** The next nonce the vault's limits for this target are signed for. */
  nonce: bigint;
  price: bigint;
  priceMark: bigint;
  totalAssets: bigint;
  assetsMark: bigint;
  utilizationBps: bigint;
  hasLiquidityMarket: boolean;
  /** What the Vault V2 can pay out now (its idle assets and the liquidity adapter's share of its market's free liquidity). */
  payout: bigint;
  shares: bigint;
  position: bigint;
  /** The Vault V2, or its liquidity market, was touched in this block's second: then only PRICE counts, unless a trip this second kept a snapshot. */
  vaultTouched: boolean;
  marketTouched: boolean;
  /** ASSETS, UTILIZATION and LIQUIDITY were judged on the snapshot a trip took earlier in this second (totalAssets, utilizationBps and payout here stay the live readings). */
  fromSnapshot: boolean;
  /** The limits crossed now (BREAKER_REASON bits), against the price mark as it stands. */
  reasons: number;
};

/** Reads OstraBreaker's view of `vault` lending into `target`. */
export async function readBreaker(client: PublicClient, breaker: Address, vault: Address, target: Address, opts: { blockNumber?: bigint } = {}): Promise<BreakerState> {
  const at = opts.blockNumber === undefined ? {} : { blockNumber: opts.blockNumber };
  const [w, s, nonce] = await Promise.all([
    client.readContract({ address: breaker, abi: ostraBreakerAbi, functionName: "watchOf", args: [vault, target], ...at }),
    client.readContract({ address: breaker, abi: ostraBreakerAbi, functionName: "check", args: [vault, target], ...at }),
    client.readContract({ address: breaker, abi: ostraBreakerAbi, functionName: "nonces", args: [vault, target], ...at }),
  ]);
  const limits: BreakerLimits = {
    priceDropBps: Number(w.limits.priceDropBps),
    assetsDropBps: Number(w.limits.assetsDropBps),
    maxUtilizationBps: Number(w.limits.maxUtilizationBps),
    minLiquidityBps: Number(w.limits.minLiquidityBps),
    assetsMarkCap: w.limits.assetsMarkCap,
  };
  return {
    breaker: getAddress(breaker),
    vault: getAddress(vault),
    target: getAddress(target),
    limits,
    watched: limits.priceDropBps !== 0 || limits.assetsDropBps !== 0 || limits.maxUtilizationBps !== 0 || limits.minLiquidityBps !== 0,
    nonce: BigInt(nonce),
    price: s.price,
    priceMark: s.priceMark,
    totalAssets: s.totalAssets,
    assetsMark: s.assetsMark,
    utilizationBps: s.utilizationBps,
    hasLiquidityMarket: s.hasLiquidityMarket,
    payout: s.payout,
    shares: s.shares,
    position: s.position,
    vaultTouched: s.vaultTouched,
    marketTouched: s.marketTouched,
    fromSnapshot: s.fromSnapshot,
    reasons: Number(s.reasons),
  };
}

/** The names of the reasons in `bits` (BREAKER_REASON). */
export function breakerReasons(bits: number): string[] {
  return Object.entries(BREAKER_REASON)
    .filter(([, b]) => (bits & b) !== 0)
    .map(([name]) => name.toLowerCase());
}
