// Ostrapad private jobs in the index (design "Ostrapad: private job", revisions 2 to 8, decided by Edu on 6 and 7 Nov
// 2026). The index holds no key and no plaintext: what it keeps is public material the parties post so that each can
// read a private job (sdk pad-private.ts), and the records Ostra's panel needs to judge a rejection "for no K".
//
//   KEM registrations  a pool member's ML-KEM-768 public key and posting address, signed by the member (an account:
//                      EIP-191; an Ostra vault: the approved digest padActionDigest(padKemMessage(...)), checked with
//                      isValidSignature at the block it arrived in). The key must pass FIPS 203's modulus check, the
//                      member must be in OstraPad's pool, issuedAt (an L2 block) must be within an hour of now.
//                      A registration of the same key and posting address as the current one changes nothing (its
//                      first arrival stands, revision 7); a new key starts a new arrival. Each keeps the server time
//                      and the RPC's block number it arrived at.
//   Order headers      each private job's order header, read from the uploader's store on this machine when the job is
//                      seen, with the time it was first read (`headerAt`; `fromCreation` when that was within
//                      HEADER_FRESH_MS of the job's creation): its posting addresses decide who may post wraps for the
//                      job, and Ostra's panel upholds a rejection for no K only when the header was here before the
//                      evaluator's assignment (review round 9, R9-B1).
//   Wraps              K wrapped for a drawn evaluator (signed by the provider's posting key, for the evaluator's round)
//                      or for an appeal panel member (signed by the appellant's posting key, round PAD_PANEL_ROUND), to
//                      the recipient's current registration; one slot per sender, recipient and round, a higher seq
//                      replacing a lower one (seq: unix milliseconds, at most SEQ_AHEAD_MS ahead of this clock); the
//                      same wrap bytes posted again keep their first arrival.
//   Heartbeat          every minute, after a self-test (the RPC answers, the uploader's store is readable, the index
//                      has read OstraPad's events to the chain's head, R9-M4): the spans
//                      the index was up, so the panel can tell an outage from a wrap that was never sent.
//
// Every record is written tmp + fsync + rename before a post is answered.
//
//   POST /api/v1/pad/private/kem                 {member, pk (base64), posting, issuedAt, signature?}
//   GET  /api/v1/pad/private/kem/<member>        its registrations, oldest first, the last one current
//   POST /api/v1/pad/private/wraps/<jobId>       {round, wrap (base64, 1,188 bytes), seq, signature}
//   GET  /api/v1/pad/private/wraps/<jobId>       the job's wraps with their arrivals, and its header
//   GET  /api/v1/pad/private/heartbeat?from=&to= the spans (unix ms) the index was up between from and to
//   On this machine only (the uploader): GET /api/v1/pad/private/listing-post/<provider>, /member-posting/<member>, /files

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, getAddress, isAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  OSTRAPAD,
  PAD_ENC_KIND,
  PAD_ENC_MAX_HEADER,
  PAD_PANEL_ROUND,
  PAD_WRAP_BYTES,
  padActionDigest,
  padCheckKemPublicKey,
  padKemMessage,
  padParseHeader,
  padRecoverSigner,
  padWrapFromBytes,
  padWrapMessage,
  readPadEvaluator,
  sha256,
} from "@ostraagent/sdk";
import type { PadIndexer, PadJobRow } from "./pad.ts";

export const SEQ_AHEAD_MS = 300_000;
export const ISSUED_WINDOW_S = 3_600;
/** A header read this soon after its job's creation was there from the start. */
export const HEADER_FRESH_MS = 10 * 60_000;
/** How long a job's order is looked for in the uploader's store before the job is taken as public. */
export const HEADER_LOOK_MS = 60 * 60_000;
/** Heartbeats: one a minute; a span continues while beats are at most BEAT_JOIN_MS apart. */
export const BEAT_JOIN_MS = 90_000;
export const BEAT_KEEP_MS = 40 * 86_400_000;
export const REGISTRATIONS_KEPT = 20;

const erc1271Abi = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }] }] as const;

