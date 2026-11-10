// Version 5 from the owner's key (src/OstraVaultV5.sol, src/OstraVaultModuleV5.sol; sdk vault-v5.ts): the policy that
// bounds the agent key and the standing orders, the allowlists, the agent key itself, the standing orders, Priors
// credit (borrow, repay, consent, leave) and the Priors root's spends, all on the agent's USDG vault. Each spend is run
// first with a throwaway key and refused before it is signed when it would revert, land as a failure (PriorsFailed,
// Guarded) or land without doing anything (a cleanup the module lets land so that nobody can hold the key: an entry
// already gone, a loan already repaid): a one-time key is never spent on a spend that does nothing. A change that
// loosens waits the withdrawal lock's delay, and each result says when it takes effect.
//
// The vault's own MCP also runs its standing orders and repays its Priors loans when due (runDue, from the sweep),
// through the relayer and paid from the vault's relayer channel (decided 8 Nov 2026); Ostra's keeper only stands in
// for an MCP that is offline, within hard limits.

import { decodeEventLog, encodeFunctionData, getAbiItem, getAddress, isAddress, zeroAddress, type AbiEvent, type Address, type Hex, type Log, type PublicClient } from "viem";
import {
  ALLOW_KIND,
  ORDER_KIND,
  QuoteError,
  VAULT_ACTION,
  VAULT_AGENT_ACTIONS,
  VAULT_V5,
  VAULT_V5_LIMITS,
  VENUE_KIND,
  agentActionMask,
  agentActionsOf,
  agentMayUse,
  allowTakesAddress,
  allowValue,
  cancelOrderParams,
  checkPolicy,
  coverJobs,
  failedModuleSpends,
  getLogsChunked,
  moduleFailureText,
  ostraVaultAbi,
  ostraVaultModuleV5Abi,
  policyParams,
  policyTighter,
  priorsBorrowParams,
  priorsConsentParams,
  priorsLeaveParams,
  priorsRepayParams,
  PRIORS_LOAN_ACTIVE,
  readAllowEntry,
  readLiveOrders,
  readOrder,
  readOwnLoan,
  readPriorsAgent,
  readPriorsLoan,
  readV5,
  readVault,
  readVaultGuard,
  revokeAgentKeyParams,
  rootClaimFeesParams,
  rootFreezeParams,
  rootSponsorParams,
  rootStakeParams,
  rootUnlockParams,
  rootVouchParams,
  setAgentKeyParams,
  setAllowParams,
  setOrderParams,
  signVaultSpend,
  simulateVaultSpend,
  spendFloorGas,
  upgradeableBeaconAbi,
  type OrderParams,
  type Policy,
  type SponsorParams,
  type V5Order,
  type V5State,
} from "@ostraagent/sdk";
import { formatUnitsAmount, parseUnitsAmount, TOKEN_DECIMALS } from "./amount.ts";
import { chainTime } from "./chain.ts";
import type { Config } from "./config.ts";
import { VAULT_SPEND_GAS, type Sender } from "./relay.ts";
import { spendCall, type VaultOperationResult, type VaultService } from "./vault.ts";

const SPEND_GAS_HEADROOM = 100_000n;
const DAY = 86_400n;
/**
 * The least time a spend whose validity ends (an agent key's expiry after it takes effect, an order's endAt) is given
 * past what the module checks: a signed spend that reverts holds the owner's key, so it is never signed so close to
 * that bound that a late landing would revert.
 */
const LANDING_MARGIN = DAY;

/** The agent key's actions by name (the VAULT_ACTION names in lower case), only those it may ever use. */
export const AGENT_ACTION_NAMES: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(VAULT_ACTION)
    .filter(([, a]) => ((VAULT_AGENT_ACTIONS >> BigInt(a)) & 1n) === 1n)
    .map(([name, a]) => [name.toLowerCase(), a]),
);

/** The allowlist kinds by name. */
export const ALLOW_KIND_NAMES: Readonly<Record<string, number>> = {
  recipient: ALLOW_KIND.RECIPIENT,
  channel: ALLOW_KIND.CHANNEL,
  pool: ALLOW_KIND.POOL,
  lend: ALLOW_KIND.LEND,
  sponsor: ALLOW_KIND.SPONSOR,
  borrower: ALLOW_KIND.BORROWER,
};

/** The events a version 5 spend that did something emits (from the vault, through delegatecall), by action. */
const DONE_EVENTS: Readonly<Record<number, readonly string[]>> = {
  [VAULT_ACTION.SET_POLICY]: ["PolicySet"],
  [VAULT_ACTION.SET_ALLOW]: ["AllowSet"],
  [VAULT_ACTION.SET_AGENT_KEY]: ["AgentKeySet"],
  [VAULT_ACTION.REVOKE_AGENT_KEY]: ["AgentKeyRevoked"],
  [VAULT_ACTION.SET_ORDER]: ["OrderSet"],
  [VAULT_ACTION.CANCEL_ORDER]: ["OrderCancelled", "OrdersStopped"],
  [VAULT_ACTION.PRIORS_BORROW]: ["PriorsBorrowed"],
  [VAULT_ACTION.PRIORS_REPAY]: ["PriorsRepaid"],
  [VAULT_ACTION.PRIORS_CONSENT]: ["PriorsConsented"],
  [VAULT_ACTION.PRIORS_LEAVE]: ["PriorsLeft"],
  [VAULT_ACTION.ROOT_ENROLL]: ["RootSpent"],
  [VAULT_ACTION.ROOT_ADD_STAKE]: ["RootSpent"],
  [VAULT_ACTION.ROOT_SPONSOR]: ["RootSpent"],
  [VAULT_ACTION.ROOT_VOUCH]: ["RootSpent"],
  [VAULT_ACTION.ROOT_UNVOUCH]: ["RootSpent"],
  [VAULT_ACTION.ROOT_FREEZE]: ["RootSpent"],
  [VAULT_ACTION.ROOT_UNLOCK]: ["RootSpent"],
  [VAULT_ACTION.ROOT_CLAIM_FEES]: ["RootSpent"],
};

