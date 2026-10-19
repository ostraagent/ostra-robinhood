// Swaps from a wallet that is not an Ostra vault (MetaMask, Robinhood Wallet,
// any EIP-1193 wallet in the web app), through Uniswap's Universal Router. The
// Ostra hook runs every swap of an Ostra pool whoever sends it: the taxes,
// anti-snipe, max buy and max wallet, the circuit breaker and the fees are the
// same as for a vault's swap.
//
// A buy pays the pool's quote currency (ETH as the transaction's value, an
// ERC-20 through Permit2), a sell pays the token through Permit2, and the
// output goes to the wallet (TAKE_ALL pays the router's caller). The swap is
// one exact-input swap on the token's pool: V4_SWAP with SWAP_EXACT_IN_SINGLE,
// SETTLE_ALL (at most amountIn) and TAKE_ALL (at least minOut), after a
// PERMIT2_PERMIT when the wallet signed a Permit2 allowance for it, and with
// ETH in, a SWEEP of any ETH left in the router back to the wallet.
//
// Nothing here signs or sends: the web app asks the wallet for the ERC-20
// approval of Permit2 (once per token), the Permit2 signature and the swap.
// Every quote comes from Uniswap's V4Quoter, run as the wallet's own call
// (the hook's limits and fees read the swapper), so what the wallet signs is
// what the pool does now.

import {
  concatHex,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { PERMIT2, QUOTE_DEFAULT_SLIPPAGE_BPS, QUOTE_MAX_SLIPPAGE_BPS, UNISWAP_UNIVERSAL_ROUTER, UNISWAP_V4_QUOTER, ostraHookAbi, ostraTokenAbi, usdgAbi, type LaunchpadDeployment, type PoolKey } from "@ostraagent/sdk";
import { quoteOfPool, readLaunchedPool, type LaunchedPool } from "./pools.ts";

/** Universal Router commands (Commands.sol) and v4 router actions (v4-periphery Actions.sol) this file sends. */
const COMMAND = { SWEEP: 0x04, PERMIT2_PERMIT: 0x0a, V4_SWAP: 0x10 } as const;
/** The router's stand-in for its caller as a recipient (v4-periphery ActionConstants.MSG_SENDER). */
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
const ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const;

/** How long a swap and its Permit2 signature stay valid: 20 minutes. */
export const WALLET_SWAP_DEADLINE_SECONDS = 1_200;
/** uint160 max: Permit2's largest allowance. */
const MAX_UINT160 = (1n << 160n) - 1n;
/** uint128 max: the router's largest amount. */
const MAX_UINT128 = (1n << 128n) - 1n;

export const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "error TransactionDeadlinePassed()",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)",
]);

export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  { type: "error", name: "UnexpectedRevertBytes", inputs: [{ name: "revertData", type: "bytes" }] },
  { type: "error", name: "NotEnoughLiquidity", inputs: [{ name: "poolId", type: "bytes32" }] },
] as const;

export const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "error AllowanceExpired(uint256 deadline)",
  "error InsufficientAllowance(uint256 amount)",
  "error InvalidNonce()",
  "error SignatureExpired(uint256 signatureDeadline)",
]);

/** v4-core's wrapper of a hook's revert (CustomRevert.WrappedError). */
const wrappedErrorAbi = parseAbi(["error WrappedError(address target, bytes4 selector, bytes reason, bytes details)"]);

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export type WalletSwapSide = "buy" | "sell";

export type WalletSwapQuote = {
  side: WalletSwapSide;
  token: Address;
  pool: LaunchedPool;
  /** The pool's quote currency (address(0): ETH). */
  quote: Address;
  /** What goes in and comes out (address(0): ETH). */
  currencyIn: Address;
  currencyOut: Address;
  zeroForOne: boolean;
  amountIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
  slippageBps: number;
  /** The V4Quoter's estimate of the swap's gas. */
  gasEstimate: bigint;
  hookData: Hex;
};

/** A swap the pool refuses now, with the reason decoded where it can be. */
export class WalletSwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletSwapError";
  }
}

/** The hook data of a swap: abi.encode(referrer), or none. */
export function referrerHookData(referrer: Address | null | undefined): Hex {
  return referrer === null || referrer === undefined ? "0x" : encodeAbiParameters([{ type: "address" }], [getAddress(referrer)]);
}

/**
 * The revert data inside `err`, if it carries any: the `raw` of a contract revert or the `data` of the RPC error,
 * found along the error's causes (by shape, not by class: the client may come from another copy of viem).
 */
function revertData(err: unknown): Hex | null {
  let e: unknown = err;
  for (let depth = 0; depth < 12 && e !== null && typeof e === "object"; depth++) {
    const x = e as { raw?: unknown; data?: unknown; cause?: unknown };
    if (typeof x.raw === "string" && x.raw.startsWith("0x")) return x.raw as Hex;
    if (typeof x.data === "string" && x.data.startsWith("0x")) return x.data as Hex;
    e = x.cause;
  }
  return null;
}

