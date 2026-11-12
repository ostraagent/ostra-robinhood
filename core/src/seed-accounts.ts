// The accounts an agent's services sign with, built on the agent's seed operations (keys.ts AgentSeed): a channel's
// voucher key, the payment wallet and Ostrapad's posting key. Each signs only what Ostra uses it for, whatever holds
// the seed (Keys in this process, or Ostra Cloud's signer):
//   voucher key     x402 batch-settlement Vouchers (EIP-712, on the x402 Batch Settlement domain) and OstraVault close
//                   requests built from their fields; nothing else
//   payment wallet  EIP-3009 TransferWithAuthorization from the wallet itself, on the token it was derived for
//   posting key     Ostrapad's reserve, upload and wrap messages built from their fields
// A request for anything else is refused before the seed is asked: no raw hash, message or transaction is ever signed.

import { getAddress, isAddress, type Address, type Hex, type LocalAccount, type TypedDataDefinition } from "viem";
import { toAccount } from "viem/accounts";
import { X402_BATCH_SETTLEMENT, X402_BATCH_SETTLEMENT_DOMAIN, padReserveMessage, padUploadMessage, padWrapMessage, type PadEncKind, type PadWrap } from "@ostraagent/sdk";
import type { AgentSeed } from "./keys.ts";

const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** An x402 batch-settlement Voucher: the channel and the highest cumulative amount its payee may claim. */
export type VoucherFields = { channelId: Hex; maxClaimableAmount: bigint };
/** An OstraVault CloseRequest (sdk closeRequestTypedData) without its chain, which the voucher key's own is. */
export type CloseRequestFields = { vault: Address; channelId: Hex; amount: bigint; nonce: bigint; deadline: bigint };
/** An EIP-3009 TransferWithAuthorization from the payment wallet, with the token's EIP-712 name and version. */
export type PaymentTransfer = { name: string; version: string; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
/** What Ostrapad's posting key signs (sdk padReserveMessage, padUploadMessage, padWrapMessage). */
export type PadPostMessage =
  | { kind: "reserve"; jobId: Hex; bytes: bigint; seq: bigint }
  | { kind: "upload"; jobId: Hex; encKind: PadEncKind; sha256: Hex; size: bigint }
  | { kind: "wrap"; jobId: Hex; round: number; wrap: PadWrap; seq: bigint };

/** The EIP-3009 TransferWithAuthorization type, field by field. */
export const TRANSFER_WITH_AUTHORIZATION_TYPE = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

const VOUCHER_TYPE = [
  { name: "channelId", type: "bytes32" },
  { name: "maxClaimableAmount", type: "uint128" },
] as const;

/** A channel's voucher key: its address, x402 Voucher signatures (signTypedData) and close requests (signClose). */
export type VoucherAccount = LocalAccount & { signClose(c: CloseRequestFields): Promise<Hex> };
/** Ostrapad's posting key: its address and its signatures of Ostrapad's messages. */
export type PadPoster = { address: Address; signPost(m: PadPostMessage): Promise<Hex> };

class SeedUseError extends Error {
  constructor(key: string, what: string) {
    super(`the ${key} signs only ${what}; this request was refused`);
    this.name = "SeedUseError";
  }
}

function sameKeys(o: unknown, keys: readonly string[]): o is Record<string, unknown> {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
}

function sameType(fields: unknown, want: readonly { name: string; type: string }[]): boolean {
  return (
    Array.isArray(fields) &&
    fields.length === want.length &&
    fields.every((f, i) => sameKeys(f, ["name", "type"]) && f.name === want[i]?.name && f.type === want[i]?.type)
  );
}

/** A uint of at most `max` given as a bigint, a safe integer or a decimal string (as typed data carries them); else null. */
function uint(v: unknown, max: bigint): bigint | null {
  let n: bigint;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === "string" && /^[0-9]{1,78}$/.test(v)) n = BigInt(v);
  else return null;
  return n >= 0n && n <= max ? n : null;
}

function chainOf(v: unknown): number | null {
  const n = uint(v, BigInt(Number.MAX_SAFE_INTEGER));
  return n === null ? null : Number(n);
}

