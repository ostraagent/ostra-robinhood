#!/usr/bin/env node
// Ostra Cloud's signer (design 12 Nov 2026): the only process that holds the hosted agents' master seeds. It has no
// network (its container has none, and it opens no connection itself): it answers the typed operations of
// signer-protocol.ts on Unix sockets, one per agent and one for the admin (the gateway), and each request opens one
// agent's seed only. It signs nothing it did not build from typed fields (core seed-accounts.ts), keeps the
// agents' WOTS records (every one-time signature, written before it is used) on its own volume, and never hands out
// a seed, a secret key or a raw signature of the caller's choosing. The agents' fee payer keys stay with the agents.
//
//   OSTRA_SIGNER_SOCKETS         the directory of the signer's Unix sockets, at most 32 bytes long (a socket path has at
//                                most 107): admin/sock, whose directory only the gateway is given, and agent-<agent
//                                id>/sock, whose directory only that agent's sandbox is given (a directory, so that a
//                                socket made again on a restart is the one the sandbox sees); each socket 0660, and a
//                                socket serves only its own principal, so no process can take another's connections
//   OSTRA_SIGNER_ROOT            the signer's data (0700): agents/<agent id>/{seed.sealed,epoch,wots/}
//   OSTRA_SIGNER_ADMIN_KEY_FILE  32 bytes, hex (0600): the admin key the agent and admin tokens derive from
//   OSTRA_SIGNER_ADMIN_KEY_CREATE  "yes": the signer makes that file (32 random bytes) when it is missing, so that the
//                                key is born in the enclave (Ostra Cloud's compose shares it with the gateway only)
//   OSTRA_SIGNER_SEAL            "dstack" (the seal key from the dstack guest agent's GetKey, bound to the app) or
//                                "file:<path>" (32 bytes, hex, 0600: outside a TEE, for the operator's tests)
//   OSTRA_SIGNER_RATE            the signing operations one agent may make per minute (default 120)
//   OSTRA_SIGNER_WORK_RATE       the key roots (and record reads, 8 to a unit) one agent may ask for per minute (default 1024)
//   DSTACK_SOCK                  the dstack guest agent's socket (default /var/run/dstack.sock)
//
// The dstack socket is mounted into the signer's container only: GetKey derives from the app key and the path alone,
// so any container of the app that reaches the socket would get the same seal key.
//
// A seed is sealed with AES-256-GCM under a key derived (HKDF-SHA256) from the seal key, the agent id as associated
// data, so a sealed seed opens only in this app, and only as the agent it was made for. Logs are JSON lines on stderr
// and never carry a seed, a key, a token or a signed payload.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { chmodSync, constants, existsSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, PAD_ENC_KIND, WotsKeyMismatchError, WotsKeyReuseError, type PadEncKind } from "@ostraagent/sdk";
import { Keys, type PadPostMessage } from "@ostraagent/core";
import { DiskFolder, ensurePrivateDir } from "./disk.ts";
import {
  AGENT_ID,
  AGENT_OPS,
  BadRequest,
  MAX_BATCH,
  MAX_LINE,
  MAX_OPEN,
  SIGNING_OPS,
  address,
  adminToken,
  agentAction,
  agentToken,
  bytes,
  chainId,
  encode,
  exact,
  hex,
  obj,
  smallInt,
  uint,
  type AgentOp,
} from "./signer-protocol.ts";

const SEAL_INFO = "OSTRA/CLOUD/SIGNER/SEAL/v1";
const SEAL_PATH = "ostra-cloud/signer/seal/v1";
/** The agent keychains (one per chain and vault) one agent's open Keys may hold before it is opened afresh. */
const MAX_KEYCHAINS = 16;
/**
 * Connections: a socket serves one principal (an agent, or the admin) and holds at most SOCKET_CONNECTIONS; a
 * connection must make an authorized request within AUTH_MS, and one with no request answered for IDLE_MS is closed.
 * Whatever reaches one agent's socket can take only that agent's connections.
 */
const SOCKET_CONNECTIONS = 16;
const AUTH_MS = 5_000;
const IDLE_MS = 5 * 60_000;
/**
 * What one principal may send per minute, refused or not: request lines, bytes (lines unfinished and blank ones
 * too) and connections. Past one, the connection that went past it is closed (a new one past the connection limit at
 * once), so traffic that costs the signer work is always charged to whoever sends it.
 */
const LINES_PER_MINUTE = 1_200;
const BYTES_PER_MINUTE = 16 * 1024 * 1024;
/**
 * The lock on the root is a lease: its holder touches it every LEASE_MS / 3, and another signer takes it over only
 * once it went untouched for LEASE_MS (so a restarted signer waits for its earlier run's lease to lapse).
 */
const LEASE_MS = 30_000;
const CONNECTIONS_PER_MINUTE = 120;
/** Answers a connection may leave unread before the signer stops reading its requests until they are read. */
const WRITE_CAP = 256 * 1024;
/** The longest sockets directory: "/agent-" + a 63-character id + "/sock" stays within a socket path's 107 bytes. */
export const MAX_SOCKETS_DIR = 107 - "/agent-".length - 63 - "/sock".length;
/** The associated data of the canary: not an agent id (AGENT_ID has no "/"), so no seed can be swapped in for it. */
const CANARY_AAD = "OSTRA/CLOUD/SIGNER/CANARY/v1";

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

async function hexFile(path: string, what: string): Promise<Uint8Array> {
  const s = await stat(path);
  if ((s.mode & 0o077) !== 0) throw new Error(`${what} ${path} must not be accessible by other users (chmod 600 it)`);
  const t = (await readFile(path, "utf8")).trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(t)) throw new Error(`${what} ${path} must hold 32 bytes as hex`);
  return Buffer.from(t, "hex");
}

/**
 * The dstack guest agent's GetKey (POST /GetKey over its Unix socket, the surface @phala/dstack-sdk getKey uses): the
 * secp256k1 key derived from this app's key and `path` (guest-agent rpc_service.rs get_key; `purpose` only names the
 * key in its signature chain).
 */
