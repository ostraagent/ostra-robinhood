// A launch on the Ostra launchpad paid from the creator's vault
// (OstraDevBuy.launchFromVault): the creator vault signs one DevBuy spend
// (OstraVault action 9) of abi.encode(devBuy, launchHash(p, d), d.quoteIn),
// and OstraDevBuy sends that spend itself inside the launch, so the vault pays
// its dev buy (d.quoteIn; 0: a launch without one) into exactly the launch it
// signed, whoever submits it. The caller pays the launch fee in ETH
// (LAUNCHPAD.FEE_WEI): the Ostra relayer fronts it and charges it in USDG.
//
// launchHash is OstraDevBuy.launchHash, keccak256(abi.encode(p, d)), encoded
// here from the contract's own ABI; the fork tests compare it with the
// contract's view for every launch they sign.

import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, zeroAddress, type Address, type ContractFunctionArgs, type Hex } from "viem";
import { ostraDevBuyAbi } from "./abi.ts";
import { CIRCUIT_BREAKER, DEV_BUY, LAUNCHPAD, VAULT_ACTION } from "./constants.ts";
import { signVaultSpend, type SignedSpend, type VaultKeyState } from "./messages.ts";
import type { WotsKeychain } from "./wots.ts";

type LaunchHashArgs = ContractFunctionArgs<typeof ostraDevBuyAbi, "pure", "launchHash">;
/** OstraLaunchpad.LaunchParams, as the contract's ABI types it. */
export type LaunchParams = LaunchHashArgs[0];
/** OstraDevBuy.DevBuy: quoteIn of the pool's quote (0: no dev buy), the vesting's beneficiary, dividend recipient, cliff and duration. */
export type DevBuyTerms = LaunchHashArgs[1];

/** A launch without a dev buy: every field 0 (OstraDevBuy refuses any other field set when quoteIn is 0). */
export const NO_DEV_BUY: DevBuyTerms = { quoteIn: 0n, beneficiary: zeroAddress, dividendRecipient: zeroAddress, cliff: 0, duration: 0 };

const LAUNCH_HASH_INPUTS = (ostraDevBuyAbi.find((x) => x.type === "function" && x.name === "launchHash") as { inputs: readonly unknown[] }).inputs;
const DEV_BUY_PARAMS_TYPES = [{ type: "address" }, { type: "bytes32" }, { type: "uint256" }] as const;

/** abi.encode(p, d): what launchHash hashes, kept to send a signed launch again (the launch hash proves it). */
export function encodeLaunch(p: LaunchParams, d: DevBuyTerms): Hex {
  return encodeAbiParameters(LAUNCH_HASH_INPUTS as never, [p, d] as never);
}

/** Reads encodeLaunch back. */
export function decodeLaunch(encoded: Hex): { launch: LaunchParams; dev: DevBuyTerms } {
  const [launch, dev] = decodeAbiParameters(LAUNCH_HASH_INPUTS as never, encoded) as unknown as [LaunchParams, DevBuyTerms];
  return { launch, dev };
}

/** OstraDevBuy.launchHash(p, d): keccak256(abi.encode(p, d)). */
export function launchHash(p: LaunchParams, d: DevBuyTerms): Hex {
  return keccak256(encodeLaunch(p, d));
}

/** The bounds OstraDevBuy checks on a dev buy, refused here before anything is signed. */
export function checkDevBuyTerms(d: DevBuyTerms, dividends: boolean): void {
  if (d.quoteIn === 0n) {
    if (d.beneficiary !== zeroAddress || d.dividendRecipient !== zeroAddress || d.cliff !== 0 || d.duration !== 0) {
      throw new RangeError("a launch without a dev buy has every other dev buy field 0");
    }
    return;
  }
  if (d.quoteIn < 0n) throw new RangeError("quoteIn must be positive");
  if (getAddress(d.beneficiary) === zeroAddress) throw new RangeError("the dev buy needs a beneficiary (the creator's token vault)");
  if (dividends && getAddress(d.dividendRecipient) === zeroAddress) throw new RangeError("the pool pays dividends: the dev buy needs a dividend recipient");
  if (d.cliff < DEV_BUY.MIN_CLIFF || d.cliff > DEV_BUY.MAX_CLIFF) throw new RangeError(`the cliff must be ${DEV_BUY.MIN_CLIFF}..${DEV_BUY.MAX_CLIFF} seconds`);
  if (d.duration < 0 || d.duration > DEV_BUY.MAX_VESTING) throw new RangeError(`the vesting must be 0..${DEV_BUY.MAX_VESTING} seconds`);
}

/** DevBuy params: abi.encode(address devBuy, bytes32 launchHash, uint256 amount). */
export function devBuyParams(a: { devBuy: Address; launchHash: Hex; amount: bigint }): Hex {
  if (BigInt(a.launchHash) === 0n) throw new RangeError("launchHash must not be zero");
  if (a.amount < 0n) throw new RangeError("amount must not be negative");
  return encodeAbiParameters(DEV_BUY_PARAMS_TYPES, [getAddress(a.devBuy), a.launchHash, a.amount]);
}

