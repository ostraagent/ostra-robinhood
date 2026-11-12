// Ostra Cloud's egress (src/egress.ts), the pay tool through it (public-fetch.ts proxiedFetch) and the front
// (src/front.ts), over real sockets and real TLS (a certificate authority made with openssl for the test): CONNECT to
// port 443 only, hosts that are not public refused at the egress with the reason pay reports, TLS checked end to end
// through the tunnel, plain HTTP and other ports refused, the egress's limits (tunnels, one tunnel's bytes, a client
// gone before its tunnel frees its place), the production rule on IP literals, headers HTTP does not take, an answer
// too large cut, and the front passing bytes both ways.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect, createServer as createTcpServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PayRefusedError } from "@ostraagent/core";
import { connectTarget, startEgress } from "../src/egress.ts";
import { startFront } from "../src/front.ts";
import { EGRESS_REFUSED_HEADER, proxiedFetch } from "../src/public-fetch.ts";

let dir: string;
let ca: string;
let seller: HttpsServer;
let sellerPort: number;
const servers: Server[] = [];

/** A CA and a certificate for pay.test signed by it (openssl). */
function certificates(d: string): { ca: string; key: string; cert: string } {
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: d, stdio: "pipe" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Ostra test CA"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "pay.key", "-out", "pay.csr", "-subj", "/CN=pay.test"]);
  writeFileSync(join(d, "ext.cnf"), "subjectAltName=DNS:pay.test\n");
  run(["x509", "-req", "-in", "pay.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "pay.pem", "-days", "2", "-extfile", "ext.cnf"]);
  return { ca: readFileSync(join(d, "ca.pem"), "utf8"), key: readFileSync(join(d, "pay.key"), "utf8"), cert: readFileSync(join(d, "pay.pem"), "utf8") };
}

/** An egress in front of the seller: pay.test and wrong.test are the seller (127.0.0.1); private.test is not public. */
async function egress(o: { maxTunnels?: number; tunnelsPerMinute?: number; tunnelBytesPerMinute?: number; upstreamPort?: number } = {}): Promise<string> {
  const s = await startEgress({
    host: "127.0.0.1",
    port: 0,
    maxTunnels: o.maxTunnels ?? 64,
    tunnelsPerMinute: o.tunnelsPerMinute ?? 1000,
    bytesPerMinute: 1 << 30,
    tunnelBytesPerMinute: o.tunnelBytesPerMinute ?? 1 << 30,
    upstreamPort: o.upstreamPort ?? sellerPort,
    resolve: async (host) => {
      if (host === "slow.test") {
        await new Promise((r) => setTimeout(r, 600));
        return [{ address: "127.0.0.1", family: 4 }];
      }
      if (host === "pay.test" || host === "wrong.test") return [{ address: "127.0.0.1", family: 4 }];
      if (host === "private.test") return [{ address: "10.1.2.3", family: 4 }];
      if (host === "mixed.test") return [{ address: "127.0.0.1", family: 4 }, { address: "169.254.169.254", family: 4 }];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    },
    // Only for this test, the seller's loopback address counts as public.
    allow: (a) => a === "127.0.0.1",
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ostra-egress-"));
  const c = certificates(dir);
  ca = c.ca;
  seller = createHttpsServer({ key: c.key, cert: c.cert }, (req, res) => {
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(9 * 1024 * 1024, 7));
      return;
    }
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      res.writeHead(402, [["content-type", "application/json"], ["payment-required", "abc"], ["set-cookie", "a=1"], ["set-cookie", "b=2"]]);
      res.end(JSON.stringify({ method: req.method, path: req.url, host: req.headers.host, body, encoding: req.headers["accept-encoding"] ?? null }));
    });
  });
  await new Promise<void>((r) => seller.listen(0, "127.0.0.1", () => r()));
  sellerPort = (seller.address() as AddressInfo).port;
});

after(() => {
  for (const s of servers) s.close();
  seller.closeAllConnections();
  seller.close();
  rmSync(dir, { recursive: true, force: true });
});

test("CONNECT targets: port 443 only, host names and IP literals, never this machine", () => {
  assert.deepEqual(connectTarget("pay.test:443"), { host: "pay.test" });
  assert.deepEqual(connectTarget("[2606:4700::1]:443"), { host: "2606:4700::1" });
  assert.deepEqual(connectTarget("8.8.8.8:443"), { host: "8.8.8.8" });
  assert.match((connectTarget("pay.test:80") as { refused: string }).refused, /port 80 is closed/);
  assert.match((connectTarget("pay.test:8443") as { refused: string }).refused, /port 8443/);
  assert.match((connectTarget("localhost:443") as { refused: string }).refused, /this machine/);
  assert.match((connectTarget("api.localhost.:443") as { refused: string }).refused, /this machine/);
  for (const bad of ["", "pay.test", "pay test:443", "[pay.test]:443", "a_b.test:443", `${"a".repeat(300)}:443`, "user@pay.test:443"]) assert.ok("refused" in connectTarget(bad), bad);
});

