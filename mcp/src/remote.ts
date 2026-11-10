#!/usr/bin/env node
// Ostra's remote MCP gateway, stage 1 of the remote MCP design (10 Nov 2026): the MCP server over Streamable HTTP, so
// that an agent can be used from any Claude app, the phone included, through a custom connector. It runs nothing of
// its own: every session is a child process of the stdio server (server.ts) in the agent role of one user's vault
// (OSTRA_AGENT_OF), with that user's own OSTRA_HOME, and the gateway passes JSON-RPC messages both ways unchanged. The
// child holds only the user's agent seed: every spend it signs is held to the policy the vault's owner set, and the
// owner's tools refuse in it (tools.ts).
//
// One child per user at a time: the agent key is a chain of one-time keys kept in OSTRA_HOME, so two processes on one
// home could sign with the same key. A new session of a user ends the session before it; a session idle for
// OSTRA_REMOTE_IDLE_SECONDS ends, and its child with it.
//
// Stage 1 authenticates with a bearer token per user (OSTRA_REMOTE_USERS; scripts/remote-user.ts adds one); stage 2
// replaces it with OAuth and passkeys. Until then the gateway listens on loopback only unless told otherwise.
//
//   OSTRA_REMOTE_LISTEN        host:port (default 127.0.0.1:4920)
//   OSTRA_REMOTE_USERS         the users file (0600, JSON): {"users":[{"id","tokenSha256","vault"}]}, read again
//                              when it changes
//   OSTRA_REMOTE_ROOT          the users' directories (0700): <root>/<id>/home is OSTRA_HOME, <root>/<id>/pad-files
//                              OSTRA_PAD_FILES
//   OSTRA_REMOTE_IDLE_SECONDS  a session's idle time before it ends (default 900)
//   OSTRA_REMOTE_ALLOWED_HOSTS the Host headers accepted (comma separated; default the listen address), against DNS
//                              rebinding
//   OSTRA_REMOTE_MAX_SESSIONS  the most sessions (children) at once (default 50); a new user past it is answered 503
//
// The other OSTRA_* variables of its environment (OSTRA_RPC_URL_FILE, OSTRA_DEPLOYMENT, the service URLs...) and a
// few system ones (PASSED_ENV) are passed to the children; nothing else is. Per user it sets OSTRA_HOME,
// OSTRA_AGENT_OF, OSTRA_PAD_FILES, OSTRA_FILES_ONLY_IN (tools read local files only from the user's own pad-files)
// and OSTRA_HOME_EXCLUSIVE (server.ts then refuses to share the home and exits when its stdin closes). Logs are JSON
// lines on stderr; a child's stderr goes to <root>/<id>/mcp.log.
//
// Ending a session ends its server at once, a tool call in flight with it (a spend may have been sent; its one-time key
// is marked used before it signs, core agent-key.ts). Connections are capped (maxConnections) without a per-address
// limit: in front of the internet, the reverse proxy limits each address.
//
// Every child runs as the gateway's own system user: the folders of all users are readable by each child's process.
// The tools never read a path outside the user's pad-files (OSTRA_FILES_ONLY_IN); a separate system user per child
// is the deployment's next layer (planned with Ostra Cloud).

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Address } from "viem";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.ts");
/** The largest request body taken (MCP requests are small; tool arguments are JSON). */
const MAX_BODY = 1 << 20;
const USER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A user may start at most one session per this many ms (each start spawns a server and reads the chain). */
const OPEN_INTERVAL_MS = 2_000;
/** The variables of the gateway's environment a child gets besides OSTRA_* (OSTRA_REMOTE_* never). */
const PASSED_ENV = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]);

type User = { id: string; tokenSha256: Buffer; vault: Address };
/**
 * A user's session and its child. `exited` settles when the child's process has exited; `ending` is set by the first
 * end() and every later end() waits for the same one; `inflight` counts the session's POSTs being answered.
 */
type Session = {
  id: string;
  user: string;
  tokenSha256: Buffer;
  vault: Address;
  transport: StreamableHTTPServerTransport;
  child: StdioClientTransport;
  pid: number | null;
  exited: Promise<void>;
  idle: NodeJS.Timeout | null;
  inflight: number;
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

export function parseUsers(text: string): User[] {
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
    return { id, tokenSha256: Buffer.from(tokenSha256, "hex"), vault: getAddress(vault) };
  });
}

