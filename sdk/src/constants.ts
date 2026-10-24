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

/** WETH9 on chain 4663 (the one Uniswap v4's PositionManager wraps with): an ETH pool's creator vault holds it. */
export const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/**
 * $OSTRA, launched on Pons, and the Pons bonding curve it trades on against ETH until the curve graduates
 * (graduated()) and OSTRA migrates (checked on chain 4663 on 20 Oct 2026: name "Ostra Agent", symbol OSTRA,
 * 18 decimals, a supply of 1,000,000,000, burn(uint256) and burnFrom, no transfer limits; the curve's token() is
 * OSTRA). OSTRA_CODE_HASH and OSTRA_PONS_CURVE_CODE_HASH are the keccak-256 of their runtime code then: neither is
 * a proxy, and the fork tests check the hashes on every run.
 */
export const OSTRA: Address = "0x68Ff81dFFF6eccefb74706fE1e0a86320CB2Eb96";
export const OSTRA_DECIMALS = 18;
export const OSTRA_CODE_HASH = "0x55e96d3bbff72f192ba79b21f7735c50dd0db6ced9f185de166ee9d871c92351";
export const OSTRA_PONS_CURVE: Address = "0xef89C3a9832Ae6f8Dc5F785484b1B5cb1120F372";
export const OSTRA_PONS_CURVE_CODE_HASH = "0xd71963ef1e2c4c13de134e298ce13bda63e8fb453b0fa9db1bea9296433ea6a0";
/**
 * The pool Pons graduates OSTRA to: native ETH (currency0) / OSTRA (currency1) on Uniswap v4
 * (UNISWAP_V4_POOL_MANAGER), fee 0, tick spacing 200, the Pons V2 meme hook PONS_HOOK; the same key as ostra-swap's
 * OstraBuyback.ostraPoolKey. Checked on chain 4663 on 22 Oct 2026, after the curve graduated (graduated() true, the
 * curve holding no OSTRA and no ETH): the pool is initialized with liquidity 29,277,002,188,455,997,495,745 at about
 * 23.4 million OSTRA per ETH, and the V4Quoter quotes 0.001 ETH in for 22,737 OSTRA out.
 */
export const PONS_HOOK: Address = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
export const OSTRA_POOL_FEE = 0;
export const OSTRA_POOL_TICK_SPACING = 200;
/** The deterministic CREATE2 deployer (github.com/Arachnid/deterministic-deployment-proxy): OstraHook is mined with it. */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/**
 * Uniswap's v4 periphery on chain 4663 (Uniswap's v4 deployments page; sources verified on Sourcify, checked
 * 19 Oct 2026; each names UNISWAP_V4_POOL_MANAGER as its pool manager). A wallet that is not an Ostra vault swaps
 * through the Universal Router (command V4_SWAP, IV4Router.ExactInputSingleParams with minHopPriceX36), quotes with
 * the V4Quoter, and lets the router take an ERC-20 input through Permit2.
 */
export const UNISWAP_UNIVERSAL_ROUTER: Address = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
export const UNISWAP_V4_QUOTER: Address = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

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

/** OstraVault.SWAP_GAS_RESERVE: gas a Swap must have left beyond swapGas * 64 / 63 when it calls the PoolManager. */
export const VAULT_SWAP_GAS_RESERVE = 30_000;

/** OstraVault spend actions. */
/**
 * OstraVault.VERSION from which the profile, token metadata and agent identity spends (OstraRegistry) are there;
 * version 3 (VAULT_V3) keeps them.
 */
export const VAULT_VERSION = 2;
/** OstraVault.MAX_URI_LENGTH and OstraRegistry.MAX_URI_LENGTH: the longest profile, metadata or agent URI, in bytes. */
export const VAULT_MAX_URI_LENGTH = 256n;

export const VAULT_ACTION = {
  TRANSFER: 0,
  OPEN_CHANNEL: 1,
  SET_CRANK_KEY: 2,
  SWAP: 3,
  CONFIGURE_POOL: 4,
  CLAIM_DIVIDEND: 5,
  SET_GUARDIAN: 6,
  SET_RECOVERY_POLICY: 7,
  SUPPORT_RECOVERY: 8,
  DEV_BUY: 9,
  SET_PROFILE: 10,
  SET_TOKEN_METADATA: 11,
  REGISTER_AGENT: 12,
  SET_AGENT_URI: 13,
  // Version 3 (OstraVault.sol notes; OstraVaultModule runs them).
  SET_WITHDRAWAL_LOCK: 14,
  CANCEL_PENDING_CHANGES: 15,
  SET_LINKED_VAULT: 16,
  LEND: 17,
  REDEEM: 18,
  POST_COLLATERAL: 19,
  WITHDRAW_COLLATERAL: 20,
  BORROW: 21,
  REPAY: 22,
  APPROVE_HASH: 23,
  GUARD: 24,
} as const;

