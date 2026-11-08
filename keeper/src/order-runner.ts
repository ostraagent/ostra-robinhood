// The standing-order and Priors-repay fallback (version 5; decided 8 Nov 2026): a vault's own MCP runs its standing
// orders and repays its Priors loans from its sweep, through the relayer and paid from the vault's own relayer channel
// (core v5.ts runDue). This keeper only stands in when that MCP is offline, free of charge, within hard limits, so that
// nobody can drain Ostra's ETH with orders that run forever (runOrder and repayDue pay their caller nothing, SWEEP and
// REFILL orders never run out, and anyone can create vaults):
//
//   * A grace before acting: an order only once it has been due for ORDER_GRACE_S (its own MCP runs it within a minute),
//     a loan only within KEEPER_REPAY_LEAD_S of its due time (its MCP repays from the policy's repay lead on).
//   * A global gas budget a day (DAILY_GAS_BUDGET), of which orders may use ORDER_GAS_BUDGET: the rest is kept for
//     repays all day (a loan left unpaid defaults and costs the vault its whole line; an order left unrun waits). A send
//     that fails after its simulation (a run front-run, a balance moved) is charged the gas it used when it reverted on
//     chain, else RUN_GAS_CAP: that order is left alone until the next day, a repay is tried again REPAY_RETRY_S later
//     (one failure never stops a vault's repays).
//   * What the limits do not stop: many vaults with small orders can use up ORDER_GAS_BUDGET each day (about 33 vaults
//     at 4 runs); orders then wait for their own MCP, while repays keep their share. It is a free fallback, not a service.
//   * At most MAX_RUNS_PER_VAULT_DAY order runs a vault a day, and only runs that move at least MIN_ORDER_AMOUNT (what a
//     SWEEP or REFILL moves now, from the vault's balance and threshold; a PAY order's amount).
//   * Every run is simulated from the fee payer first (a run that cannot happen reverts): nothing is sent that fails.
//   * Orders and loans are found from OrderSet and PriorsBorrowed events at the vaults' own addresses (from the version
//     5 upgrade's block on), kept only for vaults of the deployment's factory (sdk readVault); their state is read from
//     the vault each tick (order(id).live, ownLoan), so a cancelled order or a repaid loan is dropped.
//
// It sends OstraVault.runOrder(id) and OstraVault.repayDue(loanId) on Ostra vaults, and nothing else.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeFunctionData, getAddress, type AbiEvent, type Address, type Hash, type PublicClient } from "viem";
import {
  ORDER_KIND,
  PRIORS_LOAN_ACTIVE,
  ostraVaultAbi,
  ostraVaultModuleV5Abi,
  readOrder,
  readOwnLoan,
  readPriorsLoan,
  readV5,
  readVault,
  type Deployment,
} from "@ostraagent/sdk";

export const TICK_INTERVAL_MS = 60_000;
/** An order is run here only once it has been due this long (its own MCP runs it within a minute of being due). */
export const ORDER_GRACE_S = 30 * 60;
/** A loan is repaid here only this close to its due time (its own MCP repays from the policy's repay lead on). */
export const KEEPER_REPAY_LEAD_S = 6 * 3600;
/** The most gas the fallback uses a day (UTC): about 200 runs at 300,000 gas. */
export const DAILY_GAS_BUDGET = 60_000_000n;
/** The part of it orders may use; the rest is kept for repays. */
export const ORDER_GAS_BUDGET = 40_000_000n;
/** The most order runs of one vault a day. */
export const MAX_RUNS_PER_VAULT_DAY = 4;
/** The least an order moves a run for this keeper to run it (USDG base units: 5 USDG). */
export const MIN_ORDER_AMOUNT = 5_000_000n;
/** A repay whose send failed is tried again this much later. */
export const REPAY_RETRY_S = 10 * 60;
/** The most gas one run may be given. */
export const RUN_GAS_CAP = 4_000_000n;
/** Blocks the event cursor stays behind the head. */
export const RESCAN_BLOCKS = 3_000n;
const MAX_SPAN = 4_000_000n;
const MIN_SPAN = 10_000n;

