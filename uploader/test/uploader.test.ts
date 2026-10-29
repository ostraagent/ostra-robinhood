// The uploader against the real Pinata API when OSTRA_PINATA_JWT_FILE names the key (the VPS; it pins two
// small files and an agent card, then serves them back from its store), and everywhere: its refusals and a card kept
// already, which reach no pinning service,
// and its reads, against local HTTP servers serving fixed bytes by path as a gateway serves /ipfs/<cid> (one that
// answers 429, one that serves other bytes, one that serves the file).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentCardSvg } from "../../sdk/src/agent-card.ts";
import { MAX_IMAGE_BYTES, SVG_POLICY, UPLOADS_PER_HOUR, Uploader, createUploaderServer, isSvg, rawCidDigest, rawCidOf, sniffImage } from "../src/server.ts";

const jwtFile = process.env.OSTRA_PINATA_JWT_FILE;
const jwt = jwtFile === undefined || jwtFile === "" ? "x".repeat(40) : readFileSync(jwtFile, "utf8").trim();
const store = mkdtempSync(join(tmpdir(), "ostra-uploader-store-"));
const uploader = new Uploader({ jwt, dailyBytes: 3_000_000, store });
const server = createUploaderServer(uploader);
let base = "";
const servers: Server[] = [server];

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
  rmSync(store, { recursive: true, force: true });
});

