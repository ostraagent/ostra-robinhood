// Ostrapad (design "Ostrapad", decided by Edu on 26 and 27 Oct 2026): a market where agents are hired for work, paid
// in USDG through OstraPad's escrow (ERC-8183) and judged by an evaluator before the money moves. The contract is its
// own repository (github.com/ostraagent/ostrapad), deployed once at OSTRAPAD; this module builds, byte for byte, what
// it computes (test/pad.fork.test.ts compares each with the contract's own view on a fork of chain 4663):
//   * a job's id (keccak256 of its terms), the digest a role approves for an action (EIP-1271, actionDigest), and
//     the CREATE2 boxes a plain USDG transfer funds a job, an appeal or a bond through;
//   * the evaluator and appeal fees, and the commit of a reveal secret.
// An Ostra vault can only transfer tokens and approve hashes: it pays into a box with a Transfer spend and acts by
// approving the action's digest (ApproveHash), the call itself then sent by anyone (the relayer).
//
// It also holds the off-chain shapes Ostrapad agrees on:
//   * a provider's listing, an entry of its ERC-8004 registration file's services: the provider vault (its USDG vault,
//     where its pay lands) and its offers. The provider vault proves the listing is its own by approving
//     padListingDigest(agentId, creatorVault) (the creator vault owns the ERC-8004 identity), so nobody can list a
//     vault that is not theirs;
//   * an order and a delivery, JSON files pinned through the Ostra uploader: its CIDs are CIDv1 raw sha2-256
//     (bafkrei..., as the uploader's pins on chain show), so a job's bytes32 description or deliverable is the sha256
//     of the file and anyone who fetches it can check the bytes.

import {
  bytesToHex,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  hexToBytes,
  isAddress,
  keccak256,
  parseAbiItem,
  parseUnits,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { ROBINHOOD_CHAIN_ID } from "./constants.ts";
import { multicall3Abi } from "./external-abi.ts";
import { ostraPadAbi } from "./pad-abi.ts";

export { ostraPadAbi } from "./pad-abi.ts";

/** OstraPad on Robinhood Chain (deployed 27 Oct 2026, tx 0xab989ad7…f07, Sourcify exact match). */
export const OSTRAPAD: Address = "0x1BE28c4F08a548598fE0AA9b16DFD564C82E8055";
/** The block OSTRAPAD was deployed in: its logs start here. */
export const OSTRAPAD_FROM_BLOCK = 98_932_088n;
/** OstraPad.DOMAIN: keccak256("OSTRAPAD/v1"). */
export const PAD_DOMAIN: Hex = keccak256(stringToHex("OSTRAPAD/v1"));
/** OstraPad.BOX_CODE_HASH: keccak256 of PadBox's creation code (read from the contract on 27 Oct 2026). */
export const PAD_BOX_CODE_HASH: Hex = "0x34844b604681df62bf866f3a7d029aeefb2d3a27cee829988ae3f170aa786fac";

/** OstraPad's constants (the fork test compares each with the contract). Times in seconds, amounts in USDG base units. */
export const PAD = {
  JOB_LIFETIME: 7n * 86_400n,
  REVEAL_WINDOW: 86_400n,
  EVAL_WINDOW: 2n * 86_400n,
  DRAW_GRACE: 86_400n,
  APPEAL_WINDOW: 2n * 86_400n,
  PANEL_DRAW_WINDOW: 86_400n,
  VOTE_WINDOW: 2n * 86_400n,
  BOND_COOLDOWN: 7n * 86_400n,
  STAKE_DELAY: 2n * 86_400n,
  SNAPSHOT_TTL: 86_400n,
  MIN_BUDGET: 100_000n,
  MAX_BUDGET: 500_000_000n,
  RECORD_MIN_BUDGET: 1_000_000n,
  PLATFORM_FEE_BPS: 50n,
  EVAL_FEE_BPS: 100n,
  MIN_EVAL_FEE: 50_000n,
  APPEAL_FEE_BPS: 200n,
  MIN_APPEAL_FEE: 250_000n,
  EVALUATOR_SLASH_BPS: 2_000n,
  MIN_EVALUATOR_SLASH: 1_000_000n,
  PROVIDER_SLASH_BPS: 1_000n,
  MIN_EVALUATOR_BOND: 50_000_000n,
  MAX_TICKETS: 20n,
  MAX_POOL: 128n,
  MAX_MEMBERS: 256n,
  MIN_POOL_FOR_DRAW: 4n,
  PANEL: 3n,
} as const;

/** OstraPad.Status, by its number. */
export const PAD_STATUS = ["None", "Open", "Accepted", "Submitted", "Decided", "Appealed", "Completed", "Rejected", "Expired", "Cancelled"] as const;
export type PadStatus = (typeof PAD_STATUS)[number];

/** What the client signs (OstraPad.Terms): the job id is keccak256(abi.encode(terms)). */
export type PadTerms = {
  client: Address;
  provider: Address;
  /** The zero address: drawn from the pool. */
  evaluator: Address;
  budget: bigint;
  /** The order file's sha256 (padDigestFromCid of its CID). */
  description: Hex;
  /** Pool mode: padCommit(secret); else zero. */
  clientCommit: Hex;
  salt: Hex;
};

const TERMS = {
  type: "tuple",
  components: [
    { name: "client", type: "address" },
    { name: "provider", type: "address" },
    { name: "evaluator", type: "address" },
    { name: "budget", type: "uint256" },
    { name: "description", type: "bytes32" },
    { name: "clientCommit", type: "bytes32" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

const ZERO32: Hex = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

function word(value: Hex, name: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RangeError(`${name} must be 32 bytes (0x and 64 hex digits)`);
  return value.toLowerCase() as Hex;
}

/** The terms as OstraPad.create takes them (addresses checksummed, words lower case). */
export function padTerms(t: PadTerms): PadTerms {
  return {
    client: getAddress(t.client),
    provider: getAddress(t.provider),
    evaluator: getAddress(t.evaluator),
    budget: t.budget,
    description: word(t.description, "description"),
    clientCommit: word(t.clientCommit, "clientCommit"),
    salt: word(t.salt, "salt"),
  };
}

/** OstraPad.jobId(terms). */
export function padJobId(t: PadTerms): Hex {
  return keccak256(encodeAbiParameters([TERMS], [padTerms(t)]));
}

/** OstraPad's checks on terms that need no read of the chain (create refuses them all). */
export function padTermsProblems(t: PadTerms): string[] {
  const p: string[] = [];
  const zero = (a: Address) => getAddress(a) === ZERO_ADDRESS;
  if (zero(t.client) || zero(t.provider)) p.push("the client and the provider must be set");
  if (getAddress(t.provider) === getAddress(t.client)) p.push("the provider must not be the client");
  if (t.budget < PAD.MIN_BUDGET || t.budget > PAD.MAX_BUDGET) p.push("the budget must be 0.1 to 500 USDG");
  const pool = zero(t.evaluator);
  if (!pool && getAddress(t.evaluator) === getAddress(t.provider)) p.push("the evaluator must not be the provider");
  if (pool && word(t.clientCommit, "clientCommit") === ZERO32) p.push("a pool job needs the client's commit");
  return p;
}

/** keccak256(abi.encode(secret)): the commit OstraPad checks a reveal against. */
export function padCommit(secret: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }], [word(secret, "secret")]));
}

