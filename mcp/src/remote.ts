#!/usr/bin/env node
// Ostra's remote MCP gateway (remote MCP design, 10 Nov 2026): the MCP server over Streamable HTTP, so that an agent
// can be used from any Claude app, the phone included, through a custom connector. It runs nothing of its own: every
// session is a child process of the stdio server (server.ts) in the agent role of one vault (OSTRA_AGENT_OF), with
// that vault's own OSTRA_HOME, and the gateway passes JSON-RPC messages both ways. The child holds only the vault's
// agent seed: every spend it signs is held to the policy the vault's owner set, and the owner's tools refuse in it
// (tools.ts).
//
// One child per home at a time: the agent key is a chain of one-time keys kept in OSTRA_HOME, so two processes on one
// home could sign with the same key. The sessions of a home share its child (a Claude account opens several at once:
// its chats, its apps, the connector's settings page): the gateway initializes the child once, answers each session's
// initialize itself, and passes each session's requests to the child under ids of its own, so every answer goes back
// to the session that asked (multiplexing, 10 Nov 2026; before, a new session ended the one before it, and Claude's
// calls on that one failed). A session idle for OSTRA_REMOTE_IDLE_SECONDS ends; the child ends with its home's last
// session. A home keeps at most MAX_SESSIONS_PER_HOME sessions: one more ends the one idle longest.
//
// A user is authenticated by OAuth (remote-auth.ts, with OSTRA_REMOTE_PUBLIC_URL): a grant is for one vault and the
// agent key its owner installed, its home <root>/v<HMAC of the vault> (the key in <root>/home-id.key); or by a fixed
// bearer token of the users file (OSTRA_REMOTE_USERS; scripts/remote-user.ts adds one), for operators and tests. In an
// OAuth session an owner's tool (remote-auth.ts OWNER_TOOLS) is not passed to the child: the gateway answers with a
// link for the owner to approve it in the web app; agent_key_request and agent_key_set (REMOTE_REFUSED_TOOLS) are
// refused and left out of tools/list (an agent key is handed out and installed only by connecting, through the
// gateway's own agent_key_request to the home's child).
//
//   OSTRA_REMOTE_LISTEN        host:port (default 127.0.0.1:4920)
//   OSTRA_REMOTE_PUBLIC_URL    the gateway's public base URL (https://mcp.ostraagent.xyz): turns OAuth on
//   OSTRA_REMOTE_APP_URL       the web app's origin, for /connect and /approve (default https://app.ostraagent.xyz)
//   OSTRA_REMOTE_REDIRECTS     redirect URIs clients may register (comma separated; default Claude's callbacks,
//                              https://claude.ai/api/mcp/auth_callback and https://claude.com/api/mcp/auth_callback);
//                              loopback ones too unless OSTRA_REMOTE_LOOPBACK=no
//   OSTRA_REMOTE_DB            OAuth's SQLite file (default <root>/auth.sqlite)
//   OSTRA_REMOTE_USERS         the users file (0600, JSON): {"users":[{"id","tokenSha256","vault"}]}, read again
//                              when it changes (optional with OAuth)
//   OSTRA_REMOTE_ROOT          the homes (0700): <root>/<id>/home is OSTRA_HOME, <root>/<id>/pad-files OSTRA_PAD_FILES
//   OSTRA_REMOTE_IDLE_SECONDS  a session's idle time before it ends (default 900)
//   OSTRA_REMOTE_ALLOWED_HOSTS the Host headers accepted (comma separated; default the listen address), against DNS
//                              rebinding
//   OSTRA_REMOTE_MAX_SESSIONS  the most children (homes served) at once (default 50); a new home past it is answered 503
//   OSTRA_REMOTE_SANDBOX       bwrap (the default with OAuth) or off (the default without): each child in its own
//                              bubblewrap sandbox, which sees only the system's programs and libraries, the code and
//                              the files the environment names that it runs on (read only), and its home's home/ and
//                              pad-files/ (read and write), in its own process namespace. With or without it, every
//                              child holds its home with flock(1) (/usr/bin/flock), so no two children ever share one
//   OSTRA_REMOTE_SANDBOX_RO    more paths (directories too) a sandbox sees read only (comma separated)
//   OSTRA_REMOTE_REFRESH_GRACE_SECONDS  a rotated refresh token taken again within this is a retry (default 30)
//   OSTRA_REMOTE_KEY_STATE_SECONDS      how long a vault's agent key state read from the chain is used (default 15)
//   OSTRA_REMOTE_SIGNER_SOCKETS         Ostra Cloud (design 12 Nov 2026): the signer's sockets directory (signer.ts
//                                       OSTRA_SIGNER_SOCKETS). Each home's seed is then the signer's, never in the home:
//   OSTRA_REMOTE_SIGNER_ADMIN_KEY_FILE  the signer's admin key (32 bytes, hex, 0600). Before each child of a home
//                                       starts, the gateway has the signer make the home's seed if it has none
//                                       (agent.create) and revokes every token handed out for it before (agent.rotate),
//                                       then writes the new token to <root>/<id>/signer.token (0600): each child holds
//                                       a token no child before it held. The child gets its socket, its id and its
//                                       token file (OSTRA_SIGNER_*; in its sandbox, its socket's directory and its
//                                       token, read only, and no other's). Both or neither, and only with
//                                       OSTRA_REMOTE_SANDBOX=bwrap: outside a sandbox a child, running as the gateway,
//                                       could read the admin key and every token. No other OSTRA_SIGNER_* variable of
//                                       the gateway's environment reaches a child
//
// The other OSTRA_* variables of its environment (OSTRA_RPC_URL_FILE, OSTRA_DEPLOYMENT, the service URLs...) and a
// few system ones (PASSED_ENV) are passed to the children; nothing else is. Per home it sets OSTRA_HOME,
// OSTRA_AGENT_OF, OSTRA_PAD_FILES, OSTRA_FILES_ONLY_IN (tools read local files only from the home's own pad-files),
// OSTRA_HOSTED (no answer tells the user to export a seed kept here) and OSTRA_HOME_EXCLUSIVE (server.ts then refuses to share the home, or with "flock" leaves that to flock(1), and
// exits when its stdin closes). Logs are JSON lines on stderr, naming homes by their id, never a vault; a child's
// stderr goes to <root>/<id>/mcp.log.
//
// Ending a session ends its server at once, a tool call in flight with it (a spend may have been sent; its one-time key
// is marked used before it signs, core agent-key.ts). Connections are capped (maxConnections) without a per-address
// limit: in front of the internet, the reverse proxy limits each address.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, constants as fsc, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, isInitializeRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { robinhoodChain } from "@ostraagent/sdk";
import { loadConfig } from "./config.ts";
import { OWNER_TOOLS, REMOTE_REFUSED_TOOLS, RemoteAuth } from "./remote-auth.ts";
import { ADMIN, MAX_SOCKETS_DIR, socketPath } from "./signer.ts";
import { SignerAdmin } from "./signer-client.ts";
import { agentToken } from "./signer-protocol.ts";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.ts");
/** The largest request body taken (MCP requests are small; tool arguments are JSON). */
const MAX_BODY = 1 << 20;
const USER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A home's child may be started at most once per this many ms (each start spawns a server and reads the chain). */
const OPEN_INTERVAL_MS = 2_000;
/** The sessions one home keeps at once (they share its child); one more ends the one idle longest. */
const MAX_SESSIONS_PER_HOME = 16;
/** The child's notifications every session of its home gets (the others are dropped). */
const LIST_CHANGED = new Set(["notifications/tools/list_changed", "notifications/resources/list_changed", "notifications/prompts/list_changed"]);
/** How long the gateway's own request to a child (agent_key_request) may take. */
const CHILD_CALL_MS = 60_000;
/** The variables of the gateway's environment a child gets besides OSTRA_* (OSTRA_REMOTE_* never). */
const PASSED_ENV = new Set(["PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]);
/** The variables set per home, never bound into a sandbox from the gateway's environment. */
const PER_HOME_ENV = new Set(["OSTRA_HOME", "OSTRA_AGENT_OF", "OSTRA_PAD_FILES", "OSTRA_FILES_ONLY_IN", "OSTRA_HOME_EXCLUSIVE", "OSTRA_HOSTED", "OSTRA_SIGNER_SOCKET", "OSTRA_SIGNER_AGENT", "OSTRA_SIGNER_TOKEN_FILE"]);
/** A home's signer token, beside its home (never in it: the home is the child's to write). */
const SIGNER_TOKEN = "signer.token";
/** What a sandbox sees of the system, read only, when it is there. */
const SYSTEM_RO = ["/usr", "/etc/ssl", "/etc/ca-certificates", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/host.conf", "/etc/gai.conf", "/etc/localtime"];
const FLOCK = "/usr/bin/flock";
/** How long a new child waits for its home's flock (a child ended a moment before may still be going). */
const FLOCK_WAIT_SECONDS = 5;
/** flock(1)'s exit code when another child holds the home. */
const FLOCK_BUSY = 75;

/** `fixed`: a user of the users file (its token fixed); otherwise one of an OAuth grant (`grant`), its home from its vault. */
type User = { id: string; tokenSha256: Buffer; vault: Address; fixed: boolean; grant: string | null };
/** A request the gateway sends a child for itself (never a client's), waiting for its answer. */
type Waiter = { done: (m: JSONRPCMessage) => void; fail: (err: Error) => void };

/**
 * A home's child, shared by the home's sessions. `init` is its initialize result once the gateway has initialized it
 * (null until then); `exited` settles when its process has exited; `ending` is set by the first endHome(). `mine` holds the
 * gateway's own requests to it; `routes` the sessions' requests passed to it, by the id the child sees; `inflight` the
 * gateway's own calls being answered (the child stays while one is).
 */
type Home = {
  user: string;
  vault: Address;
  child: StdioClientTransport;
  pid: number | null;
  exited: Promise<void>;
  init: Record<string, unknown> | null;
  ending: Promise<void> | null;
  sessions: Set<Session>;
  mine: Map<string, Waiter>;
  routes: Map<string, { s: Session; id: string | number; list: boolean; progress: string | number | null }>;
  seq: number;
  inflight: number;
};

/**
 * A client's session of a home. `ending` is set by the first end(); `inflight` counts its POSTs being answered;
 * `active` is when it was last used (the one idle longest goes first when its home is full).
 */
type Session = {
  id: string;
  user: string;
  tokenSha256: Buffer;
  vault: Address;
  fixed: boolean;
  grant: string | null;
  transport: StreamableHTTPServerTransport;
  home: Home;
  idle: NodeJS.Timeout | null;
  inflight: number;
  active: number;
  ending: Promise<void> | null;
};

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`set ${name}`);
  return v;
}

/** Refuses a file or directory others can read: the users file names token hashes, the root holds seeds. */
function checkPrivatePath(path: string, mode: number): void {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} must not be readable by others (chmod ${mode.toString(8)})`);
}

export function parseUsers(text: string): Omit<User, "grant">[] {
  const raw = JSON.parse(text) as { users?: unknown };
  if (!Array.isArray(raw.users)) throw new Error("the users file is {\"users\":[...]}");
  const seen = new Set<string>();
  return raw.users.map((u: unknown) => {
    const { id, tokenSha256, vault } = (u ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !USER_ID.test(id)) throw new Error(`a user id is lower case letters, digits and dashes: ${String(id)}`);
    if (seen.has(id)) throw new Error(`user ${id} is listed twice`);
    seen.add(id);
    if (typeof tokenSha256 !== "string" || !/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error(`user ${id}: tokenSha256 is 64 hex digits`);
    if (typeof vault !== "string" || !isAddress(vault, { strict: false })) throw new Error(`user ${id}: vault is an address`);
    if (id.startsWith("v") && /^v[0-9a-f]{40}$/.test(id)) throw new Error(`user ${id}: ids of v and 40 hex digits are OAuth grants' homes`);
    return { id, tokenSha256: Buffer.from(tokenSha256, "hex"), vault: getAddress(vault), fixed: true };
  });
}

