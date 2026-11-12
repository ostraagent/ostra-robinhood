// A hosted agent's side of Ostra Cloud's signer (signer.ts, signer-protocol.ts): the AgentSeed operations of its
// seed, asked over its own Unix socket with its own token (core keys.ts gives a seedless Keys this as `remote`), and the
// gateway's admin requests (agent.create, agent.rotate). Every answer is checked before it is used: addresses are
// addresses, signatures and keys are hex of their length, and an agent spend is the spend asked for, signed by the key
// asked for (its message decoded, its WOTS signature verified against that key's root).
//
// One connection, opened on the first request and again after the signer closed it (it closes a connection idle for
// five minutes, and on a restart); at most MAX_OPEN requests are open on it at once, the rest wait their turn. A
// request the connection closed under, or with no answer within REQUEST_MS, fails: a signing request may have been
// signed then, and asked again it answers the same signature (a one-time key signs one message only).

import { readFile, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { decodeAgentSpendMessage, wotsVerify, type PadWrap, type SignedAgentSpend, type VaultAction, type WotsSignatureRecord } from "@ostraagent/sdk";
import type { AgentSeed, AgentSpendKey, CloseRequestFields, PadPostMessage, PaymentTransfer, VoucherFields } from "@ostraagent/core";
import { AGENT_ID, MAX_LINE, MAX_OPEN, adminToken, encode, type AgentOp } from "./signer-protocol.ts";

/** How long one request may wait for its answer. */
const REQUEST_MS = 30_000;
/**
 * Key roots and records are asked for this many at a time, in blocks aligned to it (AgentKey searches its keys one
 * index after another, up or down): eight records cost the signer one unit of its per-agent work budget, as one does.
 * 2^64 is a multiple of it, so no block runs past the last u64 index.
 */
const BATCH = 8n;
/** The roots and records kept (a search past it starts over, asking again). */
const KEPT = 4096;

/** A request waiting for its answer, on the connection it was sent on. */
type Pending = { socket: Socket; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** An error the signer answered (a refusal of the request, or its own failure, told without details). */
export class SignerError extends Error {
  constructor(message: string) {
    super(`the signer refused: ${message}`);
    this.name = "SignerError";
  }
}

/**
 * One JSON-lines connection to a signer socket: requests numbered here, each answer matched to its request by id. The
 * connection is opened on demand and again after it closed.
 */
class Line {
  readonly #path: string;
  #socket: Socket | null = null;
  #buf = "";
  #seq = 0;
  readonly #pending = new Map<number, Pending>();
  /** Requests waiting for one of the MAX_OPEN places. */
  readonly #queue: (() => void)[] = [];
  #open = 0;

  constructor(path: string) {
    this.#path = path;
  }

  async #slot(): Promise<void> {
    if (this.#open < MAX_OPEN) {
      this.#open++;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) next();
    else this.#open--;
  }

  /** Fails the requests sent on `socket` (never another connection's: one opened since goes on). */
  #fail(socket: Socket, err: Error): void {
    for (const [id, p] of this.#pending) {
      if (p.socket !== socket) continue;
      this.#pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  /** The live connection, or a new one: never one that is closing (destroyed, or its writing side ended). */
  #socketNow(): Socket {
    if (this.#socket !== null && !this.#socket.destroyed && this.#socket.writable) return this.#socket;
    const s = connect(this.#path);
    this.#socket = s;
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const text = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (text.trim() === "") continue;
        let a: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
        try {
          a = JSON.parse(text) as typeof a;
        } catch {
          s.destroy(new Error("the signer answered a line that is not JSON"));
          return;
        }
        const p = typeof a.id === "number" ? this.#pending.get(a.id) : undefined;
        if (p === undefined || p.socket !== s) {
          // An answer to no request of this connection (the signer's id null: a line it could not take) ends it.
          s.destroy(new Error(`the signer answered no request of this connection: ${typeof a.error === "string" ? a.error : "no error given"}`));
          return;
        }
        this.#pending.delete(a.id as number);
        clearTimeout(p.timer);
        if (a.ok === true) p.resolve(a.result);
        else p.reject(new SignerError(typeof a.error === "string" ? a.error : "no error given"));
      }
      if (buf.length > 4 * MAX_LINE) s.destroy(new Error("the signer's answer is too long"));
    });
    const gone = (err?: Error) => {
      if (this.#socket === s) this.#socket = null;
      this.#fail(s, new Error(`the connection to the signer closed${err === undefined ? "" : ` (${err.message})`}: the request may or may not have been answered; ask again`));
    };
    s.on("error", (err) => gone(err));
    s.on("close", () => gone());
    return s;
  }

  /** Sends `body` (without its id) and resolves with the answer's result. */
  async request(body: Record<string, unknown>): Promise<unknown> {
    await this.#slot();
    try {
      const id = ++this.#seq;
      const line = `${JSON.stringify({ id, ...body })}\n`;
      if (Buffer.byteLength(line) > MAX_LINE) throw new RangeError("the request is too large for the signer");
      const s = this.#socketNow();
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`the signer did not answer within ${REQUEST_MS / 1000} s`));
          // Its answer may still come: the connection goes, so that no answer is ever matched to another request.
          s.destroy();
        }, REQUEST_MS);
        timer.unref();
        this.#pending.set(id, { socket: s, resolve, reject, timer });
        s.write(line);
      });
    } finally {
      this.#release();
    }
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }
}