export function dstackGetKey(sock: string, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ path, purpose: "", algorithm: "secp256k1" });
    const q = httpRequest(
      { socketPath: sock, path: "/GetKey", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let b = "";
        res.on("data", (x) => (b += x));
        res.on("end", () => {
          let k: Buffer;
          try {
            k = Buffer.from((JSON.parse(b) as { key?: string }).key ?? "", "hex");
          } catch {
            return reject(new Error(`dstack GetKey answered ${res.statusCode} without a key`));
          }
          if (res.statusCode !== 200 || k.length !== 32) return reject(new Error(`dstack GetKey answered ${res.statusCode} without a 32-byte key`));
          resolve(k);
        });
      },
    );
    q.setTimeout(20_000, () => q.destroy(new Error("dstack GetKey timeout")));
    q.on("error", reject);
    q.end(body);
  });
}

/**
 * The seal key from dstack, refused unless the guest agent derived it from the path and nothing else: the same path
 * twice gives the same key, two paths two keys. (The canary in Signer.listen also checks it is the key the seeds on
 * this volume were sealed with.)
 */
export async function dstackKey(sock: string): Promise<Uint8Array> {
  const key = await dstackGetKey(sock, SEAL_PATH);
  const again = await dstackGetKey(sock, SEAL_PATH);
  const other = await dstackGetKey(sock, `${SEAL_PATH}/check`);
  const stable = key.equals(again);
  const fromPath = !key.equals(other);
  again.fill(0);
  other.fill(0);
  if (!stable || !fromPath) {
    key.fill(0);
    throw new Error(stable ? "dstack GetKey gave one key for two paths: it did not derive from the path" : "dstack GetKey gave two keys for one path");
  }
  return key;
}

type Sealed = { v: 1; iv: string; ct: string; tag: string };

function sealKeyFor(sealKey: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", sealKey, Buffer.alloc(0), SEAL_INFO, 32));
}

function seal(key: Buffer, agent: string, seed: Uint8Array): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(agent));
  const ct = Buffer.concat([c.update(seed), c.final()]);
  return { v: 1, iv: iv.toString("hex"), ct: ct.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

/** The seed, in a buffer of its own (not the shared pool): the caller zeroes it. */
function unseal(key: Buffer, agent: string, s: Sealed): Buffer {
  if (s.v !== 1) throw new Error("unknown sealed seed version");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "hex"));
  d.setAAD(Buffer.from(agent));
  d.setAuthTag(Buffer.from(s.tag, "hex"));
  const a = d.update(Buffer.from(s.ct, "hex"));
  const b = d.final();
  const seed = Buffer.alloc(32);
  const n = a.length + b.length;
  if (n === 32) {
    a.copy(seed, 0);
    b.copy(seed, a.length);
  }
  a.fill(0);
  b.fill(0);
  if (n !== 32) throw new Error("a sealed seed is not 32 bytes");
  return seed;
}

/** Writes `text` to `dir/name` only if it does not exist yet, whole or not at all: false when it existed. */
async function createWhole(dir: string, name: string, text: string): Promise<boolean> {
  const path = join(dir, name);
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const f = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await f.writeFile(text, "utf8");
    await f.sync();
  } finally {
    await f.close();
  }
  try {
    await link(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  const d = await open(dir, constants.O_RDONLY);
  try {
    await d.sync();
  } finally {
    await d.close();
  }
  return true;
}

/**
 * Whether the Unix socket at `path` may belong to a signer still running: false only when nothing listens there for
 * sure (the connection is refused, or the file is gone); anything else (accepted, a full backlog, no permission)
 * counts as running, so that a socket is never taken over on a doubt.
 */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", (err: NodeJS.ErrnoException) => done(err.code !== "ECONNREFUSED" && err.code !== "ENOENT"));
  });
}

/**
 * Per principal, a bucket of `perMinute` units that refills continuously: constant memory however small the units
 * taken (bytes arrive in chunks of any size).
 */
class Bucket {
  readonly #level = new Map<string, { units: number; at: number }>();
  readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  take(principal: string, n: number): boolean {
    const now = performance.now();
    const b = this.#level.get(principal) ?? { units: this.perMinute, at: now };
    const units = Math.min(this.perMinute, b.units + ((now - b.at) * this.perMinute) / 60_000);
    if (units < n) {
      this.#level.set(principal, { units, at: now });
      return false;
    }
    this.#level.set(principal, { units: units - n, at: now });
    return true;
  }
}