/** The first vault version with the withdrawal lock, linked vaults, the Morpho (Borro) spends, EIP-1271 and Guard. */
export const VAULT_V3 = 3;
/** OstraVault.LIMIT_WINDOW: the lock's used limit drains at dailyLimit per this many seconds. */
export const VAULT_LIMIT_WINDOW = 86_400;
/** OstraVaultModule.MAX_LTV_OF_LLTV_BPS: after Borrow and WithdrawCollateral the debt is at most half the LLTV allows. */
export const VAULT_MAX_LTV_OF_LLTV_BPS = 5_000n;
/** OstraVaultModule.MORPHO_MIN_GAS and GUARD_MIN_GAS: gas a Morpho spend, and a Guard or SupportRecovery call, must have left when it starts. */
export const VAULT_MORPHO_MIN_GAS = 2_000_000;
export const VAULT_GUARD_MIN_GAS = 600_000;
/** OstraVault.guard (and the Guard spend's) operations, for a guardian or the withdrawal address while the lock is on. */
export const GUARD_OP = {
  /** Drop the waiting lock and link changes (reverts when nothing waits). */
  CANCEL: 0,
  /** Withdraw a hash approval: abi.encode(bytes32 hash). */
  REVOKE_HASH: 1,
  /** Send the whole token balance to the withdrawal address: abi.encode(address expected). */
  SWEEP: 2,
  /** Redeem Vault V2 shares back into the vault: abi.encode(address vault, uint256 shares). */
  REDEEM: 3,
  /** Take collateral back into the vault: abi.encode(bytes32 marketId, uint256 shares). */
  WITHDRAW_COLLATERAL: 4,
} as const;
/** The Guarded event's op for a SupportRecovery spend the other vault refused. */
export const GUARD_OP_SUPPORT_RECOVERY = 255;

/**
 * Morpho on chain 4663: Morpho Blue, and Morpho's VaultV2Factory (BorroLib.VAULT_FACTORY in
 * github.com/Borro-Markets/contracts; verified on Sourcify, read on chain 24 Oct 2026: 111 Vault V2s, 512 markets).
 */
export const MORPHO_BLUE: Address = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
export const MORPHO_VAULT_V2_FACTORY: Address = "0x0FBad98595b0186dA120E41f77C102beb49f803c";
/**
 * Borro (borro.markets/developers registry, every contract's source on Sourcify identical to
 * github.com/Borro-Markets/contracts commit 129f1e8, read on chain 23 and 24 Oct 2026; owned by the Hoard Safe
 * 0x8A22d6e75e9427b9D57e42a7984200029e7E173C, no outside audit). BorroBuilders: referred deposits; BorroRouter: the
 * list of Borro's USDG markets. BORRO_CODE is Ostra's builder code "ostraagent", registered 24 Oct 2026.
 */
export const BORRO_BUILDERS: Address = "0x082Ae609bdC7ccEec0C58B2361a21c49dc2aE291";
export const BORRO_ROUTER: Address = "0x85ccddcb0588A434BD57F86A59381E40154650Ca";
export const BORRO_CODE = "0x6f737472616167656e7400000000000000000000000000000000000000000000" as const;
/** Borro's USDG vault (bUSDG, a Morpho Vault V2): USDG lent to Borro's stock markets. */
export const BORRO_USDG_VAULT: Address = "0xF8e0ab443098c0738489B5BAFFbd32A1341F2289";
/** Borro's Adaptive Curve IRM, every Borro USDG market's interest rate model. */
export const BORRO_IRM: Address = "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1";
/**
 * Borro's stock markets (its registry, 23 Oct 2026): the stock token, its Borro vault (a Morpho Vault V2 of the
 * stock, b<SYMBOL>), and the USDG market against that vault's shares (loan token USDG, collateral the vault, the
 * oracle and LLTV here, irm BORRO_IRM). `builders`: whether BorroBuilders lists the vault (read 24 Oct 2026: nine of
 * them; a Lend into the other three goes to the vault directly, with no builder code, and counts against a lock's
 * daily limit). test/constants.fork.test.ts checks each against the chain on every run.
 */