function hexOf(v: unknown, what: string, bytes?: number): Hex {
  if (typeof v !== "string" || !isHex(v, { strict: true }) || v.length % 2 !== 0) throw new Error(`the signer answered ${what} that is not hex`);
  if (bytes !== undefined && v.length !== 2 + 2 * bytes) throw new Error(`the signer answered ${what} of ${(v.length - 2) / 2} bytes, not ${bytes}`);
  return v.toLowerCase() as Hex;
}

function addressOf(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`the signer answered ${what} that is not an address`);
  return getAddress(v);
}

function bytesOf(v: unknown, what: string, bytes?: number): Uint8Array {
  return new Uint8Array(Buffer.from(hexOf(v, what, bytes).slice(2), "hex"));
}

/** An ECDSA signature: 65 bytes. */
const signatureOf = (v: unknown, what: string) => hexOf(v, what, 65);

const HEX = /^[0-9a-f]*$/;

/** A WOTS record as the signer keeps it (sdk WotsSignatureRecord: hex without 0x), or undefined for none. */
function recordOf(v: unknown, keychainIndex: bigint): WotsSignatureRecord | undefined {
  if (v === null) return undefined;
  const r = v as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof r[k] !== "string") throw new Error(`the signer answered a record without ${k}`);
    return r[k] as string;
  };
  if (r.version !== 1) throw new Error("the signer answered a record of another version");
  const rec: WotsSignatureRecord = {
    version: 1,
    keychain: str("keychain"),
    index: str("index"),
    keyRoot: str("keyRoot"),
    messageSha256: str("messageSha256"),
    message: str("message"),
    signature: str("signature"),
    createdAt: str("createdAt"),
  };
  for (const k of ["keychain", "keyRoot", "messageSha256", "message", "signature"] as const) if (!HEX.test(rec[k])) throw new Error(`the signer answered a record whose ${k} is not hex`);
  if (rec.index !== keychainIndex.toString()) throw new Error(`the signer answered the record of key ${rec.index} for key ${keychainIndex}`);
  return rec;
}

/** Where a hosted agent reaches its signer: its socket, its id, and the file of its token (0600). */
export type SignerConfig = { socket: string; agent: string; tokenFile: string };