function address(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

/** The Voucher in `td` when it is one on the x402 Batch Settlement domain of `chainId`; else null. */
export function voucherOf(td: TypedDataDefinition, chainId: number): VoucherFields | null {
  const t = td as { domain?: unknown; types?: unknown; primaryType?: unknown; message?: unknown };
  if (t.primaryType !== "Voucher" || !sameKeys(t.types, ["Voucher"]) || !sameType(t.types.Voucher, VOUCHER_TYPE)) return null;
  if (!sameKeys(t.domain, ["name", "version", "chainId", "verifyingContract"])) return null;
  const d = t.domain;
  if (d.name !== X402_BATCH_SETTLEMENT_DOMAIN.name || d.version !== X402_BATCH_SETTLEMENT_DOMAIN.version) return null;
  if (chainOf(d.chainId) !== chainId || address(d.verifyingContract) !== getAddress(X402_BATCH_SETTLEMENT)) return null;
  if (!sameKeys(t.message, ["channelId", "maxClaimableAmount"])) return null;
  const m = t.message;
  const max = uint(m.maxClaimableAmount, U128_MAX);
  if (typeof m.channelId !== "string" || !BYTES32.test(m.channelId) || max === null) return null;
  return { channelId: m.channelId as Hex, maxClaimableAmount: max };
}

/** The transfer in `td` when it is a TransferWithAuthorization from `from` on `token`'s domain of `chainId`; else null. */
export function paymentTransferOf(td: TypedDataDefinition, chainId: number, token: Address, from: Address): PaymentTransfer | null {
  const t = td as { domain?: unknown; types?: unknown; primaryType?: unknown; message?: unknown };
  if (t.primaryType !== "TransferWithAuthorization" || !sameKeys(t.types, ["TransferWithAuthorization"])) return null;
  if (!sameType(t.types.TransferWithAuthorization, TRANSFER_WITH_AUTHORIZATION_TYPE)) return null;
  if (!sameKeys(t.domain, ["name", "version", "chainId", "verifyingContract"])) return null;
  const d = t.domain;
  if (typeof d.name !== "string" || typeof d.version !== "string") return null;
  if (chainOf(d.chainId) !== chainId || address(d.verifyingContract) !== getAddress(token)) return null;
  if (!sameKeys(t.message, ["from", "to", "value", "validAfter", "validBefore", "nonce"])) return null;
  const m = t.message;
  const to = address(m.to);
  const value = uint(m.value, U256_MAX);
  const validAfter = uint(m.validAfter, U256_MAX);
  const validBefore = uint(m.validBefore, U256_MAX);
  if (address(m.from) !== getAddress(from) || to === null || value === null || validAfter === null || validBefore === null) return null;
  if (typeof m.nonce !== "string" || !BYTES32.test(m.nonce)) return null;
  return { name: d.name, version: d.version, to, value, validAfter, validBefore, nonce: m.nonce as Hex };
}

/** The 32-byte hash Ostrapad's posting key signs (EIP-191, raw) for message `m` on (chain, OstraPad). */
export function padPostHash(chainId: number, pad: Address, m: PadPostMessage): Hex {
  switch (m.kind) {
    case "reserve":
      return padReserveMessage({ chainId, pad, jobId: m.jobId, bytes: m.bytes, seq: m.seq });
    case "upload":
      return padUploadMessage({ chainId, pad, jobId: m.jobId, kind: m.encKind, sha256: m.sha256, size: m.size });
    case "wrap":
      return padWrapMessage({ chainId, pad, jobId: m.jobId, round: m.round, wrap: m.wrap, seq: m.seq });
  }
}

function refuse(key: string, what: string): () => Promise<never> {
  return () => Promise.reject(new SeedUseError(key, what));
}

/** The voucher key of the channel opened with `salt` on (chain, token), for x402's voucher signer and close requests. */
export async function voucherAccount(seed: AgentSeed, chainId: number, token: Address, salt: Hex): Promise<VoucherAccount> {
  const what = "x402 Vouchers and OstraVault close requests";
  const account = toAccount({
    address: await seed.voucherAddress(chainId, token, salt),
    signMessage: refuse("voucher key", what),
    signTransaction: refuse("voucher key", what),
    signTypedData: async (td) => {
      const v = voucherOf(td as TypedDataDefinition, chainId);
      if (v === null) throw new SeedUseError("voucher key", what);
      return seed.signVoucher(chainId, token, salt, v);
    },
  });
  return Object.assign(account, { signClose: (c: CloseRequestFields) => seed.signCloseRequest(chainId, token, salt, c) });
}

/** The payment wallet of `vault` on (chain, token), for x402's exact scheme and withdrawals to the vault. */
export async function paymentWalletAccount(seed: AgentSeed, chainId: number, token: Address, vault: Address): Promise<LocalAccount> {
  const what = "EIP-3009 transfers from itself on its token";
  const from = await seed.paymentWalletAddress(chainId, token, vault);
  return toAccount({
    address: from,
    signMessage: refuse("payment wallet", what),
    signTransaction: refuse("payment wallet", what),
    signTypedData: async (td) => {
      const t = paymentTransferOf(td as TypedDataDefinition, chainId, token, from);
      if (t === null) throw new SeedUseError("payment wallet", what);
      return seed.signPaymentTransfer(chainId, token, vault, t);
    },
  });
}

/** Ostrapad's posting key on (chain, OstraPad). */
export async function padPoster(seed: AgentSeed, chainId: number, pad: Address): Promise<PadPoster> {
  return { address: await seed.padPostingAddress(chainId, pad), signPost: (m) => seed.signPadPost(chainId, pad, m) };
}
