// The Ostra uploader: pins what an agent publishes about itself and its launches to IPFS, through the
// operator's Pinata account, and answers with its ipfs:// URI. Served behind nginx on the relayer's host
// (/v1/ipfs/), which also limits the request rate per address.
//
//   POST /v1/ipfs/image   the image bytes (PNG, JPEG, WebP or GIF, checked by their first bytes; at most
//                         MAX_IMAGE_BYTES), Content-Type the image's type
//   POST /v1/ipfs/json    a JSON object of at most MAX_JSON_BYTES (a profile, an ERC-8004 registration file
//                         or a token's metadata)
//   POST /v1/ipfs/agent-card   {"agentId": "<decimal>" | null}: the Ostra agent card of that agent (sdk
//                         agent-card.ts), built here, so only Ostra's card is ever pinned as SVG; a card pinned before is
//                         answered again without pinning
//   GET  /v1/ipfs/health  how much of today's budget is used
//   GET  /v1/ipfs/<cid>   the bytes a raw CIDv1 (sha2-256, in its one canonical spelling) names, at most
//                         MAX_READ_BYTES, from the files kept here. A file not kept is read from the public gateways
//                         (UPSTREAM_GATEWAYS, one at a time, a gateway that answered 429 left until its retry-after)
//                         and kept only for a caller on this machine (a loopback address and no X-Forwarded-For: Ostra's
//                         indexer and evaluator bot); a caller through nginx gets 404 for it, so no one outside can
//                         make this server fetch and keep files, or spend its standing at the public gateways. Public
//                         gateways answer 429 to a server that reads often (ipfs.io and dweb.link on 23 Oct 2026,
//                         Pinata's too on 28 Oct 2026), so Ostra's services and agents read what Ostra pinned here;
//                         the bytes are checked against the CID here and again by every reader, so this server cannot
//                         change what a CID names
//
// The web app (https://app.ostraagent.xyz) uploads from the browser: its origin gets CORS and its preflight is
// answered 204 (merchant/src/cors.ts); the limits below are the same for it.
//
// Answers are { cid, uri } or { error: <code>, message }. What is pinned is kept in the store (one file per CID,
// its bytes checked against the CID first: public files, no keys). What an address uploads is counted
// (UPLOADS_PER_HOUR per address) and the bytes of a day are capped (the daily budget), so the operator's pinning
// quota cannot be drained. The Pinata key only adds pins (pinFileToIPFS). A JSON object is pinned as a file of the
// exact bytes JSON.stringify writes (CIDv1, so the CID is the raw sha2-256 of those bytes, as for an image), so what
// is kept here is what was pinned, byte for byte.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { applyCors } from "../../merchant/src/cors.ts";
import { AGENT_CARD_TYPE, agentCardSvg } from "../../sdk/src/agent-card.ts";

export const MAX_IMAGE_BYTES = 1_048_576;
export const MAX_JSON_BYTES = 16_384;
export const UPLOADS_PER_HOUR = 30;
export const PINATA_API = "https://api.pinata.cloud/pinning";
/** The largest file served (an image, the largest thing pinned here). */
export const MAX_READ_BYTES = MAX_IMAGE_BYTES;
/** Where a file not kept here is read from, in order. */
export const UPSTREAM_GATEWAYS: readonly string[] = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];
/** Time one gateway is given for one file. */
export const UPSTREAM_TIMEOUT_MS = 20_000;
/** At least this long between two reads from the public gateways (they answer 429 to a server that reads often). */
export const UPSTREAM_SPACING_MS = 1_000;
/** A raw CIDv1 with a sha2-256 multihash, base32: "b" and 58 letters. */
const RAW_CID = /^b[a-z2-7]{58}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The sha2-256 a raw CIDv1 names; null for any other CID. */
export function rawCidDigest(cid: string): Buffer | null {
  if (!RAW_CID.test(cid)) return null;
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
  // version 1, codec raw (0x55), multihash sha2-256 (0x12) of 32 bytes (0x20)
  if (out.length !== 36 || out[0] !== 0x01 || out[1] !== 0x55 || out[2] !== 0x12 || out[3] !== 0x20) return null;
  const digest = Buffer.from(out.slice(4));
  // The last letter carries 2 padding bits: only the spelling that sets them to zero names the file.
  return rawCidOfDigest(digest) === cid ? digest : null;
}

