// The agent key of a version 5 vault another seed owns (OSTRA_AGENT_OF; decided 8 Nov 2026): this seed's WOTS keychain
// in its own domain (keys.ts agentKeychainId: the chain and the vault), and the spends it signs through
// OstraVault.spendAsAgent within the vault's policy. The owner installs each key (SetAgentKey) from the root
// agent_key_request gives; the agent never holds the owner's seed.
//
// Which key signs. The vault's agent nonce is not the key's index (SetAgentKey and a revoke move it on too), so the
// index of the key in force is found by its root among this keychain's keys. One index rises across every key ever
// handed out or rotated to: the next one is always above the highest ever used (`next` in agent-key.json). When a
// seed is restored without that file, it is rebuilt from the vault's AgentKeySet and AgentSpent events and the
// signatures recorded (here or in the relayer's escrow), plus RESTORE_SKIP: a root handed out by agent_key_request and
// never installed nor used leaves no trace, so the RESTORE_SKIP indexes right after the highest known are skipped (a
// restore after more roots than that were handed out and never used could hand one of them out again). Whatever
// happens, the keychain's records stop a key from ever signing two messages.
//
// A spend signed and not landed. An agent spend that fails reverts and keeps its key, and the keychain then refuses
// any other message for that key: the one signed is sent again first whenever it can land now (simulated with its own
// signature; one that lands as a failure is sent too: landing frees the key). While it cannot land (a budget that
// refills, an allowlist entry still waiting) nothing else is signed; if it never can (the policy or the allowlist
// changed for good), only the owner can install another key (the agent cannot revoke it without that same key).
//
// Before signing, each spend is checked as OstraVaultModuleV5 checks it (the key in force, the action in the policy,
// perTx and what the budget has left, the allowlists of the action) and then run with a throwaway key (sdk
// simulateAgentSpend): a signature that could not land would hold the key.

import { bytesToHex, decodeFunctionData, getAddress, hexToBytes, type Abi, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import {
  ALLOW_KIND,
  QuoteError,
  VAULT_AGENT_ACTIONS,
  VAULT_V5,
  agentMayUse,
  allowValue,
  decodeAgentSpendMessage,
  decodeClaimDividendParams,
  decodeLendParams,
  decodeOpenChannelParams,
  decodeRedeemParams,
  decodeRepayParams,
  decodeSwapParams,
  decodeTransferParams,
  getLogsChunked,
  ostraVaultAbi,
  ostraVaultModuleV5Abi,
  poolId,
  readAllowEntry,
  readOrder,
  readV5,
  readVault,
  readVaultGuard,
  RelaySimulationError,
  signAgentSpend,
  simulateAgentSpend,
  simulateRelay,
  spendAsAgentCall,
  upgradeableBeaconAbi,
  VAULT_ACTION as A,
  type RelayCall,
  type V5State,
  type VaultAction,
  type WotsKeychain,
} from "@ostraagent/sdk";
import { formatUnitsAmount, TOKEN_DECIMALS } from "./amount.ts";
import type { Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import type { Folder } from "./storage.ts";

/** Where this seed keeps the next agent key index of the vault (one file per vault). */
export const AGENT_KEY_DIR = "agent-key";
/** How far past the highest index known the keys are searched for a root. */
const SEARCH_WINDOW = 256n;
/** The indexes skipped past the highest known when the mark is rebuilt (roots handed out but never seen on chain). */
const RESTORE_SKIP = 64n;
/** The roots agent_key_request handed out last, kept with their index: an installed one is found without a search. */
const ISSUED_KEPT = 64;

type MarkRecord = { version: 1; chainId: number; vault: Address; next: string };
type IssuedRecord = { version: 1; roots: [root: Hex, index: string][] };

export type AgentKeyParts = {
  client: PublicClient;
  /** Serves eth_getLogs over long windows (the vault's AgentKeySet and AgentSpent, to rebuild the mark). */
  logsClient: PublicClient;
  config: Config;
  /** This agent's own keys (never the owner's seed). */
  keys: Keys;
  /** The vault the agent key signs for (OSTRA_AGENT_OF). */
  vault: Address;
  folder: Folder;
};

/** A signed agent spend that waits: sent again first when it can still land. */
export type PendingAgentSpend = { action: number; params: Hex; call: RelayCall };

/** The key in force signed a spend that cannot land now: nothing else is signed with it until that one lands. */
export class AgentSpendHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSpendHeldError";
  }
}

