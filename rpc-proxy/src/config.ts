// Configuration of the RPC proxy (main.ts), read from the environment once at
// start-up.
//
//   OSTRA_RPC_URL                the upstream RPC endpoint of Robinhood Chain
//                                (chain 4663); never printed and never sent to a
//                                browser, it may carry an API key
//   OSTRA_RPC_PROXY_LISTEN       host:port of this server, e.g. 127.0.0.1:4700
//   OSTRA_RPC_PROXY_PER_IP       requests a second one client IP address may send
//   OSTRA_RPC_PROXY_TOTAL        requests a second all clients together may send
//                                (at most what the upstream plan allows)
//   OSTRA_RPC_PROXY_CLIENT_IP    "socket" (default: the connection's address) or
//                                "cf-connecting-ip" (behind Cloudflare and a local proxy only)
//
// The two rates have no default: they are set from the measured use of the
// web app (design: RPC proxy). On Solana the proxy also read OSTRA_CLUSTER;
// the chain is now checked by its id at start (main.ts).

export type ProxyConfig = {
  rpcUrl: string;
  listen: { host: string; port: number };
  perIp: number;
  total: number;
  clientIp: "socket" | "cf-connecting-ip";
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

function httpUrl(text: string, name: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be an http or https URL`);
  return text;
}

function rate(text: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${name} must be a positive whole number of requests a second`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} is too large`);
  return n;
}

/** "host:port" with a port from 1 to 65535. */
export function parseListen(text: string): { host: string; port: number } {
  const at = text.lastIndexOf(":");
  const portText = text.slice(at + 1);
  if (at <= 0 || !/^[0-9]+$/.test(portText)) throw new Error("OSTRA_RPC_PROXY_LISTEN must be host:port");
  const port = Number(portText);
  if (port < 1 || port > 65_535) throw new Error("OSTRA_RPC_PROXY_LISTEN port must be 1..65535");
  return { host: text.slice(0, at), port };
}

export function loadProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const clientIp = env.OSTRA_RPC_PROXY_CLIENT_IP === undefined || env.OSTRA_RPC_PROXY_CLIENT_IP === "" ? "socket" : env.OSTRA_RPC_PROXY_CLIENT_IP;
  if (clientIp !== "socket" && clientIp !== "cf-connecting-ip") throw new Error("OSTRA_RPC_PROXY_CLIENT_IP must be socket or cf-connecting-ip");
  const perIp = rate(required(env, "OSTRA_RPC_PROXY_PER_IP"), "OSTRA_RPC_PROXY_PER_IP");
  const total = rate(required(env, "OSTRA_RPC_PROXY_TOTAL"), "OSTRA_RPC_PROXY_TOTAL");
  if (perIp > total) throw new Error("OSTRA_RPC_PROXY_PER_IP must not exceed OSTRA_RPC_PROXY_TOTAL");
  return {
    rpcUrl: httpUrl(required(env, "OSTRA_RPC_URL"), "OSTRA_RPC_URL"),
    listen: parseListen(required(env, "OSTRA_RPC_PROXY_LISTEN")),
    perIp,
    total,
    clientIp,
  };
}
