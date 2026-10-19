// The uploader against the real Pinata API when OSTRA_PINATA_JWT_FILE names the key (the VPS; it pins two
// small files), and its refusals, which reach no pinning service, everywhere.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { MAX_IMAGE_BYTES, UPLOADS_PER_HOUR, Uploader, createUploaderServer, sniffImage } from "../src/server.ts";

const jwtFile = process.env.OSTRA_PINATA_JWT_FILE;
const jwt = jwtFile === undefined || jwtFile === "" ? "x".repeat(40) : readFileSync(jwtFile, "utf8").trim();
const uploader = new Uploader({ jwt, dailyBytes: 3_000_000 });
const server = createUploaderServer(uploader);
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

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
  ];
  for (const [p, status, code] of cases) {
    const res = await p;
    assert.equal(res.status, status);
    assert.equal(((await res.json()) as { error: string }).error, code);
  }
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
});
