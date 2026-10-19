// Publishing to IPFS through the Ostra uploader, served on the relayer's host (<relayer>/v1/ipfs/): the files
// an agent publishes about itself (an ERC-8004 registration file, which is also its Ostra profile) and about the
// tokens it launched (their metadata), and the images they show. The files are built here from fields the
// agent gives, checked first, so what lands on IPFS has one shape.

import { ERC8004_IDENTITY_REGISTRY, ROBINHOOD_CHAIN_ID } from "@ostraagent/sdk";
import type { Address } from "viem";

/** The largest image the uploader takes. */
export const MAX_UPLOAD_IMAGE_BYTES = 1_048_576;

/** Links and texts an agent's profile or a token's metadata carries. */
export type PublicFields = { description?: string; image?: string; website?: string; x?: string; telegram?: string };

/** The image type the bytes start with, or null (PNG, JPEG, WebP, GIF: what the uploader takes). */
export function imageType(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
}

function text(value: string | undefined, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "" || v.length > max) throw new RangeError(`${name} must be 1 to ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw new RangeError(`${name} must not hold control characters`);
  return v;
}

function link(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new RangeError(`${name} must be an https:// link`);
  }
  if (u.protocol !== "https:" || v.length > 200) throw new RangeError(`${name} must be an https:// link of at most 200 characters`);
  return u.toString();
}

function imageUri(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^(ipfs:\/\/[A-Za-z0-9]+(\/[A-Za-z0-9._-]+)*|https:\/\/\S{1,200})$/.test(value)) throw new RangeError("image must be an ipfs:// or https:// URI (upload a file with upload_image first)");
  return value;
}

/** An agent's profile as an ERC-8004 registration file (registration-v1): name, description, image, its links and its vault as services, and its registration once it has one. */
export function profileFile(p: PublicFields & { name: string; vault: Address; agentId?: string | null }): Record<string, unknown> {
  const services: { name: string; endpoint: string }[] = [];
  const website = link(p.website, "website");
  const x = link(p.x, "x");
  const telegram = link(p.telegram, "telegram");
  if (website !== undefined) services.push({ name: "web", endpoint: website });
  if (x !== undefined) services.push({ name: "X", endpoint: x });
  if (telegram !== undefined) services.push({ name: "Telegram", endpoint: telegram });
  services.push({ name: "agentWallet", endpoint: `eip155:${ROBINHOOD_CHAIN_ID}:${p.vault}` });
  const image = imageUri(p.image);
  const description = text(p.description, "description", 1_000);
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: text(p.name, "name", 64),
    ...(description === undefined ? {} : { description }),
    ...(image === undefined ? {} : { image }),
    services,
    active: true,
    registrations: p.agentId === undefined || p.agentId === null ? [] : [{ agentId: Number(p.agentId), agentRegistry: `eip155:${ROBINHOOD_CHAIN_ID}:${ERC8004_IDENTITY_REGISTRY}` }],
  };
}

/** A launched token's metadata: its name and symbol as the token holds them, and what its creator tells buyers. */
export function tokenMetadataFile(m: PublicFields & { token: Address; name: string; symbol: string; creatorVault: Address }): Record<string, unknown> {
  const description = text(m.description, "description", 1_000);
  const image = imageUri(m.image);
  const website = link(m.website, "website");
  const x = link(m.x, "x");
  const telegram = link(m.telegram, "telegram");
  return {
    name: m.name,
    symbol: m.symbol,
    ...(description === undefined ? {} : { description }),
    ...(image === undefined ? {} : { image }),
    ...(website === undefined ? {} : { website }),
    ...(x === undefined ? {} : { x }),
    ...(telegram === undefined ? {} : { telegram }),
    token: `eip155:${ROBINHOOD_CHAIN_ID}:${m.token}`,
    creatorVault: `eip155:${ROBINHOOD_CHAIN_ID}:${m.creatorVault}`,
  };
}

async function post(url: string, body: string | Blob, type: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": type }, body, signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    throw new Error(`the uploader at ${new URL(url).host} could not be reached: ${(err as Error).message}`);
  }
  const out = (await res.json().catch(() => ({}))) as { uri?: unknown; error?: unknown; message?: unknown };
  if (!res.ok || typeof out.uri !== "string" || !/^ipfs:\/\/[A-Za-z0-9]+$/.test(out.uri)) throw new Error(`the upload was refused: ${String(out.error ?? res.status)} ${String(out.message ?? "")}`.trim());
  return out.uri;
}

/** The uploader's base URL: the relayer's, which serves it under /v1/ipfs/. */
export function uploaderUrl(relayerUrl: string | null): string {
  if (relayerUrl === null) throw new Error("publishing to IPFS goes through the Ostra relayer's uploader: set OSTRA_RELAYER_URL, or give an ipfs:// URI you published yourself");
  return `${relayerUrl.replace(/\/+$/, "")}/v1/ipfs`;
}

/** Pins `value` (a JSON object) and returns its ipfs:// URI. */
export function uploadJson(relayerUrl: string | null, value: Record<string, unknown>): Promise<string> {
  return post(`${uploaderUrl(relayerUrl)}/json`, JSON.stringify(value), "application/json");
}

/** Pins an image (PNG, JPEG, WebP or GIF, at most MAX_UPLOAD_IMAGE_BYTES) and returns its ipfs:// URI. */
export function uploadImage(relayerUrl: string | null, bytes: Uint8Array): Promise<string> {
  const base = uploaderUrl(relayerUrl);
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_IMAGE_BYTES) throw new RangeError(`the image must be 1 to ${MAX_UPLOAD_IMAGE_BYTES} bytes (it is ${bytes.length})`);
  const type = imageType(bytes);
  if (type === null) throw new RangeError("the image is not a PNG, JPEG, WebP or GIF");
  return post(`${base}/image`, new Blob([new Uint8Array(bytes)], { type }), type);
}