/** The names of the module V5 events among `logs` emitted by `vault`. */
export function v5EventsOf(logs: readonly Log[], vault: Address): string[] {
  const at = getAddress(vault);
  const out: string[] = [];
  for (const log of logs) {
    if (getAddress(log.address) !== at) continue;
    try {
      out.push(decodeEventLog({ abi: ostraVaultModuleV5Abi, topics: log.topics as [Hex, ...Hex[]], data: log.data }).eventName);
    } catch {
      // another contract's event, or one of the vault itself
    }
  }
  return out;
}

/** Whether a version 5 spend of `action` did something by its simulated `logs` (actions without a list: always). */
export function v5SpendDid(action: number, logs: readonly Log[], vault: Address): boolean {
  const expected = DONE_EVENTS[action];
  if (expected === undefined) return true;
  const seen = new Set(v5EventsOf(logs, vault));
  return expected.some((e) => seen.has(e));
}

function iso(unix: bigint): string {
  return new Date(Number(unix) * 1000).toISOString();
}

function usdg(units: bigint): string {
  return formatUnitsAmount(units, TOKEN_DECIMALS);
}

/** A policy as the tools show it: amounts in USDG, times in seconds and ISO, the actions by name. */
export function policyView(p: Policy): Record<string, unknown> {
  const names = Object.fromEntries(Object.entries(AGENT_ACTION_NAMES).map(([n, a]) => [a, n]));
  return {
    actions: agentActionsOf(p.actions).map((a) => names[a] ?? String(a)),
    perTx: usdg(p.perTx),
    daily: usdg(p.daily),
    maxDebt: usdg(p.maxDebt),
    maxTermSeconds: p.maxTerm,
    maxFeeBps: p.maxFeeBps,
    coverBps: p.coverBps,
    repayLeadSeconds: p.repayLead,
    repayVenue: p.repayKind === 0 ? null : { kind: p.repayKind, venue: p.repayVenue },
    vouchPerAgent: usdg(p.vouchPerAgent),
    vouchTotal: usdg(p.vouchTotal),
    maxPremiumBps: p.maxPremiumBps,
  };
}

/** A change to the policy: each field left out keeps the value in force. Amounts in USDG. */
export type PolicyInput = {
  actions?: readonly string[];
  perTx?: string;
  daily?: string;
  maxDebt?: string;
  maxTermSeconds?: number;
  maxFeeBps?: number;
  coverBps?: number;
  repayLeadSeconds?: number;
  /** The venue a short repayDue exits first: { kind, venue } (RAETO_USDG 1 or ERC4626 3), or null for none. */
  repayVenue?: { kind: number; venue: string } | null;
  vouchPerAgent?: string;
  vouchTotal?: string;
  maxPremiumBps?: number;
};

/** The policy `input` makes of `current`. Throws for an action name it does not know or a value the module refuses. */
export function policyOf(current: Policy, input: PolicyInput): Policy {
  const amount = (text: string | undefined, now: bigint) => (text === undefined ? now : parseUnitsAmount(text, TOKEN_DECIMALS));
  let actions = current.actions;
  if (input.actions !== undefined) {
    const ids = input.actions.map((n) => {
      const a = AGENT_ACTION_NAMES[n.trim().toLowerCase()];
      if (a === undefined) throw new RangeError(`"${n}" is not an action the agent key may use (one of: ${Object.keys(AGENT_ACTION_NAMES).join(", ")})`);
      return a;
    });
    actions = agentActionMask(ids);
  }
  let repayKind = current.repayKind;
  let repayVenue = current.repayVenue;
  if (input.repayVenue !== undefined) {
    if (input.repayVenue === null) [repayKind, repayVenue] = [0, zeroAddress];
    else {
      if (!isAddress(input.repayVenue.venue, { strict: false })) throw new RangeError("the repay venue is not an address");
      [repayKind, repayVenue] = [input.repayVenue.kind, getAddress(input.repayVenue.venue)];
    }
  }
  return checkPolicy({
    actions,
    perTx: amount(input.perTx, current.perTx),
    daily: amount(input.daily, current.daily),
    maxDebt: amount(input.maxDebt, current.maxDebt),
    maxTerm: input.maxTermSeconds ?? current.maxTerm,
    maxFeeBps: input.maxFeeBps ?? current.maxFeeBps,
    coverBps: input.coverBps ?? current.coverBps,
    repayLead: input.repayLeadSeconds ?? current.repayLead,
    repayKind,
    repayVenue,
    vouchPerAgent: amount(input.vouchPerAgent, current.vouchPerAgent),
    vouchTotal: amount(input.vouchTotal, current.vouchTotal),
    maxPremiumBps: input.maxPremiumBps ?? current.maxPremiumBps,
  });
}