test("pay through the egress: the seller answers through a TLS tunnel checked end to end; hosts that are not public are refused at the egress", async () => {
  const proxy = await egress();
  const send = proxiedFetch(proxy, ca);
  const res = await send("https://pay.test/paid?x=1", { method: "POST", headers: { "x-test": "1", Host: "evil.test", "Accept-Encoding": "gzip" }, body: "{\"q\":1}" });
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("payment-required"), "abc");
  assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.deepEqual(await res.json(), { method: "POST", path: "/paid?x=1", host: "pay.test", body: "{\"q\":1}", encoding: null });

  // Refused at the egress, its reason told as pay's refusal: a host that resolves to a private or metadata address.
  for (const [url, why] of [
    ["https://private.test/", /private\.test: the host is not a public address/],
    ["https://mixed.test/", /mixed\.test: the host is not a public address/],
  ] as const) {
    await assert.rejects(send(url, { method: "GET" }), (e: Error) => e instanceof PayRefusedError && why.test(e.message));
  }
  // A name that cannot be resolved: an error, not a refusal of the request.
  await assert.rejects(send("https://missing.test/", { method: "GET" }), (e: Error) => !(e instanceof PayRefusedError) && /502/.test(e.message));
  // Refused here before anything is sent: plain HTTP, another port, this machine, a private IP literal, credentials.
  for (const [url, why] of [
    ["http://pay.test/", /https requests only/],
    ["https://pay.test:8443/", /port 443 only/],
    ["https://localhost/", /this machine/],
    ["https://10.0.0.1/", /not a public address/],
    ["https://[::1]/", /not a public address/],
    ["https://169.254.169.254/latest/meta-data/", /not a public address/],
    ["https://u:p@pay.test/", /no credentials/],
  ] as const) {
    await assert.rejects(send(url, { method: "GET" }), (e: Error) => e instanceof PayRefusedError && why.test(e.message), url);
  }
  // TLS is checked through the tunnel: a host whose certificate is not its own (wrong.test is the seller, whose
  // certificate names pay.test), and a certificate authority the client does not trust.
  await assert.rejects(send("https://wrong.test/", { method: "GET" }), /altnames|does not match|Hostname/i);
  await assert.rejects(proxiedFetch(proxy)("https://pay.test/", { method: "GET" }), /self[- ]signed|unable to (get|verify)|certificate/i);
});

test("pay through the egress: a header HTTP does not take is refused before anything is sent, an answer too large is cut, and neither keeps a tunnel", async () => {
  const proxy = await egress({ maxTunnels: 1 });
  const send = proxiedFetch(proxy, ca);
  await assert.rejects(send("https://pay.test/", { method: "GET", headers: { "x-a": "a\x01b" } }), (e: Error) => e instanceof PayRefusedError && /not one HTTP sends/.test(e.message));
  const big = await send("https://pay.test/big", { method: "GET" });
  assert.equal(big.status, 200);
  await assert.rejects(big.text(), /larger than/);
  await new Promise((r) => setTimeout(r, 200));
  // The one tunnel the egress takes is free again: a request goes through.
  assert.equal((await send("https://pay.test/ok", { method: "GET" })).status, 402);
});

test("the egress's own rule on IP literals: loopback, private, mapped and metadata addresses refused, never connected to", async () => {
  const s = await startEgress({ host: "127.0.0.1", port: 0, maxTunnels: 8, tunnelsPerMinute: 100, bytesPerMinute: 1 << 20, tunnelBytesPerMinute: 1 << 20 });
  servers.push(s);
  const port = (s.address() as AddressInfo).port;
  for (const target of ["127.0.0.1:443", "10.0.0.1:443", "[::1]:443", "[::ffff:127.0.0.1]:443", "169.254.169.254:443", "127.0.0.11:443", "[fd00::1]:443"]) {
    const answer = await new Promise<string>((resolve, reject) => {
      const c = connect(port, "127.0.0.1");
      let out = "";
      c.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("\r\n\r\n")) {
          c.destroy();
          resolve(out);
        }
      });
      c.on("error", reject);
      c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    assert.match(answer, /^HTTP\/1\.1 403[\s\S]*not a public address/, target);
  }
});

