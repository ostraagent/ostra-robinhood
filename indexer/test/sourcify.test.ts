// OstraToken's standard JSON input (sourcify/ostra-token.input.json) against the repository: the sources Sourcify
// compiles are the files here, with foundry.toml's settings. The live test reads Sourcify (OSTRA_SOURCIFY_LIVE=1):
// tokens P and Ostra Test, verified there on 23 Oct 2026, and the job that verified P.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TOKEN_COMPILER, TOKEN_CONTRACT, TOKEN_INPUT_PATH, Sourcify } from "../src/sourcify.ts";

const repo = new URL("../../", import.meta.url);
const input = JSON.parse(readFileSync(TOKEN_INPUT_PATH, "utf8")) as {
  language: string;
  sources: Record<string, { content: string }>;
  settings: { optimizer: { enabled: boolean; runs: number }; evmVersion: string; metadata: { bytecodeHash: string }; remappings: string[] };
};

test("the token's standard JSON input is the repository's OstraToken with foundry.toml's settings", () => {
  assert.equal(input.language, "Solidity");
  const [file, name] = TOKEN_CONTRACT.split(":");
  assert.equal(name, "OstraToken");
  assert.ok(file !== undefined && file in input.sources, "OstraToken.sol is among the sources");
  for (const [path, s] of Object.entries(input.sources)) {
    assert.equal(s.content, readFileSync(new URL(path, repo), "utf8"), path);
  }
  const toml = readFileSync(new URL("foundry.toml", repo), "utf8");
  const val = (k: string) => new RegExp(`^${k}\\s*=\\s*"?([^"\\n]+)"?`, "m").exec(toml)?.[1];
  assert.equal(TOKEN_COMPILER.split("+")[0], val("solc_version"));
  assert.equal(input.settings.evmVersion, val("evm_version"));
  assert.equal(input.settings.optimizer.enabled, val("optimizer") === "true");
  assert.equal(String(input.settings.optimizer.runs), val("optimizer_runs"));
  assert.equal(input.settings.metadata.bytecodeHash, val("bytecode_hash"));
});

test("live: tokens P and Ostra Test are verified on Sourcify, and an address with no contract is not", { skip: process.env.OSTRA_SOURCIFY_LIVE !== "1" ? "OSTRA_SOURCIFY_LIVE=1 reads sourcify.dev" : false, timeout: 120_000 }, async () => {
  const s = new Sourcify({ chainId: 4663 });
  assert.equal(await s.status("0x247328c5b99b8B7Cf76eA304aA0Fd00177ff98B7"), "verified");
  assert.equal(await s.status("0x8f11Ce6A5c28c2064f69540C7C8471127683d3aA"), "verified");
  assert.equal(await s.status("0x000000000000000000000000000000000000dEaD"), "unverified");
  // The job that verified token P (23 Oct 2026).
  assert.deepEqual(await s.job("0375cd93-df8e-4dca-9616-08e352440139"), { done: true, verified: true, error: null });
});
