// Messages, ids and addresses the contracts compute, built off-chain byte for
// byte the same way (test/messages.fork.test.ts compares each with the
// contract's own view function on a fork of chain 4663):
//   * OstraVault: spendMessage, the spend params (Transfer, OpenChannel,
//     SetCrankKey, Swap, ConfigurePool, ClaimDividend, SetGuardian,
//     SetRecoveryPolicy, SupportRecovery), closeDigest (EIP-712
//     CloseRequest), and the vault address OstraVaultFactory creates;
//   * Uniswap v4: the pool id of a pool key (PoolIdLibrary.toId);
//   * OstraPool: depositKey, depositNonce (the EIP-3009 nonce a relayed
//     deposit is authorized with), approvalMessage, leafMessage;
//   * x402BatchSettlement: the channel id (EIP-712 ChannelConfig) and the
//     Voucher a payerAuthorizer signs.
//
// Every WOTS-authorized call has two layers, as on Solana:
//   * `*Message` / `*Params`: pure encoders;
//   * `sign*`: signs through a WotsKeychain (one key, one message, persisted
//     before use) and rotates to the next key of the same keychain.
//
// Design v0.4 rule for the SDK and its users: never sign a spend that is sure
// to fail, and never sign a zero next key root. A spend that always fails does
// not rotate the key, so its owner would have to sign a second message with
// the same key. The encoders here refuse what the contracts would refuse
// without reading the chain; the rest (balances, nonces) is checked by
// simulating before signing.

import {
  bytesToHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  hashTypedData,
  hexToBytes,
  isAddress,
  keccak256,
  numberToHex,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { BEACON_PROXY_CREATION_CODE, ostraVaultAbi } from "./abi.ts";
import {
  AIRDROP,
  CIRCUIT_BREAKER,
  CREATOR_SPLIT,
  VAULT_SWAP_GAS,
  MAX_RECOVERY_DELAY,
  MIN_RECOVERY_DELAY,
  POOL_SETTING,
  ROBINHOOD_CHAIN_ID,
  USDG_EIP712_DOMAIN,
  VAULT_ACTION,
  X402_BATCH_SETTLEMENT,
  X402_BATCH_SETTLEMENT_DOMAIN,
  X402_MAX_WITHDRAW_DELAY,
  X402_MIN_WITHDRAW_DELAY,
} from "./constants.ts";
import { LTHASH_BYTES } from "./lthash.ts";
import { WOTS_SIGNATURE_LEN, type WotsKeychain } from "./wots.ts";

const SPEND_DOMAIN = stringToHex("OSTRA/VAULT/EVM/v1"); // bytes18
const APPROVE_DOMAIN = stringToHex("OSTRA/APPROVE/EVM/v1"); // bytes20
const LEAF_DOMAIN = stringToHex("OSTRA/LEAF/EVM/v1"); // bytes17
const DEPOSIT_NONCE_DOMAIN = stringToHex("OSTRA/DEPOSIT/EVM/v1:"); // bytes21

const ZERO32: Hex = `0x${"00".repeat(32)}`;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function bytes32(value: Hex, name: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RangeError(`${name} must be 32 bytes of hex`);
  return value;
}

function nonZero32(value: Hex, name: string): Hex {
  if (BigInt(bytes32(value, name)) === 0n) throw new RangeError(`${name} must not be zero`);
  return value;
}

function addr(value: Address, name: string): Address {
  if (!isAddress(value, { strict: false })) throw new RangeError(`${name} is not an address`);
  return getAddress(value);
}

function nonZeroAddr(value: Address, name: string): Address {
  const a = addr(value, name);
  if (a === zeroAddress) throw new RangeError(`${name} must not be the zero address`);
  return a;
}

function uint(value: bigint, max: bigint, name: string): bigint {
  if (value < 0n || value > max) throw new RangeError(`${name} out of range`);
  return value;
}

function positive(value: bigint, max: bigint, name: string): bigint {
  if (value <= 0n) throw new RangeError(`${name} must be greater than zero`);
  return uint(value, max, name);
}

function u16(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`${name} must be a u16`);
  return value;
}

function chain(chainId: number): bigint {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError("chainId must be a positive integer");
  return BigInt(chainId);
}

function wotsSignature(value: Uint8Array): Hex {
  if (value.length !== WOTS_SIGNATURE_LEN) throw new RangeError(`a WOTS signature is ${WOTS_SIGNATURE_LEN} bytes`);
  return bytesToHex(value);
}

// ---------------------------------------------------------------------------
// Vault spends
// ---------------------------------------------------------------------------

export type VaultAction = (typeof VAULT_ACTION)[keyof typeof VAULT_ACTION];

/** The params lengths OstraVault._checkParamsShape accepts per action. */
export const SPEND_PARAMS_LENGTHS: Readonly<Record<VaultAction, readonly number[]>> = {
  [VAULT_ACTION.TRANSFER]: [64],
  [VAULT_ACTION.OPEN_CHANNEL]: [192],
  [VAULT_ACTION.SET_CRANK_KEY]: [32],
  [VAULT_ACTION.SWAP]: [352],
  [VAULT_ACTION.CONFIGURE_POOL]: [128],
  [VAULT_ACTION.CLAIM_DIVIDEND]: [32],
  [VAULT_ACTION.SET_GUARDIAN]: [64],
  [VAULT_ACTION.SET_RECOVERY_POLICY]: [64],
  [VAULT_ACTION.SUPPORT_RECOVERY]: [64],
  [VAULT_ACTION.DEV_BUY]: [96],
};