export class PrivateBadRequest extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type KemRegistration = { member: Address; pk: string; pkHash: Hex; posting: Address; issuedAt: string; signature: Hex | null; vault: boolean; arrivedAt: number; arrivedBlock: string };
export type StoredWrap = { sender: Address; recipient: Address; round: number; seq: string; wrap: string; signature: Hex; arrivedAt: number; arrivedBlock: string };
type JobFile = { header: string | null; headerAt?: number; fromCreation: boolean; lookedSince: number; public: boolean; wraps: StoredWrap[] };

function writeDurable(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, Buffer.from(text));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function cidOf(digest: Hex): string {
  const all = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), Buffer.from(digest.slice(2), "hex")]);
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

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function fromB64(text: unknown, length: number, name: string): Uint8Array {
  if (typeof text !== "string" || text.length > 4 * Math.ceil(length / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new PrivateBadRequest(400, "bad_base64", `${name} must be base64 of ${length} bytes`);
  const b = new Uint8Array(Buffer.from(text, "base64"));
  if (b.length !== length) throw new PrivateBadRequest(400, "bad_base64", `${name} must be base64 of ${length} bytes`);
  return b;
}

export class PadPrivate {
  readonly #pad: PadIndexer;
  readonly #client: PublicClient;
  readonly #dir: string;
  readonly #store: string;
  readonly #chainId: number;
  readonly #padAddress: Address;
  readonly #now: () => number;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  #regs: Record<string, KemRegistration[]>;
  #beats: [number, number][];
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: { pad: PadIndexer; client: PublicClient; dir: string; store: string; chainId: number; padAddress?: Address; nowMs?: () => number; log: (event: string, fields?: Record<string, unknown>) => void }) {
    this.#pad = o.pad;
    this.#client = o.client;
    this.#dir = o.dir;
    this.#store = o.store;
    this.#chainId = o.chainId;
    this.#padAddress = getAddress(o.padAddress ?? OSTRAPAD);
    this.#now = o.nowMs ?? Date.now;
    this.#log = o.log;
    mkdirSync(join(o.dir, "jobs"), { recursive: true, mode: 0o700 });
    this.#regs = existsSync(this.#regsPath) ? (JSON.parse(readFileSync(this.#regsPath, "utf8")) as Record<string, KemRegistration[]>) : {};
    this.#beats = existsSync(this.#beatsPath) ? (JSON.parse(readFileSync(this.#beatsPath, "utf8")) as { spans: [number, number][] }).spans : [];
  }

  get #regsPath(): string {
    return join(this.#dir, "registrations.json");
  }
  get #beatsPath(): string {
    return join(this.#dir, "heartbeat.json");
  }
  #jobPath(id: Hex): string {
    return join(this.#dir, "jobs", `${id.toLowerCase()}.json`);
  }
  #readJob(id: Hex): JobFile | null {
    const p = this.#jobPath(id);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as JobFile) : null;
  }

  /** One change at a time, each written before it answers. */
  #serial<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------------------------------------------------------- heartbeat and headers

  /** One minute's work: the self-test and heartbeat, then the order headers of jobs not looked at yet. */
  tick(): Promise<void> {
    return this.#serial(async () => {
      const now = this.#now();
      let healthy = true;
      try {
        await this.#client.getBlockNumber({ cacheTime: 0 });
        readdirSync(this.#store);
        // Wraps for a new draw need the draw in the index: an index behind the chain is not healthy.
        if (!this.#pad.caughtUp()) throw new Error("the index has not read OstraPad's events to the chain's head");
      } catch (err) {
        healthy = false;
        this.#log("pad_private_selftest_failed", { reason: (err as Error).message.slice(0, 200) });
      }
      if (healthy) {
        const last = this.#beats[this.#beats.length - 1];
        if (last !== undefined && now - last[1] <= BEAT_JOIN_MS) last[1] = now;
        else this.#beats.push([now, now]);
        this.#beats = this.#beats.filter(([, end]) => now - end <= BEAT_KEEP_MS);
        writeDurable(this.#beatsPath, JSON.stringify({ spans: this.#beats }));
      }
      for (const row of this.#pad.rows()) {
        if (row.description === undefined || row.description === null || row.closedAt !== null) continue;
        const f = this.#readJob(row.id);
        if (f !== null && (f.header !== null || f.public)) continue;
        this.#lookForHeader(row, f, now);
      }
    });
  }

  #lookForHeader(row: PadJobRow, f: JobFile | null, now: number): void {
    const path = join(this.#store, cidOf(row.description as Hex));
    const job: JobFile = f ?? { header: null, fromCreation: false, lookedSince: now, public: false, wraps: [] };
    if (existsSync(path)) {
      const head = Buffer.alloc(PAD_ENC_MAX_HEADER);
      const fd = openSync(path, "r");
      let n = 0;
      try {
        n = readSync(fd, head, 0, head.length, 0);
      } finally {
        closeSync(fd);
      }
      try {
        const { header, length } = padParseHeader(new Uint8Array(head.subarray(0, n)));
        if (header.kind === PAD_ENC_KIND.order && header.order !== null) {
          job.header = b64(head.subarray(0, length));
          job.headerAt = now;
          job.fromCreation = now - row.createdAt * 1000 <= HEADER_FRESH_MS;
          writeDurable(this.#jobPath(row.id), JSON.stringify(job));
          this.#log("pad_private_job", { jobId: row.id, fromCreation: job.fromCreation });
          return;
        }
      } catch {
        // not an encrypted order: a public job
      }
      job.public = true;
    } else if (now - job.lookedSince > HEADER_LOOK_MS) job.public = true;
    writeDurable(this.#jobPath(row.id), JSON.stringify(job));
  }

  /** The spans (unix ms) the index was up that overlap [from, to]. */
  heartbeat(from: number, to: number): [number, number][] {
    return this.#beats.filter(([s, e]) => e >= from && s <= to);
  }

  start(everyMs = 60_000): void {
    const run = () => void this.tick().catch((err) => this.#log("pad_private_tick_failed", { reason: (err as Error).message.slice(0, 200) }));
    this.#timer = setInterval(run, everyMs);
    run();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
  }

  // ------------------------------------------------------------------------------------------------------------- registrations

  /** A pool member's KEM registration (see the header). */
  register(b: Record<string, unknown>): Promise<KemRegistration> {
    return this.#serial(async () => {
      if (typeof b.member !== "string" || !isAddress(b.member) || typeof b.posting !== "string" || !isAddress(b.posting)) throw new PrivateBadRequest(400, "bad_address", "member and posting must be addresses");
      const member = getAddress(b.member);
      const posting = getAddress(b.posting);
      const pk = fromB64(b.pk, 1184, "pk");
      try {
        padCheckKemPublicKey(pk);
      } catch (err) {
        throw new PrivateBadRequest(400, "bad_key", `not an ML-KEM-768 public key: ${(err as Error).message}`);
      }
      if (typeof b.issuedAt !== "string" || !/^\d{1,20}$/.test(b.issuedAt)) throw new PrivateBadRequest(400, "bad_issued_at", "issuedAt must be an L2 block number");
      const issuedAt = BigInt(b.issuedAt);
      const pkHash = bytesToHex(sha256([pk]));
      const current = this.#regs[member.toLowerCase()]?.at(-1);
      if (current !== undefined && current.pkHash === pkHash && current.posting === posting) return current;
      const [head, issuedBlock, evaluator, code] = await Promise.all([
        this.#client.getBlock({ blockTag: "latest" }),
        this.#client.getBlock({ blockNumber: issuedAt }).catch(() => null),
        readPadEvaluator(this.#client, member, this.#padAddress),
        this.#client.getCode({ address: member }),
      ]);
      if (issuedBlock === null || Math.abs(Number(head.timestamp - issuedBlock.timestamp)) > ISSUED_WINDOW_S) throw new PrivateBadRequest(400, "issued_at_out_of_window", "issuedAt must be a block of the last hour");
      if (!evaluator.inPool) throw new PrivateBadRequest(403, "not_in_pool", "only a member of OstraPad's pool registers a key");
      const message = padKemMessage({ chainId: this.#chainId, pad: this.#padAddress, member, pkHash: sha256([pk]), posting, issuedAt });
      const vault = code !== undefined && code !== "0x";
      let signature: Hex | null = null;
      if (vault) {
        // An Ostra vault approves the digest; checked at this block, the one the registration arrives in.
        const digest = padActionDigest(message, this.#padAddress, this.#chainId);
        let ok = false;
        try {
          ok = ((await this.#client.readContract({ address: member, abi: erc1271Abi, functionName: "isValidSignature", args: [digest, "0x"], blockNumber: head.number })) as string).toLowerCase() === "0x1626ba7e";
        } catch {
          ok = false;
        }
        if (!ok) throw new PrivateBadRequest(403, "not_approved", "the vault has not approved this registration's digest");
      } else {
        if (typeof b.signature !== "string") throw new PrivateBadRequest(400, "bad_signature", "an account signs its registration");
        const signer = await padRecoverSigner(message, b.signature as Hex);
        if (signer === null || signer !== member) throw new PrivateBadRequest(403, "bad_signature", "the registration is not signed by the member");
        signature = b.signature as Hex;
      }
      const reg: KemRegistration = { member, pk: b64(pk), pkHash, posting, issuedAt: issuedAt.toString(), signature, vault, arrivedAt: this.#now(), arrivedBlock: head.number.toString() };
      const list = [...(this.#regs[member.toLowerCase()] ?? []), reg].slice(-REGISTRATIONS_KEPT);
      this.#regs[member.toLowerCase()] = list;
      writeDurable(this.#regsPath, JSON.stringify(this.#regs));
      this.#log("pad_private_registered", { member, vault, pkHash });
      return reg;
    });
  }

  registrations(member: Address): KemRegistration[] {
    return this.#regs[getAddress(member).toLowerCase()] ?? [];
  }

  memberPosting(member: Address): Address | null {
    return this.registrations(member).at(-1)?.posting ?? null;
  }

  // ------------------------------------------------------------------------------------------------------------- wraps

  /** A wrap posted for a job (see the header); answers the stored wrap. */
  postWrap(jobIdIn: string, b: Record<string, unknown>): Promise<StoredWrap> {
    return this.#serial(async () => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(jobIdIn)) throw new PrivateBadRequest(400, "bad_job", "jobId must be 32 bytes");
      const jobId = jobIdIn.toLowerCase() as Hex;
      const row = this.#pad.row(jobId);
      const f = this.#readJob(jobId);
      if (row === undefined || f === null || f.header === null) throw new PrivateBadRequest(404, "not_private", "no private job with this id (or its order header is not read yet)");
      const { header } = padParseHeader(new Uint8Array(Buffer.from(f.header, "base64")));
      const order = header.order;
      if (order === null) throw new PrivateBadRequest(500, "bad_header", "the stored header is not an order's");
      const round = b.round;
      if (typeof round !== "number" || !Number.isInteger(round) || round < 1 || (round > 255 && round !== PAD_PANEL_ROUND)) throw new PrivateBadRequest(400, "bad_round", `round is an evaluator round (1 to 255) or ${PAD_PANEL_ROUND} for the panel`);
      const wrap = padWrapFromBytes(fromB64(b.wrap, PAD_WRAP_BYTES, "wrap"));
      if (typeof b.seq !== "string" || !/^\d{1,16}$/.test(b.seq)) throw new PrivateBadRequest(400, "bad_seq", "seq is unix milliseconds as a decimal string");
      const seq = BigInt(b.seq);
      const now = this.#now();
      if (seq > BigInt(now + SEQ_AHEAD_MS)) throw new PrivateBadRequest(400, "seq_ahead", "seq is more than 5 minutes ahead of this server's clock");
      let sender: Address;
      if (round === PAD_PANEL_ROUND) {
        if (row.panel === undefined || row.panel === null || !row.panel.members.includes(wrap.recipient)) throw new PrivateBadRequest(409, "not_panel", "the recipient is not on this job's appeal panel");
        if (row.appellant === undefined || row.appellant === null) throw new PrivateBadRequest(409, "no_appeal", "the job has no appeal");
        if (row.appellant === row.client) sender = order.clientPosting;
        else if (row.appellant === row.provider) sender = order.providerPosting;
        else throw new PrivateBadRequest(409, "no_appeal", "the appellant is neither client nor provider");
      } else {
        if (!(row.draws ?? []).some((d) => d.round === round && d.evaluator === wrap.recipient)) throw new PrivateBadRequest(409, "not_drawn", "the recipient was not drawn for this round");
        sender = order.providerPosting;
      }
      const reg = this.registrations(wrap.recipient).at(-1);
      if (reg === undefined || reg.pkHash !== bytesToHex(wrap.pkHash)) throw new PrivateBadRequest(409, "not_current_key", "the wrap is not to the recipient's current registration");
      const signer = await padRecoverSigner(padWrapMessage({ chainId: this.#chainId, pad: this.#padAddress, jobId, round, wrap, seq }), b.signature as Hex);
      if (signer === null || signer !== sender) throw new PrivateBadRequest(403, "bad_signature", round === PAD_PANEL_ROUND ? "a panel wrap is signed by the appellant's posting key" : "an evaluator's wrap is signed by the provider's posting key");
      const old = f.wraps.find((w) => w.sender === sender && w.recipient === wrap.recipient && w.round === round);
      if (old !== undefined && BigInt(old.seq) >= seq) throw new PrivateBadRequest(409, "stale_seq", `seq must be above ${old.seq}`);
      const bytes = b64(Buffer.from(fromB64(b.wrap, PAD_WRAP_BYTES, "wrap")));
      // The same wrap posted again (wraps are deterministic: an MCP that posts again sends the same bytes) keeps its
      // first arrival, which Ostra's panel compares with the decision; other bytes arrive now.
      const same = old !== undefined && old.wrap === bytes;
      const arrivedBlock = same ? old.arrivedBlock : (await this.#client.getBlockNumber({ cacheTime: 0 })).toString();
      const stored: StoredWrap = { sender, recipient: wrap.recipient, round, seq: seq.toString(), wrap: bytes, signature: b.signature as Hex, arrivedAt: same ? old.arrivedAt : now, arrivedBlock };
      f.wraps = [...f.wraps.filter((w) => w !== old), stored];
      writeDurable(this.#jobPath(jobId), JSON.stringify(f));
      this.#log("pad_private_wrap", { jobId, round, recipient: wrap.recipient, replaced: old !== undefined });
      return stored;
    });
  }

  /** A private job's header and wraps (null when the job is not known as private). */
  job(jobId: Hex): { header: string; headerAt: number | null; fromCreation: boolean; wraps: StoredWrap[] } | null {
    const f = this.#readJob(jobId);
    return f === null || f.header === null ? null : { header: f.header, headerAt: f.headerAt ?? null, fromCreation: f.fromCreation, wraps: f.wraps };
  }

  /** For the uploader: every job with the files it names, and whether the index is caught up with the chain. */
  files(): { caughtUp: boolean; jobs: { id: Hex; client: Address; provider: Address; pool: boolean; status: string; closedAt: number | null; description: Hex | null; deliverable: Hex | null; reasons: Hex[] }[] } {
    // Jobs read before private jobs existed carry no description field and name no encrypted file; a job whose order
    // could not be read has description null (the uploader then keeps every unnamed order).
    const jobs = this.#pad
      .rows()
      .filter((r) => r.description !== undefined)
      .map((r) => ({ id: r.id, client: r.client, provider: r.provider, pool: r.pool, status: r.status, closedAt: r.closedAt, description: r.description ?? null, deliverable: r.deliverable ?? null, reasons: r.reasons ?? [] }));
    return { caughtUp: this.#pad.caughtUp(), jobs };
  }
}
