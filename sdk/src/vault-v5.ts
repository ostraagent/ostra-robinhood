// OstraVault version 5 (src/OstraVaultV5.sol, src/OstraVaultModuleV5.sol): the params of its spends (29 to 46), the
// agent key's own signed message, the reads of its state, and a spend of the agent key run with a throwaway key before
// the agent key signs it.
//
// The agent key is a second WOTS key chain the owner sets (SetAgentKey: its root and an expiry). It signs
//   "OSTRA/VAULT/EVM/AGENT/v1" (bytes24) || chainid (32) || vault (20) || agent nonce (8) || nextKeyRoot (32)
//   || action (1) || params
// (OstraVaultModuleV5._rotateAgent), sent through OstraVault.spendAsAgent. The policy and allowlist checks, a Swap, an
// Exit (always strict for the agent key) and a Priors spend of the agent key revert when they fail, and keep its key:
// a signature the agent key gave that can never land holds that key until the owner sets another one. A Morpho spend
// (17 to 22) and an Enter run in the version 3 and 4 modules as an owner spend does, and their failure lands
// (MorphoFailed, VenueFailed) when sent on its own: it rotates the agent key and counts against the budget. The
// simulation refuses both.
//
// The encoders refuse what the module refuses without reading the chain (lengths, kinds, zero values, bounds); the
// rest is read or simulated before anything is signed.

import {
  bytesToHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hexToBytes,
  isAddress,
  padHex,
  parseAbi,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { ostraVaultAbi } from "./abi.ts";
import { ALLOW_KIND, ORDER_KIND, PRIORS_POOL, VAULT_ACTION, VAULT_AGENT_ACTIONS, VAULT_AGENT_DOMAIN, VAULT_V5, VAULT_V5_LIMITS, VENUE_KIND } from "./constants.ts";
import type { Deployment } from "./deployment.ts";
import { checkSpendParamsLength, type VaultAction } from "./messages.ts";
import { ostraPadAbi } from "./pad-abi.ts";
import { OSTRAPAD } from "./pad.ts";
import { QuoteError } from "./quote.ts";
import { readVault } from "./reads.ts";
import { failedModuleSpends, moduleFailureText, RelaySimulationError, simulateRelay } from "./relayer.ts";
import { WOTS_SIGNATURE_LEN, WotsKeychain, randomBytes32, type WotsStore } from "./wots.ts";

const AGENT_DOMAIN = stringToHex(VAULT_AGENT_DOMAIN); // bytes24
const U16_MAX = (1n << 16n) - 1n;
const U32_MAX = (1n << 32n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

/** OstraVaultV5.SLOT (ERC-7201 "ostra.vault.v5"): its first word is the agent key's root (Layout.agentRoot). */
export const VAULT_V5_SLOT: Hex = "0x08a2d09332cd6f2fc6deb9ea94fe2d0f53207701b1a66b5a4c0e51e4ea1c3c00";

function uint(value: bigint, max: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > max) throw new RangeError(`${name} out of range`);
  return value;
}
function addr(value: Address, name: string): Address {
  if (!isAddress(value, { strict: false })) throw new RangeError(`${name} is not an address`);
  return getAddress(value);
}
function bytes32(value: Hex, name: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RangeError(`${name} must be 32 bytes of hex`);
  return value.toLowerCase() as Hex;
}
function nonZero32(value: Hex, name: string): Hex {
  if (BigInt(bytes32(value, name)) === 0n) throw new RangeError(`${name} must not be zero`);
  return value.toLowerCase() as Hex;
}
function checked(action: number, params: Hex): Hex {
  checkSpendParamsLength(action, params);
  return params;
}

// ---------------------------------------------------------------------------
// Policy (SetPolicy, 29)
// ---------------------------------------------------------------------------

/** OstraVaultV5.Policy: what bounds the agent key and the standing orders, and every Priors spend. */
export type Policy = {
  /** Bit `a`: the agent key may use action `a` (only within VAULT_AGENT_ACTIONS). */
  actions: bigint;
  /** The most one agent spend or one order run may count, in the vault's token units. */
  perTx: bigint;
  /** The most counted at once; it drains at `daily` per day. */
  daily: bigint;
  /** Priors: the most principal an agent this vault owns may owe (0: no borrowing). */
  maxDebt: bigint;
  /** Priors: the longest term of a loan, in seconds. */
  maxTerm: number;
  /** Priors: the most fee per 30 days of term, in bps of principal (and the most premium a consent may allow). */
  maxFeeBps: number;
  /** Priors: open principal at most coverBps of the escrowed OstraPad budgets this vault provides (0: none needed). */
  coverBps: number;
  /** Priors: how long before a loan is due anyone may repay it from this vault, in seconds (0: one day). */
  repayLead: number;
  /** Priors: the venue a short repay exits first (kind 0 and the zero address: none). */
  repayKind: number;
  repayVenue: Address;
  /** Priors root: the largest line one agent may hold, and the most the root may vouch in all. */
  vouchPerAgent: bigint;
  vouchTotal: bigint;
  /** Priors root: the highest premium the root charges, in bps. */
  maxPremiumBps: number;
};

const POLICY_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "actions", type: "uint64" },
      { name: "perTx", type: "uint128" },
      { name: "daily", type: "uint128" },
      { name: "maxDebt", type: "uint128" },
      { name: "maxTerm", type: "uint32" },
      { name: "maxFeeBps", type: "uint16" },
      { name: "coverBps", type: "uint16" },
      { name: "repayLead", type: "uint32" },
      { name: "repayKind", type: "uint8" },
      { name: "repayVenue", type: "address" },
      { name: "vouchPerAgent", type: "uint128" },
      { name: "vouchTotal", type: "uint128" },
      { name: "maxPremiumBps", type: "uint16" },
    ],
  },
] as const;

