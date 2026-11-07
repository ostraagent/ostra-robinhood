// Private jobs for Ostrapad's evaluator bot (design "Ostrapad: private job", revisions 2 to 9, decided by Edu on 6 and
// 7 Nov 2026). What the bot (pad-evaluator.ts) needs to read and judge a job whose order, delivery and reasons are
// encrypted (sdk pad-private.ts), apart from its passes:
//
//   * Reading the uploader's store: the encrypted files are read straight from the uploader's directory on this
//     machine (read only, no HTTP, revision 6), by the CID of their sha256. Only a file that is not there (ENOENT) is
//     absent; an I/O error, a file cut short or bytes that do not hash to the name are no answer yet (a sha256
//     mismatch also raises pad_alert: the operator's disk). A file read whole whose sha256 matches but that does not
//     parse, does not decrypt under a K that matches the order's keyCommit, or breaks the private job's rules (its
//     manifest names another job, a salt repeats the order's, an attachment is not UTF-8 text, a sha256 differs) is
//     the fault of the party that made it.
//   * What is kept of a decrypted file (revision 3, M4): its manifest (at most 64 KB) and the text of its attachments,
//     up to 256 KB for an order and 768 KB for a delivery (the rest is named, sized and hashed). A pool job takes text
//     attachments only (revision 7, M4; revision 8, minor 3).
//   * The index's private records (indexer pad-private.ts): KEM registrations, the job's wraps and its order header,
//     and the heartbeat spans.
//   * The rule for a rejection "for no K" (revisions 5 to 9): Ostra's panel upholds a rejection of a private job
//     without judging it afresh only when every condition holds: the decision came at or after the evaluator's late
//     point (evalStart + 42 h); the evaluator's KEM registration arrived at least 1 h before its assignment and stayed
//     current until the decision; no wrap from the provider's posting key for that registration and round arrived at
//     least 10 minutes before the decision and recomputes byte for byte under K (padVerifyWrap); the index was healthy
//     at least 1 h in all from when the provider could first wrap (the assignment, or the order's header reaching the
//     index if that was later) to 10 minutes before the decision (review rounds 9 and 10: an order uploaded late cannot
//     switch the rule off). A wrap the panel cannot recompute (the appellant, who is the provider, gave the panel no K)
//     counts as no wrap.
//   * An encrypted reason (kind 3), uploaded to the uploader's /v1/enc/ signed by the evaluator account.

import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, getAddress, hexToBytes, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import {
  PAD,
  PAD_ENC_KIND,
  PAD_ENC_MAX_FILE,
  PAD_ENC_MAX_HEADER,
  PAD_KEM_PUBLIC_KEY_BYTES,
  padActionDigest,
  padCheckKemPublicKey,
  padCheckManifest,
  padCidFromDigest,
  padEncryptFile,
  padKemMessage,
  padManifestLength,
  padNewSalt,
  padOpenFile,
  padParseHeader,
  padParseManifest,
  padPlaintextPrefix,
  padRecoverSigner,
  padUnwrapKey,
  padUploadMessage,
  padVerifyWrap,
  padWrapFromBytes,
  sha256 as sha256Parts,
  type PadEncHeader,
  type PadEncKind,
  type PadKemKeys,
  type PadWrap,
} from "@ostraagent/sdk";

/** The fixed reason of a rejection for no K (as the MCP's): nothing of the job, pinned publicly. */
export const NO_KEY_REASON = "Rejected: the delivery could not be read (no key wrap received).";
/** The most of a decrypted file's manifest kept, and of its attachments' text (revision 3, M4). */
export const KEEP_MANIFEST_BYTES = 65_536;
export const KEEP_ORDER_TEXT_BYTES = 262_144;
export const KEEP_DELIVERY_TEXT_BYTES = 786_432;
/** A registration counts for the no-K rule only when it arrived this long before the assignment (revision 6). */
export const REGISTRATION_LEAD_MS = 3_600_000;
/** A provider's wrap counts when it arrived at least this long before the decision (revision 7). */
export const WRAP_LEAD_MS = 600_000;
/** The index must have been healthy at least this long in all within the window (revision 9). */
export const HEALTHY_MS = 3_600_000;
const READ_CHUNK = 1_048_576;
const INDEX_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The file name the uploader keeps an encrypted file under: the CID (raw, sha2-256, base32) of its sha256. */
export function encFileName(digest: Hex): string {
  return padCidFromDigest(digest).slice("ipfs://".length);
}

