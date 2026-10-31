// Ostra Tide's score of one week (src/tide-score.ts), written for the index to answer each agent its own figures
// (indexer src/tide.ts) and, once the week is over, with the Merkle tree OstraTide pays against (scripts/tide-pay.ts).
// Run every hour by ostra-tide-score.timer, and by hand. The output names every agent's linked vaults: it is written
// 0600, never printed; what is printed is counts and totals.
//
//   node scripts/tide-score.ts <week>
//   node scripts/tide-score.ts auto     (the timer) the week now running; once the chain is past the last week with
//                                       rules (TIDE_RULES.week), that week, until a score read after its link
//                                       deadline (the week's end + 23 hours) is written: the one its root is set from
//
//   OSTRA_RPC_URL_FILE      file (0600) with the RPC URL for state reads: an archive node (state at past blocks);
//                           default /etc/ostra/robinhood-rpc.url; never printed
//   OSTRA_LOGS_RPC_URL      the RPC for event searches (default Robinhood Chain's public RPC: wide windows)
//   OSTRA_DEPLOYMENT        ostra-robinhood's record (default /srv/apps/ostra-robinhood/deployments/robinhood-mainnet.json)
//   OSTRA_SWAP_DEPLOYMENT   ostra-swap's record, for OstraRouter (default /srv/apps/ostra-swap/deployments/robinhood-mainnet.json)
//   OSTRA_TIDE_LINKS        the links the index keeps (default /var/lib/ostra-indexer/tide-links.json; missing: none)
//   OSTRA_STATS_OWN         Ostra's own vaults, one address at the start of each line (default /var/lib/ostra-stats/own.tsv)
//   OSTRA_TIDE_RESULTS      where week-<n>.json is written (default /var/lib/ostra-tide)
//   OSTRA_TIDE_RESCORE      1: score again a week whose score read after its link deadline is written (kept otherwise)
//
// The last line is TIDE_SCORED.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_PUBLIC_RPC, TIDE_RULES, assertRobinhoodChain, parseDeployment, redact, robinhoodClient, tideLinkDeadline, tideWeekAt } from "@ostraagent/sdk";
import { readTideWeek, type TideLinkRecord } from "../src/tide-score.ts";

// The RPC URLs (either may carry a key): never printed.
const secrets: string[] = [];
const hide = (line: string) => secrets.reduce((t, x) => (x === "" ? t : redact(t, x)), line);
const say = (line: string) => console.log(hide(line));

