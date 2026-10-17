// A vault spend this agent signed whose transaction never landed. A WOTS key
// may sign only one message (one key, one message), so the only way forward
// for the vault is to send that same signed message; these decoders read the
// stored message back into what it does, so the vault can resend it and the
// agent can be told what is pending.
//
// Layout (OstraVault.spendMessage, sdk messages.ts):
//   "OSTRA/VAULT/EVM/v1" || chain ID (32) || vault (20) || nonce (u64)
//   || next key root (32) || action (u8) || params
// with params abi-encoded: Transfer (to, amount); OpenChannel (payerAuthorizer,
// receiver, receiverAuthorizer, withdrawDelay, salt, amount); SetCrankKey
// (crank; the zero address removes the crank). On Solana the message also
// bound accounts (the destination token account, the payee and voucher key);
// on Robinhood Chain the params carry them.

import { zeroAddress, type Address, type Hex } from "viem";
import { VAULT_ACTION, decodeOpenChannelParams, decodeSetCrankParams, decodeTransferParams, decodeVaultSpendMessage, type OpenChannelParams, type VaultAction } from "@ostraagent/sdk";

export type VaultSpendHeader = { chainId: number; vault: Address; nonce: bigint; nextKeyRoot: Hex; action: VaultAction };
export type PendingTransfer = VaultSpendHeader & { to: Address; amount: bigint };
export type PendingOpenChannel = VaultSpendHeader & { open: OpenChannelParams };
/** `crank` null: the spend removes the crank. */
export type PendingSetCrankKey = VaultSpendHeader & { crank: Address | null };

export function decodeVaultSpendHeader(message: Uint8Array): VaultSpendHeader {
  const s = decodeVaultSpendMessage(message);
  return { chainId: s.chainId, vault: s.vault, nonce: s.nonce, nextKeyRoot: s.nextKeyRoot, action: s.action };
}

function decodeAs(message: Uint8Array, action: VaultAction): { header: VaultSpendHeader; params: Hex } {
  const s = decodeVaultSpendMessage(message);
  if (s.action !== action) throw new Error(`not a vault spend of action ${action}`);
  return { header: { chainId: s.chainId, vault: s.vault, nonce: s.nonce, nextKeyRoot: s.nextKeyRoot, action: s.action }, params: s.params };
}

export function decodeVaultTransferMessage(message: Uint8Array): PendingTransfer {
  const { header, params } = decodeAs(message, VAULT_ACTION.TRANSFER);
  return { ...header, ...decodeTransferParams(params) };
}

export function decodeVaultOpenChannelMessage(message: Uint8Array): PendingOpenChannel {
  const { header, params } = decodeAs(message, VAULT_ACTION.OPEN_CHANNEL);
  return { ...header, open: decodeOpenChannelParams(params) };
}

export function decodeVaultSetCrankKeyMessage(message: Uint8Array): PendingSetCrankKey {
  const { header, params } = decodeAs(message, VAULT_ACTION.SET_CRANK_KEY);
  const crank = decodeSetCrankParams(params);
  return { ...header, crank: crank === zeroAddress ? null : crank };
}
