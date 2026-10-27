// Quoting a vault Swap before the owner signs it (design v0.4: a signed
// spend always uses its key, so a Swap is quoted first and its minOut and
// swapGas come from the quote).
//
// The quote runs the exact spend the owner would sign: the same vault, pool,
// hook, sender, recipient and referrer, from the relayer's account, on the
// latest block one second later (simulateRelay), signed by a throwaway WOTS
// key whose key root replaces the vault's own in the simulation only (a state
// override of OstraVault.keyRoot, storage slot 5, checked against keyRoot()
// first). Nothing is signed with the owner's keys.
//
//   swapGas  the smallest swapGas that still swaps (a doubling then a binary
//            search), x 1.5 + 50,000 (tick crossings, graduation), within
//            VAULT_SWAP_GAS.MIN..MAX. The relayer charges what it reserves,
//            so it is kept close to what the swap needs.
//   minOut   what the swap gives at that swapGas, less slippageBps (default
//            100, at most 1,000).
//   band     on an Ostra pool, how much of the circuit breaker's room in the
//            swap's direction it uses; above 80% the quote is refused, since
//            a small price move would make the signed swap fail.

import { bytesToHex, decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, padHex, zeroAddress, type Address, type Hex, type Log, type PublicClient } from "viem";
import { ostraDevBuyAbi, ostraHookAbi, ostraLaunchpadAbi, ostraVaultAbi } from "./abi.ts";
import { LAUNCHPAD, UNISWAP_V4_POOL_MANAGER, VAULT_SWAP_GAS, WETH } from "./constants.ts";
import type { Deployment } from "./deployment.ts";
import { checkDevBuyTerms, launchFromVaultData, signVaultDevBuy, type DevBuyTerms, type LaunchParams } from "./launch.ts";
import { poolId, signVaultSpend, signVaultSwap, type SignedSpend, type SwapParams, type VaultKeyState } from "./messages.ts";
import { readVault } from "./reads.ts";
import { RelaySimulationError, relayTransaction, simulateRelay, type RelayCall } from "./relayer.ts";
import { WotsKeychain, randomBytes32, type WotsStore } from "./wots.ts";

/** OstraVault.keyRoot's storage slot (forge inspect OstraVault storageLayout: slot 5, below it EIP712's two strings, token, initialKeyRoot, initialCrank). */
export const VAULT_KEY_ROOT_SLOT: Hex = padHex("0x05", { size: 32 });
/** The PoolManager's `pools` mapping slot (v4-core StateLibrary.POOLS_SLOT). */
const POOLS_SLOT = 6n;
export const QUOTE_DEFAULT_SLIPPAGE_BPS = 100;
export const QUOTE_MAX_SLIPPAGE_BPS = 1_000;
/** Above this share of the circuit breaker's room (bps) a quote is refused. */
export const QUOTE_MAX_BAND_USE_BPS = 8_000;
const SWAP_GAS_SEARCH_STEP = 10_000n;