async function privateText(path: string, what: string): Promise<string> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${what} ${path} must be readable by its owner alone (it has mode ${mode.toString(8)})`);
  return (await readFile(path, "utf8")).split("\n")[0]!.trim();
}

async function main(): Promise<void> {
  const weekText = process.argv[2] ?? "";
  if (weekText !== "auto" && !/^[1-9][0-9]{0,3}$/.test(weekText)) throw new Error("usage: node scripts/tide-score.ts <week> | auto");
  const rpcUrl = await privateText(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  const logsUrl = process.env.OSTRA_LOGS_RPC_URL || ROBINHOOD_PUBLIC_RPC;
  secrets.push(rpcUrl, logsUrl === ROBINHOOD_PUBLIC_RPC ? "" : logsUrl);
  const client = robinhoodClient(rpcUrl);
  const logsClient = robinhoodClient(logsUrl);
  await assertRobinhoodChain(client);
  await assertRobinhoodChain(logsClient);
  const dir = process.env.OSTRA_TIDE_RESULTS || "/var/lib/ostra-tide";
  let week: number;
  if (weekText === "auto") {
    const now = Number((await client.getBlock()).timestamp);
    const running = tideWeekAt(now);
    if (running < 1) {
      say(`Ostra Tide has not started (the chain is at ${new Date(now * 1000).toISOString()}): nothing to score`);
      say("TIDE_SCORED");
      return;
    }
    week = Math.min(running, TIDE_RULES.week);
    if (week < running) {
      // No rules for the week now running yet: the last week with rules, until a score read after its link deadline
      // is written (links approved after the week's end and before the deadline count).
      let done = false;
      try {
        const kept = JSON.parse(await readFile(join(dir, `week-${week}.json`), "utf8")) as { final: boolean; at: number };
        done = kept.final === true && kept.at > tideLinkDeadline(week);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (done) {
        say(`week ${week} is scored after its link deadline; week ${running} has no rules yet: nothing to score`);
        say("TIDE_SCORED");
        return;
      }
    }
  } else week = Number(weekText);
  if (week > TIDE_RULES.week) throw new Error(`week ${week} has no rules yet (sdk TIDE_RULES is week ${TIDE_RULES.week}'s): nothing was scored`);
  // A score read after the link deadline is the one the root is set from: it is not replaced unless asked.
  const out = join(dir, `week-${week}.json`);
  try {
    const kept = JSON.parse(await readFile(out, "utf8")) as { final: boolean; at: number };
    if (kept.final === true && kept.at > tideLinkDeadline(week) && process.env.OSTRA_TIDE_RESCORE !== "1") {
      throw new Error(`${out} holds week ${week}'s score read after its link deadline, which its root is set from: it is kept (OSTRA_TIDE_RESCORE=1 scores it again; tide-pay check then compares it with the root on chain)`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
  }
  const d = parseDeployment(JSON.parse(await readFile(process.env.OSTRA_DEPLOYMENT || "/srv/apps/ostra-robinhood/deployments/robinhood-mainnet.json", "utf8")));
  const sw = JSON.parse(await readFile(process.env.OSTRA_SWAP_DEPLOYMENT || "/srv/apps/ostra-swap/deployments/robinhood-mainnet.json", "utf8")) as { chainId: number; router: Address };
  if (d.chainId !== ROBINHOOD_CHAIN_ID || sw.chainId !== ROBINHOOD_CHAIN_ID) throw new Error("the records are not Robinhood Chain mainnet's");
  const linksPath = process.env.OSTRA_TIDE_LINKS || "/var/lib/ostra-indexer/tide-links.json";
  let links: TideLinkRecord[] = [];
  try {
    await privateText(linksPath, "the Tide links");
    links = JSON.parse(await readFile(linksPath, "utf8")) as TideLinkRecord[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const own = new Set<Address>();
  for (const line of (await readFile(process.env.OSTRA_STATS_OWN || "/var/lib/ostra-stats/own.tsv", "utf8")).split("\n")) {
    const m = /^\s*(0x[0-9a-fA-F]{40})\b/.exec(line);
    if (m) own.add(getAddress(m[1] as Address));
  }
  if (own.size === 0) throw new Error("Ostra's own list names no vault: refusing to score without it");
  const t0 = Date.now();
  const r = await readTideWeek({
    client,
    logsClient,
    factory: d.vaultFactory,
    router: getAddress(sw.router),
    fromBlock: BigInt(d.fromBlock),
    week,
    links,
    own,
    linkDeadline: tideLinkDeadline(week),
    chainId: ROBINHOOD_CHAIN_ID,
  });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(`${out}.tmp`, JSON.stringify(r, null, 1), { mode: 0o600 });
  await rename(`${out}.tmp`, out);
  const withPoints = r.agents.filter((a) => BigInt(a.breakdown.points) > 0n);
  const linked = r.agents.filter((a) => a.link.status === "verified").length;
  say(`week ${week} at block ${r.block} (${new Date(r.at * 1000).toISOString()}), ${r.final ? "final" : "not over: days not over are read at the latest block"}`);
  say(`agents: ${r.agents.length} taking part (${linked} with a verified link, ${withPoints.length} with points), ${r.excluded.length} left out (${r.excluded.filter((e) => e.reason === "Ostra's own").length} Ostra's own)`);
  say(`pot ${r.pot} OSTRA base units, shared ${r.shared}, total points ${r.totalPoints}${r.tree === null ? "" : `, root ${r.tree.root} over ${r.tree.leaves.length} shares`}`);
  say(`written ${out} (0600) in ${Math.round((Date.now() - t0) / 1000)} s`);
  say("TIDE_SCORED");
}

main().catch((err: unknown) => {
  console.error(`STOPPED: ${hide(err instanceof Error ? err.message : String(err))}`);
  process.exit(1);
});
