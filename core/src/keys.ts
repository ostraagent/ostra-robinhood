// The agent's keys. Every key is derived from the 32-byte master seed:
//
//   * the WOTS keychains of the vaults and of shield deposits (key index = the
//     on-chain nonce, the approval count or the leaf's number);
//   * the secp256k1 voucher key of every channel (from its salt), the one-time
//     depositor key and the deposit id of every shield deposit (from its
//     number), and the seller's merchant and crank keys;
//   * the secrets of the agent's notes in Ostra Swap's private pool: its sk,
//     each shield's rho (from the shield's number) and each spend's change
//     and output rho (from the note spent), so that the seed recovers whose
//     every note is (private-balance.ts);
//
// so the seed alone recovers every vault, channel, deposit and leaf. The fee
// payer key pays transaction gas when no relayer pays; it holds only ETH,
// never tokens. Every WOTS signature goes to the WotsStore before it is used
// (one key, one message; see WotsKeychain), and with the relayer's signature
// escrow (escrow.ts) every key with no local record asks the escrow before it
// signs, so a device restored from the seed never signs twice with one key.
//
// On Robinhood Chain (design v0.4) the Ed25519 keys of the Solana version are
// secp256k1 keys from the same derivation, and every derivation names the
// chain (chain ID, 32 bytes) and the token (20 bytes) where it named the
// cluster and the mint; the domains carry "/EVM/v1", so no key of this chain
// is ever the key of another.
//
// The MCP package keeps the seed, the fee payer key and the WOTS store on
// disk in OSTRA_HOME (mcp/src/keys.ts); the web app keeps them in the
// browser. Nothing here is ever sent anywhere or printed.

import { bytesToHex, getAddress, hexToBytes, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WotsKeychain, sha256, utf8, type WotsStore } from "@ostraagent/sdk";
import type { SignatureEscrowClient } from "./escrow.ts";
import { backupSignerOf, sealSeed } from "./passkey.ts";
import type { Folder } from "./storage.ts";

/** The folder of the private vaults' records: one folder per private vault in it (keys.forPrivateVault). */
export const PRIVATE_DIR = "private";
/** The folder of the creator vaults' records: one folder per (chain, token) in it (keys.forCreatorVault). */
export const CREATOR_DIR = "creator";

const VAULT_KEYCHAIN_DOMAIN = utf8("OSTRA/MCP/VAULT/EVM/v1");
const VOUCHER_KEY_DOMAIN = utf8("OSTRA/MCP/VOUCHER/EVM/v1");
const SELLER_KEYCHAIN_DOMAIN = utf8("OSTRA/MCP/SELLER-VAULT/EVM/v1");
const MERCHANT_KEY_DOMAIN = utf8("OSTRA/MCP/MERCHANT/EVM/v1");
const SELF_CRANK_DOMAIN = utf8("OSTRA/MCP/SELF-CRANK/EVM/v1");
const SHIELD_KEY_DOMAIN = utf8("OSTRA/MCP/SHIELD-KEY/EVM/v1");
const SHIELD_DEPOSIT_ID_DOMAIN = utf8("OSTRA/MCP/SHIELD-DEPOSIT-ID/EVM/v1");
const SHIELD_APPROVE_KEYCHAIN_DOMAIN = utf8("OSTRA/MCP/SHIELD-APPROVE/EVM/v1");
const SHIELD_LEAF_KEYCHAIN_DOMAIN = utf8("OSTRA/MCP/SHIELD-LEAF/EVM/v1");
const PRIVATE_VAULT_KEYCHAIN_DOMAIN = utf8("OSTRA/MCP/PRIVATE-VAULT/EVM/v1");
const CREATOR_KEYCHAIN_DOMAIN = utf8("OSTRA/MCP/CREATOR-VAULT/EVM/v1");
const NOTE_SECRET_DOMAIN = utf8("OSTRA/MCP/SWAP-NOTE/EVM/v1");

/** secp256k1 group order: a private key must be in 1..n-1. */
const SECP256K1_N = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_fffe_baae_dce6_af48_a03b_bfd2_5e8c_d036_4141n;
const U64_MAX = (1n << 64n) - 1n;

