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
//   wei       the gas the transaction uses, simulated from the relayer
//             (eth_simulateV1: what a receipt's gasUsed shows, without the
//             L1 data component on Robinhood Chain), plus its L1 data
//             component (NodeInterface.gasEstimateL1Component), plus the
//             swapGas every vault Swap in it signed, times eth_gasPrice at
//             the quote. A Swap runs code the agent picks (the pool's hook,
//             the output token, an ETH recipient), which can use little gas
//             in a simulation and all of its swapGas when sent: so the
//             swapGas it reserves is paid in full, the bound of what it can
//             use, and an agent signs a swapGas close to what its swap needs.
//             With swapGas, a Swap counts the gas limit headroom its check
//             needs (swapGas / 63 + VAULT_SWAP_GAS_RESERVE). The relayer
//             sends the transaction with a gas limit of at most that gas +
//             RELAYER_MARGIN_BPS (relayGasCap): code that uses more when sent
//             than it did simulated cannot make the relayer pay more gas than
//             it was paid for.
//             Not eth_estimateGas otherwise: that is a gas limit, above what
//             the transaction uses. There is no rent and nothing comes back
//             to the relayer, so nothing is refunded.
//   value     the ETH the transaction sends (relayValue): a vault-funded
//             launch carries the launch fee, which the relayer fronts.
//   price     wei + RELAYER_MARGIN_BPS, plus value, at the Chainlink price +
//             ETH_USD_DEVIATION_BPS (the feed's deviation threshold), rounded
//             up to the token's smallest unit. The token is a USD stablecoin,
//             counted as 1 USD.

import {
  concat,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  toEventSelector,
  toFunctionSelector,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import {
  ostraAirdropAbi,
  ostraCreatorSplitAbi,
  ostraDevBuyAbi,
  ostraDispatcherAbi,
  ostraHookAbi,
  ostraLaunchpadAbi,
  ostraPoolAbi,
  ostraTokenAbi,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  ostraVestingAbi,
} from "./abi.ts";
import { ARBITRUM_NODE_INTERFACE, CHAINLINK_ETH_USD, CHAINLINK_ETH_USD_DECIMALS, LAUNCHPAD, MULTICALL3, VAULT_ACTION, VAULT_SWAP_GAS, VAULT_SWAP_GAS_RESERVE } from "./constants.ts";
import type { Deployment } from "./deployment.ts";
import { decodeSwapParams } from "./messages.ts";
import { chainlinkAggregatorAbi, multicall3Abi, nodeInterfaceAbi } from "./external-abi.ts";

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
  return relayTransactionHash(relayTransaction(calls));
}