const poolManagerSwapEvent = [
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

/** A quote that cannot be signed: `code` says why (launch_fails: the launch reverts now). */
export class QuoteError extends Error {
  readonly code: "swap_fails" | "near_circuit_breaker" | "launch_fails" | "spend_fails" | "bad_request";
  constructor(code: QuoteError["code"], message: string) {
    super(message);
    this.name = "QuoteError";
    this.code = code;
  }
}
/** The swap quote's error (QuoteError). */
export const SwapQuoteError = QuoteError;
export type SwapQuoteError = QuoteError;

export type SwapQuote = {
  /** The params to sign: the request's, with minOut and swapGas from the quote. */
  swap: SwapParams & { minOut: bigint; swapGas: bigint };
  amountIn: bigint;
  amountOut: bigint;
  /** The smallest swapGas that swapped. */
  swapGasNeeded: bigint;
  /** Unix seconds the quote simulated at. */
  time: bigint;
  /** Ostra pools: the pool's tick before and after, the band edge in the swap's direction and the share of the room used (bps). */
  band: { tickBefore: number; tickAfter: number; edge: number; usedBps: number } | null;
};

type Run = { swapped: { amountIn: bigint; amountOut: bigint } | null; failedReason: Hex | null; logs: readonly Log[]; time: bigint };

const NO_STORE: WotsStore = { load: async () => undefined, saveIfAbsent: async () => true };

/**
 * `vault`'s spend at `nonce` as `sign` makes it, signed by a throwaway key
 * whose key root replaces the vault's own in the simulation only, run as
 * `call` sends it from `relayer` (simulateRelay).
 */
async function throwawayRun(
  client: PublicClient,
  a: { relayer: Address; vault: Address; nonce: bigint; sign: (k: WotsKeychain, s: VaultKeyState) => Promise<SignedSpend>; call: (s: SignedSpend) => { to: Address; data: Hex; value?: bigint } },
): Promise<{ gasUsed: bigint; logs: readonly Log[]; time: bigint }> {
  const throwaway = new WotsKeychain(randomBytes32(), randomBytes32(), NO_STORE);
  const keyRoot = bytesToHex(throwaway.keyRoot(a.nonce));
  const signed = await a.sign(throwaway, { vault: a.vault, nonce: a.nonce, keyRoot });
  return simulateRelay(client, { relayer: a.relayer, ...a.call(signed) }, { stateOverrides: [{ address: a.vault, stateDiff: [{ slot: VAULT_KEY_ROOT_SLOT, value: keyRoot }] }] });
}

/** Throws unless the vault's keyRoot is at the storage slot the quotes override. */
async function checkKeyRootSlot(client: PublicClient, vault: Address, keyRoot: Hex): Promise<void> {
  const stored = await client.getStorageAt({ address: vault, slot: VAULT_KEY_ROOT_SLOT });
  if ((stored ?? "0x").toLowerCase() !== keyRoot.toLowerCase()) throw new Error("the vault's keyRoot is not at the storage slot the quote overrides; the vault implementation changed");
}

/** One simulation of the vault's Swap with `swap`, signed by a throwaway key over a key-root override. */
async function run(client: PublicClient, d: Deployment, relayer: Address, vault: Address, nonce: bigint, token: Address, swap: SwapParams): Promise<Run> {
  const sim = await throwawayRun(client, {
    relayer,
    vault,
    nonce,
    sign: (k, s) => signVaultSwap(k, s, { chainId: d.chainId, token, swap }),
    call: (signed) => ({ to: vault, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [signed.action, signed.nextKeyRoot, signed.params, signed.signature] }) }),
  });
  let swapped: Run["swapped"] = null;
  let failedReason: Hex | null = null;
  for (const log of sim.logs) {
    if (getAddress(log.address) !== vault) continue;
    try {
      const e = decodeEventLog({ abi: ostraVaultAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
      if (e.eventName === "Swapped") {
        const args = e.args as { amountIn: bigint; amountOut: bigint };
        swapped = { amountIn: args.amountIn, amountOut: args.amountOut };
      } else if (e.eventName === "SwapFailed") {
        failedReason = (e.args as { reason: Hex }).reason;
      }
    } catch {
      // another event of the vault
    }
  }
  return { swapped, failedReason, logs: sim.logs, time: sim.time };
}

/** The pool's current tick (PoolManager slot0, as v4-core StateLibrary reads it). */
export async function poolTick(client: PublicClient, id: Hex): Promise<number> {
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, POOLS_SLOT]));
  const word = BigInt((await client.getStorageAt({ address: UNISWAP_V4_POOL_MANAGER, slot })) ?? "0x0");
  const raw = Number((word >> 160n) & 0xffffffn);
  return raw >= 0x800000 ? raw - 0x1000000 : raw;
}

/**
 * Quotes the Swap `swap` of `vault` (an Ostra vault of the deployment) as the
 * relayer `relayer` would send it, and returns the params to sign. Throws
 * SwapQuoteError when the swap cannot be signed now.
 */
