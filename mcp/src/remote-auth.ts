// OAuth for the remote MCP gateway (remote.ts), stages 2 and 4 of the remote MCP design (10 Nov 2026): what a Claude
// custom connector needs (RFC 9728 and RFC 8414 metadata, dynamic client registration, the authorization code grant
// with PKCE S256, rotating refresh tokens), the connect calls of the web app's /connect page, and the owner's
// approvals of the /approve page.
//
// There are no accounts. A grant is for one vault and one installation of its agent key: it is given only once the
// chain shows that the vault's owner installed (AgentKeySet) the root the gateway handed out for that very
// authorization request, which only the holder of the owner's seed can do. It lives only while that installation is
// the vault's agent key in force or waiting, as the chain says now (the key's expiry, which the agent's spends never
// change, names the installation; a revoke zeroes the key): a later install ends it, unless the owner keeps it when
// connecting again, and a revoke seen ends every grant of the vault for good. The /connect page (app.ostraagent.xyz, the vault's seed in
// that browser) asks for the root (POST /connect/agent-key), signs the policy, the relayer's allowlist entry and the
// key with the owner's seed, then asks for the code (POST /connect/complete). An owner's tool called in an agent
// session is not run: the gateway keeps its arguments and answers with a link to /approve, where the owner signs it in
// the browser.
//
// A connection request is bound to the browser that started it: /authorize sets a cookie (HttpOnly, SameSite=Lax, on
// this host; app. and mcp. are one site, so the page's credentialed calls carry it) and every /connect call needs it,
// so that a request's link sent to someone else is of no use to whoever sends it. The /connect and /approve calls are
// taken from the web app's origin only (checked here, CORS aside).
//
// Everything kept is in one SQLite file (node:sqlite): clients, requests, codes, grants, tokens by their SHA-256, and
// approvals. Per-address limits are the reverse proxy's (ops/nginx); the limits here are per vault and global.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAddress, isAddress, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { AGENT_ACTION_NAMES, ALLOW_KIND_NAMES, VENUES } from "@ostraagent/core";
import { getLogsChunked, readV5, readVault, type Deployment } from "@ostraagent/sdk";

const REQUEST_SECONDS = 600;
const CODE_SECONDS = 60;
const ACCESS_SECONDS = 3_600;
const REFRESH_SECONDS = 30 * 86_400;
const APPROVAL_SECONDS = 900;
/** A refresh token used again within this many seconds of its rotation is a client's retry, not a copy (default). */
const REFRESH_GRACE_SECONDS = 30;
/**
 * Per vault: one agent key handed out per ISSUE_INTERVAL_SECONDS, and at most MAX_CONNECTS_PER_DAY connections done a
 * day. Only connections done count against the day (an unproven request costs the owner nothing but the interval).
 */
const ISSUE_INTERVAL_SECONDS = 20;
const MAX_CONNECTS_PER_DAY = 30;
/** The most approvals waiting per vault. */
const MAX_OPEN_APPROVALS = 10;
/**
 * The most clients registered per day, all together (a registration the same as one before gives that client back);
 * unused ones go after CLIENT_DAYS; requests and codes are dropped a day after they end.
 */
const MAX_CLIENTS_PER_DAY = 20_000;
const CLIENT_DAYS = 30;
/** How long a vault's agent key as read from the chain is used before it is read again; after a failed read, the wait before the next. */
const KEY_STATE_MS = 15_000;
const KEY_RETRY_MS = 5_000;
const MAX_BODY = 64 * 1024;
const AGENT_KEY_SET = parseAbiItem("event AgentKeySet(bytes32 indexed root, uint64 from, uint64 expiry)");
const AGENT_KEY_REVOKED = parseAbiItem("event AgentKeyRevoked(address indexed by)");

/** The owner's tools an agent session does not run: the owner approves them in the web app. */
export const OWNER_TOOLS = new Set(["policy_set", "allow_set", "agent_key_revoke"]);
/** The tools a remote session never runs, nor lists: an agent key is handed out and installed only by connecting. */
export const REMOTE_REFUSED_TOOLS = new Set(["agent_key_request", "agent_key_set"]);

const usdg = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/);
const actionName = z.enum(Object.keys(AGENT_ACTION_NAMES) as [string, ...string[]]);
const allowKind = z.enum(Object.keys(ALLOW_KIND_NAMES) as [string, ...string[]]);
/** The owner tools' arguments, as tools.ts takes them: an approval keeps only what passes. */
const OWNER_ARGS: Record<string, z.ZodType> = {
  policy_set: z
    .object({
      actions: z.array(actionName).max(64).optional(),
      perTx: usdg.optional(),
      daily: usdg.optional(),
      maxDebt: usdg.optional(),
      maxTermSeconds: z.number().int().min(0).max(365 * 86_400).optional(),
      maxFeeBps: z.number().int().min(0).max(10_000).optional(),
      coverBps: z.number().int().min(0).max(10_000).optional(),
      repayLeadSeconds: z.number().int().min(0).max(7 * 86_400).optional(),
      repayVenue: z.union([z.literal("none"), z.enum(VENUES.filter((v) => v.kind !== 2).map((v) => v.name) as [string, ...string[]])]).optional(),
      vouchPerAgent: usdg.optional(),
      vouchTotal: usdg.optional(),
      maxPremiumBps: z.number().int().min(0).max(200).optional(),
    })
    .strict(),
  allow_set: z.object({ kind: allowKind, value: z.string().min(1).max(66), allowed: z.boolean() }).strict(),
  agent_key_revoke: z.object({}).strict(),
};