/** The chain ID as 32 bytes, big-endian (uint256). */
function chainBytes(chainId: number): Uint8Array {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError("chainId must be a positive integer");
  return hexToBytes(`0x${BigInt(chainId).toString(16).padStart(64, "0")}`);
}

/** A token address as its 20 bytes. */
function tokenBytes(token: Address): Uint8Array {
  return hexToBytes(getAddress(token));
}

/** A u64 as 8 bytes, big-endian (an index). */
function u64Be(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) throw new RangeError("index out of range");
  return hexToBytes(`0x${value.toString(16).padStart(16, "0")}`);
}

/** A channel salt: 32 bytes of hex. */
function saltBytes(salt: Hex): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new RangeError("a channel salt is 32 bytes");
  return hexToBytes(salt);
}

/** True when `secret` is a valid secp256k1 private key. */
export function isPrivateKey(secret: Uint8Array): boolean {
  if (secret.length !== 32) return false;
  const k = BigInt(bytesToHex(secret));
  return k > 0n && k < SECP256K1_N;
}

/** The secp256k1 account of a derived 32-byte secret (outside 1..n-1 with probability about 2^-128: refused). */
export function accountFromSecret(secret: Uint8Array): PrivateKeyAccount {
  if (!isPrivateKey(secret)) throw new Error("the derived secret is not a valid secp256k1 private key");
  return privateKeyToAccount(bytesToHex(secret));
}

/**
 * Keychain id of the vault for (chain, token). Deterministic and public: the
 * secret part of every key is the master seed (see deriveWotsSeed).
 */
export function vaultKeychainId(chainId: number, token: Address): Uint8Array {
  return sha256([VAULT_KEYCHAIN_DOMAIN, chainBytes(chainId), tokenBytes(token)]);
}

/**
 * Keychain id of the seller vault for (chain, token). It differs from the
 * buyer vault's, so the two vaults never sign with the same one-time key.
 */
export function sellerKeychainId(chainId: number, token: Address): Uint8Array {
  return sha256([SELLER_KEYCHAIN_DOMAIN, chainBytes(chainId), tokenBytes(token)]);
}

/** The parts that name one shield deposit: chain, token and the deposit's number. */
function shieldParts(chainId: number, token: Address, index: bigint): Uint8Array[] {
  return [chainBytes(chainId), tokenBytes(token), u64Be(index)];
}

/** Keychain id of the approval keys of shield deposit `index` (public; the secret is the master seed). */
export function shieldApprovalKeychainId(chainId: number, token: Address, index: bigint): Uint8Array {
  return sha256([SHIELD_APPROVE_KEYCHAIN_DOMAIN, ...shieldParts(chainId, token, index)]);
}

/** Keychain id of the leaf keys of shield deposit `index`: leaf j of leaf set a is key a * 256 + j (shield.ts leafKeyIndex; public, the secret is the master seed). */
export function shieldLeafKeychainId(chainId: number, token: Address, index: bigint): Uint8Array {
  return sha256([SHIELD_LEAF_KEYCHAIN_DOMAIN, ...shieldParts(chainId, token, index)]);
}

/** Keychain id of private vault `index` (unshield; public, the secret is the master seed). */
export function privateVaultKeychainId(chainId: number, token: Address, index: bigint): Uint8Array {
  return sha256([PRIVATE_VAULT_KEYCHAIN_DOMAIN, chainBytes(chainId), tokenBytes(token), u64Be(index)]);
}

/**
 * Keychain id of the creator vault for (chain, token): the vault a launch pays
 * its creator's share to (OstraLaunchpad creatorVault), one per quote token.
 */
export function creatorKeychainId(chainId: number, token: Address): Uint8Array {
  return sha256([CREATOR_KEYCHAIN_DOMAIN, chainBytes(chainId), tokenBytes(token)]);
}

/** What a Keys holds: the master seed and fee payer key, the WOTS store, and where records are kept. */
export type KeysParts<S extends WotsStore = WotsStore> = {
  master: Uint8Array;
  feePayer: PrivateKeyAccount;
  store: S;
  /** Where the services of this vault keep their records. */
  folder: Folder;
  /** The agent's own folder (the main vault's); defaults to `folder`. */
  root?: Folder;
  /** True when the master seed was created just now (a backup should follow). */
  masterCreated?: boolean;
  /** True once an encrypted backup of the master seed was exported. */
  backupExported: () => Promise<boolean>;
  /** The relayer's signature escrow (with OSTRA_RELAYER_URL; the web app always has one). */
  escrow?: SignatureEscrowClient | null;
};

