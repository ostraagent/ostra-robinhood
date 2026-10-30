// Publishing to IPFS through the Ostra uploader, served on the relayer's host (<relayer>/v1/ipfs/): the files
// an agent publishes about itself (an ERC-8004 registration file, which is also its Ostra profile), and the images
// and files of Ostrapad orders and deliveries. An agent's profile is Ostra's own, the same for every Ostra agent (its
// name and number, one description, the Ostra agent card as its image, its vault), so anyone reading the ERC-8004
// registry sees an Ostra agent.

import { ERC8004_IDENTITY_REGISTRY, ROBINHOOD_CHAIN_ID } from "@ostraagent/sdk";
import type { Address } from "viem";

/** The largest image the uploader takes. */
export const MAX_UPLOAD_IMAGE_BYTES = 1_048_576;

/** The image type the bytes start with, or null (PNG, JPEG, WebP, GIF: what the uploader takes). */
export function imageType(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
}

function imageUri(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^(ipfs:\/\/[A-Za-z0-9]+(\/[A-Za-z0-9._-]+)*|https:\/\/\S{1,200})$/.test(value)) throw new RangeError("image must be an ipfs:// or https:// URI (upload a file with upload_image first)");
  return value;
}

/** Every Ostra agent's name: this, then its ERC-8004 number once it has one ("Ostra Agent #20074"). */
export const AGENT_NAME = "Ostra Agent";
/** Every Ostra agent's description. */
export const AGENT_DESCRIPTION =
  "An AI agent with an Ostra post-quantum privacy vault on Robinhood Chain. Its earnings and payments stay in its own vault, signed with one-time keys.";

/**
 * An agent's profile as an ERC-8004 registration file (registration-v1): Ostra's name with the agent's number, Ostra's
 * description, `image` (the agent's Ostra card, agentCardUri), its creator vault as agentWallet, and its registration
 * once it has one. The type, name, description and image fields are those ERC-8004 asks for, for ERC-721 apps.
 */
export function profileFile(p: { vault: Address; agentId?: string | null; image?: string }): Record<string, unknown> {
  const id = p.agentId === undefined || p.agentId === null ? null : p.agentId;
  if (id !== null && !/^(0|[1-9][0-9]{0,29})$/.test(id)) throw new RangeError("an agent id is a decimal number");
  const image = imageUri(p.image);
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: id === null ? AGENT_NAME : `${AGENT_NAME} #${id}`,
    description: AGENT_DESCRIPTION,
    ...(image === undefined ? {} : { image }),
    services: [{ name: "agentWallet", endpoint: `eip155:${ROBINHOOD_CHAIN_ID}:${p.vault}` }],
    active: true,
    registrations: id === null ? [] : [{ agentId: Number(id), agentRegistry: `eip155:${ROBINHOOD_CHAIN_ID}:${ERC8004_IDENTITY_REGISTRY}` }],
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

/**
 * The ipfs:// URI of agent `agentId`'s Ostra card (null: the card without a number), which the uploader builds itself
 * (sdk agent-card.ts) and pins, or answers again when it pinned it before.
 */
export function agentCardUri(relayerUrl: string | null, agentId: string | null): Promise<string> {
  return post(`${uploaderUrl(relayerUrl)}/agent-card`, JSON.stringify({ agentId }), "application/json");
}

/** Pins an image (PNG, JPEG, WebP or GIF, at most MAX_UPLOAD_IMAGE_BYTES) and returns its ipfs:// URI. */
export function uploadImage(relayerUrl: string | null, bytes: Uint8Array): Promise<string> {
  const base = uploaderUrl(relayerUrl);
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_IMAGE_BYTES) throw new RangeError(`the image must be 1 to ${MAX_UPLOAD_IMAGE_BYTES} bytes (it is ${bytes.length})`);
  const type = imageType(bytes);
  if (type === null) throw new RangeError("the image is not a PNG, JPEG, WebP or GIF");
  return post(`${base}/image`, new Blob([new Uint8Array(bytes)], { type }), type);
}
