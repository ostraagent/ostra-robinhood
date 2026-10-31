// Ostra Tide's API in the indexer (src/tide.ts, src/http.ts handleTide), served on 127.0.0.1, without a chain (no
// link is verified here; keeper's tide-score.fork.test.ts verifies them on a fork): a link is kept (0600, at most 8
// unverified per agent), malformed ones refused, bodies over 8 KiB refused; an agent's figures are answered only to
// the view key of the link its result names, another kept link's key gets only what that link lacks, a link someone
// else posted for the agent gets nothing of it, any other key 404; the summary names no agent.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getAddress, type Hex } from "viem";
import { TIDE_START, tideLinkDeadline, tideViewKey } from "@ostraagent/sdk";
import { createIndexerServer } from "../src/http.ts";
import type { Indexer } from "../src/indexer.ts";
import { TideApi } from "../src/tide.ts";

let root: string;
let base: string;
let close: () => Promise<void>;
let tide: TideApi;
const secret = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const V1 = getAddress("0x00000000000000000000000000000000000000a1");
const V2 = getAddress("0x00000000000000000000000000000000000000b2");

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-tide-api-"));
  await mkdir(join(root, "results"));
  tide = new TideApi({ linksPath: join(root, "links.json"), resultsDir: join(root, "results"), now: () => TIDE_START + 3 * 86_400 });
  await tide.load();
  const server = createIndexerServer({} as Indexer, () => {}, null, tide);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});

after(async () => {
  await close?.();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const post = async (route: string, body: unknown) => {
  const res = await fetch(`${base}/api/v1/tide/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
};

test("links: kept in a 0600 file, never answered back; malformed ones and large bodies refused; 8 per agent at most", async () => {
  const r = await post("link", { agentId: "19802", secret: secret(1), vaults: [V2, V1], payee: V1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { stored: true, verified: false, week: 1, deadline: tideLinkDeadline(1) });
  assert.equal(r.cache, "no-store");
  assert.equal(JSON.stringify(r.json).includes(secret(1).slice(2)), false);
  assert.equal((await stat(join(root, "links.json"))).mode & 0o777, 0o600);
  const kept = JSON.parse(await readFile(join(root, "links.json"), "utf8")) as { vaults: string[]; payee: string }[];
  assert.deepEqual(kept[0]!.vaults, [V1, V2]);
  for (const bad of [
    { agentId: "x", secret: secret(1), vaults: [V1], payee: null },
    { agentId: "1", secret: secret(0), vaults: [V1], payee: null },
    { agentId: "1", secret: secret(1), vaults: [], payee: null },
    { agentId: "1", secret: secret(1), vaults: [V1], payee: V2 },
    { agentId: "1", secret: secret(1), vaults: Array.from({ length: 97 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`)), payee: null },
  ]) {
    const b = await post("link", bad);
    assert.equal(b.status, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal(b.json.error, "bad_request");
  }
  assert.equal((await post("link", "{nope")).status, 400);
  assert.equal((await post("link", { agentId: "1", pad: "x".repeat(9_000) })).status, 413);
  assert.equal((await fetch(`${base}/api/v1/tide/link`)).status, 405);
  for (let i = 2; i <= 10; i++) assert.equal((await post("link", { agentId: "7", secret: secret(i), vaults: [V1], payee: null })).status, 200);
  const all = JSON.parse(await readFile(join(root, "links.json"), "utf8")) as { agentId: string; secret: string }[];
  const sevens = all.filter((x) => x.agentId === "7");
  assert.equal(sevens.length, 8);
  assert.deepEqual(sevens.map((x) => BigInt(x.secret)), [3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
});

test("points: only to the view key the result names; another kept link's key gets what it lacks; a stranger's link nothing; the summary names nobody", async () => {
  const key = tideViewKey(secret(1));
  assert.equal((await post("points", { agentId: "19802", viewKey: tideViewKey(secret(2)) })).status, 404);
  // Someone else posts links of their own for agent 19802.
  assert.equal((await post("link", { agentId: "19802", secret: secret(20), vaults: [V2], payee: null })).status, 200);
  assert.equal((await post("link", { agentId: "19802", secret: secret(21), vaults: [V1, V2], payee: null })).status, 200);
  assert.equal((await post("points", { agentId: "19803", viewKey: key })).status, 404);
  const early = await post("points", { agentId: "19802", viewKey: key });
  assert.equal(early.status, 202);
  assert.equal(early.json.error, "not_scored_yet");
  const result = {
    week: 1,
    start: TIDE_START,
    end: TIDE_START + 604_800,
    at: TIDE_START + 3 * 86_400,
    final: false,
    pot: "5000000000000000000000000",
    totalPoints: "300000000",
    agents: [
      {
        agentId: "19802",
        identityVault: V1,
        breakdown: { points: "200000000" },
        share: "1000000000000000000000000",
        viewKey: key,
        pending: [{ viewKey: tideViewKey(secret(21)), missing: [`the identity vault ${V1} has no approval of this link's set digest`] }],
      },
      { agentId: "19900", identityVault: V2, breakdown: { points: "100000000" }, share: "500000000000000000000000" },
    ],
    tree: null,
  };
  await writeFile(join(root, "results", "week-1.json"), JSON.stringify(result));
  const r = await post("points", { agentId: "19802", viewKey: key.toUpperCase().replace("0X", "0x") });
  assert.equal(r.status, 200);
  assert.equal((r.json.agent as { agentId: string }).agentId, "19802");
  assert.equal(r.json.paid, null);
  assert.equal(JSON.stringify(r.json).includes("19900"), false, "another agent's figures are not answered");
  assert.equal("viewKey" in (r.json.agent as object) || "pending" in (r.json.agent as object), false, "the keys of the agent's links are not answered");
  // The stranger's links: one the score saw gets only what it lacks, the other nothing.
  const lacks = await post("points", { agentId: "19802", viewKey: tideViewKey(secret(21)) });
  assert.equal(lacks.status, 202);
  assert.deepEqual(lacks.json, { error: "not_verified", week: 1, at: TIDE_START + 3 * 86_400, missing: [`the identity vault ${V1} has no approval of this link's set digest`] });
  const none = await post("points", { agentId: "19802", viewKey: tideViewKey(secret(20)) });
  assert.equal(none.status, 202);
  assert.deepEqual(none.json, { error: "not_scored_yet", week: 1 });
  await writeFile(join(root, "results", "week-1.paid.json"), JSON.stringify({ root: `0x${"ab".repeat(32)}`, rootTx: null, paid: { "19802": { tx: `0x${"cd".repeat(32)}`, amount: "1", vault: V1 } } }));
  assert.equal(((await post("points", { agentId: "19802", viewKey: key })).json.paid as { amount: string }).amount, "1");
  const s = await (await fetch(`${base}/api/v1/tide/summary`)).json() as Record<string, unknown>;
  assert.equal(s.agents, 2);
  assert.equal(s.root, `0x${"ab".repeat(32)}`);
  assert.equal(JSON.stringify(s).includes("19802"), false);
  assert.equal((await post("points", { agentId: "19802", viewKey: "0x12" })).status, 400);
});