/** The raw CIDv1 (sha2-256) of `bytes`. */
export function rawCidOf(bytes: Uint8Array): string {
  return rawCidOfDigest(createHash("sha256").update(bytes).digest());
}

/** The raw CIDv1 naming a sha2-256 digest. */
function rawCidOfDigest(digest: Uint8Array): string {
  const all = [0x01, 0x55, 0x12, 0x20, ...digest];
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

/** A file read: its bytes, or why there are none (no gateway has it, or every gateway refused just now). */
export type FileRead = { bytes: Uint8Array } | { missing: true } | { refused: true; retryAfterSeconds: number };

export class UploadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Whether the bytes are an SVG document (the agent cards pinned here). A file served from here with this type also
 * carries a policy that runs nothing in it (SVG_POLICY), whatever SVG it is.
 */
export function isSvg(b: Uint8Array): boolean {
  return Buffer.from(b.subarray(0, 64)).toString("utf8").startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"");
}
/** The Content-Security-Policy an SVG is served with: no script, no fetch, no navigation; its own inline styles only. */
export const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** The image type the bytes start with, or null. */
export function sniffImage(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
}

export type UploaderOptions = {
  /** The Pinata JWT (never logged). */
  jwt: string;
  /** Bytes pinned per UTC day, at most. */
  dailyBytes: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  fetch?: typeof fetch;
  /** The directory files are kept in (one per CID); null keeps nothing and reads every time from upstream. */
  store?: string | null;
  /** The gateways a file not kept is read from (default UPSTREAM_GATEWAYS). */
  upstream?: readonly string[];
};

export class Uploader {
  readonly #o: UploaderOptions;
  readonly #perAddress = new Map<string, number[]>();
  #day = "";
  #dayBytes = 0;
  /** Gateways that answered 429, and until when they are left alone. */
  readonly #blocked = new Map<string, number>();
  /** Reads in flight by CID: a second request for the same file waits for the first. */
  readonly #reading = new Map<string, Promise<FileRead>>();
  /** The upstream reads, one after another, UPSTREAM_SPACING_MS apart. */
  #upstreamQueue: Promise<unknown> = Promise.resolve();
  #lastUpstream = 0;

  constructor(o: UploaderOptions) {
    if (o.jwt.length < 20) throw new Error("the Pinata JWT is missing");
    this.#o = o;
    if (o.store !== undefined && o.store !== null) mkdirSync(o.store, { recursive: true, mode: 0o700 });
  }