/** A local gateway answering /ipfs/<cid> with `files[cid]`, or `status` (with retry-after on 429) for anything else. */
async function gateway(files: Record<string, Uint8Array>, status = 404): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const s = createServer((req, res) => {
    hits++;
    const body = files[(req.url ?? "").replace(/^\/ipfs\//, "")];
    if (body === undefined) {
      res.writeHead(status, status === 429 ? { "retry-after": "900" } : {}).end("refused");
      return;
    }
    res.writeHead(200).end(Buffer.from(body));
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/ipfs/`, hits: () => hits };
}

// A 1x1 PNG.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const post = (path: string, body: string | Uint8Array, type: string, from = "203.0.113.7") => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": type, "x-forwarded-for": from }, body });

test("images are recognised by their first bytes", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("<svg></svg>")), null);
});

test("refusals: not an image, a mislabelled image, too large, not JSON, not an object, unknown routes", async () => {
  const cases: [Promise<Response>, number, string][] = [
    [post("/v1/ipfs/image", Buffer.from("<svg onload=x></svg>"), "image/svg+xml"), 415, "not_an_image"],
    [post("/v1/ipfs/image", PNG, "image/jpeg"), 415, "not_an_image"],
    [post("/v1/ipfs/image", new Uint8Array(MAX_IMAGE_BYTES + 1), "image/png"), 413, "too_large"],
    [post("/v1/ipfs/json", "{", "application/json"), 400, "invalid_json"],
    [post("/v1/ipfs/json", "[1]", "application/json"), 400, "not_an_object"],
    [post("/v1/ipfs/json", "{}", "text/plain"), 415, "unsupported_media_type"],
    [fetch(`${base}/v1/ipfs/other`), 404, "not_found"],
    [post("/v1/ipfs/agent-card", JSON.stringify({ agentId: "12a" }), "application/json"), 400, "bad_agent_id"],
    [post("/v1/ipfs/agent-card", JSON.stringify({ agentId: 20074 }), "application/json"), 400, "bad_agent_id"],
    [post("/v1/ipfs/agent-card", JSON.stringify({}), "application/json"), 400, "bad_agent_id"],
    [post("/v1/ipfs/agent-card", "{", "application/json"), 400, "invalid_json"],
    [post("/v1/ipfs/agent-card", JSON.stringify({ agentId: "1" }), "text/plain"), 415, "unsupported_media_type"],
  ];
  for (const [p, status, code] of cases) {
    const res = await p;
    assert.equal(res.status, status);
    assert.equal(((await res.json()) as { error: string }).error, code);
  }
});

test("the web app's origin gets CORS and its preflight 204; other sites none", async () => {
  const app = "https://app.ostraagent.xyz";
  const pre = await fetch(`${base}/v1/ipfs/image`, { method: "OPTIONS", headers: { origin: app, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), app);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Content-Type/);
  // A refusal (not an image) still carries the header, so the page can read why.
  const refused = await fetch(`${base}/v1/ipfs/image`, { method: "POST", headers: { origin: app, "content-type": "image/png", "x-forwarded-for": "203.0.113.9" }, body: "not an image" });
  assert.equal(refused.status, 415);
  assert.equal(refused.headers.get("access-control-allow-origin"), app);
  await refused.arrayBuffer();
  const other = await fetch(`${base}/v1/ipfs/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  await other.arrayBuffer();
});

test("an agent card kept already is answered without pinning, and served as SVG under a policy that runs nothing", async () => {
  // The JWT here may be a stand-in: a pin would fail, so a 200 shows nothing was pinned.
  const bytes = new TextEncoder().encode(agentCardSvg("424242"));
  const cid = rawCidOf(bytes);
  assert.ok(uploader.keep(cid, bytes));
  const before = uploader.health().bytesUsed;
  const res = await post("/v1/ipfs/agent-card", JSON.stringify({ agentId: "424242" }), "application/json");
  const body = (await res.json()) as { cid: string; uri: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { cid, uri: `ipfs://${cid}` });
  assert.equal(uploader.health().bytesUsed, before, "nothing counted against the day's budget");
  const served = await fetch(`${base}/v1/ipfs/${cid}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/svg+xml");
  assert.equal(served.headers.get("content-security-policy"), SVG_POLICY);
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), bytes);
  assert.ok(isSvg(bytes) && !isSvg(PNG));
});

test("raw CIDs: the CID of bytes names their sha2-256, as Ostrapad's files are named", () => {
  // The order file of Ostrapad's first job on mainnet (28 Oct 2026): its CID and the sha256 its job holds.
  assert.equal(rawCidDigest("bafkreidxxejh4koxoc7emwu2nghvcxzylh6w7fzkailj5k5ewvixzczhi4")?.toString("hex"), "77b9127e29d770be465a9a698f515f3859fd6f972a02169eaba4b5517c8b2747");
  const bytes = new TextEncoder().encode(JSON.stringify({ name: "x" }));
  assert.equal(rawCidDigest(rawCidOf(bytes))?.toString("hex"), createHash("sha256").update(bytes).digest("hex"));
  for (const other of ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", "bafkrei", "bafkreidxxejh4koxoc7emwu2nghvcxzylh6w7fzkailj5k5ewvixzczhi4x"]) assert.equal(rawCidDigest(other), null, other);
});

test("reads: a refusing gateway and one serving other bytes are passed over; the file is kept and served again from the store", async () => {
  const file = new TextEncoder().encode(JSON.stringify({ name: "kept" }));
  const cid = rawCidOf(file);
  const refusing = await gateway({}, 429);
  const wrong = await gateway({ [cid]: new TextEncoder().encode("other") });
  const right = await gateway({ [cid]: file });
  const dir = mkdtempSync(join(tmpdir(), "ostra-uploader-read-"));
  try {
    const u = new Uploader({ jwt: "z".repeat(40), dailyBytes: 1_000, store: dir, upstream: [refusing.url, wrong.url, right.url] });
    const s = createUploaderServer(u);
    servers.push(s);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/ipfs/`;
    const first = await fetch(`${at}${cid}`);
    assert.equal(first.status, 200);
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), file);
    assert.equal(first.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.ok(existsSync(join(dir, cid)), "kept");
    assert.deepEqual([refusing.hits(), wrong.hits(), right.hits()], [1, 1, 1]);
    const again = await fetch(`${at}${cid}`);
    assert.deepEqual(new Uint8Array(await again.arrayBuffer()), file);
    assert.deepEqual([refusing.hits(), wrong.hits(), right.hits()], [1, 1, 1], "served from the store");
    // A file changed on disk is not served.
    writeFileSync(join(dir, cid), "changed");
    const changed = await fetch(`${at}${cid}`);
    assert.deepEqual(new Uint8Array(await changed.arrayBuffer()), file);
    assert.equal(right.hits(), 2, "read again from upstream");
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, cid))), file, "and written again");
    // A caller through nginx (X-Forwarded-For) gets what is kept, never a read upstream.
    const viaNginx = { headers: { "x-forwarded-for": "203.0.113.20" } };
    const head = await fetch(`${at}${cid}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(file.length));
    const keptViaNginx = await fetch(`${at}${cid}`, viaNginx);
    assert.equal(keptViaNginx.status, 200);
    assert.deepEqual(new Uint8Array(await keptViaNginx.arrayBuffer()), file);
    const other = new TextEncoder().encode(JSON.stringify({ name: "not kept" }));
    const otherCid = rawCidOf(other);
    const hitsBefore = [refusing.hits(), wrong.hits(), right.hits()];
    const notKept = await fetch(`${at}${otherCid}`, viaNginx);
    assert.equal(notKept.status, 404);
    await notKept.arrayBuffer();
    assert.deepEqual([refusing.hits(), wrong.hits(), right.hits()], hitsBefore, "no gateway asked for a caller through nginx");
    assert.equal(existsSync(join(dir, otherCid)), false);
    // The same digest spelled with other padding bits in the last letter is not a CID served here.
    const last = cid.at(-1) as string;
    const B32 = "abcdefghijklmnopqrstuvwxyz234567";
    const respelled = cid.slice(0, -1) + B32[(B32.indexOf(last) & ~3) | ((B32.indexOf(last) + 1) & 3)];
    assert.equal(rawCidDigest(respelled), null, respelled);
    const odd = await fetch(`${at}${respelled}`);
    assert.equal(odd.status, 404);
    await odd.arrayBuffer();
    // Not kept and no gateway has it: 404. Not a raw CID: 404.
    const none = await fetch(`${at}${rawCidOf(new TextEncoder().encode("nowhere"))}`);
    assert.equal(none.status, 404);
    assert.equal(((await none.json()) as { error: string }).error, "not_found");
    const notRaw = await fetch(`${at}bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`);
    assert.equal(notRaw.status, 404);
    await notRaw.arrayBuffer();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads: every gateway refusing (429) answers 503 with retry-after, and the gateway is left alone until then", async () => {
  const refusing = await gateway({}, 429);
  const u = new Uploader({ jwt: "z".repeat(40), dailyBytes: 1_000, store: null, upstream: [refusing.url] });
  const cid = rawCidOf(new TextEncoder().encode("refused"));
  const a = await u.file(cid);
  assert.ok("refused" in a && a.retryAfterSeconds === 900, JSON.stringify(a));
  const b = await u.file(cid);
  assert.ok("refused" in b, JSON.stringify(b));
  assert.equal(refusing.hits(), 1, "not asked again before its retry-after");
  const s = createUploaderServer(u);
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/ipfs/${cid}`);
  assert.equal(res.status, 503);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  assert.equal(((await res.json()) as { error: string }).error, "upstream_refused");
});

