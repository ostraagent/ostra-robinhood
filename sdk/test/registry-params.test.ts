// The SetProfile, SetTokenMetadata, RegisterAgent and SetAgentUri params: what OstraVault._checkUriParams
// accepts (the ABI encoding, a URI of 1 to 256 bytes) round trips; anything else is refused before signing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { concat, type Hex } from "viem";
import { VAULT_ACTION } from "../src/constants.ts";
import {
  checkSpendParamsLength,
  decodeRegisterAgentParams,
  decodeSetAgentUriParams,
  decodeSetProfileParams,
  decodeSetTokenMetadataParams,
  registerAgentParams,
  setAgentUriParams,
  setProfileParams,
  setTokenMetadataParams,
} from "../src/messages.ts";

const TOKEN = "0x00000000000000000000000000000000000000aa";
const POOL_ID = `0x${"11".repeat(32)}` as Hex;

test("profile, metadata and agent URIs of 1 to 256 bytes encode as the vault checks them and decode back", () => {
  for (const uri of ["i", "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", "x".repeat(256), "é".repeat(128)]) {
    assert.equal(decodeSetProfileParams(setProfileParams(uri)).uri, uri);
    assert.equal(decodeRegisterAgentParams(registerAgentParams(uri)).uri, uri);
    assert.deepEqual(decodeSetAgentUriParams(setAgentUriParams({ agentId: 8852n, uri })), { agentId: 8852n, uri });
    const m = decodeSetTokenMetadataParams(setTokenMetadataParams({ token: TOKEN, poolId: POOL_ID, uri }));
    assert.equal(m.uri, uri);
    assert.equal(m.poolId, POOL_ID);
  }
});

test("an empty, too long or control-character URI, a zero token or pool, and trailing bytes are refused", () => {
  for (const uri of ["", "x".repeat(257), "é".repeat(129), "ipfs://a\nb"]) {
    assert.throws(() => setProfileParams(uri), RangeError);
    assert.throws(() => registerAgentParams(uri), RangeError);
  }
  assert.throws(() => setTokenMetadataParams({ token: "0x0000000000000000000000000000000000000000", poolId: POOL_ID, uri: "ipfs://x" }), RangeError);
  assert.throws(() => setTokenMetadataParams({ token: TOKEN, poolId: `0x${"00".repeat(32)}`, uri: "ipfs://x" }), RangeError);
  assert.throws(() => checkSpendParamsLength(VAULT_ACTION.SET_PROFILE, concat([setProfileParams("ipfs://x"), `0x${"00".repeat(32)}`])), RangeError);
  assert.throws(() => checkSpendParamsLength(VAULT_ACTION.SET_PROFILE, `0x${"00".repeat(64)}`), RangeError);
});
