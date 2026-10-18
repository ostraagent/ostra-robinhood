// Robinhood Chain facts the SDK relies on and the protocol limits the
// contracts enforce (src/*.sol). Addresses and values checked on chain
// 4663 on 17 Oct 2026 (design v0.4, "Pindah ke Robinhood Chain"); the fork
// tests (test/constants.fork.test.ts) check them again on every run.

import type { Address } from "viem";

/** Robinhood Chain mainnet (Arbitrum Nitro, ETH for gas). */
export const ROBINHOOD_CHAIN_ID = 4663;
/** The public RPC endpoint (rate limited; services use their own endpoint behind the RPC proxy). */
export const ROBINHOOD_PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** USDG (Global Dollar, Paxos), the token Ostra is paid and shielded in. */
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_DECIMALS = 6;
/** USDG's EIP-712 domain: its DOMAIN_SEPARATOR is the hash of exactly this domain. */
export const USDG_EIP712_DOMAIN = {
  name: "Global Dollar",
  version: "1",
  chainId: ROBINHOOD_CHAIN_ID,
  verifyingContract: USDG,
} as const;

/** x402 batch-settlement (x402-foundation/x402, contracts/evm/src/x402BatchSettlement.sol). */
export const X402_BATCH_SETTLEMENT: Address = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003";
export const X402_ERC3009_DEPOSIT_COLLECTOR: Address = "0x4020806089470a89826cB9fB1f4059150b550004";
export const X402_PERMIT2_DEPOSIT_COLLECTOR: Address = "0x4020425FAf3B746C082C2f942b4E5159887B0005";
/** x402BatchSettlement's EIP-712 domain name and version (chain 4663, verifying contract X402_BATCH_SETTLEMENT). */
export const X402_BATCH_SETTLEMENT_DOMAIN = { name: "x402 Batch Settlement", version: "1" } as const;
/** x402BatchSettlement.MIN_WITHDRAW_DELAY and MAX_WITHDRAW_DELAY, in seconds. */
export const X402_MIN_WITHDRAW_DELAY = 900;
export const X402_MAX_WITHDRAW_DELAY = 2_592_000;

/**
 * Uniswap v4 PoolManager (Uniswap's v4 deployments page): the vault's Swap
 * action trades on it. Its runtime code is v4-core v4.0.0's PoolManager
 * built with that release's settings; UNISWAP_V4_POOL_MANAGER_CODE_HASH is
 * the hash of that code on chain 4663.
 */
export const UNISWAP_V4_POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
export const UNISWAP_V4_POOL_MANAGER_CODE_HASH = "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626";

/** Chainlink ETH/USD (8 decimals, heartbeat 86,400 s, deviation 0.5%). */
export const CHAINLINK_ETH_USD: Address = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
export const CHAINLINK_ETH_USD_DECIMALS = 8;

/** ERC-8004 registries (erc-8004/erc-8004-contracts). */
export const ERC8004_IDENTITY_REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const ERC8004_REPUTATION_REGISTRY: Address = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

/** Multicall3, used to send more than one call in one transaction. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** Arbitrum's NodeInterface (gasEstimateComponents: the L1 part of a gas estimate). */
export const ARBITRUM_NODE_INTERFACE: Address = "0x00000000000000000000000000000000000000C8";

/** OstraPool.MAX_FEE_BPS: the largest fee a pool may be initialized with (5%). */
export const MAX_FEE_BPS = 500;
/** OstraPool.MAX_LEAVES_PER_BATCH. */
export const MAX_LEAVES_PER_BATCH = 192;
/** OstraPool.DEPOSIT_TIMEOUT: after it, a deposit no batch consumed may be cancelled (the Solana 432,000 slots). */
export const DEPOSIT_TIMEOUT_SECONDS = 172_800n;

/** The pool Ostra deploys (design: 30 bps per deposit at sealing; 250 USDG per deposit, 2,500 USDG in total). */
export const POOL_FEE_BPS = 30;
export const POOL_MAX_DEPOSIT = 250_000_000n;
export const POOL_MAX_TOTAL = 2_500_000_000n;

/** OstraVault spend actions. */
export const VAULT_ACTION = { TRANSFER: 0, OPEN_CHANNEL: 1, SET_CRANK_KEY: 2, SWAP: 3, CONFIGURE_POOL: 4, CLAIM_DIVIDEND: 5 } as const;

/**
 * OstraHook.configure fields (its FIELD_ constants), what a ConfigurePool spend
 * changes. Every change is in the traders' favour or the hook reverts: taxes
 * and anti-snipe (bps) only lower, the tax end only earlier (unix seconds), the
 * max buy only higher or 0 (none), RELEASE_LIMITS (value 0) ends the max buy and
 * the max wallet now.
 */
export const POOL_SETTING = {
  BUY_TAX: 0,
  SELL_TAX: 1,
  POST_BUY_TAX: 2,
  POST_SELL_TAX: 3,
  TAX_END_AT: 4,
  ANTI_SNIPE: 5,
  MAX_BUY: 6,
  RELEASE_LIMITS: 7,
} as const;

/** OstraPool deposit statuses, by their on-chain number. */
export const DEPOSIT_STATUS = ["none", "pending", "consumed", "cancelled", "closed"] as const;
export type DepositStatus = (typeof DEPOSIT_STATUS)[number];

/** OstraPool batch statuses, by their on-chain number. */
export const BATCH_STATUS = ["none", "open", "sealed", "closed"] as const;
export type BatchStatus = (typeof BATCH_STATUS)[number];
