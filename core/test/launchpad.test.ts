// The launchpad's pure parts in core: token amounts of any decimals, the gas
// a vault spend is reserved for (a Swap reserves its swapGas), and the
// launch options a creator changes after the launch, by name.

import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { POOL_SETTING, VAULT_ACTION, VAULT_SWAP_GAS_RESERVE, signVaultSwap, WotsKeychain, type WotsStore } from "@ostraagent/sdk";
import { POOL_SETTING_NAMES, VAULT_SPEND_GAS, formatUnitsAmount, parseUnitsAmount, spendCall, spendGas } from "../src/index.ts";

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const NO_STORE: WotsStore = { load: async () => undefined, saveIfAbsent: async () => true };

test("token amounts of any decimals: plain decimals in, base units out, and back", () => {
  assert.equal(parseUnitsAmount("1.5", 18), 1_500_000_000_000_000_000n);
  assert.equal(parseUnitsAmount("0.000000000000000001", 18), 1n);
  assert.equal(parseUnitsAmount("12", 0), 12n);
  assert.equal(formatUnitsAmount(1_500_000_000_000_000_000n, 18), "1.5");
  assert.equal(formatUnitsAmount(1n, 18), "0.000000000000000001");
  assert.equal(formatUnitsAmount(0n, 18), "0");
  for (const bad of ["1.0000000000000000001", "-1", "1e18", " 1", "01", ""]) assert.throws(() => parseUnitsAmount(bad, 18), /invalid amount/, bad);
  assert.throws(() => parseUnitsAmount("340282366920938463463.374607431768211456", 18), /too large/);
});

test("a vault spend is reserved for VAULT_SPEND_GAS, a Swap for its swapGas on top", async () => {
  const transfer = { to: at(1), data: "0x12345678" as const };
  assert.equal(spendGas([transfer]), VAULT_SPEND_GAS);
  const keys = new WotsKeychain(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), NO_STORE);
  const vault = at(0xaa);
  const key = { currency0: at(0x5f), currency1: at(0x60), fee: 0x800000, tickSpacing: 200, hooks: at(0x28cc) };
  const signed = await signVaultSwap(keys, { vault, nonce: 0n, keyRoot: `0x${Buffer.from(keys.keyRoot(0n)).toString("hex")}` }, { chainId: 4663, token: at(0x5f), swap: { key, zeroForOne: true, amountIn: 5n, minOut: 1n, recipient: at(0xbb), swapGas: 630_000n } });
  assert.equal(signed.action, VAULT_ACTION.SWAP);
  assert.equal(spendGas([spendCall(vault, signed)]), VAULT_SPEND_GAS + 630_000n + 630_000n / 63n + 1n + BigInt(VAULT_SWAP_GAS_RESERVE));
});

test("the pool settings a creator changes, by name, are OstraHook's fields", () => {
  assert.equal(Object.keys(POOL_SETTING_NAMES).length, Object.keys(POOL_SETTING).length);
  assert.equal(POOL_SETTING_NAMES.max_tx_move, POOL_SETTING.MAX_TX_MOVE);
  assert.equal(POOL_SETTING_NAMES.sell_tax, POOL_SETTING.SELL_TAX);
});
