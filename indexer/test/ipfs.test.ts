// Reading IPFS files through gateways (src/ipfs.ts): raw CIDs checked against the bytes, gateways tried in order,
// sizes capped, images kept only when their first bytes are an image. The gateways here are local HTTP servers
// serving fixed bytes by path, as a gateway serves /ipfs/<cid>; the live test at the end reads a token's real
// metadata and image from mainnet IPFS (OSTRA_IPFS_LIVE=1: a network that can reach the gateways).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { IPFS_GATEWAYS, ImageStore, IpfsReader, imageCid, parseIpfsUri, rawCidOf, rawSha256Digest } from "../src/ipfs.ts";

/** A 1x1 PNG (a fixture: the smallest image the uploader takes). */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
const JSON_BYTES = new TextEncoder().encode(JSON.stringify({ name: "Fixture", image: `ipfs://${rawCidOf(PNG)}` }));

type Gateway = { url: string; server: Server; hits: string[] };
let dir: string;
const gateways: Gateway[] = [];

/** A local gateway answering /ipfs/<path> with `files[path]`, or `status` for anything else. */
async function gateway(files: Record<string, Uint8Array>, status = 404): Promise<Gateway> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/^\/ipfs\//, "");
    hits.push(path);
    const body = files[path];
    if (body === undefined) {
      res.writeHead(status, { "content-type": "text/plain" });
      return void res.end("no");
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const g = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/ipfs/`, server, hits };
  gateways.push(g);
  return g;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ostra-ipfs-"));
});

after(async () => {
  for (const g of gateways) await new Promise<void>((r) => g.server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

test("raw CIDs: the well-known CID of no bytes, round trips, other CIDs not checked", () => {
  // The raw CIDv1 of zero bytes (sha2-256 e3b0c442...), as every IPFS implementation computes it.
  assert.equal(rawCidOf(new Uint8Array()), "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
  assert.equal(Buffer.from(rawSha256Digest("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku") ?? []).toString("hex"), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  // Ostra token P's metadata and image (mainnet, 23 Oct 2026): raw CIDs, so their bytes are checked.
  assert.ok(rawSha256Digest("bafkreibtzfkodmlca65podpd7fctlbx6h2wwyktgu2utz63so3j6a2qcea") !== null);
  assert.ok(rawSha256Digest("bafkreidrhbpi3soa7nkc2fhvegtv3hjh63wsjlucnsgls6wmxun7ppszri") !== null);
  // dag-pb (bafybei...) and CIDv0 (Qm...) are not raw.
  assert.equal(rawSha256Digest("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"), null);
  assert.equal(rawSha256Digest("QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o"), null);
  assert.deepEqual(parseIpfsUri("ipfs://ipfs/bafkx/a/b.png"), { cid: "bafkx", path: "a/b.png" });
  assert.equal(parseIpfsUri("ipfs://bad cid"), null);
  assert.equal(parseIpfsUri("ipfs://bafy/../../ipns/x"), null);
  assert.equal(parseIpfsUri("ipfs://bafy/./a"), null);
  assert.equal(parseIpfsUri("https://example.org/a.png"), null);
  assert.equal(imageCid("ipfs://bafkx"), "bafkx");
  assert.equal(imageCid("ipfs://bafkx/a.png"), null);
  assert.deepEqual(IPFS_GATEWAYS, ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"]);
});

test("gateways in order: a refusal or bytes that are not the CID's go to the next", async () => {
  const cid = rawCidOf(JSON_BYTES);
  const refusing = await gateway({}, 429);
  const lying = await gateway({ [cid]: new TextEncoder().encode('{"name":"Not the file"}') });
  const honest = await gateway({ [cid]: JSON_BYTES });
  const reader = new IpfsReader({ gateways: [refusing.url, lying.url, honest.url] });
  assert.deepEqual(await reader.json(`ipfs://${cid}`), JSON.parse(new TextDecoder().decode(JSON_BYTES)));
  assert.deepEqual([refusing.hits, lying.hits, honest.hits], [[cid], [cid], [cid]]);
  // None returns it: null.
  assert.equal(await new IpfsReader({ gateways: [refusing.url, lying.url] }).json(`ipfs://${cid}`), null);
  // Not JSON, too large, not ipfs://: null.
  const big = new Uint8Array(70_000).fill(0x20);
  const odd = await gateway({ [rawCidOf(PNG)]: PNG, [rawCidOf(big)]: big });
  assert.equal(await new IpfsReader({ gateways: [odd.url] }).json(`ipfs://${rawCidOf(PNG)}`), null);
  assert.equal(await new IpfsReader({ gateways: [odd.url] }).json(`ipfs://${rawCidOf(big)}`), null);
  assert.equal(await reader.json("https://example.org/meta.json"), null);
  assert.throws(() => new IpfsReader({ gateways: ["https://no-slash.example/ipfs"] }), /ending in \//);
});

test("images: kept once, by CID, only when the bytes are the CID's and an image", async () => {
  const png = rawCidOf(PNG);
  const notImage = rawCidOf(JSON_BYTES);
  const g = await gateway({ [png]: PNG, [notImage]: JSON_BYTES });
  const store = new ImageStore(join(dir, "images"), new IpfsReader({ gateways: [g.url] }));
  assert.equal(store.get(png), null);
  assert.equal(await store.ensure(png), true);
  assert.equal(await store.ensure(png), true);
  assert.deepEqual(g.hits.filter((h) => h === png), [png], "fetched once");
  const kept = store.get(png);
  assert.equal(kept?.type, "image/png");
  assert.deepEqual(kept?.bytes, PNG);
  assert.equal(await store.ensure(notImage), false);
  assert.equal(store.has(notImage), false);
  assert.equal(await store.ensure("../etc"), false);
  assert.equal(store.get("../etc"), null);
});

test("live: token P's metadata and image through the default gateways", { skip: process.env.OSTRA_IPFS_LIVE !== "1" ? "OSTRA_IPFS_LIVE=1 reads mainnet IPFS" : false, timeout: 120_000 }, async () => {
  const reader = new IpfsReader();
  const meta = (await reader.json("ipfs://bafkreibtzfkodmlca65podpd7fctlbx6h2wwyktgu2utz63so3j6a2qcea")) as Record<string, unknown> | null;
  assert.ok(meta !== null, "the metadata of token P is read");
  assert.equal(meta.symbol, "P");
  assert.equal(meta.token, "eip155:4663:0x247328c5b99b8B7Cf76eA304aA0Fd00177ff98B7");
  const cid = imageCid(meta.image);
  assert.equal(cid, "bafkreidrhbpi3soa7nkc2fhvegtv3hjh63wsjlucnsgls6wmxun7ppszri");
  const store = new ImageStore(join(dir, "live"), reader);
  assert.equal(await store.ensure(cid), true);
  assert.equal(store.get(cid)?.type, "image/png");
});
