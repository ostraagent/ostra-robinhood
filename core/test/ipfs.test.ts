// Reading ipfs:// files through gateways in order (src/ipfs.ts): a gateway that refuses (429, as ipfs.io answers a
// server) or serves other bytes than a raw CID names is passed over, sizes are capped. The gateways here are local
// HTTP servers serving fixed bytes by path, as a gateway serves /ipfs/<cid>; the live test at the end reads the
// registration file the Ostrapad check pinned on mainnet IPFS on 28 Oct 2026 (OSTRA_IPFS_LIVE=1: a network that can
// reach the gateways).

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { sha256 } from "viem";
import { padCidFromDigest } from "@ostraagent/sdk";
import { IPFS_GATEWAYS, ipfsBytes, ipfsGateways, readIpfsJson } from "../src/index.ts";

const FILE = new TextEncoder().encode(JSON.stringify({ name: "Fixture" }));
const CID = padCidFromDigest(sha256(FILE)).slice("ipfs://".length);
const OTHER = new TextEncoder().encode(JSON.stringify({ name: "Other" }));

type Gateway = { url: string; server: Server; hits: number };
const servers: Gateway[] = [];

/** A local gateway answering /ipfs/<path> with `files[path]`, or `status` for anything else. */
async function gateway(files: Record<string, Uint8Array>, status = 404): Promise<Gateway> {
  const g: Gateway = { url: "", server: createServer(), hits: 0 };
  g.server.on("request", (req, res) => {
    g.hits++;
    const body = files[(req.url ?? "").replace(/^\/ipfs\//, "")];
    if (body === undefined) {
      res.writeHead(status, status === 429 ? { "retry-after": "900" } : {}).end("refused");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(body));
  });
  await new Promise<void>((resolve) => g.server.listen(0, "127.0.0.1", resolve));
  const a = g.server.address() as { port: number };
  g.url = `http://127.0.0.1:${a.port}/ipfs/`;
  servers.push(g);
  return g;
}

after(async () => {
  for (const g of servers) await new Promise((resolve) => g.server.close(resolve));
});

test("the default gateways: Pinata's first, then ipfs.io; OSTRA_IPFS_GATEWAYS replaces them", () => {
  assert.deepEqual(IPFS_GATEWAYS, ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"]);
  assert.deepEqual(ipfsGateways({}), IPFS_GATEWAYS);
  assert.deepEqual(ipfsGateways({ OSTRA_IPFS_GATEWAYS: " https://a.example/ipfs/ , http://127.0.0.1:8080/ipfs/ " }), ["https://a.example/ipfs/", "http://127.0.0.1:8080/ipfs/"]);
  for (const bad of ["ftp://a/", "https://a.example/ipfs", ","]) assert.throws(() => ipfsGateways({ OSTRA_IPFS_GATEWAYS: bad }), /OSTRA_IPFS_GATEWAYS/, bad);
});

test("a refusing gateway and one serving other bytes are passed over; the first right one answers", async () => {
  const refusing = await gateway({}, 429);
  const wrong = await gateway({ [CID]: OTHER });
  const right = await gateway({ [CID]: FILE });
  const got = await ipfsBytes(`ipfs://${CID}`, 65_536, { gateways: [refusing.url, wrong.url, right.url] });
  assert.deepEqual(got, FILE);
  assert.equal(refusing.hits, 1);
  assert.equal(wrong.hits, 1);
  assert.equal(right.hits, 1);
  assert.equal(await ipfsBytes(`ipfs://${CID}`, 65_536, { gateways: [refusing.url, wrong.url] }), null, "no gateway serves the CID's bytes");
  assert.deepEqual(await ipfsBytes(`ipfs://ipfs/${CID}`, 65_536, { gateways: [right.url] }), FILE, "ipfs://ipfs/<cid> too");
});

test("a file over the cap is refused; a path under a CID is taken as served; other URIs are not read", async () => {
  const right = await gateway({ [CID]: FILE, "bafybeigdir/a.json": OTHER });
  assert.equal(await ipfsBytes(`ipfs://${CID}`, FILE.length - 1, { gateways: [right.url] }), null);
  assert.deepEqual(await ipfsBytes(`ipfs://${CID}`, FILE.length, { gateways: [right.url] }), FILE);
  assert.deepEqual(await ipfsBytes("ipfs://bafybeigdir/a.json", 65_536, { gateways: [right.url] }), OTHER);
  const before = right.hits;
  for (const uri of ["https://example.com/a.json", "ipfs://../etc", "ipfs://", `ipfs://${CID}?x=1`, `ipfs://${CID}/../../ipns/x`, `ipfs://${CID}/./a`, `ipfs://${CID}/..`]) assert.equal(await ipfsBytes(uri, 65_536, { gateways: [right.url] }), null, uri);
  assert.equal(right.hits, before, "nothing is fetched for a URI that is not ipfs://<cid>[/path]");
});

test("live: the Ostrapad check's registration file through the default gateways", { skip: process.env.OSTRA_IPFS_LIVE !== "1" ? "OSTRA_IPFS_LIVE=1 reads mainnet IPFS" : false, timeout: 120_000 }, async () => {
  const uri = "ipfs://bafkreic3b5nwrx6tukviupgrnbmsj5mk2azvizsuj2a7kau67ld7tffu4e";
  const bytes = await ipfsBytes(uri, 65_536);
  assert.ok(bytes !== null, "the file is read");
  assert.equal(sha256(bytes), "0x5b0f5b68dfd3a2aa8a3cd1685924f58ad0335466544e81f5029efac7f994b4e1");
  const file = (await readIpfsJson(uri)) as { name?: string } | null;
  assert.equal(file?.name, "Ostrapad check");
  // ipfs.io first (it answers 429 to a server), then Pinata's: still read.
  assert.ok((await ipfsBytes(uri, 65_536, { gateways: [...IPFS_GATEWAYS].reverse() })) !== null, "read with ipfs.io tried first");
});