/** The request hash of the relay transaction `tx` itself: keccak256(to || data). */
export function relayTransactionHash(tx: { to: Address; data: Hex }): Hex {
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

/**
 * A request the chain could not price: its transaction reverts (`reverted`,
 * code simulation_failed), or the node could not simulate it at all (code
 * simulation_unavailable: worth trying again).
 */
export class RelaySimulationError extends Error {
  readonly code: "simulation_failed" | "simulation_unavailable";
  readonly reverted: boolean;
  constructor(message: string, reverted = true) {
    super(message);
    this.name = "RelaySimulationError";
    this.reverted = reverted;
    this.code = reverted ? "simulation_failed" : "simulation_unavailable";
  }
}

/** Every error Ostra's contracts define, to name a revert by. */
const OSTRA_ERRORS = [
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  ostraPoolAbi,
  ostraLaunchpadAbi,
  ostraDevBuyAbi,
  ostraHookAbi,
  ostraTokenAbi,
  ostraAirdropAbi,
  ostraVestingAbi,
  ostraDispatcherAbi,
  ostraCreatorSplitAbi,
].flatMap((abi) => (abi as readonly { type: string }[]).filter((x) => x.type === "error"));

/** The revert `data` as the Ostra error it is ("BadParams(buckets)"), or null when it is none of them. */
export function ostraRevertReason(data: Hex | undefined): string | null {
  if (data === undefined || data.length < 10) return null;
  try {
    const e = decodeErrorResult({ abi: OSTRA_ERRORS as never, data });
    const args = (e.args ?? []) as readonly unknown[];
    return `${e.errorName}(${args.map((a) => String(a)).join(", ")})`;
  } catch {
    return null;
  }
}

export type RelayMeasure = {
  /** Gas the transaction is priced at: its simulated execution, its L1 data component and the swapGas its Swaps reserve. */
  gas: bigint;
  gasPrice: bigint;
  /** gas x gasPrice: what the gas costs the relayer at most. */
  wei: bigint;
  /** ETH the transaction sends (relayValue: a vault-funded launch's fee the relayer fronts). */
  value: bigint;
  /** The logs the simulated transaction emits (see failedSwaps). */
  logs: readonly Log[];
};

/**
 * The gas a transaction to `to` with `data` pays for its L1 data on Robinhood
 * Chain (NodeInterface.gasEstimateL1Component). 0 on a chain without the
 * NodeInterface, such as an anvil fork: the call returns no data there (the
 * live chain always answers, relayer.fork.test.ts). A failing call throws.
 */
export async function l1DataGas(client: PublicClient, to: Address, data: Hex): Promise<bigint> {
  const res = await client.call({
    to: ARBITRUM_NODE_INTERFACE,
    data: encodeFunctionData({ abi: nodeInterfaceAbi, functionName: "gasEstimateL1Component", args: [to, false, data] }),
  });
  if (res.data === undefined || res.data === "0x") return 0n;
  const [gasForL1] = decodeFunctionResult({ abi: nodeInterfaceAbi, functionName: "gasEstimateL1Component", data: res.data });
  return gasForL1;
}

/** A relay transaction as the relayer sends it: from its account, with the value relayValue gives it. */
export type RelayTxInput = { relayer: Address; to: Address; data: Hex; value?: bigint };

/**
 * `tx` sent from `relayer`, simulated (eth_simulateV1) on the latest block,
 * one second after it (the time it would land; a node otherwise picks its own
 * later time, and time moves anti-snipe, taxes, limits and fees): the gas it
 * uses without the L1 data component, and the logs it emits. A transaction
 * that would revert throws RelaySimulationError (reverted); one the node
 * cannot simulate (an RPC error, a node without eth_simulateV1) throws it with
 * reverted false. `stateOverrides` (quotes only) change the state it runs on.
 */
export async function simulateRelay(
  client: PublicClient,
  a: RelayTxInput,
  o: { stateOverrides?: { address: Address; stateDiff?: { slot: Hex; value: Hex }[] }[] } = {},
): Promise<{ gasUsed: bigint; logs: readonly Log[]; time: bigint }> {
  try {
    const head = await client.getBlock({ blockTag: "latest" });
    const time = head.timestamp + 1n;
    const [block] = await client.simulateBlocks({
      blockNumber: head.number,
      blocks: [
        {
          blockOverrides: { time },
          ...(o.stateOverrides !== undefined ? { stateOverrides: o.stateOverrides } : {}),
          calls: [{ account: a.relayer, to: a.to, data: a.data, ...(a.value !== undefined && a.value !== 0n ? { value: a.value } : {}) }],
        },
      ],
    });
    const call = block?.calls[0];
    if (call === undefined) throw new Error("the node returned no simulated call");
    if (call.status !== "success") {
      const e = call.error as { shortMessage?: string; message?: string } | undefined;
      const named = ostraRevertReason(call.data);
      throw new RelaySimulationError(`the transaction reverts: ${named ?? e?.shortMessage ?? e?.message ?? "no reason given"}`);
    }
    return { gasUsed: call.gasUsed, logs: call.logs ?? [], time };
  } catch (err) {
    if (err instanceof RelaySimulationError) throw err;
    const e = err as { shortMessage?: string; message?: string };
    throw new RelaySimulationError(`the transaction cannot be simulated: ${e.shortMessage ?? e.message ?? String(err)}`, false);
  }
}

/**
 * The swapGas each vault Swap among the calls of the relay transaction `tx`
 * (one call, or Multicall3 aggregate3) signed. A call with the spend selector
 * that does not decode, or a Swap whose params do not, counts
 * VAULT_SWAP_GAS.MAX.
 */
export function swapGasOf(tx: { to: Address; data: Hex }): bigint[] {
  let calls: readonly Hex[] = [tx.data];
  if (getAddress(tx.to) === MULTICALL3) {
    try {
      const d = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
      if (d.functionName === "aggregate3") calls = (d.args[0] as readonly { callData: Hex }[]).map((c) => c.callData);
    } catch {
      calls = [];
    }
  }
  const out: bigint[] = [];
  for (const data of calls) {
    if (data.slice(0, 10).toLowerCase() !== SPEND_SELECTOR) continue;
    let spend: { args: readonly unknown[] };
    try {
      spend = decodeFunctionData({ abi: ostraVaultAbi, data }) as typeof spend;
    } catch {
      out.push(BigInt(VAULT_SWAP_GAS.MAX));
      continue;
    }
    if (Number(spend.args[0]) !== VAULT_ACTION.SWAP) continue;
    try {
      out.push(decodeSwapParams(spend.args[2] as Hex).swapGas ?? BigInt(VAULT_SWAP_GAS.DEFAULT));
    } catch {
      out.push(BigInt(VAULT_SWAP_GAS.MAX));
    }
  }
  return out;
}

/**
 * The gas the vault Swaps of the relay transaction `tx` reserve, added up:
 * each its swapGas (swapGasOf) and the gas limit its check needs beyond it
 * (swapGas / 63 + VAULT_SWAP_GAS_RESERVE), so that the gas limit cap
 * (relayGasCap) stays within what the transaction was priced at.
 */
export function reservedSwapGas(tx: { to: Address; data: Hex }): bigint {
  return swapGasOf(tx).reduce((a, g) => a + g + g / 63n + 1n + BigInt(VAULT_SWAP_GAS_RESERVE), 0n);
}

/**
 * The most gas the relayer sends a transaction with when it was priced at
 * `gas` (estimateRelay): `gas` plus RELAYER_MARGIN_BPS, which leaves room
 * for the 63/64 of each nested call and the L1 component moving. Whatever the
 * code a call runs does when sent, the relayer pays at most this much gas,
 * what it was paid for at the quote's gas price; a transaction that needs
 * more than this limit now is not sent.
 */
export function relayGasCap(gas: bigint): bigint {
  return withMargin(gas);
}

const SPEND_SELECTOR = toFunctionSelector(ostraVaultAbi.find((x) => x.type === "function" && x.name === "spend") as Parameters<typeof toFunctionSelector>[0]).toLowerCase();

/**
 * The gas `tx` is priced at sent from `relayer`: what it uses (simulateRelay),
 * its L1 data component and the swapGas its Swaps reserve (reservedSwapGas);
 * the current gas price, their product (what the relayer pays for it at
 * most), and the logs it emits. The relayer gate prices with it; an agent
 * checks a quote with it.
 */
export async function estimateRelay(client: PublicClient, a: RelayTxInput): Promise<RelayMeasure> {
  const { gasUsed, logs } = await simulateRelay(client, a);
  const [l1, gasPrice] = await Promise.all([l1DataGas(client, a.to, a.data), client.getGasPrice()]);
  const gas = gasUsed + l1 + reservedSwapGas(a);
  return { gas, gasPrice, wei: gas * gasPrice, value: a.value ?? 0n, logs };
}

/** What a relay of `m` is charged in wei before conversion: its gas with RELAYER_MARGIN_BPS, plus the ETH it sends (no margin on that). */
export function relayPriceWei(m: { wei: bigint; value: bigint }): bigint {
  return withMargin(m.wei) + m.value;
}

const LAUNCH_FROM_VAULT_SELECTOR = toFunctionSelector(
  ostraDevBuyAbi.find((x) => x.type === "function" && x.name === "launchFromVault") as Parameters<typeof toFunctionSelector>[0],
).toLowerCase();

/**
 * The ETH a relay transaction sends: OstraDevBuy.launchFromVault on the
 * deployment's launchpad carries the launch fee (LAUNCHPAD.FEE_WEI), which the
 * relayer fronts; anything else carries none. Decided from the call, never
 * by the request.
 */
export function relayValue(d: Deployment, tx: { to: Address; data: Hex }): bigint {
  if (d.launchpad === undefined || getAddress(tx.to) !== d.launchpad.devBuy) return 0n;
  return tx.data.slice(0, 10).toLowerCase() === LAUNCH_FROM_VAULT_SELECTOR ? LAUNCHPAD.FEE_WEI : 0n;
}

/** An OstraVault Swap that failed inside the PoolManager (its SwapFailed event): moved nothing, used the spend. */
export type FailedSwap = { vault: Address; poolId: Hex; reason: Hex };

const SWAP_FAILED_TOPIC = toEventSelector(
  ostraVaultAbi.find((x) => x.type === "event" && x.name === "SwapFailed") as Parameters<typeof toEventSelector>[0],
);

/**
 * The vault Swaps among `logs` that fail (OstraVault's SwapFailed), by the
 * emitting vault. Only events of addresses in `vaults` count: any contract can
 * emit a log with that topic.
 */
export function failedSwaps(logs: readonly Log[], vaults: readonly Address[]): FailedSwap[] {
  const ours = new Set(vaults.map((v) => getAddress(v)));
  const out: FailedSwap[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== SWAP_FAILED_TOPIC.toLowerCase() || !ours.has(getAddress(log.address))) continue;
    const e = decodeEventLog({ abi: ostraVaultAbi, eventName: "SwapFailed", topics: log.topics as [Hex, ...Hex[]], data: log.data });
    const args = e.args as { poolId: Hex; reason: Hex };
    out.push({ vault: getAddress(log.address), poolId: args.poolId, reason: args.reason });
  }
  return out;
}

/**
 * The request bytes of `calls` as an agent posts them: {"calls": [{"to",
 * "data"}, ...]} (plus prepay, payer and allowFailedSwaps when set).
 * allowFailedSwaps: relay it even though a vault Swap in it fails (the
 * relayer refuses that otherwise, swap_fails), to use up a spend that can no
 * longer swap.
 */
export function relayRequestBody(calls: readonly RelayCall[], o: { prepay?: boolean; payer?: Address; allowFailedSwaps?: boolean } = {}): string {
  const body: Record<string, unknown> = { calls: calls.map((c) => ({ to: getAddress(c.to), data: c.data })) };
  if (o.prepay !== undefined) body.prepay = o.prepay;
  if (o.payer !== undefined) body.payer = getAddress(o.payer);
  if (o.allowFailedSwaps !== undefined) body.allowFailedSwaps = o.allowFailedSwaps;
  return JSON.stringify(body);
}
