// Ostrapad's index (design "Ostrapad", decided by Edu on 26 and 27 Oct 2026): the agents with an Ostrapad listing and
// the jobs OstraPad holds, read from the chain, for the web app's dashboard and the MCP's pad_search. It holds no keys
// and nothing of any user's: what it serves is public chain data and the registration files agents published (data,
// never instructions). An order is still checked from the chain by the client before it is placed (core pad.ts).
//
//   agents    every ERC-8004 identity an Ostra vault of the deployment registered (the vault's AgentRegistered event,
//             found by its topic and kept only when the emitter is an Ostra vault); each one's registration file
//             (tokenURI) is read again every DETAILS_EVERY_MS, its Ostrapad listing parsed (sdk padListingFromFile),
//             and the listing kept only when the provider vault approved it (padListingDigest, EIP-1271)
//   jobs      OstraPad's events from its deployment block: created, accepted, submitted, decided, completed, rejected,
//             expired, cancelled, paid and refunded
//   records   each provider's record and limit as OstraPad holds it (provider(), limitOf)
//
// Ranking (design "Dashboard"): distinct paying clients, then completed jobs, then value completed.
//
// The board (the web app's Ostrapad page, design "Dashboard", decided by Edu on 31 Oct 2026): the listed agents and
// the jobs, leaving out entirely every agent and job of an account in the hidden list (Ostra's own vaults: its test
// agents and its own agent; the list lives on the server, never in this repository). Each agent's figures come from
// its jobs as the index read them: completed jobs, distinct paying clients, success and rejection rates, time to
// deliver, USDG earned; with its record and limit as OstraPad holds them, and how old its provider vault is. Each
// client's rejection rate is the share of the jobs it judged itself that it rejected. Without a readable hidden list
// the board is not served (it never shows what it should leave out).
//
// The logs are read up to the logs RPC's own head (the other RPC's head can be ahead of the blocks the logs RPC has:
// those blocks would be passed over for good), and the last RESCAN_BLOCKS are read again on the next pass, as the
// evaluator bot does (keeper pad-evaluator.ts); reading a block again gives the same state. A state of version 1
// (scanned to the other RPC's head) is read again from the start, once.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { getAddress, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import {
  ERC8004_IDENTITY_REGISTRY,
  OSTRAPAD,
  OSTRAPAD_FROM_BLOCK,
  PAD_EVENTS,
  getLogsChunked,
  identityRegistryAbi,
  padListingDigest,
  padListingFromFile,
  readPadProvider,
  readVault,
  type Deployment,
  type PadOffer,
  vaultCreatedEvent,
} from "@ostraagent/sdk";

const agentRegisteredEvent = parseAbiItem("event AgentRegistered(uint256 indexed agentId)");
const tokenUriAbi = [{ type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "string" }] }] as const;
const erc1271Abi = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }] }] as const;
const EIP1271_MAGIC = "0x1626ba7e";

const WINDOW_START = 200_000n;
const WINDOW_MIN = 500n;
const WINDOW_MAX = 2_000_000n;
/** How often an agent's registration file, listing approval and record are read again. */
export const DETAILS_EVERY_MS = 5 * 60_000;
/** Agents read again in one sync, at most. */
const DETAILS_PER_SYNC = 20;
/** The blocks read again on the next pass (5 minutes at 10 blocks a second). */
export const RESCAN_BLOCKS = 3_000n;
const MAX_JOBS = 20_000;

export type PadJobRow = {
  id: Hex;
  client: Address;
  provider: Address;
  evaluator: Address | null;
  pool: boolean;
  funded: string;
  status: string;
  createdAt: number;
  createdBlock: string;
  updatedAt: number;
  paid: string | null;
  refunded: string | null;
  /** When the provider accepted it, delivered it (the last delivery) and when it ended (completed, rejected, expired
   *  or cancelled): block times, null until then. */
  acceptedAt: number | null;
  submittedAt: number | null;
  closedAt: number | null;
};

