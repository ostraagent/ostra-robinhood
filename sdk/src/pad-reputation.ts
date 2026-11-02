// A reputation proof in an Ostrapad listing (reputation.ts, specified by Edu on 2 Nov 2026; reworked after the
// stage-3 review): a listing is "backed by an Ostra record meeting these thresholds that backs no other listing this
// epoch". It is not anonymous (the listing names its provider vault, whose own OstraPad record is public and shown
// by the index without any proof), and the record behind it need not be the provider vault's: the proof shows that
// some Ostra vault's record meets the thresholds, and its pseudonym, one per record and epoch in the one global
// scope, lets the index refuse a record that backs two listings. Ostra's index verifies it on chain
// (OstraReputation.verify, an eth_call), keeps pseudonym -> listings for the epoch, and shows the statements only
// when the pseudonym backs that listing alone; a client can check it the same way. Every field of it is the
// writer's: nothing is shown that the chain did not verify.
//
// The proof's public inputs are fixed by the listing, never taken from it:
//   scope      repScope("ostrapad:listings", epoch) = keccak256("ostrapad:listings:<epoch>"), one scope for every
//              listing, the epoch the current one (a proof holds only within the epoch it was made in: the listing
//              is proven again each epoch)
//   recipient  the listing's provider vault
//   challenge  padListingChallenge(file): keccak256 of the registration file's canonical JSON (keys sorted at every
//              level, no spaces) with the Ostrapad entry's `reputation` field left out, so the proof is bound to the
//              listing's exact content (its offers, provider, name and every other field)
// The listing's `reputation` carries the root, the pseudonym, the thresholds and the proof. A proof is about 81 KB,
// more than one file Ostra's uploader pins (16,384 bytes of JSON): it is pinned in parts (padReputationProofParts),
// each a JSON file under its CID holding a run of the proof's hex, which the listing names in order with the sha256 of
// the whole proof.

import { getAddress, hexToBytes, isAddress, keccak256, sha256, stringToHex, type Address, type Hex } from "viem";
import { OSTRAPAD, PAD_SERVICE_NAME, padDigestFromCid } from "./pad.ts";
import { ROBINHOOD_CHAIN_ID } from "./constants.ts";
import { REP_EPOCH_LIMIT, repIsCanonical, repScope, repThresholdsProblem, type RepThresholds } from "./reputation.ts";

/** The field of a listing's Ostrapad entry that carries its reputation proof. */
export const PAD_REPUTATION_FIELD = "reputation";
export const PAD_REPUTATION_TYPE = "ostra-reputation-v1";
export const PAD_REPUTATION_PART_TYPE = "ostra-reputation-proof-part-v1";
/** Hex characters of the proof in one part file (with its other fields, under the uploader's 16,384 bytes). */
export const PAD_REPUTATION_PART_CHARS = 15_000;
/** The most parts a listing's proof may have (a proof is about 81 KB: 11 parts). */
export const PAD_REPUTATION_MAX_PARTS = 16;

/** The scope text of every listing proof (one scope for all listings, so one record has one pseudonym an epoch); its bytes32 scope is repScope(text, epoch). */
export const PAD_LISTINGS_SCOPE_TEXT = "ostrapad:listings";

/** The bytes32 scope of the listing proofs of `epoch`: keccak256("ostrapad:listings:<epoch>"). */
export function padListingScope(epoch: bigint): Hex {
  return repScope(PAD_LISTINGS_SCOPE_TEXT, epoch);
}

/** JSON with every object's keys sorted, no spaces (what padListingChallenge hashes). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError("JSON has no infinite numbers");
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value === undefined) throw new RangeError("not JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

function isPadEntry(s: unknown, endpoint: string): s is Record<string, unknown> {
  return typeof s === "object" && s !== null && (s as { name?: unknown }).name === PAD_SERVICE_NAME && typeof (s as { endpoint?: unknown }).endpoint === "string" && (s as { endpoint: string }).endpoint.toLowerCase() === endpoint;
}

/** The Ostrapad entry of a registration file for this pad and chain (as padListingFromFile finds it), as written; null when it has none. */
export function padListingEntry(file: unknown, pad: Address = OSTRAPAD, chainId: number = ROBINHOOD_CHAIN_ID): Record<string, unknown> | null {
  if (typeof file !== "object" || file === null) return null;
  const services = (file as { services?: unknown }).services;
  if (!Array.isArray(services)) return null;
  const endpoint = `eip155:${chainId}:${getAddress(pad)}`.toLowerCase();
  return (services.find((s) => isPadEntry(s, endpoint)) as Record<string, unknown> | undefined) ?? null;
}