/** Throws unless `params` (hex) has a length OstraVault accepts for `action`. */
export function checkSpendParamsLength(action: number, params: Hex): void {
  const lengths = SPEND_PARAMS_LENGTHS[action as VaultAction];
  if (lengths === undefined) throw new RangeError(`unknown vault action ${action}`);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(params) || !lengths.includes((params.length - 2) / 2)) {
    throw new RangeError(`action ${action} params must be ${lengths.join(" or ")} bytes`);
  }
}

function paramsFor(action: number, params: Hex): Hex {
  checkSpendParamsLength(action, params);
  return params;
}

/** Transfer params: abi.encode(address to, uint256 amount). */
export function transferParams(a: { to: Address; amount: bigint }): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [nonZeroAddr(a.to, "to"), positive(a.amount, U256_MAX, "amount")],
  );
}

export function decodeTransferParams(params: Hex): { to: Address; amount: bigint } {
  const [to, amount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], paramsFor(VAULT_ACTION.TRANSFER, params));
  return { to, amount };
}

/** An x402 batch-settlement channel opened by a vault (payer = the vault, token = the vault's token). */
export type OpenChannelParams = {
  /** The channel's voucher key (a session key); it also may ask to close. Never zero. */
  payerAuthorizer: Address;
  receiver: Address;
  receiverAuthorizer: Address;
  /** Seconds; x402BatchSettlement allows 900..2,592,000. */
  withdrawDelay: number;
  salt: Hex;
  /** Deposited at the open. */
  amount: bigint;
};

/** OpenChannel params: abi.encode(payerAuthorizer, receiver, receiverAuthorizer, uint40 withdrawDelay, salt, uint128 amount). */
export function openChannelParams(p: OpenChannelParams): Hex {
  if (!Number.isInteger(p.withdrawDelay) || p.withdrawDelay < X402_MIN_WITHDRAW_DELAY || p.withdrawDelay > X402_MAX_WITHDRAW_DELAY) {
    throw new RangeError(`withdrawDelay must be ${X402_MIN_WITHDRAW_DELAY}..${X402_MAX_WITHDRAW_DELAY} seconds`);
  }
  return encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint40" }, { type: "bytes32" }, { type: "uint128" }],
    [
      nonZeroAddr(p.payerAuthorizer, "payerAuthorizer"),
      nonZeroAddr(p.receiver, "receiver"),
      nonZeroAddr(p.receiverAuthorizer, "receiverAuthorizer"),
      p.withdrawDelay,
      bytes32(p.salt, "salt"),
      positive(p.amount, U128_MAX, "amount"),
    ],
  );
}

export function decodeOpenChannelParams(params: Hex): OpenChannelParams {
  const [payerAuthorizer, receiver, receiverAuthorizer, withdrawDelay, salt, amount] = decodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint40" }, { type: "bytes32" }, { type: "uint128" }],
    paramsFor(VAULT_ACTION.OPEN_CHANNEL, params),
  );
  return { payerAuthorizer, receiver, receiverAuthorizer, withdrawDelay, salt, amount };
}

/** SetCrankKey params: abi.encode(address crank); the zero address removes the crank. */
export function setCrankParams(crank: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [addr(crank, "crank")]);
}

export function decodeSetCrankParams(params: Hex): Address {
  const [crank] = decodeAbiParameters([{ type: "address" }], paramsFor(VAULT_ACTION.SET_CRANK_KEY, params));
  return crank;
}

/** A Uniswap v4 pool key (v4-core PoolKey); the zero address as a currency is native ETH. */
export type PoolKey = {
  currency0: Address;
  currency1: Address;
  /** LP fee in hundredths of a bip (at most 1,000,000), or 0x800000 for a dynamic-fee pool. */
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/** v4-core LPFeeLibrary.MAX_LP_FEE and DYNAMIC_FEE_FLAG; TickMath.MIN_TICK_SPACING and MAX_TICK_SPACING. */
const MAX_LP_FEE = 1_000_000;
const DYNAMIC_FEE_FLAG = 0x800000;
const MIN_TICK_SPACING = 1;
const MAX_TICK_SPACING = 32_767;

const POOL_KEY_TYPE = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const SWAP_PARAMS_TYPES = [
  POOL_KEY_TYPE,
  { type: "bool" },
  { type: "uint128" },
  { type: "uint128" },
  { type: "address" },
  { type: "address" },
  { type: "uint32" },
] as const;

/** A key the PoolManager accepts: sorted distinct currencies, a valid fee and a valid tick spacing. */
function poolKey(k: PoolKey): PoolKey {
  const currency0 = addr(k.currency0, "currency0");
  const currency1 = addr(k.currency1, "currency1");
  if (BigInt(currency0) >= BigInt(currency1)) throw new RangeError("currency0 must sort below currency1");
  if (!Number.isInteger(k.fee) || (k.fee !== DYNAMIC_FEE_FLAG && (k.fee < 0 || k.fee > MAX_LP_FEE))) {
    throw new RangeError(`fee must be 0..${MAX_LP_FEE} or the dynamic fee flag`);
  }
  if (!Number.isInteger(k.tickSpacing) || k.tickSpacing < MIN_TICK_SPACING || k.tickSpacing > MAX_TICK_SPACING) {
    throw new RangeError(`tickSpacing must be ${MIN_TICK_SPACING}..${MAX_TICK_SPACING}`);
  }
  return { currency0, currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: addr(k.hooks, "hooks") };
}

/** PoolIdLibrary.toId: keccak256(abi.encode(key)), the id the PoolManager and its events use. */
export function poolId(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters([POOL_KEY_TYPE], [poolKey(key)]));
}

