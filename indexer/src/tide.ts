// Ostra Tide's private API (design "Ostra Tide", decided by Edu on 31 Oct 2026: each agent sees its own points and
// where they came from; no list of everyone's points is published). Served by the indexer under /api/v1/tide on the
// web app's host:
//
//   POST /api/v1/tide/link    {agentId, secret, vaults, payee}: an agent's vault link (sdk tide.ts), kept so the
//                             score (keeper scripts/tide-score.ts) can check its approvals on chain. The secret is
//                             what makes the link private: it is written only to OSTRA_TIDE_LINKS (0600) and never
//                             answered back. Anyone may post a link for any agent id, so a link is only kept, never
//                             trusted: it counts once the agent's identity vault approved its set digest on chain,
//                             which needs that vault's own key. A link whose set digest the agent's identity vault
//                             (an Ostra vault: a beacon proxy of Ostra's vault beacon) holds approved is "verified"
//                             (checked here when it is posted: the agent posts it again after its approvals). An agent
//                             keeps its 2 latest verified links; an unverified one never replaces or drops them. Of the
//                             unverified ones an agent keeps at most 8 and all agents at most TIDE_LINKS_MAX, the
//                             oldest dropped first. A link with the same agent and secret replaces the one kept before
//                             only when it is verified, or when neither is.
//   POST /api/v1/tide/points  {agentId, viewKey, week?}: that agent's result (its points by source, its vaults, its
//                             share, what was paid) only to the view key of the link the score counted (the result
//                             names it); to the key of another link kept for it, only what that link lacks (202); 404
//                             to any other key. So posting a link of one's own for someone else's agent shows nothing
//                             of theirs.
//   GET  /api/v1/tide/summary the latest week: its span, pot, how many agents have points, its root once posted.
//
// The results are the score's files (OSTRA_TIDE_RESULTS/week-<n>.json, and week-<n>.paid.json once paid), read
// again when they change. Bodies are at most 8 KiB. Links are changed one at a time (each write is the whole file,
// 0600, renamed into place).

import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, isAddress, keccak256, parseAbi, stringToHex, toHex, type Address, type Hex, type PublicClient } from "viem";
import { ERC8004_IDENTITY_REGISTRY, TIDE_MAX_LINKED_VAULTS, tideLinkDeadline, tideSetDigest, tideSortVaults, tideViewKey, tideWeekAt, tideWeekSpan } from "@ostraagent/sdk";

export const TIDE_BODY_MAX = 8_192;
/** Links of one agent kept unverified at most. */
export const TIDE_LINKS_PER_AGENT = 8;
/** Verified links of one agent kept (the latest). */
export const TIDE_VERIFIED_PER_AGENT = 2;
/** Links kept unverified at most, all agents together. */
export const TIDE_LINKS_MAX = 10_000;

export type TideLink = { agentId: string; secret: Hex; vaults: Address[]; payee: Address | null; at: number; verified?: boolean };

type AgentResult = { agentId: string; breakdown: { points: string }; viewKey?: Hex | null; pending?: { viewKey: Hex; missing: string[] }[] };
type Result = { week: number; start: number; end: number; at: number; final: boolean; pot: string; agents: AgentResult[]; tree: { root: Hex } | null };
type Paid = { root: Hex; rootTx: Hex | null; paid: Record<string, { tx: Hex; amount: string; vault: Address }> };

export class TideBadRequest extends Error {}

const verifyAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

/** EIP-1967's beacon slot: where a beacon proxy (each Ostra vault) keeps its beacon. */
const BEACON_SLOT = toHex(BigInt(keccak256(stringToHex("eip1967.proxy.beacon"))) - 1n, { size: 32 });

/**
 * TideApi's check of a link: the agent's identity is owned by an Ostra vault (a beacon proxy of `vaultBeacon`, so its
 * EIP-1271 answers are Ostra's: an approved hash, never any hash), and that vault holds an approval of the link's set
 * digest in force now.
 */
export function tideLinkVerifier(client: PublicClient, chainId: number, vaultBeacon: Address): (link: TideLink) => Promise<boolean> {
  return async (link) => {
    const owner = getAddress((await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: verifyAbi, functionName: "ownerOf", args: [BigInt(link.agentId)] })) as Address);
    const beacon = await client.getStorageAt({ address: owner, slot: BEACON_SLOT });
    if (beacon === undefined || BigInt(beacon) !== BigInt(vaultBeacon)) return false;
    const digest = tideSetDigest({ chainId, agentId: link.agentId, vaults: tideSortVaults([...link.vaults, owner]), payee: link.payee, secret: link.secret });
    try {
      return ((await client.readContract({ address: owner, abi: verifyAbi, functionName: "isValidSignature", args: [digest, "0x"] })) as Hex).toLowerCase() === "0x1626ba7e";
    } catch {
      return false;
    }
  };
}