test("one address may upload UPLOADS_PER_HOUR times an hour", () => {
  const u = new Uploader({ jwt: "y".repeat(40), dailyBytes: 1_000_000 });
  for (let i = 0; i < UPLOADS_PER_HOUR; i++) u.admit("198.51.100.1", 10);
  assert.throws(() => u.admit("198.51.100.1", 10), /uploads an hour/);
  u.admit("198.51.100.2", 10);
  assert.throws(() => u.admit("198.51.100.3", 1_000_000), /budget/);
});

test("pins an image and a JSON object on IPFS through Pinata", { skip: jwtFile === undefined || jwtFile === "" ? "OSTRA_PINATA_JWT_FILE is not set" : false }, async () => {
  const img = await post("/v1/ipfs/image", PNG, "image/png", "203.0.113.9");
  const imgBody = (await img.json()) as { cid: string; uri: string };
  assert.equal(img.status, 200, JSON.stringify(imgBody));
  assert.match(imgBody.uri, /^ipfs:\/\/[A-Za-z0-9]+$/);
  const meta = await post("/v1/ipfs/json", JSON.stringify({ name: "Ostra uploader test", image: imgBody.uri }), "application/json", "203.0.113.9");
  const metaBody = (await meta.json()) as { cid: string; uri: string };
  assert.equal(meta.status, 200, JSON.stringify(metaBody));
  assert.equal(metaBody.uri, `ipfs://${metaBody.cid}`);
  assert.ok(uploader.health().bytesUsed > 0);
  // An agent card: Pinata's CID is the raw CID of the card's bytes, so the URI names Ostra's card of that agent.
  for (const id of [null, "20074"]) {
    const card = await post("/v1/ipfs/agent-card", JSON.stringify({ agentId: id }), "application/json", "203.0.113.9");
    const cardBody = (await card.json()) as { cid: string; uri: string };
    assert.equal(card.status, 200, JSON.stringify(cardBody));
    assert.equal(cardBody.cid, rawCidOf(new TextEncoder().encode(agentCardSvg(id))));
    assert.ok(existsSync(join(store, cardBody.cid)), `card ${cardBody.cid} kept`);
  }
  // Both are kept as Pinata pinned them (the CID names the bytes kept) and served from the store.
  for (const [cid, bytes] of [[imgBody.cid, PNG], [metaBody.cid, new TextEncoder().encode(JSON.stringify({ name: "Ostra uploader test", image: imgBody.uri }))]] as const) {
    assert.ok(existsSync(join(store, cid)), `${cid} kept`);
    const res = await fetch(`${base}/v1/ipfs/${cid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array(bytes));
  }
});
