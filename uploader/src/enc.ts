// The uploader's store of Ostrapad's encrypted files (design "Ostrapad: private job", revisions 2 to 9, decided by Edu
// on 6 and 7 Nov 2026). A private job's order, delivery and reasons are files only the job's parties can read
// (sdk pad-private.ts); this store keeps their bytes, never a key, and serves them by their raw CID like any other file.
// Nothing here is pinned to IPFS: the files live in DIR/files, one per CID, written tmp + fsync + rename, and Ostra's
// evaluator bot and indexer read them from that directory directly (they run on this machine).
//
//   POST /v1/enc/uploads             {size, sha256, kind, jobId?, signature?}: starts an upload and takes its size from
//                                    every allowance at once; answers {id, chunk} or, for a file kept already, {cid}
//   PUT  /v1/enc/uploads/<id>/<n>    chunk n, exactly CHUNK bytes except the last; may be sent again
//   POST /v1/enc/uploads/<id>/done   checks size, sha256 and the header, keeps the file; answers {cid, uri}
//   POST /v1/enc/reserve             {jobId, bytes, seq, signature}: the provider's reservation for a job's delivery
//
// Allowances (revision 7). The store holds at most 20 GB in two parts:
//   * orders (anyone may upload one; a job does not exist yet): at most ORDERS_MAX kept, ORDERS_PER_DAY a day, and
//     NET_UPLOAD_PER_DAY bytes and NET_FILES_PER_DAY files a day from one IPv4 address or IPv6 /64; refused when the
//     disk's free space, less every outstanding reservation, would fall under GENERAL_FLOOR. Starting the upload of an
//     order kept already counts against the day and the address again (it restarts the order's day, revision 9);
//   * deliveries and reasons (bound to a job): a delivery only within the job's reservation, which its provider makes
//     before it accepts (signed by a posting key its own listing publishes), and signed by the provider's posting key
//     in the order's header (the one its MCP checked at accept); reservations take at most JOBS_MAX with the delivery and
//     reason files kept, DELIVERIES_PER_DAY a day, PROVIDER_PER_DAY a day per provider and CLIENT_PER_DAY per client,
//     and are granted only when the disk keeps RESERVE_FLOOR free after every outstanding reservation. A reserved
//     upload is never refused for room. A reason (at most REASON_MAX bytes, REASONS_PER_ROUND per evaluator and round)
//     only from the job's evaluator: an account signs it itself, a pool member's vault with its registered posting
//     key, a client judging its own job with its posting key in the order's header.
// Bytes counted against a day are never given back to it (a retry after a release takes back its own bytes).
//
// Release (every TICK_MS, from the chain and the indexer; a pass runs alone and nothing is removed when either cannot be
// read): a file no job names is removed UNREFERENCED_MS after its last upload (no order while a running job's order is
// not known to the indexer, no delivery while a job it was uploaded for is still accepted); a file a job names, once
// every job that names it is over: at once for a job cancelled or expired, KEEP_FIXED_MS after a job its client judged
// ended, KEEP_POOL_MS after a pool job ended; an order larger than
// its job's budget allows (sdk padOrderByteAllowance) is kept for that job only a day (the provider's MCP refuses such
// an order before it accepts). A delivery removed before it was submitted gives its bytes back to its reservation. A
// reservation with no JobAccepted within RESERVE_HOLD_MS is released, and taken again if the job is accepted later while
// there is room; what a submitted delivery left unused is released.
//
// Concurrency (revision 9, R8-B1): every read of the chain or the indexer happens before the ledger is touched, with a
// time limit; each change of the ledger is one synchronous step, then the ledger is written (writes coalesced, each
// tmp + fsync + rename + directory fsync). Chunks of one upload are written one at a time; uploads do not wait for each
// other, for a reservation, or for a release pass.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  OSTRAPAD,
  PAD_ENC_KIND,
  PAD_ENC_MAX_FILE,
  PAD_ENC_MAX_HEADER,
  ROBINHOOD_CHAIN_ID,
  padEncryptedLength,
  padJobByteAllowance,
  padOrderByteAllowance,
  padParseHeader,
  padRecoverSigner,
  padReserveMessage,
  padUploadMessage,
  type PadJob,
} from "../../sdk/src/index.ts";

type Address = `0x${string}`;
type Hex = `0x${string}`;

export const CHUNK = 8 * 1_048_576;
export const ENC_LIMITS = {
  ORDERS_MAX: 8_000_000_000,
  JOBS_MAX: 12_000_000_000,
  ORDERS_PER_DAY: 1_000_000_000,
  DELIVERIES_PER_DAY: 2_000_000_000,
  PROVIDER_PER_DAY: 1_000_000_000,
  CLIENT_PER_DAY: 1_000_000_000,
  NET_UPLOAD_PER_DAY: 500_000_000,
  NET_FILES_PER_DAY: 200,
  NET_READ_PER_DAY: 2_000_000_000,
  GENERAL_FLOOR: 15_000_000_000,
  RESERVE_FLOOR: 10_000_000_000,
  DISK_ALERT: 15_000_000_000,
  REASON_MAX: 65_536,
  REASONS_PER_ROUND: 10,
  DELIVERIES_PER_JOB: 3,
  UPLOAD_IDLE_MS: 3_600_000,
  UNREFERENCED_MS: 86_400_000,
  KEEP_FIXED_MS: 86_400_000,
  KEEP_POOL_MS: 14 * 86_400_000,
  RESERVE_HOLD_MS: 3_600_000,
  SEQ_AHEAD_MS: 300_000,
  READ_TIMEOUT_MS: 15_000,
  READ_CONCURRENCY: 8,
  ALERT_SHARE: 0.8,
} as const;
export type EncLimits = { -readonly [K in keyof typeof ENC_LIMITS]: number };

