// Reading ipfs:// files (profiles, registration files, Ostrapad's orders, deliveries and reasons, token metadata)
// through gateways in order: the Ostra uploader first (GET /v1/ipfs/<cid>: what it pinned, kept on its server, and
// any other raw CID read once from the public gateways and kept), then Pinata's public gateway, then ipfs.io. The
// public gateways answer 429 to a server that reads often (ipfs.io and dweb.link measured from the VPS on 23 Oct 2026,
// Pinata's on 28 Oct 2026, retry-after 900 and 1512 s), so they are only the fallback. A raw CIDv1 with a SHA-256 multihash (bafkrei..., what the
// uploader makes of a JSON file or an image) is checked against the bytes a gateway returns, so no gateway can change
// what a CID names; other CIDs are taken as the gateway returns them. OSTRA_IPFS_GATEWAYS (comma-separated http(s)
// URLs ending in /) replaces the list, in the order given.

import { sha256 } from "viem";
import { padDigestFromCid } from "@ostraagent/sdk";

/** The gateways, in the order they are tried (unless OSTRA_IPFS_GATEWAYS names others). */
export const IPFS_GATEWAYS: readonly string[] = ["https://relayer.ostraagent.xyz/v1/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];

/** The gateways a read uses: OSTRA_IPFS_GATEWAYS when it is set, else IPFS_GATEWAYS. */
export function ipfsGateways(env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}): readonly string[] {
  const text = env.OSTRA_IPFS_GATEWAYS;
  if (text === undefined || text.trim() === "") return IPFS_GATEWAYS;
  const list = text.split(",").map((g) => g.trim()).filter((g) => g !== "");
  if (list.length === 0 || list.some((g) => !/^https?:\/\/[^\s,]+\/$/.test(g))) throw new Error("OSTRA_IPFS_GATEWAYS must be comma-separated http(s) URLs ending in /");
  return list;
}

/** Time one gateway is given for one file (Pinata's answers in 5 to 7 seconds from the VPS). */
export const IPFS_GATEWAY_TIMEOUT_MS = 20_000;

/** An ipfs:// URI's path under a gateway ("<cid>[/a/b]", "ipfs://ipfs/<cid>" too); null for anything else. */
function gatewayPath(uri: string): string | null {
  if (!uri.startsWith("ipfs://")) return null;
  const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  // Segments of letters, digits, dots, dashes and underscores, never "." or ".." (a URL would resolve them away).
  return /^[A-Za-z0-9]{1,100}(\/(?!\.\.?(\/|$))[A-Za-z0-9._-]+)*$/.test(path) ? path : null;
}

/** At most `maxBytes` of one response's body; null when it is larger. */
async function body(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (res.body === null) return null;
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
}

/**
 * The bytes an ipfs:// URI names, at most `maxBytes`, from the first gateway that returns them (for a raw sha2-256
 * CID with no path, bytes matching it); null when none does.
 */
export async function ipfsBytes(uri: string, maxBytes: number, o: { gateways?: readonly string[]; timeoutMs?: number } = {}): Promise<Uint8Array | null> {
  const path = gatewayPath(uri);
  if (path === null) return null;
  const digest = path.includes("/") ? null : padDigestFromCid(path);
  for (const gateway of o.gateways ?? ipfsGateways()) {
    try {
      const res = await fetch(`${gateway}${path}`, { signal: AbortSignal.timeout(o.timeoutMs ?? IPFS_GATEWAY_TIMEOUT_MS), redirect: "error" });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const got = await body(res, maxBytes);
      if (got === null) continue;
      if (digest !== null && sha256(got) !== digest) continue;
      return got;
    } catch {
      // this gateway did not answer in time, or refused: the next one
    }
  }
  return null;
}