/** An exact-input swap of the vault's token on a Uniswap v4 pool. */
export type SwapParams = {
  key: PoolKey;
  /** true: currency0 in, currency1 out. The input side must be the vault's token. */
  zeroForOne: boolean;
  /** At most this much of the vault's token goes in. */
  amountIn: bigint;
  /** At least this much of the other currency comes out, or the spend reverts. */
  minOut: bigint;
  /** Receives the output (another vault, for example); native ETH only to a recipient that accepts it. */
  recipient: Address;
  /**
   * The swap's referrer, passed to the pool's hook as its hookData: an Ostra
   * pool pays it half of the protocol's share of the hook fee (REFERRAL).
   */
  referrer?: Address;
  /**
   * The gas the swap gets, exactly (VAULT_SWAP_GAS; DEFAULT when left out). A
   * swap that needs more fails and uses the spend: for a pool other than an
   * Ostra pool, use a quote's gas with a margin.
   */
  swapGas?: bigint;
};

/**
 * Swap params: abi.encode(PoolKey key, bool zeroForOne, uint128 amountIn,
 * uint128 minOut, address recipient, address referrer, uint32 swapGas), 352
 * bytes; referrer address(0) for none.
 */
export function swapParams(p: SwapParams): Hex {
  if (typeof p.zeroForOne !== "boolean") throw new RangeError("zeroForOne must be a boolean");
  const swapGas = p.swapGas ?? BigInt(VAULT_SWAP_GAS.DEFAULT);
  if (swapGas < BigInt(VAULT_SWAP_GAS.MIN) || swapGas > BigInt(VAULT_SWAP_GAS.MAX)) {
    throw new RangeError(`swapGas must be ${VAULT_SWAP_GAS.MIN}..${VAULT_SWAP_GAS.MAX}`);
  }
  return encodeAbiParameters(SWAP_PARAMS_TYPES, [
    poolKey(p.key),
    p.zeroForOne,
    positive(p.amountIn, U128_MAX, "amountIn"),
    uint(p.minOut, U128_MAX, "minOut"),
    nonZeroAddr(p.recipient, "recipient"),
    p.referrer === undefined ? zeroAddress : nonZeroAddr(p.referrer, "referrer"),
    Number(swapGas),
  ]);
}

export function decodeSwapParams(params: Hex): SwapParams {
  paramsFor(VAULT_ACTION.SWAP, params);
  // The vault decodes the referrer word as an address and reverts on dirty upper bytes; viem drops them.
  if (!/^0{24}$/.test(params.slice(2 + 288 * 2, 2 + 288 * 2 + 24))) throw new RangeError("referrer is not a clean address word");
  const [key, zeroForOne, amountIn, minOut, recipient, referrer, swapGas] = decodeAbiParameters(SWAP_PARAMS_TYPES, params);
  const p: SwapParams = { key: { ...key }, zeroForOne, amountIn, minOut, recipient, swapGas: BigInt(swapGas) };
  if (referrer !== zeroAddress) p.referrer = referrer;
  // viem does not range-check the other words either (dirty upper bytes in an address or a uint128) while the vault's
  // abi.decode reverts on them: the params must be exactly what swapParams encodes for what they decode to.
  if (swapParams(p).toLowerCase() !== params.toLowerCase()) throw new RangeError("swap params are not canonically encoded");
  return p;
}

/**
 * The hookData of a swap on an Ostra pool that pays `referrer` (REFERRAL):
 * abi.encode(address referrer), for routers that pass hookData (the Universal
 * Router's V4 swaps); an OstraVault Swap carries it with SwapParams.referrer.
 */
export function referralHookData(referrer: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [nonZeroAddr(referrer, "referrer")]);
}

/** The currency a swap spends: currency0 when zeroForOne, else currency1. */
export function swapInput(p: Pick<SwapParams, "key" | "zeroForOne">): Address {
  return getAddress(p.zeroForOne ? p.key.currency0 : p.key.currency1);
}

/** The currency a swap pays out. */
export function swapOutput(p: Pick<SwapParams, "key" | "zeroForOne">): Address {
  return getAddress(p.zeroForOne ? p.key.currency1 : p.key.currency0);
}

export type PoolSetting = (typeof POOL_SETTING)[keyof typeof POOL_SETTING];

/** The largest value per OstraHook.configure field: the width of the PoolConfig member it sets, or the hook's own bound. */
const POOL_SETTING_MAX: Readonly<Record<PoolSetting, bigint>> = {
  [POOL_SETTING.BUY_TAX]: 0xffffn,
  [POOL_SETTING.SELL_TAX]: 0xffffn,
  [POOL_SETTING.POST_BUY_TAX]: 0xffffn,
  [POOL_SETTING.POST_SELL_TAX]: 0xffffn,
  [POOL_SETTING.TAX_END_AT]: (1n << 40n) - 1n,
  [POOL_SETTING.ANTI_SNIPE]: 0xffffn,
  [POOL_SETTING.MAX_BUY]: U128_MAX,
  [POOL_SETTING.RELEASE_LIMITS]: 0n,
  [POOL_SETTING.VOLATILITY_FEE]: 0n,
  [POOL_SETTING.MAX_TX_MOVE]: BigInt(CIRCUIT_BREAKER.MAX_TICKS),
};