/** The policy after the upgrade: the agent key can do nothing, no order runs, no Priors loan. */
export const EMPTY_POLICY: Policy = {
  actions: 0n,
  perTx: 0n,
  daily: 0n,
  maxDebt: 0n,
  maxTerm: 0,
  maxFeeBps: 0,
  coverBps: 0,
  repayLead: 0,
  repayKind: 0,
  repayVenue: zeroAddress,
  vouchPerAgent: 0n,
  vouchTotal: 0n,
  maxPremiumBps: 0,
};

/** Throws for a policy OstraVaultModuleV5._setPolicy refuses. */
export function checkPolicy(p: Policy): Policy {
  uint(p.actions, U64_MAX, "actions");
  if ((p.actions & ~VAULT_AGENT_ACTIONS) !== 0n) throw new RangeError("actions names an action the agent key may never use");
  uint(p.perTx, U128_MAX, "perTx");
  uint(p.daily, U128_MAX, "daily");
  uint(p.maxDebt, U128_MAX, "maxDebt");
  uint(BigInt(p.maxTerm), BigInt(VAULT_V5_LIMITS.MAX_TERM), "maxTerm");
  uint(BigInt(p.maxFeeBps), 10_000n, "maxFeeBps");
  uint(BigInt(p.coverBps), 10_000n, "coverBps");
  uint(BigInt(p.repayLead), BigInt(VAULT_V5_LIMITS.MAX_REPAY_LEAD), "repayLead");
  uint(BigInt(p.maxPremiumBps), BigInt(VAULT_V5_LIMITS.MAX_PREMIUM_BPS), "maxPremiumBps");
  uint(p.vouchPerAgent, U128_MAX, "vouchPerAgent");
  uint(p.vouchTotal, U128_MAX, "vouchTotal");
  const venue = addr(p.repayVenue, "repayVenue");
  if (p.repayKind === 0) {
    if (venue !== zeroAddress) throw new RangeError("a repay venue needs its kind (RAETO_USDG or ERC4626)");
  } else if ((p.repayKind !== VENUE_KIND.RAETO_USDG && p.repayKind !== VENUE_KIND.ERC4626) || venue === zeroAddress) {
    throw new RangeError("the repay venue is a RAETO_USDG or ERC4626 venue, with its address");
  }
  for (const [k, v] of [["maxTerm", p.maxTerm], ["maxFeeBps", p.maxFeeBps], ["coverBps", p.coverBps], ["repayLead", p.repayLead], ["repayKind", p.repayKind], ["maxPremiumBps", p.maxPremiumBps]] as const) {
    if (!Number.isInteger(v)) throw new RangeError(`${k} must be an integer`);
  }
  return { ...p, repayVenue: venue };
}

export function policyParams(p: Policy): Hex {
  const c = checkPolicy(p);
  return checked(VAULT_ACTION.SET_POLICY, encodeAbiParameters(POLICY_TUPLE, [{ ...c, repayKind: c.repayKind }]));
}

export function decodePolicyParams(params: Hex): Policy {
  checkSpendParamsLength(VAULT_ACTION.SET_POLICY, params);
  return policyOf(decodeAbiParameters(POLICY_TUPLE, params)[0]);
}

function policyOf(r: { actions: bigint; perTx: bigint; daily: bigint; maxDebt: bigint; maxTerm: number; maxFeeBps: number; coverBps: number; repayLead: number; repayKind: number; repayVenue: Address; vouchPerAgent: bigint; vouchTotal: bigint; maxPremiumBps: number }): Policy {
  return {
    actions: BigInt(r.actions),
    perTx: BigInt(r.perTx),
    daily: BigInt(r.daily),
    maxDebt: BigInt(r.maxDebt),
    maxTerm: Number(r.maxTerm),
    maxFeeBps: Number(r.maxFeeBps),
    coverBps: Number(r.coverBps),
    repayLead: Number(r.repayLead),
    repayKind: Number(r.repayKind),
    repayVenue: getAddress(r.repayVenue),
    vouchPerAgent: BigInt(r.vouchPerAgent),
    vouchTotal: BigInt(r.vouchTotal),
    maxPremiumBps: Number(r.maxPremiumBps),
  };
}

/** OstraVaultModuleV5._tighter: whether `n` is at least as strict as `c` in every field (it takes effect at once). */
export function policyTighter(n: Policy, c: Policy): boolean {
  return (
    (n.actions & ~c.actions) === 0n &&
    n.perTx <= c.perTx &&
    n.daily <= c.daily &&
    n.maxDebt <= c.maxDebt &&
    n.maxTerm <= c.maxTerm &&
    n.maxFeeBps <= c.maxFeeBps &&
    (c.coverBps === 0 || (n.coverBps !== 0 && n.coverBps <= c.coverBps)) &&
    n.repayLead === c.repayLead &&
    n.repayKind === c.repayKind &&
    getAddress(n.repayVenue) === getAddress(c.repayVenue) &&
    n.vouchPerAgent <= c.vouchPerAgent &&
    n.vouchTotal <= c.vouchTotal &&
    n.maxPremiumBps <= c.maxPremiumBps
  );
}

/** The actions bit mask of `actions` (each must be one the agent key may ever use). */
export function agentActionMask(actions: readonly number[]): bigint {
  let m = 0n;
  for (const a of actions) {
    if (!Number.isInteger(a) || a < 0 || a > 63 || ((VAULT_AGENT_ACTIONS >> BigInt(a)) & 1n) === 0n) throw new RangeError(`action ${a} is not one the agent key may ever use`);
    m |= 1n << BigInt(a);
  }
  return m;
}