// ---------------------------------------------------------------------------------------------------------------
// Actions and their digests
// ---------------------------------------------------------------------------------------------------------------

/** An action a role authorizes, as OstraPad names it (keccak256(abi.encode(name, ...arguments))). */
export type PadAction =
  | { kind: "create"; id: Hex }
  | { kind: "cancel"; id: Hex }
  | { kind: "accept"; id: Hex; providerCommit: Hex }
  | { kind: "submit"; id: Hex; deliverable: Hex }
  | { kind: "decide"; id: Hex; round: number; approve: boolean; reason: Hex }
  | { kind: "appeal"; id: Hex; round: number }
  | { kind: "vote"; id: Hex; round: number; agree: boolean }
  | { kind: "join"; evaluator: Address; amount: bigint; nonce: bigint }
  | { kind: "leave"; evaluator: Address; nonce: bigint }
  | { kind: "withdraw"; account: Address; evaluator: boolean; nonce: bigint }
  | { kind: "bond"; provider: Address; amount: bigint; nonce: bigint }
  | { kind: "sweep job"; id: Hex; nonce: bigint }
  | { kind: "sweep bond"; account: Address; evaluator: boolean; nonce: bigint };

function uint8(n: number, name: string): number {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new RangeError(`${name} must be 0 to 255`);
  return n;
}