  /**
   * Keeps `bytes` as the file of `cid` when they are what it names (written atomically; a file there with other bytes
   * is written again); false when not kept. A failure to write (a full or read-only disk) is logged, never thrown: what
   * was pinned or read is still answered.
   */
  keep(cid: string, bytes: Uint8Array): boolean {
    const store = this.#o.store;
    const digest = rawCidDigest(cid);
    if (store === undefined || store === null || digest === null || !createHash("sha256").update(bytes).digest().equals(digest)) return false;
    if (this.#kept(cid) !== null) return true;
    const path = join(store, cid);
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, path);
      return true;
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // nothing more to do
      }
      this.#o.log?.("keep_failed", { cid, reason: (err as Error).message.slice(0, 200) });
      return false;
    }
  }

  /** The file a raw CID names: kept here, else (`upstream`, the default) read from upstream and kept. */
  file(cid: string, o: { upstream?: boolean } = {}): Promise<FileRead> {
    if (rawCidDigest(cid) === null) return Promise.resolve({ missing: true });
    const kept = this.#kept(cid);
    if (kept !== null) return Promise.resolve({ bytes: kept });
    if (o.upstream === false) return Promise.resolve({ missing: true });
    const running = this.#reading.get(cid);
    if (running !== undefined) return running;
    const read = this.#upstream(cid).finally(() => this.#reading.delete(cid));
    this.#reading.set(cid, read);
    return read;
  }

  #kept(cid: string): Uint8Array | null {
    const store = this.#o.store;
    if (store === undefined || store === null) return null;
    const path = join(store, cid);
    let bytes: Buffer;
    try {
      if (!existsSync(path)) return null;
      bytes = readFileSync(path);
    } catch (err) {
      this.#o.log?.("kept_unreadable", { cid, reason: (err as Error).message.slice(0, 200) });
      return null;
    }
    // A file changed on disk is not served (and is read again from upstream).
    return createHash("sha256").update(bytes).digest().equals(rawCidDigest(cid) as Buffer) ? new Uint8Array(bytes) : null;
  }

  #upstream(cid: string): Promise<FileRead> {
    const run = this.#upstreamQueue.then(async (): Promise<FileRead> => {
      const digest = rawCidDigest(cid) as Buffer;
      let refusedFor = 0;
      let refusedAll = true;
      for (const gateway of this.#o.upstream ?? UPSTREAM_GATEWAYS) {
        const until = this.#blocked.get(gateway) ?? 0;
        if (Date.now() < until) {
          refusedFor = Math.max(refusedFor, Math.ceil((until - Date.now()) / 1000));
          continue;
        }
        const wait = this.#lastUpstream + UPSTREAM_SPACING_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        this.#lastUpstream = Date.now();
        try {
          const res = await (this.#o.fetch ?? fetch)(`${gateway}${cid}`, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: "error" });
          if (res.status === 429) {
            const after = Number(res.headers.get("retry-after") ?? "60");
            const seconds = Number.isFinite(after) && after > 0 ? Math.min(after, 3_600) : 60;
            this.#blocked.set(gateway, Date.now() + seconds * 1000);
            refusedFor = Math.max(refusedFor, seconds);
            this.#o.log?.("upstream_refused", { gateway: new URL(gateway).host, status: 429, retryAfterSeconds: seconds });
            await res.body?.cancel().catch(() => {});
            continue;
          }
          refusedAll = false;
          if (!res.ok || res.body === null) {
            await res.body?.cancel().catch(() => {});
            continue;
          }
          const bytes = await readCapped(res, MAX_READ_BYTES);
          if (bytes === null || !createHash("sha256").update(bytes).digest().equals(digest)) continue;
          this.keep(cid, bytes);
          this.#o.log?.("read_upstream", { gateway: new URL(gateway).host, cid, bytes: bytes.length });
          return { bytes };
        } catch {
          refusedAll = false;
        }
      }
      return refusedAll && refusedFor > 0 ? { refused: true, retryAfterSeconds: refusedFor } : { missing: true };
    });
    this.#upstreamQueue = run.catch(() => undefined);
    return run;
  }

  health(): { day: string; bytesUsed: number; dailyBytes: number } {
    this.#roll();
    return { day: this.#day, bytesUsed: this.#dayBytes, dailyBytes: this.#o.dailyBytes };
  }

  #roll(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#dayBytes = 0;
    }
  }

  /** Counts an upload of `bytes` from `address`; throws when the address or the day is over its limit. */
  admit(address: string, bytes: number): void {
    this.#roll();
    const now = Date.now();
    const recent = (this.#perAddress.get(address) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= UPLOADS_PER_HOUR) throw new UploadError(429, "too_many_uploads", `at most ${UPLOADS_PER_HOUR} uploads an hour from one address`);
    if (this.#dayBytes + bytes > this.#o.dailyBytes) throw new UploadError(503, "daily_budget_used", "today's upload budget is used; try again tomorrow (UTC)");
    recent.push(now);
    this.#perAddress.set(address, recent);
    this.#dayBytes += bytes;
    if (this.#perAddress.size > 10_000) {
      for (const [k, v] of this.#perAddress) if (v.every((t) => now - t >= 3_600_000)) this.#perAddress.delete(k);
    }
  }

  async #pin(path: string, body: FormData): Promise<string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#o.jwt}` };
    const res = await (this.#o.fetch ?? fetch)(`${PINATA_API}/${path}`, { method: "POST", headers, body, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let cid: unknown;
    try {
      cid = (JSON.parse(text) as { IpfsHash?: unknown }).IpfsHash;
    } catch {
      cid = undefined;
    }
    if (!res.ok || typeof cid !== "string" || !/^[A-Za-z0-9]{40,100}$/.test(cid)) {
      this.#o.log?.("pin_failed", { path, status: res.status, body: text.slice(0, 200) });
      throw new UploadError(502, "pin_failed", "the pinning service refused the upload");
    }
    return cid;
  }

  async image(bytes: Uint8Array, declaredType: string): Promise<{ cid: string; uri: string }> {
    if (bytes.length === 0) throw new UploadError(400, "empty", "the image is empty");
    const type = sniffImage(bytes);
    if (type === null || type !== declaredType.split(";")[0]?.trim().toLowerCase()) throw new UploadError(415, "not_an_image", "send a PNG, JPEG, WebP or GIF with its Content-Type");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), `ostra.${type.slice("image/".length)}`);
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    form.append("pinataMetadata", JSON.stringify({ name: "ostra-image" }));
    const cid = await this.#pin("pinFileToIPFS", form);
    this.keep(cid, bytes);
    return { cid, uri: `ipfs://${cid}` };
  }

  /**
   * The Ostra agent card of `agentId` (null: the card without a number), built here from the SDK: what is pinned is
   * always Ostra's card, never an SVG a caller sent. A card kept here already (pinned before) is answered without
   * pinning it again; `admit` counts only a new pin.
   */
  async agentCard(agentId: string | null, admit: (bytes: number) => void): Promise<{ cid: string; uri: string }> {
    let svg: string;
    try {
      svg = agentCardSvg(agentId);
    } catch (err) {
      throw new UploadError(400, "bad_agent_id", (err as Error).message);
    }
    const bytes = new TextEncoder().encode(svg);
    const expected = rawCidOf(bytes);
    if (this.#kept(expected) !== null) return { cid: expected, uri: `ipfs://${expected}` };
    admit(bytes.length);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: AGENT_CARD_TYPE }), "ostra-agent.svg");
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    form.append("pinataMetadata", JSON.stringify({ name: "ostra-agent-card" }));
    const cid = await this.#pin("pinFileToIPFS", form);
    if (cid !== expected) this.#o.log?.("card_cid_differs", { pinned: cid, expected });
    if (!this.keep(cid, bytes)) this.#o.log?.("not_kept", { cid });
    return { cid, uri: `ipfs://${cid}` };
  }

  async json(value: unknown): Promise<{ cid: string; uri: string }> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UploadError(400, "not_an_object", "send a JSON object");
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/json" }), "ostra.json");
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    form.append("pinataMetadata", JSON.stringify({ name: "ostra-json" }));
    const cid = await this.#pin("pinFileToIPFS", form);
    if (!this.keep(cid, bytes)) this.#o.log?.("not_kept", { cid });
    return { cid, uri: `ipfs://${cid}` };
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** At most `max` bytes of a response's body; null when it is larger. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readBody(req: IncomingMessage, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > max) throw new UploadError(413, "too_large", `the body exceeds ${max} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new UploadError(413, "too_large", `the body exceeds ${max} bytes`);
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** A caller on this machine: a loopback socket and no X-Forwarded-For (nginx sets it on everything it passes). */
function onThisMachine(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return req.headers["x-forwarded-for"] === undefined && (a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1");
}

/** The client's address as nginx passes it (the Cloudflare-resolved remote address). */
function clientAddress(req: IncomingMessage): string {
  const h = req.headers["x-forwarded-for"];
  const first = (Array.isArray(h) ? h[0] : h)?.split(",")[0]?.trim();
  return first !== undefined && first !== "" ? first : (req.socket.remoteAddress ?? "unknown");
}

export function createUploaderServer(u: Uploader, log?: UploaderOptions["log"]): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        if (applyCors(req, res)) return;
        const path = new URL(req.url ?? "/", "http://uploader").pathname;
        if (req.method === "GET" && path === "/v1/ipfs/health") return reply(res, 200, u.health());
        const asked = /^\/v1\/ipfs\/([A-Za-z0-9]{1,100})$/.exec(path);
        if ((req.method === "GET" || req.method === "HEAD") && asked !== null) {
          const cid = asked[1] as string;
          if (rawCidDigest(cid) === null) throw new UploadError(404, "not_found", "only a raw CIDv1 (sha2-256, bafkrei...) is served here");
          const got = await u.file(cid, { upstream: onThisMachine(req) });
          if ("bytes" in got) {
            const svg = isSvg(got.bytes);
            res.writeHead(200, {
              "content-type": svg ? AGENT_CARD_TYPE : (sniffImage(got.bytes) ?? "application/octet-stream"),
              "content-length": String(got.bytes.length),
              "cache-control": "public, max-age=31536000, immutable",
              "x-content-type-options": "nosniff",
              ...(svg ? { "content-security-policy": SVG_POLICY } : {}),
            });
            res.end(req.method === "HEAD" ? undefined : Buffer.from(got.bytes));
            return;
          }
          if ("refused" in got) {
            res.setHeader("retry-after", String(got.retryAfterSeconds));
            throw new UploadError(503, "upstream_refused", `the public gateways refuse reads from this server for ${got.retryAfterSeconds} s more, and the file is not kept here`);
          }
          throw new UploadError(404, "not_found", onThisMachine(req) ? "the file is not kept here and no public gateway has it" : "the file is not kept here (read it from a public IPFS gateway)");
        }
        if (req.method !== "POST" || (path !== "/v1/ipfs/image" && path !== "/v1/ipfs/json" && path !== "/v1/ipfs/agent-card")) {
          throw new UploadError(404, "not_found", "POST /v1/ipfs/image, /v1/ipfs/json or /v1/ipfs/agent-card, GET /v1/ipfs/<cid>");
        }
        const type = String(req.headers["content-type"] ?? "");
        if (path === "/v1/ipfs/agent-card") {
          if (!type.toLowerCase().startsWith("application/json")) throw new UploadError(415, "unsupported_media_type", "send application/json");
          let asked: unknown;
          try {
            asked = JSON.parse(Buffer.from(await readBody(req, 256)).toString("utf8"));
          } catch (err) {
            if (err instanceof UploadError) throw err;
            throw new UploadError(400, "invalid_json", "the body is not valid JSON");
          }
          const id = typeof asked === "object" && asked !== null ? (asked as { agentId?: unknown }).agentId : undefined;
          if (id !== null && typeof id !== "string") throw new UploadError(400, "bad_agent_id", 'send {"agentId": "<decimal>"} or {"agentId": null}');
          const address = clientAddress(req);
          const out = await u.agentCard(id, (bytes) => u.admit(address, bytes));
          log?.("pinned", { kind: "agent_card", agentId: id, cid: out.cid });
          return reply(res, 200, out);
        }
        const image = path === "/v1/ipfs/image";
        const body = await readBody(req, image ? MAX_IMAGE_BYTES : MAX_JSON_BYTES);
        let value: unknown;
        if (!image) {
          if (!type.toLowerCase().startsWith("application/json")) throw new UploadError(415, "unsupported_media_type", "send application/json");
          try {
            value = JSON.parse(Buffer.from(body).toString("utf8"));
          } catch {
            throw new UploadError(400, "invalid_json", "the body is not valid JSON");
          }
        }
        const address = clientAddress(req);
        u.admit(address, body.length);
        const out = image ? await u.image(body, type) : await u.json(value);
        log?.("pinned", { kind: image ? "image" : "json", bytes: body.length, cid: out.cid });
        reply(res, 200, out);
      } catch (err) {
        if (err instanceof UploadError) return reply(res, err.status, { error: err.code, message: err.message });
        log?.("error", { message: (err as Error).message });
        reply(res, 500, { error: "internal", message: "the upload failed" });
      }
    })();
  });
}
