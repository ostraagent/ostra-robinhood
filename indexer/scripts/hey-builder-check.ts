// Checks the index's HEY builder reader (src/hey.ts) against HEY's real API with the key the indexer's service has
// (OSTRA_HEY_KEY_FILE): OSTRA, a project HEY publishes, answers its Partner Card under HEY's rules (HEY's status
// words, project_link carrying Ostra's integration name, a count or null, never a made-up 0); a second read within
// 60 seconds is kept and not asked again; the NVDA stock token, which HEY has not published, answers not_published
// with HEY's scan link; two reads of one address at once make one call; past the day's calls nothing more is asked
// (unavailable); an address outside the listed tokens is asked about within the other tokens' calls of the day and not
// past them, and text that is not an address never; and a card whose project names another contract (OSTRA's real
// card with activity_applies_to_token turned false) passes on the project and its link alone.
// Makes five calls to HEY. Prints the answers, never the key.
//
//   OSTRA_HEY_KEY_FILE=/etc/ostra/hey-research.key node scripts/hey-builder-check.ts

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { getAddress, type Address } from "viem";
import { HEY_API, HEY_CHAIN, HEY_INTEGRATION, HeyBuilders, cardOf } from "../src/hey.ts";

const keyFile = process.env.OSTRA_HEY_KEY_FILE;
if (keyFile === undefined || keyFile === "") throw new Error("missing environment variable OSTRA_HEY_KEY_FILE");
if ((statSync(keyFile).mode & 0o777) !== 0o600) throw new Error(`${keyFile} must have mode 0600`);
const key = readFileSync(keyFile, "utf8").trim();

const OSTRA = getAddress("0x68Ff81dFFF6eccefb74706fE1e0a86320CB2Eb96");
const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const STEAKHOUSE = getAddress("0xBeEff033F34C046626B8D0A041844C5d1A5409dd");
const BORRO_USDG = getAddress("0xF8e0ab443098c0738489B5BAFFbd32A1341F2289");

const events: string[] = [];
const allowed = new Set<Address>([OSTRA, NVDA, STEAKHOUSE, BORRO_USDG]);
const hey = new HeyBuilders({ key, allowed: (t) => allowed.has(t), log: (e) => events.push(e), dailyCalls: 3 });

// 1. A published project: its card under HEY's rules.
const ostra = await hey.builder(OSTRA);
console.log("OSTRA:", JSON.stringify(ostra, null, 2));
assert.ok(ostra !== null && ostra.state === "published", "OSTRA's card is published");
const c = ostra.card;
assert.equal(c.hey_project_name.length > 0, true);
assert.match(c.hey_status_label, /\S/);
assert.equal(typeof c.activity_measured, "boolean");
const link = new URL(c.project_link);
assert.equal(link.origin, HEY_API);
assert.equal(link.searchParams.get("utm_source"), HEY_INTEGRATION, "project_link carries Ostra's integration name");
assert.ok(c.meaningful_ships_30d === null || (Number.isInteger(c.meaningful_ships_30d) && c.meaningful_ships_30d >= 0));
if (c.latest_meaningful_ship !== null) assert.equal(new URL(c.latest_meaningful_ship.evidence_link).origin, HEY_API);
assert.match(ostra.disclaimer, /not a rating/);
assert.equal(hey.callsMade, 1);

// 2. Read again within 60 seconds: kept, not asked again.
assert.equal(await hey.builder(OSTRA.toLowerCase()), ostra);
assert.equal(hey.callsMade, 1, "a second read within 60 seconds is not asked again");

// 3. Not published by HEY: not_published, with HEY's scan link.
const nvda = await hey.builder(NVDA);
console.log("NVDA:", JSON.stringify(nvda));
assert.ok(nvda !== null && nvda.state === "not_published");
assert.equal(new URL(nvda.scan_url as string).origin, HEY_API);
assert.equal(hey.callsMade, 2);

// 4. Two reads of one address at once: one call.
const [s1, s2] = await Promise.all([hey.builder(STEAKHOUSE), hey.builder(STEAKHOUSE)]);
assert.equal(s1, s2);
assert.equal(hey.callsMade, 3, "two reads at once make one call");

// 5. Past the day's calls: nothing more is asked.
const borro = await hey.builder(BORRO_USDG);
assert.deepEqual(borro && borro.state, "unavailable");
assert.equal(hey.callsMade, 3, "no call past the day's limit");
assert.ok(events.includes("hey_daily_calls_reached"));

// 6. Addresses outside the listed tokens (here none is listed): asked about within the other tokens' calls of the day,
// not past them; text that is not an address is never asked about.
const others = new HeyBuilders({ key, allowed: () => false, log: (e) => events.push(e), otherDailyCalls: 1 });
const other = await others.builder(BORRO_USDG);
console.log("an unlisted address:", JSON.stringify(other));
assert.ok(other !== null && other.state === "not_published");
assert.equal(others.callsMade, 1);
const past = await others.builder(NVDA);
assert.deepEqual(past && past.state, "unavailable");
assert.equal(others.callsMade, 1, "no call past the other tokens' calls of the day");
assert.ok(events.includes("hey_other_daily_calls_reached"));
assert.equal(await hey.builder("not an address"), null);
assert.equal(await others.builder("not an address"), null);
assert.equal(hey.callsMade, 3);
assert.equal(others.callsMade, 1);

// 7. A project that names another contract: OSTRA's real card with activity_applies_to_token turned false; and one
// that says nothing of whether its activity applies to the token is not passed on.
const res = await fetch(`${HEY_API}/api/v1/builder?chain=${HEY_CHAIN}&token=${OSTRA}`, { headers: { authorization: `Bearer ${key}`, "x-hey-integration": HEY_INTEGRATION } });
assert.equal(res.status, 200);
const body = (await res.json()) as Record<string, unknown>;
const mismatch = cardOf({ ...body, activity_applies_to_token: false, token_verification: "MISMATCH" });
console.log("OSTRA as a mismatch:", JSON.stringify(mismatch));
assert.ok(mismatch !== null && mismatch.state === "project_only");
assert.equal(mismatch.project_link, body.project_link);
assert.equal("card" in mismatch, false, "no activity is passed on as the token's");
const unsaid = { ...body };
delete unsaid.activity_applies_to_token;
assert.equal(cardOf(unsaid), null, "activity is passed on only when HEY says it applies to the token");
// HEY's text is cut and cleaned before it reaches an agent.
const long = cardOf({ ...body, hey_project_name: `A\u202eB${"x".repeat(400)}` });
assert.ok(long !== null && long.state === "published");
assert.equal([...long.card.hey_project_name].length, 200);
assert.ok(!/[\u202e]/.test(long.card.hey_project_name));

console.log("HEY_BUILDER_CHECK_PASSED");