export class TideApi {
  readonly #linksPath: string;
  readonly #resultsDir: string;
  readonly #now: () => number;
  readonly #verify: ((link: TideLink) => Promise<boolean>) | null;
  #links: TideLink[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  readonly #cache = new Map<string, { mtimeMs: number; value: unknown }>();

  /**
   * `verify`: whether the agent's identity vault approved `link`'s set digest on chain (main.ts: ownerOf and the
   * vault's isValidSignature); null: no link is verified here (each is kept as unverified).
   */
  constructor(o: { linksPath: string; resultsDir: string; now?: () => number; verify?: ((link: TideLink) => Promise<boolean>) | null }) {
    this.#linksPath = o.linksPath;
    this.#resultsDir = o.resultsDir;
    this.#now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.#verify = o.verify ?? null;
  }

  /** Reads the links kept before (none yet: an empty list). */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.#linksPath, "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new Error(`${this.#linksPath} is not a list`);
      this.#links = raw as TideLink[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.#links = [];
    }
  }

  /** Keeps an agent's link (verified when its set digest is approved on chain); refuses a malformed one. */
  async link(body: unknown): Promise<{ stored: true; verified: boolean; week: number; deadline: number }> {
    const b = body as Record<string, unknown> | null;
    if (b === null || typeof b !== "object") throw new TideBadRequest("a JSON object is expected");
    const agentId = b.agentId;
    if (typeof agentId !== "string" || !/^(0|[1-9][0-9]{0,29})$/.test(agentId)) throw new TideBadRequest("agentId must be a decimal number");
    const secret = b.secret;
    if (typeof secret !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(secret) || BigInt(secret) === 0n) throw new TideBadRequest("secret must be 32 bytes of hex, not zero");
    if (!Array.isArray(b.vaults) || b.vaults.length === 0 || b.vaults.length > TIDE_MAX_LINKED_VAULTS || !b.vaults.every((v) => typeof v === "string" && isAddress(v))) {
      throw new TideBadRequest(`vaults must be 1 to ${TIDE_MAX_LINKED_VAULTS} addresses`);
    }
    const vaults = tideSortVaults(b.vaults as string[]);
    let payee: Address | null = null;
    if (b.payee !== null && b.payee !== undefined) {
      if (typeof b.payee !== "string" || !isAddress(b.payee)) throw new TideBadRequest("payee must be an address or null");
      payee = getAddress(b.payee);
      if (!vaults.includes(payee)) throw new TideBadRequest("payee must be one of the vaults");
    }
    const link: TideLink = { agentId, secret: secret.toLowerCase() as Hex, vaults, payee, at: this.#now() };
    let verified = false;
    if (this.#verify !== null) {
      try {
        verified = await this.#verify(link);
      } catch {
        verified = false; // the chain could not be read: kept as unverified, verified when posted again
      }
    }
    if (verified) link.verified = true;
    // One change at a time: each builds on the one before it.
    const run = this.#queue.then(async () => {
      // A verified link replaces every link with its agent and secret; an unverified one only the unverified one.
      const rest = this.#links.filter((x) => !(x.agentId === link.agentId && x.secret === link.secret && (verified || x.verified !== true)));
      let next = [...rest, link];
      const unverified = (list: TideLink[]) => list.filter((x) => x.verified !== true);
      const mine = unverified(next).filter((x) => x.agentId === agentId);
      const mineVerified = next.filter((x) => x.verified === true && x.agentId === agentId);
      const drop = new Set<TideLink>([...mine.slice(0, Math.max(0, mine.length - TIDE_LINKS_PER_AGENT)), ...mineVerified.slice(0, Math.max(0, mineVerified.length - TIDE_VERIFIED_PER_AGENT))]);
      next = next.filter((x) => !drop.has(x));
      const all = unverified(next);
      if (all.length > TIDE_LINKS_MAX) {
        const old = new Set(all.slice(0, all.length - TIDE_LINKS_MAX));
        next = next.filter((x) => !old.has(x));
      }
      await this.#save(next);
      this.#links = next;
    });
    this.#queue = run.catch(() => {});
    await run;
    const week = Math.max(1, tideWeekAt(this.#now()));
    return { stored: true, verified, week, deadline: tideLinkDeadline(week) };
  }

  /** One agent's result for the latest week scored (or `week`), to the holder of a view key of one of its links. */
  async points(body: unknown): Promise<{ status: 200 | 202 | 404; body: Record<string, unknown> }> {
    const b = body as Record<string, unknown> | null;
    if (b === null || typeof b !== "object") throw new TideBadRequest("a JSON object is expected");
    const agentId = b.agentId;
    if (typeof agentId !== "string" || !/^(0|[1-9][0-9]{0,29})$/.test(agentId)) throw new TideBadRequest("agentId must be a decimal number");
    const viewKey = b.viewKey;
    if (typeof viewKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(viewKey)) throw new TideBadRequest("viewKey must be 32 bytes of hex");
    let week: number | null = null;
    if (b.week !== undefined && b.week !== null) {
      if (typeof b.week !== "number" || !Number.isSafeInteger(b.week) || b.week < 1 || b.week > 1_000) throw new TideBadRequest("week must be a week number");
      week = b.week;
    }
    const key = viewKey.toLowerCase();
    const kept = this.#links.some((x) => x.agentId === agentId && tideViewKey(x.secret).toLowerCase() === key);
    const r = await this.#result(week);
    const agent = r?.agents.find((a) => a.agentId === agentId);
    if (r !== null && agent !== undefined) {
      // The figures to the key of the link the score counted; to another link's key, only what it lacks.
      if (typeof agent.viewKey === "string" && agent.viewKey.toLowerCase() === key) {
        const { viewKey: _key, pending: _pending, ...own } = agent;
        const paid = await this.#paid(r.week);
        return { status: 200, body: { week: r.week, start: r.start, end: r.end, at: r.at, final: r.final, pot: r.pot, agent: own, paid: paid?.paid[agentId] ?? null } };
      }
      const p = (agent.pending ?? []).find((x) => x.viewKey.toLowerCase() === key);
      if (p !== undefined) return { status: 202, body: { error: "not_verified", week: r.week, at: r.at, missing: p.missing } };
    }
    if (!kept) return { status: 404, body: { error: "not_found" } };
    return { status: 202, body: { error: "not_scored_yet", week: r?.week ?? week ?? Math.max(1, tideWeekAt(this.#now())) } };
  }

  /** The latest week scored, without anyone's figures. */
  async summary(): Promise<Record<string, unknown>> {
    const r = await this.#result(null);
    if (r === null) {
      const week = Math.max(1, tideWeekAt(this.#now()));
      const { start, end } = tideWeekSpan(week);
      return { week, start, end, at: null, final: false, pot: null, agents: 0, root: null };
    }
    const paid = await this.#paid(r.week);
    return { week: r.week, start: r.start, end: r.end, at: r.at, final: r.final, pot: r.pot, agents: r.agents.filter((a) => BigInt(a.breakdown.points) > 0n).length, root: paid?.root ?? r.tree?.root ?? null };
  }

  async #json(path: string): Promise<unknown | null> {
    let s;
    try {
      s = await stat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const c = this.#cache.get(path);
    if (c !== undefined && c.mtimeMs === s.mtimeMs) return c.value;
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    this.#cache.set(path, { mtimeMs: s.mtimeMs, value });
    return value;
  }

  async #result(week: number | null): Promise<Result | null> {
    let n = week;
    if (n === null) {
      let names: string[];
      try {
        names = await readdir(this.#resultsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      const weeks = names.map((f) => /^week-([0-9]{1,4})\.json$/.exec(f)?.[1]).filter((x): x is string => x !== undefined).map(Number);
      if (weeks.length === 0) return null;
      n = Math.max(...weeks);
    }
    return (await this.#json(join(this.#resultsDir, `week-${n}.json`))) as Result | null;
  }

  async #paid(week: number): Promise<Paid | null> {
    return (await this.#json(join(this.#resultsDir, `week-${week}.paid.json`))) as Paid | null;
  }

  async #save(links: readonly TideLink[]): Promise<void> {
    await writeFile(`${this.#linksPath}.tmp`, JSON.stringify(links), { mode: 0o600 });
    await rename(`${this.#linksPath}.tmp`, this.#linksPath);
  }
}