/** The action word OstraPad hashes for `a` (its _auth argument). */
export function padActionHash(a: PadAction): Hex {
  const s = { type: "string" } as const;
  const b32 = { type: "bytes32" } as const;
  const addr = { type: "address" } as const;
  const u256 = { type: "uint256" } as const;
  const u8 = { type: "uint8" } as const;
  const bool = { type: "bool" } as const;
  switch (a.kind) {
    case "create":
    case "cancel":
      return keccak256(encodeAbiParameters([s, b32], [a.kind, word(a.id, "id")]));
    case "accept":
      return keccak256(encodeAbiParameters([s, b32, b32], ["accept", word(a.id, "id"), word(a.providerCommit, "providerCommit")]));
    case "submit":
      return keccak256(encodeAbiParameters([s, b32, b32], ["submit", word(a.id, "id"), word(a.deliverable, "deliverable")]));
    case "decide":
      return keccak256(encodeAbiParameters([s, b32, u8, bool, b32], ["decide", word(a.id, "id"), uint8(a.round, "round"), a.approve, word(a.reason, "reason")]));
    case "appeal":
      return keccak256(encodeAbiParameters([s, b32, u8], ["appeal", word(a.id, "id"), uint8(a.round, "round")]));
    case "vote":
      return keccak256(encodeAbiParameters([s, b32, u8, bool], ["vote", word(a.id, "id"), uint8(a.round, "round"), a.agree]));
    case "join":
      return keccak256(encodeAbiParameters([s, addr, u256, u256], ["join", getAddress(a.evaluator), a.amount, a.nonce]));
    case "leave":
      return keccak256(encodeAbiParameters([s, addr, u256], ["leave", getAddress(a.evaluator), a.nonce]));
    case "withdraw":
      return keccak256(encodeAbiParameters([s, addr, bool, u256], ["withdraw", getAddress(a.account), a.evaluator, a.nonce]));
    case "bond":
      return keccak256(encodeAbiParameters([s, addr, u256, u256], ["bond", getAddress(a.provider), a.amount, a.nonce]));
    case "sweep job":
      return keccak256(encodeAbiParameters([s, b32, u256], ["sweep job", word(a.id, "id"), a.nonce]));
    case "sweep bond":
      return keccak256(encodeAbiParameters([s, addr, bool, u256], ["sweep bond", getAddress(a.account), a.evaluator, a.nonce]));
  }
}

/** OstraPad.actionDigest(action): what a role's vault approves (ApproveHash) to authorize it. */
export function padActionDigest(action: Hex, pad: Address = OSTRAPAD, chainId: number = ROBINHOOD_CHAIN_ID): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }], [PAD_DOMAIN, BigInt(chainId), getAddress(pad), word(action, "action")]),
  );
}

/** The digest a role approves for `a`. */
export function padDigest(a: PadAction, pad: Address = OSTRAPAD, chainId: number = ROBINHOOD_CHAIN_ID): Hex {
  return padActionDigest(padActionHash(a), pad, chainId);
}

/**
 * The digest a provider vault approves to make a listing its own: under OstraPad's domain, but no action OstraPad
 * checks ("listing" is none of its names), so the approval authorizes nothing there.
 */
export function padListingDigest(agentId: bigint, creatorVault: Address, pad: Address = OSTRAPAD, chainId: number = ROBINHOOD_CHAIN_ID): Hex {
  const action = keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }], ["listing", agentId, getAddress(creatorVault)]));
  return padActionDigest(action, pad, chainId);
}

// ---------------------------------------------------------------------------------------------------------------
// Boxes and fees
// ---------------------------------------------------------------------------------------------------------------

export function padJobSalt(id: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["job", word(id, "id")]));
}

export function padAppealSalt(id: Hex, round: number, appellant: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "uint8" }, { type: "address" }], ["appeal", word(id, "id"), uint8(round, "round"), getAddress(appellant)]));
}

export function padBondSalt(account: Address, evaluator: boolean): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }], [evaluator ? "evaluator" : "provider", getAddress(account)]));
}

/** OstraPad.boxAddress(salt). */
export function padBoxAddress(salt: Hex, pad: Address = OSTRAPAD): Address {
  return getContractAddress({ opcode: "CREATE2", from: getAddress(pad), salt: hexToBytes(word(salt, "salt")), bytecodeHash: hexToBytes(PAD_BOX_CODE_HASH) });
}

export function padJobBox(id: Hex, pad: Address = OSTRAPAD): Address {
  return padBoxAddress(padJobSalt(id), pad);
}

export function padAppealBox(id: Hex, round: number, appellant: Address, pad: Address = OSTRAPAD): Address {
  return padBoxAddress(padAppealSalt(id, round, appellant), pad);
}

export function padBondBox(account: Address, evaluator: boolean, pad: Address = OSTRAPAD): Address {
  return padBoxAddress(padBondSalt(account, evaluator), pad);
}

/** OstraPad.evaluatorFeeFor: 1% of the budget, at least 0.05 USDG (pool jobs only). */
export function padEvaluatorFee(budget: bigint): bigint {
  const f = (budget * PAD.EVAL_FEE_BPS) / 10_000n;
  return f < PAD.MIN_EVAL_FEE ? PAD.MIN_EVAL_FEE : f;
}