/** A readable reason for revert `data` from the quoter, the router, Permit2, v4-core or the Ostra hook and token. */
export function swapRevertReason(data: Hex | null, depth = 0): string {
  if (data === null || data === "0x") return "the swap reverts";
  if (depth > 4) return `the swap reverts (${data.slice(0, 10)})`;
  for (const abi of [v4QuoterAbi, wrappedErrorAbi, universalRouterAbi, permit2Abi, ostraHookAbi, ostraTokenAbi] as const) {
    try {
      const e = decodeErrorResult({ abi: abi as never, data }) as { errorName: string; args?: readonly unknown[] };
      if (e.errorName === "UnexpectedRevertBytes") return swapRevertReason(e.args?.[0] as Hex, depth + 1);
      if (e.errorName === "WrappedError") return swapRevertReason(e.args?.[2] as Hex, depth + 1);
      if (e.errorName === "ExecutionFailed") return swapRevertReason(e.args?.[1] as Hex, depth + 1);
      const args = (e.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a)));
      return args.length === 0 ? e.errorName : `${e.errorName}(${args.join(", ")})`;
    } catch {
      // not an error of this ABI
    }
  }
  return `the swap reverts (${data.slice(0, 10)})`;
}

function checkSlippage(bps: number | undefined): number {
  const s = bps ?? QUOTE_DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(s) || s < 0 || s > QUOTE_MAX_SLIPPAGE_BPS) throw new RangeError(`slippage must be 0..${QUOTE_MAX_SLIPPAGE_BPS} bps`);
  return s;
}

/**
 * Quotes an exact-input swap of `amountIn` (base units of what goes in: the quote currency for a buy, the token for a
 * sell) on the pool of `token`, as `account` would send it. Throws WalletSwapError when the pool refuses it now.
 */
export async function quoteWalletSwap(
  client: PublicClient,
  lp: LaunchpadDeployment,
  a: { account: Address; token: string; side: WalletSwapSide; amountIn: bigint; slippageBps?: number; referrer?: Address | null },
): Promise<WalletSwapQuote> {
  if (a.amountIn <= 0n) throw new RangeError("the amount must be greater than zero");
  if (a.amountIn > MAX_UINT128) throw new RangeError("the amount is too large");
  const slippageBps = checkSlippage(a.slippageBps);
  const pool = await readLaunchedPool(client, lp, a.token);
  const quote = quoteOfPool(pool);
  const buying = a.side === "buy";
  const currencyIn = buying ? quote : pool.token;
  const currencyOut = buying ? pool.token : quote;
  const zeroForOne = getAddress(pool.key.currency0) === getAddress(currencyIn);
  const hookData = referrerHookData(a.referrer);
  let amountOut: bigint;
  let gasEstimate: bigint;
  try {
    const { result } = await client.simulateContract({
      account: getAddress(a.account),
      address: UNISWAP_V4_QUOTER,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: poolKeyArgs(pool.key), zeroForOne, exactAmount: a.amountIn, hookData }],
    });
    [amountOut, gasEstimate] = result;
  } catch (err) {
    throw new WalletSwapError(`the pool refuses this ${a.side} now: ${swapRevertReason(revertData(err))}`);
  }
  if (amountOut === 0n) throw new WalletSwapError(`the pool gives nothing for this ${a.side}`);
  const minOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  return { side: a.side, token: pool.token, pool, quote, currencyIn, currencyOut, zeroForOne, amountIn: a.amountIn, expectedOut: amountOut, minOut, slippageBps, gasEstimate, hookData };
}

function poolKeyArgs(key: PoolKey) {
  return { currency0: getAddress(key.currency0), currency1: getAddress(key.currency1), fee: key.fee, tickSpacing: key.tickSpacing, hooks: getAddress(key.hooks) };
}

/** What a swap of `q` needs from `owner` before it can be sent. */
export type WalletSwapNeeds = {
  /** The ERC-20 approval of Permit2 to send first (null: none, ETH in or already approved). */
  approve: { to: Address; data: Hex } | null;
  /** The Permit2 allowance for the router to sign (null: none, ETH in or an allowance that covers the swap). */
  permit: PermitSingle | null;
};

export type PermitSingle = {
  details: { token: Address; amount: bigint; expiration: number; nonce: number };
  spender: Address;
  sigDeadline: bigint;
};

/**
 * What `owner` must do before the swap `q`: approve Permit2 for the input token (once; the approval is for any
 * amount, as Uniswap's own interface asks, since Permit2 only moves what a signed, expiring allowance allows), and
 * sign a Permit2 allowance of exactly amountIn for the router when the one it has does not cover the swap.
 */
