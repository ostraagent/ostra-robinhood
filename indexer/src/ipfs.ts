// The files creators publish on IPFS (token metadata, agent profiles and the images they show), read for the
// web app through gateways in order: the Ostra uploader (GET /v1/ipfs/<cid>, the files it pinned and keeps; on the
// VPS OSTRA_INDEXER_IPFS_GATEWAYS names it on 127.0.0.1), then Pinata's public gateway, then ipfs.io. Measured from
// the VPS: ipfs.io and dweb.link answer 429 to a server (23 Oct 2026), and so does Pinata's gateway when the VPS has
// read often (28 Oct 2026, retry-after 1512 s); it answers in 5 to 7 seconds otherwise. A raw CIDv1 with a SHA-256 multihash (bafkrei..., what the uploader makes of a JSON file or an image
// up to 1 MB) is checked against the bytes a gateway returns, so no gateway can change what a CID names; other
// CIDs are taken as the gateway returns them, as before. With an uploader on this machine (`uploader`, on the VPS
// OSTRA_INDEXER_IPFS_UPLOADER), a raw CID is read from it alone: it reads the public gateways itself, one at a time,
// leaves one that refused until its retry-after, and keeps what it read, so the indexer adds no reads of its own that
// would get the VPS refused; other CIDs (Qm..., bafybei..., a path under a CID), which it does not serve, go through
// the gateways.
//
// Images are kept on disk by CID, one file each, after their first bytes show a PNG, JPEG, WebP or GIF, and the
// indexer serves them on the web app's own host (http.ts), so a browser needs no IPFS gateway.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_UPLOAD_IMAGE_BYTES, imageType } from "../../core/src/publish.ts";