export class Keys<S extends WotsStore = WotsStore> {
  /** Where records are kept: the agent's folder, or a private vault's own folder in it (forPrivateVault). */
  readonly folder: Folder;
  readonly feePayer: PrivateKeyAccount;
  readonly store: S;
  /** True when this call created the master seed (a backup should follow). */
  readonly masterCreated: boolean;
  /** The relayer's signature escrow every keychain asks before it signs; null: records on this device only. */
  readonly escrow: SignatureEscrowClient | null;
  readonly #master: Uint8Array;
  readonly #root: Folder;
  readonly #backupExported: () => Promise<boolean>;

  constructor(parts: KeysParts<S>) {
    if (parts.master.length !== 32) throw new RangeError("the master seed must be 32 bytes");
    this.folder = parts.folder;
    this.feePayer = parts.feePayer;
    this.store = parts.store;
    this.masterCreated = parts.masterCreated ?? false;
    this.escrow = parts.escrow ?? null;
    this.#master = parts.master.slice();
    this.#root = parts.root ?? parts.folder;
    this.#backupExported = parts.backupExported;
  }

  /**
   * The same keys with records kept in the folder of private vault `index`
   * (<agent folder>/private/<chain>-<token>-<index>, created now): the
   * services of that vault keep their records there. The master seed, the fee
   * payer and the WOTS store stay the agent's.
   */
  async forPrivateVault(chainId: number, token: Address, index: bigint): Promise<Keys<S>> {
    const folder = this.#root.folder(PRIVATE_DIR).folder(`${chainId}-${getAddress(token)}-${index}`);
    await folder.ensure();
    return new Keys({ master: this.#master, feePayer: this.feePayer, store: this.store, folder, root: this.#root, backupExported: this.#backupExported, escrow: this.escrow });
  }

  /**
   * The same keys with records kept in the folder of the creator vault for
   * (chain, token) (<agent folder>/creator/<chain>-<token>, created now): its
   * relayer client and channels are its own. Shield records stay in the
   * agent's folder (ShieldService takes the agent's keys).
   */
  async forCreatorVault(chainId: number, token: Address): Promise<Keys<S>> {
    const folder = this.#root.folder(CREATOR_DIR).folder(`${chainId}-${getAddress(token)}`);
    await folder.ensure();
    return new Keys({ master: this.#master, feePayer: this.feePayer, store: this.store, folder, root: this.#root, backupExported: this.#backupExported, escrow: this.escrow });
  }

  /** True once an encrypted backup of the master seed has been exported. */
  backupExported(): Promise<boolean> {
    return this.#backupExported();
  }

  /** The seed's backup key (passkey.ts): it signs this seed's writes to the relayer's passkey backups. */
  backupSigner(): PrivateKeyAccount {
    return backupSignerOf(this.#master);
  }

  /** The master seed encrypted under a passkey's PRF output, for the backup of passkey `credentialId` (passkey.ts sealSeed). */
  passkeyBackup(prf: Uint8Array, credentialId: Uint8Array): Promise<string> {
    return sealSeed(this.#master, prf, credentialId);
  }

  /** A keychain of this seed that asks the signature escrow (when there is one) before it signs. */
  #keychain(id: Uint8Array): WotsKeychain {
    return new WotsKeychain(this.#master, id, this.store, this.escrow?.lookup);
  }

  vaultKeychain(chainId: number, token: Address): WotsKeychain {
    return this.#keychain(vaultKeychainId(chainId, token));
  }

  sellerKeychain(chainId: number, token: Address): WotsKeychain {
    return this.#keychain(sellerKeychainId(chainId, token));
  }

  /** Keychain of the creator vault for (chain, token) (key index = the vault's on-chain nonce). */
  creatorKeychain(chainId: number, token: Address): WotsKeychain {
    return this.#keychain(creatorKeychainId(chainId, token));
  }

  /** Keychain of private vault `index` (key index = the vault's on-chain nonce). */
  privateVaultKeychain(chainId: number, token: Address, index: bigint): WotsKeychain {
    return this.#keychain(privateVaultKeychainId(chainId, token, index));
  }

  /**
   * The seller's merchant key for (chain, token), as a private key: the keeper
   * derives the seller's crank from its address, and the seller server signs
   * its close requests with it.
   */
  merchantKey(chainId: number, token: Address): Hex {
    const secret = sha256([MERCHANT_KEY_DOMAIN, this.#master, chainBytes(chainId), tokenBytes(token)]);
    accountFromSecret(secret);
    return bytesToHex(secret);
  }

  /** The seller's own crank key for (chain, token), installed by settle_self when the keeper cannot act. */
  selfCrankSigner(chainId: number, token: Address): PrivateKeyAccount {
    return accountFromSecret(sha256([SELF_CRANK_DOMAIN, this.#master, chainBytes(chainId), tokenBytes(token)]));
  }

  /**
   * Voucher key (the channel's payerAuthorizer) of the channel this vault
   * opens with `salt`. The salt is part of the channel config, so the master
   * seed and the config recover the key.
   */
  channelVoucherSigner(chainId: number, token: Address, salt: Hex): PrivateKeyAccount {
    return accountFromSecret(sha256([VOUCHER_KEY_DOMAIN, this.#master, chainBytes(chainId), tokenBytes(token), saltBytes(salt)]));
  }

  /**
   * One-time depositor key of shield deposit `index` (design v0.3, decided 15
   * Oct 2026): it holds the deposit's tokens for one deposit, signs the
   * deposit's EIP-3009 authorization and the aggregator polls.
   */
  shieldSigner(chainId: number, token: Address, index: bigint): PrivateKeyAccount {
    return accountFromSecret(sha256([SHIELD_KEY_DOMAIN, this.#master, ...shieldParts(chainId, token, index)]));
  }

  /** depositId of shield deposit `index`; with the depositor key it fixes the deposit key (OstraPool.depositKey). */
  shieldDepositId(chainId: number, token: Address, index: bigint): Hex {
    return bytesToHex(sha256([SHIELD_DEPOSIT_ID_DOMAIN, this.#master, ...shieldParts(chainId, token, index)]));
  }

  /** Approval keys of shield deposit `index` (one per approveBatch; the key rotates every time). */
  shieldApprovalKeychain(chainId: number, token: Address, index: bigint): WotsKeychain {
    return this.#keychain(shieldApprovalKeychainId(chainId, token, index));
  }

  /**
   * A 32-byte secret of the agent's notes in Ostra Swap's private pool `pool` on chain `chainId`: `purpose` "sk"
   * (index 0: the agent's note key) or "rho" (index n: shield n's nonce), or a further block (`block` > 0) of the same
   * secret when a field element must be drawn again (private-balance.ts #digest).
   */
  noteSecret(chainId: number, pool: Address, purpose: "sk" | "rho", index: bigint, block = 0n): Uint8Array {
    return sha256([NOTE_SECRET_DOMAIN, this.#master, chainBytes(chainId), tokenBytes(pool), utf8(purpose), u64Be(index), u64Be(block)]);
  }

  /**
   * A 32-byte secret of a spend of the note `spent` (its 32-byte commitment) in the private pool `pool`: `purpose`
   * "change" (the nonce of its change note) or "out" (the nonce of a private swap's output note), or a further block.
   * A note is spent once, so each is used once; the chain's events and the seed say them again.
   */
  spendNoteSecret(chainId: number, pool: Address, purpose: "change" | "out", spent: Hex, block = 0n): Uint8Array {
    if (!/^0x[0-9a-fA-F]{64}$/.test(spent)) throw new RangeError("the note spent is a 32-byte commitment");
    return sha256([NOTE_SECRET_DOMAIN, this.#master, chainBytes(chainId), tokenBytes(pool), utf8(purpose), hexToBytes(spent), u64Be(block)]);
  }

  /** Leaf keys of shield deposit `index`: leaf j of leaf set a is key a * 256 + j (shield.ts leafKeyIndex), which spends it once. */
  shieldLeafKeychain(chainId: number, token: Address, index: bigint): WotsKeychain {
    return this.#keychain(shieldLeafKeychainId(chainId, token, index));
  }
}