/** Per agent, the units taken in the last minute. */
class Budget {
  readonly #taken = new Map<string, { t: number; n: number }[]>();
  readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  /** Whether `n` more units fit in the agent's last minute. */
  fits(agent: string, n: number): boolean {
    const now = performance.now();
    const used = (this.#taken.get(agent) ?? []).reduce((sum, x) => (now - x.t < 60_000 ? sum + x.n : sum), 0);
    return used + n <= this.perMinute;
  }

  take(agent: string, n: number): boolean {
    const now = performance.now();
    const r = (this.#taken.get(agent) ?? []).filter((x) => now - x.t < 60_000);
    const used = r.reduce((s, x) => s + x.n, 0);
    if (used + n > this.perMinute) {
      if (r.length === 0) this.#taken.delete(agent);
      else this.#taken.set(agent, r);
      return false;
    }
    r.push({ t: now, n });
    this.#taken.set(agent, r);
    return true;
  }
}

/** Errors whose message is the caller's to read: a refusal of its request. Any other is the signer's own fault. */
function told(err: unknown): err is Error {
  return err instanceof BadRequest || err instanceof WotsKeyReuseError || err instanceof WotsKeyMismatchError || err instanceof RangeError;
}

export type SignerOptions = {
  /** The directory of the sockets: admin/sock and agent-<agent id>/sock. */
  sockets: string;
  root: string;
  adminKey: Uint8Array;
  sealKey: Uint8Array;
  rate: number;
  workRate?: number;
  /** How long a new connection has to make its first authorized request (default AUTH_MS). */
  authMs?: number;
  /** The root lock's lease (default LEASE_MS). */
  leaseMs?: number;
  /** Called once if the lease is lost (another signer took the root over): main() exits non-zero then. */
  onLeaseLost?: () => void;
};

/**
 * A connection: the principal its socket serves (an agent id, or ADMIN, which is not one), whether it made an
 * authorized request, whether it closed, and when it last had an answer.
 */
type Conn = { principal: string; authorized: boolean; closed: boolean; last: number };

/** The admin's principal (the gateway): not an agent id (AGENT_ID has no "#"). */
export const ADMIN = "#admin";

/** The socket of an agent, or of the admin, in the sockets directory: each in a directory of its own. */
export function socketPath(dir: string, principal: string): string {
  return join(dir, principal === ADMIN ? "admin" : `agent-${principal}`, "sock");
}

/** The signer: its sockets and the agents it holds. close() stops it. */

export class Signer {
  readonly #o: SignerOptions;
  readonly #seal: Buffer;
  readonly #admin: Buffer;
  readonly #keys = new Map<string, Keys>();
  /** Per agent, the (chain, vault) agent keychains its open Keys holds. */
  readonly #keychains = new Map<string, Set<string>>();
  readonly #epochs = new Map<string, number>();
  /** Per agent, the requests one after the other: a WOTS index is never asked for twice at once. */
  readonly #queue = new Map<string, Promise<unknown>>();
  readonly #open = new Map<string, number>();
  readonly #signing: Budget;
  readonly #work: Budget;
  readonly #sockets = new Set<Socket>();
  /** Per principal, its socket's server and its open connections. */
  readonly #servers = new Map<string, Promise<Server>>();
  readonly #connections = new Map<string, number>();
  readonly #lines: Budget;
  readonly #bytes: Bucket;
  readonly #accepts: Bucket;
  /** The lock on the root: one signer at a time on these seeds (released by close): this instance's nonce in it, and
   *  the timer that keeps its lease. */
  #lockNonce: string | undefined;
  #lease: NodeJS.Timeout | undefined;
  #leaseTouched = 0;
  #leaseGone = 0;
  #leaseMs = LEASE_MS;
  #closing = false;
  /** The fee payer Keys requires: never used by any operation here (each agent's own stays with the agent). */
  readonly #unusedFeePayer = privateKeyToAccount(generatePrivateKey());

  constructor(o: SignerOptions) {
    this.#o = o;
    this.#seal = sealKeyFor(o.sealKey);
    this.#admin = Buffer.from(adminToken(o.adminKey), "hex");
    this.#signing = new Budget(o.rate);
    this.#work = new Budget(o.workRate ?? 1024);
    this.#lines = new Budget(LINES_PER_MINUTE);
    this.#bytes = new Bucket(BYTES_PER_MINUTE);
    this.#accepts = new Bucket(CONNECTIONS_PER_MINUTE);
    if (Buffer.byteLength(o.sockets) > MAX_SOCKETS_DIR) throw new Error(`the sockets directory must be at most ${MAX_SOCKETS_DIR} bytes long`);
  }

  /** Opens the admin socket and the socket of every agent with a seed here. */
  async listen(): Promise<void> {
    await ensurePrivateDir(this.#o.root);
    await this.#takeLock();
    try {
      await ensurePrivateDir(join(this.#o.root, "agents"));
      await this.#canary();
      await this.#listenFor(ADMIN);
      for (const agent of await readdir(join(this.#o.root, "agents"))) {
        if (!AGENT_ID.test(agent) || !existsSync(join(this.#dir(agent), "seed.sealed"))) continue;
        // One agent's socket that cannot open does not keep the others (or the admin) from theirs.
        await this.#listenFor(agent).catch((err: Error) => log("socket_failed", { agent, message: err.message.slice(0, 120) }));
      }
    } catch (err) {
      // A start that fails lets go of what it took: its sockets and its lease.
      await this.close();
      throw err;
    }
  }

  /**
   * One signer at a time on a root: two would each keep their own epochs (a token one revoked would still open on the
   * other) and race on the sockets. The lock is a lease file (this instance's random nonce, made whole and exclusively):
   * its holder touches it every lease / 3, and checks it still names its nonce (if not, it was taken over: it stops);
   * one untouched for a whole lease (a crash, this container's earlier run) is taken over, by renaming it away first
   * (a live lease renamed by mistake, when another signer took the lapsed one first, is put back). A lock that
   * cannot be read counts as held until it lapses. A signer that finds a live lease waits up to two leases for it to
   * lapse, then refuses to start.
   */
  async #takeLock(): Promise<void> {
    const lease = this.#o.leaseMs ?? LEASE_MS;
    if (!Number.isSafeInteger(lease) || lease < 100 || lease > 10 * LEASE_MS) throw new Error("leaseMs out of range");
    const path = join(this.#o.root, "signer.lock");
    const nonce = randomBytes(16).toString("hex");
    // Whether a lease lapsed is seen, not computed from clocks: it lapsed once it stayed the same (content and mtime)
    // for its holder's whole lease, timed here on the monotonic clock. Wall clocks never decide it.
    let seen: { key: string; since: number } | undefined;
    const started = performance.now();
    for (;;) {
      if (await createWhole(this.#o.root, "signer.lock", `${nonce} ${lease}\n`)) break;
      let st;
      let text: string;
      try {
        st = await stat(path);
        text = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      // The lease its holder keeps (as it wrote it), or this signer's own for one that cannot be read.
      const held = Number(text.trim().split(" ")[1]);
      const theirs = Number.isSafeInteger(held) && held >= 100 && held <= 10 * LEASE_MS ? held : lease;
      const key = `${st.mtimeMs} ${st.ino} ${text}`;
      const now = performance.now();
      if (seen === undefined || seen.key !== key) seen = { key, since: now };
      if (now - seen.since > theirs) {
        // Lapsed: renamed away (only one signer's rename takes this file), then made anew.
        const away = `${path}.lapsed-${randomBytes(6).toString("hex")}`;
        try {
          await rename(path, away);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          continue;
        }
        // What was renamed may be a lease another signer made meanwhile (it took the lapsed one first): put it back
        // where it was, unless a newer one is there already.
        const moved = await stat(away);
        if (`${moved.mtimeMs} ${moved.ino} ${await readFile(away, "utf8")}` !== key) {
          await link(away, path).catch(() => undefined);
        }
        await unlink(away).catch(() => undefined);
        seen = undefined;
        continue;
      }
      if (now - started > 2 * Math.max(lease, theirs)) {
        throw new Error("another signer holds this signer's root (its lease is kept)");
      }
      await new Promise((r) => setTimeout(r, Math.min(1_000, lease / 3)));
    }
    this.#lockNonce = nonce;
    this.#leaseMs = lease;
    this.#leaseTouched = performance.now();
    this.#lease = setInterval(() => void this.#keepLease(path, lease), lease / 3);
    this.#lease.unref();
  }

  /**
   * Touches the lease. If the lock names another signer (read, and different), or is gone twice in a row, the root was
   * taken over: this signer stops. If touching fails for two thirds of a lease, others may soon see it lapsed: it
   * stops too, rather than serve beside a new holder.
   */
  async #keepLease(path: string, lease: number): Promise<void> {
    const nonce = this.#lockNonce;
    if (nonce === undefined || this.#closing) return;
    // Untouched for two thirds of a lease (a stalled process, a touch that hung): another signer may take the root
    // soon, so this one stops. Short of that it touches again and is fresh again (no signer takes a lease over before
    // a whole lease of no change).
    if (performance.now() - this.#leaseTouched > (2 * lease) / 3) return this.#loseLease("lease_untouched");
    let held: string | undefined;
    try {
      held = (await readFile(path, "utf8")).trim().split(" ")[0];
      this.#leaseGone = 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && ++this.#leaseGone >= 2) held = "";
    }
    if (held !== undefined && held !== nonce) return this.#loseLease("lease_lost");
    if (held === nonce) {
      try {
        // The time is taken before the touch: the file changes no later than this.
        const at = performance.now();
        const now = new Date();
        await utimes(path, now, now);
        this.#leaseTouched = at;
        return;
      } catch (err) {
        log("lease_error", { message: (err as Error).message.slice(0, 120) });
      }
    }
    if (performance.now() - this.#leaseTouched > (2 * lease) / 3) return this.#loseLease("lease_untouched");
  }

  /**
   * Whether this signer's lease was touched within half a lease: no request is served otherwise (checked with no I/O,
   * so a signer resumed after a stall refuses at once, before its timer has even run).
   */
  #leaseFresh(): boolean {
    return this.#lockNonce !== undefined && performance.now() - this.#leaseTouched <= this.#leaseMs / 2;
  }

  async #loseLease(event: string): Promise<void> {
    if (this.#lockNonce === undefined) return;
    log(event, {});
    // Not this signer's lease any more: close() must not remove it.
    this.#lockNonce = undefined;
    this.#o.onLeaseLost?.();
    await this.close();
  }

  /** Opens the socket of `principal` (once; a failure is forgotten, so a later call tries again). */
  #listenFor(principal: string): Promise<Server> {
    if (this.#closing) return Promise.reject(new Error("the signer is stopping"));
    let p = this.#servers.get(principal);
    if (p === undefined) {
      p = this.#open1(principal);
      this.#servers.set(principal, p);
      p.catch(() => {
        if (this.#servers.get(principal) === p) this.#servers.delete(principal);
      });
    }
    return p;
  }

  async #open1(principal: string): Promise<Server> {
    const path = socketPath(this.#o.sockets, principal);
    // The socket's own directory, 0750 whatever it was before (a sandbox that could write there could swap the socket).
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const st = await lstat(dir);
    if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
    if ((st.mode & 0o777) !== 0o750) await chmod(dir, 0o750);
    if (existsSync(path)) {
      // A socket that answers belongs to a signer still running: it is not taken over.
      if (await answers(path)) throw new Error(`another signer is listening on ${path}`);
      await unlink(path);
    }
    if (this.#closing) throw new Error("the signer is stopping");
    const server = createServer({ allowHalfOpen: true }, (s) => this.#serve(s, principal));
    // The socket is born 0660 (no moment with wider access): a Unix socket is bound within listen() itself, so the
    // umask is put back at once.
    const listening = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const mask = process.umask(0o117);
    try {
      server.listen(path);
    } finally {
      process.umask(mask);
    }
    await listening;
    // A failure of a socket while it runs (no file descriptor left, say) is logged; its connections keep their own.
    server.on("error", (err) => log("socket_error", { principal: principal === ADMIN ? "admin" : principal, message: err.message.slice(0, 120) }));
    try {
      chmodSync(path, 0o660);
      if (this.#closing) throw new Error("the signer is stopping");
    } catch (err) {
      server.close();
      throw err;
    }
    log("listening", { socket: path });
    return server;
  }

  /**
   * The canary: a value sealed under the seal key when the signer first ran on this volume. It must open, or the
   * signer refuses to start: a seal key that is not the one the seeds were sealed with (another app, a GetKey that
   * changed) would otherwise seal new seeds that never open again after the next restart.
   */
  async #canary(): Promise<void> {
    const text = await new DiskFolder(this.#o.root).read("canary.sealed");
    if (text === undefined) {
      // No canary yet. If seeds are here already, the key must open one of them before it seals anything (one that
      // does not open may be a copy or tampered with: any one that opens shows the key is theirs).
      let seeds = 0;
      let opened = false;
      for (const agent of await readdir(join(this.#o.root, "agents"))) {
        const sealed = AGENT_ID.test(agent) ? await new DiskFolder(this.#dir(agent)).read("seed.sealed") : undefined;
        if (sealed === undefined) continue;
        seeds++;
        try {
          unseal(this.#seal, agent, JSON.parse(sealed) as Sealed).fill(0);
          opened = true;
          break;
        } catch {
          // Try the next one.
        }
      }
      if (seeds > 0 && !opened) {
        throw new Error("the seal key does not open the seeds here and there is no canary: it is not the key they were sealed with");
      }
      const value = randomBytes(32);
      try {
        await createWhole(this.#o.root, "canary.sealed", JSON.stringify(seal(this.#seal, CANARY_AAD, value)));
      } finally {
        value.fill(0);
      }
      return;
    }
    try {
      unseal(this.#seal, CANARY_AAD, JSON.parse(text) as Sealed).fill(0);
    } catch {
      throw new Error("the seal key does not open this signer's canary: it is not the key the seeds here were sealed with");
    }
  }

  /** Stops taking requests, lets the requests under way finish, then closes every connection. */
  async close(): Promise<void> {
    this.#closing = true;
    const servers = (await Promise.allSettled([...this.#servers.values()])).flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const closed = servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
    await Promise.allSettled([...this.#queue.values()]);
    for (const s of this.#sockets) s.destroy();
    await Promise.all(closed);
    this.#servers.clear();
    if (this.#lease !== undefined) clearInterval(this.#lease);
    this.#lease = undefined;
    const nonce = this.#lockNonce;
    this.#lockNonce = undefined;
    if (nonce !== undefined) {
      // Only its own lease: never one another signer holds now.
      const path = join(this.#o.root, "signer.lock");
      if ((await readFile(path, "utf8").catch(() => "")).trim().split(" ")[0] === nonce) await unlink(path).catch(() => undefined);
    }
  }

  #dir(agent: string): string {
    return join(this.#o.root, "agents", agent);
  }

  /** The agent's epoch: 0 until it is rotated, and for an agent with no seed here (not kept, so ids asked for do not pile up). */
  async #epoch(agent: string): Promise<number> {
    const e = this.#epochs.get(agent);
    if (e !== undefined) return e;
    if (!existsSync(join(this.#dir(agent), "seed.sealed"))) return 0;
    const text = await new DiskFolder(this.#dir(agent)).read("epoch");
    const t = text?.trim() ?? "0";
    if (!/^(0|[1-9][0-9]{0,14})$/.test(t)) throw new Error(`agent ${agent} has a corrupt epoch`);
    const n = Number(t);
    this.#epochs.set(agent, n);
    return n;
  }

  /** Creates the agent's seed if it has none: true when it was created now. */
  async #create(agent: string): Promise<boolean> {
    const folder = new DiskFolder(this.#dir(agent));
    await folder.ensure();
    if ((await folder.read("seed.sealed")) !== undefined) return false;
    const seed = randomBytes(32);
    let created: boolean;
    try {
      created = await createWhole(this.#dir(agent), "seed.sealed", JSON.stringify(seal(this.#seal, agent, seed)));
    } finally {
      seed.fill(0);
    }
    if (created) log("agent_created", { agent });
    return created;
  }

  /** Raises the agent's epoch: every token handed out for it before stops working. */
  async #rotate(agent: string): Promise<number> {
    if (!existsSync(join(this.#dir(agent), "seed.sealed"))) throw new BadRequest(`agent ${agent} has no seed here`);
    const next = (await this.#epoch(agent)) + 1;
    await new DiskFolder(this.#dir(agent)).write("epoch", `${next}\n`);
    this.#epochs.set(agent, next);
    log("agent_rotated", { agent, epoch: next });
    return next;
  }

  async #keysOf(agent: string): Promise<Keys> {
    const k = this.#keys.get(agent);
    if (k !== undefined) return k;
    const folder = new DiskFolder(this.#dir(agent));
    const text = existsSync(this.#dir(agent)) ? await folder.read("seed.sealed") : undefined;
    if (text === undefined) throw new BadRequest(`agent ${agent} has no seed here`);
    let master: Buffer;
    try {
      master = unseal(this.#seal, agent, JSON.parse(text) as Sealed);
    } catch (err) {
      // A sealed seed that does not open here: another app's, another agent's, or tampered with.
      log("unseal_failed", { agent, message: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
      throw new Error("unseal failed");
    }
    // Keys copies its master with slice(), which on a Buffer is a view: it is given a plain Uint8Array (whose slice is
    // a copy), and both buffers here are zeroed once it holds its own.
    const plain = new Uint8Array(master);
    try {
      await ensurePrivateDir(join(this.#dir(agent), "wots"));
      const keys = new Keys({
        master: plain,
        feePayer: this.#unusedFeePayer,
        store: new FileWotsStore(join(this.#dir(agent), "wots")),
        folder,
        backupExported: async () => true,
        escrow: null,
      });
      this.#keys.set(agent, keys);
      this.#keychains.set(agent, new Set());
      return keys;
    } finally {
      master.fill(0);
      plain.fill(0);
    }
  }

  /** Notes the agent keychain (chain, vault) a request uses; past MAX_KEYCHAINS the agent's Keys is opened afresh next time. */
  #keychain(agent: string, c: number, vault: string): void {
    const set = this.#keychains.get(agent);
    if (set === undefined) return;
    set.add(`${c}:${vault}`);
    if (set.size > MAX_KEYCHAINS) {
      this.#keys.delete(agent);
      this.#keychains.delete(agent);
    }
  }

  #serve(s: Socket, principal: string): void {
    const n = this.#connections.get(principal) ?? 0;
    if (this.#closing || n >= SOCKET_CONNECTIONS || !this.#accepts.take(principal, 1)) {
      s.destroy();
      return;
    }
    this.#connections.set(principal, n + 1);
    this.#sockets.add(s);
    const conn: Conn = { principal, authorized: false, closed: false, last: performance.now() };
    let buf = "";
    let open = 0;
    let ended = false;
    const finish = () => {
      if (ended && open === 0 && !s.destroyed) s.end();
    };
    // Answers left unread past WRITE_CAP: no more requests are read from this connection until they are.
    let stopped = false;
    const send = (a: unknown) => {
      s.write(`${JSON.stringify(a)}\n`);
      if (s.writableLength > WRITE_CAP && !s.isPaused()) {
        s.pause();
        s.once("drain", () => {
          if (!stopped) s.resume();
        });
      }
    };
    const auth = setTimeout(() => {
      if (!conn.authorized) s.destroy();
    }, this.#o.authMs ?? AUTH_MS);
    const idle = setInterval(() => {
      if (open === 0 && performance.now() - conn.last > IDLE_MS) s.destroy();
    }, Math.min(IDLE_MS, 30_000));
    auth.unref();
    idle.unref();
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      // Every byte costs its principal, a line finished or not.
      if (!this.#bytes.take(principal, Buffer.byteLength(chunk))) {
        log("bytes_exceeded", { principal: principal === ADMIN ? "admin" : principal });
        s.destroy();
        return;
      }
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0 || buf.length > MAX_LINE) {
        if (i < 0 || i > MAX_LINE) {
          buf = "";
          stopped = true;
          s.removeAllListeners("data");
          s.pause();
          s.end(`${JSON.stringify({ id: null, ok: false, error: "request too large" })}\n`, () => s.destroy());
          return;
        }
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() === "") continue;
        // Every line costs its principal, refused or not: past the limit the connection that sent it is closed.
        if (!this.#lines.take(principal, 1)) {
          log("lines_exceeded", { principal: principal === ADMIN ? "admin" : principal });
          s.destroy();
          return;
        }
        if (this.#closing) {
          send({ id: null, ok: false, error: "the signer is stopping" });
          continue;
        }
        if (open >= MAX_OPEN) {
          send({ id: null, ok: false, error: "too many open requests on this connection" });
          continue;
        }
        open++;
        void this.#answer(line, conn).then((a) => {
          open--;
          if (conn.authorized) conn.last = performance.now();
          if (!s.destroyed && s.writable) send(a);
          finish();
        });
      }
    });
    s.on("end", () => {
      ended = true;
      finish();
    });
    s.on("close", () => {
      conn.closed = true;
      clearTimeout(auth);
      clearInterval(idle);
      this.#sockets.delete(s);
      const left = (this.#connections.get(principal) ?? 1) - 1;
      if (left <= 0) this.#connections.delete(principal);
      else this.#connections.set(principal, left);
    });
    s.on("error", () => s.destroy());
  }

  /** A request's principal must be its socket's: a socket serves no one else. */
  #only(conn: Conn, principal: string): void {
    if (conn.principal !== principal) throw new BadRequest("this socket serves another principal");
    if (!conn.closed) conn.authorized = true;
  }

  async #answer(line: string, conn: Conn): Promise<{ id: unknown; ok: boolean; result?: unknown; error?: string }> {
    let id: unknown = null;
    try {
      // Not served while the lease is not fresh (its timer decides whether it is lost).
      if (!this.#leaseFresh()) throw new Error("lease not held");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new BadRequest("a request must be one JSON object on one line");
      }
      const r = obj(parsed, "a request");
      id = r.id ?? null;
      if (typeof id !== "number" && typeof id !== "string") throw new BadRequest("id must be a number or a string");
      if (r.op === "agent.create" || r.op === "agent.rotate") {
        exact(r, ["id", "admin", "op", "args"], "an admin request");
        if (conn.principal !== ADMIN) throw new BadRequest("this socket serves another principal");
        if (!this.#tokenOk(r.admin, this.#admin)) throw new BadRequest("not authorized");
        this.#only(conn, ADMIN);
        const a = exact(obj(r.args, "args"), ["agent"], r.op);
        if (typeof a.agent !== "string" || !AGENT_ID.test(a.agent)) throw new BadRequest("agent must be an agent id");
        const agent = a.agent;
        if (r.op === "agent.rotate") return { id, ok: true, result: { epoch: await this.#serial(agent, () => this.#rotate(agent)) } };
        // The agent's own socket first (for its sandbox, which the gateway gives it to only): a seed is never made for an
        // agent that could not be reached.
        await this.#listenFor(agent);
        const created = await this.#serial(agent, () => this.#create(agent));
        return { id, ok: true, result: { created, epoch: await this.#epoch(agent) } };
      }
      exact(r, ["id", "agent", "token", "op", "args"], "a request");
      if (typeof r.agent !== "string" || !AGENT_ID.test(r.agent)) throw new BadRequest("agent must be an agent id");
      const agent = r.agent;
      if (conn.principal !== agent) throw new BadRequest("this socket serves another principal");
      const epoch = await this.#epoch(agent);
      if (!this.#tokenOk(r.token, Buffer.from(agentToken(this.#o.adminKey, agent, epoch), "hex"))) throw new BadRequest("not authorized");
      this.#only(conn, agent);
      if (typeof r.op !== "string" || !(AGENT_OPS as readonly string[]).includes(r.op)) throw new BadRequest("unknown op");
      const op = r.op as AgentOp;
      const args = obj(r.args, "args");
      const open = this.#open.get(agent) ?? 0;
      if (open >= MAX_OPEN) throw new BadRequest("too many open requests for this agent");
      // Every request costs work: a key root a WOTS key derivation (milliseconds of CPU), eight records a unit of file
      // reads, any other request one unit (an address or a KEM key is a derivation too). Both budgets are checked
      // before either is charged.
      let units = 1;
      if (op === "agent.keyRoots" || op === "agent.records") {
        const n = smallInt(args.count, "count", MAX_BATCH);
        units = Math.max(1, op === "agent.keyRoots" ? n : Math.ceil(n / 8));
      }
      const signing = SIGNING_OPS.has(op);
      if (signing && !this.#signing.fits(agent, 1)) throw new BadRequest("rate limit: too many signing requests this minute");
      if (!this.#work.fits(agent, units)) throw new BadRequest("rate limit: too much work asked for this minute");
      if (signing) this.#signing.take(agent, 1);
      this.#work.take(agent, units);
      this.#open.set(agent, open + 1);
      try {
        const result = await this.#serial(agent, async () => {
          // A token revoked (agent.rotate) while this request waited in the queue no longer counts.
          if ((await this.#epoch(agent)) !== epoch) throw new BadRequest("not authorized");
          return this.#op(agent, await this.#keysOf(agent), op, args);
        });
        return { id, ok: true, result: encode(result) };
      } finally {
        const left = (this.#open.get(agent) ?? 1) - 1;
        if (left <= 0) this.#open.delete(agent);
        else this.#open.set(agent, left);
      }
    } catch (err) {
      // A refusal of the request (its fields, a WOTS key that signed something else, an expected root) is told; any
      // other error is the signer's own (its storage, a seed that does not open) and is logged here, answered without
      // its details (paths, internals).
      if (told(err)) return { id, ok: false, error: err.message };
      log("error", { message: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      return { id, ok: false, error: "the signer could not answer this request" };
    }
  }

  /** Runs `f` after the agent's earlier requests; a failure does not hold the next one. */
  #serial<T>(agent: string, f: () => Promise<T>): Promise<T> {
    const prev = this.#queue.get(agent) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => {
      // Work that waited in the queue runs only while this signer still holds the root.
      if (!this.#leaseFresh()) throw new Error("lease not held");
      return f();
    });
    this.#queue.set(agent, run);
    void run
      .catch(() => undefined)
      .then(() => {
        if (this.#queue.get(agent) === run) this.#queue.delete(agent);
      });
    return run;
  }

  #tokenOk(v: unknown, want: Buffer): boolean {
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) return false;
    return timingSafeEqual(Buffer.from(v, "hex"), want);
  }

  async #op(agent: string, k: Keys, op: AgentOp, a: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "agent.keyRoots": {
        exact(a, ["chainId", "vault", "from", "count"], op);
        const c = chainId(a.chainId);
        const vault = address(a.vault, "vault");
        const from = uint(a.from, "from", 64);
        const n = smallInt(a.count, "count", MAX_BATCH);
        this.#keychain(agent, c, vault);
        const out: string[] = [];
        for (let i = 0n; i < BigInt(n); i++) {
          out.push(await k.agentKeyRoot(c, vault, from + i));
          // A key root is milliseconds of CPU: the event loop gets a turn every few, so that no batch stalls the
          // lease's timer or the other agents.
          if (i % 4n === 3n) await new Promise((r) => setImmediate(r));
        }
        return out;
      }
      case "agent.records": {
        exact(a, ["chainId", "vault", "from", "count"], op);
        const c = chainId(a.chainId);
        const vault = address(a.vault, "vault");
        const from = uint(a.from, "from", 64);
        const n = smallInt(a.count, "count", MAX_BATCH);
        this.#keychain(agent, c, vault);
        const out: unknown[] = [];
        for (let i = 0n; i < BigInt(n); i++) out.push((await k.agentRecorded(c, vault, from + i)) ?? null);
        return out;
      }
      case "agent.signSpend": {
        exact(a, ["key", "spend"], op);
        const key = exact(obj(a.key, "key"), ["vault", "agentNonce", "keyRoot", "vaultKeyRoot", "index", "nextIndex"], "key");
        const s = exact(obj(a.spend, "spend"), ["chainId", "action", "params"], "spend");
        const spendChain = chainId(s.chainId);
        const vault = address(key.vault, "key.vault");
        this.#keychain(agent, spendChain, vault);
        return k.signAgentSpend(
          {
            vault,
            agentNonce: uint(key.agentNonce, "key.agentNonce", 64),
            keyRoot: hex(key.keyRoot, "key.keyRoot", 32),
            vaultKeyRoot: hex(key.vaultKeyRoot, "key.vaultKeyRoot", 32),
            index: uint(key.index, "key.index", 64),
            nextIndex: uint(key.nextIndex, "key.nextIndex", 64),
          },
          { chainId: spendChain, action: agentAction(s.action), params: hex(s.params, "spend.params") },
        );
      }
      case "voucher.address":
      case "voucher.sign":
      case "voucher.signClose": {
        if (op === "voucher.address") exact(a, ["chainId", "token", "salt"], op);
        else if (op === "voucher.sign") exact(a, ["chainId", "token", "salt", "channelId", "maxClaimableAmount"], op);
        else exact(a, ["chainId", "token", "salt", "vault", "channelId", "amount", "nonce", "deadline"], op);
        const c = chainId(a.chainId);
        const token = address(a.token, "token");
        const salt = hex(a.salt, "salt", 32);
        if (op === "voucher.address") return k.voucherAddress(c, token, salt);
        if (op === "voucher.sign") {
          return k.signVoucher(c, token, salt, { channelId: hex(a.channelId, "channelId", 32), maxClaimableAmount: uint(a.maxClaimableAmount, "maxClaimableAmount", 128) });
        }
        return k.signCloseRequest(c, token, salt, {
          vault: address(a.vault, "vault"),
          channelId: hex(a.channelId, "channelId", 32),
          amount: uint(a.amount, "amount", 128),
          nonce: uint(a.nonce, "nonce"),
          deadline: uint(a.deadline, "deadline", 64),
        });
      }
      case "payment.address": {
        exact(a, ["chainId", "token", "vault"], op);
        return k.paymentWalletAddress(chainId(a.chainId), address(a.token, "token"), address(a.vault, "vault"));
      }
      case "payment.signTransfer": {
        exact(a, ["chainId", "token", "vault", "name", "version", "to", "value", "validAfter", "validBefore", "nonce"], op);
        if (typeof a.name !== "string" || a.name.length === 0 || a.name.length > 64) throw new BadRequest("name must be a token name");
        if (typeof a.version !== "string" || a.version.length === 0 || a.version.length > 16) throw new BadRequest("version must be a token version");
        return k.signPaymentTransfer(chainId(a.chainId), address(a.token, "token"), address(a.vault, "vault"), {
          name: a.name,
          version: a.version,
          to: address(a.to, "to"),
          value: uint(a.value, "value"),
          validAfter: uint(a.validAfter, "validAfter"),
          validBefore: uint(a.validBefore, "validBefore"),
          nonce: hex(a.nonce, "nonce", 32),
        });
      }
      case "pad.postingAddress":
      case "pad.kemPublicKey": {
        exact(a, ["chainId", "pad"], op);
        const c = chainId(a.chainId);
        const pad = address(a.pad, "pad");
        return op === "pad.postingAddress" ? k.padPostingAddress(c, pad) : k.padKemPublicKey(c, pad);
      }
      case "pad.signPost": {
        exact(a, ["chainId", "pad", "message"], op);
        return k.signPadPost(chainId(a.chainId), address(a.pad, "pad"), padPost(obj(a.message, "message")));
      }
      case "pad.unwrap": {
        exact(a, ["chainId", "pad", "wrap", "recipient", "keyCommit"], op);
        return k.padUnwrap(chainId(a.chainId), address(a.pad, "pad"), padWrap(obj(a.wrap, "wrap")), address(a.recipient, "recipient"), bytes(a.keyCommit, "keyCommit", 32));
      }
      case "tide.secret": {
        exact(a, ["chainId", "tide"], op);
        return k.tideSecret(chainId(a.chainId), address(a.tide, "tide"));
      }
    }
  }
}

function padWrap(w: Record<string, unknown>) {
  exact(w, ["recipient", "pkHash", "ct", "wrapped"], "wrap");
  const ct = bytes(w.ct, "wrap.ct");
  const wrapped = bytes(w.wrapped, "wrap.wrapped");
  if (ct.length === 0 || ct.length > 4096 || wrapped.length === 0 || wrapped.length > 4096) throw new BadRequest("wrap.ct and wrap.wrapped must be 1 to 4096 bytes");
  return { recipient: address(w.recipient, "wrap.recipient"), pkHash: bytes(w.pkHash, "wrap.pkHash", 32), ct, wrapped };
}

const ENC_KINDS = new Set<number>(Object.values(PAD_ENC_KIND));

function padPost(m: Record<string, unknown>): PadPostMessage {
  switch (m.kind) {
    case "reserve":
      exact(m, ["kind", "jobId", "bytes", "seq"], "message");
      return { kind: "reserve", jobId: hex(m.jobId, "message.jobId", 32), bytes: uint(m.bytes, "message.bytes", 64), seq: uint(m.seq, "message.seq", 64) };
    case "upload": {
      exact(m, ["kind", "jobId", "encKind", "sha256", "size"], "message");
      const encKind = smallInt(m.encKind, "message.encKind", 255);
      if (!ENC_KINDS.has(encKind)) throw new BadRequest("message.encKind is not an Ostrapad file kind");
      return { kind: "upload", jobId: hex(m.jobId, "message.jobId", 32), encKind: encKind as PadEncKind, sha256: hex(m.sha256, "message.sha256", 32), size: uint(m.size, "message.size", 64) };
    }
    case "wrap":
      exact(m, ["kind", "jobId", "round", "wrap", "seq"], "message");
      return { kind: "wrap", jobId: hex(m.jobId, "message.jobId", 32), round: smallInt(m.round, "message.round", 0xffffffff), wrap: padWrap(obj(m.wrap, "message.wrap")), seq: uint(m.seq, "message.seq", 64) };
    default:
      throw new BadRequest("message.kind must be reserve, upload or wrap");
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const sockets = env.OSTRA_SIGNER_SOCKETS;
  const root = env.OSTRA_SIGNER_ROOT;
  const adminFile = env.OSTRA_SIGNER_ADMIN_KEY_FILE;
  const sealMode = env.OSTRA_SIGNER_SEAL;
  if (!sockets || !root || !adminFile || !sealMode) throw new Error("OSTRA_SIGNER_SOCKETS, OSTRA_SIGNER_ROOT, OSTRA_SIGNER_ADMIN_KEY_FILE and OSTRA_SIGNER_SEAL are required");
  const perMinute = (name: string, fallback: string) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new Error(`${name} must be an integer from 1 to 100000`);
    return n;
  };
  const rate = perMinute("OSTRA_SIGNER_RATE", "120");
  const workRate = perMinute("OSTRA_SIGNER_WORK_RATE", "1024");
  if (env.OSTRA_SIGNER_ADMIN_KEY_CREATE === "yes" && !existsSync(adminFile)) {
    const key = randomBytes(32);
    try {
      // Made whole and exclusively: another start that made it first keeps its key.
      if (await createWhole(dirname(adminFile), basename(adminFile), `${key.toString("hex")}\n`)) log("admin_key_created", {});
    } finally {
      key.fill(0);
    }
  }
  const adminKey = await hexFile(adminFile, "the admin key");
  let sealKey: Uint8Array;
  if (sealMode === "dstack") sealKey = await dstackKey(env.DSTACK_SOCK ?? "/var/run/dstack.sock");
  else if (sealMode.startsWith("file:")) sealKey = await hexFile(sealMode.slice(5), "the seal key");
  else throw new Error('OSTRA_SIGNER_SEAL must be "dstack" or "file:<path>"');
  const signer = new Signer({ sockets, root, adminKey, sealKey, rate, workRate, onLeaseLost: () => (process.exitCode = 1) });
  await signer.listen();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    void signer.close().then(() => process.exit(process.exitCode ?? 0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/** True when this module is the program node runs (also through a symlinked bin). */
function isEntry(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((err) => {
    log("fatal", { message: (err as Error).message });
    process.exit(1);
  });
}
