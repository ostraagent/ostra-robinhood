// The files an agent publishes: Ostra's ERC-8004 registration file as its profile (the same for every Ostra agent but
// its number, card and vault) and a token's metadata, built from checked fields; and the uploader's address, which is
// the relayer's.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ERC8004_IDENTITY_REGISTRY } from "@ostraagent/sdk";
import { AGENT_DESCRIPTION, AGENT_NAME, imageType, profileFile, uploaderUrl } from "../src/publish.ts";

const VAULT = "0x00000000000000000000000000000000000000Aa";

test("a profile is Ostra's ERC-8004 registration file: its name and number, Ostra's description, its card, its vault as agentWallet", () => {
  const f = profileFile({ vault: VAULT, agentId: "8853", image: "ipfs://bafkreiimage" });
  assert.deepEqual(f, {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Ostra Agent #8853",
    description: AGENT_DESCRIPTION,
    image: "ipfs://bafkreiimage",
    services: [{ name: "agentWallet", endpoint: `eip155:4663:${VAULT}` }],
    active: true,
    registrations: [{ agentId: 8853, agentRegistry: `eip155:4663:${ERC8004_IDENTITY_REGISTRY}` }],
  });
  const first = profileFile({ vault: VAULT });
  assert.equal(first.name, AGENT_NAME);
  assert.deepEqual(first.registrations, []);
  assert.equal("image" in first, false);
  assert.ok(!/—/.test(AGENT_DESCRIPTION) && AGENT_DESCRIPTION.length <= 1_000);
});

test("bad fields are refused before anything is uploaded", () => {
  assert.throws(() => profileFile({ vault: VAULT, agentId: "12a" }), RangeError);
  assert.throws(() => profileFile({ vault: VAULT, image: "javascript:alert(1)" }), RangeError);
});

test("images by their first bytes, and the uploader on the relayer's host", () => {
  assert.equal(imageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(imageType(new TextEncoder().encode("<svg/>")), null);
  assert.equal(uploaderUrl("https://relayer.ostraagent.xyz/"), "https://relayer.ostraagent.xyz/v1/ipfs");
  assert.throws(() => uploaderUrl(null), /OSTRA_RELAYER_URL/);
});