export const BORRO_STOCKS: readonly { symbol: string; token: Address; vault: Address; oracle: Address; lltv: bigint; builders: boolean }[] = [
  { symbol: "SPY", token: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", vault: "0xC3ED4a5A7dB4102F4Ed37Af26ef0d3f21e2360c1", oracle: "0xac6E0472981877dcebb1527E417b5CB6133721b3", lltv: 625000000000000000n, builders: true },
  { symbol: "QQQ", token: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", vault: "0xbAD8A97dA1050092d6a14194D53E72D407D6cc17", oracle: "0x667b8FC52939a08940C13B03effc6F072547ccdc", lltv: 625000000000000000n, builders: true },
  { symbol: "NVDA", token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", vault: "0x508E23274C39C60c345e35B1f0188bE180717CB9", oracle: "0x62c20e5AfCFCB1A2Bbe30891aB77334C31c956d2", lltv: 625000000000000000n, builders: true },
  { symbol: "TSLA", token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", vault: "0x60b3d353E7e5bD12ED4Ea2589C11B5603dd4c988", oracle: "0x14896c69b0b53292f51ab11C69d46C2f4518ecde", lltv: 385000000000000000n, builders: true },
  { symbol: "MSTR", token: "0xec262a75e413fAfD0dF80480274532C79D42da09", vault: "0x2B74f8F2b76cd4e97265BC37FB2578a04B8437e9", oracle: "0xeFf12C9bE9bd34DC25E5586EbBC4904df2b0416b", lltv: 385000000000000000n, builders: true },
  { symbol: "COIN", token: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", vault: "0x7BA71BCCeCb12860aE7E141B6b6F1f8B96d31257", oracle: "0xb7470ad30d6aBD81E9a3Cb7893Af1bcbFb1795c5", lltv: 385000000000000000n, builders: true },
  { symbol: "PLTR", token: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", vault: "0xFE9419E70e5481F7a2dDddc18f856b09b3687B27", oracle: "0xFc4AfF549eea3A64992fC6410ea0fea52bD1f543", lltv: 385000000000000000n, builders: true },
  { symbol: "SPCX", token: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", vault: "0x1261210E19052157fCe2064D9aa9A2140Bd89791", oracle: "0xCA61a812B8793a3AA891CDCD0f1323c2FBdCea83", lltv: 385000000000000000n, builders: true },
  { symbol: "GME", token: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", vault: "0x328461fB01F54C2Ab73909EA947c583d0dC24C3d", oracle: "0xA7f17C3E654Ba4E7E5ACe9F81878C347c6785C7F", lltv: 385000000000000000n, builders: true },
  { symbol: "AAPL", token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", vault: "0x24Fe7bCAEB75bC2202A42ECD48a177a27782c64a", oracle: "0xf64B96E968b925C1FC0B9803808B165B0a98F385", lltv: 625000000000000000n, builders: false },
  { symbol: "GOOGL", token: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", vault: "0xf0731B1022ABD1e3f543Cfd837C7eBA42ED60E4f", oracle: "0xF64EFc62792850109ab235844730daCb6511349B", lltv: 625000000000000000n, builders: false },
  { symbol: "MSFT", token: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", vault: "0x8032C80a7817a3C4C401b096515B27b2CedA4e71", oracle: "0xcF7AF87FCe1ce58750BE01da536283963Cb04d3A", lltv: 625000000000000000n, builders: false },
];

/** OstraVault.MIN_RECOVERY_DELAY and MAX_RECOVERY_DELAY, in seconds (36 hours, 14 days). */
export const MIN_RECOVERY_DELAY = 129_600;
export const MAX_RECOVERY_DELAY = 1_209_600;
/** Defaults the SDK proposes (design v0.4): a 3-day delay (Candide's Safe recovery module default), 2 of 3 guardians. */
export const DEFAULT_RECOVERY_DELAY = 259_200;
export const DEFAULT_RECOVERY_GUARDIANS = 3;
export const DEFAULT_RECOVERY_THRESHOLD = 2;

/**
 * OstraHook.configure fields (its FIELD_ constants), what a ConfigurePool spend
 * changes. Every change is in the traders' favour or the hook reverts: taxes
 * and anti-snipe (bps) only lower, the tax end only earlier (unix seconds), the
 * max buy only higher or 0 (none), RELEASE_LIMITS (value 0) ends the max buy and
 * the max wallet now, VOLATILITY_FEE (value 0) turns the volatility LP fee off
 * for good (the pool pays the base LP fee, or the closed-market fee in a stock
 * pool), MAX_TX_MOVE only loosens the circuit breaker (more ticks, at most
 * CIRCUIT_BREAKER.MAX_TICKS) or turns it off for good (0).
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
  VOLATILITY_FEE: 8,
  MAX_TX_MOVE: 9,
} as const;

/**
 * OstraHook's circuit breaker: a pool's maxTxMoveTicks (launch parameter) is
 * how far one transaction's swaps may move its price from where it was before
 * the first of them; 0 is off. At launch 0 or MIN_TICKS..MAX_TICKS (1,000 ticks
 * is about a 10% move, 6,932 a halving or doubling); DEFAULT_TICKS, 2,231
 * (-20% / +25%), is Ostra's default, the one a launch should propose
 * (OstraHook.txMoveBand gives the band a transaction may end in).
 */
export const CIRCUIT_BREAKER = {
  DEFAULT_TICKS: 2_231,
  MIN_TICKS: 1_000,
  MAX_TICKS: 6_932,
} as const;

/**
 * A swap on an Ostra pool whose hookData is abi.encode(referrer) pays its
 * referrer SHARE_BPS of the protocol's part of the hook fee (half of 0.3%:
 * 0.15% of the quote leg), claimed by anyone for the referrer through
 * OstraDispatcher.claimReferral (paid in the pool's quote; WETH for ETH).
 */
export const REFERRAL = {
  SHARE_BPS: 5_000,
} as const;

/**
 * OstraVault Swap's signed `swapGas`: the gas its PoolManager call gets
 * exactly, MIN..MAX; a swap that needs more fails (SwapFailed) and uses the
 * spend. DEFAULT is about twice what a swap in an Ostra pool takes; a quote's
 * gas with a margin is better for other pools.
 */
export const VAULT_SWAP_GAS = {
  MIN: 100_000,
  MAX: 10_000_000,
  DEFAULT: 1_000_000,
} as const;

/**
 * OstraLaunchpad: FEE_WEI, the launch fee in ETH (LAUNCH_FEE; the relayer
 * fronts it for a vault-funded launch and charges it in USDG), SUPPLY, every
 * launch's fixed supply (18 decimals), TICK_SPACING of every Ostra pool
 * (OstraHook.TICK_SPACING), and HOOK_FLAGS, the permission bits an OstraHook
 * address carries in its low 14 bits (beforeInitialize, beforeAddLiquidity,
 * before/afterSwap, both return deltas).
 */
export const LAUNCHPAD = {
  FEE_WEI: 200_000_000_000_000n,
  SUPPLY: 1_000_000_000n * 10n ** 18n,
  TICK_SPACING: 200,
  HOOK_FLAGS: 0x28cc,
  HOOK_FLAGS_MASK: 0x3fff,
} as const;

/**
 * OstraDevBuy: a launch with the creator's dev buy in the same transaction
 * (no anti-snipe; the hook fee, the tax, the max buy, the max wallet and the
 * circuit breaker apply), at most MAX_BPS of the supply, held by an
 * OstraVesting clone that pays the creator's token vault after a cliff of
 * MIN_CLIFF..MAX_CLIFF seconds, linearly over at most MAX_VESTING seconds.
 */
export const DEV_BUY = {
  MAX_BPS: 500,
  MIN_CLIFF: 604_800,
  MAX_CLIFF: 31_536_000,
  MAX_VESTING: 31_536_000,
} as const;

/**
 * OstraAirdrop: the creator vault buys a round into the airdrop contract (a
 * Swap whose recipient is OstraAirdrop; for an ETH pool, bought elsewhere and
 * sent there), sets the round's amount (FIELD_ROUND_AMOUNT: what the tree
 * shares out, at most MAX_ROUND_BPS of the launch supply) and starts it
 * (FIELD_START_ROUND, value = the merkle root, see airdropTree), with two
 * ConfigurePool spends. The round reserves that amount of what the contract
 * holds beyond open rounds (OstraAirdrop.available); claims run for
 * CLAIM_PERIOD seconds, then anyone closes it and what was not claimed is burned.
 */
export const AIRDROP = {
  FIELD_START_ROUND: 0,
  FIELD_ROUND_AMOUNT: 1,
  MAX_ROUND_BPS: 1_000,
  CLAIM_PERIOD: 604_800,
} as const;

/**
 * OstraCreatorSplit: a pool's creator vault shares its creator payouts among up
 * to MAX_RECIPIENTS recipients and keeps the rest (FIELD_SHARE is its only
 * configure field; shares change at any time and apply to later payouts).
 */
export const CREATOR_SPLIT = {
  FIELD_SHARE: 0,
  MAX_RECIPIENTS: 100,
  BPS: 10_000,
} as const;

/** OstraPool deposit statuses, by their on-chain number. */
export const DEPOSIT_STATUS = ["none", "pending", "consumed", "cancelled", "closed"] as const;
export type DepositStatus = (typeof DEPOSIT_STATUS)[number];

/** OstraPool batch statuses, by their on-chain number. */
export const BATCH_STATUS = ["none", "open", "sealed", "closed"] as const;
export type BatchStatus = (typeof BATCH_STATUS)[number];
