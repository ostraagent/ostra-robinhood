// Raeto (raeto.cc) from the agent's USDG vault (decided by Edu on 25 Oct 2026: what vault version 3 can do with Raeto is
// built now; deposits into Raeto's own vaults wait for a later vault version). Raeto sells AI models (over 400, image
// models among them) through one OpenAI-compatible API, paid in its credits. Read from Raeto's API and docs on 25 Oct
// 2026 (GET /v1/agents, raeto.cc/developers, raeto.cc/sdk/raeto.mjs):
//   * an agent signs in with its own wallet: POST /v1/agents/challenge {address} answers a message (valid 10 minutes),
//     and POST /v1/agents/login {address, signature, name?, limitUsd?, models?} takes "personal_sign of the challenge
//     message by the wallet, or, for a smart-contract account (multisig, post-quantum vault), a signature its
//     isValidSignature(hashMessage(message), signature) accepts (EIP-1271)". An Ostra vault signs a hash by approving it
//     (ApproveHash) and reads no signature bytes, so the approval is made, the login sent, and the approval withdrawn
//     (a second spend: a login message left approved would sign that login for anyone while Raeto takes it). Under the withdrawal
//     lock an approval waits the lock's delay, longer than the challenge lives: refused then;
//   * USDG sent from the agent's wallet to `payTo` (GET /v1/agents) becomes credits of that wallet's account;
//   * requests: Authorization: Bearer <the account's API key>; GET /v1/me, GET /v1/models, POST /v1/chat/completions.
// The API key is the vault's account's secret: it is kept in this agent's folder (on disk, mode 0600) and never returned
// (it is replaced by "<raeto key>" in whatever Raeto answers). Raeto's payTo is pinned (RAETO_PAY_TO, read 25 Oct 2026):
// an answer naming another address is refused, so a wrong OSTRA_RAETO_URL or a changed API cannot redirect USDG.

import { getAddress, hashMessage, isAddress, parseAbi, type Address, type PublicClient } from "viem";
import { CASH_VAULTS, USDG, VAULT_ACTION, decodeApproveHashParams, decodeTransferParams, readVaultGuard } from "@ostraagent/sdk";
import { formatUnitsAmount, parseTokenAmount, TOKEN_DECIMALS } from "./amount.ts";
import type { BorroService } from "./borro.ts";
import { tokenBalance } from "./chain.ts";
import type { Folder } from "./storage.ts";
import type { VaultService } from "./vault.ts";

export const RAETO_API = "https://api.raeto.cc";
/** Where Raeto takes USDG for credits (GET /v1/agents usdg.payTo, read 25 Oct 2026; also its vaults' treasury). */
export const RAETO_PAY_TO: Address = "0xF0Cc2FE5A90a3BB784De818f6E2061fd99c236Bf";
/** The first line of Raeto's agent login message (POST /v1/agents/challenge, read 25 Oct 2026). */
const CHALLENGE_FIRST_LINE = "Sign in to raeto as an agent";
/** The longest a challenge may live: Raeto's live 10 minutes (read 25 Oct 2026), with room for clocks. */
const CHALLENGE_MAX_MS = 15 * 60_000;
/** Robinhood Chain, where Raeto takes USDG (GET /v1/agents: chainId 4663). */
const RAETO_CHAIN_ID = 4663;
const KEY_FILE = "account.json";
const YIELD_FILE = "yield.json";
/** Login messages whose approval may have been signed and is not known withdrawn yet. */
const APPROVALS_FILE = "approvals.json";
const TIMEOUT_MS = 60_000;
/** A model's answer may take this long. */
const COMPLETION_TIMEOUT_MS = 600_000;
const EIP1271_MAGIC = "0x1626ba7e";
/** How long the login waits for the vault's approval to read on chain (a relayed spend lands within seconds). */
const APPROVAL_WAIT_MS = 120_000;

const erc1271Abi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const shareAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function convertToAssets(uint256 shares) view returns (uint256)", "function decimals() view returns (uint8)"]);

export type RaetoParts = {
  client: PublicClient;
  buyer: VaultService;
  borro: BorroService;
  folder: Folder;
  /** Raeto's API (default RAETO_API). */
  apiUrl?: string;
};

export class RaetoError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RaetoError";
    this.status = status;
  }
}