/** The actions of the mask `m`, in order. */
export function agentActionsOf(m: bigint): number[] {
  const out: number[] = [];
  for (let a = 0; a < 64; a++) if (((m >> BigInt(a)) & 1n) === 1n) out.push(a);
  return out;
}

/** Whether the policy lets the agent key use `action` (OstraVaultModuleV5: AGENT_ACTIONS & policy.actions). */
export function agentMayUse(p: Pick<Policy, "actions">, action: number): boolean {
  return action >= 0 && action < 64 && ((VAULT_AGENT_ACTIONS & p.actions) >> BigInt(action)) % 2n === 1n;
}

// ---------------------------------------------------------------------------
// Allowlist (SetAllow, 30)
// ---------------------------------------------------------------------------

export type AllowKind = (typeof ALLOW_KIND)[keyof typeof ALLOW_KIND];

/** Whether the allowlist kind takes an address as its value (OstraVaultModuleV5._setAllow). */
export function allowTakesAddress(kind: number): boolean {
  return kind === ALLOW_KIND.RECIPIENT || kind === ALLOW_KIND.CHANNEL || kind === ALLOW_KIND.LEND;
}

/** The allowlist value of `kind`: an address (left-padded), a PoolId, or an agent id. Throws when it is not one. */
export function allowValue(kind: number, value: Address | Hex | bigint): Hex {
  if (!Number.isInteger(kind) || kind < ALLOW_KIND.RECIPIENT || kind > ALLOW_KIND.BORROWER) throw new RangeError(`allowlist kind ${kind} is not one of 1 to 6`);
  let word: Hex;
  if (allowTakesAddress(kind)) {
    if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new RangeError("this allowlist kind takes an address");
    word = padHex(getAddress(value), { size: 32 }).toLowerCase() as Hex;
  } else if (kind === ALLOW_KIND.POOL) {
    if (typeof value !== "string") throw new RangeError("the pool kind takes a PoolId (32 bytes of hex)");
    word = bytes32(value, "PoolId");
  } else {
    if (typeof value !== "bigint") throw new RangeError("the Priors kinds take an agent id");
    word = padHex(numberHex(uint(value, U256_MAX, "agent id")), { size: 32 });
  }
  if (BigInt(word) === 0n) throw new RangeError("an allowlist value must not be zero");
  return word;
}

function numberHex(v: bigint): Hex {
  return `0x${v.toString(16)}`;
}

export function setAllowParams(a: { kind: number; value: Hex; allowed: boolean }): Hex {
  const kind = a.kind;
  if (!Number.isInteger(kind) || kind < ALLOW_KIND.RECIPIENT || kind > ALLOW_KIND.BORROWER) throw new RangeError(`allowlist kind ${kind} is not one of 1 to 6`);
  const value = nonZero32(a.value, "value");
  if (allowTakesAddress(kind) && BigInt(value) >> 160n !== 0n) throw new RangeError("an address kind's value is an address");
  return checked(VAULT_ACTION.SET_ALLOW, encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bool" }], [kind, value, a.allowed]));
}

export function decodeSetAllowParams(params: Hex): { kind: number; value: Hex; allowed: boolean } {
  checkSpendParamsLength(VAULT_ACTION.SET_ALLOW, params);
  const [kind, value, allowed] = decodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bool" }], params);
  return { kind: Number(kind), value, allowed };
}

// ---------------------------------------------------------------------------
// Agent key (SetAgentKey 31, RevokeAgentKey 32)
// ---------------------------------------------------------------------------

/**
 * SetAgentKey params. Not checked here (OstraVaultModuleV5._setAgentKey refuses them): the root is not the vault's own
 * key root, and the expiry is after the key takes effect (now, plus the lock delay under the lock) and at most
 * MAX_AGENT_KEY_LIFE from now.
 */
export function setAgentKeyParams(a: { root: Hex; expiry: bigint }): Hex {
  return checked(VAULT_ACTION.SET_AGENT_KEY, encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], [nonZero32(a.root, "root"), uint(a.expiry, U64_MAX, "expiry")]));
}

export function decodeSetAgentKeyParams(params: Hex): { root: Hex; expiry: bigint } {
  checkSpendParamsLength(VAULT_ACTION.SET_AGENT_KEY, params);
  const [root, expiry] = decodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], params);
  return { root, expiry };
}

export function revokeAgentKeyParams(): Hex {
  return "0x";
}

// ---------------------------------------------------------------------------
// Standing orders (SetOrder 33, CancelOrder 34)
// ---------------------------------------------------------------------------

/** OstraVaultModuleV5.OrderParams. */
export type OrderParams = {
  kind: number;
  /** SWEEP and REFILL: the version 4 venue kind; PAY: 0. */
  venueKind: number;
  /** SWEEP and REFILL: the venue; PAY: the recipient. */
  target: Address;
  /** SWEEP and REFILL: the most one run moves; PAY: what one run pays. */
  amount: bigint;
  /** SWEEP: the balance kept; REFILL: the balance refilled to; PAY: 0. */
  threshold: bigint;
  /** Seconds between two runs (MIN_ORDER_INTERVAL to MAX_ORDER_INTERVAL). */
  interval: number;
  /** PAY: the number of runs; SWEEP and REFILL: 0. */
  runs: number;
  /** No run from then on (unix seconds; 0: none). */
  endAt: bigint;
};

const ORDER_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "kind", type: "uint8" },
      { name: "venueKind", type: "uint8" },
      { name: "target", type: "address" },
      { name: "amount", type: "uint128" },
      { name: "threshold", type: "uint128" },
      { name: "interval", type: "uint32" },
      { name: "runs", type: "uint32" },
      { name: "endAt", type: "uint64" },
    ],
  },
] as const;