export async function walletSwapNeeds(client: PublicClient, q: WalletSwapQuote, owner: Address, now: bigint): Promise<WalletSwapNeeds> {
  if (q.currencyIn === zeroAddress) return { approve: null, permit: null };
  const token = q.currencyIn;
  const [erc20Allowance, permit2] = await Promise.all([
    client.readContract({ address: token, abi: usdgAbi, functionName: "allowance", args: [getAddress(owner), PERMIT2] }) as Promise<bigint>,
    client.readContract({ address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [getAddress(owner), token, UNISWAP_UNIVERSAL_ROUTER] }),
  ]);
  const approve = erc20Allowance >= q.amountIn ? null : { to: token, data: encodeFunctionData({ abi: usdgAbi, functionName: "approve", args: [PERMIT2, maxUint256] }) };
  const [amount, expiration, nonce] = permit2;
  const covered = amount >= q.amountIn && BigInt(expiration) > now + BigInt(WALLET_SWAP_DEADLINE_SECONDS);
  const deadline = now + BigInt(WALLET_SWAP_DEADLINE_SECONDS);
  const permit = covered ? null : { details: { token, amount: q.amountIn, expiration: Number(deadline), nonce: Number(nonce) }, spender: UNISWAP_UNIVERSAL_ROUTER, sigDeadline: deadline };
  if (permit !== null && permit.details.amount > MAX_UINT160) throw new RangeError("the amount is too large for Permit2");
  return { approve, permit };
}

/** The EIP-712 typed data of a Permit2 PermitSingle, for the wallet's eth_signTypedData_v4. */
export function permitSingleTypedData(chainId: number, permit: PermitSingle) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    types: {
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    primaryType: "PermitSingle" as const,
    message: permit,
  };
}

/**
 * The gas limit a wallet swap is sent with: the node's estimate plus 30% and 50,000 (what the web app sends). A swap
 * through the Universal Router and the hook, sent with the bare estimate as its limit, ran out of gas in an inner call
 * on a mainnet fork (limit 251,108, used 244,907, ReentrancySentryOOG; 20 Oct 2026).
 */
export function walletSwapGasLimit(estimate: bigint): bigint {
  return (estimate * 13n) / 10n + 50_000n;
}

/**
 * The Universal Router call of the swap `q`: the transaction the wallet sends (to the router, with the ETH in as its
 * value). `permit` and its signature come first when walletSwapNeeds asked for one.
 */
export function walletSwapCall(q: WalletSwapQuote, a: { deadline: bigint; permit?: { permit: PermitSingle; signature: Hex } }): { to: Address; data: Hex; value: bigint } {
  const commands: number[] = [];
  const inputs: Hex[] = [];
  if (a.permit !== undefined) {
    if (getAddress(a.permit.permit.details.token) !== getAddress(q.currencyIn) || a.permit.permit.details.amount < q.amountIn) {
      throw new RangeError("the Permit2 allowance does not cover this swap");
    }
    commands.push(COMMAND.PERMIT2_PERMIT);
    inputs.push(
      encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              {
                name: "details",
                type: "tuple",
                components: [
                  { name: "token", type: "address" },
                  { name: "amount", type: "uint160" },
                  { name: "expiration", type: "uint48" },
                  { name: "nonce", type: "uint48" },
                ],
              },
              { name: "spender", type: "address" },
              { name: "sigDeadline", type: "uint256" },
            ],
          },
          { type: "bytes" },
        ],
        [a.permit.permit, a.permit.signature],
      ),
    );
  }
  const actions = concatHex([ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL].map((x) => `0x${x.toString(16).padStart(2, "0")}` as Hex));
  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "minHopPriceX36", type: "uint256" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [{ poolKey: poolKeyArgs(q.pool.key), zeroForOne: q.zeroForOne, amountIn: q.amountIn, amountOutMinimum: q.minOut, minHopPriceX36: 0n, hookData: q.hookData }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [q.currencyIn, q.amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [q.currencyOut, q.minOut]);
  commands.push(COMMAND.V4_SWAP);
  inputs.push(encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settle, take]]));
  // ETH in: whatever of the value the swap did not use (the pool ran out of liquidity at the price limit, with the
  // output still at least minOut) goes back to the caller instead of staying in the router.
  if (q.currencyIn === zeroAddress) {
    commands.push(COMMAND.SWEEP);
    inputs.push(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [zeroAddress, MSG_SENDER, 0n]));
  }
  const commandBytes = concatHex(commands.map((c) => `0x${c.toString(16).padStart(2, "0")}` as Hex));
  return {
    to: UNISWAP_UNIVERSAL_ROUTER,
    data: encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [commandBytes, inputs, a.deadline] }),
    value: q.currencyIn === zeroAddress ? q.amountIn : 0n,
  };
}

/** Runs the router call `call` as `account` would send it (eth_call); throws WalletSwapError with the reason when it reverts. */
export async function simulateWalletSwap(client: PublicClient, account: Address, call: { to: Address; data: Hex; value: bigint }): Promise<void> {
  try {
    await client.call({ account: getAddress(account), to: call.to, data: call.data, value: call.value });
  } catch (err) {
    throw new WalletSwapError(`the swap would fail: ${swapRevertReason(revertData(err))}`);
  }
}