function usdg(units: bigint): string {
  return formatUnitsAmount(units, TOKEN_DECIMALS);
}

function iso(unix: bigint): string {
  return new Date(Number(unix) * 1000).toISOString();
}

function v5Event(name: string): AbiEvent {
  const e = (ostraVaultModuleV5Abi as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === name);
  if (e === undefined) throw new Error(`OstraVaultModuleV5 has no event ${name}`);
  return e as unknown as AbiEvent;
}

export class AgentKey {
  readonly vault: Address;
  readonly #p: AgentKeyParts;
  readonly #keychain: WotsKeychain;
  readonly #roots = new Map<bigint, Hex>();
  #from: bigint | null = null;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(p: AgentKeyParts) {
    this.#p = p;
    this.vault = getAddress(p.vault);
    this.#keychain = p.keys.agentKeychain(p.config.chainId, this.vault);
  }

  /** One at a time: the mark and the keys move together. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => undefined);
    return run;
  }

  #root(index: bigint): Hex {
    let r = this.#roots.get(index);
    if (r === undefined) {
      r = bytesToHex(this.#keychain.keyRoot(index));
      this.#roots.set(index, r);
    }
    return r;
  }

  #name(): string {
    return `${this.#p.config.chainId}-${this.vault.toLowerCase()}.json`;
  }

  #issuedName(): string {
    return `${this.#p.config.chainId}-${this.vault.toLowerCase()}.issued.json`;
  }

  /** The roots handed out last and their indexes (a hint only: each is checked against the keychain before use). */
  async #issued(): Promise<[Hex, bigint][]> {
    const text = await this.#p.folder.read(this.#issuedName());
    if (text === undefined) return [];
    try {
      const r = JSON.parse(text) as IssuedRecord;
      return r.version === 1 && Array.isArray(r.roots) ? r.roots.map(([root, i]) => [root.toLowerCase() as Hex, BigInt(i)]) : [];
    } catch {
      return [];
    }
  }

  /** The vault, running version 5 (else nothing is signed). */
  async state(): Promise<V5State> {
    if ((await readVault(this.#p.client, this.#p.config.deployment, this.vault)) === null) throw new Error(`${this.vault} is not an Ostra vault of this deployment`);
    const s = await readV5(this.#p.client, this.vault);
    if (s === null) throw new Error(`the vault ${this.vault} does not run version ${VAULT_V5} yet: its agent key opens once the vault beacon is upgraded`);
    return s;
  }

  /** The first block a version 5 event can be in: the vault beacon's first Upgraded to a version 5 implementation (kept). */
  async #v5From(): Promise<bigint> {
    if (this.#from !== null) return this.#from;
    const d = this.#p.config.deployment;
    const head = await this.#p.logsClient.getBlockNumber();
    const upgraded = (upgradeableBeaconAbi as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === "Upgraded") as unknown as AbiEvent;
    for (const l of await getLogsChunked(this.#p.logsClient, { address: d.vaultBeacon, event: upgraded, fromBlock: BigInt(d.fromBlock), toBlock: head })) {
      const impl = (l.args as { implementation: Address }).implementation;
      const version = Number(await this.#p.client.readContract({ address: impl, abi: ostraVaultAbi, functionName: "VERSION" }).catch(() => 0));
      if (version >= VAULT_V5) {
        this.#from = l.blockNumber;
        return l.blockNumber;
      }
    }
    return BigInt(d.fromBlock);
  }

  /** The roots the vault ever had as its agent key (AgentKeySet, and AgentSpent's nextKeyRoot), from its upgrade on. */
  async #rootsOnChain(): Promise<Set<string>> {
    const head = await this.#p.logsClient.getBlockNumber();
    const from = await this.#v5From();
    const roots = new Set<string>();
    for (const l of await getLogsChunked(this.#p.logsClient, { address: this.vault, event: v5Event("AgentKeySet"), fromBlock: from, toBlock: head })) roots.add((l.args as { root: Hex }).root.toLowerCase());
    for (const l of await getLogsChunked(this.#p.logsClient, { address: this.vault, event: v5Event("AgentSpent"), fromBlock: from, toBlock: head })) roots.add((l.args as { nextKeyRoot: Hex }).nextKeyRoot.toLowerCase());
    return roots;
  }

  /**
   * The next index never handed out or used: from agent-key.json, or, without it (a restored seed), rebuilt from the
   * vault's events and the signatures recorded (locally or in the escrow), searched SEARCH_WINDOW past the highest found.
   */
  async #next(): Promise<bigint> {
    const text = await this.#p.folder.read(this.#name());
    if (text !== undefined) {
      const r = JSON.parse(text) as MarkRecord;
      if (r.version !== 1 || r.chainId !== this.#p.config.chainId || getAddress(r.vault) !== this.vault) throw new Error(`corrupt agent key record ${this.#name()}`);
      return BigInt(r.next);
    }
    const onChain = await this.#rootsOnChain();
    let found = -1n;
    for (let i = 0n; i < found + 1n + SEARCH_WINDOW; i++) {
      if (onChain.has(this.#root(i)) || (await this.#keychain.signed(i)) !== undefined) found = i;
    }
    const next = found + 1n + RESTORE_SKIP;
    await this.#setNext(next);
    return next;
  }

  async #setNext(next: bigint): Promise<void> {
    await this.#p.folder.ensure();
    const r: MarkRecord = { version: 1, chainId: this.#p.config.chainId, vault: this.vault, next: next.toString() };
    await this.#p.folder.write(this.#name(), `${JSON.stringify(r, null, 2)}\n`);
  }

  /** Hands out a fresh index (above every index ever used) and moves the mark past it. */
  async #take(): Promise<bigint> {
    const i = await this.#next();
    await this.#setNext(i + 1n);
    return i;
  }

  /**
   * The index of this keychain's key whose root is `root`, or null when it is none of this seed's: searched down from
   * the newest index handed out (the key in force is almost always one of the last), then SEARCH_WINDOW past it; a root
   * agent_key_request handed out lately is found at once (the issued record), however many were handed out after it.
   */
  async indexOf(root: Hex): Promise<bigint | null> {
    const r = root.toLowerCase();
    for (const [h, i] of await this.#issued()) if (h === r && this.#root(i) === r) return i;
    const next = await this.#next();
    for (let i = next - 1n; i >= 0n; i--) if (this.#root(i) === r) return i;
    for (let i = next; i < next + SEARCH_WINDOW; i++) if (this.#root(i) === r) return i;
    return null;
  }

  /**
   * agent_key_request: a fresh key root for the owner to install (agent_key_set), and what the owner sets up so that
   * this agent can pay the relayer from the vault: the relayer's channel receiver on the allowlist, OpenChannel in the
   * policy, and a perTx no lower than the relayer channel's deposit.
   */
  request(): Promise<{ vault: Address; root: Hex; index: string }> {
    return this.#serial(async () => {
      await this.state();
      const i = await this.#take();
      const root = this.#root(i);
      const kept = (await this.#issued()).slice(-(ISSUED_KEPT - 1));
      const rec: IssuedRecord = { version: 1, roots: [...kept.map(([h, x]) => [h, x.toString()] as [Hex, string]), [root, i.toString()]] };
      await this.#p.folder.write(this.#issuedName(), `${JSON.stringify(rec)}\n`);
      return { vault: this.vault, root, index: i.toString() };
    });
  }

  /** The key in force: its index, or why there is none this seed can use. */
  async #current(s: V5State): Promise<bigint> {
    const k = s.agentKey;
    if (BigInt(k.root) === 0n) throw new Error(`the vault ${this.vault} has no agent key: ask its owner to install one (agent_key_request, then the owner's agent_key_set)`);
    const index = await this.indexOf(k.root);
    if (index === null) throw new Error(`the vault's agent key ${k.root} is not one of this seed's keys`);
    if (!k.inForce) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const why = k.from > now ? `it may sign from ${iso(k.from)} (the lock's delay)` : `it expired at ${iso(k.expiry)}`;
      throw new Error(`the vault's agent key is not in force: ${why}; nothing was signed`);
    }
    return index;
  }

  /**
   * The spend the key in force signed at the vault's current agent nonce and has not seen land (this device's record
   * or the escrow's), decoded, or null. Read only: nothing is simulated.
   */
  async signedNow(s: V5State): Promise<PendingAgentSpend | null> {
    if (BigInt(s.agentKey.root) === 0n) return null;
    const index = await this.indexOf(s.agentKey.root);
    if (index === null) return null;
    const rec = await this.#keychain.signed(index);
    if (rec === undefined) return null;
    const m = decodeAgentSpendMessage(hexToBytes(`0x${rec.message}`));
    if (m.vault !== this.vault || m.chainId !== this.#p.config.chainId) throw new Error(`agent key ${index} signed for another vault or chain`);
    // Signed under an earlier agent nonce of the same root (it cannot happen: every nonce move but a spend changes the
    // root, and a spend rotates it): not this nonce's.
    if (m.agentNonce !== s.agentKey.agentNonce) return null;
    return { action: m.action, params: m.params, call: spendAsAgentCall(this.vault, { action: m.action, nextKeyRoot: m.nextKeyRoot, params: m.params, signature: `0x${rec.signature}` }) };
  }

  /**
   * Where the next agent spend is signed (the agent nonce and the key's index) and the spend signed there and not
   * landed, decoded; null without a key of this seed in force or waiting. The VaultService's spendSlot in agent mode.
   */
  async slot(): Promise<{ nonce: bigint; keyIndex: bigint; pending: { action: number; params: Hex } | null } | null> {
    const s = await readV5(this.#p.client, this.vault);
    if (s === null || BigInt(s.agentKey.root) === 0n) return null;
    const keyIndex = await this.indexOf(s.agentKey.root);
    if (keyIndex === null) return null;
    const p = await this.signedNow(s);
    return { nonce: s.agentKey.agentNonce, keyIndex, pending: p === null ? null : { action: p.action, params: p.params } };
  }

  /**
   * The agent spend that landed at agent nonce `slot.nonce`, decoded, when this seed signed it; null when none landed
   * there (the nonce also moves on a SetAgentKey or a revoke, with no spend) or another key's did (VaultService.signedAt
   * in agent mode). The landing is read from the vault's AgentSpent event at that nonce, and the spend from this seed's
   * record (here or in the escrow) whose message has that nonce and that next root: indexes do not follow the agent
   * nonce one for one (a new key jumps the index), so the slot's key index is not used.
   */
  async signedAt(slot: { nonce: bigint; keyIndex: bigint }): Promise<{ action: number; params: Hex } | null> {
    const head = await this.#p.logsClient.getBlockNumber();
    const spent = await getLogsChunked(this.#p.logsClient, { address: this.vault, event: v5Event("AgentSpent"), args: { nonce: slot.nonce }, fromBlock: await this.#v5From(), toBlock: head });
    const landed = spent[0];
    if (landed === undefined) return null;
    const next = (landed.args as { nextKeyRoot: Hex }).nextKeyRoot.toLowerCase();
    const mark = await this.#next();
    const match = (rec: { message: string } | undefined) => {
      if (rec === undefined) return null;
      const m = decodeAgentSpendMessage(hexToBytes(`0x${rec.message}`));
      return m.agentNonce === slot.nonce && m.vault === this.vault && m.chainId === this.#p.config.chainId && m.nextKeyRoot.toLowerCase() === next ? { action: m.action, params: m.params } : null;
    };
    // This device's records first, newest first (no request); the escrow's only when none of them is it (a restore).
    for (let i = mark - 1n; i >= 0n; i--) {
      const found = match(await this.#p.keys.store.load(this.#keychain.keychainId, i));
      if (found !== null) return found;
    }
    for (let i = mark - 1n; i >= 0n; i--) {
      const found = match(await this.#keychain.signed(i));
      if (found !== null) return found;
    }
    return null;
  }

  /**
   * The spend the key in force signed and that never landed, when it can land now (simulated with its own signature;
   * one that lands as a failure too: landing frees the key), else null when none waits. Throws AgentSpendHeldError
   * when one waits that cannot land now.
   */
  async pending(s: V5State, relayer: Address): Promise<PendingAgentSpend | null> {
    await this.#current(s);
    const p = await this.signedNow(s);
    if (p === null) return null;
    try {
      await simulateRelay(this.#p.client, { relayer, ...p.call });
      return p;
    } catch (err) {
      if (!(err instanceof RelaySimulationError) || !err.reverted) throw err;
      throw new AgentSpendHeldError(
        `the agent key in force signed a spend (action ${p.action}) that cannot land now (${err.message}), and a one-time key signs only once: it is sent again first as soon as it can land; nothing else is signed with this key until then. If it never can (the policy or the allowlist changed for good), the vault's owner installs a new agent key (agent_key_request, then agent_key_set)`,
      );
    }
  }

  /** What an agent spend of `action` counts against the policy, after checking its allowlists (OstraVaultModuleV5._agentAmount). */
  async #counted(s: V5State, action: number, params: Hex): Promise<bigint> {
    const need = async (kind: number, value: Hex, what: string) => {
      if (!(await readAllowEntry(this.#p.client, this.vault, kind, value)).inForce) throw new Error(`${what} is not on the vault's allowlist in force: ask the owner (allow_set); nothing was signed`);
    };
    const addr = (a: Address) => allowValue(ALLOW_KIND.RECIPIENT, a);
    const linked = async () => (await readVaultGuard(this.#p.client, this.vault)).linkedVault;
    switch (action) {
      case A.TRANSFER: {
        const t = decodeTransferParams(params);
        await need(ALLOW_KIND.RECIPIENT, addr(t.to), `the recipient ${t.to}`);
        return t.amount;
      }
      case A.OPEN_CHANNEL: {
        const o = decodeOpenChannelParams(params);
        await need(ALLOW_KIND.CHANNEL, allowValue(ALLOW_KIND.CHANNEL, o.receiver), `the channel receiver ${o.receiver}`);
        return o.amount;
      }
      case A.SWAP: {
        const w = decodeSwapParams(params);
        await need(ALLOW_KIND.POOL, allowValue(ALLOW_KIND.POOL, poolId(w.key)), `the pool ${poolId(w.key)}`);
        if (getAddress(w.recipient) !== this.vault) await need(ALLOW_KIND.RECIPIENT, addr(w.recipient), `the swap's recipient ${w.recipient}`);
        return w.amountIn;
      }
      case A.CLAIM_DIVIDEND: {
        const to = getAddress(decodeClaimDividendParams(params));
        if (to !== this.vault && to !== (await linked())) throw new Error("the agent key claims dividends only to the vault or its linked vault; nothing was signed");
        return 0n;
      }
      case A.LEND: {
        const l = decodeLendParams(params);
        await need(ALLOW_KIND.LEND, allowValue(ALLOW_KIND.LEND, l.vault), `the Morpho vault ${l.vault}`);
        return 0n;
      }
      case A.REDEEM: {
        const r = decodeRedeemParams(params);
        await need(ALLOW_KIND.LEND, allowValue(ALLOW_KIND.LEND, r.vault), `the Morpho vault ${r.vault}`);
        return 0n;
      }
      case A.REPAY: {
        const r = decodeRepayParams(params);
        if (getAddress(r.onBehalf) !== (await linked())) throw new Error("the agent key repays only the debt of the vault's linked vault; nothing was signed");
        return r.maxAssets;
      }
      case A.CANCEL_ORDER: {
        const id = BigInt(params);
        if (id === 0n) throw new Error("the agent key cancels one order at a time, never all; nothing was signed");
        const o = await readOrder(this.#p.client, this.vault, id);
        if (o.kind !== 0 && o.agentGen === 0) throw new Error(`order ${id} was set by the owner: only the owner cancels it; nothing was signed`);
        return 0n;
      }
      case A.PRIORS_BORROW: {
        // The fee leaves the vault however early the loan is repaid: at most the capped maximum fee counts.
        const amount = BigInt(`0x${params.slice(66, 130)}`);
        const term = BigInt(`0x${params.slice(130, 194)}`);
        const maxFee = BigInt(`0x${params.slice(194, 258)}`);
        const cap = (amount * BigInt(s.policy.maxFeeBps) * term) / (10_000n * 30n * 86_400n);
        return maxFee < cap ? maxFee : cap;
      }
      case A.ROOT_SPONSOR:
      case A.ROOT_VOUCH: {
        const agentId = BigInt(`0x${params.slice(66, 130)}`);
        await need(ALLOW_KIND.BORROWER, allowValue(ALLOW_KIND.BORROWER, agentId), `the borrower agent ${agentId}`);
        // What a default can burn (the line and its fee at the pool's longest term) is read by the simulation.
        return 0n;
      }
      case A.ROOT_FREEZE: {
        if (BigInt(`0x${params.slice(66, 130)}`) === 0n) throw new Error("the agent key may freeze a line, never reopen one; nothing was signed");
        return 0n;
      }
      default:
        return 0n;
    }
  }

  /** The checks of OstraVaultModuleV5.agent before anything is simulated or signed. */
  async check(s: V5State, action: number, params: Hex, what: string): Promise<bigint> {
    if (action < 0 || action > 63 || ((VAULT_AGENT_ACTIONS >> BigInt(action)) & 1n) === 0n) throw new Error(`${what} (action ${action}) is the vault owner's: an agent key never does it; nothing was signed`);
    if (!agentMayUse(s.policy, action)) throw new Error(`the vault's policy does not let the agent key ${what} (action ${action}): ask the owner (policy_set actions); nothing was signed`);
    const amount = await this.#counted(s, action, params);
    if (amount > s.policy.perTx) throw new Error(`${what} counts ${usdg(amount)}, above the policy's perTx of ${usdg(s.policy.perTx)}; nothing was signed`);
    if (amount > s.budgetAvailable) throw new Error(`${what} counts ${usdg(amount)}, and the policy's budget has ${usdg(s.budgetAvailable)} left now (it refills at ${usdg(s.policy.daily)} a day); nothing was signed`);
    return amount;
  }

  /**
   * The checks of `action` with `params` before anything else happens for it (a relayer channel opened to pay for it,
   * say): the key in force and the policy's rules (check). Nothing is signed.
   */
  async precheck(action: number, params: Hex, what: string): Promise<void> {
    const s = await this.state();
    await this.#current(s);
    await this.check(s, action, params, what);
  }

  /**
   * Signs the agent spend of `action` with `params` with the key in force, rotating to a fresh key: checked, then
   * simulated with a throwaway key, first. Throws when a spend it signed earlier waits (PendingAgentSpendError carries
   * it, to be sent first).
   */
  sign(action: number, params: Hex, what: string, relayer: Address): Promise<RelayCall> {
    return this.#serial(async () => {
      const s = await this.state();
      const waiting = await this.pending(s, relayer);
      if (waiting !== null) throw new PendingAgentSpendError(waiting);
      const index = await this.#current(s);
      await this.check(s, action, params, what);
      try {
        await simulateAgentSpend(this.#p.client, this.#p.config.deployment, { relayer, vault: this.vault, action, params });
      } catch (err) {
        if (err instanceof QuoteError) throw new QuoteError(err.code, `${what}: ${err.message}; nothing was signed`);
        throw err;
      }
      const v = await readVault(this.#p.client, this.#p.config.deployment, this.vault);
      if (v === null) throw new Error(`${this.vault} is not an Ostra vault`);
      // The next key is taken (and the mark moved past it) before signing: a crash after this never hands it out again.
      const next = await this.#take();
      const signed = await signAgentSpend(this.#keychain, { vault: this.vault, agentNonce: s.agentKey.agentNonce, keyRoot: s.agentKey.root, vaultKeyRoot: v.keyRoot, index, nextIndex: next }, { chainId: this.#p.config.chainId, action: action as VaultAction, params });
      return spendAsAgentCall(this.vault, signed);
    });
  }

  /**
   * The calls of an operation built as owner spends (with a throwaway owner key: VaultService in agent mode), each
   * spend signed again by the agent key instead (sign). One spend per operation: each rotates the agent key.
   */
  async convert(calls: readonly RelayCall[], what: string, relayer: Address): Promise<RelayCall[]> {
    const out: RelayCall[] = [];
    let spends = 0;
    for (const c of calls) {
      const spend = getAddress(c.to) === this.vault ? spendArgs(c.data) : null;
      if (spend === null) {
        out.push(c);
        continue;
      }
      if (++spends > 1) throw new Error(`${what} needs more than one vault spend in one transaction, which the agent key does not sign; nothing was signed`);
      out.push(await this.sign(spend.action, spend.params, what, relayer));
    }
    return out;
  }
}

/** A spend this agent key signed earlier waits: it is sent first (call), and the operation asked for is not. */
export class PendingAgentSpendError extends Error {
  readonly pending: PendingAgentSpend;
  constructor(pending: PendingAgentSpend) {
    super(`a spend the agent key signed earlier (action ${pending.action}) has not landed; it is sent first`);
    this.name = "PendingAgentSpendError";
    this.pending = pending;
  }
}

/** The action and params of a call of OstraVault.spend, or null for any other call. */
export function spendArgs(data: Hex): { action: number; params: Hex } | null {
  try {
    const d = decodeFunctionData({ abi: ostraVaultAbi as Abi, data });
    if (d.functionName !== "spend") return null;
    const args = d.args as readonly unknown[];
    return { action: Number(args[0]), params: args[2] as Hex };
  } catch {
    return null;
  }
}