test("the egress's limits on one client: gone before its tunnel is up, its place is freed at once; one tunnel's bytes a minute are throttled", async () => {
  const proxy = new URL(await egress({ maxTunnels: 1 }));
  // A client that asks for a slow host and leaves before it resolves: the next one gets the one tunnel.
  const leaving = connect(Number(proxy.port), "127.0.0.1");
  leaving.write("CONNECT slow.test:443 HTTP/1.1\r\nHost: slow.test:443\r\n\r\n");
  await new Promise((r) => setTimeout(r, 100));
  leaving.destroy();
  await new Promise((r) => setTimeout(r, 100));
  const next = await new Promise<string>((resolve, reject) => {
    const c = connect(Number(proxy.port), "127.0.0.1");
    let out = "";
    c.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("\r\n\r\n")) {
        c.destroy();
        resolve(out);
      }
    });
    c.on("error", reject);
    c.write("CONNECT pay.test:443 HTTP/1.1\r\nHost: pay.test:443\r\n\r\n");
  });
  assert.match(next, /^HTTP\/1\.1 200/);

  // One tunnel at most 2,000 bytes a minute: an upstream sending 5,000 in small pieces gets about that far, then waits.
  const source = createTcpServer((sock) => {
    let n = 0;
    const t = setInterval(() => {
      if (sock.destroyed || n >= 10) return clearInterval(t);
      sock.write(Buffer.alloc(500, 1));
      n++;
    }, 20);
    sock.on("error", () => {});
    sock.on("close", () => clearInterval(t));
  });
  await new Promise<void>((r) => source.listen(0, "127.0.0.1", () => r()));
  servers.push(source);
  const throttled = new URL(await egress({ tunnelBytesPerMinute: 2000, upstreamPort: (source.address() as AddressInfo).port }));
  const got = await new Promise<number>((resolve, reject) => {
    const c = connect(Number(throttled.port), "127.0.0.1");
    let head = "";
    let bytes = 0;
    let open = false;
    c.on("data", (d: Buffer) => {
      if (open) bytes += d.length;
      else {
        head += d.toString("latin1");
        const i = head.indexOf("\r\n\r\n");
        if (i >= 0) {
          open = true;
          bytes += Buffer.byteLength(head.slice(i + 4), "latin1");
        }
      }
    });
    c.on("error", reject);
    c.write("CONNECT pay.test:443 HTTP/1.1\r\nHost: pay.test:443\r\n\r\n");
    setTimeout(() => {
      c.destroy();
      resolve(bytes);
    }, 800);
  });
  assert.ok(got >= 2000 && got < 5000, `the tunnel carried ${got} bytes in 0.8 s`);
});

test("the egress itself: plain HTTP and other ports refused with the reason; at most so many tunnels at once and a minute", async () => {
  const proxy = new URL(await egress({ maxTunnels: 1, tunnelsPerMinute: 3 }));
  /** The egress's answer to `lines` on a new connection (its head only), the connection then closed. */
  const raw = (lines: string) =>
    new Promise<string>((resolve, reject) => {
      const s = connect(Number(proxy.port), "127.0.0.1");
      let out = "";
      const done = () => {
        s.destroy();
        resolve(out);
      };
      s.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("\r\n\r\n")) done();
      });
      s.on("close", done);
      s.on("error", reject);
      s.write(lines);
    });
  const settle = () => new Promise((r) => setTimeout(r, 100));
  const plain = await new Promise<{ status: number; why: unknown }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: Number(proxy.port), path: "http://pay.test/", method: "GET" }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, why: res.headers[EGRESS_REFUSED_HEADER] });
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(plain.status, 403);
  assert.match(String(plain.why), /plain HTTP/);
  assert.match(await raw("CONNECT pay.test:22 HTTP/1.1\r\nHost: pay.test:22\r\n\r\n"), /403[\s\S]*port 22 is closed/);
  const tunnel = "CONNECT pay.test:443 HTTP/1.1\r\nHost: pay.test:443\r\n\r\n";
  // One tunnel at once: the first is open (and counted), a second is refused while it lasts (not counted).
  const held = connect(Number(proxy.port), "127.0.0.1");
  await new Promise<void>((resolve) => {
    let got = "";
    held.on("data", (d: Buffer) => {
      got += d.toString();
      if (got.includes("200 Connection Established")) resolve();
    });
    held.write(tunnel);
  });
  assert.match(await raw(tunnel), /^HTTP\/1\.1 429[\s\S]*busy/);
  held.destroy();
  await settle();
  // Three a minute: two more open, then the minute is spent.
  assert.match(await raw(tunnel), /^HTTP\/1\.1 200/);
  await settle();
  assert.match(await raw(tunnel), /^HTTP\/1\.1 200/);
  await settle();
  assert.match(await raw(tunnel), /^HTTP\/1\.1 429/);
});

test("the front passes bytes both ways, untouched, to its target", async () => {
  const target = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${req.method} ${req.url} ${req.headers.host}`);
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  servers.push(target as unknown as Server);
  const front = await startFront({ listen: { host: "127.0.0.1", port: 0 }, target: { host: "127.0.0.1", port: (target.address() as AddressInfo).port }, max: 8 });
  servers.push(front);
  const port = (front.address() as AddressInfo).port;
  const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp?x=1", method: "POST", headers: { host: "cloud.example", "content-type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end("{}");
  });
  assert.deepEqual(answer, { status: 200, text: "POST /mcp?x=1 cloud.example" });
});