/**
 * Throws for an order OstraVaultModuleV5._setOrder refuses without reading the chain. Not checked here: the target is
 * not the vault itself, and `endAt` (when not 0) is after now.
 */
export function checkOrder(o: OrderParams): OrderParams {
  const target = addr(o.target, "target");
  if (target === zeroAddress) throw new RangeError("the order's target must not be the zero address");
  if (uint(o.amount, U128_MAX, "amount") === 0n) throw new RangeError("the order's amount must be greater than zero");
  uint(o.threshold, U128_MAX, "threshold");
  uint(o.endAt, U64_MAX, "endAt");
  if (!Number.isInteger(o.interval) || o.interval < VAULT_V5_LIMITS.MIN_ORDER_INTERVAL || o.interval > VAULT_V5_LIMITS.MAX_ORDER_INTERVAL) {
    throw new RangeError(`the interval is ${VAULT_V5_LIMITS.MIN_ORDER_INTERVAL} to ${VAULT_V5_LIMITS.MAX_ORDER_INTERVAL} seconds`);
  }
  if (!Number.isInteger(o.runs) || o.runs < 0 || BigInt(o.runs) > U32_MAX) throw new RangeError("runs out of range");
  if (o.kind === ORDER_KIND.PAY) {
    if (o.venueKind !== 0 || o.threshold !== 0n || o.runs === 0) throw new RangeError("a PAY order has no venue and no threshold, and at least one run");
  } else if (o.kind === ORDER_KIND.SWEEP) {
    if (o.venueKind < VENUE_KIND.RAETO_USDG || o.venueKind > VENUE_KIND.ERC4626 || o.runs !== 0) throw new RangeError("a SWEEP order names a version 4 venue kind and has no run count");
  } else if (o.kind === ORDER_KIND.REFILL) {
    if ((o.venueKind !== VENUE_KIND.RAETO_USDG && o.venueKind !== VENUE_KIND.ERC4626) || o.runs !== 0 || o.threshold === 0n) {
      throw new RangeError("a REFILL order names a RAETO_USDG or ERC4626 venue, a threshold above zero and no run count");
    }
  } else {
    throw new RangeError(`order kind ${o.kind} is not SWEEP (1), REFILL (2) or PAY (3)`);
  }
  return { ...o, target };
}

export function setOrderParams(o: OrderParams): Hex {
  const c = checkOrder(o);
  return checked(VAULT_ACTION.SET_ORDER, encodeAbiParameters(ORDER_TUPLE, [c]));
}

export function decodeSetOrderParams(params: Hex): OrderParams {
  checkSpendParamsLength(VAULT_ACTION.SET_ORDER, params);
  const r = decodeAbiParameters(ORDER_TUPLE, params)[0];
  return { kind: Number(r.kind), venueKind: Number(r.venueKind), target: getAddress(r.target), amount: r.amount, threshold: r.threshold, interval: Number(r.interval), runs: Number(r.runs), endAt: r.endAt };
}

/** CancelOrder params: abi.encode(uint256 id); id 0 cancels every order (the owner only). */
export function cancelOrderParams(id: bigint): Hex {
  return checked(VAULT_ACTION.CANCEL_ORDER, encodeAbiParameters([{ type: "uint256" }], [uint(id, U256_MAX, "id")]));
}

// ---------------------------------------------------------------------------
// Priors (35 to 38) and the Priors root (39 to 46)
// ---------------------------------------------------------------------------

