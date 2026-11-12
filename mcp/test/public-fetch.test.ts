// The pay tool's HTTP client (src/public-fetch.ts): model-chosen URLs reach public hosts only, the connection goes to
// the address checked, and answers come back as fetch's would (redirects not followed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { PayRefusedError } from "@ostraagent/core";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { isPublicAddress, publicFetch } from "../src/public-fetch.ts";

test("public addresses only: loopback, private, link-local, metadata, CGNAT, reserved and IPv4-carrying IPv6 are refused", () => {
  const refused = [
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.51.100.7",
    "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8",
    "64:ff9b::808:808", "2001::1", "2001:db8::1", "2002:7f00:1::1", "100::1", "3fff::1", "not-an-address", "",
  ];
  for (const a of refused) assert.equal(isPublicAddress(a), false, a);
  const allowed = ["8.8.8.8", "1.1.1.1", "172.66.147.70", "104.20.46.209", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:10::ac42:9346", "2a00:1450:4001:80e::200e", "2001:4860:4860::8888"];
  for (const a of allowed) assert.equal(isPublicAddress(a), true, a);
});

/** A local server counting its requests, answering by path. */
async function server(): Promise<{ s: Server; port: number; seen: IncomingMessage[]; bodies: string[] }> {
  const seen: IncomingMessage[] = [];
  const bodies: string[] = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push(req);
      bodies.push(body);
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://127.0.0.1/elsewhere" });
        res.end("moved");
      } else if (req.url === "/empty") {
        res.writeHead(204);
        res.end();
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 2_000);
      } else {
        res.writeHead(402, [["content-type", "application/json"], ["set-cookie", "a=1"], ["set-cookie", "b=2"], ["payment-required", "abc"]]);
        res.end(JSON.stringify({ method: req.method, path: req.url, host: req.headers.host }));
      }
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { s, port: (s.address() as AddressInfo).port, seen, bodies };
}