export type PadAgent = {
  agentId: string;
  /** The Ostra vault that registered it and owns it. */
  owner: Address;
  registeredBlock: string;
  uri: string | null;
  name: string | null;
  description: string | null;
  image: string | null;
  provider: Address | null;
  approved: boolean;
  offers: PadOffer[];
  problems: string[];
  record: { completed: number; rejected: number; expired: number; clients: number; volume: string; bond: string; active: number; fixedCompleted: number; limit: string } | null;
  /** The provider vault's creation (the factory's VaultCreated): its block time (null: none found), for the vault it
   *  was read for. */
  providerCreated: { vault: Address; at: number | null } | null;
  readAt: number;
};

export type PadIndexState = { version: 3; chainId: number; pad: Address; scannedTo: string; vaultsScannedTo: string; agents: Record<string, PadAgent>; jobs: Record<Hex, PadJobRow> };

/** A job on the board: who judges it as a kind, not as an address (the judge's account is not the board's to show). */
export type PadBoardJob = Omit<PadJobRow, "createdBlock" | "updatedAt" | "evaluator"> & { judgedBy: "pool" | "client" | "fixed"; agentId: string | null; agentName: string | null };

/** An agent on the board: its listing and the figures its jobs give. */
export type PadBoardAgent = {
  agentId: string;
  name: string | null;
  description: string | null;
  owner: Address;
  provider: Address;
  offers: PadOffer[];
  /** The lowest price among its offers. */
  priceFrom: string;
  completed: number;
  rejected: number;
  /** Jobs it accepted that expired undelivered (one delivered and left unjudged is not counted against it). */
  expired: number;
  /** Jobs accepted and not ended yet. */
  inProgress: number;
  /** Distinct clients of its completed jobs. */
  clients: number;
  /** USDG paid to its vault for completed jobs. */
  earned: string;
  /** Completed (rejected) jobs over those that ended after it accepted them; null before any. */
  successRate: number | null;
  rejectionRate: number | null;
  /** Mean seconds from acceptance to delivery; null before any delivery. */
  deliverySeconds: number | null;
  lastJobAt: number | null;
  record: PadAgent["record"];
  /** Block time of its provider vault's creation; null when not read yet. */
  providerSince: number | null;
  registeredBlock: string;
};

export type PadBoardClient = {
  client: Address;
  /** Jobs it ordered from this agent, and how they ended. */
  orders: number;
  completed: number;
  rejected: number;
  /** Over all its jobs on the board: the share of those it judged itself that it rejected; null before any. */
  rejectionRate: number | null;
  judged: number;
};

export type PadBoardStats = { listed: number; jobs: number; completed: number; valueCompleted: string; clients: number; scannedTo: string };