/** The allowlist value of a kind from its text: an address, a PoolId (32 bytes of hex) or an agent id (decimal). */
export function allowValueOf(kind: number, text: string): Hex {
  const t = text.trim();
  if (allowTakesAddress(kind)) {
    if (!isAddress(t, { strict: false })) throw new RangeError(`this allowlist kind takes an address, not ${t}`);
    return allowValue(kind, getAddress(t));
  }
  if (kind === ALLOW_KIND.POOL) return allowValue(kind, t as Hex);
  if (!/^[0-9]+$/.test(t)) throw new RangeError(`this allowlist kind takes an agent id (a decimal number), not ${t}`);
  return allowValue(kind, BigInt(t));
}

export type V5Parts = {
  client: PublicClient;
  /** Serves eth_getLogs over long windows (the allowlist, the agent keys installed, the Priors loans). */
  logsClient: PublicClient;
  config: Config;
  buyer: VaultService;
  sender: Sender;
};

export type V5Change = VaultOperationResult & { effectiveAt?: string; note?: string };

export type V5Status = {
  vault: Address;
  version: number;
  policy: Record<string, unknown>;
  pendingPolicy: { policy: Record<string, unknown>; effectiveAt: string } | null;
  budgetAvailable: string;
  agentKey: { root: Hex | null; agentNonce: string; from: string | null; expiry: string | null; inForce: boolean };
  allowlist: { kind: string; value: Hex; inForce: boolean; effectiveAt: string }[];
  orders: { id: string; kind: string; target: Address; amount: string; threshold: string; intervalSeconds: number; runsLeft: number; lastRun: string | null; endAt: string | null; setBy: "owner" | "agent key" }[];
  loans: { loanId: string; agentId: string; principal: string; fee: string; dueAt: string; status: number }[];
};

const KIND_NAME: Record<number, string> = Object.fromEntries(Object.entries(ALLOW_KIND_NAMES).map(([n, k]) => [k, n]));
const ORDER_NAME: Record<number, string> = { [ORDER_KIND.SWEEP]: "sweep", [ORDER_KIND.REFILL]: "refill", [ORDER_KIND.PAY]: "pay" };

function event(name: string): AbiEvent {
  const e = (ostraVaultModuleV5Abi as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === name);
  if (e === undefined) throw new Error(`OstraVaultModuleV5 has no event ${name}`);
  return e as unknown as AbiEvent;
}

export class V5Service {
  readonly #p: V5Parts;
  #fromBlock: bigint | null = null;

  constructor(p: V5Parts) {
    this.#p = p;
  }

  async #vault(): Promise<Address> {
    return getAddress(await this.#p.buyer.vaultAddress());
  }

