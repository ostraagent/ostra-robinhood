import assert from "node:assert/strict";
import { test } from "node:test";
import { loadProxyConfig, parseListen } from "../src/config.ts";

const base = {
  OSTRA_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  OSTRA_RPC_PROXY_LISTEN: "127.0.0.1:4700",
  OSTRA_RPC_PROXY_PER_IP: "3",
  OSTRA_RPC_PROXY_TOTAL: "7",
};

test("both rates and the socket's address", () => {
  const c = loadProxyConfig(base);
  assert.deepEqual(c, { rpcUrl: base.OSTRA_RPC_URL, listen: { host: "127.0.0.1", port: 4700 }, perIp: 3, total: 7, clientIp: "socket" });
  assert.equal(loadProxyConfig({ ...base, OSTRA_RPC_PROXY_CLIENT_IP: "cf-connecting-ip" }).clientIp, "cf-connecting-ip");
  assert.equal(loadProxyConfig({ ...base, OSTRA_RPC_PROXY_CLIENT_IP: "" }).clientIp, "socket");
});

test("every variable is checked, and the rates have no default", () => {
  for (const name of Object.keys(base)) {
    const env: Record<string, string> = { ...base };
    delete env[name];
    assert.throws(() => loadProxyConfig(env), new RegExp(name), name);
  }
  for (const bad of ["0", "-1", "1.5", "x", "01"]) {
    assert.throws(() => loadProxyConfig({ ...base, OSTRA_RPC_PROXY_PER_IP: bad }), /positive whole number/, bad);
    assert.throws(() => loadProxyConfig({ ...base, OSTRA_RPC_PROXY_TOTAL: bad }), /positive whole number/, bad);
  }
  assert.throws(() => loadProxyConfig({ ...base, OSTRA_RPC_PROXY_PER_IP: "8" }), /must not exceed/);
  assert.throws(() => loadProxyConfig({ ...base, OSTRA_RPC_URL: "ftp://x" }), /http or https/);
  assert.throws(() => loadProxyConfig({ ...base, OSTRA_RPC_PROXY_CLIENT_IP: "x-forwarded-for" }), /socket or cf-connecting-ip/);
});

test("listen addresses", () => {
  assert.deepEqual(parseListen("[::1]:80"), { host: "[::1]", port: 80 });
  assert.throws(() => parseListen("4700"), /host:port/);
  assert.throws(() => parseListen("h:0"), /1..65535/);
  assert.throws(() => parseListen("h:65536"), /1..65535/);
});