/** OstraPad.appealFeeFor: 2% of the budget, at least 0.25 USDG. */
export function padAppealFee(budget: bigint): bigint {
  const f = (budget * PAD.APPEAL_FEE_BPS) / 10_000n;
  return f < PAD.MIN_APPEAL_FEE ? PAD.MIN_APPEAL_FEE : f;
}

/** What a client funds for a job: the budget, plus the evaluator fee in pool mode. */
export function padFunding(budget: bigint, pool: boolean): bigint {
  return budget + (pool ? padEvaluatorFee(budget) : 0n);
}

/** What the provider receives on completion: the budget less the 0.5% platform fee (rounded as OstraPad rounds it). */
export function padProviderPay(budget: bigint): bigint {
  return budget - (budget * PAD.PLATFORM_FEE_BPS) / 10_000n;
}

// ---------------------------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------------------------

/** A call to OstraPad: `to` and its calldata. */
export type PadCall = { to: Address; data: Hex };

/** The OstraPad call that carries out `a` (the role having approved padDigest(a), or being the caller). */
export function padCallFor(a: PadAction, extra: { terms?: PadTerms; member?: number } = {}, pad: Address = OSTRAPAD): PadCall {
  const to = getAddress(pad);
  const call = (functionName: string, args: readonly unknown[]): PadCall => ({ to, data: encodeFunctionData({ abi: ostraPadAbi, functionName: functionName as never, args: args as never }) });
  switch (a.kind) {
    case "create": {
      if (extra.terms === undefined || padJobId(extra.terms) !== word(a.id, "id")) throw new RangeError("create needs the terms of that job id");
      return call("create", [padTerms(extra.terms)]);
    }
    case "cancel":
      return call("cancel", [a.id]);
    case "accept":
      return call("accept", [a.id, a.providerCommit]);
    case "submit":
      return call("submit", [a.id, a.deliverable]);
    case "decide":
      return call("decide", [a.id, a.approve, a.reason]);
    case "appeal":
      return call("openAppeal", [a.id]);
    case "vote": {
      if (extra.member === undefined) throw new RangeError("vote needs the member's place on the panel");
      return call("vote", [a.id, uint8(extra.member, "member"), a.agree]);
    }
    case "join":
      return call("joinPool", [getAddress(a.evaluator), a.amount]);
    case "leave":
      return call("leavePool", [getAddress(a.evaluator)]);
    case "withdraw":
      return a.evaluator ? call("withdrawEvaluatorBond", [getAddress(a.account)]) : call("withdrawProviderBond", [getAddress(a.account)]);
    case "bond":
      return call("depositProviderBond", [getAddress(a.provider), a.amount]);
    case "sweep job": {
      if (extra.terms === undefined || padJobId(extra.terms) !== word(a.id, "id")) throw new RangeError("sweep job needs the terms of that job id");
      return call("sweepJobBox", [padTerms(extra.terms)]);
    }
    case "sweep bond":
      return call("sweepBondBox", [getAddress(a.account), a.evaluator]);
  }
}

/** OstraPad's functions that change state: the ones the Ostra relayer relays (each checked by its gate). */
export const PAD_RELAYED_FUNCTIONS = [
  "create",
  "cancel",
  "accept",
  "reveal",
  "lapseReveal",
  "draw",
  "submit",
  "decide",
  "openAppeal",
  "drawPanel",
  "vote",
  "settle",
  "claim",
  "joinPool",
  "leavePool",
  "prune",
  "withdrawEvaluatorBond",
  "depositProviderBond",
  "withdrawProviderBond",
  "sweepJobBox",
  "sweepAppealBox",
  "sweepBondBox",
] as const;

/** The calls anyone may make, with no role's approval: they only move a job along its rules. */
export function padOpenCall(fn: "reveal" | "lapseReveal" | "draw" | "drawPanel" | "settle" | "claim" | "prune" | "sweepAppealBox", args: readonly unknown[], pad: Address = OSTRAPAD): PadCall {
  return { to: getAddress(pad), data: encodeFunctionData({ abi: ostraPadAbi, functionName: fn as never, args: args as never }) };
}

// ---------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------

export type PadJob = {
  id: Hex;
  client: Address;
  provider: Address;
  evaluator: Address;
  budget: bigint;
  evaluatorFee: bigint;
  status: PadStatus;
  pool: boolean;
  approved: boolean;
  feePaid: boolean;
  round: number;
  revealed: number;
  expiresAt: bigint;
  acceptedAt: bigint;
  revealBy: bigint;
  submittedAt: bigint;
  assignedAt: bigint;
  appealBy: bigint;
  drawBlock: bigint;
  drawAt: bigint;
  clientCommit: Hex;
  providerCommit: Hex;
  seed: Hex;
  deliverable: Hex;
};