/** PriorsBorrow params (BorrowParams): `jobs` up to COVER_JOBS OstraPad job ids, strictly rising, zeros only at the end. */
export function priorsBorrowParams(p: { agentId: bigint; amount: bigint; term: bigint; maxFee: bigint; jobs: readonly Hex[] }): Hex {
  if (p.jobs.length > VAULT_V5_LIMITS.COVER_JOBS) throw new RangeError(`at most ${VAULT_V5_LIMITS.COVER_JOBS} cover jobs`);
  const jobs = [...p.jobs.map((j, i) => nonZero32(j, `jobs[${i}]`))];
  for (let i = 1; i < jobs.length; i++) if (BigInt(jobs[i] as Hex) <= BigInt(jobs[i - 1] as Hex)) throw new RangeError("the cover jobs' ids must be strictly rising");
  while (jobs.length < VAULT_V5_LIMITS.COVER_JOBS) jobs.push(`0x${"00".repeat(32)}`);
  if (uint(p.amount, U256_MAX, "amount") === 0n) throw new RangeError("the amount must be greater than zero");
  if (uint(p.term, U64_MAX, "term") === 0n) throw new RangeError("the term must be greater than zero");
  return checked(
    VAULT_ACTION.PRIORS_BORROW,
    encodeAbiParameters(
      [{ type: "tuple", components: [{ name: "agentId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "term", type: "uint64" }, { name: "maxFee", type: "uint256" }, { name: "jobs", type: "bytes32[8]" }] }],
      [{ agentId: uint(p.agentId, U256_MAX, "agentId"), amount: p.amount, term: p.term, maxFee: uint(p.maxFee, U256_MAX, "maxFee"), jobs: jobs as unknown as readonly [Hex, Hex, Hex, Hex, Hex, Hex, Hex, Hex] }],
    ),
  );
}

export function decodePriorsBorrowParams(params: Hex): { agentId: bigint; amount: bigint; term: bigint; maxFee: bigint; jobs: Hex[] } {
  checkSpendParamsLength(VAULT_ACTION.PRIORS_BORROW, params);
  const [r] = decodeAbiParameters(
    [{ type: "tuple", components: [{ name: "agentId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "term", type: "uint64" }, { name: "maxFee", type: "uint256" }, { name: "jobs", type: "bytes32[8]" }] }],
    params,
  );
  return { agentId: r.agentId, amount: r.amount, term: r.term, maxFee: r.maxFee, jobs: [...r.jobs].filter((j) => BigInt(j) !== 0n) };
}

export function priorsRepayParams(p: { loanId: bigint; maxDue: bigint }): Hex {
  return checked(VAULT_ACTION.PRIORS_REPAY, encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [uint(p.loanId, U256_MAX, "loanId"), uint(p.maxDue, U256_MAX, "maxDue")]));
}

export function priorsConsentParams(p: { agentId: bigint; sponsorId: bigint; maxPremiumBps: bigint; deadline: bigint }): Hex {
  uint(p.maxPremiumBps, BigInt(VAULT_V5_LIMITS.MAX_PREMIUM_BPS), "maxPremiumBps");
  return checked(
    VAULT_ACTION.PRIORS_CONSENT,
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [uint(p.agentId, U256_MAX, "agentId"), uint(p.sponsorId, U256_MAX, "sponsorId"), uint(p.maxPremiumBps, U256_MAX, "maxPremiumBps"), uint(p.deadline, U256_MAX, "deadline")]),
  );
}

export function priorsLeaveParams(agentId: bigint): Hex {
  return checked(VAULT_ACTION.PRIORS_LEAVE, encodeAbiParameters([{ type: "uint256" }], [uint(agentId, U256_MAX, "agentId")]));
}

/** RootEnroll (39) and RootAddStake (40) params: abi.encode(uint256 rootId, uint256 assets). */
export function rootStakeParams(action: typeof VAULT_ACTION.ROOT_ENROLL | typeof VAULT_ACTION.ROOT_ADD_STAKE, p: { rootId: bigint; assets: bigint }): Hex {
  if (uint(p.assets, U256_MAX, "assets") === 0n) throw new RangeError("the stake must be greater than zero");
  return checked(action, encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [uint(p.rootId, U256_MAX, "rootId"), p.assets]));
}

/** OstraVaultModuleV5.SponsorParams (RootSponsor, 41): a vouch with the borrower's consent (v 0: an EIP-1271 consent). */
export type SponsorParams = {
  rootId: bigint;
  agentId: bigint;
  amount: bigint;
  premiumBps: bigint;
  maxPremiumBps: bigint;
  nonce: bigint;
  deadline: bigint;
  owner: Address;
  v: number;
  r: Hex;
  s: Hex;
};

export function rootSponsorParams(p: SponsorParams): Hex {
  if (!Number.isInteger(p.v) || p.v < 0 || p.v > 255) throw new RangeError("v out of range");
  return checked(
    VAULT_ACTION.ROOT_SPONSOR,
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "rootId", type: "uint256" },
            { name: "agentId", type: "uint256" },
            { name: "amount", type: "uint256" },
            { name: "premiumBps", type: "uint256" },
            { name: "maxPremiumBps", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "owner", type: "address" },
            { name: "v", type: "uint8" },
            { name: "r", type: "bytes32" },
            { name: "s", type: "bytes32" },
          ],
        },
      ],
      [{ ...p, owner: addr(p.owner, "owner"), r: bytes32(p.r, "r"), s: bytes32(p.s, "s") }],
    ),
  );
}

/** RootVouch (42) and RootUnvouch (43) params: abi.encode(uint256 rootId, uint256 agentId, uint256 amount). */
export function rootVouchParams(action: typeof VAULT_ACTION.ROOT_VOUCH | typeof VAULT_ACTION.ROOT_UNVOUCH, p: { rootId: bigint; agentId: bigint; amount: bigint }): Hex {
  return checked(action, encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [uint(p.rootId, U256_MAX, "rootId"), uint(p.agentId, U256_MAX, "agentId"), uint(p.amount, U256_MAX, "amount")]));
}

export function rootFreezeParams(p: { agentId: bigint; frozen: boolean }): Hex {
  return checked(VAULT_ACTION.ROOT_FREEZE, encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [uint(p.agentId, U256_MAX, "agentId"), p.frozen]));
}

export function rootUnlockParams(p: { rootId: bigint; shares: bigint }): Hex {
  return checked(VAULT_ACTION.ROOT_UNLOCK, encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [uint(p.rootId, U256_MAX, "rootId"), uint(p.shares, U256_MAX, "shares")]));
}

export function rootClaimFeesParams(rootId: bigint): Hex {
  return checked(VAULT_ACTION.ROOT_CLAIM_FEES, encodeAbiParameters([{ type: "uint256" }], [uint(rootId, U256_MAX, "rootId")]));
}

// ---------------------------------------------------------------------------
// The agent key's message and signature
// ---------------------------------------------------------------------------

export type AgentSpend = {
  chainId: number;
  vault: Address;
  /** The vault's agent nonce (agentKey().agentNonce) the spend is signed at. */
  agentNonce: bigint;
  nextKeyRoot: Hex;
  action: VaultAction;
  params: Hex;
};

/** OstraVault.agentSpendMessage, byte for byte (a zero nextKeyRoot is a valid message: it ends the agent key; signAgentSpend never signs one). */
export function agentSpendMessage(s: AgentSpend): Uint8Array {
  if (!Number.isInteger(s.chainId) || s.chainId <= 0) throw new RangeError("chainId out of range");
  return hexToBytes(
    encodePacked(
      ["bytes24", "uint256", "address", "uint64", "bytes32", "uint8", "bytes"],
      [AGENT_DOMAIN, BigInt(s.chainId), addr(s.vault, "vault"), uint(s.agentNonce, U64_MAX, "agentNonce"), bytes32(s.nextKeyRoot, "nextKeyRoot"), s.action, checked(s.action, s.params)],
    ),
  );
}

