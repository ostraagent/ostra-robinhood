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
// The logs are read up to the logs RPC's own head (the other RPC's head can be ahead of the blocks the logs RPC has:
// those blocks would be passed over for good), and the last RESCAN_BLOCKS are read again on the next pass, as the
// evaluator bot does (keeper pad-evaluator.ts); reading a block again gives the same state. A state of version 1
// (scanned to the other RPC's head) is read again from the start, once.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getAddress, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import {
  ERC8004_IDENTITY_REGISTRY,
  OSTRAPAD,
  OSTRAPAD_FROM_BLOCK,
  PAD_EVENTS,
  identityRegistryAbi,
  padListingDigest,
  padListingFromFile,
  readPadProvider,
  readVault,
  type Deployment,
  type PadOffer,
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
  readAt: number;
};

export type PadIndexState = { version: 2; chainId: number; pad: Address; scannedTo: string; vaultsScannedTo: string; agents: Record<string, PadAgent>; jobs: Record<Hex, PadJobRow> };

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

export class PadIndexer {
  readonly #client: PublicClient;
  readonly #logs: PublicClient;
  readonly #deployment: () => Deployment;
  readonly #statePath: string;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  readonly #readFile: (uri: string) => Promise<unknown>;
  readonly #pad: Address;
  #state: PadIndexState;
  #window = WINDOW_START;
  #vaultWindow = WINDOW_START;
  #ostraVault = new Map<Address, boolean>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(o: { client: PublicClient; logsClient?: PublicClient; deployment: () => Deployment; statePath: string; log: (event: string, fields?: Record<string, unknown>) => void; readFile: (uri: string) => Promise<unknown>; pad?: Address }) {
    this.#client = o.client;
    this.#logs = o.logsClient ?? o.client;
    this.#deployment = o.deployment;
    this.#statePath = o.statePath;
    this.#log = o.log;
    this.#readFile = o.readFile;
    this.#pad = getAddress(o.pad ?? OSTRAPAD);
    const d = o.deployment();
    const fresh: PadIndexState = { version: 2, chainId: d.chainId, pad: this.#pad, scannedTo: (OSTRAPAD_FROM_BLOCK - 1n).toString(), vaultsScannedTo: (BigInt(d.fromBlock) - 1n).toString(), agents: {}, jobs: {} };
    if (existsSync(this.#statePath)) {
      const saved = JSON.parse(readFileSync(this.#statePath, "utf8")) as PadIndexState;
      this.#state = saved.version === 2 && saved.chainId === d.chainId && getAddress(saved.pad) === this.#pad ? saved : fresh;
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
            this.#state.agents[id] = { agentId: id, owner, registeredBlock: l.blockNumber.toString(), uri: null, name: null, description: null, image: null, provider: null, approved: false, offers: [], problems: [], record: null, readAt: 0 };
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
      this.#state.jobs[a.jobId] = { id: a.jobId, client: getAddress(a.client), provider: getAddress(a.provider), evaluator: pool ? null : getAddress(a.evaluator), pool, funded: "0", status: "Open", createdAt: t, createdBlock: l.blockNumber.toString(), updatedAt: t, paid: null, refunded: null };
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
      j.updatedAt = await time(l.blockNumber);
      if (kind === "funded") j.funded = usd(l.args.amount as bigint);
      else if (kind === "paid") j.paid = usd(l.args.amount as bigint);
      else if (kind === "refunded") j.refunded = usd(l.args.amount as bigint);
      else if (kind === "drawn") j.evaluator = getAddress(l.args.evaluator as Address);
      // A cancel emits JobRejected too: Cancelled stands.
      else if (!(kind === "Rejected" && j.status === "Cancelled")) j.status = kind;
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
}