test("a URL that is not a public host is refused before anything is sent", async () => {
  const srv = await server();
  try {
    let resolved = 0;
    const send = publicFetch(async (host) => {
      resolved++;
      if (host === "private.example") return [{ address: "10.1.2.3", family: 4 }];
      if (host === "mixed.example") return [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
      if (host === "metadata.example") return [{ address: "169.254.169.254", family: 4 }];
      if (host === "six.example") return [{ address: "::1", family: 6 }];
      if (host === "none.example") return [];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    });
    const cases: [string, RegExp][] = [
      [`http://127.0.0.1:${srv.port}/`, /127\.0\.0\.1:\d+ is not a public address/],
      [`http://localhost:${srv.port}/`, /is this machine/],
      [`http://LOCALHOST.:${srv.port}/`, /is this machine/],
      [`http://api.localhost:${srv.port}/`, /is this machine/],
      [`http://[::1]:${srv.port}/`, /\[::1\]:\d+ is not a public address/],
      [`http://[::ffff:127.0.0.1]:${srv.port}/`, /not a public address/],
      ["http://169.254.169.254/latest/meta-data/", /169\.254\.169\.254 is not a public address/],
      ["http://2130706433/", /127\.0\.0\.1 is not a public address/],
      ["http://0x7f.1/", /127\.0\.0\.1 is not a public address/],
      ["https://private.example/", /10\.1\.2\.3, which is not a public address/],
      ["https://mixed.example/", /127\.0\.0\.1, which is not a public address/],
      ["http://metadata.example/", /169\.254\.169\.254/],
      ["http://six.example/", /::1/],
      ["https://none.example/", /resolves to no address/],
      ["https://missing.example/", /cannot be resolved: getaddrinfo ENOTFOUND/],
      ["ftp://8.8.8.8/", /http\(s\) requests only/],
      ["http://user:secret@8.8.8.8/", /no credentials/],
    ];
    for (const [url, why] of cases) {
      await assert.rejects(send(url, { method: "GET" }), (e: Error) => {
        assert.match(e.message, why, url);
        // Refusals of the request are PayRefusedError (pay tells them as they are); DNS failures are not.
        assert.equal(e instanceof PayRefusedError, !/cannot be resolved|resolves to no address/.test(e.message), url);
        return true;
      });
    }
    assert.equal(srv.seen.length, 0, "nothing reached the server");
    assert.equal(resolved, 6, "IP literals and localhost are never looked up");
  } finally {
    srv.s.close();
  }
});

test("the connection goes to the address checked (no second lookup), and the answer comes back as fetch's would", async () => {
  const srv = await server();
  try {
    // Only for this test, 127.0.0.1 counts as public, so the request reaches the local server: a name that would
    // answer another address on a second lookup must still connect where the check looked.
    let lookups = 0;
    const send = publicFetch(
      async () => {
        lookups++;
        return lookups === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.9.9.9", family: 4 }];
      },
      (a) => a === "127.0.0.1",
    );
    const res = await send(`http://rebind.example:${srv.port}/paid?x=1`, { method: "POST", headers: { "x-test": "1", "Payment-Signature": "sig", Host: "other.example", "Accept-Encoding": "gzip" }, body: "{\"q\":1}" });
    assert.equal(lookups, 1);
    assert.equal(res.status, 402);
    assert.equal(res.headers.get("payment-required"), "abc");
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2"]);
    const clone = res.clone();
    assert.deepEqual(JSON.parse(await res.text()), { method: "POST", path: "/paid?x=1", host: `rebind.example:${srv.port}` });
    assert.equal((await clone.text()).length > 0, true);
    const req = srv.seen[0]!;
    assert.equal(req.headers["x-test"], "1");
    assert.equal(req.headers["payment-signature"], "sig");
    assert.equal(req.headers["content-type"], "text/plain;charset=UTF-8");
    assert.equal(req.headers["content-length"], "7");
    assert.equal(req.headers["user-agent"], "node");
    // The model's Host and Accept-Encoding are dropped: the Host is the URL's, the answer uncompressed.
    assert.equal(req.headers["accept-encoding"], undefined);
    assert.equal(srv.bodies[0], "{\"q\":1}");

    const local = publicFetch(async () => [{ address: "127.0.0.1", family: 4 }], (a) => a === "127.0.0.1");

    // A redirect is the answer, never followed.
    const moved = await local(`http://rebind.example:${srv.port}/redirect`, { method: "GET" });
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get("location"), "http://127.0.0.1/elsewhere");
    assert.equal(await moved.text(), "moved");
    assert.equal(srv.seen.length, 2);

    // A status without a body.
    const empty = await local(`http://rebind.example:${srv.port}/empty`, { method: "DELETE" });
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), "");

    // Every address checked is tried in order: an unreachable first one falls back to the next.
    const both = publicFetch(async () => [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }], (a) => a === "::1" || a === "127.0.0.1");
    const second = await both(`http://dual.example:${srv.port}/paid`, { method: "GET" });
    assert.equal(second.status, 402);
    await second.text();

    // The caller's signal still ends a request.
    await assert.rejects(local(`http://rebind.example:${srv.port}/slow`, { method: "GET", signal: AbortSignal.timeout(200) }), (e: Error) => e.name === "TimeoutError" || e.name === "AbortError");
  } finally {
    srv.s.closeAllConnections();
    srv.s.close();
  }
});

test("an answer that is not HTTP pay reads is an error naming the host, and its connection is closed", async () => {
  let closed = false;
  const raw = createTcpServer((socket) => {
    socket.on("close", () => (closed = true));
    socket.once("data", () => socket.write("HTTP/1.1 600 Odd\r\ncontent-length: 2\r\n\r\nok"));
  });
  await new Promise<void>((r) => raw.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (raw.address() as AddressInfo).port;
    const local = publicFetch(async () => [{ address: "127.0.0.1", family: 4 }], (a) => a === "127.0.0.1");
    await assert.rejects(local(`http://odd.example:${port}/`, { method: "GET" }), /odd\.example:\d+ answered status 600/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(closed, true);
  } finally {
    raw.close();
  }
});

test("OSTRA_PAY_PRIVATE_HOSTS=yes lets pay reach hosts that are not public, never on a hosted server", async () => {
  const base = { OSTRA_HOME: "/nonexistent/ostra-config-test", OSTRA_DEPLOYMENT: fileURLToPath(new URL("../../deployments/robinhood-mainnet.json", import.meta.url)) };
  assert.equal((await loadConfig(base)).payPrivateHosts, false);
  assert.equal((await loadConfig({ ...base, OSTRA_PAY_PRIVATE_HOSTS: "yes" })).payPrivateHosts, true);
  assert.equal((await loadConfig({ ...base, OSTRA_PAY_PRIVATE_HOSTS: "1" })).payPrivateHosts, false);
  assert.equal((await loadConfig({ ...base, OSTRA_PAY_PRIVATE_HOSTS: "yes", OSTRA_HOSTED: "yes" })).payPrivateHosts, false);
});