/**
 * A ConfigurePool spend: the vault calls hook.configure(poolId, field, value)
 * as itself, which OstraHook allows only from the pool's creator vault and only
 * in the traders' favour (POOL_SETTING). Whether the change is in their favour
 * depends on the pool's current rules: read them (OstraHook.poolConfig) and
 * simulate before signing.
 */
export type ConfigurePoolParams = { hook: Address; poolId: Hex; field: PoolSetting; value: bigint };

const CONFIGURE_POOL_TYPES = [{ type: "address" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint256" }] as const;

/** ConfigurePool params: abi.encode(address hook, bytes32 poolId, uint8 field, uint256 value). */
export function configurePoolParams(p: ConfigurePoolParams): Hex {
  const max = POOL_SETTING_MAX[p.field];
  if (max === undefined) throw new RangeError(`unknown pool setting ${p.field}`);
  return encodeAbiParameters(CONFIGURE_POOL_TYPES, [nonZeroAddr(p.hook, "hook"), bytes32(p.poolId, "poolId"), p.field, uint(p.value, max, "value")]);
}

export function decodeConfigurePoolParams(params: Hex): ConfigurePoolParams {
  const [hook, poolId, field, value] = decodeAbiParameters(CONFIGURE_POOL_TYPES, paramsFor(VAULT_ACTION.CONFIGURE_POOL, params));
  return { hook, poolId, field: field as PoolSetting, value };
}

/**
 * A creator split share: a ConfigurePool spend whose `hook` is the
 * OstraCreatorSplit contract, so the vault calls
 * split.configure(poolId, CREATOR_SPLIT.FIELD_SHARE, uint160(recipient) | bps << 160).
 * Only the pool's creator vault may set shares; bps 0 removes the recipient;
 * the creator vault keeps 10,000 bps minus the recipients' total. The split
 * also refuses the creator vault itself as a recipient, the current share
 * again, a total above 10,000 bps and a 101st recipient: simulate before signing.
 */
export type CreatorShareParams = { split: Address; poolId: Hex; recipient: Address; bps: number };

/** CreatorShare params: abi.encode(address split, bytes32 poolId, uint8 0, uint256 recipient | bps << 160). */
export function creatorShareParams(p: CreatorShareParams): Hex {
  const recipient = nonZeroAddr(p.recipient, "recipient");
  if (!Number.isInteger(p.bps) || p.bps < 0 || p.bps > CREATOR_SPLIT.BPS) throw new RangeError(`bps must be 0..${CREATOR_SPLIT.BPS}`);
  const value = BigInt(recipient) | (BigInt(p.bps) << 160n);
  return encodeAbiParameters(CONFIGURE_POOL_TYPES, [nonZeroAddr(p.split, "split"), bytes32(p.poolId, "poolId"), CREATOR_SPLIT.FIELD_SHARE, value]);
}

export function decodeCreatorShareParams(params: Hex): CreatorShareParams {
  const [split, poolId, field, value] = decodeAbiParameters(CONFIGURE_POOL_TYPES, paramsFor(VAULT_ACTION.CONFIGURE_POOL, params));
  const recipient = value & ((1n << 160n) - 1n);
  const bps = value >> 160n;
  if (field !== CREATOR_SPLIT.FIELD_SHARE || recipient === 0n || bps > BigInt(CREATOR_SPLIT.BPS)) throw new RangeError("not a creator share");
  return { split, poolId, recipient: getAddress(`0x${recipient.toString(16).padStart(40, "0")}`), bps: Number(bps) };
}

/**
 * ClaimDividend params: abi.encode(address recipient). The vault's token (an
 * OstraToken) pays the dividends it owes the vault to `recipient`, which should
 * be the owner's vault for the dividend token: a vault only spends its own
 * token. The spend reverts while nothing is owed (OstraToken.dividendOf), and
 * the same signed bytes can be sent again later.
 */
export function claimDividendParams(recipient: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [nonZeroAddr(recipient, "recipient")]);
}

export function decodeClaimDividendParams(params: Hex): Address {
  const [recipient] = decodeAbiParameters([{ type: "address" }], paramsFor(VAULT_ACTION.CLAIM_DIVIDEND, params));
  return recipient;
}

/** SetGuardian params: abi.encode(address guardian, bool enabled). The guardian should be another Ostra vault. */
export function setGuardianParams(a: { guardian: Address; enabled: boolean }): Hex {
  if (typeof a.enabled !== "boolean") throw new RangeError("enabled must be a boolean");
  return encodeAbiParameters([{ type: "address" }, { type: "bool" }], [nonZeroAddr(a.guardian, "guardian"), a.enabled]);
}

export function decodeSetGuardianParams(params: Hex): { guardian: Address; enabled: boolean } {
  const [guardian, enabled] = decodeAbiParameters([{ type: "address" }, { type: "bool" }], paramsFor(VAULT_ACTION.SET_GUARDIAN, params));
  return { guardian, enabled };
}

/**
 * SetRecoveryPolicy params: abi.encode(uint8 threshold, uint32 delay).
 * threshold 0 with delay 0 turns recovery off; otherwise delay is
 * MIN_RECOVERY_DELAY..MAX_RECOVERY_DELAY seconds. Whether threshold fits the
 * vault's guardian count is read from the chain (readRecovery) before signing.
 */
export function setRecoveryPolicyParams(a: { threshold: number; delay: number }): Hex {
  if (!Number.isInteger(a.threshold) || a.threshold < 0 || a.threshold > 255) throw new RangeError("threshold must be 0..255");
  if (!Number.isInteger(a.delay)) throw new RangeError("delay must be whole seconds");
  if (a.threshold === 0 ? a.delay !== 0 : a.delay < MIN_RECOVERY_DELAY || a.delay > MAX_RECOVERY_DELAY) {
    throw new RangeError(`delay must be 0 with threshold 0, else ${MIN_RECOVERY_DELAY}..${MAX_RECOVERY_DELAY} seconds`);
  }
  return encodeAbiParameters([{ type: "uint8" }, { type: "uint32" }], [a.threshold, a.delay]);
}

export function decodeSetRecoveryPolicyParams(params: Hex): { threshold: number; delay: number } {
  const [threshold, delay] = decodeAbiParameters([{ type: "uint8" }, { type: "uint32" }], paramsFor(VAULT_ACTION.SET_RECOVERY_POLICY, params));
  return { threshold, delay };
}

/**
 * SupportRecovery params: abi.encode(address vault, bytes32 newKeyRoot),
 * signed by a guardian's own vault. newKeyRoot is recoveryKeyRoot: the new
 * seed's key at the recovered vault's current nonce, which the recovery keeps.
 */
export function supportRecoveryParams(a: { vault: Address; newKeyRoot: Hex }): Hex {
  return encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [nonZeroAddr(a.vault, "vault"), nonZero32(a.newKeyRoot, "newKeyRoot")]);
}

