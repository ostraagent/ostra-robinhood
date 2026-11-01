// Ostra Tide for the agent (design "Ostra Tide", decided by Edu on 31 Oct 2026): it links its vaults for the score,
// privately, and reads its own points.
//
//   link       The score counts what the agent pays and holds in all its vaults only once they are linked: each
//              existing vault of the agent (the buyer vault, the seller vault, the vault of each pair's token and each
//              Borro stock, each pair's creator vault; never a private vault) approves its member digest, and then the
//              identity vault (the creator vault holding the ERC-8004 identity) approves the set digest over the list
//              of those that did (sdk tide.ts). The digests hold a secret derived from the seed, so the approvals are
//              hashes nobody else can tie to the agent or to each other: they add no tie between the vaults on chain
//              (a vault's own swaps name the vault they pay, which ties those already). The link (the agent id, the
//              secret, the list, the OSTRA vault paid) is sent to Ostra's index before any approval, and again after the
//              set approval, when the index checks it on chain and keeps it as verified; Ostra alone learns which vaults
//              are the agent's. The approvals go out one by one with random gaps. A vault whose approval was sent before
//              is not asked again (a record per digest); a vault whose approval could not be sent is left out of the set
//              this time (calling link again adds it). Calls run one at a time.
//              The OSTRA vault paid (decided by Edu on 1 Nov 2026: the agent only updates and links, it never swaps or
//              opens a vault for its share): an existing OSTRA vault of the list (the OSTRA token vault before a pair's
//              creator vault in OSTRA), which approved its member digest; when the list has none (the agent has no
//              OSTRA vault, or its approval was not sent this time), its OSTRA token vault as its seed derives it,
//              outside the list (the address, and the createVault params the index checks it against), which is not
//              created here: Ostra creates it at payout, only when the agent has a share. The set digest names it as
//              the payee either way, so a link never falls back to no payee while the agent has an OSTRA vault (one
//              this seed recovered, at another address, is paid only from the list: without its approval no set is
//              approved, and the link kept before stays). An agent that linked with no payee (0.1.15) links again: the
//              members' approvals are not sent again, only the set approval naming the payee.
//   points     The agent's figures from Ostra's index, asked with the view key (the secret's hash).
//   dashboard  The web app's page with the view key in the URL's fragment (never sent to a server in the address).
//
// Each approval is one ApproveHash spend paid like the vault's other spends. A digest names its own domain and the
// secret: it is never a permit, an authorization or another contract's action, so approving it moves nothing.

import { getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import {
  ERC8004_IDENTITY_REGISTRY,
  OSTRA,
  OSTRA_TIDE,
  TIDE_MAX_LINKED_VAULTS,
  VAULT_ACTION,
  approveHashParams,
  signVaultSpend,
  simulateVaultSpend,
  tideLinkDeadline,
  tideMemberDigest,
  tidePayeeVault,
  tideSetDigest,
  tideSortVaults,
  tideViewKey,
  tideWeekAt,
  type TidePayeeCreation,
} from "@ostraagent/sdk";
import type { Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import type { Folder } from "./storage.ts";
import { spendCall, type VaultService } from "./vault.ts";

export const TIDE_DIR = "tide";
/** The web app's Tide page. */
export const TIDE_APP_URL = "https://app.ostraagent.xyz/tide";
const SPEND_GAS_HEADROOM = 100_000n;
const EIP1271_MAGIC = "0x1626ba7e";
const erc1271Abi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const identityAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);

export type TideServiceParams = {
  client: PublicClient;
  config: Config;
  keys: Keys;
  /** The agent's ERC-8004 id (null: not registered) and the vault holding it. */
  identity: () => Promise<{ agentId: bigint | null; vault: Address }>;
  /** The identity vault's own service (the creator vault). */
  identityVault: VaultService;
  /** Every other vault service of the agent that may exist (private vaults left out). */
  vaults: () => Promise<VaultService[]>;
  /** The relayer's account (or the fee payer's), for the spends' simulation. */
  payer: () => Promise<Address>;
  /** Ostra's index (the web app's host); null: Tide is not available. */
  indexerUrl: string | null;
  folder: Folder;
  fetch?: typeof fetch;
  /** The gap before each approval after the first, in milliseconds (default 4 to 20 seconds at random). */
  gap?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Sent = Record<Hex, { vault: Address; tx: string; at: number }>;

export class TideService {
  readonly #p: TideServiceParams;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(p: TideServiceParams) {
    this.#p = p;
  }

  /** Runs `f` after the calls before it: two links at once would send the same approvals twice. */
  #one<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(f);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** The agent's link secret: from the seed, for this chain and OstraTide. */
  #secret(): Hex {
    return this.#p.keys.tideSecret(this.#p.config.chainId, OSTRA_TIDE);
  }

  #api(path: string): URL {
    if (this.#p.indexerUrl === null) throw new Error("no Ostra index is set (OSTRA_PAD_INDEXER_URL): Ostra Tide is not available here");
    const url = new URL(path, this.#p.indexerUrl);
    // The link carries the secret: only over TLS, or to this machine.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw new Error(`Ostra's index ${url.origin} is not https: the link's secret is never sent over plain http; nothing was sent`);
    }
    return url;
  }

  async #post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const f = this.#p.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(this.#api(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new Error(`Ostra's index could not be reached: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  async #agent(): Promise<{ agentId: bigint; vault: Address }> {
    const id = await this.#p.identity();
    if (id.agentId === null) throw new Error("the agent has no ERC-8004 identity yet: publish_profile registers it (it is what Ostra Tide counts)");
    const owner = getAddress((await this.#p.client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [id.agentId] })) as Address);
    if (owner !== getAddress(id.vault)) throw new Error(`agent ${id.agentId} is owned by ${owner}, not this agent's creator vault ${id.vault}`);
    if (getAddress(await this.#p.identityVault.vaultAddress()) !== owner) throw new Error("the identity vault's service is not the vault holding the identity");
    return { agentId: id.agentId, vault: owner };
  }

  async #sent(): Promise<Sent> {
    const t = await this.#p.folder.read("sent.json");
    return t === undefined ? {} : (JSON.parse(t) as Sent);
  }

  async #approved(vault: Address, digest: Hex): Promise<boolean> {
    try {
      const r = await this.#p.client.readContract({ address: vault, abi: erc1271Abi, functionName: "isValidSignature", args: [digest, "0x"] });
      return r.toLowerCase() === EIP1271_MAGIC;
    } catch {
      return false;
    }
  }

  /** One ApproveHash spend of `digest` from `vs`, recorded once sent. */
  async #approve(vs: VaultService, vault: Address, digest: Hex, what: string): Promise<{ vault: Address; tx: string; status: string }> {
    const params = approveHashParams({ hash: digest, approved: true });
    const sim = await simulateVaultSpend(this.#p.client, this.#p.config.deployment, { relayer: await this.#p.payer(), vault, action: VAULT_ACTION.APPROVE_HASH, params });
    const r = await vs.operate({
      gas: (sim.gasUsed * 5n) / 4n + SPEND_GAS_HEADROOM,
      what,
      build: async ({ v, vault: at, keychain, chainId }) => [spendCall(at, await signVaultSpend(keychain, v, { chainId, action: VAULT_ACTION.APPROVE_HASH, params }))],
    });
    if (r.status !== "sent") return { vault, tx: "", status: `not sent: ${r.note}` };
    const sent = await this.#sent();
    sent[digest] = { vault, tx: r.txHash, at: Math.floor(Date.now() / 1000) };
    await this.#p.folder.write("sent.json", JSON.stringify(sent));
    return { vault, tx: r.txHash, status: "sent" };
  }

  /**
   * Links the agent's existing vaults for Ostra Tide: the link sent to Ostra's index first, then each vault's member
   * approval, then the identity vault's set approval. Call again after a vault is added (or when a step was not sent):
   * what was sent before is not sent again.
   */
  link(): Promise<Record<string, unknown>> {
    return this.#one(() => this.#link());
  }

  async #link(): Promise<Record<string, unknown>> {
    const { agentId, vault: identity } = await this.#agent();
    const chainId = this.#p.config.chainId;
    const services = await this.#p.vaults();
    const members: { vs: VaultService; vault: Address; token: Address }[] = [];
    for (const vs of services) {
      const vault = await vs.vaultAddress().catch(() => null);
      if (vault === null || getAddress(vault) === identity || members.some((m) => m.vault === getAddress(vault))) continue;
      if (!(await vs.state()).exists) continue;
      members.push({ vs, vault: getAddress(vault), token: getAddress(vs.token) });
    }
    if (members.length + 1 > TIDE_MAX_LINKED_VAULTS) throw new Error(`the agent has ${members.length + 1} vaults, more than a link lists (${TIDE_MAX_LINKED_VAULTS}); nothing was signed`);
    // The agent's OSTRA token vault as its seed creates it, created or not, and the params that create it: the payee,
    // outside the list, whenever no OSTRA vault of the list can be (none exists, or its member approval was not sent
    // this time), so a link never falls back to no payee while the agent has one.
    let own: { payee: Address; creation: TidePayeeCreation } | null = null;
    const ostraVs = services.find((v) => v.kind === "token" && getAddress(v.token) === OSTRA);
    if (ostraVs !== undefined) {
      const creation = ostraVs.creationParams();
      const payee = tidePayeeVault(this.#p.config.deployment, creation);
      // An address the vault service cannot give (as the members above skip it) names no payee here.
      const read = await ostraVs.vaultAddress().catch(() => null);
      const at = read === null ? null : getAddress(read);
      if (at === payee) own = { payee, creation };
      // A vault this seed recovered is at another address: it is paid only as a member of the list.
      else if (at !== null && !members.some((m) => m.vault === at)) throw new Error(`the agent's OSTRA vault ${at} is not the one its seed creates (${payee}), and it does not exist; nothing was signed`);
    }
    // The payee of a list: its first OSTRA vault in the list's order (the same on every call), else the agent's OSTRA
    // token vault outside it, named with its params; null without either.
    type Payee = { payee: Address; creation: TidePayeeCreation | null };
    const payeeOf = (listed: readonly { vault: Address }[]): Payee | null => {
      const m = members.find((x) => x.token === OSTRA && listed.some((a) => a.vault === x.vault));
      if (m !== undefined) return { payee: m.vault, creation: null };
      return own === null ? null : { payee: own.payee, creation: own.creation };
    };
    const secret = this.#secret();
    const keep = async (vaults: Address[], p: Payee | null, when: string) => {
      const r = await this.#post("/api/v1/tide/link", { agentId: agentId.toString(), secret, vaults, payee: p?.payee ?? null, ...(p === null || p.creation === null ? {} : { payeeCreation: p.creation }) });
      if (r.status !== 200) throw new Error(`Ostra's index did not keep the link ${when} (${r.status} ${String(r.json.error ?? "")} ${String(r.json.message ?? "")})`);
      return r.json.verified === true;
    };
    const all = tideSortVaults([identity, ...members.map((m) => m.vault)]);
    await keep(all, payeeOf(members), "before the approvals; nothing was signed");
    const sent = await this.#sent();
    const steps: { vault: Address; tx: string; status: string }[] = [];
    const gap = this.#p.gap ?? (() => 4_000 + Math.floor(Math.random() * 16_000));
    const sleep = this.#p.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // Members in a random order, then the set over those approved.
    const order = members.map((m) => ({ m, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.m);
    const approved: typeof members = [];
    let first = true;
    for (const m of order) {
      const digest = tideMemberDigest({ chainId, agentId, vault: m.vault, secret });
      if (sent[digest] !== undefined || (await this.#approved(m.vault, digest))) {
        steps.push({ vault: m.vault, tx: sent[digest]?.tx ?? "", status: "approved before" });
        approved.push(m);
        continue;
      }
      if (!first) await sleep(gap());
      first = false;
      let step: { vault: Address; tx: string; status: string };
      try {
        step = await this.#approve(m.vs, m.vault, digest, "Ostra Tide link approval");
      } catch (err) {
        step = { vault: m.vault, tx: "", status: `not sent: ${(err as Error).message.slice(0, 300)}` };
      }
      steps.push(step);
      if (step.status === "sent") approved.push(m);
    }
    const vaults = tideSortVaults([identity, ...approved.map((m) => m.vault)]);
    const chosen = payeeOf(approved);
    const payee = chosen?.payee ?? null;
    const setDigest = tideSetDigest({ chainId, agentId, vaults, payee, secret, outsidePayee: chosen !== null && chosen.creation !== null });
    let set: { vault: Address; tx: string; status: string };
    if (chosen === null && members.some((m) => m.token === OSTRA)) {
      // The agent's OSTRA vault could be named neither in the list nor outside it: no set naming no payee is approved
      // (it would replace a link that pays it), the link kept before stays.
      set = { vault: identity, tx: "", status: "not sent: the agent's OSTRA vault is not in the list this time (its approval was not sent): call link again" };
    } else if (sent[setDigest] !== undefined || (await this.#approved(identity, setDigest))) set = { vault: identity, tx: sent[setDigest]?.tx ?? "", status: "approved before" };
    else {
      if (!first) await sleep(gap());
      set = await this.#approve(this.#p.identityVault, identity, setDigest, "Ostra Tide link (the set of vaults)");
    }
    const linked = set.status === "sent" || set.status === "approved before";
    // Kept again with the set as approved: the index checks it on chain and never drops it.
    const verified = linked ? await keep(vaults, chosen, "after the approvals (call link again: nothing is signed twice)") : false;
    const week = Math.max(1, tideWeekAt(Math.floor(Date.now() / 1000)));
    const left = steps.filter((s) => s.status.startsWith("not sent")).map((s) => s.vault);
    return {
      agentId: agentId.toString(),
      vaults,
      payee,
      approvals: [...steps, set],
      linked,
      verifiedByIndex: verified,
      ...(linked && !verified
        ? { verifyNote: "Ostra's index could not confirm the set approval yet (a vault's lock delays when an approval takes effect, or the chain could not be read): call link again later; nothing is signed twice" }
        : {}),
      ...(left.length === 0 ? {} : { leftOut: left, leftOutNote: "these vaults' approvals were not sent: call link again to add them" }),
      ...(chosen === null || chosen.creation === null ? {} : { payeeCreation: chosen.creation }),
      note:
        payee === null
          ? members.some((m) => m.token === OSTRA)
            ? "the agent's OSTRA vault could not be named this time: the link kept before stays; call link again"
            : "no OSTRA vault of this agent is in the link: its share is kept for it until it has one and links again"
          : chosen === null || chosen.creation === null
            ? "the share is paid to the OSTRA vault named"
            : members.some((m) => m.vault === payee)
              ? "the share is paid to the agent's OSTRA vault named (outside the list: its approval was not sent this time, so call link again to count what it holds and pays)"
              : "the share is paid to the agent's OSTRA vault named, which does not exist yet: Ostra creates it at payout, only when the agent gets a share (nothing to swap or open)",
      countsFor: `week ${week} and on, for approvals in force by ${new Date(tideLinkDeadline(week) * 1000).toISOString()} (the score checks each on chain)`,
    };
  }

  /** The agent's own figures for the latest week scored (or `week`). */
  async points(week?: number): Promise<Record<string, unknown>> {
    const { agentId } = await this.#agent();
    const r = await this.#post("/api/v1/tide/points", { agentId: agentId.toString(), viewKey: tideViewKey(this.#secret()), ...(week === undefined ? {} : { week }) });
    if (r.status === 404) return { agentId: agentId.toString(), linked: false, note: "Ostra's index has no link of this agent: call tide with action link first" };
    if (r.status === 202 && r.json.error === "not_verified") return { agentId: agentId.toString(), linked: false, missing: r.json.missing, note: "the score did not count this link: call tide with action link again" };
    if (r.status === 202) return { agentId: agentId.toString(), note: "the link is kept; the points appear after the next score (every 30 minutes)" };
    if (r.status !== 200) throw new Error(`Ostra's index answered ${r.status} ${String(r.json.error ?? "")}`);
    return r.json;
  }

  /** The web app's page of the agent's points: the view key in the URL's fragment. */
  async dashboard(): Promise<{ url: string; note: string }> {
    const { agentId } = await this.#agent();
    return { url: `${TIDE_APP_URL}#agent=${agentId.toString()}&key=${tideViewKey(this.#secret())}`, note: "anyone holding this link sees this agent's points and linked vaults: share it only with people who should see them" };
  }
}