/** Reads an agent spend message back; throws unless it re-encodes to the same bytes. */
export function decodeAgentSpendMessage(message: Uint8Array): AgentSpend {
  const head = 24 + 32 + 20 + 8 + 32 + 1;
  if (message.length < head) throw new Error("the message is too short for an agent spend");
  if (bytesToHex(message.subarray(0, 24)) !== AGENT_DOMAIN) throw new Error("not an agent spend message");
  const decoded: AgentSpend = {
    chainId: Number(BigInt(bytesToHex(message.subarray(24, 56)))),
    vault: getAddress(bytesToHex(message.subarray(56, 76))),
    agentNonce: BigInt(bytesToHex(message.subarray(76, 84))),
    nextKeyRoot: bytesToHex(message.subarray(84, 116)),
    action: message[116] as VaultAction,
    params: bytesToHex(message.subarray(head)),
  };
  const again = agentSpendMessage(decoded);
  if (again.length !== message.length || !again.every((x, i) => x === message[i])) throw new Error("the message does not re-encode to the same bytes");
  return decoded;
}

/** What OstraVault.spendAsAgent takes, signed. */
export type SignedAgentSpend = { action: VaultAction; nextKeyRoot: Hex; params: Hex; signature: Hex; message: Uint8Array };

/**
 * Signs an agent spend with key `index` of the agent keychain (whose root must be the vault's agent root `keyRoot`) and
 * rotates to key `nextIndex`, which must be another key that never signed: OstraVaultModuleV5.agent reverts on the same
 * root and on the vault's own key root `vaultKeyRoot`, and a next key that signed already could never sign the spend
 * after this one. Each of these would hold the agent key once the signature is out.
 */
export async function signAgentSpend(
  keychain: WotsKeychain,
  k: { vault: Address; agentNonce: bigint; keyRoot: Hex; vaultKeyRoot: Hex; index: bigint; nextIndex: bigint },
  a: { chainId: number; action: VaultAction; params: Hex },
): Promise<SignedAgentSpend> {
  if (k.nextIndex === k.index) throw new RangeError("the next agent key is another key");
  const nextKeyRoot = bytesToHex(keychain.keyRoot(k.nextIndex));
  if (nextKeyRoot.toLowerCase() === k.keyRoot.toLowerCase()) throw new RangeError("the next agent key root is the one signing");
  if (nextKeyRoot.toLowerCase() === bytes32(k.vaultKeyRoot, "vaultKeyRoot")) throw new RangeError("the next agent key root is the vault's own key root");
  if ((await keychain.signed(k.nextIndex)) !== undefined) throw new RangeError(`agent key ${k.nextIndex} signed already: the next agent key is one that never signed`);
  const message = agentSpendMessage({ chainId: a.chainId, vault: k.vault, agentNonce: k.agentNonce, nextKeyRoot, action: a.action, params: a.params });
  const signature = await keychain.sign(k.index, message, hexToBytes(bytes32(k.keyRoot, "keyRoot")));
  if (signature.length !== WOTS_SIGNATURE_LEN) throw new Error("the WOTS signature has the wrong length");
  return { action: a.action, nextKeyRoot, params: a.params, signature: bytesToHex(signature), message };
}