/**
 * The challenge of a listing's proof: keccak256 of the registration file's canonical JSON with the Ostrapad entry's
 * `reputation` left out (the entry the listing is, as padListingFromFile finds it: its name and this pad's endpoint).
 */
export function padListingChallenge(file: Record<string, unknown>, pad: Address = OSTRAPAD, chainId: number = ROBINHOOD_CHAIN_ID): Hex {
  const endpoint = `eip155:${chainId}:${getAddress(pad)}`.toLowerCase();
  const services = Array.isArray(file.services) ? file.services : [];
  const copy = {
    ...file,
    ...(Array.isArray(file.services)
      ? {
          services: services.map((s) => {
            if (!isPadEntry(s, endpoint)) return s;
            const { [PAD_REPUTATION_FIELD]: _r, ...rest } = s;
            return rest;
          }),
        }
      : {}),
  };
  return keccak256(stringToHex(canonicalJson(copy)));
}

/** A listing's reputation proof, as it is written in its Ostrapad entry (every field the writer's until verified). */
export type PadReputation = {
  type: typeof PAD_REPUTATION_TYPE;
  /** eip155:<chain>:<OstraReputation>. */
  contract: string;
  epoch: string;
  root: Hex;
  pseudonym: Hex;
  /** Decimal strings (minVolume in USDG base units). */
  thresholds: { minCompleted: string; minClients: string; minVolume: string; maxFailPermille: string; minTier: string; maxFirstDay: string };
  /** The proof's part files, in order (ipfs:// CIDv1 raw sha2-256). */
  proofParts: string[];
  /** sha256 of the whole proof's bytes. */
  proofSha256: Hex;
  /** The anonymity set the prover counted (the writer's figure, never shown). */
  anonymitySet?: number;
};

export function padReputationEntry(p: { reputation: Address; chainId: number; epoch: bigint; root: Hex; pseudonym: Hex; thresholds: RepThresholds; proofParts: string[]; proof: Hex; anonymitySet: number }): PadReputation {
  const t = p.thresholds;
  return {
    type: PAD_REPUTATION_TYPE,
    contract: `eip155:${p.chainId}:${getAddress(p.reputation)}`,
    epoch: p.epoch.toString(),
    root: p.root.toLowerCase() as Hex,
    pseudonym: p.pseudonym.toLowerCase() as Hex,
    thresholds: { minCompleted: String(t.minCompleted), minClients: String(t.minClients), minVolume: t.minVolume.toString(), maxFailPermille: String(t.maxFailPermille), minTier: String(t.minTier), maxFirstDay: String(t.maxFirstDay) },
    proofParts: [...p.proofParts],
    proofSha256: sha256(hexToBytes(p.proof)),
    anonymitySet: p.anonymitySet,
  };
}

/** The part files of a proof, in order (each under the uploader's 16,384 bytes of JSON). */
export function padReputationProofParts(proof: Hex): Record<string, unknown>[] {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(proof)) throw new RangeError("a proof is 0x and whole bytes of hex");
  const bytes = hexToBytes(proof);
  const text = proof.slice(2).toLowerCase();
  const of = Math.ceil(text.length / PAD_REPUTATION_PART_CHARS);
  if (of === 0 || of > PAD_REPUTATION_MAX_PARTS) throw new RangeError(`a proof of ${bytes.length} bytes does not fit ${PAD_REPUTATION_MAX_PARTS} parts`);
  const digest = sha256(bytes);
  return Array.from({ length: of }, (_, i) => ({ type: PAD_REPUTATION_PART_TYPE, proofSha256: digest, index: i, of, data: text.slice(i * PAD_REPUTATION_PART_CHARS, (i + 1) * PAD_REPUTATION_PART_CHARS) }));
}

const dec = (x: unknown, max: bigint): bigint | null => (typeof x === "string" && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= max ? BigInt(x) : null);