export function decodeSupportRecoveryParams(params: Hex): { vault: Address; newKeyRoot: Hex } {
  const [vault, newKeyRoot] = decodeAbiParameters([{ type: "address" }, { type: "bytes32" }], paramsFor(VAULT_ACTION.SUPPORT_RECOVERY, params));
  return { vault, newKeyRoot };
}

/** The key root a recovery moves a vault to: key `nonce` (the vault's current nonce) of the new seed's keychain. */
export function recoveryKeyRoot(newKeychain: WotsKeychain, vaultNonce: bigint): Hex {
  return bytesToHex(newKeychain.keyRoot(uint(vaultNonce, U64_MAX, "vaultNonce")));
}

export type VaultSpend = {
  chainId: number;
  vault: Address;
  nonce: bigint;
  nextKeyRoot: Hex;
  action: VaultAction;
  params: Hex;
};

/** OstraVault.spendMessage: "OSTRA/VAULT/EVM/v1" || chainid || vault || nonce (u64) || nextKeyRoot || action || params. */
export function vaultSpendMessage(s: VaultSpend): Uint8Array {
  return hexToBytes(
    encodePacked(
      ["bytes18", "uint256", "address", "uint64", "bytes32", "uint8", "bytes"],
      [
        SPEND_DOMAIN,
        chain(s.chainId),
        addr(s.vault, "vault"),
        uint(s.nonce, U64_MAX, "nonce"),
        nonZero32(s.nextKeyRoot, "nextKeyRoot"),
        s.action,
        paramsFor(s.action, s.params),
      ],
    ),
  );
}

/** Reads a spend message back; throws unless it re-encodes to the same bytes. */
export function decodeVaultSpendMessage(message: Uint8Array): VaultSpend {
  const head = 18 + 32 + 20 + 8 + 32 + 1;
  if (message.length < head) throw new Error("the message is too short for a vault spend");
  if (bytesToHex(message.subarray(0, 18)) !== SPEND_DOMAIN) throw new Error("not a vault spend message");
  const chainId = Number(BigInt(bytesToHex(message.subarray(18, 50))));
  const vault = getAddress(bytesToHex(message.subarray(50, 70)));
  const nonce = BigInt(bytesToHex(message.subarray(70, 78)));
  const nextKeyRoot = bytesToHex(message.subarray(78, 110));
  const action = message[110] as VaultAction;
  const params = bytesToHex(message.subarray(head));
  const decoded: VaultSpend = { chainId, vault, nonce, nextKeyRoot, action, params };
  const again = vaultSpendMessage(decoded);
  if (again.length !== message.length || !again.every((x, i) => x === message[i])) throw new Error("the message does not re-encode to the same bytes");
  return decoded;
}

/** What OstraVault.spend takes, signed. */
export type SignedSpend = { action: VaultAction; nextKeyRoot: Hex; params: Hex; signature: Hex; message: Uint8Array };

/** The vault's current key (index = on-chain nonce) as read from the vault. */
export type VaultKeyState = { vault: Address; nonce: bigint; keyRoot: Hex };

/** Signs a spend with key `nonce` and rotates to key `nonce + 1` of the same keychain. */
export async function signVaultSpend(
  keychain: WotsKeychain,
  state: VaultKeyState,
  a: { chainId: number; action: VaultAction; params: Hex },
): Promise<SignedSpend> {
  const nextKeyRoot = bytesToHex(keychain.keyRoot(state.nonce + 1n));
  const message = vaultSpendMessage({ chainId: a.chainId, vault: state.vault, nonce: state.nonce, nextKeyRoot, action: a.action, params: a.params });
  const signature = await keychain.sign(state.nonce, message, hexToBytes(bytes32(state.keyRoot, "keyRoot")));
  return { action: a.action, nextKeyRoot, params: a.params, signature: wotsSignature(signature), message };
}

