// The files an agent publishes: an ERC-8004 registration file as its profile and a token's metadata, built from
// checked fields; and the uploader's address, which is the relayer's.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ERC8004_IDENTITY_REGISTRY } from "@ostraagent/sdk";
import { imageType, profileFile, tokenMetadataFile, uploaderUrl } from "../src/publish.ts";

const VAULT = "0x00000000000000000000000000000000000000Aa";
const TOKEN = "0x00000000000000000000000000000000000000bB";

test("a profile is an ERC-8004 registration file with the vault as agentWallet and the registration once there is one", () => {
  const f = profileFile({ name: "Ostra Agent", description: "Trades and launches", image: "ipfs://bafkreiimage", website: "https://ostraagent.xyz", x: "https://x.com/ostraagent", vault: VAULT, agentId: "8853" });
  assert.equal(f.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  assert.equal(f.name, "Ostra Agent");
  assert.deepEqual(f.services, [
    { name: "web", endpoint: "https://ostraagent.xyz/" },
    { name: "X", endpoint: "https://x.com/ostraagent" },
    { name: "agentWallet", endpoint: `eip155:4663:${VAULT}` },
  ]);
  assert.deepEqual(f.registrations, [{ agentId: 8853, agentRegistry: `eip155:4663:${ERC8004_IDENTITY_REGISTRY}` }]);
  assert.deepEqual(profileFile({ name: "A", vault: VAULT }).registrations, []);
});

test("bad fields are refused before anything is uploaded", () => {
  assert.throws(() => profileFile({ name: "", vault: VAULT }), RangeError);
  assert.throws(() => profileFile({ name: "x".repeat(65), vault: VAULT }), RangeError);
  assert.throws(() => profileFile({ name: "A", website: "http://plain.example", vault: VAULT }), RangeError);
  assert.throws(() => profileFile({ name: "A", image: "javascript:alert(1)", vault: VAULT }), RangeError);
  assert.throws(() => tokenMetadataFile({ token: TOKEN, name: "T", symbol: "T", creatorVault: VAULT, description: "x".repeat(1_001) }), RangeError);
});

test("a token's metadata carries its name, symbol, links and where it lives", () => {
  const m = tokenMetadataFile({ token: TOKEN, name: "Ostra Test", symbol: "OTST", creatorVault: VAULT, telegram: "https://t.me/ostra" });
  assert.deepEqual(m, { name: "Ostra Test", symbol: "OTST", telegram: "https://t.me/ostra", token: `eip155:4663:${TOKEN}`, creatorVault: `eip155:4663:${VAULT}` });
});

test("images by their first bytes, and the uploader on the relayer's host", () => {
  assert.equal(imageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(imageType(new TextEncoder().encode("<svg/>")), null);
  assert.equal(uploaderUrl("https://relayer.ostraagent.xyz/"), "https://relayer.ostraagent.xyz/v1/ipfs");
  assert.throws(() => uploaderUrl(null), /OSTRA_RELAYER_URL/);
});