export type AuthOptions = {
  /** This gateway's public base URL (https://mcp.ostraagent.xyz): the issuer and the resource. */
  publicUrl: string;
  /** The web app's origin (https://app.ostraagent.xyz): its /connect and /approve pages, and the only origin of their calls. */
  appUrl: string;
  dbPath: string;
  /** Redirect URIs a client may register: exact URLs, and loopback (http://localhost, 127.0.0.1 or [::1], any port) if set. */
  redirects: { exact: readonly string[]; loopback: boolean };
  client: PublicClient;
  /** Serves eth_getLogs (an AgentKeySet of the root a request handed out; the installs and revokes before it, to keep grants). */
  logsClient: PublicClient;
  deployment: Deployment;
  /** Hands out a new agent key root from vault `vault`'s home (remote.ts: under that home's lock). */
  issueAgentKey: (vault: Address) => Promise<{ root: Hex; index: string }>;
  /** The home id of a vault, for logs (remote.ts: not the address). */
  homeId: (vault: Address) => string;
  /** Called when a grant is found ended (its sessions go). */
  onGrantEnded?: (grant: string) => void;
  /** REFRESH_GRACE_SECONDS unless set (0: a refresh token is never taken twice). */
  refreshGraceSeconds?: number;
  /** KEY_STATE_MS unless set. */
  keyStateMs?: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
};

/** A vault's agent key as the chain has it now: `expiry` names its installation (0: none, revoked or never set). */
type ChainKey = { expiry: number };

const now = () => Math.floor(Date.now() / 1000);
const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SECURITY_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

async function readText(req: IncomingMessage): Promise<string> {
  const length = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY) throw new HttpError(413, "invalid_request", "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "invalid_request", "body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A loopback redirect URI (RFC 8252 7.3): http, host localhost, 127.0.0.1 or [::1], no user info, no fragment. */
function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") && u.username === "" && u.password === "" && u.hash === "" && !uri.includes("#");
  } catch {
    return false;
  }
}

/** Constant-time equality of two strings' SHA-256. */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** The cookies of a request, by name. */
function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}

type RequestRow = {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  state: string | null;
  binding: string;
  created: number;
  expires: number;
  status: string;
  vault: string | null;
  root: string | null;
  from_block: string | null;
  issued_at: number | null;
  redirect: string | null;
};

type ApprovalRow = { id: string; vault: string; grant_id: string; client_name: string; tool: string; args: string; created: number; expires: number; status: string };

export class RemoteAuth {
  readonly #o: AuthOptions;
  readonly #db: DatabaseSync;
  readonly #resource: string;
  readonly #secureCookie: boolean;
  /** Each vault's agent key as last read from the chain, when (ms), and the read running. */
  readonly #keyRead = new Map<string, { at: number; key: ChainKey | null; running: Promise<ChainKey> | null }>();