type Account = { vault: Address; apiKey: string; name: string; at: number };

export class RaetoService {
  readonly #p: RaetoParts;
  readonly #api: string;
  /** Spends of this service run one after the other (two calls of fundFromYield must not both redeem and send). */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(p: RaetoParts) {
    this.#p = p;
    this.#api = (p.apiUrl ?? RAETO_API).replace(/\/+$/, "");
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** `value` with the API key, wherever it appears, replaced (an answer such as /v1/me may name it). */
  async #scrub<T>(value: T): Promise<T> {
    const a = await this.#account();
    if (a === null) return value;
    return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "string" && v.includes(a.apiKey) ? v.split(a.apiKey).join("<raeto key>") : v))) as T;
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown, key?: string, timeout = TIMEOUT_MS): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key !== undefined) headers.authorization = `Bearer ${key}`;
    let res: Response;
    try {
      res = await fetch(`${this.#api}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw new Error(`Raeto (${this.#api}) cannot be reached: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const m = json !== null && typeof json === "object" ? ((json as { error?: { message?: unknown } | string; message?: unknown }).message ?? (json as { error?: unknown }).error) : text.slice(0, 300);
      let message = `Raeto answered ${res.status} to ${method} ${path}: ${typeof m === "string" ? m : JSON.stringify(m)}`;
      if (key !== undefined) message = message.split(key).join("<raeto key>");
      throw new RaetoError(res.status, message);
    }
    if (json === null) throw new RaetoError(res.status, `Raeto's answer to ${method} ${path} is not JSON`);
    return json;
  }

  /** Where USDG for credits goes (GET /v1/agents), checked: Robinhood Chain, USDG, and the payTo pinned here. */
  async terms(): Promise<{ payTo: Address; token: Address; chainId: number }> {
    const t = (await this.#call("GET", "/v1/agents")) as { chainId?: unknown; usdg?: { token?: unknown; payTo?: unknown } };
    if (t.chainId !== RAETO_CHAIN_ID) throw new Error(`Raeto's terms name chain ${String(t.chainId)}, not Robinhood Chain (${RAETO_CHAIN_ID}); nothing was sent`);
    const payTo = t.usdg?.payTo;
    const token = t.usdg?.token;
    if (typeof payTo !== "string" || !isAddress(payTo, { strict: false }) || typeof token !== "string" || !isAddress(token, { strict: false })) throw new Error("Raeto's terms carry no USDG payTo address; nothing was sent");
    if (getAddress(token) !== USDG) throw new Error(`Raeto takes ${token}, not USDG; nothing was sent`);
    if (getAddress(payTo) !== RAETO_PAY_TO) throw new Error(`Raeto's terms name ${payTo} as payTo, not ${RAETO_PAY_TO}: nothing was sent (a changed address is checked before it is used)`);
    return { payTo: RAETO_PAY_TO, token: USDG, chainId: RAETO_CHAIN_ID };
  }

  async #account(): Promise<Account | null> {
    const text = await this.#p.folder.read(KEY_FILE);
    if (text === undefined) return null;
    const a = JSON.parse(text) as Account;
    const vault = getAddress(await this.#p.buyer.vaultAddress());
    return getAddress(a.vault) === vault ? a : null;
  }

  async #key(): Promise<string> {
    const a = await this.#account();
    if (a === null) throw new Error("the vault is not signed in to Raeto yet: call raeto login first");
    return a.apiKey;
  }

  async #approved(vault: Address, hash: `0x${string}`): Promise<boolean> {
    const r = await this.#p.client.readContract({ address: vault, abi: erc1271Abi, functionName: "isValidSignature", args: [hash, "0x"] });
    return r.toLowerCase() === EIP1271_MAGIC;
  }

  /** Withdraws the approval of `hash`, sending any spend signed earlier first: the withdrawal's transaction, or why not. */
  async #withdraw(vault: Address, hash: `0x${string}`): Promise<string> {
    let last = "";
    for (let i = 0; i < 3; i++) {
      try {
        const w = await this.#p.borro.approveHash(hash, false);
        if (w.status === "sent") return w.txHash;
        last = w.note;
        // The spend sent first may have been this withdrawal itself.
        if (!(await this.#approved(vault, hash)) && !(await this.#approvalPending(hash))) return "withdrawn by a spend signed earlier, sent now";
      } catch (err) {
        last = (err as Error).message.split("\n")[0] as string;
      }
    }
    return `not withdrawn (${last})`;
  }

  /** Whether the vault's spend signed and not landed yet is an approval of `hash` (the next operation sends it first). */
  async #approvalPending(hash: `0x${string}`): Promise<boolean> {
    const pending = (await this.#p.buyer.spendSlot())?.pending ?? null;
    if (pending === null || pending.action !== VAULT_ACTION.APPROVE_HASH) return false;
    const a = decodeApproveHashParams(pending.params);
    return a.approved && a.hash.toLowerCase() === hash.toLowerCase();
  }

  async #keptApprovals(): Promise<`0x${string}`[]> {
    const text = await this.#p.folder.read(APPROVALS_FILE);
    return text === undefined ? [] : (JSON.parse(text) as `0x${string}`[]);
  }

  async #keepApprovals(hashes: `0x${string}`[]): Promise<void> {
    if (hashes.length === 0) await this.#p.folder.remove(APPROVALS_FILE);
    else await this.#p.folder.write(APPROVALS_FILE, JSON.stringify(hashes));
  }

  /**
   * Makes sure the vault's approval of the login message `hash` does not stay: withdrawn when it reads on chain or when
   * the spend the vault signed and has not landed is that approval (sent first, then withdrawn); nothing is signed when
   * neither holds (it was never approved). The hash stays in APPROVALS_FILE until it is known not approved.
   */
  async #clear(vault: Address, hash: `0x${string}`): Promise<{ done: boolean; note: string }> {
    let note: string;
    try {
      if (!(await this.#approved(vault, hash)) && !(await this.#approvalPending(hash))) note = "never approved: nothing to withdraw";
      else note = await this.#withdraw(vault, hash);
    } catch (err) {
      note = `not withdrawn (${(err as Error).message.split("\n")[0]})`;
    }
    const still = await this.#approved(vault, hash).catch(() => true) || (await this.#approvalPending(hash).catch(() => true));
    if (!still) {
      await this.#keepApprovals((await this.#keptApprovals()).filter((h) => h !== hash));
      return { done: true, note };
    }
    return { done: false, note: `${note}; the approval may still read or land: call raeto login again to withdraw it, or vault_approve_hash ${hash} approved false` };
  }

  /**
   * Signs the vault in to Raeto as an agent (see the file comment): its own Raeto account and API key, kept here. With a
   * key kept already, nothing is done. `limitUsd`: the spending limit Raeto keeps for the account. The challenge must be
   * Raeto's agent login message naming this vault and living at most CHALLENGE_MAX_MS: the vault approves nothing else.
   * The message's hash is kept here before it is approved, and its approval withdrawn whatever happens next (also when
   * the login fails, the outcome then added to the error); one not known withdrawn is withdrawn by the next call first.
   */
  login(a: { name: string; limitUsd?: number }): Promise<{ vault: Address; signedIn: "now" | "already"; approval?: string; withdrawn?: string; earlier?: string[] }> {
    return this.#serial(async () => {
      const vault = getAddress(await this.#p.buyer.vaultAddress());
      // Approvals of earlier logins not known withdrawn: withdrawn first.
      const earlier: string[] = [];
      for (const h of await this.#keptApprovals()) earlier.push(`${h}: ${(await this.#clear(vault, h)).note}`);
      const withEarlier = earlier.length === 0 ? {} : { earlier };
      if ((await this.#account()) !== null) return { vault, signedIn: "already" as const, ...withEarlier };
      if ((await readVaultGuard(this.#p.client, vault)).lockedSince !== 0n) {
        throw new Error("the vault's withdrawal lock is on: its approval of Raeto's login message would wait the lock's delay, and the message lives 10 minutes; sign in before the lock, or after it is turned off; nothing was signed");
      }
      const c = (await this.#call("POST", "/v1/agents/challenge", { address: vault })) as { message?: unknown; expiresAt?: unknown };
      const expires = typeof c.expiresAt === "string" ? Date.parse(c.expiresAt) : Number.NaN;
      if (typeof c.message !== "string" || !c.message.startsWith(CHALLENGE_FIRST_LINE) || !c.message.includes(`Wallet: ${vault}`) || !/\nNonce: [0-9a-f]{16,}\n/.test(c.message)) {
        throw new Error("Raeto's challenge is not its agent login message for this vault; nothing was signed");
      }
      if (!Number.isFinite(expires) || expires - Date.now() > CHALLENGE_MAX_MS || expires <= Date.now()) throw new Error(`Raeto's challenge expires at ${String(c.expiresAt)}, not within the next 15 minutes; nothing was signed`);
      const hash = hashMessage(c.message);
      let approval: string | undefined;
      let answer: Record<string, unknown> = {};
      let failure: Error | null = null;
      await this.#keepApprovals([...(await this.#keptApprovals()).filter((h) => h !== hash), hash]);
      try {
        const approve = await this.#p.borro.approveHash(hash, true);
        if (approve.status !== "sent") throw new Error(`a spend signed earlier was sent first (${approve.note}): call raeto login again`);
        approval = approve.txHash;
        const deadline = Date.now() + APPROVAL_WAIT_MS;
        while (!(await this.#approved(vault, hash))) {
          if (Date.now() > deadline) throw new Error("the vault's approval of Raeto's login message does not read on chain yet: call raeto login again");
          await new Promise((res) => setTimeout(res, 2_000));
        }
        answer = (await this.#call("POST", "/v1/agents/login", { address: vault, signature: "0x", name: a.name, ...(a.limitUsd === undefined ? {} : { limitUsd: a.limitUsd }) })) as Record<string, unknown>;
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      }
      // Whatever happened: a login message left approved signs that login for anyone while Raeto takes it.
      const withdrawn = (await this.#clear(vault, hash)).note;
      if (failure !== null) {
        failure.message = `${failure.message}; the login message's approval: ${withdrawn}`;
        throw failure;
      }
      const inner = typeof answer.data === "object" && answer.data !== null ? (answer.data as Record<string, unknown>) : {};
      const key = [answer.apiKey, answer.api_key, answer.key, inner.apiKey, inner.api_key, inner.key].find((x): x is string => typeof x === "string" && x.length > 0);
      if (key === undefined) throw new Error(`Raeto signed the vault in but its answer carries no API key (fields: ${Object.keys(answer).join(", ")}): sign in again`);
      await this.#p.folder.write(KEY_FILE, JSON.stringify({ vault, apiKey: key, name: a.name, at: Math.floor(Date.now() / 1000) } satisfies Account));
      return { vault, signedIn: "now" as const, ...(approval === undefined ? {} : { approval }), withdrawn, ...withEarlier };
    });
  }

  /** The vault's Raeto account (GET /v1/me): its credits and key details (the key itself never shown). */
  async me(): Promise<unknown> {
    return this.#scrub(await this.#call("GET", "/v1/me", undefined, await this.#key()));
  }

  /** Raeto's models and their prices per token (GET /v1/models); `output`: only those whose output includes it (image: the image models). */
  async models(output?: string): Promise<{ total: number; models: { id: string; output: unknown; pricing: unknown }[] }> {
    const m = (await this.#call("GET", "/v1/models")) as { data?: unknown };
    const list = (Array.isArray(m.data) ? m.data : Array.isArray(m) ? m : []) as { id?: unknown; architecture?: { output_modalities?: unknown }; pricing?: unknown }[];
    const out = list
      .filter((x) => typeof x.id === "string")
      .map((x) => ({ id: x.id as string, output: x.architecture?.output_modalities ?? null, pricing: x.pricing ?? null }))
      .filter((x) => output === undefined || (Array.isArray(x.output) && x.output.includes(output)));
    return { total: list.length, models: out };
  }

  /** Sends USDG from the vault to Raeto's payTo: credits of the vault's account. */
  fund(amount: string): Promise<{ payTo: Address; amount: string; result: unknown }> {
    return this.#serial(async () => {
      const { payTo } = await this.terms();
      return { payTo, amount, result: await this.#p.buyer.withdraw(payTo, amount) };
    });
  }

  /** A model call (POST /v1/chat/completions, the OpenAI format; `model` is Raeto's id, or raeto/auto). */
  async complete(request: Record<string, unknown>): Promise<unknown> {
    if (typeof request.model !== "string" || request.model === "") throw new RangeError("the request names a model (raeto models lists them)");
    if (request.stream === true) throw new RangeError("stream is not supported here: the answer is returned whole");
    return this.#scrub(await this.#call("POST", "/v1/chat/completions", request, await this.#key(), COMPLETION_TIMEOUT_MS));
  }

  /**
   * What the vault's cash vault shares earn, as credits. Kept here: a mark (the shares, and the highest share price read:
   * a high-water mark, so a price that falls and comes back earns nothing until it passes its high), what is owed (the
   * shares of each mark times the rise of the price over its high, added on every call), and USDG redeemed for it and
   * not sent yet (`ready`), with the vault's spend slot its transfer is signed at. A call adds what the shares earned
   * since the mark, moves the mark to now, sends what was redeemed and not sent first, and else, when what is owed is at
   * least `min` USDG, redeems that from the cash vault and sends what the redeem paid (at most what is owed) to Raeto's
   * payTo. A transfer of `ready` that another operation of the vault sent first (it sends a signed spend before its
   * own) is found at its slot and not paid again. Shares added or removed count from the read after; a full exit leaves
   * what was owed until then. Raeto's terms are checked before anything is redeemed. Calls run one after the other.
   */
  fundFromYield(min = "1"): Promise<{ vault: Address; owed: string; sent: string; note?: string; redeem?: unknown; fund?: unknown }> {
    return this.#serial(async () => {
      const minimum = parseTokenAmount(min);
      const buyer = getAddress(await this.#p.buyer.vaultAddress());
      const target = CASH_VAULTS[0] as Address;
      const read = async () => {
        const shares = (await this.#p.client.readContract({ address: target, abi: shareAbi, functionName: "balanceOf", args: [buyer] })) as bigint;
        const unit = 10n ** BigInt(await this.#p.client.readContract({ address: target, abi: shareAbi, functionName: "decimals" }));
        const price = (await this.#p.client.readContract({ address: target, abi: shareAbi, functionName: "convertToAssets", args: [unit] })) as bigint;
        return { shares, unit, price };
      };
      const now = await read();
      const text = await this.#p.folder.read(YIELD_FILE);
      const kept = text === undefined ? null : (JSON.parse(text) as YieldMark);
      const usd = (x: bigint) => formatUnitsAmount(x, TOKEN_DECIMALS);
      const write = (m: YieldMark) => this.#p.folder.write(YIELD_FILE, JSON.stringify(m));
      if (kept === null || getAddress(kept.vault) !== target) {
        await write({ vault: target, shares: now.shares.toString(), price: now.price.toString(), owed: "0", ready: "0" });
        return { vault: target, owed: "0", sent: "0", note: "the mark is set now: what the shares earn from here is sent as credits by later calls" };
      }
      const high = BigInt(kept.price);
      let owed = BigInt(kept.owed) + (now.price > high ? (BigInt(kept.shares) * (now.price - high)) / now.unit : 0n);
      let ready = BigInt(kept.ready);
      const mark: YieldMark = { ...kept, vault: target, shares: now.shares.toString(), price: (now.price > high ? now.price : high).toString(), owed: owed.toString(), ready: ready.toString() };
      await write(mark);
      if (ready === 0n && (owed === 0n || owed < minimum)) return { vault: target, owed: usd(owed), sent: "0", note: `under ${min} USDG: kept for a later call` };
      const { payTo } = await this.terms();
      // `ready` signed earlier, at the kept slot or after it (a relayer channel opened first, or another operation of the
      // vault, takes a slot before the transfer): the spends that landed since are read, one slot after the other.
      if (ready > 0n && mark.readySlot !== undefined) {
        const slot = { nonce: BigInt(mark.readySlot.nonce), keyIndex: BigInt(mark.readySlot.keyIndex) };
        const nowSlot = await this.#p.buyer.spendSlot();
        if (nowSlot !== null && nowSlot.nonce > slot.nonce) {
          let paid = false;
          for (let i = 0n; slot.nonce + i < nowSlot.nonce && !paid; i++) {
            const landed = await this.#p.buyer.signedAt({ nonce: slot.nonce + i, keyIndex: slot.keyIndex + i });
            const t = landed !== null && landed.action === VAULT_ACTION.TRANSFER ? decodeTransferParams(landed.params as `0x${string}`) : null;
            paid = t !== null && getAddress(t.to) === payTo && t.amount === ready;
          }
          const latest = JSON.parse((await this.#p.folder.read(YIELD_FILE)) as string) as YieldMark;
          if (paid) {
            const { readySlot: _paid, ...rest } = latest;
            await write({ ...rest, ready: "0" });
            return { vault: target, owed: usd(owed), sent: usd(ready), note: "sent by an earlier operation of the vault, which sent this signed transfer before its own" };
          }
          const { readySlot: _never, ...rest } = latest;
          await write(rest);
          mark.readySlot = undefined;
        }
      }
      let redeem: unknown;
      if (ready === 0n) {
        const shares = (owed * now.unit) / now.price;
        if (shares === 0n || shares > now.shares) return { vault: target, owed: usd(owed), sent: "0", note: shares === 0n ? "what is owed redeems no share yet" : "the vault holds fewer shares than what is owed: kept for a later call" };
        const before = await tokenBalance(this.#p.client, USDG, buyer);
        const r = await this.#p.borro.redeemCash(target, shares);
        redeem = r;
        if (r.status !== "sent") return { vault: target, owed: usd(owed), sent: "0", note: `a spend signed earlier was sent first (${r.note}): call again`, redeem };
        const after = await read();
        const paid = (await tokenBalance(this.#p.client, USDG, buyer)) - before;
        ready = paid <= 0n ? 0n : paid < owed ? paid : owed;
        owed -= ready;
        const afterHigh = BigInt(mark.price) > after.price ? BigInt(mark.price) : after.price;
        await write({ vault: target, shares: after.shares.toString(), price: afterHigh.toString(), owed: owed.toString(), ready: ready.toString() });
        if (ready === 0n) return { vault: target, owed: usd(owed), sent: "0", note: "the redeem paid nothing into the vault", redeem };
      }
      // The first slot the transfer can be signed at, kept before it is signed (with nothing signed and unsent there:
      // else that spend is sent first, and withdraw tells whether it was this transfer); it may land at a later slot.
      const slot = await this.#p.buyer.spendSlot();
      if (slot !== null && slot.pending === null) {
        const latest = JSON.parse((await this.#p.folder.read(YIELD_FILE)) as string) as YieldMark;
        await write({ ...latest, readySlot: { nonce: slot.nonce.toString(), keyIndex: slot.keyIndex.toString() } });
      }
      const fund = await this.#p.buyer.withdraw(payTo, usd(ready));
      if ((fund as { status?: string }).status !== "sent") return { vault: target, owed: usd(owed), sent: "0", note: "a spend signed earlier was sent first: what was redeemed is sent by the next call", redeem, fund };
      const latest = JSON.parse((await this.#p.folder.read(YIELD_FILE)) as string) as YieldMark;
      const { readySlot: _sent, ...rest } = latest;
      await write({ ...rest, ready: "0" });
      return { vault: target, owed: usd(owed), sent: usd(ready), ...(redeem === undefined ? {} : { redeem }), fund };
    });
  }
}

/** `price`: the highest share price read (a high-water mark). `readySlot`: the vault's spend slot the transfer of `ready` is signed at. */
type YieldMark = { vault: Address; shares: string; price: string; owed: string; ready: string; readySlot?: { nonce: string; keyIndex: string } | undefined };

/** A Raeto answer's images (OpenAI-compatible: choices[].message.images[].image_url.url as data: URLs), decoded. */
export function raetoImages(answer: unknown): { index: number; mediaType: string; bytes: Uint8Array }[] {
  const out: { index: number; mediaType: string; bytes: Uint8Array }[] = [];
  const choices = (answer as { choices?: { message?: { images?: { image_url?: { url?: unknown } }[] } }[] } | null)?.choices;
  if (!Array.isArray(choices)) return out;
  let i = 0;
  for (const c of choices) {
    for (const img of c.message?.images ?? []) {
      const url = img.image_url?.url;
      const m = typeof url === "string" ? /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url) : null;
      if (m !== null) out.push({ index: i, mediaType: m[1] as string, bytes: Uint8Array.from(atob(m[2] as string), (ch) => ch.charCodeAt(0)) });
      i++;
    }
  }
  return out;
}