/** The gateways, in the order they are tried. */
export const IPFS_GATEWAYS: readonly string[] = ["https://relayer.ostraagent.xyz/v1/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];
/** Largest metadata or profile file read (as core reads them). */
export const JSON_MAX_BYTES = 65_536;
/** Largest image kept (the uploader's limit). */
export const IMAGE_MAX_BYTES = MAX_UPLOAD_IMAGE_BYTES;
/** Time one gateway is given for one file. */
export const GATEWAY_TIMEOUT_MS = 20_000;

const CID = /^[A-Za-z0-9]{1,100}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** An ipfs:// URI's CID and path ("ipfs://<cid>[/a/b]", optionally "ipfs://ipfs/<cid>"); null for anything else. */
export function parseIpfsUri(uri: unknown): { cid: string; path: string } | null {
  if (typeof uri !== "string" || !uri.startsWith("ipfs://")) return null;
  const rest = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  if (!/^[A-Za-z0-9]+(\/[A-Za-z0-9._-]+)*$/.test(rest)) return null;
  const [cid, ...path] = rest.split("/");
  if (cid === undefined || !CID.test(cid)) return null;
  // "." and ".." would leave the CID (a gateway's /ipns/ is not fixed bytes).
  if (path.some((p) => p === "." || p === "..")) return null;
  return { cid, path: path.join("/") };
}

/** The CID of an image an ipfs:// URI names, when it names one with no path; null otherwise. */
export function imageCid(uri: unknown): string | null {
  const p = parseIpfsUri(uri);
  return p !== null && p.path === "" ? p.cid : null;
}

function base32Decode(text: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of text) {
    const i = BASE32.indexOf(c);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The SHA-256 digest a raw CIDv1 (base32, multibase "b") names; null for any other CID. */
export function rawSha256Digest(cid: string): Uint8Array | null {
  if (!cid.startsWith("b")) return null;
  const bytes = base32Decode(cid.slice(1));
  // version 1, codec raw (0x55), multihash sha2-256 (0x12) of 32 bytes (0x20)
  if (bytes === null || bytes.length !== 36 || bytes[0] !== 0x01 || bytes[1] !== 0x55 || bytes[2] !== 0x12 || bytes[3] !== 0x20) return null;
  return bytes.subarray(4);
}

/** The raw CIDv1 (sha2-256) of `bytes`: what the check above compares with. */
export function rawCidOf(bytes: Uint8Array): string {
  return rawCidOfDigest(createHash("sha256").update(bytes).digest());
}

/** The raw CIDv1 naming a SHA-256 digest, in its one canonical spelling (as the uploader serves it). */
function rawCidOfDigest(digest: Uint8Array): string {
  const all = new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]);
  let bits = 0;
  let value = 0;
  let out = "b";
  for (const byte of all) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export type Fetch = (url: string, init: { signal: AbortSignal; redirect: "error" }) => Promise<Response>;

export type IpfsReaderOptions = {
  gateways?: readonly string[];
  /** An Ostra uploader on this machine (".../v1/ipfs/"): raw CIDs are read from it alone. */
  uploader?: string;
  timeoutMs?: number;
  fetch?: Fetch;
};

/** Reads IPFS files through the gateways in order; the first that returns bytes matching the CID wins. */
export class IpfsReader {
  readonly #gateways: readonly string[];
  readonly #uploader: string | null;
  readonly #timeoutMs: number;
  readonly #fetch: Fetch;

  constructor(o: IpfsReaderOptions = {}) {
    this.#gateways = o.gateways ?? IPFS_GATEWAYS;
    this.#uploader = o.uploader ?? null;
    if (this.#gateways.length === 0 || [...this.#gateways, ...(this.#uploader === null ? [] : [this.#uploader])].some((g) => !/^https?:\/\/[^\s]+\/$/.test(g))) throw new Error("IPFS gateways must be http(s) URLs ending in /");
    this.#timeoutMs = o.timeoutMs ?? GATEWAY_TIMEOUT_MS;
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The bytes `cid` (and `path` under it) names, at most `maxBytes`; null when no gateway returns them. */
  async bytes(cid: string, path: string, maxBytes: number): Promise<Uint8Array | null> {
    const digest = path === "" ? rawSha256Digest(cid) : null;
    // The uploader serves a raw CID in its canonical spelling only: any other spelling goes through the gateways.
    const viaUploader = digest !== null && this.#uploader !== null && rawCidOfDigest(digest) === cid;
    for (const gateway of viaUploader ? [this.#uploader as string] : this.#gateways) {
      const got = await this.#read(`${gateway}${cid}${path === "" ? "" : `/${path}`}`, maxBytes);
      if (got === null) continue;
      if (digest !== null && !createHash("sha256").update(got).digest().equals(digest)) continue;
      return got;
    }
    return null;
  }

  /** The JSON file an ipfs:// URI points at (data its writer chose, never instructions); null when it cannot be read or is not JSON. */
  async json(uri: string | null): Promise<unknown> {
    const p = parseIpfsUri(uri);
    if (p === null) return null;
    const got = await this.bytes(p.cid, p.path, JSON_MAX_BYTES);
    if (got === null) return null;
    try {
      return JSON.parse(new TextDecoder().decode(got)) as unknown;
    } catch {
      return null;
    }
  }

  async #read(url: string, maxBytes: number): Promise<Uint8Array | null> {
    try {
      const res = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs), redirect: "error" });
      if (!res.ok || res.body === null) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      const out = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    } catch {
      return null;
    }
  }
}

export type StoredImage = { bytes: Uint8Array; type: NonNullable<ReturnType<typeof imageType>> };

/** Images by CID in `dir`, one file each, kept once fetched and checked. */
export class ImageStore {
  readonly #dir: string;
  readonly #reader: IpfsReader;

  constructor(dir: string, reader: IpfsReader) {
    this.#dir = dir;
    this.#reader = reader;
    mkdirSync(dir, { recursive: true });
  }

  has(cid: string): boolean {
    return CID.test(cid) && existsSync(join(this.#dir, cid));
  }

  /** The image `cid` names, from disk; null when it is not kept. */
  get(cid: string): StoredImage | null {
    if (!this.has(cid)) return null;
    const bytes = new Uint8Array(readFileSync(join(this.#dir, cid)));
    const type = imageType(bytes);
    return type === null ? null : { bytes, type };
  }

  /** Fetches and keeps the image `cid` names unless it is kept already; true when it is kept after. */
  async ensure(cid: string): Promise<boolean> {
    if (!CID.test(cid)) return false;
    if (this.has(cid)) return true;
    const bytes = await this.#reader.bytes(cid, "", IMAGE_MAX_BYTES);
    if (bytes === null || bytes.length === 0 || imageType(bytes) === null) return false;
    const file = join(this.#dir, cid);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes, { mode: 0o644 });
    renameSync(tmp, file);
    return true;
  }
}