/** What the store reads from the chain. */
export interface EncChain {
  job(id: Hex): Promise<PadJob | null>;
}

/** A job as the indexer holds it: the files it names and when it ended (description null: not known yet). */
export type EncIndexJob = { id: Hex; client: Address; provider: Address; pool: boolean; status: string; closedAt: number | null; description: Hex | null; deliverable: Hex | null; reasons: Hex[] };

/** What the store reads from Ostra's indexer (on this machine). */
export interface EncIndex {
  /** Every posting address the provider vault's own approved listings publish (`post`). */
  listingPosts(provider: Address): Promise<Address[]>;
  /** The posting address of a pool member's current KEM registration (a vault signs its uploads with it); null when none. */
  memberPosting(member: Address): Promise<Address | null>;
  /** The order file's sha256 of a job (its terms' description), null when the indexer has not read it. */
  description(jobId: Hex): Promise<Hex | null>;
  /** Every job with the files it names, and whether the indexer has read the chain up to its head (else nothing is removed). */
  files(): Promise<{ caughtUp: boolean; jobs: EncIndexJob[] }>;
}

export class EncError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type FileRec = { size: number; kind: number; at: number; jobs?: Hex[] };
type UploadRec = { size: number; sha256: Hex; kind: number; job?: Hex; at: number; lastAt: number; net: string; chunks: number[]; reasonKey?: string };
type ReserveRec = { bytes: number; used: number; granted: number; seq: string; provider: Address; client: Address; at: number; accepted: boolean; released: boolean; timedOut: boolean };
type Ledger = {
  version: 2;
  day: string;
  orders: number;
  deliveries: number;
  provider: Record<string, number>;
  client: Record<string, number>;
  netUp: Record<string, number>;
  netFiles: Record<string, number>;
  netRead: Record<string, number>;
  reasons: Record<string, number>;
  files: Record<string, FileRec>;
  uploads: Record<string, UploadRec>;
  reservations: Record<string, ReserveRec>;
};

const HEX32 = /^0x[0-9a-f]{64}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The raw CIDv1 (sha2-256) naming a digest (as server.ts rawCidOf). */
export function cidOfDigest(digest: Uint8Array): string {
  const all = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), Buffer.from(digest)]);
  let bits = 0;
  let value = 0;
  let out = "b";
  for (const b of all) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The sha2-256 a raw CIDv1 names (the inverse of cidOfDigest; the CID is one this store made). */