/** The key that names OAuth homes (32 random bytes, made once): a home's name does not tell its vault. */
function homeIdKey(root: string): Buffer {
  const path = join(root, "home-id.key");
  try {
    writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  checkPrivatePath(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error(`${path} is not 32 bytes`);
  return key;
}

/**
 * The directories of the code a child runs: the mcp package and every @ostraagent package it links to, as real
 * paths (each with its node_modules).
 */
function codeDirs(): string[] {
  const out = new Set<string>();
  const walk = (dir: string) => {
    const real = realpathSync(dir);
    if (out.has(real)) return;
    out.add(real);
    const scope = join(real, "node_modules", "@ostraagent");
    if (!existsSync(scope)) return;
    for (const name of readdirSync(scope)) walk(join(scope, name));
  };
  walk(dirname(dirname(SERVER)));
  return [...out];
}

/**
 * The signer of OSTRA_REMOTE_SIGNER_SOCKETS and OSTRA_REMOTE_SIGNER_ADMIN_KEY_FILE (both or neither), or null. Its
 * sockets are never under the homes' root, nor the root under them.
 */
function signerOf(root: string): { sockets: string; keyFile: string; adminKey: Buffer; admin: SignerAdmin } | null {
  const sockets = process.env.OSTRA_REMOTE_SIGNER_SOCKETS ?? "";
  const keyFile = process.env.OSTRA_REMOTE_SIGNER_ADMIN_KEY_FILE ?? "";
  if (sockets === "" && keyFile === "") return null;
  if (sockets === "" || keyFile === "") throw new Error("set OSTRA_REMOTE_SIGNER_SOCKETS and OSTRA_REMOTE_SIGNER_ADMIN_KEY_FILE together, or neither");
  if (!isAbsolute(sockets) || Buffer.byteLength(sockets) > MAX_SOCKETS_DIR) throw new Error(`OSTRA_REMOTE_SIGNER_SOCKETS is an absolute path of at most ${MAX_SOCKETS_DIR} bytes (signer.ts)`);
  if (!statSync(sockets).isDirectory()) throw new Error(`${sockets} is not a directory`);
  const r = realpathSync(root);
  const s = realpathSync(sockets);
  if (s === r || s.startsWith(`${r}/`) || r.startsWith(`${s}/`)) throw new Error("the signer's sockets and the homes' root are apart: neither is in the other");
  checkPrivatePath(keyFile, 0o600);
  const t = readFileSync(keyFile, "utf8").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(t)) throw new Error(`${keyFile} must hold 32 bytes as hex`);
  const adminKey = Buffer.from(t, "hex");
  return { sockets, keyFile, adminKey, admin: new SignerAdmin(socketPath(sockets, ADMIN), adminKey) };
}

async function main(): Promise<void> {
  const usersPath = process.env.OSTRA_REMOTE_USERS !== undefined && process.env.OSTRA_REMOTE_USERS !== "" ? process.env.OSTRA_REMOTE_USERS : null;
  const publicUrl = process.env.OSTRA_REMOTE_PUBLIC_URL !== undefined && process.env.OSTRA_REMOTE_PUBLIC_URL !== "" ? process.env.OSTRA_REMOTE_PUBLIC_URL.replace(/\/+$/, "") : null;
  if (usersPath === null && publicUrl === null) throw new Error("set OSTRA_REMOTE_PUBLIC_URL (OAuth), OSTRA_REMOTE_USERS (fixed tokens), or both");
  const root = required("OSTRA_REMOTE_ROOT");
  if (usersPath !== null) checkPrivatePath(usersPath, 0o600);
  checkPrivatePath(root, 0o700);
  const listen = process.env.OSTRA_REMOTE_LISTEN ?? "127.0.0.1:4920";
  const at = listen.lastIndexOf(":");
  const host = listen.slice(0, at);
  const port = Number(listen.slice(at + 1));
  if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("OSTRA_REMOTE_LISTEN is host:port");
  const idleSeconds = Number(process.env.OSTRA_REMOTE_IDLE_SECONDS ?? "900");
  if (!Number.isInteger(idleSeconds) || idleSeconds < 30 || idleSeconds > 86_400) throw new Error("OSTRA_REMOTE_IDLE_SECONDS is a whole number from 30 to 86400");
  const allowedHosts = (process.env.OSTRA_REMOTE_ALLOWED_HOSTS ?? listen).split(",").map((h) => h.trim()).filter((h) => h !== "");
  const maxSessions = Number(process.env.OSTRA_REMOTE_MAX_SESSIONS ?? "50");
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 10_000) throw new Error("OSTRA_REMOTE_MAX_SESSIONS is a whole number from 1 to 10000");
  const sandboxMode = process.env.OSTRA_REMOTE_SANDBOX ?? (publicUrl !== null ? "bwrap" : "off");
  if (sandboxMode !== "bwrap" && sandboxMode !== "off") throw new Error("OSTRA_REMOTE_SANDBOX is bwrap or off");
  const sandbox = sandboxMode === "bwrap";
  if (!existsSync(FLOCK)) throw new Error(`the gateway holds each home with flock(1): ${FLOCK} is missing`);
  const hidKey = homeIdKey(root);
  /** Ostra Cloud: the signer that holds every home's seed (OSTRA_REMOTE_SIGNER_*), or null: each home holds its own. */
  const signer = signerOf(root);
  if (signer !== null && !sandbox) throw new Error("OSTRA_REMOTE_SIGNER_* needs OSTRA_REMOTE_SANDBOX=bwrap: outside a sandbox every child could read the signer's admin key and every home's token");
  /** The home id of an OAuth grant's vault. */
  const vaultUserId = (vault: Address) => `v${createHmac("sha256", hidKey).update(getAddress(vault)).digest("hex").slice(0, 40)}`;

  /**
   * What a sandbox sees read only besides its home: the system's, the node binary's prefix, the code, the files named in
   * the environment, at their real paths. A path named that is a link (/etc/resolv.conf, which systemd-resolved makes a
   * link into /run) is also seen at its own path as what it points to (sandboxLinks), unless a folder bound above it
   * shows the link itself already.
   */
  const sandboxRo: string[] = [];
  const sandboxLinks: string[] = [];
  if (sandbox) {
    const probe = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) throw new Error("OSTRA_REMOTE_SANDBOX=bwrap needs bubblewrap (bwrap) on PATH");
    const add = (p: string) => {
      if (!existsSync(p)) return;
      const real = realpathSync(p);
      sandboxRo.push(real);
      if (p !== real) sandboxLinks.push(p);
    };
    for (const p of SYSTEM_RO) add(p);
    add(dirname(dirname(realpathSync(process.execPath))));
    for (const d of codeDirs()) add(d);
    // Files named in the environment (the deployment record, the RPC URL's file...), never a directory: a directory
    // is seen only when OSTRA_REMOTE_SANDBOX_RO names it.
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || !isAbsolute(v) || PER_HOME_ENV.has(k)) continue;
      if (((k.startsWith("OSTRA_") && !k.startsWith("OSTRA_REMOTE_") && !k.startsWith("OSTRA_SIGNER_")) || k === "NODE_EXTRA_CA_CERTS") && existsSync(v) && statSync(v).isFile()) add(v);
    }
    for (const p of (process.env.OSTRA_REMOTE_SANDBOX_RO ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "")) add(p);
    // Never the homes: no path read only may be, hold, or lie in the root; nor the signer's sockets but each home's own.
    const r = realpathSync(root);
    const sockets = signer === null ? [] : [realpathSync(signer.sockets), realpathSync(signer.keyFile)];
    for (const p of [...sandboxRo, ...sandboxLinks]) {
      for (const x of [r, ...sockets]) if (p === x || p.startsWith(`${x}/`) || x.startsWith(p === "/" ? "/" : `${p}/`)) throw new Error(`the sandbox would see ${p}, which is, holds or lies in ${x} (the homes, the signer's sockets or its admin key): move it`);
    }
  }
  /**
   * A sandbox's arguments: the home's home/ and pad-files/ read and write, nothing else of <root> (its log stays
   * outside); with the signer, its own socket's directory and its token, read only.
   */
  const sandboxArgs = (id: string): string[] => {
    const dir = join(root, id);
    // No capabilities inside, whoever runs the gateway (bwrap started by root otherwise keeps all of root's).
    const a: string[] = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
    // /bin, /lib, /lib64 and /sbin as the system has them: links into /usr, or directories.
    for (const top of ["/bin", "/sbin", "/lib", "/lib64", "/lib32"]) {
      if (!existsSync(top)) continue;
      if (lstatSync(top).isSymbolicLink()) a.push("--symlink", readlinkSync(top), top);
      else a.push("--ro-bind", top, top);
    }
    const seen = new Set<string>();
    for (const p of sandboxRo) {
      if (seen.has(p)) continue;
      seen.add(p);
      a.push("--ro-bind", p, p);
    }
    // bwrap mounts what a link points to at the link's path; never inside a folder bound already (there the link is
    // seen as it is, and its target at its real path).
    for (const p of sandboxLinks) {
      if (seen.has(p) || sandboxRo.some((d) => p.startsWith(d === "/" ? "/" : `${d}/`))) continue;
      seen.add(p);
      a.push("--ro-bind", p, p);
    }
    a.push("--bind", join(dir, "home"), join(dir, "home"), "--bind", join(dir, "pad-files"), join(dir, "pad-files"), "--chdir", join(dir, "home"), "--setenv", "HOME", join(dir, "home"));
    if (signer !== null) {
      // The directory, not the socket: a socket the signer makes again on a restart is the one the sandbox sees.
      const sockDir = dirname(socketPath(signer.sockets, id));
      a.push("--ro-bind", sockDir, sockDir, "--ro-bind", join(dir, SIGNER_TOKEN), join(dir, SIGNER_TOKEN));
    }
    return a;
  };

  /** OAuth (remote-auth.ts), set up below once the helpers it calls exist; null without OSTRA_REMOTE_PUBLIC_URL. */
  let auth: RemoteAuth | null = null;

  /** Initialized sessions by session id. */
  const sessions = new Map<string, Session>();
  /** Each home's one child, from the moment it is spawned until it is gone. */
  const homes = new Map<string, Home>();
  /** When each home's child was last started (ms): at most one start per OPEN_INTERVAL_MS. */
  const lastOpen = new Map<string, number>();
  /** The prefix of the ids of the gateway's own requests to children (never one a client sends). */
  const mineId = `ostra-gateway-${randomUUID()}-`;
  let mineSeq = 0;

  /** Per home, the tail of the opens and ends queued: one at a time, so no two children ever share a home. */
  const locks = new Map<string, Promise<void>>();
  const withUserLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    locks.set(id, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(id) === tail) locks.delete(id);
    }
  };

  /**
   * Ends a home's child: its sessions first, then the child, waiting for its process to exit. Every later call waits
   * for the same end. The home's slot is freed only once the child is gone; a child that does not exit keeps its home
   * blocked (logged), never a second child on that home.
   */
  const endHome = (h: Home, why: string): Promise<void> => {
    if (h.ending !== null) return h.ending;
    let done!: () => void;
    let failed!: (err: unknown) => void;
    h.ending = new Promise<void>((res, rej) => {
      done = res;
      failed = rej;
    });
    void (async () => {
      for (const s of [...h.sessions]) endLater(s, why);
      for (const w of h.mine.values()) w.fail(new Error(`the session's server ended (${why})`));
      h.mine.clear();
      h.routes.clear();
      log("child_end", { user: h.user, pid: h.pid, why });
      await h.child.close().catch(() => {});
      const warn = setTimeout(() => log("child_stuck", { user: h.user, pid: h.pid, why: "still running 15 s after its end: its home stays blocked until it exits" }), 15_000);
      warn.unref();
      await h.exited;
      clearTimeout(warn);
      if (homes.get(h.user) === h) homes.delete(h.user);
    })().then(done, (err: unknown) => {
      log("child_stuck", { user: h.user, pid: h.pid, error: String(err) });
      failed(err);
    });
    return h.ending;
  };
  /** Ends the home's child once it serves no session and no call of the gateway's own (never while it starts). */
  const endHomeIfUnused = (h: Home, why: string): void => {
    if (h.init !== null && h.sessions.size === 0 && h.inflight === 0) void endHome(h, why).catch(() => {});
  };

  /**
   * Ends a session: its transport, and its requests still with the child are forgotten (their answers dropped). The
   * home's child ends with its last session; the promise settles once that child, if it ended, is gone.
   */
  const end = (s: Session, why: string): Promise<void> => {
    if (s.ending !== null) return s.ending;
    // Set before anything runs: closing the transport calls its onclose, and so end() again, synchronously.
    let started!: () => void;
    const gate = new Promise<void>((r) => (started = r));
    s.ending = (async () => {
      await gate;
      if (s.idle !== null) clearTimeout(s.idle);
      if (s.id !== "") sessions.delete(s.id);
      const h = s.home;
      h.sessions.delete(s);
      for (const [k, r] of h.routes) if (r.s === s) h.routes.delete(k);
      log("session_end", { session: s.id, user: s.user, why });
      await s.transport.close().catch(() => {});
      if (h.sessions.size === 0 && h.inflight === 0) await endHome(h, why).catch(() => {});
    })();
    started();
    return s.ending;
  };
  /** end() from a callback: a failure is logged there, never an unhandled rejection. */
  const endLater = (s: Session, why: string): void => void end(s, why).catch(() => {});

  /** Arms the idle timer, unless a POST of the session is still being answered. */
  const touch = (s: Session): void => {
    s.active = Date.now();
    if (s.idle !== null) clearTimeout(s.idle);
    s.idle = null;
    if (s.inflight > 0 || s.ending !== null) return;
    s.idle = setTimeout(() => endLater(s, "idle"), idleSeconds * 1000);
    s.idle.unref();
  };

  let users: Omit<User, "grant">[] = [];
  let usersMtime = -1;
  const readUsers = (): Omit<User, "grant">[] => {
    if (usersPath === null) return [];
    const st = statSync(usersPath);
    if (st.mtimeMs !== usersMtime) {
      checkPrivatePath(usersPath, 0o600);
      const next = parseUsers(readFileSync(usersPath, "utf8"));
      // A user removed, or given a new token or vault: its live session ends.
      for (const s of sessions.values()) {
        if (!s.fixed) continue;
        const u = next.find((x) => x.id === s.user);
        if (u === undefined || !u.tokenSha256.equals(s.tokenSha256) || u.vault !== s.vault) endLater(s, "user_changed");
      }
      users = next;
      usersMtime = st.mtimeMs;
      log("users_read", { users: users.length });
    }
    return users;
  };
  readUsers();

  /**
   * The user a bearer token belongs to, or null. Every fixed user's hash is compared, in constant time; then OAuth's
   * tokens. A token of a grant that ended ends that grant's session.
   */
  const authenticate = async (req: IncomingMessage): Promise<User | null> => {
    const h = req.headers.authorization;
    if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
    const token = h.slice(7).trim();
    if (token === "") return null;
    const hash = createHash("sha256").update(token).digest();
    let found: Omit<User, "grant"> | null = null;
    for (const u of readUsers()) if (timingSafeEqual(u.tokenSha256, hash)) found = u;
    if (found !== null) return { ...found, grant: null };
    if (auth === null) return null;
    const g = await auth.grantOf(token);
    if (g === null) return null;
    if (!g.live) {
      endGrantSessions(g.grant, "grant_ended");
      return null;
    }
    return { id: vaultUserId(g.vault), tokenSha256: hash, vault: g.vault, fixed: false, grant: g.grant };
  };

  /** Ends the sessions of grant `grant` (its home's child goes on for the other sessions, if any). */
  const endGrantSessions = (grant: string, why: string): void => {
    for (const s of sessions.values()) if (s.grant === grant) endLater(s, why);
  };

  /**
   * Ostra Cloud: before a child of the home starts, its seed is made in the signer if it has none, every token of the
   * home before is revoked, and the new one written beside the home (0600). A signer that cannot be reached starts no
   * child (503).
   */
  const prepareSigner = async (u: User): Promise<void> => {
    if (signer === null) return;
    const dir = join(root, u.id);
    // A home from before the signer holds its own seed: its agent key is that seed's, and its server refuses to start
    // on the signer (keys.ts). No seed is made for it.
    if (existsSync(join(dir, "home", "master.key"))) {
      log("home_holds_seed", { user: u.id });
      throw Object.assign(new Error("this agent's home holds its own seed, from before Ostra Cloud's signer: it is not served here"), { status: 409 });
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let epoch: number;
    let created: boolean;
    try {
      created = (await signer.admin.create(u.id)).created;
      epoch = await signer.admin.rotate(u.id);
    } catch (err) {
      log("signer_failed", { user: u.id, error: err instanceof Error ? err.message : String(err) });
      throw Object.assign(new Error("Ostra Cloud's signer cannot be reached now: try again shortly"), { status: 503 });
    }
    const path = join(dir, SIGNER_TOKEN);
    const tmp = `${path}.${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, `${agentToken(signer.adminKey, u.id, epoch)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
    log("signer_agent", { user: u.id, created, epoch });
  };

  /** The child's environment: only what it needs from the gateway's, and this home's own folders. */
  const childEnv = (u: User): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PER_HOME_ENV.has(k) && ((k.startsWith("OSTRA_") && !k.startsWith("OSTRA_REMOTE_") && !k.startsWith("OSTRA_SIGNER_")) || PASSED_ENV.has(k))) env[k] = v;
    const dir = join(root, u.id);
    mkdirSync(join(dir, "home"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "pad-files"), { recursive: true, mode: 0o700 });
    return {
      ...env,
      ...(signer === null ? {} : { OSTRA_SIGNER_SOCKET: socketPath(signer.sockets, u.id), OSTRA_SIGNER_AGENT: u.id, OSTRA_SIGNER_TOKEN_FILE: join(dir, SIGNER_TOKEN) }),
      HOME: join(dir, "home"),
      OSTRA_HOME: join(dir, "home"),
      OSTRA_AGENT_OF: u.vault,
      OSTRA_PAD_FILES: join(dir, "pad-files"),
      OSTRA_FILES_ONLY_IN: join(dir, "pad-files"),
      OSTRA_HOME_EXCLUSIVE: sandbox ? "flock" : "yes",
      OSTRA_HOSTED: "yes",
    };
  };

  /**
   * The command that starts a home's child: the server under flock(1) on the home (with or without the sandbox, the
   * same lock), in its sandbox when there is one.
   */
  const childCommand = (u: User): { command: string; args: string[]; cwd: string } => {
    const dir = join(root, u.id);
    const locked = [FLOCK, "--wait", String(FLOCK_WAIT_SECONDS), "--conflict-exit-code", String(FLOCK_BUSY), join(dir, "home", ".server.flock"), process.execPath, SERVER];
    if (!sandbox) return { command: FLOCK, args: locked.slice(1), cwd: join(dir, "home") };
    return { command: "bwrap", args: [...sandboxArgs(u.id), "--", ...locked], cwd: join(dir, "home") };
  };
  /** A home's log, opened for the child's stderr: never through a link (the home's folders are the child's to change). */
  const openLog = (u: User): number => openSync(join(root, u.id, "mcp.log"), fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW, 0o600);
  /** Connect children running now (short-lived, outside homes): counted with the homes against maxSessions. */
  let connecting = 0;

  /** The gateway's own request to a home's child (never a client's): its answer, or an error after CHILD_CALL_MS. */
  const askChild = (h: Home, method: string, params: Record<string, unknown>): Promise<JSONRPCMessage> =>
    new Promise<JSONRPCMessage>((resolve, reject) => {
      const id = `${mineId}${++mineSeq}`;
      h.inflight++;
      const timer = setTimeout(() => {
        h.mine.delete(id);
        finish();
        reject(new Error(`${method}: no answer from the home's server within ${CHILD_CALL_MS / 1000} s`));
      }, CHILD_CALL_MS);
      const finish = () => {
        clearTimeout(timer);
        h.inflight--;
        endHomeIfUnused(h, "unused");
      };
      h.mine.set(id, {
        done: (m) => {
          finish();
          resolve(m);
        },
        fail: (err) => {
          finish();
          reject(err);
        },
      });
      h.child.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage).catch((err: unknown) => {
        h.mine.delete(id);
        finish();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

  /** A child's message: an answer to the gateway, or to the session that asked, or a notification for its sessions. */
  const fromChild = (h: Home, m: JSONRPCMessage): void => {
    if (!("method" in m) && "id" in m) {
      const key = String(m.id);
      if (key.startsWith(mineId)) {
        const w = h.mine.get(key);
        h.mine.delete(key);
        w?.done(m);
        return;
      }
      const r = h.routes.get(key);
      if (r === undefined) return; // its session ended: the answer has no one to go to
      h.routes.delete(key);
      let out = { ...m, id: r.id } as JSONRPCMessage;
      if (r.list && "result" in m) {
        const res = m.result as { tools?: { name?: string }[] };
        if (Array.isArray(res.tools)) out = { ...out, result: { ...res, tools: res.tools.filter((t) => !REMOTE_REFUSED_TOOLS.has(t.name ?? "")) } } as JSONRPCMessage;
      }
      touch(r.s);
      void r.s.transport.send(out).catch((err: unknown) => log("client_send_failed", { user: h.user, error: String(err) }));
      return;
    }
    if ("method" in m && "id" in m) {
      // The server asks nothing of clients (no sampling, roots or elicitation): refused, never passed on.
      void h.child.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "the remote gateway passes no requests to clients" } } as JSONRPCMessage).catch(() => {});
      return;
    }
    if ("method" in m && m.method === "notifications/progress") {
      const params = (m.params ?? {}) as { progressToken?: unknown };
      const r = h.routes.get(String(params.progressToken));
      if (r !== undefined && r.progress !== null) void r.s.transport.send({ ...m, params: { ...params, progressToken: r.progress } } as JSONRPCMessage).catch(() => {});
      return;
    }
    // A list changed is every session's; any other notification (a log message, say) is no session's: the sessions of
    // a home may be different grants', and none sees what is not its own.
    if ("method" in m && LIST_CHANGED.has(m.method)) for (const s of h.sessions) void s.transport.send(m).catch(() => {});
  };

  /** A session's message: answered here (initialize, an owner's or a refused tool) or passed to its home's child. */
  const fromSession = (s: Session, u: User, m: JSONRPCMessage): void => {
    const h = s.home;
    if ("method" in m && m.method === "initialize" && "id" in m) {
      // The child was initialized once, by the gateway: the session gets its answer, at the version it asked when the
      // server supports it (as the server itself answers, SDK server/index.js _oninitialize).
      const asked = ((m.params ?? {}) as { protocolVersion?: unknown }).protocolVersion;
      const init = h.init ?? {};
      const protocolVersion = typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
      void s.transport.send({ jsonrpc: "2.0", id: m.id, result: { ...init, protocolVersion } } as JSONRPCMessage).catch((err: unknown) => log("client_send_failed", { user: u.id, error: String(err) }));
      return;
    }
    if ("method" in m && m.method === "notifications/initialized") return;
    const answer = remoteToolAnswer(u, m);
    if (answer !== null) {
      void s.transport.send(answer).catch((err: unknown) => log("client_send_failed", { user: u.id, error: String(err) }));
      return;
    }
    if ("method" in m && "id" in m) {
      const key = `c${++h.seq}`;
      const params = (m.params ?? undefined) as { _meta?: { progressToken?: string | number } } | undefined;
      const progress = params?._meta?.progressToken ?? null;
      h.routes.set(key, { s, id: m.id, list: !u.fixed && m.method === "tools/list", progress });
      const out = progress === null ? { ...m, id: key } : { ...m, id: key, params: { ...params, _meta: { ...params?._meta, progressToken: key } } };
      void h.child.send(out as JSONRPCMessage).catch((err: unknown) => log("child_send_failed", { user: u.id, error: String(err) }));
      return;
    }
    if ("method" in m && m.method === "notifications/cancelled") {
      const params = (m.params ?? {}) as { requestId?: unknown; reason?: unknown };
      for (const [key, r] of h.routes) {
        if (r.s !== s || r.id !== params.requestId) continue;
        h.routes.delete(key);
        void h.child.send({ ...m, params: { ...params, requestId: key } } as JSONRPCMessage).catch(() => {});
      }
    }
    // Other notifications and answers from a client are not the server's to see.
  };

  /**
   * A home's child, spawned and initialized by the gateway (its initialize answered and acknowledged), under the
   * home's lock only.
   */
  const spawnHome = async (u: User): Promise<Home> => {
    if (homes.size + connecting >= maxSessions) throw Object.assign(new Error("the gateway is full: try again later"), { status: 503 });
    const last = lastOpen.get(u.id) ?? 0;
    if (Date.now() - last < OPEN_INTERVAL_MS) throw Object.assign(new Error("too many sessions started: try again shortly"), { status: 429 });
    lastOpen.set(u.id, Date.now());
    if (signer !== null) {
      // Its place among maxSessions is kept while the signer answers (the home is in `homes` only once spawned).
      connecting++;
      try {
        // A failure counts as a start: a home's requests to the signer stay at most one per OPEN_INTERVAL_MS.
        await prepareSigner(u);
      } finally {
        connecting--;
      }
    }
    const env = childEnv(u);
    const stderr = openLog(u);
    const child = new StdioClientTransport({ ...childCommand(u), env, stderr });
    let exited!: () => void;
    const h: Home = {
      user: u.id,
      vault: u.vault,
      child,
      pid: null,
      exited: new Promise<void>((r) => (exited = r)),
      init: null,
      ending: null,
      sessions: new Set(),
      mine: new Map(),
      routes: new Map(),
      seq: 0,
      inflight: 0,
    };
    homes.set(u.id, h);
    child.onmessage = (m) => fromChild(h, m);
    child.onclose = () => void endHome(h, "child_exit").catch(() => {});
    child.onerror = (err) => log("child_error", { user: u.id, error: String(err) });
    // start() spawns the child synchronously, keeping it in _process (SDK 1.32.1, pinned), before its first await: its
    // real exit is watched from that moment, so an end racing the start still waits for it (StdioClientTransport.close
    // sends SIGKILL last without waiting for the exit).
    const starting = child.start();
    const proc = (child as unknown as { _process?: ChildProcess })._process;
    if (proc === undefined) exited();
    else {
      h.pid = proc.pid ?? null;
      if (proc.exitCode !== null || proc.signalCode !== null) exited();
      else
        proc.once("exit", (code) => {
          if (code === FLOCK_BUSY) log("home_busy", { user: u.id, why: "another child still held the home (flock)" });
          exited();
        });
    }
    try {
      await starting;
      if (proc === undefined) throw new Error("the MCP SDK's StdioClientTransport kept no child process: the gateway cannot see it exit");
      const m = await askChild(h, "initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ostra-remote-gateway", version: "1.0.0" } });
      if (!("result" in m)) throw new Error(`the home's server refused initialize: ${JSON.stringify((m as { error?: unknown }).error)}`);
      h.init = m.result as Record<string, unknown>;
      await child.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
      if (h.ending !== null) throw new Error("the home's server ended while it started");
      log("child_start", { user: u.id, pid: h.pid });
    } catch (err) {
      await endHome(h, "child_failed").catch(() => {});
      throw err;
    } finally {
      closeSync(stderr);
    }
    return h;
  };

  /**
   * A new session of `u` on its home's child (started first when the home has none); the session idle longest goes
   * first when the home is full. Called under the home's lock only.
   */
  const open = async (u: User): Promise<Session> => {
    let h = homes.get(u.id);
    // A fixed user given another vault: the child of the vault before ends, never shared with the new one.
    if (h !== undefined && h.ending === null && h.vault !== u.vault) await endHome(h, "vault_changed").catch(() => {});
    if (h !== undefined && h.ending !== null) {
      await h.ending.catch(() => {});
      h = undefined;
    }
    if (h === undefined) h = await spawnHome(u);
    if (h.sessions.size >= MAX_SESSIONS_PER_HOME) {
      // The one idle longest goes: one with no call being answered first, of the same grant before another's.
      const rank = (x: Session) => (x.inflight > 0 ? 2 : 0) + (x.grant === u.grant ? 0 : 1);
      const out = [...h.sessions].sort((a, b) => rank(a) - rank(b) || a.active - b.active)[0] as Session;
      void end(out, "home_full").catch(() => {});
    }
    const home = h;
    const s: Session = {
      id: "",
      user: u.id,
      tokenSha256: u.tokenSha256,
      fixed: u.fixed,
      grant: u.grant,
      vault: u.vault,
      transport: null as unknown as StreamableHTTPServerTransport,
      home,
      idle: null,
      inflight: 0,
      active: Date.now(),
      ending: null,
    };
    home.sessions.add(s);
    s.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        s.id = id;
        sessions.set(id, s);
        log("session_start", { session: id, user: u.id, pid: home.pid, sessions: home.sessions.size });
      },
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    s.transport.onmessage = (m) => fromSession(s, u, m);
    s.transport.onclose = () => endLater(s, "closed");
    return s;
  };

  /** The gateway's own tools/call to a home's live child; its answer is never passed to a client. */
  const callChild = (h: Home, name: string, args: Record<string, unknown>): Promise<JSONRPCMessage> => askChild(h, "tools/call", { name, arguments: args });

  /** Waits until process `pid` is gone (polled; for the short-lived connect child, whose process is not watched). */
  const gone = async (pid: number | null | undefined): Promise<void> => {
    if (pid === null || pid === undefined) return;
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      if (Date.now() > deadline) throw new Error(`child ${pid} did not exit`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  /** The root of an agent_key_request answer (a tools/call result's text). */
  const rootOf = (result: unknown): { root: Hex; index: string } => {
    const r = result as { isError?: boolean; content?: { type: string; text?: string }[] };
    const text = r.content?.[0]?.text ?? "";
    if (r.isError === true) throw new Error(`agent_key_request: ${text}`);
    const out = JSON.parse(text) as { root?: unknown; index?: unknown };
    if (typeof out.root !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(out.root)) throw new Error("agent_key_request gave no root");
    return { root: out.root as Hex, index: String(out.index) };
  };

  /**
   * A new agent key root from vault `vault`'s home, for a connect (remote-auth.ts), under the home's lock: asked of
   * the home's live child when there is one (its sessions go on), else of a short-lived child, gone before the lock is
   * let go.
   */
  const issueAgentKey = (vault: Address) =>
    withUserLock(vaultUserId(vault), async () => {
      const u: User = { id: vaultUserId(vault), tokenSha256: Buffer.alloc(32), vault, fixed: false, grant: null };
      const live = homes.get(u.id);
      if (live !== undefined && live.init !== null && live.ending === null) {
        const m = await callChild(live, "agent_key_request", {});
        if ("error" in m) throw new Error(`agent_key_request: ${JSON.stringify(m.error)}`);
        const key = rootOf((m as { result?: unknown }).result);
        log("connect_agent_key", { user: u.id, index: key.index, from: "session" });
        return key;
      }
      if (live !== undefined) await endHome(live, "connect");
      if (homes.size + connecting >= maxSessions) throw Object.assign(new Error("the gateway is full: try again later"), { status: 503 });
      connecting++;
      try {
        await prepareSigner(u);
      } catch (err) {
        connecting--;
        throw err;
      }
      const env = childEnv(u);
      const stderr = openLog(u);
      const transport = new StdioClientTransport({ ...childCommand(u), env, stderr });
      const client = new Client({ name: "ostra-remote-connect", version: "1.0.0" });
      try {
        await client.connect(transport);
        const key = rootOf(await client.callTool({ name: "agent_key_request", arguments: {} }));
        log("connect_agent_key", { user: u.id, index: key.index, from: "connect" });
        return key;
      } finally {
        // Its process as spawned, whether or not initialize went through: gone before the home's lock is let go.
        const pid = (transport as unknown as { _process?: ChildProcess })._process?.pid ?? null;
        await client.close().catch(() => {});
        closeSync(stderr);
        await gone(pid).finally(() => connecting--);
      }
    });

  /**
   * In an OAuth session: an owner's tool kept for the owner's approval and answered with its link; a refused tool
   * answered with an error; null for anything else (passed to the child).
   */
  const remoteToolAnswer = (u: User, m: JSONRPCMessage): JSONRPCMessage | null => {
    if (auth === null || u.fixed || u.grant === null || !("method" in m) || m.method !== "tools/call" || !("id" in m)) return null;
    const params = (m.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== "string") return null;
    const result = (text: string, isError: boolean) => ({ jsonrpc: "2.0", id: m.id, result: { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] } }) as JSONRPCMessage;
    if (REMOTE_REFUSED_TOOLS.has(params.name))
      return result(`${params.name} is not available through the remote connector: an agent key is handed out and installed only by connecting the connector again (the vault's owner signs it in the Ostra web app).`, true);
    if (!OWNER_TOOLS.has(params.name)) return null;
    try {
      const a = auth.createApproval(u.grant, u.vault, params.name, params.arguments);
      return result(
        JSON.stringify({
          status: "waiting_for_the_owner",
          approve: a.approve,
          expiresAt: a.expiresAt,
          forTheUser: `${params.name} is the vault owner's to sign: open this link on the device that keeps the vault (the Ostra web app) to see exactly what is asked, then approve or decline. Nothing changes until the owner signs.`,
        }),
        false,
      );
    } catch (err) {
      return result(`invalid_input: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };

  /** An optional whole number of seconds from the environment, in [min, max]. */
  const seconds = (name: string, min: number, max: number): number | undefined => {
    const v = process.env[name];
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} is a whole number of seconds from ${min} to ${max}`);
    return n;
  };

  if (publicUrl !== null) {
    // The chain as the children read it: the deployment and the RPCs of their environment (config.ts). OSTRA_PAY_PROXY
    // is the children's (hosted ones only), never the gateway's.
    const config = await loadConfig({ ...process.env, OSTRA_PAY_PROXY: "" });
    const keyStateSeconds = seconds("OSTRA_REMOTE_KEY_STATE_SECONDS", 1, 300);
    const redirects = (process.env.OSTRA_REMOTE_REDIRECTS ?? "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback").split(",").map((r) => r.trim()).filter((r) => r !== "");
    auth = new RemoteAuth({
      publicUrl,
      appUrl: (process.env.OSTRA_REMOTE_APP_URL ?? "https://app.ostraagent.xyz").replace(/\/+$/, ""),
      dbPath: process.env.OSTRA_REMOTE_DB !== undefined && process.env.OSTRA_REMOTE_DB !== "" ? process.env.OSTRA_REMOTE_DB : join(root, "auth.sqlite"),
      redirects: { exact: redirects, loopback: process.env.OSTRA_REMOTE_LOOPBACK !== "no" },
      client: createPublicClient({ chain: robinhoodChain, transport: http(config.rpcUrl, { retryCount: 2, timeout: 8_000 }) }) as PublicClient,
      logsClient: createPublicClient({ chain: robinhoodChain, transport: http(config.logsRpcUrl, { retryCount: 2, timeout: 20_000 }) }) as PublicClient,
      deployment: config.deployment,
      issueAgentKey,
      homeId: vaultUserId,
      onGrantEnded: (grant) => endGrantSessions(grant, "grant_ended"),
      refreshGraceSeconds: seconds("OSTRA_REMOTE_REFRESH_GRACE_SECONDS", 0, 300),
      keyStateMs: keyStateSeconds === undefined ? undefined : keyStateSeconds * 1000,
      log,
    });
  }

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const length = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(length) && length > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
      chunks.push(c as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text === "" ? undefined : JSON.parse(text);
  };

  const reply = (res: ServerResponse, status: number, error: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: error }, id: null }));
  };

  /** What the transport would refuse in an initialize, checked before any child is started or any session ended. */
  const initializeRefusal = (req: IncomingMessage): [number, string] | null => {
    if (!allowedHosts.includes(req.headers.host ?? "")) return [403, "host not allowed"];
    const accept = req.headers.accept ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return [406, "accept application/json and text/event-stream"];
    if ((req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json") return [415, "content-type application/json"];
    return null;
  };

  const server = createServer(async (req, res) => {
    let counted: Session | null = null;
    let opened: Session | null = null;
    try {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      if (path === "/health" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessions: sessions.size, children: homes.size }));
        return;
      }
      if (auth !== null && path !== "/mcp" && (await auth.handle(req, res, path, new URL(req.url ?? "/", "http://gateway")))) return;
      if (path !== "/mcp") return reply(res, 404, "not found");
      const u = await authenticate(req);
      if (u === null) return reply(res, 401, "unauthorized", { "www-authenticate": auth === null ? 'Bearer realm="ostra"' : auth.challenge() });
      const sid = req.headers["mcp-session-id"];
      const body = req.method === "POST" ? await readBody(req) : undefined;
      let s: Session | undefined;
      if (typeof sid === "string") {
        s = sessions.get(sid);
        // A session is its grant's (or its fixed user's) only.
        if (s === undefined || s.user !== u.id || s.grant !== u.grant || s.ending !== null) return reply(res, 404, "Session not found");
      } else if (req.method === "POST" && isInitializeRequest(body)) {
        const refused = initializeRefusal(req);
        if (refused !== null) return reply(res, refused[0], refused[1]);
        s = await withUserLock(u.id, () => open(u));
        opened = s;
      } else {
        // What a client sent without a session (its methods only, never their arguments), to see why.
        const methods = (Array.isArray(body) ? body : [body]).map((x) => (x !== null && typeof x === "object" && "method" in x ? String((x as { method: unknown }).method) : "-"));
        log("request_refused", { status: 400, httpMethod: req.method, methods: methods.slice(0, 5) });
        return reply(res, 400, "no session: start with initialize");
      }
      if (req.method === "POST") {
        s.inflight++;
        counted = s;
      }
      touch(s);
      await s.transport.handleRequest(req, res, body);
      // An initialize the transport refused leaves no session: its child goes.
      if (s.id === "") await withUserLock(s.user, () => end(s as Session, "initialize_refused"));
    } catch (err) {
      // An initialize that failed after its session was made: that session ends (its id never given out).
      if (opened !== null && opened.id === "") {
        const o = opened;
        await withUserLock(o.user, () => end(o, "initialize_failed")).catch(() => {});
      }
      const status = (err as { status?: number }).status ?? (err instanceof SyntaxError ? 400 : 500);
      log("request_failed", { status, error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) reply(res, status, status === 500 ? "internal error" : (err as Error).message, status === 429 ? { "retry-after": "2" } : {});
    } finally {
      if (counted !== null) {
        counted.inflight--;
        touch(counted);
      }
    }
  });
  // Each session holds its GET stream and a POST or two: three connections per session a home may keep.
  server.maxConnections = 3 * maxSessions * MAX_SESSIONS_PER_HOME + 16;
  server.headersTimeout = 20_000;
  server.listen(port, host, () => log("listening", { listen, users: users.length, idleSeconds, maxSessions, oauth: auth !== null, sandbox: sandboxMode, signer: signer !== null }));
  const stop = () => {
    log("stopping", { children: homes.size });
    server.close();
    void Promise.allSettled([...homes.values()].map((h) => endHome(h, "stopping"))).then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    log("fatal", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