/** The reputation proof of a listing's Ostrapad entry, checked for shape (data, never trusted until verified); null when there is none or it is malformed. */
export function padReputationFromEntry(entry: unknown, reputation: Address, chainId: number): (PadReputation & { parsed: { epoch: bigint; thresholds: RepThresholds } }) | null {
  if (typeof entry !== "object" || entry === null) return null;
  const r = (entry as Record<string, unknown>)[PAD_REPUTATION_FIELD];
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  if (o.type !== PAD_REPUTATION_TYPE) return null;
  if (typeof o.contract !== "string" || o.contract.toLowerCase() !== `eip155:${chainId}:${getAddress(reputation)}`.toLowerCase()) return null;
  const epoch = dec(o.epoch, BigInt(REP_EPOCH_LIMIT) - 1n);
  if (epoch === null) return null;
  if (typeof o.root !== "string" || !repIsCanonical(o.root as Hex) || typeof o.pseudonym !== "string" || !repIsCanonical(o.pseudonym as Hex)) return null;
  const th = o.thresholds as Record<string, unknown> | null;
  if (typeof th !== "object" || th === null) return null;
  const small = (k: string) => dec(th[k], 1n << 32n);
  const vol = dec(th.minVolume, (1n << 128n) - 1n);
  const nums = ["minCompleted", "minClients", "maxFailPermille", "minTier", "maxFirstDay"].map(small);
  if (vol === null || nums.some((x) => x === null)) return null;
  const [minCompleted, minClients, maxFailPermille, minTier, maxFirstDay] = nums.map(Number) as [number, number, number, number, number];
  const thresholds: RepThresholds = { minCompleted, minClients, minVolume: vol, maxFailPermille, minTier, maxFirstDay };
  if (repThresholdsProblem(thresholds) !== null) return null;
  if (!Array.isArray(o.proofParts) || o.proofParts.length === 0 || o.proofParts.length > PAD_REPUTATION_MAX_PARTS || !o.proofParts.every((u) => typeof u === "string" && padDigestFromCid(u) !== null)) return null;
  if (typeof o.proofSha256 !== "string" || !/^0x[0-9a-f]{64}$/.test(o.proofSha256)) return null;
  const anonymitySet = typeof o.anonymitySet === "number" && Number.isSafeInteger(o.anonymitySet) && o.anonymitySet >= 0 ? o.anonymitySet : undefined;
  return {
    type: PAD_REPUTATION_TYPE,
    contract: o.contract,
    epoch: epoch.toString(),
    root: (o.root as string).toLowerCase() as Hex,
    pseudonym: (o.pseudonym as string).toLowerCase() as Hex,
    thresholds: { minCompleted: String(minCompleted), minClients: String(minClients), minVolume: vol.toString(), maxFailPermille: String(maxFailPermille), minTier: String(minTier), maxFirstDay: String(maxFirstDay) },
    proofParts: o.proofParts as string[],
    proofSha256: o.proofSha256 as Hex,
    ...(anonymitySet === undefined ? {} : { anonymitySet }),
    parsed: { epoch, thresholds },
  };
}

/** The proof from its part files (each read by its CID, its bytes checked there), checked against `sha256`; null when they do not make it. */
export function padReputationProofFromParts(parts: readonly unknown[], proofSha256: Hex): Hex | null {
  let text = "";
  for (const [i, p] of parts.entries()) {
    if (typeof p !== "object" || p === null) return null;
    const o = p as Record<string, unknown>;
    if (o.type !== PAD_REPUTATION_PART_TYPE || o.index !== i || o.of !== parts.length || o.proofSha256 !== proofSha256 || typeof o.data !== "string" || !/^[0-9a-f]+$/.test(o.data) || o.data.length > PAD_REPUTATION_PART_CHARS) return null;
    text += o.data;
  }
  if (text.length === 0 || text.length % 2 !== 0) return null;
  const proof = `0x${text}` as Hex;
  if (sha256(hexToBytes(proof)) !== proofSha256) return null;
  return proof;
}

/** The provider vault a listing's entry names (eip155:<chain>:<address>), or null. */
export function padEntryProvider(entry: Record<string, unknown>, chainId: number): Address | null {
  const prefix = `eip155:${chainId}:`;
  const text = typeof entry.provider === "string" && entry.provider.startsWith(prefix) ? entry.provider.slice(prefix.length) : "";
  return isAddress(text, { strict: false }) ? getAddress(text) : null;
}
