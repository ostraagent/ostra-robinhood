// The Ostra uploader: pins what an agent publishes about itself and its launches to IPFS, through the
// operator's Pinata account, and answers with its ipfs:// URI. Served behind nginx on the relayer's host
// (/v1/ipfs/), which also limits the request rate per address.
//
//   POST /v1/ipfs/image   the image bytes (PNG, JPEG, WebP or GIF, checked by their first bytes; at most
//                         MAX_IMAGE_BYTES), Content-Type the image's type
//   POST /v1/ipfs/json    a JSON object of at most MAX_JSON_BYTES (a profile, an ERC-8004 registration file
//                         or a token's metadata)
//   GET  /v1/ipfs/health  how much of today's budget is used
//
// The web app (https://app.ostraagent.xyz) uploads from the browser: its origin gets CORS and its preflight is
// answered 204 (merchant/src/cors.ts); the limits below are the same for it.
//
// Answers are { cid, uri } or { error: <code>, message }. Nothing is stored here: what an address uploads is
// counted (UPLOADS_PER_HOUR per address) and the bytes of a day are capped (the daily budget), so the
// operator's pinning quota cannot be drained. The Pinata key only adds pins (pinFileToIPFS, pinJSONToIPFS).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { applyCors } from "../../merchant/src/cors.ts";

export const MAX_IMAGE_BYTES = 1_048_576;
export const MAX_JSON_BYTES = 16_384;
export const UPLOADS_PER_HOUR = 30;
export const PINATA_API = "https://api.pinata.cloud/pinning";

export class UploadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
};

export class Uploader {
  readonly #o: UploaderOptions;
  readonly #perAddress = new Map<string, number[]>();
  #day = "";
  #dayBytes = 0;

  constructor(o: UploaderOptions) {
    if (o.jwt.length < 20) throw new Error("the Pinata JWT is missing");
    this.#o = o;
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

  async #pin(path: string, body: string | FormData, json: boolean): Promise<string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#o.jwt}` };
    if (json) headers["content-type"] = "application/json";
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
    const cid = await this.#pin("pinFileToIPFS", form, false);
    return { cid, uri: `ipfs://${cid}` };
  }

  async json(value: unknown): Promise<{ cid: string; uri: string }> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UploadError(400, "not_an_object", "send a JSON object");
    const cid = await this.#pin("pinJSONToIPFS", JSON.stringify({ pinataContent: value, pinataOptions: { cidVersion: 1 }, pinataMetadata: { name: "ostra-json" } }), true);
    return { cid, uri: `ipfs://${cid}` };
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
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
        if (req.method !== "POST" || (path !== "/v1/ipfs/image" && path !== "/v1/ipfs/json")) throw new UploadError(404, "not_found", "POST /v1/ipfs/image or /v1/ipfs/json");
        const type = String(req.headers["content-type"] ?? "");
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