type Kept = {
  toBlock: string;
  /** seenAt: when this keeper first read the order (unix seconds): an order never run is due from then. */
  orders: { vault: Address; id: string; seenAt: number }[];
  loans: { vault: Address; loanId: string }[];
  notVaults: Address[];
  day: string;
  gasToday: string;
  runsToday: Record<string, number>;
  /** Orders (vault:id) left alone for the rest of the day after a failed send. */
  failedToday?: string[];
  /** Repays (vault:loanId) whose send failed, and when they may be tried again (unix seconds). */
  repayRetryAt?: Record<string, number>;
};

export type RunResult = { kind: "repay" | "order"; vault: Address; id: string; tx?: Hash; gasUsed?: string; error?: string };

export type OrderRunnerParts = {
  client: PublicClient;
  logsClient: PublicClient;
  deployment: Deployment;
  /** The first block to read events from (the version 5 upgrade's block). */
  fromBlock: bigint;
  feePayer: Address;
  /**
   * Sends OstraVault.runOrder(id) or repayDue(id) on `vault` from the fee payer (simulated first), within `maxGas`:
   * its hash and gas, `reverted` when it landed and reverted. Throws when it was not sent, or its outcome is unknown.
   */
  send: (vault: Address, fn: "runOrder" | "repayDue", id: bigint, maxGas: bigint) => Promise<{ hash: Hash; gasUsed: bigint; reverted: boolean }>;
  dataDir: string;
  log: (event: string, fields: Record<string, unknown>) => void;
};

function v5Event(name: string): AbiEvent {
  const e = (ostraVaultModuleV5Abi as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === name);
  if (e === undefined) throw new Error(`OstraVaultModuleV5 has no event ${name}`);
  return e as unknown as AbiEvent;
}

const erc20BalanceAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;

const today = (nowS: number) => new Date(nowS * 1000).toISOString().slice(0, 10);

export class OrderRunner {
  readonly #p: OrderRunnerParts;
  #kept: Kept;
  #timer: NodeJS.Timeout | undefined;
  #busy = false;

  private constructor(p: OrderRunnerParts, kept: Kept) {
    this.#p = p;
    this.#kept = kept;
  }