export function signVaultTransfer(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; to: Address; amount: bigint }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.TRANSFER, params: transferParams(a) });
}

export function signVaultOpenChannel(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; open: OpenChannelParams }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.OPEN_CHANNEL, params: openChannelParams(a.open) });
}

export function signVaultSetCrankKey(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; crank: Address }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.SET_CRANK_KEY, params: setCrankParams(a.crank) });
}

/** Signs a Swap; `token` is the vault's token, which must be the swap's input (the vault refuses anything else). */
export async function signVaultSwap(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; token: Address; swap: SwapParams }): Promise<SignedSpend> {
  const params = swapParams(a.swap);
  if (swapInput(a.swap) !== addr(a.token, "token")) throw new RangeError("the swap's input currency is not the vault's token");
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.SWAP, params });
}

export function signVaultConfigurePool(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; configure: ConfigurePoolParams }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.CONFIGURE_POOL, params: configurePoolParams(a.configure) });
}

/**
 * An airdrop round's two ConfigurePool spends, whose `hook` is the OstraAirdrop
 * contract: first its amount (the tree's total, airdropRoundAmountParams), then
 * its start with the tree's root (startAirdropParams), so the vault calls
 * airdrop.configure(poolId, AIRDROP.FIELD_ROUND_AMOUNT, amount) and
 * airdrop.configure(poolId, AIRDROP.FIELD_START_ROUND, uint256(root)). Only the
 * pool's creator vault, only while no round is open, and the start only while
 * OstraAirdrop.available covers the amount.
 */
export type AirdropRoundAmountParams = { airdrop: Address; poolId: Hex; amount: bigint };

export function airdropRoundAmountParams(p: AirdropRoundAmountParams): Hex {
  return encodeAbiParameters(CONFIGURE_POOL_TYPES, [nonZeroAddr(p.airdrop, "airdrop"), bytes32(p.poolId, "poolId"), AIRDROP.FIELD_ROUND_AMOUNT, positive(p.amount, U256_MAX, "amount")]);
}

export function signVaultSetAirdropAmount(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; round: AirdropRoundAmountParams }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.CONFIGURE_POOL, params: airdropRoundAmountParams(a.round) });
}

export type StartAirdropParams = { airdrop: Address; poolId: Hex; root: Hex };

export function startAirdropParams(p: StartAirdropParams): Hex {
  const root = bytes32(p.root, "root");
  if (BigInt(root) === 0n) throw new RangeError("root must not be zero");
  return encodeAbiParameters(CONFIGURE_POOL_TYPES, [nonZeroAddr(p.airdrop, "airdrop"), bytes32(p.poolId, "poolId"), AIRDROP.FIELD_START_ROUND, BigInt(root)]);
}

export function decodeStartAirdropParams(params: Hex): StartAirdropParams {
  const [airdrop, poolId, field, value] = decodeAbiParameters(CONFIGURE_POOL_TYPES, paramsFor(VAULT_ACTION.CONFIGURE_POOL, params));
  if (field !== AIRDROP.FIELD_START_ROUND || value === 0n) throw new RangeError("not an airdrop round start");
  return { airdrop, poolId, root: numberToHex(value, { size: 32 }) };
}

export function signVaultStartAirdrop(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; start: StartAirdropParams }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.CONFIGURE_POOL, params: startAirdropParams(a.start) });
}

export function signVaultSetCreatorShare(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; share: CreatorShareParams }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.CONFIGURE_POOL, params: creatorShareParams(a.share) });
}

export function signVaultClaimDividend(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; recipient: Address }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.CLAIM_DIVIDEND, params: claimDividendParams(a.recipient) });
}

export function signVaultSetGuardian(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; guardian: Address; enabled: boolean }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.SET_GUARDIAN, params: setGuardianParams(a) });
}

export function signVaultSetRecoveryPolicy(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; threshold: number; delay: number }): Promise<SignedSpend> {
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.SET_RECOVERY_POLICY, params: setRecoveryPolicyParams(a) });
}

/** Signed by the guardian's own vault key: supports moving `vault` to `newKeyRoot`. */
export async function signVaultSupportRecovery(keychain: WotsKeychain, state: VaultKeyState, a: { chainId: number; vault: Address; newKeyRoot: Hex }): Promise<SignedSpend> {
  if (addr(a.vault, "vault") === addr(state.vault, "guardian vault")) throw new RangeError("a vault cannot support its own recovery");
  return signVaultSpend(keychain, state, { chainId: a.chainId, action: VAULT_ACTION.SUPPORT_RECOVERY, params: supportRecoveryParams(a) });
}

// ---------------------------------------------------------------------------
// Vault addresses
// ---------------------------------------------------------------------------

/** The address OstraVaultFactory.createVault gives (token, initial key root, initial crank). */
export function vaultAddress(a: { factory: Address; beacon: Address; token: Address; initialKeyRoot: Hex; initialCrank: Address }): Address {
  const token = nonZeroAddr(a.token, "token");
  const root = bytes32(a.initialKeyRoot, "initialKeyRoot");
  const crank = addr(a.initialCrank, "initialCrank");
  const salt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "address" }], [token, root, crank]));
  const init = encodeFunctionData({ abi: ostraVaultAbi, functionName: "initialize", args: [token, root, crank] });
  const bytecode = encodePacked(
    ["bytes", "bytes"],
    [BEACON_PROXY_CREATION_CODE, encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [addr(a.beacon, "beacon"), init])],
  );
  return getContractAddress({ opcode: "CREATE2", from: addr(a.factory, "factory"), salt, bytecode });
}

