// The `pay` tool's HTTP client: a request to a URL the model chose reaches only public hosts.
//
// The host is resolved first (an IP literal is taken as it is), and the request is refused unless every address it
// resolves to is a public unicast address: never loopback, "localhost", private (RFC 1918, IPv6 ULA), link-local
// (169.254.0.0/16 with the cloud metadata address 169.254.169.254, fe80::/10), carrier-grade NAT, documentation,
// benchmark, multicast or reserved space, nor an IPv6 address that carries an IPv4 one (mapped, NAT64, 6to4, Teredo).
// The connection is then made to the address checked, never to a second lookup, so a name that answers differently
// the next time (DNS rebinding) cannot move the request. TLS still checks the certificate against the host name.
// Redirects are never followed: a 3xx comes back as the answer, as `pay`'s fetch already did (redirect: "manual").
// The model's Host and Accept-Encoding headers are dropped: the Host is the URL's (TLS checks that name), and answers
// come back uncompressed. Requests go straight to the host, never through an HTTP proxy from the environment (a
// proxy would make its own connection, outside this check). An address list cannot tell a network's own public
// addresses (a VPC's global IPv6 range, an operator's NAT64 prefix) from the Internet's.
//
// OSTRA_PAY_PRIVATE_HOSTS=yes turns the check off (a seller on the user's own network, local tests); never on a
// hosted server (OSTRA_HOSTED=yes).

import { ADDRCONFIG } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { PayRefusedError } from "@ostraagent/core";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private (RFC 1918)
  ["100.64.0.0", 10], // carrier-grade NAT (RFC 6598)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, the cloud metadata address 169.254.169.254 among them
  ["172.16.0.0", 12], // private (RFC 1918)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private (RFC 1918)
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
/** IPv6 that is public unicast: inside 2000::/3 (global unicast) and none of these. */
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ["2001::", 23], // IETF protocol assignments, Teredo (2001::/32, carries an IPv4 address) among them
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (carries an IPv4 address)
  ["3fff::", 20], // documentation (RFC 9637)
] as const) {
  blocked6.addSubnet(net, prefix, "ipv6");
}
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");

/** Whether `address` (an IP literal) is a public unicast address a model-chosen request may reach. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return global6.check(address, "ipv6") && !blocked6.check(address, "ipv6");
  return false;
}

export type PublicFetch = (url: string, init: RequestInit) => Promise<Response>;

type Address = { address: string; family: number };
type Resolve = (host: string) => Promise<Address[]>;

const defaultResolve: Resolve = (host) => lookup(host, { all: true, verbatim: true, hints: ADDRCONFIG });

/** Statuses whose answer has no body (the Response constructor refuses one). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
/** Request headers that are this client's, never the model's. */
const DROPPED = new Set(["host", "accept-encoding", "content-length", "connection", "transfer-encoding"]);

function headerRecord(h: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((value, name) => {
    if (!DROPPED.has(name)) out[name] = value;
  });
  return out;
}

/**
 * fetch(url, init) to a public host only: `init` takes method, headers, a string body and signal (what `pay` sends).
 * `resolve` and `allow` stand in for DNS and for the public-address rule in tests.
 */
export function publicFetch(resolve: Resolve = defaultResolve, allow: (address: string) => boolean = isPublicAddress): PublicFetch {
  return async (urlText, init) => {
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      throw new PayRefusedError(`${urlText} is not a URL; nothing was sent`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new PayRefusedError("pay sends http(s) requests only; nothing was sent");
    if (url.username !== "" || url.password !== "") throw new PayRefusedError("pay sends no credentials in a URL; nothing was sent");
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const name = host.toLowerCase().replace(/\.$/, "");
    if (name === "localhost" || name.endsWith(".localhost")) throw new PayRefusedError(`${url.host} is this machine: pay reaches public hosts only; nothing was sent`);
    const literal = isIP(host) !== 0;
    const addresses: Address[] = literal
      ? [{ address: host, family: isIP(host) }]
      : await resolve(host).catch((err: Error) => {
          throw new Error(`${url.host} cannot be resolved: ${err.message}; nothing was sent`);
        });
    if (addresses.length === 0) throw new Error(`${url.host} resolves to no address; nothing was sent`);
    const refused = addresses.filter((a) => !allow(a.address));
    if (refused.length > 0) {
      const what = literal ? `${url.host} is not a public address` : `${url.host} resolves to ${refused.map((a) => a.address).join(", ")}, which is not a public address`;
      throw new PayRefusedError(`${what}: pay reaches public hosts only; nothing was sent`);
    }
    const body = init.body === undefined || init.body === null ? undefined : init.body;
    if (body !== undefined && typeof body !== "string") throw new TypeError("pay sends a string body only");
    const headers: Record<string, string> = { accept: "*/*", "user-agent": "node", ...headerRecord(init.headers) };
    if (body !== undefined) {
      if (headers["content-type"] === undefined) headers["content-type"] = "text/plain;charset=UTF-8";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const https = url.protocol === "https:";
    const send = https ? httpsRequest : httpRequest;
    const res = await new Promise<IncomingMessage>((resolveRes, reject) => {
      const req = send(
        url,
        {
          method: init.method ?? "GET",
          headers,
          // The connection goes to the addresses checked above (in their order), never to a second lookup.
          lookup: (_hostname, options, cb) => {
            if ((options as { all?: boolean }).all === true) (cb as (e: null, a: Address[]) => void)(null, addresses);
            else (cb as (e: null, a: string, f: number) => void)(null, addresses[0]!.address, addresses[0]!.family);
          },
          // TLS checks the certificate against the URL's host name.
          ...(https && !literal ? { servername: host } : {}),
          ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
          agent: false,
        },
        resolveRes,
      );
      req.on("error", reject);
      req.end(body);
    });
    const out = new Headers();
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
    const status = res.statusCode ?? 0;
    const empty = NULL_BODY.has(status) || (init.method ?? "GET").toUpperCase() === "HEAD";
    try {
      const answer = new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage ?? "", headers: out });
      if (empty) res.resume();
      return answer;
    } catch (err) {
      res.destroy();
      throw new Error(`${url.host} answered status ${status}, which is not an HTTP answer pay reads: ${(err as Error).message}`);
    }
  };
}