  static async open(p: OrderRunnerParts): Promise<OrderRunner> {
    await mkdir(p.dataDir, { recursive: true, mode: 0o700 });
    let kept: Kept = { toBlock: (p.fromBlock - 1n).toString(), orders: [], loans: [], notVaults: [], day: "", gasToday: "0", runsToday: {} };
    try {
      kept = JSON.parse(await readFile(join(p.dataDir, "order-runner.json"), "utf8")) as Kept;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return new OrderRunner(p, kept);
  }

  get orders(): readonly { vault: Address; id: string; seenAt: number }[] {
    return this.#kept.orders;
  }

  get loans(): readonly { vault: Address; loanId: string }[] {
    return this.#kept.loans;
  }

  async #save(): Promise<void> {
    const file = join(this.#p.dataDir, "order-runner.json");
    await writeFile(`${file}.tmp`, JSON.stringify(this.#kept), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  async #logs(event: AbiEvent, from: bigint, to: bigint): Promise<{ address: Address; args: Record<string, unknown> }[]> {
    const out: { address: Address; args: Record<string, unknown> }[] = [];
    let a = from;
    let span = MAX_SPAN;
    while (a <= to) {
      const b = a + span - 1n > to ? to : a + span - 1n;
      try {
        const logs = await this.#p.logsClient.getLogs({ event, fromBlock: a, toBlock: b, strict: true });
        for (const l of logs) out.push({ address: getAddress(l.address), args: l.args as Record<string, unknown> });
        a = b + 1n;
        span = span * 2n > MAX_SPAN ? MAX_SPAN : span * 2n;
      } catch (e) {
        if (span === MIN_SPAN) throw e;
        span = span / 4n < MIN_SPAN ? MIN_SPAN : span / 4n;
      }
    }
    return out;
  }

  /** Reads OrderSet and PriorsBorrowed since the cursor and keeps those of Ostra vaults. */
  async refresh(): Promise<void> {
    const head = await this.#p.logsClient.getBlockNumber();
    const from = BigInt(this.#kept.toBlock) + 1n;
    if (from > head) return;
    const [sets, borrows] = await Promise.all([this.#logs(v5Event("OrderSet"), from, head), this.#logs(v5Event("PriorsBorrowed"), from, head)]);
    const notVaults = new Set(this.#kept.notVaults.map((v) => getAddress(v)));
    const isVault = async (a: Address) => {
      if (notVaults.has(a)) return false;
      if ((await readVault(this.#p.client, this.#p.deployment, a)) !== null) return true;
      notVaults.add(a);
      return false;
    };
    const orders = new Map(this.#kept.orders.map((o) => [`${o.vault}:${o.id}`, o]));
    const seenAt = Number((await this.#p.client.getBlock()).timestamp);
    for (const l of sets) {
      if (!(await isVault(l.address))) continue;
      const id = (l.args.id as bigint).toString();
      if (!orders.has(`${l.address}:${id}`)) orders.set(`${l.address}:${id}`, { vault: l.address, id, seenAt });
    }
    const loans = new Map(this.#kept.loans.map((o) => [`${o.vault}:${o.loanId}`, o]));
    for (const l of borrows) {
      if (!(await isVault(l.address))) continue;
      const loanId = (l.args.loanId as bigint).toString();
      loans.set(`${l.address}:${loanId}`, { vault: l.address, loanId });
    }
    const cursor = head - RESCAN_BLOCKS > BigInt(this.#kept.toBlock) ? head - RESCAN_BLOCKS : BigInt(this.#kept.toBlock);
    this.#kept = { ...this.#kept, toBlock: cursor.toString(), orders: [...orders.values()], loans: [...loans.values()], notVaults: [...notVaults] };
    await this.#save();
  }

  /** What a run of `order` moves now: a PAY order its amount, a SWEEP what is above its threshold, a REFILL what is below. */
  async #moves(vault: Address, order: { kind: number; amount: bigint; threshold: bigint }): Promise<bigint> {
    if (order.kind === ORDER_KIND.PAY) return order.amount;
    const balance = (await this.#p.client.readContract({ address: this.#p.deployment.token, abi: erc20BalanceAbi, functionName: "balanceOf", args: [vault] })) as bigint;
    const gap = order.kind === ORDER_KIND.SWEEP ? (balance > order.threshold ? balance - order.threshold : 0n) : balance < order.threshold ? order.threshold - balance : 0n;
    return gap < order.amount ? gap : order.amount;
  }

  /** What may run now and is due here: repays first, then orders; drops orders and loans that are gone. */
  async #due(now: bigint): Promise<{ kind: "repay" | "order"; vault: Address; id: bigint }[]> {
    const repays: { kind: "repay"; vault: Address; id: bigint }[] = [];
    const keepLoans: Kept["loans"] = [];
    for (const l of this.#kept.loans) {
      const id = BigInt(l.loanId);
      if (!(await readOwnLoan(this.#p.client, l.vault, id))) continue;
      keepLoans.push(l);
      const ln = await readPriorsLoan(this.#p.client, id);
      if (ln.status !== PRIORS_LOAN_ACTIVE) continue;
      if (now + BigInt(KEEPER_REPAY_LEAD_S) >= ln.dueAt) repays.push({ kind: "repay", vault: l.vault, id });
    }
    const runs: { kind: "order"; vault: Address; id: bigint }[] = [];
    const keepOrders: Kept["orders"] = [];
    for (const o of this.#kept.orders) {
      const id = BigInt(o.id);
      const order = await readOrder(this.#p.client, o.vault, id);
      if (!order.live) continue;
      keepOrders.push(o);
      if ((await this.#moves(o.vault, order)) < MIN_ORDER_AMOUNT) continue;
      // Due since its last run's interval passed, or, never run, since this keeper first read it; then the grace.
      const dueAt = order.lastRun === 0n ? BigInt(o.seenAt) : order.lastRun + BigInt(order.interval);
      if (now < dueAt + BigInt(ORDER_GRACE_S)) continue;
      runs.push({ kind: "order", vault: o.vault, id });
    }
    this.#kept = { ...this.#kept, loans: keepLoans, orders: keepOrders };
    return [...repays, ...runs];
  }

  /** One pass: what is due, within the day's gas budget and each vault's runs, simulated then sent. */
  async tick(): Promise<RunResult[]> {
    const nowS = Number((await this.#p.client.getBlock()).timestamp);
    const day = today(nowS);
    if (this.#kept.day !== day) this.#kept = { ...this.#kept, day, gasToday: "0", runsToday: {}, failedToday: [] };
    // Retries whose time has passed are dropped.
    this.#kept = { ...this.#kept, repayRetryAt: Object.fromEntries(Object.entries(this.#kept.repayRetryAt ?? {}).filter(([, at]) => at > nowS)) };
    const out: RunResult[] = [];
    for (const r of await this.#due(BigInt(nowS))) {
      let gasToday = BigInt(this.#kept.gasToday);
      const budget = r.kind === "repay" ? DAILY_GAS_BUDGET : ORDER_GAS_BUDGET;
      if (gasToday + RUN_GAS_CAP > budget) {
        this.#p.log("order_runner_budget_spent", { day, kind: r.kind, gasToday: gasToday.toString() });
        continue;
      }
      const vaultKey = r.vault.toLowerCase();
      const runKey = `${vaultKey}:${r.id}`;
      if (r.kind === "order" && (this.#kept.failedToday ?? []).includes(runKey)) continue;
      if (r.kind === "repay" && nowS < (this.#kept.repayRetryAt?.[runKey] ?? 0)) continue;
      if (r.kind === "order" && (this.#kept.runsToday[vaultKey] ?? 0) >= MAX_RUNS_PER_VAULT_DAY) continue;
      // Ostra vaults run version 5 for these to exist; still, a vault read as not version 5 is skipped.
      if ((await readV5(this.#p.client, r.vault)) === null) continue;
      const data = r.kind === "repay" ? encodeFunctionData({ abi: ostraVaultAbi, functionName: "repayDue", args: [r.id] }) : encodeFunctionData({ abi: ostraVaultAbi, functionName: "runOrder", args: [r.id] });
      try {
        await this.#p.client.call({ account: this.#p.feePayer, to: r.vault, data });
      } catch {
        continue; // it cannot run now (too early, nothing to do, out of policy): a run that fails reverts, never sent
      }
      const failed = (gas: bigint, error: string) => {
        gasToday += gas;
        // A failed order run counts as one of its vault's runs of the day too: many orders that fail cannot use the budget up.
        this.#kept =
          r.kind === "order"
            ? { ...this.#kept, gasToday: gasToday.toString(), failedToday: [...(this.#kept.failedToday ?? []), runKey], runsToday: { ...this.#kept.runsToday, [vaultKey]: (this.#kept.runsToday[vaultKey] ?? 0) + 1 } }
            : { ...this.#kept, gasToday: gasToday.toString(), repayRetryAt: { ...(this.#kept.repayRetryAt ?? {}), [runKey]: nowS + REPAY_RETRY_S } };
        out.push({ kind: r.kind, vault: r.vault, id: r.id.toString(), error });
        this.#p.log("order_runner_send_failed", { kind: r.kind, vault: r.vault, id: r.id.toString(), gas: gas.toString(), error });
      };
      try {
        const sent = await this.#p.send(r.vault, r.kind === "repay" ? "repayDue" : "runOrder", r.id, RUN_GAS_CAP);
        if (sent.reverted) {
          failed(sent.gasUsed, `the transaction ${sent.hash} reverted`);
          continue;
        }
        gasToday += sent.gasUsed;
        this.#kept = { ...this.#kept, gasToday: gasToday.toString(), runsToday: r.kind === "order" ? { ...this.#kept.runsToday, [vaultKey]: (this.#kept.runsToday[vaultKey] ?? 0) + 1 } : this.#kept.runsToday };
        out.push({ kind: r.kind, vault: r.vault, id: r.id.toString(), tx: sent.hash, gasUsed: sent.gasUsed.toString() });
        this.#p.log(r.kind === "repay" ? "repay_due_sent" : "order_run_sent", { vault: r.vault, id: r.id.toString(), tx: sent.hash, gasUsed: sent.gasUsed.toString() });
      } catch (err) {
        // Not sent, or its outcome unknown: charged as if it used the most it could, so that a run that passes its
        // simulation and then fails again and again never costs the fee payer more than the budget.
        failed(RUN_GAS_CAP, (err as Error).message);
      }
    }
    await this.#save();
    return out;
  }

  run(): void {
    const loop = async () => {
      if (this.#busy) return;
      this.#busy = true;
      try {
        await this.refresh();
        await this.tick();
      } catch (err) {
        this.#p.log("order_runner_tick_failed", { error: (err as Error).message });
      } finally {
        this.#busy = false;
      }
    };
    void loop();
    this.#timer = setInterval(() => void loop(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
