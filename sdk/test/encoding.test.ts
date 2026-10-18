// Checks the SDK's own byte encodings (written without Node's Buffer so the
// SDK runs in a browser) against Node's Buffer, and that the browser entry
// is the Node entry without the Node-only modules.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import * as browser from "../src/browser.ts";
import { fromHex, toHex } from "../src/hash.ts";
import * as node from "../src/index.ts";
import { randomBytes32 } from "../src/wots.ts";

test("toHex and fromHex match Buffer for every byte value and random lengths", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(toHex(all), Buffer.from(all).toString("hex"));
  assert.deepEqual(fromHex(Buffer.from(all).toString("hex")), all);
  for (let n = 0; n <= 70; n++) {
    const bytes = new Uint8Array(randomBytes(n));
    const hex = Buffer.from(bytes).toString("hex");
    assert.equal(toHex(bytes), hex);
    assert.deepEqual(fromHex(hex), bytes);
  }
  assert.throws(() => fromHex("0g"), /invalid hex/);
  assert.throws(() => fromHex("AB"), /invalid hex/);
});

test("randomBytes32 gives 32 fresh bytes", () => {
  const a = randomBytes32();
  const b = randomBytes32();
  assert.equal(a.length, 32);
  assert.equal(b.length, 32);
  assert.notDeepEqual(a, b);
});

test("the browser entry is the Node entry without FileWotsStore and the deployment functions", () => {
  const nodeOnly = ["FileWotsStore", "checkDeployment", "checkLaunchpad", "deployLaunchpad", "deployOstra", "mineHookSalt"];
  const nodeNames = Object.keys(node).sort();
  const browserNames = Object.keys(browser).sort();
  for (const name of nodeOnly) {
    assert.ok(nodeNames.includes(name), name);
    assert.ok(!browserNames.includes(name), name);
  }
  assert.deepEqual(browserNames, nodeNames.filter((n) => !nodeOnly.includes(n)));
});