export function digestOfCid(cid: string): Hex {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of cid.slice(1)) {
    value = ((value << 5) | BASE32.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return `0x${Buffer.from(out.slice(4, 36)).toString("hex")}` as Hex;
}

/** The counting key of a client address: an IPv4 address, or the /64 of an IPv6 address. */
export function netKey(ip: string): string {
  const a = ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
  if (!a.includes(":")) return a;
  const [head = "", tail = ""] = a.split("::");
  const h = head === "" ? [] : head.split(":");
  const t = tail === "" ? [] : tail.split(":");
  const groups = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (g === "" ? "0" : g).toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** `p` within `ms`, else a rejection (the read it waits for is left to finish on its own). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

export type EncStoreOptions = {
  dir: string;
  chain: EncChain;
  index: EncIndex;
  chainId?: number;
  pad?: Address;
  limits?: Partial<EncLimits>;
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => number;
  /** Free bytes on the store's disk (default: statfs of the store). */
  freeBytes?: () => number;
};

export class EncStore {
  readonly dir: string;
  readonly filesDir: string;
  readonly #staging: string;
  readonly #ledgerPath: string;
  readonly #o: EncStoreOptions;
  readonly #l: EncLimits;
  readonly #chainId: number;
  readonly #pad: Address;
  #ledger: Ledger;
  /** Uploads with a chunk or the finish in progress (one at a time per upload). */
  readonly #busy = new Set<string>();
  #ticking = false;
  #flushing: Promise<void> | null = null;
  #alerted = new Set<string>();

  constructor(o: EncStoreOptions) {
    this.#o = o;
    this.#l = { ...ENC_LIMITS, ...(o.limits ?? {}) };
    this.#chainId = o.chainId ?? ROBINHOOD_CHAIN_ID;
    this.#pad = o.pad ?? OSTRAPAD;
    this.dir = o.dir;
    this.filesDir = join(o.dir, "files");
    this.#staging = join(o.dir, "staging");
    this.#ledgerPath = join(o.dir, "ledger.json");
    for (const d of [o.dir, this.filesDir, this.#staging]) mkdirSync(d, { recursive: true, mode: 0o700 });
    this.#ledger = this.#load();
    this.#writeNow();
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** The ledger, made consistent with the disk after a crash: kept files win over unfinished uploads, orphans go. */
  #load(): Ledger {
    const empty: Ledger = { version: 2, day: today(this.#now()), orders: 0, deliveries: 0, provider: {}, client: {}, netUp: {}, netFiles: {}, netRead: {}, reasons: {}, files: {}, uploads: {}, reservations: {} };
    const l: Ledger = existsSync(this.#ledgerPath) ? { ...empty, ...(JSON.parse(readFileSync(this.#ledgerPath, "utf8")) as Partial<Ledger>), version: 2 } : empty;
    for (const name of readdirSync(this.filesDir)) {
      const path = join(this.filesDir, name);
      if (name.endsWith(".tmp")) {
        rmSync(path, { force: true });
        continue;
      }
      if (l.files[name] === undefined) {
        const head = Buffer.alloc(14);
        const fd = openSync(path, "r");
        try {
          readSync(fd, head, 0, 14, 0);
        } finally {
          closeSync(fd);
        }
        l.files[name] = { size: statSync(path).size, kind: head[13] ?? 0, at: this.#now() };
      }
    }
    for (const cid of Object.keys(l.files)) if (!existsSync(join(this.filesDir, cid))) delete l.files[cid];
    // An upload whose file was kept (a crash between the rename and the ledger's write) is finished; one without its
    // staging file is gone; a staging file without its upload is removed.
    for (const [id, u] of Object.entries(l.uploads)) {
      const cid = cidOfDigest(Buffer.from(u.sha256.slice(2), "hex"));
      if (l.files[cid] !== undefined) {
        l.files[cid] = { ...l.files[cid], kind: u.kind, ...(u.job === undefined ? {} : { jobs: [u.job] }) };
        delete l.uploads[id];
        rmSync(join(this.#staging, id), { force: true });
      } else if (!existsSync(join(this.#staging, id))) delete l.uploads[id];
    }
    for (const name of readdirSync(this.#staging)) if (l.uploads[name] === undefined) rmSync(join(this.#staging, name), { force: true });
    return l;
  }

  #writeNow(): void {
    const tmp = `${this.#ledgerPath}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, Buffer.from(JSON.stringify(this.#ledger)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.#ledgerPath);
    fsyncDir(this.dir);
  }

  /** Writes the ledger (coalesced: callers during a write share the next one); resolves once their change is on disk. */
  #flush(): Promise<void> {
    if (this.#flushing !== null) return this.#flushing.then(() => this.#flush());
    this.#flushing = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        try {
          this.#writeNow();
          resolve();
        } catch (err) {
          reject(err as Error);
        } finally {
          this.#flushing = null;
        }
      });
    });
    return this.#flushing;
  }

  #roll(): void {
    const day = today(this.#now());
    if (day === this.#ledger.day) return;
    Object.assign(this.#ledger, { day, orders: 0, deliveries: 0, provider: {}, client: {}, netUp: {}, netFiles: {}, netRead: {} });
  }

  #free(): number {
    if (this.#o.freeBytes) return this.#o.freeBytes();
    const s = statfsSync(this.dir);
    return Number(s.bavail) * Number(s.bsize);
  }

  /** Bytes reserved or uploading and not kept yet: what the disk must still take. */
  #outstanding(): number {
    let n = 0;
    for (const r of Object.values(this.#ledger.reservations)) if (!r.released) n += Math.max(0, r.bytes - r.used);
    for (const u of Object.values(this.#ledger.uploads)) n += u.size;
    return n;
  }

  /** The two parts of the store: orders kept or uploading, and job files kept, uploading or reserved. */
  usage(): { orders: number; jobs: number; free: number; outstanding: number } {
    let orders = 0;
    let jobs = 0;
    for (const f of Object.values(this.#ledger.files)) {
      if (f.kind === PAD_ENC_KIND.order) orders += f.size;
      else jobs += f.size;
    }
    // An upload counts once: an order in the orders part; a delivery or reason in the jobs part (a delivery's bytes are
    // in its reservation's `used`, so the reservation adds only what is not uploaded yet).
    for (const u of Object.values(this.#ledger.uploads)) {
      if (u.kind === PAD_ENC_KIND.order) orders += u.size;
      else jobs += u.size;
    }
    for (const r of Object.values(this.#ledger.reservations)) if (!r.released) jobs += Math.max(0, r.bytes - r.used);
    return { orders, jobs, free: this.#free(), outstanding: this.#outstanding() };
  }

  #alert(part: string, used: number, max: number): void {
    if (used >= max * this.#l.ALERT_SHARE) {
      if (!this.#alerted.has(part)) this.#o.log?.("enc_alert", { part, used, max });
      this.#alerted.add(part);
    } else this.#alerted.delete(part);
  }

  health(): Record<string, unknown> {
    this.#roll();
    const u = this.usage();
    return { day: this.#ledger.day, ordersKept: u.orders, ordersMax: this.#l.ORDERS_MAX, jobsKept: u.jobs, jobsMax: this.#l.JOBS_MAX, ordersToday: this.#ledger.orders, deliveriesToday: this.#ledger.deliveries, free: u.free, outstanding: u.outstanding, files: Object.keys(this.#ledger.files).length };
  }

  /** The path of a kept file, or null. */
  path(cid: string): string | null {
    if (this.#ledger.files[cid] === undefined) return null;
    const p = join(this.filesDir, cid);
    return existsSync(p) ? p : null;
  }

  #read<T>(p: Promise<T>, what: string): Promise<T> {
    return within(p, this.#l.READ_TIMEOUT_MS, what).catch((err: unknown) => {
      throw err instanceof EncError ? err : new EncError(503, "unavailable", `${what} could not be read now; try again (${(err as Error).message.slice(0, 120)})`);
    });
  }

  // -------------------------------------------------------------------------------------------------------------- reserve

  /** A provider's reservation for job `jobId`'s delivery (signed by a `post` of job.provider's own listings). */
  async reserve(r: { jobId: string; bytes: number; seq: string; signature: string }): Promise<{ bytes: number }> {
    if (!HEX32.test(r.jobId)) throw new EncError(400, "bad_job", "jobId must be 32 bytes of lower-case hex");
    if (!Number.isSafeInteger(r.bytes) || r.bytes <= 0) throw new EncError(400, "bad_bytes", "bytes must be a positive whole number");
    if (!/^\d{1,16}$/.test(r.seq)) throw new EncError(400, "bad_seq", "seq must be unix milliseconds as a decimal number");
    const seq = BigInt(r.seq);
    if (seq > BigInt(this.#now() + this.#l.SEQ_AHEAD_MS)) throw new EncError(400, "seq_ahead", "seq is more than 5 minutes ahead of this server's clock");
    const jobId = r.jobId as Hex;
    // Reads first, outside any change.
    const job = await this.#read(this.#o.chain.job(jobId), "the job");
    if (job === null || (job.status !== "Open" && job.status !== "Accepted")) throw new EncError(409, "wrong_status", "a reservation is made for a job that is open or accepted");
    const posts = await this.#read(this.#o.index.listingPosts(job.provider), "the provider's listing");
    const signer = await padRecoverSigner(padReserveMessage({ chainId: this.#chainId, pad: this.#pad, jobId, bytes: BigInt(r.bytes), seq }), r.signature as Hex);
    if (signer === null || !posts.some((p) => p.toLowerCase() === signer.toLowerCase())) throw new EncError(403, "bad_signature", "the reservation is not signed by a posting key of the provider's listing");
    const allowance = Math.min(padJobByteAllowance(job.budget), this.#l.DELIVERIES_PER_JOB * PAD_ENC_MAX_FILE);
    if (r.bytes > allowance) throw new EncError(413, "over_allowance", `this job's deliveries may take at most ${allowance} bytes`);
    // One synchronous change.
    this.#roll();
    const old = this.#ledger.reservations[jobId];
    if (old !== undefined && BigInt(old.seq) >= seq) throw new EncError(409, "stale_seq", `seq must be above ${old.seq}`);
    if (old !== undefined && r.bytes < old.used) throw new EncError(409, "below_used", `${old.used} bytes are uploaded already`);
    // Room: what this reservation adds to what is held now. The day: only bytes above what this job's reservations were
    // ever granted (a retry after a release takes back its own bytes, revision 8).
    const room = old !== undefined && !old.released ? r.bytes - old.bytes : r.bytes - (old?.used ?? 0);
    const day = Math.max(0, r.bytes - (old?.granted ?? 0));
    this.#admitReservation(day, room, job.provider, job.client);
    this.#ledger.reservations[jobId] = { bytes: r.bytes, used: old?.used ?? 0, granted: Math.max(r.bytes, old?.granted ?? 0), seq: r.seq, provider: job.provider, client: job.client, at: this.#now(), accepted: job.status === "Accepted", released: false, timedOut: false };
    await this.#flush();
    this.#o.log?.("enc_reserved", { jobId, bytes: r.bytes, day, room });
    return { bytes: r.bytes };
  }

  /**
   * Takes `day` bytes from today's allowances (all deliveries, the provider, the client) and `room` bytes from the jobs
   * part and the disk; throws, taking nothing, when one has no room. Synchronous.
   */
  #admitReservation(day: number, room: number, provider: Address, client: Address): void {
    const L = this.#ledger;
    const p = provider.toLowerCase();
    const c = client.toLowerCase();
    if (day > 0) {
      if (L.deliveries + day > this.#l.DELIVERIES_PER_DAY) throw new EncError(503, "deliveries_day_used", "today's allowance for private deliveries is used; try again tomorrow (UTC)");
      if ((L.provider[p] ?? 0) + day > this.#l.PROVIDER_PER_DAY) throw new EncError(429, "provider_day_used", "this provider's allowance for today is used");
      if ((L.client[c] ?? 0) + day > this.#l.CLIENT_PER_DAY) throw new EncError(429, "client_day_used", "this client's allowance for today is used");
    }
    const u = this.usage();
    if (room > 0) {
      if (u.jobs + room > this.#l.JOBS_MAX) {
        this.#alert("jobs", u.jobs, this.#l.JOBS_MAX);
        throw new EncError(507, "jobs_store_full", "the store for private deliveries is full; try again later");
      }
      if (u.free - u.outstanding - room < this.#l.RESERVE_FLOOR) throw new EncError(507, "disk_floor", "the server's disk is too full for a new reservation");
    }
    if (day > 0) {
      L.deliveries += day;
      L.provider[p] = (L.provider[p] ?? 0) + day;
      L.client[c] = (L.client[c] ?? 0) + day;
    }
    this.#alert("jobs", u.jobs + Math.max(0, room), this.#l.JOBS_MAX);
  }

  // -------------------------------------------------------------------------------------------------------------- uploads

  /** Starts an upload; answers its id, or the CID when the file is kept already. */
  async begin(b: { size: unknown; sha256: unknown; kind: unknown; jobId?: unknown; signature?: unknown }, ip: string): Promise<{ id: string; chunk: number } | { cid: string; uri: string }> {
    const size = b.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 74 || size > PAD_ENC_MAX_FILE) throw new EncError(400, "bad_size", `size must be a whole number from 74 to ${PAD_ENC_MAX_FILE}`);
    if (typeof b.sha256 !== "string" || !HEX32.test(b.sha256)) throw new EncError(400, "bad_sha256", "sha256 must be 32 bytes of lower-case hex");
    const sha256 = b.sha256 as Hex;
    const kind = b.kind;
    if (kind !== PAD_ENC_KIND.order && kind !== PAD_ENC_KIND.delivery && kind !== PAD_ENC_KIND.reason) throw new EncError(400, "bad_kind", "kind must be 1 (order), 2 (delivery) or 3 (reason)");
    const cid = cidOfDigest(Buffer.from(sha256.slice(2), "hex"));
    const net = netKey(ip);
    const now = this.#now();
    const rec: UploadRec = { size, sha256, kind, at: now, lastAt: now, net, chunks: [] };
    // A job file's checks read the chain and the indexer first; nothing is counted yet.
    const job = kind === PAD_ENC_KIND.order ? null : await this.#checkJobFile(rec, b.jobId, b.signature);
    this.#roll();
    const kept = this.#ledger.files[cid];
    if (kept !== undefined && existsSync(join(this.filesDir, cid))) {
      // Kept already: the same file, of the size it was kept at. An order's day starts again only when it is counted
      // again, at that size (revision 9, R8-M2; review round 9, R9-M1).
      if (size !== kept.size || kind !== kept.kind) throw new EncError(409, "kept_differs", `this sha256 is kept as a file of kind ${kept.kind} and ${kept.size} bytes`);
      if (kind === PAD_ENC_KIND.order) {
        this.#admitOrder(kept.size, net, false);
        kept.at = now;
      }
      if (job !== null) kept.jobs = [...new Set([...(kept.jobs ?? []), job])];
      await this.#flush();
      return { cid, uri: `ipfs://${cid}` };
    }
    if (kind === PAD_ENC_KIND.order) this.#admitOrder(size, net, true);
    else this.#admitJobFile(rec);
    const id = randomBytes(16).toString("hex");
    closeSync(openSync(join(this.#staging, id), "w", 0o600));
    this.#ledger.uploads[id] = rec;
    await this.#flush();
    return { id, chunk: CHUNK };
  }

  /** Counts an order against the day, the address and (when it takes room) the orders part and the disk. Synchronous. */
  #admitOrder(size: number, net: string, room: boolean): void {
    const L = this.#ledger;
    if (L.orders + size > this.#l.ORDERS_PER_DAY) throw new EncError(503, "orders_day_used", "today's allowance for private orders is used; try again tomorrow (UTC)");
    if ((L.netUp[net] ?? 0) + size > this.#l.NET_UPLOAD_PER_DAY) throw new EncError(429, "address_day_used", "this address's allowance for today is used");
    if ((L.netFiles[net] ?? 0) + 1 > this.#l.NET_FILES_PER_DAY) throw new EncError(429, "address_files_used", "this address's uploads for today are used");
    if (room) {
      const u = this.usage();
      if (u.orders + size > this.#l.ORDERS_MAX) {
        this.#alert("orders", u.orders, this.#l.ORDERS_MAX);
        throw new EncError(507, "orders_store_full", "the store for private orders is full; try again later");
      }
      if (u.free - u.outstanding - size < this.#l.GENERAL_FLOOR) throw new EncError(507, "disk_floor", "the server's disk is too full for a new order");
      this.#alert("orders", u.orders + size, this.#l.ORDERS_MAX);
    }
    L.orders += size;
    L.netUp[net] = (L.netUp[net] ?? 0) + size;
    L.netFiles[net] = (L.netFiles[net] ?? 0) + 1;
  }

  /** The reads a delivery or reason needs: the job, its signer. Its jobId on success. Counts nothing. */
  async #checkJobFile(rec: UploadRec, jobIdIn: unknown, signatureIn: unknown): Promise<Hex> {
    if (typeof jobIdIn !== "string" || !HEX32.test(jobIdIn)) throw new EncError(400, "bad_job", "a delivery or reason names its jobId");
    if (typeof signatureIn !== "string") throw new EncError(400, "bad_signature", "a delivery or reason is signed");
    const jobId = jobIdIn as Hex;
    rec.job = jobId;
    const job = await this.#read(this.#o.chain.job(jobId), "the job");
    if (job === null) throw new EncError(404, "no_job", "no such job");
    const signer = await padRecoverSigner(padUploadMessage({ chainId: this.#chainId, pad: this.#pad, jobId, kind: rec.kind as 2 | 3, sha256: rec.sha256, size: BigInt(rec.size) }), signatureIn as Hex);
    if (signer === null) throw new EncError(403, "bad_signature", "the signature does not recover");
    if (rec.kind === PAD_ENC_KIND.delivery) {
      if (job.status !== "Accepted") throw new EncError(409, "wrong_status", "a delivery is uploaded while the job is accepted");
      // The provider's posting key in the order's header (its MCP checked it before accepting).
      const description = await this.#read(this.#o.index.description(jobId), "the job's order");
      const header = description === null ? null : this.#orderHeader(description);
      if (header === null) throw new EncError(409, "no_order", "the job's private order is not known here");
      if (header.providerPosting.toLowerCase() !== signer.toLowerCase()) throw new EncError(403, "bad_signature", "a delivery is signed by the provider's posting key in the order");
      return jobId;
    }
    if (job.status !== "Submitted") throw new EncError(409, "wrong_status", "a reason is uploaded while the job waits for its decision");
    if (signer.toLowerCase() !== job.evaluator.toLowerCase()) {
      // A vault signs with a posting key: a pool member's registered one; a client judging its own job, the client's
      // posting key in the order's header (it has no registration: it is not in the pool).
      let posting: Address | null;
      if (job.evaluator.toLowerCase() === job.client.toLowerCase()) {
        const description = await this.#read(this.#o.index.description(jobId), "the job's order");
        posting = description === null ? null : (this.#orderHeader(description)?.clientPosting ?? null);
      } else posting = await this.#read(this.#o.index.memberPosting(job.evaluator), "the evaluator's registration");
      if (posting === null || posting.toLowerCase() !== signer.toLowerCase()) throw new EncError(403, "bad_signature", "a reason is signed by the job's evaluator");
    }
    rec.reasonKey = `${jobId}:${job.evaluator.toLowerCase()}:${job.round}`;
    return jobId;
  }

  /** The posting addresses in a kept order's header, or null. */
  #orderHeader(description: Hex): { providerPosting: Address; clientPosting: Address } | null {
    const p = this.path(cidOfDigest(Buffer.from(description.slice(2), "hex")));
    if (p === null) return null;
    const head = Buffer.alloc(PAD_ENC_MAX_HEADER);
    const fd = openSync(p, "r");
    let n = 0;
    try {
      n = readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    try {
      const o = padParseHeader(new Uint8Array(head.subarray(0, n))).header.order;
      return o === null ? null : { providerPosting: o.providerPosting as Address, clientPosting: o.clientPosting as Address };
    } catch {
      return null;
    }
  }

  /** Counts a delivery against its reservation, or a reason against its round and the jobs part. Synchronous. */
  #admitJobFile(rec: UploadRec): void {
    const jobId = rec.job as Hex;
    if (rec.kind === PAD_ENC_KIND.delivery) {
      const res = this.#ledger.reservations[jobId];
      if (res === undefined || res.released) throw new EncError(409, "no_reservation", "this job has no reservation for its delivery");
      if (res.used + rec.size > res.bytes) throw new EncError(413, "over_reservation", `the reservation has ${res.bytes - res.used} bytes left`);
      const count = Object.values(this.#ledger.files).filter((f) => f.kind === PAD_ENC_KIND.delivery && f.jobs?.includes(jobId)).length + Object.values(this.#ledger.uploads).filter((u) => u.job === jobId && u.kind === PAD_ENC_KIND.delivery).length;
      if (count >= this.#l.DELIVERIES_PER_JOB) throw new EncError(429, "too_many_deliveries", `at most ${this.#l.DELIVERIES_PER_JOB} delivery files per job`);
      res.used += rec.size;
      return;
    }
    if (rec.size > this.#l.REASON_MAX) throw new EncError(413, "too_large", `a reason is at most ${this.#l.REASON_MAX} bytes`);
    const key = rec.reasonKey as string;
    const n = this.#ledger.reasons[key] ?? 0;
    if (n >= this.#l.REASONS_PER_ROUND) throw new EncError(429, "too_many_reasons", `at most ${this.#l.REASONS_PER_ROUND} reasons per evaluator and round`);
    const u = this.usage();
    if (u.jobs + rec.size > this.#l.JOBS_MAX || u.free - u.outstanding - rec.size < this.#l.RESERVE_FLOOR) throw new EncError(507, "jobs_store_full", "the store for private job files is full");
    this.#ledger.reasons[key] = n + 1;
  }

  /** The size chunk `n` of upload `id` must have; throws when the upload or chunk is unknown (checked before the body is read). */
  expectChunk(id: string, n: number): number {
    const u = this.#ledger.uploads[id];
    if (u === undefined) throw new EncError(404, "no_upload", "no such upload (it finished, or expired after an hour without a chunk)");
    const count = Math.ceil(u.size / CHUNK);
    if (!Number.isInteger(n) || n < 0 || n >= count) throw new EncError(400, "bad_chunk", `chunks are numbered 0 to ${count - 1}`);
    return n === count - 1 ? u.size - n * CHUNK : CHUNK;
  }

  /** Writes chunk `n` of upload `id` (CHUNK bytes, the last one the rest); chunks of one upload one at a time. */
  async chunk(id: string, n: number, body: Uint8Array): Promise<void> {
    const want = this.expectChunk(id, n);
    if (body.length !== want) throw new EncError(400, "bad_chunk_size", `chunk ${n} is ${want} bytes`);
    if (this.#busy.has(id)) throw new EncError(409, "busy", "another chunk of this upload is being written; send it again");
    this.#busy.add(id);
    try {
      const fd = openSync(join(this.#staging, id), "r+");
      try {
        let o = 0;
        while (o < body.length) o += writeSync(fd, body, o, body.length - o, n * CHUNK + o);
      } finally {
        closeSync(fd);
      }
      const u = this.#ledger.uploads[id];
      if (u === undefined) throw new EncError(404, "no_upload", "the upload expired while this chunk was written");
      if (!u.chunks.includes(n)) u.chunks.push(n);
      u.lastAt = this.#now();
      await this.#flush();
    } finally {
      this.#busy.delete(id);
    }
  }

  /** Finishes upload `id`: checks every byte against its size, sha256 and header, then keeps the file. */
  async done(id: string): Promise<{ cid: string; uri: string }> {
    const u = this.#ledger.uploads[id];
    if (u === undefined) throw new EncError(404, "no_upload", "no such upload");
    const count = Math.ceil(u.size / CHUNK);
    if (u.chunks.length !== count) throw new EncError(409, "missing_chunks", `${count - u.chunks.length} chunks are missing`);
    if (this.#busy.has(id)) throw new EncError(409, "busy", "a chunk of this upload is being written; finish it again");
    this.#busy.add(id);
    try {
      const path = join(this.#staging, id);
      const hash = createHash("sha256");
      const head = Buffer.alloc(Math.min(PAD_ENC_MAX_HEADER, u.size));
      let total = 0;
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(1_048_576);
        for (;;) {
          const r = readSync(fd, buf, 0, buf.length, total);
          if (r === 0) break;
          if (total < head.length) buf.copy(head, total, 0, Math.min(r, head.length - total));
          hash.update(buf.subarray(0, r));
          total += r;
          // Hashing 100 MB yields to other requests every 1 MiB.
          if (total % (8 * 1_048_576) === 0) await new Promise((r2) => setImmediate(r2));
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        if (total !== u.size) throw new EncError(400, "bad_size", "the bytes are not the size declared");
        if (`0x${hash.digest("hex")}` !== u.sha256) throw new EncError(400, "bad_sha256", "the bytes do not match the sha256 declared");
        let parsed;
        try {
          parsed = padParseHeader(new Uint8Array(head));
        } catch (err) {
          throw new EncError(400, "bad_header", (err as Error).message);
        }
        if (parsed.header.kind !== u.kind) throw new EncError(400, "bad_header", "the header's kind is not the kind declared");
        if (padEncryptedLength(parsed.length, parsed.header.plaintextLength) !== u.size) throw new EncError(400, "bad_header", "the file's length does not match its header");
      } catch (err) {
        if (err instanceof EncError) {
          this.#drop(id, u, false);
          await this.#flush();
        }
        throw err;
      }
      const cid = cidOfDigest(Buffer.from(u.sha256.slice(2), "hex"));
      const kept = this.#ledger.files[cid];
      if (kept !== undefined && existsSync(join(this.filesDir, cid))) {
        // The same bytes were kept meanwhile (two uploads of one digest): this one's job joins that record.
        rmSync(path, { force: true });
        if (u.job !== undefined) kept.jobs = [...new Set([...(kept.jobs ?? []), u.job])];
      } else {
        renameSync(path, join(this.filesDir, cid));
        fsyncDir(this.filesDir);
        this.#ledger.files[cid] = { size: u.size, kind: u.kind, at: this.#now(), ...(u.job === undefined ? {} : { jobs: [u.job] }) };
      }
      delete this.#ledger.uploads[id];
      await this.#flush();
      this.#o.log?.("enc_kept", { cid, kind: u.kind, size: u.size, ...(u.job === undefined ? {} : { jobId: u.job }) });
      return { cid, uri: `ipfs://${cid}` };
    } finally {
      this.#busy.delete(id);
    }
  }

  /**
   * Drops an upload that failed or lapsed, giving back what it took: a delivery's bytes to its reservation, a reason's
   * count, and (`refundDay`) an order's bytes to the day and the address. Synchronous.
   */
  #drop(id: string, u: UploadRec, refundDay: boolean): void {
    rmSync(join(this.#staging, id), { force: true });
    delete this.#ledger.uploads[id];
    if (u.kind === PAD_ENC_KIND.delivery && u.job !== undefined) {
      const r = this.#ledger.reservations[u.job];
      if (r !== undefined) r.used = Math.max(0, r.used - u.size);
    }
    if (u.reasonKey !== undefined) this.#ledger.reasons[u.reasonKey] = Math.max(0, (this.#ledger.reasons[u.reasonKey] ?? 1) - 1);
    if (refundDay && u.kind === PAD_ENC_KIND.order) {
      this.#ledger.orders = Math.max(0, this.#ledger.orders - u.size);
      this.#ledger.netUp[u.net] = Math.max(0, (this.#ledger.netUp[u.net] ?? 0) - u.size);
    }
  }

  // -------------------------------------------------------------------------------------------------------------- reads

  /**
   * Counts `bytes` read by `ip` (an IPv4 address or IPv6 /64, NET_READ_PER_DAY a day); a caller on this machine is not
   * counted. Throws when the day's reads are used. Kept in memory and written with the next change.
   */
  admitRead(ip: string, bytes: number, local: boolean): void {
    if (local) return;
    this.#roll();
    const net = netKey(ip);
    const used = this.#ledger.netRead[net] ?? 0;
    if (used + bytes > this.#l.NET_READ_PER_DAY) throw new EncError(429, "reads_day_used", "this address's reads of private files for today are used");
    this.#ledger.netRead[net] = used + bytes;
  }

  // -------------------------------------------------------------------------------------------------------------- release

  /**
   * One pass: lapsed uploads, reservations against the chain, files no job needs, the disk alert. A pass already running
   * makes this one a no-op. Reads that fail remove nothing.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      this.#roll();
      const now = this.#now();
      for (const [id, u] of Object.entries(this.#ledger.uploads)) {
        if (!this.#busy.has(id) && now - u.lastAt > this.#l.UPLOAD_IDLE_MS) {
          // An order that never finished gives its bytes back to the day and the address (revision 2); a job file does not.
          this.#drop(id, u, true);
          this.#o.log?.("enc_upload_expired", { id, kind: u.kind });
        }
      }
      await this.#tickReservations(now);
      await this.#tickFiles(now);
      await this.#flush();
      const u = this.usage();
      this.#alert("orders", u.orders, this.#l.ORDERS_MAX);
      this.#alert("jobs", u.jobs, this.#l.JOBS_MAX);
      if (u.free < this.#l.DISK_ALERT) {
        if (!this.#alerted.has("disk")) this.#o.log?.("enc_alert", { part: "disk", free: u.free, floor: this.#l.DISK_ALERT });
        this.#alerted.add("disk");
      } else this.#alerted.delete("disk");
    } finally {
      this.#ticking = false;
    }
  }

  /** The chain's view of `ids`, READ_CONCURRENCY at a time, each within READ_TIMEOUT_MS ("unread" when it failed). */
  async #jobs(ids: Hex[]): Promise<Map<Hex, PadJob | null | "unread">> {
    const out = new Map<Hex, PadJob | null | "unread">();
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++] as Hex;
        try {
          out.set(id, await within(this.#o.chain.job(id), this.#l.READ_TIMEOUT_MS, "job"));
        } catch {
          out.set(id, "unread");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#l.READ_CONCURRENCY, ids.length) }, worker));
    return out;
  }

  async #tickReservations(now: number): Promise<void> {
    const read = await this.#jobs(Object.keys(this.#ledger.reservations) as Hex[]);
    for (const [jobId, r] of Object.entries(this.#ledger.reservations)) {
      const job = read.get(jobId as Hex);
      if (job === undefined || job === "unread") continue;
      if (job === null) {
        delete this.#ledger.reservations[jobId];
        continue;
      }
      if (job.status === "Open") {
        if (!r.released && now - r.at > this.#l.RESERVE_HOLD_MS) {
          r.released = true;
          r.timedOut = true;
          this.#o.log?.("enc_reservation_released", { jobId, why: "not accepted within an hour" });
        }
      } else if (job.status === "Accepted") {
        r.accepted = true;
        if (r.released && r.timedOut) {
          // accepted after its reservation lapsed (a vault approval sent late): taken again when there is room
          try {
            this.#admitReservation(0, r.bytes - r.used, r.provider, r.client);
            r.released = false;
            r.timedOut = false;
            this.#o.log?.("enc_reservation_retaken", { jobId, bytes: r.bytes });
          } catch (err) {
            this.#o.log?.("enc_reservation_not_retaken", { jobId, reason: (err as Error).message });
          }
        }
      } else {
        if (!r.released) this.#o.log?.("enc_reservation_released", { jobId, why: job.status, unused: r.bytes - r.used });
        delete this.#ledger.reservations[jobId];
      }
    }
  }

  async #tickFiles(now: number): Promise<void> {
    let index: Awaited<ReturnType<EncIndex["files"]>>;
    try {
      index = await within(this.#o.index.files(), 4 * this.#l.READ_TIMEOUT_MS, "indexer files");
    } catch (err) {
      this.#o.log?.("enc_release_skipped", { reason: `indexer: ${(err as Error).message.slice(0, 200)}` });
      return;
    }
    // Nothing is removed until the indexer has read the chain to its head: a job it has not seen yet may name any file.
    if (!index.caughtUp) {
      this.#o.log?.("enc_release_skipped", { reason: "the indexer is behind the chain" });
      return;
    }
    // A running job whose order the indexer could not read may name any order: none is removed as unnamed meanwhile.
    const unknownOrder = index.jobs.some((j) => j.description === null && j.closedAt === null);
    const refs = new Map<string, EncIndexJob[]>();
    for (const j of index.jobs) {
      for (const d of [j.description, j.deliverable, ...j.reasons]) {
        if (d === null || !HEX32.test(d)) continue;
        const cid = cidOfDigest(Buffer.from(d.slice(2), "hex"));
        if (this.#ledger.files[cid] !== undefined) refs.set(cid, [...(refs.get(cid) ?? []), j]);
      }
    }
    // A delivery no job names yet (uploaded, not submitted) is kept while a job it was uploaded for is still accepted
    // (review round 9, minor 3: a submit can come more than a day after the upload).
    const pending = Object.entries(this.#ledger.files).filter(([cid, f]) => f.kind === PAD_ENC_KIND.delivery && !refs.has(cid)).flatMap(([, f]) => f.jobs ?? []);
    const read = await this.#jobs([...new Set([...[...refs.values()].flat().map((j) => j.id), ...pending])]);
    for (const [cid, f] of Object.entries(this.#ledger.files)) {
      const named = refs.get(cid) ?? [];
      const sha = digestOfCid(cid);
      let removeAt: number | null;
      if (named.length === 0) {
        const waiting = f.kind === PAD_ENC_KIND.delivery && (f.jobs ?? []).some((id) => {
          const job = read.get(id);
          return job === undefined || job === "unread" || job?.status === "Accepted";
        });
        removeAt = (unknownOrder && f.kind === PAD_ENC_KIND.order) || waiting ? null : f.at + this.#l.UNREFERENCED_MS;
      } else {
        removeAt = 0;
        for (const j of named) {
          const job = read.get(j.id);
          if (job === undefined || job === "unread") {
            removeAt = null;
            break;
          }
          // An order larger than its job's budget allows is not kept for that job past a day (revision 8; the provider's
          // MCP refuses such an order before accepting, so only a job its client accepted itself is left without it).
          if (f.kind === PAD_ENC_KIND.order && job !== null && j.description === sha && f.size > padOrderByteAllowance(job.budget)) {
            removeAt = Math.max(removeAt, f.at + this.#l.UNREFERENCED_MS);
            continue;
          }
          const status = job?.status ?? null;
          let at: number | null;
          if (status === "Cancelled" || status === "Expired") at = 0;
          else if ((status === "Completed" || status === "Rejected") && j.closedAt !== null) at = j.closedAt * 1000 + (j.pool ? this.#l.KEEP_POOL_MS : this.#l.KEEP_FIXED_MS);
          else at = null;
          if (at === null) {
            removeAt = null;
            break;
          }
          removeAt = Math.max(removeAt, at);
        }
      }
      if (removeAt !== null && now >= removeAt) {
        rmSync(join(this.filesDir, cid), { force: true });
        delete this.#ledger.files[cid];
        // A delivery removed before it was submitted gives its bytes back to its job's reservation (revision 9, R8-M4).
        if (f.kind === PAD_ENC_KIND.delivery) {
          for (const job of f.jobs ?? []) {
            const r = this.#ledger.reservations[job];
            if (r !== undefined && !r.released) r.used = Math.max(0, r.used - f.size);
          }
        }
        this.#o.log?.("enc_released", { cid, size: f.size, jobs: named.map((j) => j.id) });
      }
    }
  }
}

/**
 * The indexer's private-job routes on this machine (indexer pad-private.ts): GET <base>/listing-post/<provider>,
 * /member-posting/<member>, /description/<jobId> and /files. A read that fails throws (a reservation or job file is then
 * refused, and nothing is removed).
 */
export function httpEncIndex(base: string, f: typeof fetch = fetch): EncIndex {
  const get = async (path: string): Promise<unknown> => {
    const res = await f(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`indexer ${path.split("/")[1]}: HTTP ${res.status}`);
    return res.json();
  };
  const addr = (v: unknown): Address | null => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null);
  return {
    async listingPosts(provider) {
      const v = ((await get(`/listing-post/${provider}`)) as { posts?: unknown }).posts;
      return Array.isArray(v) ? v.map(addr).filter((a): a is Address => a !== null) : [];
    },
    async memberPosting(member) {
      return addr(((await get(`/member-posting/${member}`)) as { posting?: unknown }).posting);
    },
    async description(jobId) {
      const v = ((await get(`/description/${jobId}`)) as { description?: unknown }).description;
      return typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v) ? (v as Hex) : null;
    },
    async files() {
      const v = (await get("/files")) as { caughtUp?: unknown; jobs?: unknown };
      if (typeof v.caughtUp !== "boolean" || !Array.isArray(v.jobs)) throw new Error("indexer files: malformed answer");
      return { caughtUp: v.caughtUp, jobs: v.jobs as EncIndexJob[] };
    },
  };
}