/** An I/O failure while reading the store (no answer, never a party's fault). */
class StoreIoError extends Error {}

async function openStore(dir: string, digest: Hex): Promise<FileHandle | "absent"> {
  try {
    return await open(join(dir, encFileName(digest)), "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new StoreIoError((err as Error).message);
  }
}

async function readAt(fh: FileHandle, offset: number, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    let n: number;
    try {
      n = (await fh.read(out, got, length - got, offset + got)).bytesRead;
    } catch (err) {
      throw new StoreIoError((err as Error).message);
    }
    if (n === 0) throw new StoreIoError("the file is cut short");
    got += n;
  }
  return out;
}

async function hashFile(fh: FileHandle, size: number): Promise<Hex> {
  const h = createHash("sha256");
  for (let o = 0; o < size; o += READ_CHUNK) h.update(await readAt(fh, o, Math.min(READ_CHUNK, size - o)));
  return `0x${h.digest("hex")}`;
}

async function sizeOf(fh: FileHandle): Promise<number> {
  try {
    return (await fh.stat()).size;
  } catch (err) {
    throw new StoreIoError((err as Error).message);
  }
}

/** Whether an encrypted file is in the store with the bytes its name says. */
export type Presence = { state: "present"; size: number } | { state: "absent" } | { state: "unknown"; why: string; mismatch?: boolean };