  /** The vault, existing and running version 5; throws otherwise (nothing is signed before the upgrade runs). */
  async ready(what: string): Promise<{ vault: Address; s: V5State }> {
    const vault = await this.#vault();
    if ((await readVault(this.#p.client, this.#p.config.deployment, vault)) === null) throw new Error(`this agent has no vault yet; nothing was signed`);
    const s = await readV5(this.#p.client, vault);
    if (s === null) throw new Error(`the vault ${vault} does not run version ${VAULT_V5} yet; ${what} opens once the vault beacon is upgraded (OstraUpgradeOwner call 3, executable from 2026-11-09T06:55:00Z); nothing was signed`);
    return { vault, s };
  }

  /**
   * The first block a version 5 event can be in: the vault beacon's first Upgraded to a version 5 implementation
   * (read once, then kept). Throws while the beacon has not been upgraded.
   */
  async fromBlock(): Promise<bigint> {
    if (this.#fromBlock !== null) return this.#fromBlock;
    const d = this.#p.config.deployment;
    const upgraded = getAbiItem({ abi: upgradeableBeaconAbi, name: "Upgraded" }) as AbiEvent;
    const head = await this.#p.logsClient.getBlockNumber();
    const logs = await getLogsChunked(this.#p.logsClient, { address: d.vaultBeacon, event: upgraded, fromBlock: BigInt(d.fromBlock), toBlock: head });
    for (const log of logs) {
      const impl = (log.args as { implementation: Address }).implementation;
      const version = Number(await this.#p.client.readContract({ address: impl, abi: ostraVaultAbi, functionName: "VERSION" }).catch(() => 0));
      if (version >= VAULT_V5) {
        this.#fromBlock = log.blockNumber;
        return log.blockNumber;
      }
    }
    throw new Error("the vault beacon has not been upgraded to version 5");
  }

  async #logs(vault: Address, name: string): Promise<Log[]> {
    const from = await this.fromBlock();
    // The head now, never viem's cached one: a change this service just made must be among the logs read.
    const head = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
    return (await getLogsChunked(this.#p.logsClient, { address: vault, event: event(name), fromBlock: from, toBlock: head })) as unknown as Log[];
  }

  /** Every agent key root the vault ever had: installed (AgentKeySet) or rotated to (AgentSpent's nextKeyRoot). */
  async agentRootsEver(vault: Address): Promise<Set<string>> {
    const [set, spent] = await Promise.all([this.#logs(vault, "AgentKeySet"), this.#logs(vault, "AgentSpent")]);
    const roots = new Set<string>();
    for (const l of set) roots.add(((l as unknown as { args: { root: Hex } }).args.root).toLowerCase());
    for (const l of spent) roots.add(((l as unknown as { args: { nextKeyRoot: Hex } }).args.nextKeyRoot).toLowerCase());
    return roots;
  }

  /** The vault's allowlist: every entry ever set (AllowSet), as the vault judges it now (allowEntry). */
  async allowlist(vault: Address): Promise<V5Status["allowlist"]> {
    const seen = new Map<string, { kind: number; value: Hex }>();
    for (const l of await this.#logs(vault, "AllowSet")) {
      const a = (l as unknown as { args: { kind: number; value: Hex } }).args;
      seen.set(`${a.kind}:${a.value.toLowerCase()}`, { kind: Number(a.kind), value: a.value.toLowerCase() as Hex });
    }
    const out: V5Status["allowlist"] = [];
    for (const { kind, value } of seen.values()) {
      const e = await readAllowEntry(this.#p.client, vault, kind, value);
      if (e.from === 0n) continue;
      out.push({ kind: KIND_NAME[kind] ?? String(kind), value, inForce: e.inForce, effectiveAt: iso(e.from) });
    }
    return out;
  }

  /** The vault's Priors loans still its own to repay (PriorsBorrowed, then ownLoan), with the pool's record of each. */
  async loans(vault: Address): Promise<V5Status["loans"]> {
    const out: V5Status["loans"] = [];
    for (const l of await this.#logs(vault, "PriorsBorrowed")) {
      const loanId = (l as unknown as { args: { loanId: bigint } }).args.loanId;
      if (!(await readOwnLoan(this.#p.client, vault, loanId))) continue;
      const ln = await readPriorsLoan(this.#p.client, loanId);
      out.push({ loanId: loanId.toString(), agentId: ln.agentId.toString(), principal: usdg(ln.principal), fee: usdg(ln.fee), dueAt: iso(ln.dueAt), status: ln.status });
    }
    return out;
  }

  async status(): Promise<V5Status> {
    const { vault, s } = await this.ready("v5_status");
    const orders = await readLiveOrders(this.#p.client, vault, s.orderCount);
    const [allowlist, loans] = await Promise.all([this.allowlist(vault), this.loans(vault)]);
    const k = s.agentKey;
    return {
      vault,
      version: s.version,
      policy: policyView(s.policy),
      pendingPolicy: s.pending === null ? null : { policy: policyView(s.pending.policy), effectiveAt: iso(s.pending.at) },
      budgetAvailable: usdg(s.budgetAvailable),
      agentKey: { root: BigInt(k.root) === 0n ? null : k.root, agentNonce: k.agentNonce.toString(), from: k.from === 0n ? null : iso(k.from), expiry: k.expiry === 0n ? null : iso(k.expiry), inForce: k.inForce },
      allowlist,
      orders: orders.map((o) => orderView(o)),
      loans,
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Spends
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Runs the spend with a throwaway key (sdk simulateVaultSpend): refused when it reverts, lands as a failure, or lands
   * without doing anything (`nothing` says why). Its gas used.
   */
  async #simulate(vault: Address, action: number, params: Hex, what: string, nothing: string): Promise<bigint> {
    let sim: Awaited<ReturnType<typeof simulateVaultSpend>>;
    try {
      sim = await simulateVaultSpend(this.#p.client, this.#p.config.deployment, { relayer: await this.#p.sender.payer(), vault, action, params });
    } catch (err) {
      if (err instanceof QuoteError) throw new QuoteError(err.code, `${what}: ${err.message}; nothing was signed`);
      throw err;
    }
    const failed = failedModuleSpends(sim.logs, [vault])[0];
    if (failed !== undefined) throw new QuoteError("spend_fails", `${what} fails now: ${moduleFailureText(failed.reason)}; nothing was signed`);
    if (!v5SpendDid(action, sim.logs, vault)) throw new QuoteError("spend_fails", `${what} would change nothing now (${nothing}); nothing was signed`);
    return sim.gasUsed;
  }

  /** Simulates, then inside the vault's queue simulates again right before signing, and sends the spend alone. */
  async #spend(vault: Address, action: number, params: Hex, what: string, nothing: string, moves = 0n): Promise<VaultOperationResult> {
    const gasUsed = await this.#simulate(vault, action, params, what, nothing);
    const floor = spendFloorGas(action, params);
    let gas = (gasUsed * 5n) / 4n + SPEND_GAS_HEADROOM + floor;
    if (gas < VAULT_SPEND_GAS + floor) gas = VAULT_SPEND_GAS + floor;
    return this.#p.buyer.operate({
      gas,
      moves,
      what,
      preview: { action, params },
      build: async ({ v, vault: at, keychain, chainId }) => {
        const again = await this.#simulate(at, action, params, what, nothing);
        if (again + SPEND_GAS_HEADROOM + floor > gas) throw new QuoteError("spend_fails", `${what} needs more gas now than it was reserved for; call again; nothing was signed`);
        return [spendCall(at, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))];
      },
    });
  }

  /** When a loosening change waits: the lock's delay from now, or now without the lock. */
  async #waitUntil(vault: Address): Promise<{ locked: boolean; at: bigint; now: bigint }> {
    const [g, now] = await Promise.all([readVaultGuard(this.#p.client, vault), chainTime(this.#p.client)]);
    const locked = g.lock.withdrawal !== zeroAddress;
    return { locked, at: now + (locked ? BigInt(g.lock.delay) : 0n), now };
  }

  /** SetPolicy: the fields given change, the rest keep their value. Tighter in every field: at once; else after the lock's delay. */
  async setPolicy(input: PolicyInput): Promise<V5Change & { policy: Record<string, unknown> }> {
    const what = "set the vault's policy";
    const { vault, s } = await this.ready(what);
    const next = policyOf(s.policy, input);
    const tighter = policyTighter(next, s.policy);
    const r = await this.#spend(vault, VAULT_ACTION.SET_POLICY, policyParams(next), what, "the same policy is in force");
    if (r.status !== "sent") return { ...r, policy: policyView(next) };
    const after = await readV5(this.#p.client, vault);
    if (after?.pending !== null && after?.pending !== undefined) {
      return { ...r, policy: policyView(next), effectiveAt: iso(after.pending.at), note: `it loosens the policy under the withdrawal lock: it takes effect at ${iso(after.pending.at)}; until then the policy in force stays, and the owner, a guardian or the withdrawal address can drop it` };
    }
    return { ...r, policy: policyView(next), effectiveAt: iso(await chainTime(this.#p.client)), note: tighter ? "tighter in every field: in force at once" : "no withdrawal lock: in force at once" };
  }

  /** SetAllow: an entry on (after the lock's delay under the lock) or off (at once). */
  async setAllow(kindName: string, valueText: string, allowed: boolean): Promise<V5Change & { kind: string; value: Hex }> {
    const kind = ALLOW_KIND_NAMES[kindName.trim().toLowerCase()];
    if (kind === undefined) throw new RangeError(`"${kindName}" is not an allowlist kind (one of: ${Object.keys(ALLOW_KIND_NAMES).join(", ")})`);
    const value = allowValueOf(kind, valueText);
    const what = `${allowed ? "allow" : "remove"} ${kindName} ${valueText}`;
    const { vault } = await this.ready(what);
    const e = await readAllowEntry(this.#p.client, vault, kind, value);
    if (allowed && e.inForce) throw new Error(`${kindName} ${valueText} is on the allowlist and in force already; nothing was signed`);
    // Waiting under the lock: allowing it again could land after it takes effect, and the module would then refuse it.
    // (One whose from has passed and is not in force was dropped, by a cancel or a recovery: it may be allowed again.)
    if (allowed && e.from > (await chainTime(this.#p.client))) {
      throw new Error(`${kindName} ${valueText} is on the allowlist already and takes effect at ${iso(e.from)} (the lock's delay), unless a cancel or a recovery dropped it since: then remove it first (allowed false) and allow it again; nothing was signed`);
    }
    if (!allowed && e.from === 0n) throw new Error(`${kindName} ${valueText} is not on the allowlist; nothing was signed`);
    const r = await this.#spend(vault, VAULT_ACTION.SET_ALLOW, setAllowParams({ kind, value, allowed }), what, "the entry is already as asked");
    if (r.status !== "sent" || !allowed) return { ...r, kind: kindName, value };
    const now = await readAllowEntry(this.#p.client, vault, kind, value);
    return now.inForce
      ? { ...r, kind: kindName, value, effectiveAt: iso(now.from) }
      : { ...r, kind: kindName, value, effectiveAt: iso(now.from), note: `under the withdrawal lock the entry takes effect at ${iso(now.from)}` };
  }

  /**
   * SetAgentKey: installs `rootText` (what agent_key_request gave) for `days` (at most MAX_AGENT_KEY_LIFE). Refuses a
   * root the vault had before (a message it signed then could never land again: SetAgentKey moves the agent nonce on),
   * the vault's own key root, and an expiry the lock's delay leaves no time before.
   */
  async setAgentKey(rootText: string, days: number): Promise<V5Change & { root: Hex; expiry: string }> {
    const what = "install the agent key";
    if (!/^0x[0-9a-fA-F]{64}$/.test(rootText.trim())) throw new RangeError("the agent key root is 32 bytes of hex (what agent_key_request gave)");
    const root = rootText.trim().toLowerCase() as Hex;
    if (BigInt(root) === 0n) throw new RangeError("the agent key root must not be zero");
    if (!Number.isFinite(days) || days <= 0) throw new RangeError("days must be greater than zero");
    const { vault, s } = await this.ready(what);
    const v = await readVault(this.#p.client, this.#p.config.deployment, vault);
    if (v !== null && v.keyRoot.toLowerCase() === root) throw new Error("that root is the vault's own key root: the agent key is another key; nothing was signed");
    if (s.agentKey.root.toLowerCase() === root) throw new Error("that root is the agent key in force already; nothing was signed");
    if ((await this.agentRootsEver(vault)).has(root)) throw new Error("that root was an agent key of this vault before: ask the agent for a new one (agent_key_request); nothing was signed");
    const { locked, at: from, now } = await this.#waitUntil(vault);
    const expiry = now + BigInt(Math.floor(days * Number(DAY)));
    if (expiry > now + BigInt(VAULT_V5_LIMITS.MAX_AGENT_KEY_LIFE)) throw new RangeError(`an agent key lasts at most ${VAULT_V5_LIMITS.MAX_AGENT_KEY_LIFE / 86_400} days`);
    if (expiry < from + LANDING_MARGIN) throw new RangeError(`the key takes effect at ${iso(from)}${locked ? " (the lock's delay)" : ""}: its expiry must be at least a day after that`);
    const r = await this.#spend(vault, VAULT_ACTION.SET_AGENT_KEY, setAgentKeyParams({ root, expiry }), what, "the key is already installed");
    const base = { ...r, root, expiry: iso(expiry), effectiveAt: iso(from) };
    return locked ? { ...base, note: `under the withdrawal lock the agent key may sign from ${iso(from)}` } : base;
  }

  /** RevokeAgentKey: the agent key stops at once, and the orders it set with it. */
  async revokeAgentKey(): Promise<V5Change> {
    const what = "revoke the agent key";
    const { vault, s } = await this.ready(what);
    if (BigInt(s.agentKey.root) === 0n) throw new Error("the vault has no agent key; nothing was signed");
    return this.#spend(vault, VAULT_ACTION.REVOKE_AGENT_KEY, revokeAgentKeyParams(), what, "no agent key to revoke");
  }

  /** The checks of an order against the policy in force, beyond the module's own (a run it would refuse every time). */
  #orderProblem(o: OrderParams, s: V5State, vault: Address, recipientOk: boolean): string | null {
    if (getAddress(o.target) === vault) return "the order's target is the vault itself";
    if (o.kind === ORDER_KIND.PAY) {
      if (!agentMayUse(s.policy, VAULT_ACTION.TRANSFER)) return "a PAY order runs only while the policy allows transfer (policy_set actions)";
      if (!recipientOk) return "a PAY order's recipient must be on the allowlist (allow_set recipient)";
    }
    if (o.kind === ORDER_KIND.SWEEP && !agentMayUse(s.policy, VAULT_ACTION.ENTER)) return "a SWEEP order runs only while the policy allows enter";
    if (o.kind === ORDER_KIND.REFILL && !agentMayUse(s.policy, VAULT_ACTION.EXIT)) return "a REFILL order runs only while the policy allows exit";
    if (o.amount > s.policy.perTx) return `one run counts ${usdg(o.amount)}, above the policy's perTx ${usdg(s.policy.perTx)}`;
    return null;
  }

  /** SetOrder: a standing order (sweep, refill or pay; amounts in USDG). */
  async setOrder(a: { kind: string; target: string; amount: string; threshold?: string; intervalSeconds: number; runs?: number; endAt?: string; venueKind?: number }): Promise<V5Change & { orderId?: string }> {
    const kind = { sweep: ORDER_KIND.SWEEP, refill: ORDER_KIND.REFILL, pay: ORDER_KIND.PAY }[a.kind.trim().toLowerCase()];
    if (kind === undefined) throw new RangeError(`"${a.kind}" is not an order kind (sweep, refill or pay)`);
    if (!isAddress(a.target, { strict: false })) throw new RangeError("the order's target is not an address");
    const endAt = a.endAt === undefined ? 0n : BigInt(Math.floor(Date.parse(a.endAt) / 1000));
    if (a.endAt !== undefined && !(endAt > 0n)) throw new RangeError("endAt is not a date");
    const o: OrderParams = {
      kind,
      venueKind: kind === ORDER_KIND.PAY ? 0 : (a.venueKind ?? VENUE_KIND.ERC4626),
      target: getAddress(a.target),
      amount: parseUnitsAmount(a.amount, TOKEN_DECIMALS),
      threshold: a.threshold === undefined ? 0n : parseUnitsAmount(a.threshold, TOKEN_DECIMALS),
      interval: a.intervalSeconds,
      runs: kind === ORDER_KIND.PAY ? (a.runs ?? 0) : 0,
      endAt,
    };
    const params = setOrderParams(o);
    const what = `set a ${a.kind} order`;
    const { vault, s } = await this.ready(what);
    if (endAt !== 0n && endAt < (await chainTime(this.#p.client)) + LANDING_MARGIN) throw new RangeError("endAt must be at least a day from now");
    const recipient = o.kind === ORDER_KIND.PAY ? await readAllowEntry(this.#p.client, vault, ALLOW_KIND.RECIPIENT, allowValue(ALLOW_KIND.RECIPIENT, o.target)) : { inForce: true, from: 1n };
    const problem = this.#orderProblem(o, s, vault, recipient.from !== 0n);
    if (problem !== null) throw new Error(`${problem}; nothing was signed`);
    const r = await this.#spend(vault, VAULT_ACTION.SET_ORDER, params, what, "the order was not set");
    if (r.status !== "sent") return r;
    const after = await readV5(this.#p.client, vault);
    return { ...r, ...(after === null ? {} : { orderId: after.orderCount.toString() }) };
  }

  /** CancelOrder: order `id`, or every order with id 0. */
  async cancelOrder(id: bigint): Promise<V5Change> {
    const what = id === 0n ? "cancel every standing order" : `cancel order ${id}`;
    const { vault, s } = await this.ready(what);
    if (id === 0n) {
      if ((await readLiveOrders(this.#p.client, vault, s.orderCount)).length === 0) throw new Error("the vault has no standing order that can still run; nothing was signed");
    } else if ((await readOrder(this.#p.client, vault, id)).kind === 0) {
      throw new Error(`order ${id} does not exist (cancelled or run out); nothing was signed`);
    }
    return this.#spend(vault, VAULT_ACTION.CANCEL_ORDER, cancelOrderParams(id), what, "no such order");
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Priors
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * PriorsBorrow for the vault's agent `agentId`: `amount` USDG for `termSeconds`, the fee at most `maxFee` USDG (the
   * policy caps it further). With the policy's cover, `candidates` are the OstraPad jobs to cover it from (the vault's
   * escrowed jobs, from the indexer): the largest budgets first, up to COVER_JOBS.
   */
  async priorsBorrow(a: { agentId: bigint; amount: string; termSeconds: number; maxFee: string; candidates?: readonly Hex[] }): Promise<V5Change & { loanId?: string; jobs: Hex[] }> {
    const what = `borrow ${a.amount} USDG from Priors`;
    const { vault, s } = await this.ready(what);
    const amount = parseUnitsAmount(a.amount, TOKEN_DECIMALS);
    const maxFee = parseUnitsAmount(a.maxFee, TOKEN_DECIMALS);
    const p = s.policy;
    if (p.maxDebt === 0n) throw new Error("the policy allows no borrowing (maxDebt 0: policy_set maxDebt); nothing was signed");
    const agent = await readPriorsAgent(this.#p.client, a.agentId);
    if (agent.principalOut + amount > p.maxDebt) throw new Error(`the agent would owe ${usdg(agent.principalOut + amount)}, above the policy's maxDebt ${usdg(p.maxDebt)}; nothing was signed`);
    if (a.termSeconds > p.maxTerm) throw new Error(`the term is above the policy's maxTerm of ${p.maxTerm} seconds; nothing was signed`);
    if (agent.sponsor === 0n) throw new Error(`agent ${a.agentId} has no Priors sponsor (no line to borrow on); nothing was signed`);
    if (!(await readAllowEntry(this.#p.client, vault, ALLOW_KIND.SPONSOR, allowValue(ALLOW_KIND.SPONSOR, agent.sponsor))).inForce) {
      throw new Error(`the agent's sponsor ${agent.sponsor} is not on the allowlist in force (allow_set sponsor ${agent.sponsor}); nothing was signed`);
    }
    let jobs: Hex[] = [];
    if (p.coverBps !== 0) {
      const c = await coverJobs(this.#p.client, vault, a.candidates ?? [], await chainTime(this.#p.client));
      const debt = agent.principalOut + amount;
      if (debt * 10_000n > BigInt(p.coverBps) * c.escrowed) {
        throw new Error(`the policy needs open principal of at most ${p.coverBps / 100}% of the vault's escrowed OstraPad budgets: ${usdg(debt)} owed against ${usdg(c.escrowed)} escrowed in ${c.jobs.length} job(s); nothing was signed`);
      }
      jobs = c.jobs;
    }
    const params = priorsBorrowParams({ agentId: a.agentId, amount, term: BigInt(a.termSeconds), maxFee, jobs });
    const r = await this.#spend(vault, VAULT_ACTION.PRIORS_BORROW, params, what, "the loan was not made");
    return { ...r, jobs };
  }

  /** PriorsRepay of loan `loanId` in full (one this vault borrowed and still open). */
  async priorsRepay(loanId: bigint): Promise<V5Change & { due: string }> {
    const what = `repay Priors loan ${loanId}`;
    const { vault } = await this.ready(what);
    if (!(await readOwnLoan(this.#p.client, vault, loanId))) throw new Error(`loan ${loanId} is not one this vault borrowed and has not repaid; nothing was signed`);
    const ln = await readPriorsLoan(this.#p.client, loanId);
    if (ln.status !== PRIORS_LOAN_ACTIVE) throw new Error(`loan ${loanId} is no longer open on Priors (status ${ln.status}: repaid by someone else, or defaulted); nothing was signed`);
    const due = ln.principal + ln.fee;
    const r = await this.#spend(vault, VAULT_ACTION.PRIORS_REPAY, priorsRepayParams({ loanId, maxDue: due }), what, "the loan is not open", due);
    return { ...r, due: usdg(due) };
  }

  /** PriorsConsent: the vault's agent `agentId` consents to sponsor `sponsorId` up to `maxPremiumBps`, for `days`. */
  async priorsConsent(a: { agentId: bigint; sponsorId: bigint; maxPremiumBps: number; days: number }): Promise<V5Change> {
    const what = `consent to Priors sponsor ${a.sponsorId}`;
    const { vault, s } = await this.ready(what);
    if (!(await readAllowEntry(this.#p.client, vault, ALLOW_KIND.SPONSOR, allowValue(ALLOW_KIND.SPONSOR, a.sponsorId))).inForce) throw new Error(`sponsor ${a.sponsorId} is not on the allowlist in force (allow_set sponsor); nothing was signed`);
    if (a.maxPremiumBps > s.policy.maxFeeBps || a.maxPremiumBps > VAULT_V5_LIMITS.MAX_PREMIUM_BPS) throw new Error(`the premium is above the policy's maxFeeBps ${s.policy.maxFeeBps} or ${VAULT_V5_LIMITS.MAX_PREMIUM_BPS} bps; nothing was signed`);
    const { at: from, now } = await this.#waitUntil(vault);
    const deadline = now + BigInt(Math.floor(a.days * Number(DAY)));
    if (deadline <= from || deadline > now + BigInt(VAULT_V5_LIMITS.MAX_CONSENT_LIFE)) throw new RangeError(`the consent lasts after the lock's delay (${iso(from)}) and at most ${VAULT_V5_LIMITS.MAX_CONSENT_LIFE / 86_400} days`);
    const r = await this.#spend(vault, VAULT_ACTION.PRIORS_CONSENT, priorsConsentParams({ agentId: a.agentId, sponsorId: a.sponsorId, maxPremiumBps: BigInt(a.maxPremiumBps), deadline }), what, "the consent was not given");
    return { ...r, effectiveAt: iso(from) };
  }

  /** PriorsLeave: the vault's agent `agentId` leaves its sponsor. */
  async priorsLeave(agentId: bigint): Promise<V5Change> {
    const what = `leave the Priors sponsor of agent ${agentId}`;
    const { vault } = await this.ready(what);
    if ((await readPriorsAgent(this.#p.client, agentId)).sponsor === 0n) throw new Error(`agent ${agentId} has no sponsor; nothing was signed`);
    return this.#spend(vault, VAULT_ACTION.PRIORS_LEAVE, priorsLeaveParams(agentId), what, "the agent has no sponsor");
  }

  /** The Priors root's spends (39 to 46), with their params (sdk vault-v5.ts). `moves`: USDG it takes out of the vault. */
  async root(
    a:
      | { action: "enroll" | "add_stake"; rootId: bigint; assets: string }
      | { action: "sponsor"; sponsor: SponsorParams }
      | { action: "vouch" | "unvouch"; rootId: bigint; agentId: bigint; amount: string }
      | { action: "freeze"; agentId: bigint; frozen: boolean }
      | { action: "unlock"; rootId: bigint; shares: bigint }
      | { action: "claim_fees"; rootId: bigint },
  ): Promise<V5Change> {
    const what = `Priors root ${a.action.replace("_", " ")}`;
    const { vault } = await this.ready(what);
    switch (a.action) {
      case "enroll":
      case "add_stake": {
        const assets = parseUnitsAmount(a.assets, TOKEN_DECIMALS);
        const action = a.action === "enroll" ? VAULT_ACTION.ROOT_ENROLL : VAULT_ACTION.ROOT_ADD_STAKE;
        return this.#spend(vault, action, rootStakeParams(action, { rootId: a.rootId, assets }), what, "nothing was staked", assets);
      }
      case "sponsor":
        return this.#spend(vault, VAULT_ACTION.ROOT_SPONSOR, rootSponsorParams(a.sponsor), what, "the borrower's consent nonce was used already");
      case "vouch":
      case "unvouch": {
        const action = a.action === "vouch" ? VAULT_ACTION.ROOT_VOUCH : VAULT_ACTION.ROOT_UNVOUCH;
        return this.#spend(vault, action, rootVouchParams(action, { rootId: a.rootId, agentId: a.agentId, amount: parseUnitsAmount(a.amount, TOKEN_DECIMALS) }), what, "the root does not sponsor that agent");
      }
      case "freeze":
        return this.#spend(vault, VAULT_ACTION.ROOT_FREEZE, rootFreezeParams({ agentId: a.agentId, frozen: a.frozen }), what, "the vault's root does not sponsor that agent");
      case "unlock":
        return this.#spend(vault, VAULT_ACTION.ROOT_UNLOCK, rootUnlockParams({ rootId: a.rootId, shares: a.shares }), what, "nothing was unlocked");
      case "claim_fees":
        return this.#spend(vault, VAULT_ACTION.ROOT_CLAIM_FEES, rootClaimFeesParams(a.rootId), what, "no fees to claim");
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Standing orders and Priors repays, run by the vault's own MCP
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * What can run now (each simulated from the sender: a run that fails reverts and is never sent): the vault's orders
   * past their interval, and its Priors loans within the policy's repay lead before they are due.
   */
  async due(): Promise<{ orders: bigint[]; loans: bigint[] }> {
    const vault = await this.#vault();
    const s = await readV5(this.#p.client, vault).catch(() => null);
    if (s === null) return { orders: [], loans: [] };
    const now = await chainTime(this.#p.client);
    const payer = await this.#p.sender.payer();
    const runs = async (data: Hex) => {
      try {
        await this.#p.client.call({ account: payer, to: vault, data });
        return true;
      } catch {
        return false;
      }
    };
    const orders: bigint[] = [];
    for (const o of await readLiveOrders(this.#p.client, vault, s.orderCount)) {
      if (o.lastRun !== 0n && now < o.lastRun + BigInt(o.interval)) continue;
      if (await runs(encodeFunctionData({ abi: ostraVaultAbi, functionName: "runOrder", args: [o.id] }))) orders.push(o.id);
    }
    const loans: bigint[] = [];
    const lead = BigInt(s.policy.repayLead === 0 ? VAULT_V5_LIMITS.DEFAULT_REPAY_LEAD : s.policy.repayLead);
    for (const l of await this.loans(vault).catch(() => [])) {
      if (l.status !== PRIORS_LOAN_ACTIVE) continue;
      if (now + lead < BigInt(Math.floor(Date.parse(l.dueAt) / 1000))) continue;
      if (await runs(encodeFunctionData({ abi: ostraVaultAbi, functionName: "repayDue", args: [BigInt(l.loanId)] }))) loans.push(BigInt(l.loanId));
    }
    return { orders, loans };
  }

  /** Runs what is due (due), repays first, each in its own transaction through the vault's sender. */
  async runDue(): Promise<{ ran: { kind: "repay" | "order"; id: string; txHash?: Hex; error?: string }[] }> {
    const vault = await this.#vault();
    const { orders, loans } = await this.due();
    const ran: { kind: "repay" | "order"; id: string; txHash?: Hex; error?: string }[] = [];
    const send = async (kind: "repay" | "order", id: bigint, data: Hex) => {
      try {
        ran.push({ kind, id: id.toString(), txHash: await this.#p.sender.send([{ to: vault, data }]) });
      } catch (err) {
        ran.push({ kind, id: id.toString(), error: (err as Error).message });
      }
    };
    for (const id of loans) await send("repay", id, encodeFunctionData({ abi: ostraVaultAbi, functionName: "repayDue", args: [id] }));
    for (const id of orders) await send("order", id, encodeFunctionData({ abi: ostraVaultAbi, functionName: "runOrder", args: [id] }));
    return { ran };
  }
}

function orderView(o: V5Order): V5Status["orders"][number] {
  return {
    id: o.id.toString(),
    kind: ORDER_NAME[o.kind] ?? String(o.kind),
    target: o.target,
    amount: usdg(o.amount),
    threshold: usdg(o.threshold),
    intervalSeconds: o.interval,
    runsLeft: o.runsLeft,
    lastRun: o.lastRun === 0n ? null : iso(o.lastRun),
    endAt: o.endAt === 0n ? null : iso(o.endAt),
    setBy: o.agentGen === 0 ? "owner" : "agent key",
  };
}