/** Reads DevBuy params back; throws on anything OstraVault would refuse or encode differently. */
export function decodeDevBuyParams(params: Hex): { devBuy: Address; launchHash: Hex; amount: bigint } {
  if (!/^0x[0-9a-fA-F]{192}$/.test(params)) throw new RangeError("DevBuy params must be 96 bytes");
  const [devBuy, hash, amount] = decodeAbiParameters(DEV_BUY_PARAMS_TYPES, params);
  const out = { devBuy: getAddress(devBuy), launchHash: hash, amount };
  if (devBuyParams(out).toLowerCase() !== params.toLowerCase()) throw new RangeError("DevBuy params are not canonically encoded");
  return out;
}

/** The creator vault's DevBuy spend for the launch `p` with the dev buy `d` (the vault is p.creatorVault). */
export async function signVaultDevBuy(
  keychain: WotsKeychain,
  state: VaultKeyState,
  a: { chainId: number; devBuy: Address; launch: LaunchParams; dev: DevBuyTerms },
): Promise<SignedSpend> {
  if (getAddress(a.launch.creatorVault) !== getAddress(state.vault)) throw new RangeError("a vault-funded launch is signed by its creator vault");
  const params = devBuyParams({ devBuy: a.devBuy, launchHash: launchHash(a.launch, a.dev), amount: a.dev.quoteIn });
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.DEV_BUY, params });
}

/** The calldata of OstraDevBuy.launchFromVault for the signed DevBuy spend; sent with the launch fee as value. */
export function launchFromVaultData(p: LaunchParams, d: DevBuyTerms, signed: Pick<SignedSpend, "nextKeyRoot" | "signature">): Hex {
  return encodeFunctionData({ abi: ostraDevBuyAbi, functionName: "launchFromVault", args: [p, d, signed.nextKeyRoot, signed.signature] });
}

/** Reads the calldata of OstraDevBuy.launchFromVault back; throws on any other call. */
export function decodeLaunchFromVaultData(data: Hex): { launch: LaunchParams; dev: DevBuyTerms; nextKeyRoot: Hex; signature: Hex } {
  const decoded = decodeFunctionData({ abi: ostraDevBuyAbi, data });
  if (decoded.functionName !== "launchFromVault") throw new RangeError(`not a launchFromVault call (${decoded.functionName})`);
  const [launch, dev, nextKeyRoot, signature] = decoded.args as unknown as [LaunchParams, DevBuyTerms, Hex, Hex];
  return { launch, dev, nextKeyRoot, signature };
}

/** OstraHook graduation kinds: when the share of the supply sold (bps) or the quote raised (base units) reaches the threshold. */
export const GRADUATION = { TOKENS_SOLD: 1, QUOTE_RAISED: 2 } as const;

/**
 * The pool's starting tick for a starting market cap of `marketCap` base
 * units of the quote (the whole supply at the starting price): the tick of
 * the token's price in the quote, raw unit for raw unit, rounded down to the
 * tick spacing. 50,000 USDG (50_000_000_000n) gives -375,400.
 */
export function startTickForMarketCap(marketCap: bigint): number {
  if (marketCap <= 0n) throw new RangeError("the market cap must be positive");
  // The price of one token base unit in quote base units: marketCap / SUPPLY.
  const price = Number(marketCap) / Number(LAUNCHPAD.SUPPLY);
  if (!Number.isFinite(price) || price <= 0) throw new RangeError("the market cap is out of range");
  const tick = Math.log(price) / Math.log(1.0001);
  return Math.floor(tick / LAUNCHPAD.TICK_SPACING) * LAUNCHPAD.TICK_SPACING;
}

/**
 * A launch with Ostra's defaults for what the caller does not set: three
 * tiers (40% over 40,000 ticks, 30% over the next 40,000, 30% open to the top),
 * no taxes, no buckets, no dividends, no anti-snipe, no max buy or max wallet,
 * no anti-farmer, the volatility fee off, the circuit breaker at
 * CIRCUIT_BREAKER.DEFAULT_TICKS, graduation when 80% of the supply is sold.
 */
export function launchParams(a: { name: string; symbol: string; salt: Hex; quote: Address; creatorVault: Address; startTick: number } & Partial<LaunchParams>): LaunchParams {
  const zeroKey = { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress };
  return {
    tiers: [
      { width: 40_000, supplyBps: 4_000 },
      { width: 40_000, supplyBps: 3_000 },
      { width: 0, supplyBps: 3_000 },
    ],
    buyTaxBps: 0,
    sellTaxBps: 0,
    postBuyTaxBps: 0,
    postSellTaxBps: 0,
    taxDuration: 0,
    creatorBucketBps: 0,
    dividendBucketBps: 0,
    burnBucketBps: 0,
    lpBucketBps: 0,
    floorBucketBps: 0,
    dividendToken: zeroAddress,
    dividendKey: zeroKey,
    minDividendBalance: 0n,
    antiSnipeBps: 0,
    antiSnipeDuration: 0,
    maxBuy: 0n,
    maxWallet: 0n,
    limitsDuration: 0,
    antiFarmerDuration: 0,
    graduationKind: GRADUATION.TOKENS_SOLD,
    graduationThreshold: 8_000n,
    volatilityFee: false,
    maxTxMoveTicks: CIRCUIT_BREAKER.DEFAULT_TICKS,
    ...a,
    quote: getAddress(a.quote),
    creatorVault: getAddress(a.creatorVault),
  };
}