/** The call OstraVault.spendAsAgent(action, nextKeyRoot, params, signature) on `vault`. */
export function spendAsAgentCall(vault: Address, s: { action: number; nextKeyRoot: Hex; params: Hex; signature: Hex }): { to: Address; data: Hex } {
  return { to: getAddress(vault), data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spendAsAgent", args: [s.action, s.nextKeyRoot, s.params, s.signature] }) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type AgentKeyState = { root: Hex; agentNonce: bigint; from: bigint; expiry: bigint; inForce: boolean };

export type V5State = {
  version: number;
  agentKey: AgentKeyState;
  policy: Policy;
  pending: { policy: Policy; at: bigint } | null;
  budgetAvailable: bigint;
  orderCount: bigint;
};

/** The vault's version 5 state, or null when it runs an earlier version. */
export async function readV5(client: PublicClient, vault: Address): Promise<V5State | null> {
  const v = getAddress(vault);
  const version = Number(await client.readContract({ address: v, abi: ostraVaultAbi, functionName: "VERSION" }));
  if (version < VAULT_V5) return null;
  const [key, pol, budget, count] = await Promise.all([
    client.readContract({ address: v, abi: ostraVaultAbi, functionName: "agentKey" }) as Promise<readonly [Hex, bigint, bigint, bigint, boolean]>,
    client.readContract({ address: v, abi: ostraVaultAbi, functionName: "policy" }) as Promise<readonly [Parameters<typeof policyOf>[0], Parameters<typeof policyOf>[0], bigint]>,
    client.readContract({ address: v, abi: ostraVaultAbi, functionName: "budgetAvailable" }) as Promise<bigint>,
    client.readContract({ address: v, abi: ostraVaultAbi, functionName: "orderCount" }) as Promise<bigint>,
  ]);
  const pendingAt = BigInt(pol[2]);
  return {
    version,
    agentKey: { root: key[0], agentNonce: BigInt(key[1]), from: BigInt(key[2]), expiry: BigInt(key[3]), inForce: key[4] },
    policy: policyOf(pol[0]),
    pending: pendingAt === 0n ? null : { policy: policyOf(pol[1]), at: pendingAt },
    budgetAvailable: BigInt(budget),
    orderCount: BigInt(count),
  };
}

/** An allowlist entry of the vault: in force now, and from when it takes effect (0: not on the list). */
export async function readAllowEntry(client: PublicClient, vault: Address, kind: number, value: Hex): Promise<{ inForce: boolean; from: bigint }> {
  const [inForce, from] = (await client.readContract({ address: getAddress(vault), abi: ostraVaultAbi, functionName: "allowEntry", args: [kind, bytes32(value, "value")] })) as readonly [boolean, bigint];
  return { inForce, from: BigInt(from) };
}

/** OstraVaultV5.Order as the vault reports it, with its id and whether it can still run. */
export type V5Order = {
  id: bigint;
  kind: number;
  venueKind: number;
  interval: number;
  runsLeft: number;
  lastRun: bigint;
  endAt: bigint;
  target: Address;
  /** 0: set by the owner; else the agent key generation that set it. */
  agentGen: number;
  amount: bigint;
  threshold: bigint;
  live: boolean;
};

/** Standing order `id` of the vault. */
export async function readOrder(client: PublicClient, vault: Address, id: bigint): Promise<V5Order> {
  const [o, live] = (await client.readContract({ address: getAddress(vault), abi: ostraVaultAbi, functionName: "order", args: [id] })) as readonly [
    { kind: number; venueKind: number; interval: number; runsLeft: number; lastRun: bigint; endAt: bigint; epoch: bigint; target: Address; agentGen: number; amount: bigint; threshold: bigint },
    boolean,
  ];
  return {
    id,
    kind: Number(o.kind),
    venueKind: Number(o.venueKind),
    interval: Number(o.interval),
    runsLeft: Number(o.runsLeft),
    lastRun: BigInt(o.lastRun),
    endAt: BigInt(o.endAt),
    target: getAddress(o.target),
    agentGen: Number(o.agentGen),
    amount: BigInt(o.amount),
    threshold: BigInt(o.threshold),
    live,
  };
}

/** The vault's standing orders that can still run (ids 1 to orderCount). */
export async function readLiveOrders(client: PublicClient, vault: Address, orderCount: bigint): Promise<V5Order[]> {
  const out: V5Order[] = [];
  for (let from = 1n; from <= orderCount; from += ORDER_READ_BATCH) {
    const ids: bigint[] = [];
    for (let id = from; id < from + ORDER_READ_BATCH && id <= orderCount; id++) ids.push(id);
    out.push(...(await Promise.all(ids.map((id) => readOrder(client, vault, id)))).filter((o) => o.live));
  }
  return out;
}

/** How many orders readLiveOrders reads at once. */
const ORDER_READ_BATCH = 16n;

/** Whether Priors loan `loanId` is one the vault borrowed and has not repaid itself. */
export async function readOwnLoan(client: PublicClient, vault: Address, loanId: bigint): Promise<boolean> {
  return (await client.readContract({ address: getAddress(vault), abi: ostraVaultAbi, functionName: "ownLoan", args: [loanId] })) as boolean;
}

// ---------------------------------------------------------------------------
// The agent key's spend simulated with a throwaway key
// ---------------------------------------------------------------------------

const NO_STORE: WotsStore = { load: async () => undefined, saveIfAbsent: async () => true };

/** Throws unless the vault's agent root is at the slot the simulation overrides (OstraVaultV5.SLOT, offset 0). */
async function checkAgentRootSlot(client: PublicClient, vault: Address, root: Hex): Promise<void> {
  const stored = await client.getStorageAt({ address: vault, slot: VAULT_V5_SLOT });
  if ((stored ?? "0x").toLowerCase() !== padHex(root, { size: 32 }).toLowerCase()) throw new Error("the vault's agent root is not at the storage slot the simulation overrides; the vault implementation changed");
}

/**
 * Runs `vault`'s agent spend of `action` with `params` (OstraVault.spendAsAgent, from `relayer`) signed by a throwaway
 * key whose root replaces the vault's agent root in the simulation only, before the agent key signs it: the gas it uses
 * and its logs. The agent key must be in force. Throws QuoteError spend_fails when it reverts now (a signed one that
 * cannot land holds the agent key), or lands as a failure (MorphoFailed, VenueFailed: it would rotate the key and
 * count against the budget for nothing).
 */
export async function simulateAgentSpend(
  client: PublicClient,
  d: Deployment,
  a: { relayer: Address; vault: Address; action: number; params: Hex },
): Promise<{ gasUsed: bigint; logs: readonly Log[]; time: bigint }> {
  const vault = getAddress(a.vault);
  if ((await readVault(client, d, vault)) === null) throw new QuoteError("bad_request", `${vault} is not an Ostra vault of this deployment`);
  const s = await readV5(client, vault);
  if (s === null) throw new QuoteError("bad_request", `${vault} does not run version ${VAULT_V5} yet`);
  if (!s.agentKey.inForce) throw new QuoteError("spend_fails", "the vault's agent key is not in force (none set, not in force yet, expired or revoked)");
  await checkAgentRootSlot(client, vault, s.agentKey.root);
  const throwaway = new WotsKeychain(randomBytes32(), randomBytes32(), NO_STORE);
  const keyRoot = bytesToHex(throwaway.keyRoot(0n));
  const v = await readVault(client, d, vault);
  const signed = await signAgentSpend(throwaway, { vault, agentNonce: s.agentKey.agentNonce, keyRoot, vaultKeyRoot: v?.keyRoot ?? `0x${"00".repeat(32)}`, index: 0n, nextIndex: 1n }, { chainId: d.chainId, action: a.action as VaultAction, params: a.params });
  let sim: { gasUsed: bigint; logs: readonly Log[]; time: bigint };
  try {
    sim = await simulateRelay(client, { relayer: a.relayer, ...spendAsAgentCall(vault, signed) }, { stateOverrides: [{ address: vault, stateDiff: [{ slot: VAULT_V5_SLOT, value: keyRoot }] }] });
  } catch (err) {
    if (err instanceof RelaySimulationError && err.reverted) throw new QuoteError("spend_fails", `the agent spend fails now: ${err.message}`);
    throw err;
  }
  const failed = failedModuleSpends(sim.logs, [vault])[0];
  if (failed !== undefined) throw new QuoteError("spend_fails", `the agent spend fails now (${failed.kind} ${failed.action}: ${moduleFailureText(failed.reason)}) and would land as a failure, rotating the agent key for nothing`);
  return sim;
}

// ---------------------------------------------------------------------------
// Priors (CreditPoolV2) reads, and the OstraPad jobs that cover a loan
// ---------------------------------------------------------------------------

/** What OstraVaultModuleV5 reads of Priors' CreditPoolV2 (its IPriorsPool, against the pool's pinned code). */
export const priorsPoolAbi = parseAbi([
  "struct Agent { bool enrolled; bool isRoot; bool defaulted; bool frozen; bool importedFromV1; uint64 enrolledAt; uint64 lastBorrowAt; uint64 lastRepayAt; uint256 sponsor; uint256 delegatedIn; uint256 delegatedOut; uint256 principalOut; uint256 activeLoans; uint256 premiumBps; uint256 premiumCap; uint256 loansRepaid; uint256 volumeRepaid; uint256 feesPaid; uint256 recourseHonored; uint256 childrenDefaulted; uint256 qualifiedRepaid; uint256 dollarSecondsRepaid; }",
  "struct Loan { uint256 agentId; uint256 sponsorId; uint256 principal; uint256 fee; uint256 sponsorCut; uint256 reserveCut; uint256 premium; address owner; uint64 issuedAt; uint64 dueAt; uint64 defaultableAt; uint64 minScoreTerm; uint64 closedAt; uint8 status; }",
  "struct Params { uint256 minLoan; uint256 maxLoan; uint64 minTerm; uint64 maxTerm; uint64 grace; uint64 minScoreTerm; uint256 feeBps; uint256 sponsorFeeBps; uint256 protocolFeeBps; uint256 minStake; uint256 maxUtilizationBps; uint256 keeperBounty; }",
  "function getAgent(uint256 id) view returns (Agent)",
  "function getLoan(uint256 loanId) view returns (Loan)",
  "function getParams() view returns (Params)",
  "function nonces(uint256 agentId) view returns (uint256)",
]);

/** CreditPoolV2's loan status of an open loan (OstraVaultModuleV5.LOAN_ACTIVE). */
export const PRIORS_LOAN_ACTIVE = 1;

export type PriorsAgent = { enrolled: boolean; isRoot: boolean; defaulted: boolean; frozen: boolean; sponsor: bigint; principalOut: bigint; activeLoans: bigint; premiumBps: bigint };
export type PriorsLoan = { loanId: bigint; agentId: bigint; sponsorId: bigint; principal: bigint; fee: bigint; owner: Address; issuedAt: bigint; dueAt: bigint; defaultableAt: bigint; status: number };

export async function readPriorsAgent(client: PublicClient, agentId: bigint): Promise<PriorsAgent> {
  const a = await client.readContract({ address: PRIORS_POOL, abi: priorsPoolAbi, functionName: "getAgent", args: [agentId] });
  return { enrolled: a.enrolled, isRoot: a.isRoot, defaulted: a.defaulted, frozen: a.frozen, sponsor: a.sponsor, principalOut: a.principalOut, activeLoans: a.activeLoans, premiumBps: a.premiumBps };
}

export async function readPriorsLoan(client: PublicClient, loanId: bigint): Promise<PriorsLoan> {
  const l = await client.readContract({ address: PRIORS_POOL, abi: priorsPoolAbi, functionName: "getLoan", args: [loanId] });
  return { loanId, agentId: l.agentId, sponsorId: l.sponsorId, principal: l.principal, fee: l.fee, owner: getAddress(l.owner), issuedAt: BigInt(l.issuedAt), dueAt: BigInt(l.dueAt), defaultableAt: BigInt(l.defaultableAt), status: Number(l.status) };
}

const JOB_ACCEPTED = 2;
const JOB_SUBMITTED = 3;
const JOB_DECIDED = 4;
const JOB_APPEALED = 5;

/**
 * The OstraPad jobs among `candidates` that cover a loan of `vault` now (OstraVaultModuleV5._escrowed: provided by the
 * vault, and accepted or submitted and not past expiry, or decided or appealed with an approval): the COVER_JOBS of
 * them with the largest budgets, their ids rising as PriorsBorrow takes them, and the budgets they add up to.
 */
export async function coverJobs(client: PublicClient, vault: Address, candidates: readonly Hex[], now: bigint): Promise<{ jobs: Hex[]; escrowed: bigint }> {
  const v = getAddress(vault);
  const ids = [...new Set(candidates.map((c) => bytes32(c, "job id")))].filter((c) => BigInt(c) !== 0n);
  const read = await Promise.all(ids.map(async (id) => ({ id, j: (await client.readContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: "job", args: [id] })) as { provider: Address; budget: bigint; status: number; approved: boolean; expiresAt: bigint } })));
  const live = read.filter(({ j }) => {
    if (getAddress(j.provider) !== v) return false;
    const status = Number(j.status);
    return ((status === JOB_ACCEPTED || status === JOB_SUBMITTED) && now < BigInt(j.expiresAt)) || ((status === JOB_DECIDED || status === JOB_APPEALED) && j.approved);
  });
  live.sort((a, b) => (BigInt(b.j.budget) > BigInt(a.j.budget) ? 1 : BigInt(b.j.budget) < BigInt(a.j.budget) ? -1 : 0));
  const chosen = live.slice(0, VAULT_V5_LIMITS.COVER_JOBS);
  chosen.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return { jobs: chosen.map((c) => c.id), escrowed: chosen.reduce((t, c) => t + BigInt(c.j.budget), 0n) };
}