export async function quoteVaultSwap(
  client: PublicClient,
  d: Deployment,
  a: { vault: Address; relayer: Address; swap: Omit<SwapParams, "minOut" | "swapGas">; slippageBps?: number },
): Promise<SwapQuote> {
  const slippageBps = a.slippageBps ?? QUOTE_DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > QUOTE_MAX_SLIPPAGE_BPS) {
    throw new SwapQuoteError("bad_request", `slippage must be 0..${QUOTE_MAX_SLIPPAGE_BPS} bps`);
  }
  const vault = getAddress(a.vault);
  const state = await readVault(client, d, vault);
  if (state === null) throw new SwapQuoteError("bad_request", `${vault} is not an Ostra vault of this deployment`);
  await checkKeyRootSlot(client, vault, state.keyRoot);
  const id = poolId(a.swap.key);
  const ostraPool = d.launchpad !== undefined && getAddress(a.swap.key.hooks) === d.launchpad.hook;
  const tickBefore = ostraPool ? await poolTick(client, id) : 0;
  const at = (swapGas: bigint) => run(client, d, a.relayer, vault, state.nonce, state.token, { ...a.swap, minOut: 0n, swapGas });

  const most = await at(BigInt(VAULT_SWAP_GAS.MAX));
  if (most.swapped === null) {
    throw new SwapQuoteError("swap_fails", `the swap fails now even with the most gas a Swap may sign${most.failedReason !== null ? ` (reason ${most.failedReason})` : ""}`);
  }
  // The smallest swapGas that swaps: double from MIN, then halve the gap.
  let lo = 0n;
  let hi = BigInt(VAULT_SWAP_GAS.MIN);
  while (hi < BigInt(VAULT_SWAP_GAS.MAX) && (await at(hi)).swapped === null) {
    lo = hi;
    hi = hi * 2n > BigInt(VAULT_SWAP_GAS.MAX) ? BigInt(VAULT_SWAP_GAS.MAX) : hi * 2n;
  }
  while (hi - lo > SWAP_GAS_SEARCH_STEP) {
    const mid = (lo + hi) / 2n;
    if ((await at(mid)).swapped !== null) hi = mid;
    else lo = mid;
  }
  const needed = hi;
  let swapGas = (needed * 3n) / 2n + 50_000n;
  if (swapGas > BigInt(VAULT_SWAP_GAS.MAX)) swapGas = BigInt(VAULT_SWAP_GAS.MAX);
  if (swapGas < BigInt(VAULT_SWAP_GAS.MIN)) swapGas = BigInt(VAULT_SWAP_GAS.MIN);
  const final = await at(swapGas);
  if (final.swapped === null) throw new SwapQuoteError("swap_fails", "the swap failed again at the quoted gas; the pool is moving, quote again");
  const minOut = (final.swapped.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut === 0n) throw new SwapQuoteError("swap_fails", "the swap gives nothing out at this amount");

  let band: SwapQuote["band"] = null;
  if (ostraPool) {
    let tickAfter = tickBefore;
    for (const log of final.logs) {
      if (getAddress(log.address) !== UNISWAP_V4_POOL_MANAGER) continue;
      try {
        const e = decodeEventLog({ abi: poolManagerSwapEvent, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        if (e.args.id.toLowerCase() === id.toLowerCase()) tickAfter = e.args.tick;
      } catch {
        // another PoolManager event
      }
    }
    const [lower, upper] = (await client.readContract({ address: d.launchpad!.hook, abi: ostraHookAbi, functionName: "txMoveBand", args: [id] })) as readonly [number, number];
    const edge = tickAfter >= tickBefore ? upper : lower;
    const room = Math.abs(edge - tickBefore);
    const usedBps = room === 0 ? 10_000 : Math.floor((Math.abs(tickAfter - tickBefore) * 10_000) / room);
    band = { tickBefore, tickAfter, edge, usedBps };
    if (usedBps > QUOTE_MAX_BAND_USE_BPS) {
      throw new SwapQuoteError(
        "near_circuit_breaker",
        `the swap uses ${(usedBps / 100).toFixed(1)}% of the price move the pool's circuit breaker allows in one transaction (at most ${QUOTE_MAX_BAND_USE_BPS / 100}% is signed); swap a smaller amount`,
      );
    }
  }
  return { swap: { ...a.swap, minOut, swapGas }, amountIn: final.swapped.amountIn, amountOut: final.swapped.amountOut, swapGasNeeded: needed, time: final.time, band };
}

export type LaunchQuote = {
  /** The token the launch makes (OstraDevBuy.tokenAddressFromVault) and its pool. */
  token: Address;
  poolId: Hex;
  /** Gas the launch used in the simulation (without the L1 data component). */
  gasUsed: bigint;
  /** Unix seconds the quote simulated at. */
  time: bigint;
  /** The dev buy as it happened in the simulation (null without one). */
  devBuy: { vesting: Address; quotePaid: bigint; tokens: bigint; cliffEnd: bigint; vestingEnd: bigint } | null;
};

/**
 * Runs the vault-funded launch `launch` with the dev buy `dev`
 * (OstraDevBuy.launchFromVault, with the launch fee) as the relayer
 * `relayer` would send it, signed by a throwaway key over a key-root override
 * of the creator vault, and returns what it makes. Throws QuoteError
 * launch_fails when it reverts now: nothing is to be signed then, since a
 * signed DevBuy that never lands blocks the vault's key.
 */
export async function quoteVaultLaunch(client: PublicClient, d: Deployment, a: { relayer: Address; launch: LaunchParams; dev: DevBuyTerms }): Promise<LaunchQuote> {
  const lp = d.launchpad;
  if (lp === undefined) throw new QuoteError("bad_request", "this deployment has no launchpad");
  const vault = getAddress(a.launch.creatorVault);
  const state = await readVault(client, d, vault);
  if (state === null) throw new QuoteError("bad_request", `the creator vault ${vault} is not an Ostra vault of this deployment`);
  const quote = getAddress(a.launch.quote);
  const vaultToken = quote === zeroAddress ? WETH : quote;
  if (state.token !== vaultToken) throw new QuoteError("bad_request", `the creator vault holds ${state.token}; this launch's creator vault holds ${vaultToken}`);
  try {
    checkDevBuyTerms(a.dev, getAddress(a.launch.dividendToken) !== zeroAddress);
  } catch (err) {
    throw new QuoteError("bad_request", (err as Error).message);
  }
  await checkKeyRootSlot(client, vault, state.keyRoot);
  const token = (await client.readContract({ address: lp.devBuy, abi: ostraDevBuyAbi, functionName: "tokenAddressFromVault", args: [a.launch] })) as Address;
  let sim;
  try {
    sim = await throwawayRun(client, {
      relayer: a.relayer,
      vault,
      nonce: state.nonce,
      sign: (k, s) => signVaultDevBuy(k, s, { chainId: d.chainId, devBuy: lp.devBuy, launch: a.launch, dev: a.dev }),
      call: (signed) => ({ to: lp.devBuy, data: launchFromVaultData(a.launch, a.dev, signed), value: LAUNCHPAD.FEE_WEI }),
    });
  } catch (err) {
    if (err instanceof RelaySimulationError && err.reverted) throw new QuoteError("launch_fails", `the launch fails now: ${err.message}`);
    throw err;
  }
  let launched: { poolId: Hex; token: Address } | null = null;
  let devBuy: LaunchQuote["devBuy"] = null;
  for (const log of sim.logs) {
    const at = getAddress(log.address);
    try {
      if (at === lp.launchpad) {
        const e = decodeEventLog({ abi: ostraLaunchpadAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        if (e.eventName === "Launched") {
          const args = e.args as unknown as { poolId: Hex; token: Address };
          launched = { poolId: args.poolId, token: getAddress(args.token) };
        }
      } else if (at === lp.devBuy) {
        const e = decodeEventLog({ abi: ostraDevBuyAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        if (e.eventName === "DevBought") {
          const args = e.args as unknown as { vesting: Address; quotePaid: bigint; tokens: bigint; cliffEnd: bigint; vestingEnd: bigint };
          devBuy = { vesting: getAddress(args.vesting), quotePaid: args.quotePaid, tokens: args.tokens, cliffEnd: args.cliffEnd, vestingEnd: args.vestingEnd };
        }
      }
    } catch {
      // another event
    }
  }
  if (launched === null || launched.token !== getAddress(token)) throw new Error("the simulated launch did not make the token OstraDevBuy predicts");
  if ((a.dev.quoteIn === 0n) !== (devBuy === null)) throw new Error("the simulated launch's dev buy is not the one asked for");
  return { token: launched.token, poolId: launched.poolId, gasUsed: sim.gasUsed, time: sim.time, devBuy };
}

/**
 * Runs `vault`'s spend of `action` with `params` (OstraVault.spend, from
 * `relayer`) signed by a throwaway key over a key-root override, before the
 * owner signs it: the gas it uses and its logs. Throws QuoteError spend_fails
 * when it reverts now (a signed spend that cannot land blocks the vault's
 * key until it can).
 */
export async function simulateVaultSpend(
  client: PublicClient,
  d: Deployment,
  a: { relayer: Address; vault: Address; action: number; params: Hex },
): Promise<{ gasUsed: bigint; logs: readonly Log[]; time: bigint }> {
  const vault = getAddress(a.vault);
  const state = await readVault(client, d, vault);
  if (state === null) throw new QuoteError("bad_request", `${vault} is not an Ostra vault of this deployment`);
  await checkKeyRootSlot(client, vault, state.keyRoot);
  try {
    return await throwawayRun(client, {
      relayer: a.relayer,
      vault,
      nonce: state.nonce,
      sign: (k, s) => signVaultSpend(k, s, { chainId: d.chainId, action: a.action as never, params: a.params }),
      call: (signed) => ({ to: vault, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [signed.action, signed.nextKeyRoot, signed.params, signed.signature] }) }),
    });
  } catch (err) {
    if (err instanceof RelaySimulationError && err.reverted) throw new QuoteError("spend_fails", `the vault operation fails now: ${err.message}`);
    throw err;
  }
}

/**
 * `vault`'s spend (action, params) followed by the calls `then`, in one relayed transaction (Multicall3) as the relayer
 * sends it, simulated with a throwaway key as simulateVaultSpend does: an EIP-1271 approval and the call it
 * authorizes (Ostrapad), for one. Throws QuoteError spend_fails when the transaction reverts.
 */
export async function simulateVaultSpendThen(
  client: PublicClient,
  d: Deployment,
  a: { relayer: Address; vault: Address; action: number; params: Hex; then: readonly RelayCall[] },
): Promise<{ gasUsed: bigint; logs: readonly Log[]; time: bigint }> {
  if (a.then.length === 0) throw new QuoteError("bad_request", "no call follows the spend");
  const vault = getAddress(a.vault);
  const state = await readVault(client, d, vault);
  if (state === null) throw new QuoteError("bad_request", `${vault} is not an Ostra vault of this deployment`);
  await checkKeyRootSlot(client, vault, state.keyRoot);
  try {
    return await throwawayRun(client, {
      relayer: a.relayer,
      vault,
      nonce: state.nonce,
      sign: (k, s) => signVaultSpend(k, s, { chainId: d.chainId, action: a.action as never, params: a.params }),
      call: (signed) =>
        relayTransaction([
          { to: vault, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [signed.action, signed.nextKeyRoot, signed.params, signed.signature] }) },
          ...a.then,
        ]),
    });
  } catch (err) {
    if (err instanceof RelaySimulationError && err.reverted) throw new QuoteError("spend_fails", `the vault operation fails now: ${err.message}`);
    throw err;
  }
}