function usd(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

function units(text: string | null): bigint {
  if (text === null) return 0n;
  const [w, f = ""] = text.split(".");
  return BigInt(w as string) * 1_000_000n + BigInt(f.padEnd(6, "0").slice(0, 6));
}

function text(file: unknown, key: string, max: number): string | null {
  if (file === null || typeof file !== "object") return null;
  const v = (file as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;
}

const lower = (a: string) => a.toLowerCase();

export class PadIndexer {
  readonly #client: PublicClient;
  readonly #logs: PublicClient;
  readonly #deployment: () => Deployment;
  readonly #statePath: string;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  readonly #readFile: (uri: string) => Promise<unknown>;
  readonly #pad: Address;
  readonly #hidden: () => ReadonlySet<string> | null;
  #state: PadIndexState;
  #window = WINDOW_START;
  #vaultWindow = WINDOW_START;
  #ostraVault = new Map<Address, boolean>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  /**
   * `hidden`: the accounts the board leaves out (lower case), read when the board is served; null while the list
   * cannot be read. Without it, or while it is null, the board is not served.
   */
  constructor(o: { client: PublicClient; logsClient?: PublicClient; deployment: () => Deployment; statePath: string; log: (event: string, fields?: Record<string, unknown>) => void; readFile: (uri: string) => Promise<unknown>; pad?: Address; hidden?: () => ReadonlySet<string> | null }) {
    this.#client = o.client;
    this.#logs = o.logsClient ?? o.client;
    this.#deployment = o.deployment;
    this.#statePath = o.statePath;
    this.#log = o.log;
    this.#readFile = o.readFile;
    this.#pad = getAddress(o.pad ?? OSTRAPAD);
    this.#hidden = o.hidden ?? (() => null);
    const d = o.deployment();
    const fresh: PadIndexState = { version: 3, chainId: d.chainId, pad: this.#pad, scannedTo: (OSTRAPAD_FROM_BLOCK - 1n).toString(), vaultsScannedTo: (BigInt(d.fromBlock) - 1n).toString(), agents: {}, jobs: {} };
    if (existsSync(this.#statePath)) {
      const saved = JSON.parse(readFileSync(this.#statePath, "utf8")) as { version: number; chainId: number; pad: Address } & Omit<PadIndexState, "version">;
      const same = saved.chainId === d.chainId && getAddress(saved.pad) === this.#pad;
      if (same && saved.version === 3) this.#state = saved as PadIndexState;
      // Version 2 kept no job times: its jobs are read again from OstraPad's first block (its agents stay).
      else if (same && saved.version === 2) this.#state = { ...fresh, vaultsScannedTo: saved.vaultsScannedTo, agents: Object.fromEntries(Object.entries(saved.agents).map(([k, a]) => [k, { ...a, providerCreated: null }])) };
      else this.#state = fresh;
    } else {
      this.#state = fresh;
    }
  }

  #save(): void {
    const tmp = `${this.#statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#state), { mode: 0o600 });
    renameSync(tmp, this.#statePath);
  }

  async #isOstraVault(a: Address): Promise<boolean> {
    const known = this.#ostraVault.get(a);
    if (known !== undefined) return known;
    // Only an answer is kept: a failed read throws, and the pass (with its window) is tried again.
    const v = (await readVault(this.#client, this.#deployment(), a)) !== null;
    this.#ostraVault.set(a, v);
    return v;
  }

  /** One pass: new agents and jobs from the logs, then some agents' files and records read again. */
  async sync(): Promise<void> {
    const latest = await this.#logs.getBlockNumber({ cacheTime: 0 });
    // Each pass starts RESCAN_BLOCKS back from the head at most (never before where the scan began).
    const back = (scannedTo: string, start: bigint) => {
      const next = BigInt(scannedTo) + 1n;
      const floor = latest + 1n - RESCAN_BLOCKS;
      return next > floor && floor > start ? floor : next;
    };
    const d = this.#deployment();
    let changed = false;
    // Agents: AgentRegistered of Ostra vaults, by its topic.
    let from = back(this.#state.vaultsScannedTo, BigInt(d.fromBlock));
    while (from <= latest) {
      const to = from + this.#vaultWindow - 1n < latest ? from + this.#vaultWindow - 1n : latest;
      try {
        const logs = await this.#logs.getLogs({ event: agentRegisteredEvent, fromBlock: from, toBlock: to });
        for (const l of logs) {
          const owner = getAddress(l.address);
          if (!(await this.#isOstraVault(owner))) continue;
          const id = (l.args as { agentId: bigint }).agentId.toString();
          if (this.#state.agents[id] === undefined) {
            this.#state.agents[id] = { agentId: id, owner, registeredBlock: l.blockNumber.toString(), uri: null, name: null, description: null, image: null, provider: null, approved: false, offers: [], problems: [], record: null, providerCreated: null, readAt: 0 };
            changed = true;
          }
        }
      } catch (err) {
        if (this.#vaultWindow <= WINDOW_MIN) throw err;
        this.#vaultWindow = this.#vaultWindow / 2n < WINDOW_MIN ? WINDOW_MIN : this.#vaultWindow / 2n;
        continue;
      }
      this.#state.vaultsScannedTo = to.toString();
      from = to + 1n;
      if (this.#vaultWindow < WINDOW_MAX) this.#vaultWindow = this.#vaultWindow * 2n > WINDOW_MAX ? WINDOW_MAX : this.#vaultWindow * 2n;
    }
    // Jobs: OstraPad's events.
    from = back(this.#state.scannedTo, OSTRAPAD_FROM_BLOCK);
    while (from <= latest) {
      const to = from + this.#window - 1n < latest ? from + this.#window - 1n : latest;
      try {
        changed = (await this.#scanJobs(from, to)) || changed;
      } catch (err) {
        if (this.#window <= WINDOW_MIN) throw err;
        this.#window = this.#window / 2n < WINDOW_MIN ? WINDOW_MIN : this.#window / 2n;
        this.#log("pad_window_shrunk", { window: this.#window.toString(), reason: (err as Error).message.slice(0, 200) });
        continue;
      }
      this.#state.scannedTo = to.toString();
      from = to + 1n;
      if (this.#window < WINDOW_MAX) this.#window = this.#window * 2n > WINDOW_MAX ? WINDOW_MAX : this.#window * 2n;
    }
    // Agents' files, approvals and records, the oldest read first.
    const due = Object.values(this.#state.agents)
      .filter((a) => Date.now() - a.readAt >= DETAILS_EVERY_MS)
      .sort((a, b) => a.readAt - b.readAt)
      .slice(0, DETAILS_PER_SYNC);
    for (const a of due) {
      try {
        await this.#readAgent(a);
        changed = true;
      } catch (err) {
        this.#log("pad_agent_read_failed", { agentId: a.agentId, reason: (err as Error).message.slice(0, 200) });
      }
    }
    if (changed) this.#save();
  }

  async #scanJobs(from: bigint, to: bigint): Promise<boolean> {
    let changed = false;
    const get = (event: (typeof PAD_EVENTS)[keyof typeof PAD_EVENTS]) => this.#logs.getLogs({ address: this.#pad, event: event as never, fromBlock: from, toBlock: to }) as Promise<{ args: Record<string, unknown>; blockNumber: bigint; logIndex: number }[]>;
    const times = new Map<bigint, number>();
    const time = async (b: bigint) => {
      let t = times.get(b);
      if (t === undefined) {
        // The logs RPC's head can be ahead of this node's: a block it does not have yet is read from the logs RPC.
        t = Number((await this.#client.getBlock({ blockNumber: b }).catch(() => this.#logs.getBlock({ blockNumber: b }))).timestamp);
        times.set(b, t);
      }
      return t;
    };
    const [created, funded, accepted, submitted, decided, completed, rejected, expired, cancelled, paid, refunded, drawn, appealed] = await Promise.all([
      get(PAD_EVENTS.JobCreated),
      get(PAD_EVENTS.JobFunded),
      get(PAD_EVENTS.JobAccepted),
      get(PAD_EVENTS.JobSubmitted),
      get(PAD_EVENTS.Decided),
      get(PAD_EVENTS.JobCompleted),
      get(PAD_EVENTS.JobRejected),
      get(PAD_EVENTS.JobExpired),
      get(PAD_EVENTS.JobCancelled),
      get(PAD_EVENTS.PaymentReleased),
      get(PAD_EVENTS.Refunded),
      get(PAD_EVENTS.EvaluatorDrawn),
      get(PAD_EVENTS.AppealOpened),
    ]);
    for (const l of created) {
      const a = l.args as { jobId: Hex; client: Address; provider: Address; evaluator: Address };
      // A job read in an earlier pass (the last RESCAN_BLOCKS are read again) keeps what its later events set.
      if (this.#state.jobs[a.jobId] !== undefined) continue;
      const t = await time(l.blockNumber);
      const pool = BigInt(a.evaluator) === 0n;
      this.#state.jobs[a.jobId] = { id: a.jobId, client: getAddress(a.client), provider: getAddress(a.provider), evaluator: pool ? null : getAddress(a.evaluator), pool, funded: "0", status: "Open", createdAt: t, createdBlock: l.blockNumber.toString(), updatedAt: t, paid: null, refunded: null, acceptedAt: null, submittedAt: null, closedAt: null };
      changed = true;
    }
    // Later events of a window, in log order, move a job's status along (a window holds whole blocks).
    const events: { kind: string; l: { args: Record<string, unknown>; blockNumber: bigint; logIndex: number } }[] = [
      ...funded.map((l) => ({ kind: "funded", l })),
      ...accepted.map((l) => ({ kind: "Accepted", l })),
      ...submitted.map((l) => ({ kind: "Submitted", l })),
      ...decided.map((l) => ({ kind: "Decided", l })),
      ...completed.map((l) => ({ kind: "Completed", l })),
      ...rejected.map((l) => ({ kind: "Rejected", l })),
      ...expired.map((l) => ({ kind: "Expired", l })),
      ...cancelled.map((l) => ({ kind: "Cancelled", l })),
      ...paid.map((l) => ({ kind: "paid", l })),
      ...refunded.map((l) => ({ kind: "refunded", l })),
      ...drawn.map((l) => ({ kind: "drawn", l })),
      ...appealed.map((l) => ({ kind: "Appealed", l })),
    ].sort((x, y) => (x.l.blockNumber === y.l.blockNumber ? x.l.logIndex - y.l.logIndex : x.l.blockNumber < y.l.blockNumber ? -1 : 1));
    for (const { kind, l } of events) {
      const id = l.args.jobId as Hex;
      const j = this.#state.jobs[id];
      if (j === undefined) continue;
      const at = await time(l.blockNumber);
      j.updatedAt = at;
      if (kind === "funded") j.funded = usd(l.args.amount as bigint);
      else if (kind === "paid") j.paid = usd(l.args.amount as bigint);
      else if (kind === "refunded") j.refunded = usd(l.args.amount as bigint);
      else if (kind === "drawn") j.evaluator = getAddress(l.args.evaluator as Address);
      // A cancel emits JobRejected too: Cancelled stands.
      else if (!(kind === "Rejected" && j.status === "Cancelled")) {
        j.status = kind;
        if (kind === "Accepted") j.acceptedAt = at;
        else if (kind === "Submitted") j.submittedAt = at;
        else if (kind === "Completed" || kind === "Rejected" || kind === "Expired" || kind === "Cancelled") j.closedAt = at;
      }
      changed = true;
    }
    const ids = Object.keys(this.#state.jobs) as Hex[];
    if (ids.length > MAX_JOBS) for (const id of ids.slice(0, ids.length - MAX_JOBS)) delete this.#state.jobs[id];
    return changed;
  }

  async #readAgent(a: PadAgent): Promise<void> {
    a.readAt = Date.now();
    const id = BigInt(a.agentId);
    const owner = getAddress((await this.#client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] })) as Address);
    a.owner = owner;
    // An identity moved to an account that is not an Ostra vault is no longer listed.
    if (!(await this.#isOstraVault(owner))) {
      a.provider = null;
      a.approved = false;
      a.offers = [];
      a.problems = ["the identity's owner is not an Ostra vault"];
      a.record = null;
      return;
    }
    a.uri = (await this.#client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: tokenUriAbi, functionName: "tokenURI", args: [id] })) as string;
    const file = await this.#readFile(a.uri);
    a.name = text(file, "name", 64);
    a.description = text(file, "description", 1_000);
    a.image = text(file, "image", 200);
    const found = file === null ? null : padListingFromFile(file, this.#pad, this.#deployment().chainId);
    if (found === null) {
      a.provider = null;
      a.approved = false;
      a.offers = [];
      a.problems = [];
      a.record = null;
      return;
    }
    a.provider = found.listing.provider;
    a.offers = found.listing.offers;
    a.problems = found.problems;
    const digest = padListingDigest(id, owner, this.#pad, this.#deployment().chainId);
    let approved = false;
    try {
      approved = ((await this.#client.readContract({ address: found.listing.provider, abi: erc1271Abi, functionName: "isValidSignature", args: [digest, "0x"] })) as string).toLowerCase() === EIP1271_MAGIC;
    } catch {
      approved = false;
    }
    a.approved = approved;
    const r = await readPadProvider(this.#client, found.listing.provider, this.#pad);
    a.record = { completed: r.completed, rejected: r.rejected, expired: r.expired, clients: r.clients, volume: usd(r.volume), bond: usd(r.bond), active: r.active, fixedCompleted: r.fixedCompleted, limit: usd(r.limit) };
    // Read once per provider vault, found or not.
    if (a.providerCreated?.vault !== found.listing.provider) a.providerCreated = { vault: found.listing.provider, at: await this.#vaultCreatedAt(found.listing.provider) };
  }

  /** The block time of `vault`'s creation by the deployment's factory (VaultCreated, indexed by vault); null if none. */
  async #vaultCreatedAt(vault: Address): Promise<number | null> {
    const d = this.#deployment();
    const logs = await getLogsChunked(this.#logs, { address: d.vaultFactory, event: vaultCreatedEvent, args: { vault }, fromBlock: BigInt(d.fromBlock), toBlock: await this.#logs.getBlockNumber({ cacheTime: 0 }), minSpan: 100_000n });
    const first = logs[0];
    if (first === undefined) return null;
    const block = await this.#client.getBlock({ blockNumber: first.blockNumber }).catch(() => this.#logs.getBlock({ blockNumber: first.blockNumber }));
    return Number(block.timestamp);
  }

  /** Runs sync every `everyMs` until stop(); a failed pass is logged and the next one tried. */
  start(everyMs: number): void {
    this.#running = true;
    const tick = async () => {
      try {
        await this.sync();
      } catch (err) {
        this.#log("pad_sync_failed", { reason: (err as Error).message.slice(0, 300) });
      }
      if (this.#running) this.#timer = setTimeout(() => void tick(), everyMs);
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
  }

  /** Listed agents (an approved listing with offers), ranked; `q` matches their name, description and offers. */
  listings(o: { q?: string; provider?: Address; limit?: number; offset?: number } = {}): { total: number; agents: Omit<PadAgent, "problems" | "readAt">[] } {
    const q = (o.q ?? "").trim().toLowerCase();
    const provider = o.provider === undefined ? null : getAddress(o.provider);
    const listed = Object.values(this.#state.agents).filter((a) => a.approved && a.provider !== null && a.offers.length > 0 && (provider === null || a.provider === provider));
    const matched = q === "" ? listed : listed.filter((a) => [a.name, a.description, ...a.offers.flatMap((f) => [f.id, f.title, f.description])].some((t) => t !== null && t.toLowerCase().includes(q)));
    const ranked = matched.sort((x, y) => (y.record?.clients ?? 0) - (x.record?.clients ?? 0) || (y.record?.completed ?? 0) - (x.record?.completed ?? 0) || Number(y.record?.volume ?? 0) - Number(x.record?.volume ?? 0) || Number(x.agentId) - Number(y.agentId));
    const offset = o.offset ?? 0;
    const limit = o.limit ?? 20;
    return { total: ranked.length, agents: ranked.slice(offset, offset + limit).map(({ problems: _p, readAt: _r, ...rest }) => rest) };
  }

  /** One agent (listed or not) and its recent jobs as a provider. */
  agent(agentId: string): (PadAgent & { jobs: PadJobRow[] }) | null {
    const a = this.#state.agents[agentId];
    if (a === undefined) return null;
    const jobs = a.provider === null ? [] : Object.values(this.#state.jobs).filter((j) => j.provider === a.provider).sort((x, y) => y.createdAt - x.createdAt).slice(0, 50);
    return { ...a, jobs };
  }

  /** Recent jobs, newest first. */
  jobs(o: { limit?: number } = {}): PadJobRow[] {
    return Object.values(this.#state.jobs).sort((x, y) => y.createdAt - x.createdAt).slice(0, o.limit ?? 50);
  }

  stats(): { agents: number; listed: number; jobs: number; completed: number; valueCompleted: string; scannedTo: string } {
    const jobs = Object.values(this.#state.jobs);
    const completed = jobs.filter((j) => j.status === "Completed");
    const value = completed.reduce((s, j) => s + units(j.paid), 0n);
    return { agents: Object.keys(this.#state.agents).length, listed: this.listings({ limit: 10_000 }).total, jobs: jobs.length, completed: completed.length, valueCompleted: usd(value), scannedTo: this.#state.scannedTo };
  }

  /** What the board shows: the listed agents and the jobs, without any account of the hidden list; null without it. */
  #board(): { agents: PadAgent[]; jobs: PadJobRow[] } | null {
    const hidden = this.#hidden();
    if (hidden === null) return null;
    const seen = (a: string | null) => a === null || !hidden.has(lower(a));
    // An agent whose owner is hidden takes its provider vault's jobs with it.
    const away = new Set(Object.values(this.#state.agents).filter((a) => !seen(a.owner) && a.provider !== null).map((a) => lower(a.provider as string)));
    const agents = Object.values(this.#state.agents).filter((a) => a.approved && a.provider !== null && a.offers.length > 0 && seen(a.owner) && seen(a.provider));
    const jobs = Object.values(this.#state.jobs).filter((j) => seen(j.client) && seen(j.provider) && !away.has(lower(j.provider)));
    return { agents, jobs };
  }

  static #figures(a: PadAgent, jobs: PadJobRow[]): PadBoardAgent {
    const mine = jobs.filter((j) => j.provider === a.provider);
    const completed = mine.filter((j) => j.status === "Completed");
    const rejected = mine.filter((j) => j.status === "Rejected").length;
    // An order nobody accepted that expired, one cancelled, or one delivered and never judged before it expired says
    // nothing against the provider's work.
    const expired = mine.filter((j) => j.status === "Expired" && j.acceptedAt !== null && j.submittedAt === null).length;
    const ended = completed.length + rejected + expired;
    const delivered = mine.filter((j) => j.acceptedAt !== null && j.submittedAt !== null && j.submittedAt >= j.acceptedAt);
    const prices = a.offers.map((f) => units(f.price));
    const from = prices.reduce((m, p) => (p < m ? p : m), prices[0] as bigint);
    return {
      agentId: a.agentId,
      name: a.name,
      description: a.description,
      owner: a.owner,
      provider: a.provider as Address,
      offers: a.offers,
      priceFrom: usd(from),
      completed: completed.length,
      rejected,
      expired,
      inProgress: mine.filter((j) => j.acceptedAt !== null && j.closedAt === null).length,
      clients: new Set(completed.map((j) => j.client)).size,
      earned: usd(completed.reduce((s, j) => s + units(j.paid), 0n)),
      successRate: ended === 0 ? null : completed.length / ended,
      rejectionRate: ended === 0 ? null : rejected / ended,
      deliverySeconds: delivered.length === 0 ? null : Math.round(delivered.reduce((s, j) => s + ((j.submittedAt as number) - (j.acceptedAt as number)), 0) / delivered.length),
      lastJobAt: mine.reduce<number | null>((m, j) => (m === null || j.createdAt > m ? j.createdAt : m), null),
      record: a.record,
      providerSince: a.providerCreated !== null && a.providerCreated.vault === a.provider ? a.providerCreated.at : null,
      registeredBlock: a.registeredBlock,
    };
  }

  static #boardJob(j: PadJobRow, byProvider: Map<Address, PadAgent>): PadBoardJob {
    const { createdBlock: _b, updatedAt: _u, evaluator, ...rest } = j;
    const a = byProvider.get(j.provider);
    return { ...rest, judgedBy: j.pool ? "pool" : evaluator === j.client ? "client" : "fixed", agentId: a?.agentId ?? null, agentName: a?.name ?? null };
  }

  /** The board's agents, ranked as listings() ranks them but by the figures of their shown jobs; null without the hidden list. */
  board(o: { q?: string; limit?: number; offset?: number } = {}): { stats: PadBoardStats; total: number; agents: PadBoardAgent[] } | null {
    const b = this.#board();
    if (b === null) return null;
    const q = (o.q ?? "").trim().toLowerCase();
    const matched = q === "" ? b.agents : b.agents.filter((a) => [a.name, a.description, ...a.offers.flatMap((f) => [f.id, f.title, f.description])].some((t) => t !== null && t.toLowerCase().includes(q)));
    const ranked = matched
      .map((a) => PadIndexer.#figures(a, b.jobs))
      .sort((x, y) => y.clients - x.clients || y.completed - x.completed || Number(units(y.earned) - units(x.earned)) || Number(x.agentId) - Number(y.agentId));
    const done = b.jobs.filter((j) => j.status === "Completed");
    const stats: PadBoardStats = {
      listed: b.agents.length,
      jobs: b.jobs.length,
      completed: done.length,
      valueCompleted: usd(done.reduce((s, j) => s + units(j.paid), 0n)),
      clients: new Set(done.map((j) => j.client)).size,
      scannedTo: this.#state.scannedTo,
    };
    const offset = o.offset ?? 0;
    const limit = o.limit ?? 20;
    return { stats, total: ranked.length, agents: ranked.slice(offset, offset + limit) };
  }

  /**
   * One agent of the board, its jobs (newest first, 50 at most) and its clients with their rejection rates; undefined
   * when the board does not show it, null without the hidden list.
   */
  boardAgent(agentId: string): (PadBoardAgent & { jobs: PadBoardJob[]; clientsOf: PadBoardClient[] }) | undefined | null {
    const b = this.#board();
    if (b === null) return null;
    const a = b.agents.find((x) => x.agentId === agentId);
    if (a === undefined) return undefined;
    const byProvider = new Map(b.agents.map((x) => [x.provider as Address, x]));
    const mine = b.jobs.filter((j) => j.provider === a.provider).sort((x, y) => y.createdAt - x.createdAt);
    // Each client's own judging, over all its shown jobs: the jobs it judged (client-judged, ended Completed or Rejected).
    const judging = new Map<Address, { judged: number; rejected: number }>();
    for (const j of b.jobs) {
      if (j.pool || j.evaluator !== j.client || (j.status !== "Completed" && j.status !== "Rejected")) continue;
      const c = judging.get(j.client) ?? { judged: 0, rejected: 0 };
      c.judged += 1;
      if (j.status === "Rejected") c.rejected += 1;
      judging.set(j.client, c);
    }
    const clients = new Map<Address, PadBoardClient>();
    for (const j of mine) {
      const own = judging.get(j.client) ?? { judged: 0, rejected: 0 };
      const c = clients.get(j.client) ?? { client: j.client, orders: 0, completed: 0, rejected: 0, judged: own.judged, rejectionRate: own.judged === 0 ? null : own.rejected / own.judged };
      c.orders += 1;
      if (j.status === "Completed") c.completed += 1;
      if (j.status === "Rejected") c.rejected += 1;
      clients.set(j.client, c);
    }
    return {
      ...PadIndexer.#figures(a, b.jobs),
      jobs: mine.slice(0, 50).map((j) => PadIndexer.#boardJob(j, byProvider)),
      clientsOf: [...clients.values()].sort((x, y) => y.orders - x.orders || (x.client < y.client ? -1 : 1)),
    };
  }

  /** The board's recent jobs, newest first; null without the hidden list. */
  boardJobs(o: { limit?: number } = {}): PadBoardJob[] | null {
    const b = this.#board();
    if (b === null) return null;
    const byProvider = new Map(b.agents.map((x) => [x.provider as Address, x]));
    return b.jobs
      .sort((x, y) => y.createdAt - x.createdAt)
      .slice(0, o.limit ?? 50)
      .map((j) => PadIndexer.#boardJob(j, byProvider));
  }
}

/**
 * The hidden list of the board from files (OSTRA_PAD_HIDE in main.ts): an address at the start of each line counts,
 * anything else is ignored. The files are read again when one changes; while one cannot be read (missing,
 * unreadable), the list is null and the board is not served.
 */
export function hiddenListFromFiles(paths: string[], log: (event: string, fields?: Record<string, unknown>) => void): () => ReadonlySet<string> | null {
  let key = "";
  let set: ReadonlySet<string> | null = null;
  return () => {
    let next: string;
    try {
      next = paths.map((p) => `${p}:${statSync(p).mtimeMs}:${statSync(p).size}`).join("|");
    } catch (err) {
      if (set !== null || key !== "missing") log("pad_hidden_unreadable", { reason: (err as Error).message.slice(0, 200) });
      key = "missing";
      set = null;
      return null;
    }
    if (next === key) return set;
    try {
      const out = new Set<string>();
      for (const p of paths) {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          const m = /^\s*(0x[0-9a-fA-F]{40})\b/.exec(line);
          if (m) out.add(lower(m[1] as string));
        }
      }
      set = out;
      key = next;
      log("pad_hidden_read", { files: paths.length, accounts: out.size });
    } catch (err) {
      log("pad_hidden_unreadable", { reason: (err as Error).message.slice(0, 200) });
      key = "missing";
      set = null;
    }
    return set;
  };
}