// ---------------------------------------------------------------------------
// x402 batch-settlement channels
// ---------------------------------------------------------------------------

export type ChannelConfig = {
  payer: Address;
  payerAuthorizer: Address;
  receiver: Address;
  receiverAuthorizer: Address;
  token: Address;
  withdrawDelay: number;
  salt: Hex;
};

const CHANNEL_CONFIG_TYPES = {
  ChannelConfig: [
    { name: "payer", type: "address" },
    { name: "payerAuthorizer", type: "address" },
    { name: "receiver", type: "address" },
    { name: "receiverAuthorizer", type: "address" },
    { name: "token", type: "address" },
    { name: "withdrawDelay", type: "uint40" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

function settlementDomain(chainId: number, settlement: Address) {
  return { ...X402_BATCH_SETTLEMENT_DOMAIN, chainId, verifyingContract: addr(settlement, "settlement") } as const;
}

/** The channel config an OpenChannel spend of `vault` creates. */
export function vaultChannelConfig(vault: Address, token: Address, p: OpenChannelParams): ChannelConfig {
  return {
    payer: addr(vault, "vault"),
    payerAuthorizer: p.payerAuthorizer,
    receiver: p.receiver,
    receiverAuthorizer: p.receiverAuthorizer,
    token: addr(token, "token"),
    withdrawDelay: p.withdrawDelay,
    salt: p.salt,
  };
}

/** x402BatchSettlement.getChannelId: the EIP-712 hash of the config. */
export function channelId(config: ChannelConfig, chainId: number = ROBINHOOD_CHAIN_ID, settlement: Address = X402_BATCH_SETTLEMENT): Hex {
  return hashTypedData({
    domain: settlementDomain(chainId, settlement),
    types: CHANNEL_CONFIG_TYPES,
    primaryType: "ChannelConfig",
    message: { ...config, salt: bytes32(config.salt, "salt") },
  });
}

/** The typed data of a cumulative Voucher(channelId, maxClaimableAmount), signed by the channel's payerAuthorizer. */
export function voucherTypedData(a: { channelId: Hex; maxClaimableAmount: bigint; chainId?: number; settlement?: Address }) {
  return {
    domain: settlementDomain(a.chainId ?? ROBINHOOD_CHAIN_ID, a.settlement ?? X402_BATCH_SETTLEMENT),
    types: { Voucher: [{ name: "channelId", type: "bytes32" }, { name: "maxClaimableAmount", type: "uint128" }] },
    primaryType: "Voucher",
    message: { channelId: bytes32(a.channelId, "channelId"), maxClaimableAmount: uint(a.maxClaimableAmount, U128_MAX, "maxClaimableAmount") },
  } as const;
}

/** x402BatchSettlement.getVoucherDigest. */
export function voucherDigest(a: { channelId: Hex; maxClaimableAmount: bigint; chainId?: number; settlement?: Address }): Hex {
  return hashTypedData(voucherTypedData(a));
}

/** The typed data of OstraVault's EIP-712 CloseRequest, signed by the channel's voucher key or the vault's crank. */
export function closeRequestTypedData(a: { chainId: number; vault: Address; channelId: Hex; amount: bigint; nonce: bigint; deadline: bigint }) {
  return {
    domain: { name: "Ostra Vault", version: "1", chainId: a.chainId, verifyingContract: addr(a.vault, "vault") },
    types: {
      CloseRequest: [
        { name: "channelId", type: "bytes32" },
        { name: "amount", type: "uint128" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "CloseRequest",
    message: {
      channelId: bytes32(a.channelId, "channelId"),
      amount: uint(a.amount, U128_MAX, "amount"),
      nonce: uint(a.nonce, U256_MAX, "nonce"),
      deadline: uint(a.deadline, U64_MAX, "deadline"),
    },
  } as const;
}

/** OstraVault.closeDigest at close nonce `nonce`. */
export function closeDigest(a: { chainId: number; vault: Address; channelId: Hex; amount: bigint; nonce: bigint; deadline: bigint }): Hex {
  return hashTypedData(closeRequestTypedData(a));
}

// ---------------------------------------------------------------------------
// Shielded pool
// ---------------------------------------------------------------------------

/** OstraPool.depositKey: keccak256(abi.encode(depositor, depositId)). */
export function depositKey(depositor: Address, depositId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [addr(depositor, "depositor"), bytes32(depositId, "depositId")]));
}

export type DepositArgs = {
  depositor: Address;
  depositId: Hex;
  amount: bigint;
  refundOwner: Address;
  approvalKeyRoot: Hex;
  /** The LtHash commitment of the deposit's leaves (2,048 bytes). */
  commitment: Uint8Array;
};

function commitmentHex(commitment: Uint8Array): Hex {
  if (commitment.length !== LTHASH_BYTES) throw new RangeError(`commitment must be ${LTHASH_BYTES} bytes`);
  return bytesToHex(commitment);
}

/** OstraPool.depositNonce: the EIP-3009 nonce that binds every field of a relayed deposit. */
export function depositNonce(a: DepositArgs & { chainId: number; pool: Address }): Hex {
  return keccak256(
    encodePacked(
      ["bytes21", "uint256", "address", "address", "bytes32", "uint64", "address", "bytes32", "bytes32"],
      [
        DEPOSIT_NONCE_DOMAIN,
        chain(a.chainId),
        addr(a.pool, "pool"),
        addr(a.depositor, "depositor"),
        bytes32(a.depositId, "depositId"),
        positive(a.amount, U64_MAX, "amount"),
        nonZeroAddr(a.refundOwner, "refundOwner"),
        nonZero32(a.approvalKeyRoot, "approvalKeyRoot"),
        keccak256(commitmentHex(a.commitment)),
      ],
    ),
  );
}

/** The EIP-3009 ReceiveWithAuthorization a depositor signs so a relayer can submit its deposit (USDG's domain). */
export function depositAuthorizationTypedData(a: DepositArgs & { chainId: number; pool: Address; validAfter: bigint; validBefore: bigint }) {
  if (a.chainId !== USDG_EIP712_DOMAIN.chainId) throw new RangeError(`USDG's domain is on chain ${USDG_EIP712_DOMAIN.chainId}`);
  return {
    domain: USDG_EIP712_DOMAIN,
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: addr(a.depositor, "depositor"),
      to: addr(a.pool, "pool"),
      value: a.amount,
      validAfter: uint(a.validAfter, U256_MAX, "validAfter"),
      validBefore: uint(a.validBefore, U256_MAX, "validBefore"),
      nonce: depositNonce(a),
    },
  } as const;
}

/** OstraPool.approvalMessage: "OSTRA/APPROVE/EVM/v1" || chainid || pool || key || batchId (u64) || state || nextKeyRoot. */
export function approvalMessage(a: { chainId: number; pool: Address; key: Hex; batchId: bigint; state: Hex; nextKeyRoot: Hex }): Uint8Array {
  return hexToBytes(
    encodePacked(
      ["bytes20", "uint256", "address", "bytes32", "uint64", "bytes32", "bytes32"],
      [
        APPROVE_DOMAIN,
        chain(a.chainId),
        addr(a.pool, "pool"),
        bytes32(a.key, "key"),
        uint(a.batchId, U64_MAX, "batchId"),
        bytes32(a.state, "state"),
        nonZero32(a.nextKeyRoot, "nextKeyRoot"),
      ],
    ),
  );
}

/** What OstraPool.approveBatch takes, signed. */
export type SignedApproval = { key: Hex; batchId: bigint; state: Hex; nextKeyRoot: Hex; signature: Hex; message: Uint8Array };

/**
 * Signs an approval with approval key `index` (expected on-chain key root
 * `currentKeyRoot`) and rotates to key `index + 1`. Approve only after
 * checking that every one of your leaves is in the batch.
 */
export async function signApproveBatch(
  keychain: WotsKeychain,
  key: { index: bigint; currentKeyRoot: Hex },
  a: { chainId: number; pool: Address; key: Hex; batchId: bigint; state: Hex },
): Promise<SignedApproval> {
  const nextKeyRoot = bytesToHex(keychain.keyRoot(key.index + 1n));
  const message = approvalMessage({ ...a, nextKeyRoot });
  const signature = await keychain.sign(key.index, message, hexToBytes(bytes32(key.currentKeyRoot, "currentKeyRoot")));
  return { key: a.key, batchId: a.batchId, state: a.state, nextKeyRoot, signature: wotsSignature(signature), message };
}

/** OstraPool.leafMessage: "OSTRA/LEAF/EVM/v1" || chainid || pool || batchId (u64) || leafIndex (u16) || destination || leafAmount (u64). */
export function leafMessage(a: { chainId: number; pool: Address; batchId: bigint; leafIndex: number; destination: Address; leafAmount: bigint }): Uint8Array {
  return hexToBytes(
    encodePacked(
      ["bytes17", "uint256", "address", "uint64", "uint16", "address", "uint64"],
      [
        LEAF_DOMAIN,
        chain(a.chainId),
        addr(a.pool, "pool"),
        uint(a.batchId, U64_MAX, "batchId"),
        u16(a.leafIndex, "leafIndex"),
        nonZeroAddr(a.destination, "destination"),
        positive(a.leafAmount, U64_MAX, "leafAmount"),
      ],
    ),
  );
}

/** What OstraPool.spendLeaf takes, signed. */
export type SignedLeafSpend = { batchId: bigint; leafIndex: number; destination: Address; signature: Hex; message: Uint8Array };

/** Signs a leaf spend with leaf key `index`; `leafKeyRoot` is the key root stored in the batch leaf. */
export async function signSpendLeaf(
  keychain: WotsKeychain,
  key: { index: bigint; leafKeyRoot: Hex },
  a: { chainId: number; pool: Address; batchId: bigint; leafIndex: number; destination: Address; leafAmount: bigint },
): Promise<SignedLeafSpend> {
  const message = leafMessage(a);
  const signature = await keychain.sign(key.index, message, hexToBytes(bytes32(key.leafKeyRoot, "leafKeyRoot")));
  return { batchId: a.batchId, leafIndex: a.leafIndex, destination: getAddress(a.destination), signature: wotsSignature(signature), message };
}

/** The zero bytes32 (an unset key root, state or id). */
export const ZERO_BYTES32 = ZERO32;
