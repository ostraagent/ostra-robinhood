// builder.ts: which token of a swap HEY is asked about, and that an index that cannot be reached (a closed port on
// this machine, a real refused connection) answers "unavailable" at once, without throwing, so a swap goes on without
// it. The answers of the live index are checked by scripts/smoke.ts on mainnet.

import assert from "node:assert/strict";
import { test } from "node:test";
import { LAUNCH_PAIRS, USDG, WETH } from "@ostraagent/sdk";
import { UNAVAILABLE, builderOf, builderToken } from "../src/builder.ts";

const OSTRA = LAUNCH_PAIRS.find((p) => p.kind === "ostra")?.address as string;
const NVDA = LAUNCH_PAIRS.find((p) => p.symbol === "NVDA")?.address as string;

test("the token bought, or the one sold for USDG or WETH; none between USDG and WETH", () => {
  assert.equal(builderToken(USDG, OSTRA), OSTRA);
  assert.equal(builderToken(WETH, OSTRA), OSTRA);
  assert.equal(builderToken(OSTRA, USDG), OSTRA);
  assert.equal(builderToken(OSTRA.toLowerCase(), WETH.toLowerCase()), OSTRA.toLowerCase());
  assert.equal(builderToken(OSTRA, NVDA), NVDA);
  assert.equal(builderToken(USDG, WETH), null);
  assert.equal(builderToken(WETH.toLowerCase(), USDG.toUpperCase().replace("0X", "0x")), null);
});

test("an index that cannot be reached answers unavailable, without throwing", async () => {
  const t0 = Date.now();
  assert.deepEqual(await builderOf("http://127.0.0.1:9", OSTRA), UNAVAILABLE);
  assert.deepEqual(await builderOf("http://127.0.0.1:9/", OSTRA), UNAVAILABLE);
  assert.ok(Date.now() - t0 < 5_000, "a refused connection answers at once");
});