export async function encPresence(dir: string, digest: Hex): Promise<Presence> {
  let fh: FileHandle | "absent";
  try {
    fh = await openStore(dir, digest);
  } catch (err) {
    return { state: "unknown", why: (err as Error).message };
  }
  if (fh === "absent") return { state: "absent" };
  try {
    const size = await sizeOf(fh);
    if (size > PAD_ENC_MAX_FILE) return { state: "unknown", why: "over the size limit", mismatch: true };
    const got = await hashFile(fh, size);
    return got === digest.toLowerCase() ? { state: "present", size } : { state: "unknown", why: "its bytes do not hash to its name", mismatch: true };
  } catch (err) {
    return { state: "unknown", why: (err as Error).message };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** The header of an encrypted file in the store (not hashed: for the posting addresses and keyCommit to unwrap with). */
export async function encHeader(dir: string, digest: Hex): Promise<{ state: "ok"; header: PadEncHeader } | { state: "absent" } | { state: "unknown"; why: string } | { state: "bad"; why: string }> {
  let fh: FileHandle | "absent";
  try {
    fh = await openStore(dir, digest);
  } catch (err) {
    return { state: "unknown", why: (err as Error).message };
  }
  if (fh === "absent") return { state: "absent" };
  try {
    const size = await sizeOf(fh);
    const first = await readAt(fh, 0, Math.min(PAD_ENC_MAX_HEADER, size));
    try {
      return { state: "ok", header: padParseHeader(first).header };
    } catch (err) {
      return { state: "bad", why: (err as Error).message };
    }
  } catch (err) {
    return { state: "unknown", why: (err as Error).message };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** An attachment as kept: its text when it is text (cut at the file's limit, `truncated`), else only what names it. */
export type KeptAttachment = { name: string; size: number; sha256: Hex; type: "text" | "binary"; text?: string; truncated?: true };
/** A decrypted file as kept: its manifest's fields (the order's, the delivery's, the reason's) and its attachments. */
export type KeptPlain = Record<string, unknown> & { attachments: KeptAttachment[] };

export type OpenResult =
  | { state: "ok"; plain: KeptPlain; header: PadEncHeader }
  | { state: "absent" }
  | { state: "unknown"; why: string; mismatch?: boolean }
  | { state: "bad"; why: string };

/** The job a file belongs to, for the manifest's binding (padCheckManifest). */
export type PrivateJobRef = { id: Hex; client: Address; provider: Address; chainId: number };

/**
 * Reads, checks and decrypts an encrypted file of `kind` from the store with K (already matched to keyCommit): the
 * whole file is hashed first and must hash to `digest`, then each segment is authenticated as it is read; the manifest
 * is bound to the job, every attachment's size and sha256 checked, and only what is kept (above) is returned.
 * `orderSalt`: the order's salt, which a delivery's or reason's may not repeat.
 */
export async function openEncFile(o: { dir: string; digest: Hex; kind: PadEncKind; k: Uint8Array; keyCommit: Uint8Array; job: PrivateJobRef; orderSalt?: Uint8Array; textBytes: number }): Promise<OpenResult> {
  let fh: FileHandle | "absent";
  try {
    fh = await openStore(o.dir, o.digest);
  } catch (err) {
    return { state: "unknown", why: (err as Error).message };
  }
  if (fh === "absent") return { state: "absent" };
  const handle = fh;
  try {
    const size = await sizeOf(handle);
    if (size > PAD_ENC_MAX_FILE) return { state: "unknown", why: "over the size limit", mismatch: true };
    if ((await hashFile(handle, size)) !== o.digest.toLowerCase()) return { state: "unknown", why: "its bytes do not hash to its name", mismatch: true };
    // From here the bytes are the ones the job names: anything wrong with them is the fault of the party that made them,
    // except an I/O failure.
    try {
      return await decryptKept(handle, size, o);
    } catch (err) {
      if (err instanceof StoreIoError) return { state: "unknown", why: err.message };
      return { state: "bad", why: (err as Error).message };
    }
  } catch (err) {
    return { state: "unknown", why: (err as Error).message };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function decryptKept(fh: FileHandle, size: number, o: { kind: PadEncKind; k: Uint8Array; keyCommit: Uint8Array; job: PrivateJobRef; orderSalt?: Uint8Array; textBytes: number }): Promise<OpenResult> {
  const opened = await padOpenFile(o.k, o.keyCommit, { size, read: (offset, length) => readAt(fh, offset, length) });
  const header = opened.header;
  if (header.kind !== o.kind) throw new Error(`the file is of kind ${header.kind}, not ${o.kind}`);
  if (o.orderSalt !== undefined && bytesToHex(header.salt) === bytesToHex(o.orderSalt)) throw new Error("the file repeats the order's salt");
  const total = header.plaintextLength;
  // The plaintext as it comes: the manifest's length, the manifest, then each attachment in order.
  let pending = new Uint8Array(0);
  let manifestLength = -1;
  let parsed: ReturnType<typeof padParseManifest> | null = null;
  const kept: KeptAttachment[] = [];
  let index = 0;
  let left = 0;
  let hash = createHash("sha256");
  let decoder = new TextDecoder("utf-8", { fatal: true });
  let textRoom = o.textBytes;
  let consumed = 0;
  const startAttachment = () => {
    while (parsed !== null && index < parsed.attachments.length && parsed.attachments[index]!.size === 0) finishAttachment();
    if (parsed !== null && index < parsed.attachments.length) {
      const a = parsed.attachments[index]!;
      left = a.size;
      hash = createHash("sha256");
      decoder = new TextDecoder("utf-8", { fatal: true });
      kept.push({ name: a.name, size: a.size, sha256: a.sha256, type: a.type, ...(a.type === "text" ? { text: "" } : {}) });
    }
  };
  const finishAttachment = () => {
    const a = parsed!.attachments[index]!;
    if (a.size === 0) kept.push({ name: a.name, size: 0, sha256: a.sha256, type: a.type, ...(a.type === "text" ? { text: "" } : {}) });
    const got = a.size === 0 ? `0x${createHash("sha256").digest("hex")}` : `0x${hash.digest("hex")}`;
    if (got !== a.sha256) throw new Error(`attachment ${a.name}: its bytes do not match its sha256`);
    if (a.type === "text") {
      const k = kept[kept.length - 1]!;
      try {
        if (a.size > 0) {
          const tail = decoder.decode();
          if (k.truncated !== true) k.text = (k.text ?? "") + tail;
        }
      } catch {
        throw new Error(`attachment ${a.name} is not valid UTF-8 text`);
      }
    }
    index++;
  };
  const feed = (chunk: Uint8Array) => {
    let at = 0;
    while (at < chunk.length) {
      if (parsed === null) {
        // The manifest's length and the manifest.
        const need = manifestLength < 0 ? 4 : 4 + manifestLength;
        const take = Math.min(need - pending.length, chunk.length - at);
        const next = new Uint8Array(pending.length + take);
        next.set(pending, 0);
        next.set(chunk.subarray(at, at + take), pending.length);
        pending = next;
        at += take;
        if (manifestLength < 0 && pending.length === 4) manifestLength = padManifestLength(pending);
        if (manifestLength >= 0 && pending.length === 4 + manifestLength) {
          if (manifestLength > KEEP_MANIFEST_BYTES) throw new Error("the manifest is over the limit");
          parsed = padParseManifest(total, pending.subarray(4), { pool: true });
          padCheckManifest(parsed.manifest, o.kind, o.job);
          startAttachment();
        }
        continue;
      }
      if (index >= parsed.attachments.length) throw new Error("bytes after the last attachment");
      const a = parsed.attachments[index]!;
      const take = Math.min(left, chunk.length - at);
      const part = chunk.subarray(at, at + take);
      hash.update(part);
      if (a.type === "text") {
        let text: string;
        try {
          text = decoder.decode(part, { stream: true });
        } catch {
          throw new Error(`attachment ${a.name} is not valid UTF-8 text`);
        }
        const k = kept[kept.length - 1]!;
        if (k.truncated !== true) {
          const bytes = Buffer.byteLength(text, "utf8");
          if (bytes <= textRoom) {
            k.text = (k.text ?? "") + text;
            textRoom -= bytes;
          } else {
            // Cut at a character, within what is left of the room.
            let cut = "";
            let used = 0;
            for (const ch of text) {
              const b = Buffer.byteLength(ch, "utf8");
              if (used + b > textRoom) break;
              cut += ch;
              used += b;
            }
            k.text = (k.text ?? "") + cut;
            textRoom -= used;
            k.truncated = true;
          }
        }
      }
      left -= take;
      at += take;
      if (left === 0) {
        finishAttachment();
        startAttachment();
      }
    }
  };
  for await (const seg of opened.segments()) {
    consumed += seg.length;
    feed(seg);
  }
  if (consumed !== total) throw new Error("the plaintext's length differs from its header");
  if (parsed === null) throw new Error("the plaintext ends before its manifest");
  const p = parsed as ReturnType<typeof padParseManifest>;
  if (index !== p.attachments.length) throw new Error("the plaintext ends before its last attachment");
  const { attachments: _drop, ...fields } = p.manifest;
  return { state: "ok", plain: { ...fields, attachments: kept }, header };
}

// ------------------------------------------------------------------------------------------------------------- the index

export type KemRegistration = { member: Address; pk: string; pkHash: Hex; posting: Address; issuedAt: string; signature: Hex | null; vault: boolean; arrivedAt: number; arrivedBlock: string };
export type StoredWrap = { sender: Address; recipient: Address; round: number; seq: string; wrap: string; signature: Hex; arrivedAt: number; arrivedBlock: string };
export type PrivateJobRecord = { header: string; headerAt: number | null; fromCreation: boolean; wraps: StoredWrap[] };

/** The index's private records, as the bot reads them; each read is null when the index gives no answer. */
export type PadPrivateIndex = {
  /** The job's header and wraps; "public" when the index does not know it as private. */
  job(jobId: Hex): Promise<PrivateJobRecord | "public" | null>;
  /** A member's registrations, oldest first, the last one current. */
  registrations(member: Address): Promise<KemRegistration[] | null>;
  /** The spans (unix ms) the index was up within [from, to]. */
  heartbeat(from: number, to: number): Promise<[number, number][] | null>;
  /** Registers a key (the index's answer: true when it took it or holds it, else the reason it refused). */
  register(body: Record<string, unknown>): Promise<true | string>;
};

/** The index over HTTP (indexer http.ts, /api/v1/pad/private/), `base` its origin (http://127.0.0.1:4900 on this host). */
export function httpPrivateIndex(base: string, f: typeof fetch = fetch): PadPrivateIndex {
  const root = `${base.replace(/\/+$/, "")}/api/v1/pad/private`;
  const get = async (path: string): Promise<{ status: number; body: unknown } | null> => {
    try {
      const res = await f(`${root}/${path}`, { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS), redirect: "error" });
      const body = (await res.json().catch(() => null)) as unknown;
      return { status: res.status, body };
    } catch {
      return null;
    }
  };
  return {
    async job(jobId) {
      const r = await get(`wraps/${jobId}`);
      if (r === null) return null;
      if (r.status === 404 && (r.body as { error?: unknown } | null)?.error === "not_private") return "public";
      if (r.status !== 200 || typeof r.body !== "object" || r.body === null) return null;
      const b = r.body as { header?: unknown; headerAt?: unknown; fromCreation?: unknown; wraps?: unknown };
      if (typeof b.header !== "string" || typeof b.fromCreation !== "boolean" || !Array.isArray(b.wraps)) return null;
      return { header: b.header, headerAt: typeof b.headerAt === "number" ? b.headerAt : null, fromCreation: b.fromCreation, wraps: b.wraps as StoredWrap[] };
    },
    async registrations(member) {
      const r = await get(`kem/${member}`);
      if (r === null || r.status !== 200) return null;
      const regs = (r.body as { registrations?: unknown } | null)?.registrations;
      return Array.isArray(regs) ? (regs as KemRegistration[]) : null;
    },
    async heartbeat(from, to) {
      const r = await get(`heartbeat?from=${Math.floor(from)}&to=${Math.floor(to)}`);
      if (r === null || r.status !== 200) return null;
      const spans = (r.body as { spans?: unknown } | null)?.spans;
      return Array.isArray(spans) ? (spans as [number, number][]) : null;
    },
    async register(body) {
      try {
        const res = await f(`${root}/kem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(INDEX_TIMEOUT_MS), redirect: "error" });
        const out = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
        return res.status === 200 ? true : String(out.message ?? out.error ?? res.status);
      } catch (err) {
        return (err as Error).message;
      }
    },
  };
}

/** K from the index's wraps to any of the bot's accounts (each under its own KEM key), matched to keyCommit; else null. */
export function keyFromWraps(wraps: readonly StoredWrap[], keys: ReadonlyMap<Address, PadKemKeys>, keyCommit: Uint8Array): Uint8Array | null {
  for (const s of wraps) {
    let w: PadWrap;
    try {
      w = padWrapFromBytes(new Uint8Array(Buffer.from(s.wrap, "base64")));
    } catch {
      continue;
    }
    const mine = keys.get(getAddress(w.recipient));
    if (mine === undefined) continue;
    const k = padUnwrapKey(w, w.recipient, mine, keyCommit);
    if (k !== null) return k;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------- the no-K rule

/**
 * What the rule for a rejection "for no K" needs, read from the index once the job is decided (a snapshot kept until
 * the job is finished): `base` whether every condition but the wraps' holds, why not, and the provider's wraps that
 * arrived in time, with the registration's key they would be checked against.
 */
export type UpholdSnapshot = { base: boolean; why: string; pk: string | null; wraps: string[] };

/** Sums the parts of `spans` inside [from, to]. */
export function healthyMs(spans: readonly [number, number][], from: number, to: number): number {
  // Spans may overlap at their joins: merged first.
  const clipped = spans.map(([s, e]) => [Math.max(s, from), Math.min(e, to)] as [number, number]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const sp of clipped) {
    if (cur !== null && sp[0] <= cur[1]) cur[1] = Math.max(cur[1], sp[1]);
    else {
      if (cur !== null) total += cur[1] - cur[0];
      cur = [sp[0], sp[1]];
    }
  }
  if (cur !== null) total += cur[1] - cur[0];
  return total;
}

/**
 * The snapshot of the rule for the rejection of round `round` by `evaluator` (decided at `decidedAt`, assigned at
 * `assignedAt`, evaluation from `evalStart`, seconds); the provider's posting address is the order header's, as the
 * index holds it (the header it took wraps by). Null when the index or the chain gives no answer (read again later).
 */
export async function upholdSnapshot(o: {
  index: PadPrivateIndex;
  client: PublicClient;
  chainId: number;
  pad: Address;
  jobId: Hex;
  round: number;
  evaluator: Address;
  assignedAt: bigint;
  evalStart: bigint;
  decidedAt: bigint;
}): Promise<UpholdSnapshot | null> {
  const decidedMs = Number(o.decidedAt) * 1000;
  const assignedMs = Number(o.assignedAt) * 1000;
  if (o.decidedAt < o.evalStart + PAD.EVAL_WINDOW - 6n * 3600n) return { base: false, why: LATE_POINT_WHY, pk: null, wraps: [] };
  const [record, regs, spans] = await Promise.all([o.index.job(o.jobId), o.index.registrations(o.evaluator), o.index.heartbeat(assignedMs, decidedMs - WRAP_LEAD_MS)]);
  if (record === null || regs === null || spans === null) return null;
  const vaultApproved = async (digest: Hex, block: bigint): Promise<boolean | null> => {
    try {
      return ((await o.client.readContract({ address: o.evaluator, abi: erc1271Abi, functionName: "isValidSignature", args: [digest, "0x"], blockNumber: block })) as string).toLowerCase() === "0x1626ba7e";
    } catch {
      return null;
    }
  };
  return upholdFromRecords({ ...o, record, regs, spans, vaultApproved });
}

const LATE_POINT_WHY = "the rejection came before the evaluator's late point (evalStart + 42 h)";

/**
 * upholdSnapshot's rule on what the index holds (the job's record, the evaluator's registrations, the heartbeat spans
 * within [assignment, decision - 10 min]); `vaultApproved` reads a vault's isValidSignature at a block (null: no
 * answer, and then no snapshot).
 */
export async function upholdFromRecords(o: {
  chainId: number;
  pad: Address;
  round: number;
  evaluator: Address;
  assignedAt: bigint;
  evalStart: bigint;
  decidedAt: bigint;
  record: PrivateJobRecord | "public";
  regs: readonly KemRegistration[];
  spans: readonly [number, number][];
  vaultApproved: (digest: Hex, block: bigint) => Promise<boolean | null>;
}): Promise<UpholdSnapshot | null> {
  const no = (why: string): UpholdSnapshot => ({ base: false, why, pk: null, wraps: [] });
  const decidedMs = Number(o.decidedAt) * 1000;
  const assignedMs = Number(o.assignedAt) * 1000;
  const { record, regs, spans } = o;
  if (o.decidedAt < o.evalStart + PAD.EVAL_WINDOW - 6n * 3600n) return no(LATE_POINT_WHY);
  if (record === "public") return no("the index does not know the job as private");
  // The provider could wrap from when both the draw and the order's header were in the index: the index must have been
  // healthy at least an hour in all from then to 10 minutes before the decision (review round 10, R10-B1: an order
  // uploaded after the draw starts that hour late, it does not switch the rule off).
  if (record.headerAt === null) return no("the index holds no time for the job's order header");
  const wrappableMs = Math.max(assignedMs, record.headerAt);
  let providerPosting: Address;
  try {
    const h = padParseHeader(new Uint8Array(Buffer.from(record.header, "base64"))).header;
    if (h.order === null) return no("the index's header of the job is not an order's");
    providerPosting = h.order.providerPosting;
  } catch {
    return no("the index's header of the job does not parse");
  }
  // The registration current at the assignment, arrived at least an hour before it, and still current at the decision.
  let at = -1;
  for (let i = 0; i < regs.length; i++) if (regs[i]!.arrivedAt <= assignedMs - REGISTRATION_LEAD_MS) at = i;
  if (at < 0) return no("the evaluator had no KEM registration an hour before its assignment");
  const reg = regs[at]!;
  const next = regs[at + 1];
  if (next !== undefined && next.arrivedAt <= decidedMs) return no("the evaluator's KEM registration changed before the decision");
  // Valid as the provider's MCP must find it (revision 7, R6-B2).
  let pk: Uint8Array;
  try {
    pk = new Uint8Array(Buffer.from(reg.pk, "base64"));
    if (pk.length !== PAD_KEM_PUBLIC_KEY_BYTES) return no("the evaluator's registered key is not an ML-KEM-768 key");
    padCheckKemPublicKey(pk);
  } catch {
    return no("the evaluator's registered key is not an ML-KEM-768 key");
  }
  if (bytesToHex(sha256Parts([pk])) !== reg.pkHash.toLowerCase()) return no("the registration's key hash differs from its key");
  if (getAddress(reg.member) !== getAddress(o.evaluator)) return no("the registration is another member's");
  const message = padKemMessage({ chainId: o.chainId, pad: o.pad, member: o.evaluator, pkHash: sha256Parts([pk]), posting: getAddress(reg.posting), issuedAt: BigInt(reg.issuedAt) });
  if (reg.vault) {
    const ok = await o.vaultApproved(padActionDigest(message, o.pad, o.chainId), BigInt(reg.arrivedBlock));
    if (ok === null) return null;
    if (!ok) return no("the evaluator vault's registration was not approved at the block it arrived in");
  } else if (reg.signature === null || (await padRecoverSigner(message, reg.signature)) !== getAddress(o.evaluator)) return no("the registration is not signed by the evaluator");
  if (healthyMs(spans, wrappableMs, decidedMs - WRAP_LEAD_MS) < HEALTHY_MS) return no("the index was healthy less than an hour in all between when the provider could first wrap (the assignment, or the order's header reaching the index if later) and the decision");
  const wraps = record.wraps
    .filter((w) => getAddress(w.sender) === providerPosting && getAddress(w.recipient) === getAddress(o.evaluator) && w.round === o.round && w.arrivedAt <= decidedMs - WRAP_LEAD_MS)
    .map((w) => w.wrap);
  return { base: true, why: "", pk: reg.pk, wraps };
}

/**
 * The rule's answer from its snapshot and the panel's K (null when the panel holds none): uphold the rejection, or
 * judge afresh (why). A wrap that recomputes under K means the evaluator could read the job; one that cannot be
 * recomputed (no K) counts as none, since the appellant (the provider) gives the panel its K.
 */
export function upholdNoKey(s: UpholdSnapshot, k: Uint8Array | null, keyCommit: Uint8Array | null, ctx: { chainId: number; pad: Address; jobId: Hex; round: number; evaluator: Address }): { uphold: boolean; why: string } {
  if (!s.base || s.pk === null) return { uphold: false, why: s.why };
  if (k === null || keyCommit === null) return { uphold: true, why: s.wraps.length === 0 ? "no wrap from the provider reached the evaluator's key before the decision" : "the provider's wraps could not be checked: the appellant gave the panel no key" };
  const pk = new Uint8Array(Buffer.from(s.pk, "base64"));
  for (const b64 of s.wraps) {
    let w: PadWrap;
    try {
      w = padWrapFromBytes(new Uint8Array(Buffer.from(b64, "base64")));
    } catch {
      continue;
    }
    if (padVerifyWrap(k, keyCommit, w, ctx.evaluator, pk, { chainId: ctx.chainId, pad: ctx.pad, jobId: ctx.jobId, round: ctx.round })) return { uphold: false, why: "the provider's wrap to the evaluator arrived before the decision and recomputes under the job's key" };
  }
  return { uphold: true, why: s.wraps.length === 0 ? "no wrap from the provider reached the evaluator's key before the decision" : "no wrap from the provider recomputes under the job's key" };
}

const erc1271Abi = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }] }] as const;

// ------------------------------------------------------------------------------------------------------------- reasons and keys

/** The bot account's KEM registration body for the index (an account signs it itself; its posting address is its own). */
export async function registrationBody(account: PrivateKeyAccount, keys: PadKemKeys, issuedAt: bigint, chainId: number, pad: Address): Promise<Record<string, unknown>> {
  const message = padKemMessage({ chainId, pad, member: account.address, pkHash: sha256Parts([keys.publicKey]), posting: account.address, issuedAt });
  return { member: getAddress(account.address), pk: Buffer.from(keys.publicKey).toString("base64"), posting: getAddress(account.address), issuedAt: issuedAt.toString(), signature: await account.signMessage({ message: { raw: message } }) };
}

/** The encrypted reason file (kind 3) of a decision, under K. */
export function sealReason(k: Uint8Array, jobId: Hex, approve: boolean, reason: string): Uint8Array {
  const prefix = padPlaintextPrefix({ type: "ostrapad-decision-v1", job: jobId, approve, reason });
  return padEncryptFile(k, { kind: PAD_ENC_KIND.reason, salt: padNewSalt(), plaintextLength: prefix.length, order: null }, prefix);
}

/**
 * Uploads an encrypted reason to the uploader's /v1/enc/ (one chunk: a reason is small), signed by the evaluator
 * account; its sha256, or null when it was not kept.
 */
export async function uploadReason(uploader: string, account: PrivateKeyAccount, chainId: number, pad: Address, jobId: Hex, file: Uint8Array, f: typeof fetch = fetch): Promise<Hex | null> {
  const digest = bytesToHex(sha256Parts([file]));
  const base = `${uploader.replace(/\/+$/, "")}/v1/enc/uploads`;
  const json = async (url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> } | null> => {
    try {
      const res = await f(url, { ...init, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS), redirect: "error" });
      return { status: res.status, body: ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
    } catch {
      return null;
    }
  };
  const signature = await account.signMessage({ message: { raw: padUploadMessage({ chainId, pad, jobId, kind: PAD_ENC_KIND.reason, sha256: digest, size: BigInt(file.length) }) } });
  const begin = await json(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: file.length, sha256: digest, kind: PAD_ENC_KIND.reason, jobId, signature }) });
  if (begin === null || begin.status !== 200) return null;
  if (typeof begin.body.uri === "string") return digest;
  if (typeof begin.body.id !== "string") return null;
  const put = await f(`${base}/${begin.body.id}/0`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS), redirect: "error" }).catch(() => null);
  await put?.body?.cancel().catch(() => undefined);
  if (put === null || !put.ok) return null;
  const done = await json(`${base}/${begin.body.id}/done`, { method: "POST" });
  return done !== null && done.status === 200 && typeof done.body.uri === "string" ? digest : null;
}

/** K as kept on disk (with the order's keyCommit and salt, from its header), and back. */
export type KeptKey = { k: Uint8Array; keyCommit: Uint8Array; orderSalt: Uint8Array; providerPosting: Address };
export function keyToText(x: KeptKey): string {
  return JSON.stringify({ k: bytesToHex(x.k), keyCommit: bytesToHex(x.keyCommit), orderSalt: bytesToHex(x.orderSalt), providerPosting: x.providerPosting });
}
export function keyFromText(t: string): KeptKey | null {
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    const k = hexToBytes(o.k as Hex);
    const keyCommit = hexToBytes(o.keyCommit as Hex);
    const orderSalt = hexToBytes(o.orderSalt as Hex);
    if (k.length !== 32 || keyCommit.length !== 32 || orderSalt.length !== 32) return null;
    return { k, keyCommit, orderSalt, providerPosting: getAddress(o.providerPosting as string) };
  } catch {
    return null;
  }
}
