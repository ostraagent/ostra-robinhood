// The configuration the agent's services run with, and the limits decided in
// the design. The MCP package reads it from the environment (mcp/src/config.ts,
// which adds OSTRA_HOME); the web app sets it for the chain it serves.

import { ROBINHOOD_CHAIN_ID, type Deployment } from "@ostraagent/sdk";

/**
 * Soft limit on a vault's token balance (decided 12 Oct 2026, design v0.3):
 * 250 tokens. Transfers into a vault are plain ERC-20 transfers that the
 * contract cannot refuse, so the limit is reported by this package, not
 * enforced on-chain.
 */
export const VAULT_SOFT_LIMIT = 250_000_000n;

/**
 * Session limits (decided 12 Oct 2026, design v0.3): one session key holds at
 * most 20 tokens and lives at most 24 hours.
 */
export const SESSION_MAX_BUDGET = 20_000_000n;
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Longest grace period (`withdrawDelay`) an x402 `batch-settlement` channel
 * may set (decided 13 Oct 2026, design v0.3): 24 hours, the session
 * lifetime. x402 itself allows 15 minutes to 30 days; a seller that
 * disappears can hold the unused part of a channel deposit about this long.
 * On Robinhood Chain every channel this package opens is a batch-settlement
 * channel (to a seller, to another Ostra vault, to the relayer), so this is
 * also the longest grace period of a relayer channel (on Solana,
 * MPP_MAX_GRACE_SECONDS, the same 24 hours).
 */
export const BATCH_MAX_WITHDRAW_DELAY_SECONDS = 24 * 60 * 60;

/**
 * Deposit of a channel from the buyer vault to the relayer (decided 15 Oct
 * 2026, design v0.3): 1 token, or more when its first voucher and the payment
 * at hand need more, never more than the vault holds (relay.ts).
 */
export const RELAYER_CHANNEL_DEPOSIT = 1_000_000n;

/** x402 (CAIP-2) id of Robinhood Chain. */
export const X402_NETWORK = `eip155:${ROBINHOOD_CHAIN_ID}` as const;

export type Config = {
  /** Robinhood Chain (4663); the RPC is pinned to it (eth_chainId). */
  chainId: number;
  /** RPC endpoint; never printed, it may carry an API key. */
  rpcUrl: string;
  /** Where Ostra's contracts are (the token, the vault factory, the pool, the split factory). */
  deployment: Deployment;
  x402Network: string;
  /** Null without a keeper URL (OSTRA_KEEPER_URL): the seller tools then refuse to run. */
  keeperUrl: string | null;
  /** Null without a relayer URL (OSTRA_RELAYER_URL): the local fee payer then pays every transaction. */
  relayerUrl: string | null;
  /** Null without an aggregator URL (OSTRA_AGGREGATOR_URL): shield then refuses to run. */
  aggregatorUrl: string | null;
  /** Null without an AI gateway URL (OSTRA_AI_URL): ostra_ai then refuses to run. */
  aiUrl: string | null;
};

/** The token the agent's vaults hold (USDG): the deployment's. */
export function tokenOf(config: Config): Deployment["token"] {
  return config.deployment.token;
}
