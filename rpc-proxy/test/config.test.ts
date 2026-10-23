import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROBINHOOD_PUBLIC_RPC } from "@ostraagent/sdk";
import { DEFAULT_LOGS, DEFAULT_SWAP_DEPLOYMENT, loadProxyConfig, parseListen, privatePoolOf } from "../src/config.ts";

const base = {
  OSTRA_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  OSTRA_RPC_PROXY_LISTEN: "127.0.0.1:4700",
  OSTRA_RPC_PROXY_PER_IP: "3",
  OSTRA_RPC_PROXY_TOTAL: "7",
};

test("both rates and the socket's address", () => {
  const c = loadProxyConfig(base);
  assert.deepEqual(c, {
    rpcUrl: base.OSTRA_RPC_URL,
    listen: { host: "127.0.0.1", port: 4700 },
    perIp: 3,
    total: 7,
    clientIp: "socket",
    logs: { rpcUrl: ROBINHOOD_PUBLIC_RPC, perIp: DEFAULT_LOGS.perIp, total: DEFAULT_LOGS.total, swapDeployment: DEFAULT_SWAP_DEPLOYMENT },
  });
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

test("the logs route: defaults, its own variables checked, and the pool from the ostra-swap record", () => {
  const c = loadProxyConfig({
    ...base,
    OSTRA_RPC_PROXY_LOGS_URL: "http://127.0.0.1:8545",
    OSTRA_RPC_PROXY_LOGS_PER_IP: "4",
    OSTRA_RPC_PROXY_LOGS_TOTAL: "9",
    OSTRA_SWAP_DEPLOYMENT: "/x/record.json",
  });
  assert.deepEqual(c.logs, { rpcUrl: "http://127.0.0.1:8545", perIp: 4, total: 9, swapDeployment: "/x/record.json" });
  assert.equal(loadProxyConfig({ ...base, OSTRA_RPC_PROXY_LOGS_URL: "" }).logs.rpcUrl, ROBINHOOD_PUBLIC_RPC);
  assert.throws(() => loadProxyConfig({ ...base, OSTRA_RPC_PROXY_LOGS_URL: "ws://x" }), /OSTRA_RPC_PROXY_LOGS_URL must be an http or https URL/);
  assert.throws(() => loadProxyConfig({ ...base, OSTRA_RPC_PROXY_LOGS_PER_IP: "0" }), /OSTRA_RPC_PROXY_LOGS_PER_IP must be a positive/);
  assert.throws(() => loadProxyConfig({ ...base, OSTRA_RPC_PROXY_LOGS_PER_IP: "61" }), /OSTRA_RPC_PROXY_LOGS_PER_IP must not exceed/);
  // The record of the ostra-swap checkout next to this one.
  assert.deepEqual(privatePoolOf(DEFAULT_SWAP_DEPLOYMENT), { privatePool: "0xe4250895Da2499602Cee4e178Fb46A0cF39F5b76", fromBlock: 94_940_585n });
  const dir = mkdtempSync(join(tmpdir(), "rpc-proxy-"));
  try {
    const file = join(dir, "r.json");
    writeFileSync(file, JSON.stringify({ chainId: 1, privatePool: "0xe4250895Da2499602Cee4e178Fb46A0cF39F5b76" }));
    assert.throws(() => privatePoolOf(file), /not Robinhood Chain's/);
    writeFileSync(file, JSON.stringify({ chainId: 4663 }));
    assert.throws(() => privatePoolOf(file), /names no privatePool/);
    writeFileSync(file, JSON.stringify({ chainId: 4663, privatePool: "0xe4250895Da2499602Cee4e178Fb46A0cF39F5b76" }));
    assert.throws(() => privatePoolOf(file), /has no fromBlock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