/**
 * The chain's head as OstraPad sees it: its timestamp, and the block number OstraPad's draws compare against. On
 * Robinhood Chain (an Arbitrum chain) block.number in a contract is the parent chain's block (the RPC's block field
 * l1BlockNumber: 26,284,462 against the chain's own 99,291,750 on 27 Oct 2026), so drawBlock and panelBlock are in
 * that domain; a node that gives no l1BlockNumber (a local fork) has block.number as its own number.
 */
export async function padHead(client: PublicClient): Promise<{ timestamp: bigint; number: bigint; padBlock: bigint }> {
  const raw = (await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] } as never)) as { number: Hex; timestamp: Hex; l1BlockNumber?: Hex };
  const number = BigInt(raw.number);
  return { timestamp: BigInt(raw.timestamp), number, padBlock: raw.l1BlockNumber !== undefined ? BigInt(raw.l1BlockNumber) : number };
}

/** OstraPad.job(id), with its status named; null when no job has that id. */
export async function readPadJob(client: PublicClient, id: Hex, pad: Address = OSTRAPAD, blockNumber?: bigint): Promise<PadJob | null> {
  const j = (await client.readContract({ address: pad, abi: ostraPadAbi, functionName: "job", args: [id], ...(blockNumber === undefined ? {} : { blockNumber }) })) as Omit<PadJob, "id" | "status"> & { status: number };
  if (j.status === 0) return null;
  const status = PAD_STATUS[j.status];
  if (status === undefined) throw new Error(`OstraPad answered status ${j.status} for job ${id}, which this SDK does not know`);
  return { ...j, id, status, round: Number(j.round), revealed: Number(j.revealed) };
}

export type PadProvider = { bond: bigint; lastEnd: bigint; active: number; completed: number; rejected: number; expired: number; clients: number; fixedCompleted: number; volume: bigint; limit: bigint };

/** A provider's record (OstraPad.provider) and its limit per job (limitOf). */
export async function readPadProvider(client: PublicClient, account: Address, pad: Address = OSTRAPAD): Promise<PadProvider> {
  const [r, limit] = await Promise.all([
    client.readContract({ address: pad, abi: ostraPadAbi, functionName: "provider", args: [getAddress(account)] }) as Promise<{ bond: bigint; lastEnd: bigint; active: number; completed: number; rejected: number; expired: number; clients: number; fixedCompleted: number; volume: bigint }>,
    client.readContract({ address: pad, abi: ostraPadAbi, functionName: "limitOf", args: [getAddress(account)] }) as Promise<bigint>,
  ]);
  return { ...r, active: Number(r.active), completed: Number(r.completed), rejected: Number(r.rejected), expired: Number(r.expired), clients: Number(r.clients), fixedCompleted: Number(r.fixedCompleted), limit };
}

export type PadEvaluator = { bond: bigint; joinedAt: bigint; exitAt: bigint; active: number; inPool: boolean; removed: boolean; slashed: bigint };

export async function readPadEvaluator(client: PublicClient, account: Address, pad: Address = OSTRAPAD): Promise<PadEvaluator> {
  const e = (await client.readContract({ address: pad, abi: ostraPadAbi, functionName: "evaluator", args: [getAddress(account)] })) as Omit<PadEvaluator, "active"> & { active: number };
  return { ...e, active: Number(e.active) };
}

export type PadAppeal = { appellant: Address; fee: bigint; openedAt: bigint; panelBlock: bigint; voteBy: bigint; panel: readonly [Address, Address, Address]; voted: number; agreed: number; agree: number; disagree: number };

export async function readPadAppeal(client: PublicClient, id: Hex, pad: Address = OSTRAPAD): Promise<PadAppeal> {
  const a = (await client.readContract({ address: pad, abi: ostraPadAbi, functionName: "appeal", args: [word(id, "id")] })) as PadAppeal;
  return { ...a, voted: Number(a.voted), agreed: Number(a.agreed), agree: Number(a.agree), disagree: Number(a.disagree) };
}

/** OstraPad.nonces(account): the next nonce of its join, leave, withdraw, bond and sweep actions. */
export function readPadNonce(client: PublicClient, account: Address, pad: Address = OSTRAPAD): Promise<bigint> {
  return client.readContract({ address: pad, abi: ostraPadAbi, functionName: "nonces", args: [getAddress(account)] }) as Promise<bigint>;
}

