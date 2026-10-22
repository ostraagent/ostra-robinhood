// The chain as this package reads and writes it: the RPC (pinned to
// Robinhood Chain), token and ETH balances, the chain's clock, and the
// transactions the local fee payer sends itself (simulate, send, receipt).
// On Solana this module held the RPC with its genesis pin, the SPL token
// account and System instructions and the Clock sysvar; ERC-20 needs no
// token accounts and an EVM chain no rent, so those are gone.

import { createWalletClient, type Address, type Hash, type PrivateKeyAccount, type PublicClient, type Transport } from "viem";
import { assertRobinhoodChain, escrowCalls, estimateRelay, readVault, relayGasCap, relayTransaction, retryingHttp, robinhoodChain, robinhoodClient, usdgAbi, type Deployment, type RelayCall, type VaultState } from "@ostraagent/sdk";
import type { Config } from "./config.ts";

/** Gas limit of a transaction the fee payer sends = estimate + 20% (as the relayer, decided 17 Oct 2026). */
export const GAS_LIMIT_MARGIN_PERCENT = 20n;
/** How long a sent transaction's receipt is waited for. */
const RECEIPT_TIMEOUT_MS = 120_000;

/** A transaction the chain refuses now (its simulation reverts): nothing was sent. */
export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationError";
  }
}

/**
 * A client of the configured RPC, refused unless it serves the configured
 * chain (eth_chainId) and the deployment is for that chain. The RPC URL is
 * never printed: it may carry an API key.
 */
export async function connect(config: Config): Promise<PublicClient> {
  if (config.deployment.chainId !== config.chainId) throw new Error(`the deployment is for chain ${config.deployment.chainId}, not ${config.chainId}`);
  if (config.chainId !== robinhoodChain.id) throw new Error(`this package serves Robinhood Chain (${robinhoodChain.id}), not chain ${config.chainId}`);
  const client = robinhoodClient(config.rpcUrl);
  await assertRobinhoodChain(client);
  return client;
}

/** The HTTP transport of the configured RPC (retrying), for the transactions the fee payer signs. */
export function transportOf(config: Config): Transport {
  return retryingHttp(config.rpcUrl);
}

/** `owner`'s balance of `token`, in base units. */
export function tokenBalance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [owner] });
}

/** The decimals of `token`. */
export async function tokenDecimals(client: PublicClient, token: Address): Promise<number> {
  return Number(await client.readContract({ address: token, abi: usdgAbi, functionName: "decimals" }));
}

/** `account`'s ETH, in wei. */
export function ethBalance(client: PublicClient, account: Address): Promise<bigint> {
  return client.getBalance({ address: account });
}

/** The chain's clock: the latest block's timestamp (unix seconds), what contracts compare deadlines with. */
export async function chainTime(client: PublicClient): Promise<bigint> {
  return (await client.getBlock({ blockTag: "latest" })).timestamp;
}

/** True when there is contract code at `account`. */
export async function hasCode(client: PublicClient, account: Address): Promise<boolean> {
  const code = await client.getCode({ address: account });
  return code !== undefined && code !== "0x";
}

/** The Ostra vault of `d` at `account`, or null when it is not one (sdk readVault). */
export function readOstraVault(client: PublicClient, d: Deployment, account: Address): Promise<VaultState | null> {
  return readVault(client, d, account);
}

/** The revert reason of a failed simulation, as short as viem gives it. */
export function revertReason(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return e.shortMessage ?? e.message ?? String(err);
}

/**
 * Sends `calls` from `account` (one call as it is, several through Multicall3
 * aggregate3, none allowed to fail) and waits for a successful receipt. The
 * transaction is simulated first (eth_estimateGas): one that reverts now is
 * not sent (SimulationError). A transaction with an OstraRouter escrow
 * execution gets the gas limit its swap needs as the relayer prices it
 * (estimateRelay): eth_estimateGas finds the least gas that does not revert,
 * at which an escrow refunds instead of swapping. Returns the transaction hash.
 */
export async function sendCalls(client: PublicClient, transport: Transport, account: PrivateKeyAccount, calls: readonly RelayCall[], value = 0n): Promise<Hash> {
  const tx = relayTransaction(calls);
  let gas: bigint;
  try {
    gas = await client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value });
  } catch (err) {
    throw new SimulationError(`the transaction reverts now, so it was not sent: ${revertReason(err)}`);
  }
  let limit = gas + (gas * GAS_LIMIT_MARGIN_PERCENT) / 100n;
  if (escrowCalls(tx) > 0) {
    const swapLimit = relayGasCap((await estimateRelay(client, { relayer: account.address, to: tx.to, data: tx.data, value })).gas);
    if (swapLimit > limit) limit = swapLimit;
  }
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport });
  const hash = await wallet.sendTransaction({ account, chain: robinhoodChain, to: tx.to, data: tx.data, value, gas: limit });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on-chain`);
  return hash;
}
