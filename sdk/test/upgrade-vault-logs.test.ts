// The lock scan's logs RPC against the state RPC's head (scripts/upgrade-vault.ts logsHeadReached), with two local
// anvil nodes as the two RPCs: a logs RPC a few blocks behind is waited for until it reaches the head, one that stays
// behind is refused, and one at or past the head is used at once.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { createPublicClient, http, type PublicClient } from "viem";
import { logsHeadReached } from "../scripts/upgrade-vault.ts";
import { rpc } from "./fork.ts";

type Node = { url: string; client: PublicClient; child: ChildProcess };
const nodes: Node[] = [];

async function startNode(): Promise<Node> {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await rpc(url, "eth_chainId", []);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("anvil did not start within 30 s");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const node = { url, client: createPublicClient({ transport: http(url) }) as PublicClient, child };
  nodes.push(node);
  return node;
}

const mine = async (n: Node, blocks: number) => {
  for (let i = 0; i < blocks; i++) await rpc(n.url, "evm_mine", []);
};

let state: Node;
let logs: Node;

before(async () => {
  state = await startNode();
  logs = await startNode();
});

after(() => {
  for (const n of nodes) n.child.kill();
});

test("a logs RPC behind the state RPC is waited for, refused if it stays behind, and used at once when level", async () => {
  await mine(state, 10);
  await mine(logs, 6);
  // Four blocks behind and never catching up: refused after the wait, naming both heads.
  await assert.rejects(logsHeadReached(state.client, logs.client, 2_000), /the logs RPC is at block 6, still behind the state RPC's 10 after 2 s/);
  // Four blocks behind, then catching up while the scan waits: the state RPC's head is returned.
  const caughtUp = setTimeout(() => void mine(logs, 4), 1_500);
  try {
    const started = Date.now();
    assert.equal(await logsHeadReached(state.client, logs.client, 20_000), 10n);
    assert.ok(Date.now() - started >= 1_500, "it waited for the logs RPC");
  } finally {
    clearTimeout(caughtUp);
  }
  // Level, or past the head (it moved on since): no wait.
  await mine(logs, 3);
  const started = Date.now();
  assert.equal(await logsHeadReached(state.client, logs.client, 20_000), 10n);
  assert.ok(Date.now() - started < 1_000, "no wait when the logs RPC is not behind");
});