  constructor(o: AuthOptions) {
    this.#o = o;
    this.#resource = `${o.publicUrl}/mcp`;
    this.#secureCookie = o.publicUrl.startsWith("https://");
    this.#db = new DatabaseSync(o.dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT,
        state TEXT, binding TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL, vault TEXT, root TEXT UNIQUE, from_block TEXT,
        issued_at INTEGER, redirect TEXT);
      CREATE INDEX IF NOT EXISTS requests_vault ON requests (vault, status);
      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, request_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
        resource TEXT, vault TEXT NOT NULL, root TEXT NOT NULL, key_expiry INTEGER NOT NULL, set_block TEXT NOT NULL, expires INTEGER NOT NULL, grant_id TEXT);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, vault TEXT NOT NULL, client_id TEXT NOT NULL, root TEXT NOT NULL, key_expiry INTEGER NOT NULL,
        set_block TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS grants_vault ON grants (vault);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL, used_at INTEGER);
      CREATE INDEX IF NOT EXISTS tokens_grant ON tokens (grant_id);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, vault TEXT NOT NULL, grant_id TEXT NOT NULL, client_name TEXT NOT NULL, tool TEXT NOT NULL,
        args TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL);
    `);
  }

  close(): void {
    this.#db.close();
  }

  // --- a vault's agent key, read from the chain -------------------------------------------------------------------

  /**
   * The vault's agent key as the chain has it now (the read RPC, uncached; logs are never trusted to be current): at
   * most one read per KEY_STATE_MS unless `fresh`, and after a failed read none for KEY_RETRY_MS (the grants of the
   * vault meanwhile fail closed). A key zeroed (revoked) ends every grant of the vault for good.
   */
  async chainKey(vault: Address, fresh = false): Promise<ChainKey> {
    const read = this.#keyRead.get(vault);
    if (read?.running) return read.running;
    if (read !== undefined && Date.now() - read.at < (read.key === null ? KEY_RETRY_MS : (this.#o.keyStateMs ?? KEY_STATE_MS)) && !(fresh && read.key !== null)) {
      if (read.key === null) throw new Error("the vault's agent key could not be read from the chain just now");
      return read.key;
    }
    const running = (async () => {
      const v5 = await readV5(this.#o.client, vault);
      const key = { expiry: v5 === null || BigInt(v5.agentKey.root) === 0n ? 0 : Number(v5.agentKey.expiry) };
      if (key.expiry === 0) {
        const ended = this.#db.prepare("SELECT id FROM grants WHERE vault = ? AND revoked = 0").all(vault) as { id: string }[];
        if (ended.length > 0) {
          this.#db.prepare("UPDATE grants SET revoked = 1 WHERE vault = ?").run(vault);
          for (const g of ended) this.#o.onGrantEnded?.(g.id);
          this.#o.log("grants_revoked_on_chain", { user: this.#o.homeId(vault), grants: ended.length });
        }
      }
      return key;
    })();
    this.#keyRead.set(vault, { at: read?.at ?? 0, key: read?.key ?? null, running });
    try {
      const key = await running;
      this.#keyRead.set(vault, { at: Date.now(), key, running: null });
      return key;
    } catch (err) {
      this.#keyRead.set(vault, { at: Date.now(), key: null, running: null });
      throw err;
    }
  }

  /** Whether grant `g` lives: not revoked, its installation the vault's agent key now, not expired. */
  async #grantLives(g: { vault: string; key_expiry: number; revoked: number }): Promise<boolean> {
    if (g.revoked !== 0 || g.key_expiry <= now()) return false;
    const k = await this.chainKey(getAddress(g.vault));
    return k.expiry === g.key_expiry;
  }

  /**
   * The grant and vault of an access token: `live` false when the token is known but its grant ended (its sessions
   * should end); null when the token is unknown or expired.
   */
  async grantOf(accessToken: string): Promise<{ grant: string; vault: Address; live: boolean } | null> {
    const row = this.#db
      .prepare("SELECT g.id AS id, g.vault AS vault, g.key_expiry AS key_expiry, g.revoked AS revoked FROM tokens t JOIN grants g ON g.id = t.grant_id WHERE t.hash = ? AND t.kind = 'access' AND t.expires > ?")
      .get(sha(accessToken), now()) as { id: string; vault: string; key_expiry: number; revoked: number } | undefined;
    if (row === undefined) return null;
    return { grant: row.id, vault: getAddress(row.vault), live: await this.#grantLives(row) };
  }

  /** An owner's tool called in grant `grant`'s session of `vault`: kept for the owner to approve. Throws for arguments the tool would refuse. */
  createApproval(grant: string, vault: Address, tool: string, args: unknown): { approve: string; expiresAt: string } {
    const schema = OWNER_ARGS[tool];
    if (schema === undefined) throw new RangeError(`${tool} is not an owner's tool`);
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) throw new RangeError(`${tool}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    const open = this.#db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE vault = ? AND status = 'open' AND expires > ?").get(vault, now()) as { n: number };
    if (open.n >= MAX_OPEN_APPROVALS) throw new RangeError(`${MAX_OPEN_APPROVALS} approvals of this vault wait already: the owner decides those first`);
    const g = this.#db.prepare("SELECT c.name AS name FROM grants g JOIN clients c ON c.id = g.client_id WHERE g.id = ?").get(grant) as { name: string } | undefined;
    const id = token(16);
    const expires = now() + APPROVAL_SECONDS;
    this.#db
      .prepare("INSERT INTO approvals (id, vault, grant_id, client_name, tool, args, created, expires, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')")
      .run(id, vault, grant, g?.name ?? "an MCP client", tool, JSON.stringify(parsed.data), now(), expires);
    this.#o.log("approval_created", { user: this.#o.homeId(vault), tool });
    return { approve: `${this.#o.appUrl}/approve?id=${id}`, expiresAt: new Date(expires * 1000).toISOString() };
  }

  /** The WWW-Authenticate header of a 401 from /mcp (RFC 9728 5.1: the metadata of the resource /mcp). */
  challenge(): string {
    return `Bearer resource_metadata="${this.#o.publicUrl}/.well-known/oauth-protected-resource/mcp"`;
  }

  /** Answers the request if it is one of these routes; false otherwise. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
    const page = path.startsWith("/connect/") || path.startsWith("/approve/");
    if (page) {
      // The web app's calls only: the origin is checked here (CORS only keeps other pages from reading the answer).
      if (req.headers.origin !== this.#o.appUrl) {
        json(res, 403, { error: "origin_not_allowed" });
        return true;
      }
      res.setHeader("access-control-allow-origin", this.#o.appUrl);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("vary", "origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
        res.end();
        return true;
      }
    }
    try {
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, { resource: this.#resource, authorization_servers: [this.#o.publicUrl], bearer_methods_supported: ["header"], resource_name: "Ostra Agent" }, { "cache-control": "public, max-age=3600" });
      } else if (path === "/.well-known/oauth-authorization-server") {
        const b = this.#o.publicUrl;
        json(
          res,
          200,
          {
            issuer: b,
            authorization_endpoint: `${b}/authorize`,
            token_endpoint: `${b}/token`,
            registration_endpoint: `${b}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            authorization_response_iss_parameter_supported: true,
          },
          { "cache-control": "public, max-age=3600" },
        );
      } else if (path === "/register" && req.method === "POST") await this.#register(req, res);
      else if (path === "/authorize" && req.method === "GET") this.#authorize(res, url);
      else if (path === "/token" && req.method === "POST") await this.#token(req, res);
      else if (path === "/connect/request" && req.method === "GET") this.#connectInfo(req, res, url);
      else if (path === "/connect/agent-key" && req.method === "POST") await this.#connectAgentKey(req, res);
      else if (path === "/connect/complete" && req.method === "POST") await this.#connectComplete(req, res);
      else if (path === "/connect/cancel" && req.method === "POST") await this.#connectCancel(req, res);
      else if (path === "/approve/request" && req.method === "GET") this.#approvalInfo(res, url);
      else if (path === "/approve/done" && req.method === "POST") await this.#approvalDone(req, res);
      else return false;
    } catch (err) {
      if (err instanceof HttpError) json(res, err.status, { error: err.code, error_description: err.message });
      else {
        this.#o.log("auth_failed", { path, error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) json(res, 500, { error: "server_error" });
      }
    }
    return true;
  }

  // --- OAuth -------------------------------------------------------------------------------------------------------

  async #register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readText(req)) as Record<string, unknown>;
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, "invalid_client_metadata", "the body is a JSON object");
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 512)) throw new HttpError(400, "invalid_redirect_uri", "redirect_uris: 1 to 10 URLs");
    for (const u of uris as string[]) if (!this.#redirectAllowed(u)) throw new HttpError(400, "invalid_redirect_uri", `${u} is not a redirect URI this server accepts`);
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none") throw new HttpError(400, "invalid_client_metadata", "token_endpoint_auth_method: none (public clients)");
    // Clients never used go after CLIENT_DAYS; requests and codes a day after they end.
    this.#db.prepare("DELETE FROM clients WHERE created < ? AND id NOT IN (SELECT client_id FROM grants)").run(now() - CLIENT_DAYS * 86_400);
    this.#db.prepare("DELETE FROM requests WHERE expires < ?").run(now() - 86_400);
    this.#db.prepare("DELETE FROM codes WHERE expires < ?").run(now() - 86_400);
    const raw = typeof body.client_name === "string" ? body.client_name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() : "";
    const name = raw !== "" ? raw.slice(0, 100) : "an MCP client";
    // The same name and redirect URIs as a client before: that client (public clients: its id is no secret).
    const same = this.#db.prepare("SELECT id, created FROM clients WHERE name = ? AND redirect_uris = ? ORDER BY created DESC LIMIT 1").get(name, JSON.stringify(uris)) as { id: string; created: number } | undefined;
    const reply = (id: string, issued: number) =>
      json(res, 201, { client_id: id, client_id_issued_at: issued, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    if (same !== undefined) return reply(same.id, same.created);
    const day = this.#db.prepare("SELECT COUNT(*) AS n FROM clients WHERE created > ?").get(now() - 86_400) as { n: number };
    if (day.n >= MAX_CLIENTS_PER_DAY) throw new HttpError(429, "temporarily_unavailable", "too many registrations today");
    const id = `c_${token(18)}`;
    this.#db.prepare("INSERT INTO clients (id, name, redirect_uris, created) VALUES (?, ?, ?, ?)").run(id, name, JSON.stringify(uris), now());
    this.#o.log("client_registered", { client: id });
    reply(id, now());
  }

  #redirectAllowed(uri: string): boolean {
    if (this.#o.redirects.exact.includes(uri)) return true;
    return this.#o.redirects.loopback && isLoopback(uri);
  }

  /** Whether `uri` is one of the client's: exact, or for a loopback URI the same but for its port (RFC 8252 7.3). */
  #clientRedirect(clientUris: string[], uri: string): boolean {
    if (clientUris.includes(uri)) return true;
    if (!isLoopback(uri)) return false;
    const a = new URL(uri);
    return clientUris.some((c) => {
      if (!isLoopback(c)) return false;
      const b = new URL(c);
      return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
    });
  }

  #client(id: string | null): { id: string; name: string; uris: string[] } | null {
    if (id === null) return null;
    const row = this.#db.prepare("SELECT id, name, redirect_uris FROM clients WHERE id = ?").get(id) as { id: string; name: string; redirect_uris: string } | undefined;
    return row === undefined ? null : { id: row.id, name: row.name, uris: JSON.parse(row.redirect_uris) as string[] };
  }

  #cookieName(request: string): string {
    return `${this.#secureCookie ? "__Host-" : ""}ostra-connect-${request}`;
  }

  #authorize(res: ServerResponse, url: URL): void {
    const q = url.searchParams;
    const client = this.#client(q.get("client_id"));
    const redirect = q.get("redirect_uri");
    // Before the redirect URI is known to be the client's, errors are shown here, never sent to it.
    if (client === null) return this.#page(res, 400, "Unknown client", "This connection request names a client this server does not know. Start again from the app.");
    if (redirect === null || !this.#clientRedirect(client.uris, redirect)) return this.#page(res, 400, "Wrong redirect", "This connection request's redirect address is not the client's. Start again from the app.");
    const state = q.get("state");
    const back = (error: string, description: string) => {
      const to = new URL(redirect);
      to.searchParams.set("error", error);
      to.searchParams.set("error_description", description);
      if (state !== null) to.searchParams.set("state", state);
      to.searchParams.set("iss", this.#o.publicUrl);
      res.writeHead(302, { location: to.toString(), ...SECURITY_HEADERS });
      res.end();
    };
    if (q.get("response_type") !== "code") return back("unsupported_response_type", "response_type=code");
    const challenge = q.get("code_challenge");
    if (q.get("code_challenge_method") !== "S256" || challenge === null || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back("invalid_request", "PKCE with S256 is required");
    const resource = q.get("resource");
    if (resource !== null && resource !== this.#resource && resource !== this.#o.publicUrl) return back("invalid_target", `the resource is ${this.#resource}`);
    if (state !== null && state.length > 1_024) return back("invalid_request", "state is too long");
    const id = token(18);
    const binding = token();
    this.#db
      .prepare("INSERT INTO requests (id, client_id, redirect_uri, code_challenge, resource, state, binding, created, expires, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')")
      .run(id, client.id, redirect, challenge, resource, state, sha(binding), now(), now() + REQUEST_SECONDS);
    const cookie = `${this.#cookieName(id)}=${binding}; Path=/; Max-Age=${REQUEST_SECONDS}; HttpOnly; SameSite=Lax${this.#secureCookie ? "; Secure" : ""}`;
    res.writeHead(302, { location: `${this.#o.appUrl}/connect?request=${id}`, "set-cookie": cookie, ...SECURITY_HEADERS });
    res.end();
  }

  #page(res: ServerResponse, status: number, title: string, text: string): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(text)}</p></body>`);
  }

  async #token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") throw new HttpError(400, "invalid_request", "application/x-www-form-urlencoded");
    const p = new URLSearchParams(await readText(req));
    const grant = p.get("grant_type");
    const client = this.#client(p.get("client_id"));
    if (client === null) throw new HttpError(401, "invalid_client", "unknown client");
    const resource = p.get("resource");
    if (resource !== null && resource !== this.#resource && resource !== this.#o.publicUrl) throw new HttpError(400, "invalid_target", `the resource is ${this.#resource}`);
    if (grant === "authorization_code") {
      const code = p.get("code");
      const verifier = p.get("code_verifier");
      if (code === null || verifier === null || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new HttpError(400, "invalid_request", "code and code_verifier (43 to 128 characters)");
      const row = this.#db.prepare("SELECT * FROM codes WHERE hash = ?").get(sha(code)) as
        | { hash: string; request_id: string; client_id: string; redirect_uri: string; code_challenge: string; resource: string | null; vault: string; root: string; key_expiry: number; set_block: string; expires: number; grant_id: string | null }
        | undefined;
      if (row === undefined || row.client_id !== client.id) throw new HttpError(400, "invalid_grant", "the code is unknown or not this client's");
      if (row.grant_id !== null) {
        // A code redeemed twice: the grant it gave is revoked (RFC 6749 4.1.2).
        this.#endGrant(row.grant_id, "code_reused");
        throw new HttpError(400, "invalid_grant", "the code was used already");
      }
      if (row.expires <= now()) throw new HttpError(400, "invalid_grant", "the code expired");
      if (p.get("redirect_uri") !== row.redirect_uri) throw new HttpError(400, "invalid_grant", "redirect_uri is not the one of the authorization");
      if (resource !== null && row.resource !== null && resource !== row.resource) throw new HttpError(400, "invalid_target", "the resource is not the one of the authorization");
      if (!sameSecret(b64url(createHash("sha256").update(verifier).digest()), row.code_challenge)) throw new HttpError(400, "invalid_grant", "the code_verifier does not match");
      const grantId = `g_${token(18)}`;
      const taken = this.#db.prepare("UPDATE codes SET grant_id = ? WHERE hash = ? AND grant_id IS NULL").run(grantId, row.hash);
      if (taken.changes !== 1) throw new HttpError(400, "invalid_grant", "the code was used already");
      this.#db.prepare("INSERT INTO grants (id, vault, client_id, root, key_expiry, set_block, created) VALUES (?, ?, ?, ?, ?, ?, ?)").run(grantId, row.vault, client.id, row.root, row.key_expiry, row.set_block, now());
      // The code is in the request's redirect until it is redeemed (complete answered again to the bound browser).
      this.#db.prepare("UPDATE requests SET redirect = NULL WHERE id = ?").run(row.request_id);
      this.#o.log("grant_issued", { grant: grantId, user: this.#o.homeId(getAddress(row.vault)), client: client.id });
      return json(res, 200, this.#issueTokens(grantId));
    }
    if (grant === "refresh_token") {
      const refresh = p.get("refresh_token");
      if (refresh === null) throw new HttpError(400, "invalid_request", "refresh_token");
      const row = this.#db
        .prepare(
          "SELECT t.hash AS hash, t.grant_id AS grant_id, t.expires AS expires, t.used_at AS used_at, g.vault AS vault, g.key_expiry AS key_expiry, g.revoked AS revoked, g.client_id AS client_id FROM tokens t JOIN grants g ON g.id = t.grant_id WHERE t.hash = ? AND t.kind = 'refresh'",
        )
        .get(sha(refresh)) as { hash: string; grant_id: string; expires: number; used_at: number | null; vault: string; key_expiry: number; revoked: number; client_id: string } | undefined;
      if (row === undefined || row.revoked !== 0 || row.expires <= now() || row.client_id !== client.id) throw new HttpError(400, "invalid_grant", "the refresh token is unknown, expired or revoked");
      if (row.used_at !== null && now() - row.used_at >= (this.#o.refreshGraceSeconds ?? REFRESH_GRACE_SECONDS)) {
        // A rotated refresh token used again (past a retry's grace): someone holds a copy. The whole grant ends.
        this.#endGrant(row.grant_id, "refresh_reused");
        throw new HttpError(400, "invalid_grant", "the refresh token was used already: the grant is revoked");
      }
      if (!(await this.#grantLives(row))) throw new HttpError(400, "invalid_grant", "the agent key of this connection was replaced, revoked or expired: connect again");
      if (row.used_at === null) this.#db.prepare("UPDATE tokens SET used_at = ? WHERE hash = ?").run(now(), row.hash);
      return json(res, 200, this.#issueTokens(row.grant_id));
    }
    throw new HttpError(400, "unsupported_grant_type", "authorization_code or refresh_token");
  }

  #endGrant(grant: string, why: string): void {
    this.#db.prepare("UPDATE grants SET revoked = 1 WHERE id = ?").run(grant);
    this.#o.log("grant_revoked", { grant, why });
    this.#o.onGrantEnded?.(grant);
  }

  #issueTokens(grantId: string): Record<string, unknown> {
    const access = token();
    const refresh = token();
    const ins = this.#db.prepare("INSERT INTO tokens (hash, grant_id, kind, expires) VALUES (?, ?, ?, ?)");
    ins.run(sha(access), grantId, "access", now() + ACCESS_SECONDS);
    ins.run(sha(refresh), grantId, "refresh", now() + REFRESH_SECONDS);
    // Spent rows are dropped as they pile up: expired tokens.
    this.#db.prepare("DELETE FROM tokens WHERE expires <= ?").run(now());
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh };
  }

  // --- the web app's /connect page -----------------------------------------------------------------------------------

  /** The request `id`, checked to be this browser's (its binding cookie). */
  #request(req: IncomingMessage, id: unknown): RequestRow {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(id)) throw new HttpError(400, "invalid_request", "request");
    const row = this.#db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
    const binding = cookies(req).get(this.#cookieName(id));
    // Unknown, or not this browser's: the same answer.
    if (row === undefined || binding === undefined || !sameSecret(sha(binding), row.binding)) throw new HttpError(403, "not_this_browser", "this connection request was not started in this browser: start again from the app");
    if (row.expires <= now() && row.status !== "done") throw new HttpError(410, "expired", "this connection request has expired: start again from the app");
    return row;
  }

  async #jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "invalid_request", "application/json");
    try {
      const v = JSON.parse(await readText(req)) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, "invalid_request", "the body is a JSON object");
    }
  }

  #connectInfo(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const r = this.#request(req, url.searchParams.get("id"));
    const client = this.#client(r.client_id);
    json(res, 200, {
      client: client?.name ?? "an MCP client",
      redirectHost: new URL(r.redirect_uri).host,
      status: r.status,
      vault: r.vault,
      root: r.root,
      createdAt: new Date(r.created * 1000).toISOString(),
      expiresAt: new Date(r.expires * 1000).toISOString(),
    });
  }

  async #connectAgentKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = await this.#jsonBody(req);
    const r = this.#request(req, b.request);
    if (typeof b.vault !== "string" || !isAddress(b.vault, { strict: false })) throw new HttpError(400, "invalid_request", "vault");
    const vault = getAddress(b.vault);
    // One root per request: asked again, the same one.
    if (r.status === "issued" && r.vault === vault && r.root !== null) return json(res, 200, { root: r.root, vault, maxDays: 90, reused: true });
    if (r.status !== "open") throw new HttpError(409, "conflict", `this connection request is ${r.status}`);
    // Checked before anything is made for the vault (its home included): one of this deployment, at version 5.
    if ((await readVault(this.#o.client, this.#o.deployment, vault)) === null) throw new HttpError(400, "invalid_request", "this address is not an Ostra vault of this deployment");
    if ((await readV5(this.#o.client, vault)) === null) throw new HttpError(400, "invalid_request", "this vault does not run version 5");
    const t = now();
    const last = this.#db.prepare("SELECT MAX(issued_at) AS t FROM requests WHERE vault = ?").get(vault) as { t: number | null };
    if (last.t !== null && t - last.t < ISSUE_INTERVAL_SECONDS) throw new HttpError(429, "slow_down", `one agent key per ${ISSUE_INTERVAL_SECONDS} s for a vault: try again shortly`);
    const day = this.#db.prepare("SELECT COUNT(*) AS n FROM requests WHERE vault = ? AND status = 'done' AND issued_at > ?").get(vault, t - 86_400) as { n: number };
    if (day.n >= MAX_CONNECTS_PER_DAY) throw new HttpError(429, "slow_down", `${MAX_CONNECTS_PER_DAY} connections of this vault were made in a day: try again tomorrow`);
    const claimed = this.#db.prepare("UPDATE requests SET status = 'issuing', vault = ?, issued_at = ? WHERE id = ? AND status = 'open'").run(vault, t, r.id);
    if (claimed.changes !== 1) throw new HttpError(409, "conflict", "this connection request is being answered already");
    let key: { root: Hex; index: string };
    let fromBlock: bigint;
    try {
      fromBlock = await this.#o.logsClient.getBlockNumber({ cacheTime: 0 });
      key = await this.#o.issueAgentKey(vault);
      if (!/^0x[0-9a-fA-F]{64}$/.test(key.root)) throw new Error("the home gave no root");
    } catch (err) {
      // The index taken (if any) is not handed out again: issued_at stays, for the vault's interval.
      this.#db.prepare("UPDATE requests SET status = 'failed' WHERE id = ? AND status = 'issuing'").run(r.id);
      throw err;
    }
    // The owner has REQUEST_SECONDS from now to sign it (a cancel meanwhile stands: the root is not given).
    const issued = this.#db
      .prepare("UPDATE requests SET status = 'issued', root = ?, from_block = ?, expires = ? WHERE id = ? AND status = 'issuing'")
      .run(key.root.toLowerCase(), fromBlock.toString(), now() + REQUEST_SECONDS, r.id);
    if (issued.changes !== 1) throw new HttpError(409, "conflict", "this connection request was cancelled");
    this.#o.log("connect_key_issued", { request: r.id, user: this.#o.homeId(vault), index: key.index });
    json(res, 200, { root: key.root, vault, maxDays: 90 });
  }

  async #connectComplete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = await this.#jsonBody(req);
    const r = this.#request(req, b.request);
    // Done, its code not redeemed yet: the same answer again to the browser it is bound to (its first answer was lost).
    if (r.status === "done" && r.redirect !== null) {
      const code = this.#db.prepare("SELECT 1 FROM codes WHERE request_id = ? AND grant_id IS NULL AND expires > ?").get(r.id, now());
      if (code !== undefined) return json(res, 200, { redirect: r.redirect, again: true });
    }
    if (r.status !== "issued" || r.vault === null || r.root === null || r.from_block === null) throw new HttpError(409, "conflict", `this connection request is ${r.status}`);
    const vault = getAddress(r.vault);
    // The owner installed this request's root after it was handed out: its AgentKeySet (the root is indexed), and the
    // chain's key now that installation (its expiry), not revoked nor replaced since. It may wait for the lock's delay:
    // the grant is given now, and the key signs from `from`.
    const tip = await this.#o.logsClient.getBlockNumber({ cacheTime: 0 });
    const sets = await getLogsChunked(this.#o.logsClient, { address: vault, event: AGENT_KEY_SET, args: { root: r.root as Hex }, fromBlock: BigInt(r.from_block), toBlock: tip });
    const set = sets.at(-1);
    if (set === undefined) return json(res, 409, { error: "not_installed", error_description: "the vault's owner has not installed this request's agent key yet" });
    const keyExpiry = Number((set as unknown as { args: { expiry: bigint } }).args.expiry);
    const v5 = await readV5(this.#o.client, vault);
    const k = await this.chainKey(vault, true);
    if (k.expiry !== keyExpiry) return json(res, 409, { error: "not_in_force", error_description: "this request's agent key was installed, then revoked or replaced: start again from the app" });
    const done = this.#db.prepare("UPDATE requests SET status = 'done' WHERE id = ? AND status = 'issued'").run(r.id);
    if (done.changes !== 1) throw new HttpError(409, "conflict", "this connection request is done already");
    // Kept at the owner's word: the grants of the installation just before this one go on with this one, unless the
    // key was revoked in between (a revoke ends them for good). The logs read are of blocks up to this install's.
    let kept = 0;
    if (b.keep === true) {
      const candidates = this.#db.prepare("SELECT MIN(CAST(set_block AS INTEGER)) AS b FROM grants WHERE vault = ? AND revoked = 0 AND key_expiry > ?").get(vault, now()) as { b: number | null };
      if (candidates.b !== null && BigInt(candidates.b) <= set.blockNumber) {
        const q = { address: vault, fromBlock: BigInt(candidates.b), toBlock: set.blockNumber };
        const [all, revokes] = await Promise.all([getLogsChunked(this.#o.logsClient, { ...q, event: AGENT_KEY_SET }), getLogsChunked(this.#o.logsClient, { ...q, event: AGENT_KEY_REVOKED })]);
        const before = (l: { blockNumber: bigint; logIndex: number }) => l.blockNumber < set.blockNumber || (l.blockNumber === set.blockNumber && l.logIndex < set.logIndex);
        const prev = all.filter(before).at(-1);
        if (prev !== undefined) {
          const after = (l: { blockNumber: bigint; logIndex: number }) => l.blockNumber > prev.blockNumber || (l.blockNumber === prev.blockNumber && l.logIndex > prev.logIndex);
          const prevExpiry = Number((prev as unknown as { args: { expiry: bigint } }).args.expiry);
          if (revokes.some((l) => after(l) && before(l))) {
            this.#db.prepare("UPDATE grants SET revoked = 1 WHERE vault = ? AND key_expiry = ?").run(vault, prevExpiry);
          } else {
            kept = Number(
              this.#db.prepare("UPDATE grants SET root = ?, key_expiry = ?, set_block = ? WHERE vault = ? AND key_expiry = ? AND revoked = 0").run(r.root, keyExpiry, set.blockNumber.toString(), vault, prevExpiry).changes,
            );
          }
        }
      }
    }
    const code = token();
    this.#db
      .prepare("INSERT INTO codes (hash, request_id, client_id, redirect_uri, code_challenge, resource, vault, root, key_expiry, set_block, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sha(code), r.id, r.client_id, r.redirect_uri, r.code_challenge, r.resource, vault, r.root, keyExpiry, set.blockNumber.toString(), now() + CODE_SECONDS);
    const to = new URL(r.redirect_uri);
    to.searchParams.set("code", code);
    if (r.state !== null) to.searchParams.set("state", r.state);
    to.searchParams.set("iss", this.#o.publicUrl);
    this.#db.prepare("UPDATE requests SET redirect = ? WHERE id = ?").run(to.toString(), r.id);
    this.#o.log("connect_done", { request: r.id, user: this.#o.homeId(vault), kept });
    json(res, 200, { redirect: to.toString(), agentKeyFrom: v5 === null ? null : new Date(Number(v5.agentKey.from) * 1000).toISOString(), kept });
  }

  async #connectCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = await this.#jsonBody(req);
    const r = this.#request(req, b.request);
    if (r.status === "done") throw new HttpError(409, "conflict", "this connection request is done");
    this.#db.prepare("UPDATE requests SET status = 'cancelled' WHERE id = ? AND status != 'done'").run(r.id);
    const to = new URL(r.redirect_uri);
    to.searchParams.set("error", "access_denied");
    to.searchParams.set("error_description", "the vault's owner declined");
    if (r.state !== null) to.searchParams.set("state", r.state);
    to.searchParams.set("iss", this.#o.publicUrl);
    json(res, 200, { redirect: to.toString() });
  }

  // --- the web app's /approve page -----------------------------------------------------------------------------------

  #approval(id: unknown): ApprovalRow {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(id)) throw new HttpError(400, "invalid_request", "id");
    const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    if (row === undefined) throw new HttpError(404, "not_found", "no such approval");
    return row;
  }

  /** What an approval asks, for the page to show and sign: nothing of it is read from the page's URL but its id. */
  #approvalInfo(res: ServerResponse, url: URL): void {
    const a = this.#approval(url.searchParams.get("id"));
    json(res, 200, {
      vault: a.vault,
      tool: a.tool,
      args: JSON.parse(a.args) as unknown,
      askedBy: a.client_name,
      createdAt: new Date(a.created * 1000).toISOString(),
      expiresAt: new Date(a.expires * 1000).toISOString(),
      status: a.expires <= now() && a.status === "open" ? "expired" : a.status,
    });
  }

  /** The page's word once the owner signed (the transaction sent) or declined: bookkeeping, it grants nothing. */
  async #approvalDone(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = await this.#jsonBody(req);
    const a = this.#approval(b.id);
    if (b.outcome !== "signed" && b.outcome !== "declined") throw new HttpError(400, "invalid_request", "outcome: signed or declined");
    if (a.status !== "open" || a.expires <= now()) throw new HttpError(409, "conflict", `this approval is ${a.status === "open" ? "expired" : a.status}`);
    this.#db.prepare("UPDATE approvals SET status = ? WHERE id = ? AND status = 'open'").run(b.outcome, a.id);
    json(res, 200, { status: b.outcome });
  }
}
