// The Ostra agent card (agent-card.ts): the same bytes for the same agent on every machine, Ostra's fixed design with
// only the number set, a number made smaller only when it would not fit, and nothing in it that runs or loads.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AGENT_CARD_TYPE, AGENT_CARD_VERSION, agentCardSvg } from "../src/agent-card.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("one agent, one card: deterministic, and the design is the one chosen (its bytes pinned here)", () => {
  assert.equal(AGENT_CARD_VERSION, 1);
  assert.equal(AGENT_CARD_TYPE, "image/svg+xml");
  assert.equal(agentCardSvg("20074"), agentCardSvg("20074"));
  assert.notEqual(agentCardSvg("20074"), agentCardSvg("20075"));
  // A change to these is a new design: a new AGENT_CARD_VERSION, never the same version with other bytes.
  assert.equal(sha(agentCardSvg("20074")), CARD_20074);
  assert.equal(sha(agentCardSvg(null)), CARD_NONE);
});

test("the number is set at 210 px, and smaller only when it would run past the card", () => {
  const scale = (svg: string) => Number(/<path transform="matrix\(([0-9.]+) /.exec(svg.slice(svg.lastIndexOf('fill="#D9381E"')))?.[1]);
  const short = scale(agentCardSvg("7"));
  assert.ok(Math.abs(short - 210 / 2048) < 1e-3, String(short));
  assert.equal(scale(agentCardSvg("20074")), short);
  assert.ok(scale(agentCardSvg("123456789012")) < short);
});

test("only Ostra's SVG: no script, link, style sheet or anything fetched, and agent ids are decimal", () => {
  for (const svg of [agentCardSvg(null), agentCardSvg("0"), agentCardSvg("9".repeat(30))]) {
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"'));
    assert.ok(svg.endsWith("</svg>"));
    for (const bad of ["<script", "href", "url(", "<image", "<foreignObject", "<style", "on"]) {
      if (bad === "on") assert.ok(!/\son[a-z]+=/i.test(svg), "no event attribute");
      else assert.ok(!svg.includes(bad), bad);
    }
  }
  for (const bad of ["", "01", "1.5", "-1", "1e3", "12a", "9".repeat(31)]) assert.throws(() => agentCardSvg(bad), RangeError, bad);
});

const CARD_20074 = "314330edaaf35ebd34eca2a05f6d30a6dc8beab80e0fc6b38144722e93d46ee0";
const CARD_NONE = "93fa71d26783995f53c655eabc85f3ce04f0fe0b5b06910cae16b2568c191665";