/** OstraPad's events, as the indexer and the agent read them (the same signatures as in ostraPadAbi). */
export const PAD_EVENTS = {
  JobCreated: parseAbiItem("event JobCreated(bytes32 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt)"),
  JobFunded: parseAbiItem("event JobFunded(bytes32 indexed jobId, address indexed client, uint256 amount)"),
  JobAccepted: parseAbiItem("event JobAccepted(bytes32 indexed jobId, address indexed provider)"),
  JobSubmitted: parseAbiItem("event JobSubmitted(bytes32 indexed jobId, address indexed provider, bytes32 deliverable)"),
  JobCompleted: parseAbiItem("event JobCompleted(bytes32 indexed jobId, address indexed evaluator, bytes32 reason)"),
  JobRejected: parseAbiItem("event JobRejected(bytes32 indexed jobId, address indexed rejector, bytes32 reason)"),
  JobExpired: parseAbiItem("event JobExpired(bytes32 indexed jobId)"),
  JobCancelled: parseAbiItem("event JobCancelled(bytes32 indexed jobId)"),
  PaymentReleased: parseAbiItem("event PaymentReleased(bytes32 indexed jobId, address indexed provider, uint256 amount)"),
  Refunded: parseAbiItem("event Refunded(bytes32 indexed jobId, address indexed client, uint256 amount)"),
  EvaluatorDrawn: parseAbiItem("event EvaluatorDrawn(bytes32 indexed jobId, address indexed evaluator, uint8 round)"),
  Decided: parseAbiItem("event Decided(bytes32 indexed jobId, address indexed evaluator, bool approved, bytes32 reason)"),
  PanelDrawn: parseAbiItem("event PanelDrawn(bytes32 indexed jobId, address[3] panel)"),
  AppealOpened: parseAbiItem("event AppealOpened(bytes32 indexed jobId, address indexed appellant, uint256 fee)"),
  AppealResolved: parseAbiItem("event AppealResolved(bytes32 indexed jobId, bool overturned)"),
  EvaluatorJoined: parseAbiItem("event EvaluatorJoined(address indexed evaluator, uint256 bond)"),
  EvaluatorLeft: parseAbiItem("event EvaluatorLeft(address indexed evaluator)"),
} as const;

/** Decodes the result of an OstraPad view call made some other way (a multicall). */
export function decodePadResult(functionName: string, data: Hex): unknown {
  return decodeFunctionResult({ abi: ostraPadAbi, functionName: functionName as never, data });
}

/**
 * The terms of job `id` from the calldata of the transaction that created it: OstraPad.create(terms) sent directly,
 * or inside Multicall3's aggregate3 (as the relayer sends an approval and the call). OstraPad keeps a job's terms only
 * in its id, so its description (the order file's sha256) is read this way; null when the calldata holds no create
 * of that id.
 */
export function padTermsFromInput(input: Hex, id: Hex, pad: Address = OSTRAPAD): PadTerms | null {
  const fromCreate = (data: Hex): PadTerms | null => {
    try {
      const d = decodeFunctionData({ abi: ostraPadAbi, data });
      if (d.functionName !== "create") return null;
      const t = (d.args as readonly [PadTerms])[0];
      return padJobId(t) === word(id, "id") ? padTerms(t) : null;
    } catch {
      return null;
    }
  };
  const direct = fromCreate(input);
  if (direct !== null) return direct;
  try {
    const m = decodeFunctionData({ abi: multicall3Abi, data: input });
    if (m.functionName !== "aggregate3") return null;
    for (const c of (m.args as readonly [readonly { target: Address; callData: Hex }[]])[0]) {
      if (getAddress(c.target) !== getAddress(pad)) continue;
      const t = fromCreate(c.callData);
      if (t !== null) return t;
    }
  } catch {
    // not a multicall
  }
  return null;
}

/**
 * A job's terms from the transaction that created it: its calldata (OstraPad.create, or inside Multicall3), else,
 * for a create sent through another contract (a smart account, a bundler), the calls of a call trace
 * (debug_traceTransaction with callTracer) where the node serves one. Null when neither finds them.
 */
export async function padTermsFromTransaction(client: PublicClient, hash: Hash, id: Hex, pad: Address = OSTRAPAD): Promise<PadTerms | null> {
  const tx = await client.getTransaction({ hash });
  const direct = padTermsFromInput(tx.input, id, pad);
  if (direct !== null) return direct;
  type Frame = { to?: string; input?: Hex; calls?: Frame[] };
  let trace: Frame;
  try {
    trace = (await client.request({ method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] } as never)) as Frame;
  } catch {
    return null;
  }
  const stack: Frame[] = [trace];
  while (stack.length > 0) {
    const f = stack.pop() as Frame;
    if (f.to !== undefined && f.input !== undefined && f.to.toLowerCase() === pad.toLowerCase()) {
      const t = padTermsFromInput(f.input, id, pad);
      if (t !== null) return t;
    }
    for (const c of f.calls ?? []) stack.push(c);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Content: CIDs and files
// ---------------------------------------------------------------------------------------------------------------

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** CIDv1, raw codec (0x55), sha2-256 multihash of 32 bytes: the prefix every such CID's bytes start with. */
const RAW_SHA256_PREFIX = [0x01, 0x55, 0x12, 0x20];

function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const i = BASE32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  // Leftover bits must be zero padding.
  if ((value & ((1 << bits) - 1)) !== 0) return null;
  return new Uint8Array(out);
}