/** Reads an agent's token: 32 bytes of hex in a file only its owner reads. */
export async function readToken(path: string): Promise<string> {
  const st = await stat(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`the signer token ${path} must not be accessible by other users (chmod 600 it)`);
  const t = (await readFile(path, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error(`the signer token ${path} must hold 32 bytes as hex`);
  return t;
}

/** A hosted agent's seed, in its signer: the AgentSeed operations over the agent's own socket. */
export class SignerSeed implements AgentSeed {
  readonly agent: string;
  readonly #line: Line;
  readonly #token: string;
  /**
   * Key roots (a root never changes) and records, by chain, vault and index. A record kept as none is right for as long
   * as nothing else signs with this agent's keys: the gateway gives each server of a home a token no other holds (the
   * one before is revoked), and this one forgets an index's record whenever it asks for a signature with that key.
   */
  readonly #roots = new Map<string, Hex>();
  readonly #records = new Map<string, WotsSignatureRecord | null>();
  /** Per index, how many signing requests were made with its key: a block of records read across one is not kept for it. */
  readonly #signings = new Map<string, number>();

  constructor(socket: string, agent: string, token: string) {
    if (!AGENT_ID.test(agent)) throw new RangeError("an agent id is lower case letters, digits and dashes (at most 63)");
    if (!/^[0-9a-f]{64}$/.test(token)) throw new RangeError("a signer token is 32 bytes of hex");
    this.agent = agent;
    this.#line = new Line(socket);
    this.#token = token;
  }

  static async open(c: SignerConfig): Promise<SignerSeed> {
    return new SignerSeed(c.socket, c.agent, await readToken(c.tokenFile));
  }

  #ask(op: AgentOp, args: Record<string, unknown>): Promise<unknown> {
    return this.#line.request({ agent: this.agent, token: this.#token, op, args: encode(args) });
  }

  close(): void {
    this.#line.close();
  }

  /** The key of index `index` of `vault`'s agent keychain on chain `chainId` in the maps. */
  static #key(chainId: number, vault: Address, index: bigint): string {
    return `${chainId}:${getAddress(vault)}:${index}`;
  }

  /** The first index of the block that holds `index`. */
  static #block(index: bigint): bigint {
    return index - (index % BATCH);
  }

  static #keep<V>(m: Map<string, V>, k: string, v: V): void {
    if (m.size >= KEPT) m.clear();
    m.set(k, v);
  }

  async agentKeyRoot(chainId: number, vault: Address, index: bigint): Promise<Hex> {
    const known = this.#roots.get(SignerSeed.#key(chainId, vault, index));
    if (known !== undefined) return known;
    const from = SignerSeed.#block(index);
    const r = await this.#ask("agent.keyRoots", { chainId, vault, from, count: Number(BATCH) });
    if (!Array.isArray(r) || r.length !== Number(BATCH)) throw new Error("the signer answered key roots that are not the ones asked for");
    const roots = r.map((x) => hexOf(x, "a key root", 32));
    roots.forEach((root, j) => SignerSeed.#keep(this.#roots, SignerSeed.#key(chainId, vault, from + BigInt(j)), root));
    return roots[Number(index - from)] as Hex;
  }

  async agentSigned(chainId: number, vault: Address, index: bigint): Promise<WotsSignatureRecord | undefined> {
    // The signer is the only record there is of this seed's keys: what it recorded is what was signed.
    return this.agentRecorded(chainId, vault, index);
  }

  async agentRecorded(chainId: number, vault: Address, index: bigint): Promise<WotsSignatureRecord | undefined> {
    const known = this.#records.get(SignerSeed.#key(chainId, vault, index));
    if (known !== undefined) return known ?? undefined;
    const from = SignerSeed.#block(index);
    const keys = Array.from({ length: Number(BATCH) }, (_, j) => SignerSeed.#key(chainId, vault, from + BigInt(j)));
    const before = keys.map((k) => this.#signings.get(k) ?? 0);
    const r = await this.#ask("agent.records", { chainId, vault, from, count: Number(BATCH) });
    if (!Array.isArray(r) || r.length !== Number(BATCH)) throw new Error("the signer answered records that are not the ones asked for");
    const records = r.map((x, j) => recordOf(x, from + BigInt(j)) ?? null);
    // Kept only for the keys no signing request was made with while the block was read.
    records.forEach((rec, j) => {
      if ((this.#signings.get(keys[j] as string) ?? 0) === before[j]) SignerSeed.#keep(this.#records, keys[j] as string, rec);
    });
    return records[Number(index - from)] ?? undefined;
  }

  async signAgentSpend(k: AgentSpendKey, a: { chainId: number; action: VaultAction; params: Hex }): Promise<SignedAgentSpend> {
    // Its record is asked for again after this request, whatever its answer (it may be signed even when no answer came).
    const at = SignerSeed.#key(a.chainId, k.vault, k.index);
    const mark = () => {
      this.#records.delete(at);
      if (this.#signings.size >= KEPT) this.#signings.clear();
      this.#signings.set(at, (this.#signings.get(at) ?? 0) + 1);
    };
    mark();
    let r: Record<string, unknown> | null;
    try {
      r = (await this.#ask("agent.signSpend", { key: k, spend: a })) as Record<string, unknown> | null;
    } finally {
      mark();
    }
    if (r === null || typeof r !== "object") throw new Error("the signer answered no agent spend");
    const message = bytesOf(r.message, "an agent spend message");
    const signature = hexOf(r.signature, "an agent spend signature");
    const nextKeyRoot = hexOf(r.nextKeyRoot, "the next key root", 32);
    // The spend asked for, signed by the key asked for: decoded from the very bytes signed, and verified.
    const d = decodeAgentSpendMessage(message);
    if (
      d.chainId !== a.chainId ||
      getAddress(d.vault) !== getAddress(k.vault) ||
      d.agentNonce !== k.agentNonce ||
      d.action !== a.action ||
      d.params.toLowerCase() !== a.params.toLowerCase() ||
      d.nextKeyRoot.toLowerCase() !== nextKeyRoot ||
      r.action !== a.action ||
      hexOf(r.params, "the params") !== a.params.toLowerCase()
    ) {
      throw new Error("the signer answered an agent spend other than the one asked for");
    }
    if (nextKeyRoot === k.keyRoot.toLowerCase() || nextKeyRoot === k.vaultKeyRoot.toLowerCase()) throw new Error("the signer answered a next key root that is the key signing or the vault's own");
    if (nextKeyRoot !== (await this.agentKeyRoot(a.chainId, k.vault, k.nextIndex)).toLowerCase()) throw new Error(`the signer answered a next key root that is not key ${k.nextIndex}'s`);
    if (!wotsVerify(Buffer.from(signature.slice(2), "hex"), message, Buffer.from(k.keyRoot.slice(2), "hex"))) throw new Error("the signer's agent spend signature does not verify against the agent key in force");
    return { action: a.action, nextKeyRoot, params: a.params, signature, message };
  }

  async voucherAddress(chainId: number, token: Address, salt: Hex): Promise<Address> {
    return addressOf(await this.#ask("voucher.address", { chainId, token, salt }), "a voucher key");
  }

  async signVoucher(chainId: number, token: Address, salt: Hex, v: VoucherFields): Promise<Hex> {
    return signatureOf(await this.#ask("voucher.sign", { chainId, token, salt, channelId: v.channelId, maxClaimableAmount: v.maxClaimableAmount }), "a voucher signature");
  }

  async signCloseRequest(chainId: number, token: Address, salt: Hex, c: CloseRequestFields): Promise<Hex> {
    return signatureOf(await this.#ask("voucher.signClose", { chainId, token, salt, vault: c.vault, channelId: c.channelId, amount: c.amount, nonce: c.nonce, deadline: c.deadline }), "a close request signature");
  }

  async paymentWalletAddress(chainId: number, token: Address, vault: Address): Promise<Address> {
    return addressOf(await this.#ask("payment.address", { chainId, token, vault }), "a payment wallet");
  }

  async signPaymentTransfer(chainId: number, token: Address, vault: Address, t: PaymentTransfer): Promise<Hex> {
    return signatureOf(
      await this.#ask("payment.signTransfer", { chainId, token, vault, name: t.name, version: t.version, to: t.to, value: t.value, validAfter: t.validAfter, validBefore: t.validBefore, nonce: t.nonce }),
      "a transfer signature",
    );
  }

  async tideSecret(chainId: number, tide: Address): Promise<Hex> {
    return hexOf(await this.#ask("tide.secret", { chainId, tide }), "a Tide link secret", 32);
  }

  async padPostingAddress(chainId: number, pad: Address): Promise<Address> {
    return addressOf(await this.#ask("pad.postingAddress", { chainId, pad }), "a posting key");
  }

  async signPadPost(chainId: number, pad: Address, m: PadPostMessage): Promise<Hex> {
    return signatureOf(await this.#ask("pad.signPost", { chainId, pad, message: m }), "an Ostrapad post signature");
  }

  async padKemPublicKey(chainId: number, pad: Address): Promise<Uint8Array> {
    // ML-KEM-768's public key: 1184 bytes.
    return bytesOf(await this.#ask("pad.kemPublicKey", { chainId, pad }), "an ML-KEM public key", 1184);
  }

  async padUnwrap(chainId: number, pad: Address, wrap: PadWrap, recipient: Address, keyCommit: Uint8Array): Promise<Uint8Array | null> {
    const r = await this.#ask("pad.unwrap", { chainId, pad, wrap, recipient, keyCommit });
    return r === null ? null : bytesOf(r, "a job key", 32);
  }
}

/**
 * The gateway's admin requests to the signer, on one connection to the admin socket (opened again when the signer
 * closed it): the signer takes few new connections a minute from one principal.
 */
export class SignerAdmin {
  readonly #line: Line;
  readonly #token: string;

  constructor(socket: string, adminKey: Uint8Array) {
    this.#line = new Line(socket);
    this.#token = adminToken(adminKey);
  }

  async #ask(op: "agent.create" | "agent.rotate", agent: string): Promise<Record<string, unknown>> {
    if (!AGENT_ID.test(agent)) throw new RangeError("an agent id is lower case letters, digits and dashes (at most 63)");
    const r = await this.#line.request({ admin: this.#token, op, args: { agent } });
    if (r === null || typeof r !== "object") throw new Error(`the signer answered ${op} with nothing`);
    return r as Record<string, unknown>;
  }

  close(): void {
    this.#line.close();
  }

  /** Makes the agent's seed if it has none (and opens its socket): whether it was made now, and its epoch. */
  async create(agent: string): Promise<{ created: boolean; epoch: number }> {
    const r = await this.#ask("agent.create", agent);
    if (typeof r.created !== "boolean" || !Number.isSafeInteger(r.epoch) || (r.epoch as number) < 0) throw new Error("the signer answered agent.create with no epoch");
    return { created: r.created, epoch: r.epoch as number };
  }

  /** Raises the agent's epoch: every token handed out for it before stops working. The new epoch. */
  async rotate(agent: string): Promise<number> {
    const r = await this.#ask("agent.rotate", agent);
    if (!Number.isSafeInteger(r.epoch) || (r.epoch as number) < 1) throw new Error("the signer answered agent.rotate with no epoch");
    return r.epoch as number;
  }
}