function main(): void {
  const usersPath = required("OSTRA_REMOTE_USERS");
  const root = required("OSTRA_REMOTE_ROOT");
  checkPrivatePath(usersPath, 0o600);
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

  /** Initialized sessions by session id. */
  const sessions = new Map<string, Session>();
  /** Each user's one live session, from the moment its child is spawned until that child is gone. */
  const byUser = new Map<string, Session>();
  /** When each user last started a session (ms): at most one start per OPEN_INTERVAL_MS. */
  const lastOpen = new Map<string, number>();

  /** Per user, the tail of the opens and ends queued: one at a time, so no two children ever share a home. */
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
   * Ends a session: its transport, then its child, waiting for the child's process to exit. Every later call waits
   * for the same end. Its user's slot is freed only once the child is gone; a child that does not exit keeps its
   * user blocked (logged), never a second child on that home.
   */
  const end = (s: Session, why: string): Promise<void> => {
    if (s.ending !== null) return s.ending;
    let done!: () => void;
    let failed!: (err: unknown) => void;
    s.ending = new Promise<void>((res, rej) => {
      done = res;
      failed = rej;
    });
    void (async () => {
      if (s.idle !== null) clearTimeout(s.idle);
      sessions.delete(s.id);
      log("session_end", { session: s.id, user: s.user, why });
      await s.transport.close().catch(() => {});
      await s.child.close().catch(() => {});
      const warn = setTimeout(() => log("child_stuck", { user: s.user, pid: s.pid, why: "still running 15 s after its end: its user stays blocked until it exits" }), 15_000);
      warn.unref();
      await s.exited;
      clearTimeout(warn);
      if (byUser.get(s.user) === s) byUser.delete(s.user);
    })().then(done, (err: unknown) => {
      log("child_stuck", { user: s.user, pid: s.pid, error: String(err) });
      failed(err);
    });
    return s.ending;
  };
  /** end() from a callback: a failure is logged there, never an unhandled rejection. */
  const endLater = (s: Session, why: string): void => void end(s, why).catch(() => {});

  /** Arms the idle timer, unless a POST of the session is still being answered. */
  const touch = (s: Session): void => {
    if (s.idle !== null) clearTimeout(s.idle);
    s.idle = null;
    if (s.inflight > 0 || s.ending !== null) return;
    s.idle = setTimeout(() => endLater(s, "idle"), idleSeconds * 1000);
    s.idle.unref();
  };

  let users: User[] = [];
  let usersMtime = -1;
  const readUsers = (): User[] => {
    const st = statSync(usersPath);
    if (st.mtimeMs !== usersMtime) {
      checkPrivatePath(usersPath, 0o600);
      const next = parseUsers(readFileSync(usersPath, "utf8"));
      // A user removed, or given a new token or vault: its live session ends.
      for (const s of byUser.values()) {
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

  /** The user a bearer token belongs to, or null. Every user's hash is compared, in constant time. */
  const authenticate = (req: IncomingMessage): User | null => {
    const h = req.headers.authorization;
    if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
    const token = h.slice(7).trim();
    if (token === "") return null;
    const hash = createHash("sha256").update(token).digest();
    let found: User | null = null;
    for (const u of readUsers()) if (timingSafeEqual(u.tokenSha256, hash)) found = u;
    return found;
  };

  /** The child's environment: only what it needs from the gateway's, and this user's own folders. */
  const childEnv = (u: User): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ((k.startsWith("OSTRA_") && !k.startsWith("OSTRA_REMOTE_")) || PASSED_ENV.has(k))) env[k] = v;
    const dir = join(root, u.id);
    mkdirSync(join(dir, "home"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "pad-files"), { recursive: true, mode: 0o700 });
    return { ...env, OSTRA_HOME: join(dir, "home"), OSTRA_AGENT_OF: u.vault, OSTRA_PAD_FILES: join(dir, "pad-files"), OSTRA_FILES_ONLY_IN: join(dir, "pad-files"), OSTRA_HOME_EXCLUSIVE: "yes" };
  };

  /** A new session of `u`, its child started; ends `u`'s session before it first. Called under `u`'s lock only. */
  const open = async (u: User): Promise<Session> => {
    const before = byUser.get(u.id);
    if (before !== undefined) await end(before, "replaced");
    if (byUser.size >= maxSessions) throw Object.assign(new Error("the gateway is full: try again later"), { status: 503 });
    const env = childEnv(u);
    const stderr = openSync(join(root, u.id, "mcp.log"), "a", 0o600);
    const child = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr, cwd: join(root, u.id) });
    let exited!: () => void;
    const s: Session = {
      id: "",
      user: u.id,
      tokenSha256: u.tokenSha256,
      vault: u.vault,
      transport: null as unknown as StreamableHTTPServerTransport,
      child,
      pid: null,
      exited: new Promise<void>((r) => (exited = r)),
      idle: null,
      inflight: 0,
      ending: null,
    };
    byUser.set(u.id, s);
    s.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        s.id = id;
        sessions.set(id, s);
        log("session_start", { session: id, user: u.id, vault: u.vault, pid: s.pid });
      },
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    s.transport.onmessage = (m) => void child.send(m).catch((err: unknown) => log("child_send_failed", { user: u.id, error: String(err) }));
    child.onmessage = (m) => {
      touch(s);
      void s.transport.send(m).catch((err: unknown) => log("client_send_failed", { user: u.id, error: String(err) }));
    };
    s.transport.onclose = () => endLater(s, "closed");
    child.onclose = () => endLater(s, "child_exit");
    child.onerror = (err) => log("child_error", { user: u.id, error: String(err) });
    // start() spawns the child synchronously, keeping it in _process (SDK 1.32.1, pinned), before its first await: its
    // real exit is watched from that moment, so an end() racing the start still waits for it (StdioClientTransport.close
    // sends SIGKILL last without waiting for the exit).
    const starting = child.start();
    const proc = (child as unknown as { _process?: ChildProcess })._process;
    if (proc === undefined) exited();
    else {
      s.pid = proc.pid ?? null;
      if (proc.exitCode !== null || proc.signalCode !== null) exited();
      else proc.once("exit", () => exited());
    }
    try {
      await starting;
      if (proc === undefined) throw new Error("the MCP SDK's StdioClientTransport kept no child process: the gateway cannot see it exit");
      if (s.ending !== null) throw new Error("the session ended while its server started");
    } catch (err) {
      await end(s, "child_failed").catch(() => {});
      throw err;
    } finally {
      closeSync(stderr);
    }
    return s;
  };

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
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessions: sessions.size, children: byUser.size }));
        return;
      }
      if (path !== "/mcp") return reply(res, 404, "not found");
      const u = authenticate(req);
      if (u === null) return reply(res, 401, "unauthorized", { "www-authenticate": 'Bearer realm="ostra"' });
      const sid = req.headers["mcp-session-id"];
      const body = req.method === "POST" ? await readBody(req) : undefined;
      let s: Session | undefined;
      if (typeof sid === "string") {
        s = sessions.get(sid);
        if (s === undefined || s.user !== u.id || s.ending !== null) return reply(res, 404, "Session not found");
      } else if (req.method === "POST" && isInitializeRequest(body)) {
        const refused = initializeRefusal(req);
        if (refused !== null) return reply(res, refused[0], refused[1]);
        const last = lastOpen.get(u.id) ?? 0;
        if (Date.now() - last < OPEN_INTERVAL_MS) return reply(res, 429, "too many sessions started: try again shortly", { "retry-after": "2" });
        lastOpen.set(u.id, Date.now());
        s = await withUserLock(u.id, () => open(u));
      } else return reply(res, 400, "no session: start with initialize");
      if (req.method === "POST") {
        s.inflight++;
        counted = s;
      }
      touch(s);
      await s.transport.handleRequest(req, res, body);
      // An initialize the transport refused leaves no session: its child goes.
      if (s.id === "") await withUserLock(s.user, () => end(s as Session, "initialize_refused"));
    } catch (err) {
      const status = (err as { status?: number }).status ?? (err instanceof SyntaxError ? 400 : 500);
      log("request_failed", { status, error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) reply(res, status, status === 500 ? "internal error" : (err as Error).message);
    } finally {
      if (counted !== null) {
        counted.inflight--;
        touch(counted);
      }
    }
  });
  server.maxConnections = 4 * maxSessions + 16;
  server.headersTimeout = 20_000;
  server.listen(port, host, () => log("listening", { listen, users: users.length, idleSeconds, maxSessions }));
  const stop = () => {
    log("stopping", { children: byUser.size });
    server.close();
    void Promise.allSettled([...byUser.values()].map((s) => end(s, "stopping"))).then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    log("fatal", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}