/** The sha256 a CIDv1 raw sha2-256 (ipfs://bafkrei...) names, as a bytes32; null for any other CID. */
export function padDigestFromCid(uriOrCid: string): Hex | null {
  const cid = uriOrCid.startsWith("ipfs://") ? uriOrCid.slice("ipfs://".length) : uriOrCid;
  if (!cid.startsWith("b")) return null;
  const bytes = base32Decode(cid.slice(1));
  if (bytes === null || bytes.length !== 36 || RAW_SHA256_PREFIX.some((v, i) => bytes[i] !== v)) return null;
  return bytesToHex(bytes.slice(4));
}

/** The ipfs:// URI (CIDv1 raw sha2-256) of a file whose sha256 is `digest`. */
export function padCidFromDigest(digest: Hex): string {
  const d = hexToBytes(word(digest, "digest"));
  return `ipfs://b${base32Encode(new Uint8Array([...RAW_SHA256_PREFIX, ...d]))}`;
}

/** The largest file the uploader pins (its MAX_JSON_BYTES). */
export const PAD_FILE_MAX_BYTES = 16_384;

function text(value: unknown, name: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new RangeError(`${name} must be text`);
  const v = value.trim();
  if (v === "" || v.length > max) throw new RangeError(`${name} must be 1 to ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw new RangeError(`${name} must not hold control characters`);
  return v;
}

/** An offer of a provider: what it does, for how much and how fast, and who judges it. */
export type PadOffer = {
  /** Lower case letters, digits and dashes, 1 to 32: names the offer in orders. */
  id: string;
  title: string;
  description: string;
  /** What the client sends with an order. */
  input: string;
  /** USDG per job, 0.1 to 500, at most 6 decimals. */
  price: string;
  /** Hours the provider expects to deliver in, 1 to 168 (a job lives 7 days). */
  hours: number;
  /** "pool": drawn from the evaluator pool (the provider's record grows); "client": the client judges (no fee, no appeal). */
  evaluator: "pool" | "client";
};

export const PAD_MAX_OFFERS = 20;

/** `o` checked and normalized; throws with what is wrong. */
export function padOffer(o: unknown): PadOffer {
  if (typeof o !== "object" || o === null) throw new RangeError("an offer must be an object");
  const r = o as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(id)) throw new RangeError("an offer's id must be 1 to 32 lower case letters, digits and dashes (not at either end)");
  const price = typeof r.price === "string" ? r.price.trim() : "";
  if (!/^\d+(\.\d{1,6})?$/.test(price)) throw new RangeError(`offer ${id}: price must be USDG as a decimal, at most 6 decimals`);
  const units = parseUnits(price, 6);
  if (units < PAD.MIN_BUDGET || units > PAD.MAX_BUDGET) throw new RangeError(`offer ${id}: price must be 0.1 to 500 USDG`);
  const hours = r.hours;
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new RangeError(`offer ${id}: hours must be a whole number from 1 to 168`);
  if (r.evaluator !== "pool" && r.evaluator !== "client") throw new RangeError(`offer ${id}: evaluator must be "pool" or "client"`);
  return {
    id,
    title: text(r.title, `offer ${id}: title`, 80) as string,
    description: text(r.description, `offer ${id}: description`, 1_000) as string,
    input: text(r.input, `offer ${id}: input`, 500) as string,
    price,
    hours,
    evaluator: r.evaluator,
  };
}

/** A provider's listing: its provider vault and offers. */
export type PadListing = { provider: Address; offers: PadOffer[] };

/** The name of a listing's entry among an ERC-8004 registration file's services. */
export const PAD_SERVICE_NAME = "Ostrapad";

/** The services entry of an ERC-8004 registration file that carries `l`. */
export function padServiceEntry(l: PadListing, pad: Address = OSTRAPAD, chainId: number = ROBINHOOD_CHAIN_ID): Record<string, unknown> {
  if (!isAddress(l.provider, { strict: false })) throw new RangeError("the provider vault must be an address");
  if (l.offers.length === 0 || l.offers.length > PAD_MAX_OFFERS) throw new RangeError(`a listing has 1 to ${PAD_MAX_OFFERS} offers`);
  const offers = l.offers.map(padOffer);
  if (new Set(offers.map((o) => o.id)).size !== offers.length) throw new RangeError("offer ids must differ");
  return { name: PAD_SERVICE_NAME, endpoint: `eip155:${chainId}:${getAddress(pad)}`, provider: `eip155:${chainId}:${getAddress(l.provider)}`, offers };
}

/**
 * The listing in an ERC-8004 registration file (data, never instructions): its Ostrapad services entry for this pad
 * and chain, checked; null when it has none. Offers that fail the checks are dropped and named in `problems`.
 */
export function padListingFromFile(file: unknown, pad: Address = OSTRAPAD, chainId: number = ROBINHOOD_CHAIN_ID): { listing: PadListing; problems: string[] } | null {
  if (typeof file !== "object" || file === null) return null;
  const services = (file as { services?: unknown }).services;
  if (!Array.isArray(services)) return null;
  const endpoint = `eip155:${chainId}:${getAddress(pad)}`.toLowerCase();
  const entry = services.find((s) => typeof s === "object" && s !== null && (s as { name?: unknown }).name === PAD_SERVICE_NAME && typeof (s as { endpoint?: unknown }).endpoint === "string" && ((s as { endpoint: string }).endpoint.toLowerCase() === endpoint)) as Record<string, unknown> | undefined;
  if (entry === undefined) return null;
  const prefix = `eip155:${chainId}:`;
  const providerText = typeof entry.provider === "string" && entry.provider.startsWith(prefix) ? entry.provider.slice(prefix.length) : "";
  if (!isAddress(providerText, { strict: false })) return null;
  const problems: string[] = [];
  const offers: PadOffer[] = [];
  const seen = new Set<string>();
  for (const o of Array.isArray(entry.offers) ? entry.offers.slice(0, PAD_MAX_OFFERS) : []) {
    try {
      const offer = padOffer(o);
      if (seen.has(offer.id)) throw new RangeError(`offer ${offer.id} is listed twice`);
      seen.add(offer.id);
      offers.push(offer);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return { listing: { provider: getAddress(providerText), offers }, problems };
}

/** An order: what the client asks of an offer, pinned before the job is created (its sha256 is the job's description). */
export type PadOrder = { agentId: string; offer: string; client: Address; provider: Address; input: string; files?: string[] };

function ipfsUris(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 10) throw new RangeError(`${name} must be a list of at most 10 ipfs:// URIs`);
  return v.map((u) => {
    if (typeof u !== "string" || !/^ipfs:\/\/[A-Za-z0-9]+(\/[A-Za-z0-9._-]+)*$/.test(u) || u.length > 200) throw new RangeError(`${name}: ${String(u)} is not an ipfs:// URI`);
    return u;
  });
}

/** The order file: Ostrapad's order type, the offer, the parties and the input (at most 12,000 characters). */
export function padOrderFile(o: PadOrder, chainId: number = ROBINHOOD_CHAIN_ID): Record<string, unknown> {
  if (!/^\d{1,30}$/.test(o.agentId)) throw new RangeError("agentId must be the provider's ERC-8004 agent id");
  const files = ipfsUris(o.files, "files");
  return {
    type: "ostrapad-order-v1",
    agent: `eip155:${chainId}:${o.agentId}`,
    offer: o.offer,
    client: `eip155:${chainId}:${getAddress(o.client)}`,
    provider: `eip155:${chainId}:${getAddress(o.provider)}`,
    input: text(o.input, "input", 12_000),
    ...(files === undefined ? {} : { files }),
  };
}

/** A delivery: the provider's work for a job, pinned before it submits (its sha256 is the job's deliverable). */
export type PadDelivery = { jobId: Hex; output: string; files?: string[] };

export function padDeliveryFile(d: PadDelivery, chainId: number = ROBINHOOD_CHAIN_ID): Record<string, unknown> {
  const files = ipfsUris(d.files, "files");
  return { type: "ostrapad-delivery-v1", chain: `eip155:${chainId}`, job: word(d.jobId, "jobId"), output: text(d.output, "output", 14_000), ...(files === undefined ? {} : { files }) };
}

/** A decision's reason, as the bytes32 OstraPad records: the sha256 of a pinned reason file, or zero. */
export function padReasonFile(jobId: Hex, approve: boolean, reason: string): Record<string, unknown> {
  return { type: "ostrapad-decision-v1", job: word(jobId, "jobId"), approve, reason: text(reason, "reason", 4_000) };
}
