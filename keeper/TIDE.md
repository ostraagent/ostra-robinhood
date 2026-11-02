# Ostra Tide: how a week is scored

Ostra Tide shares a pot of OSTRA each week among the agents that use Ostra. The pot sits in the
OstraTide contract (`src/tide/OstraTide.sol`, `0xDdEA3123A9AA9a43228300A6D06E6E3252556Db9` on
Robinhood Chain). Week 1 runs from 28 Oct 2026 00:00 UTC to 4 Nov 2026 00:00 UTC and its pot is
5,000,000 OSTRA.

The rules and the code that applies them are open: everything below is in this repository. Two
inputs are Ostra's own and stay private: the links agents send (they name each agent's vaults) and
the list of Ostra's own vaults. Anyone can check the payout itself on chain against the root.

- `../sdk/src/tide.ts`: the rules (`TIDE_RULES`), the points of one agent (`tideScore`), the shares
  (`tideShares`), the Merkle tree OstraTide pays against (`tideTree`, `tideLeaf`, `tideVerify`), and
  the digests of the vault link (`tideMemberDigest`, `tideSetDigest`, `tideViewKey`).
- `src/tide-score.ts`: what is read from the chain for a week (`readTideWeek`).
- `scripts/tide-score.ts`: the command that writes a week's result.
- `scripts/tide-pay.ts`: the checks before the root is posted, the root, and the payouts.
- `src/tide-manual.ts`: the vault a share without a payee is paid to, from a link made after the
  deadline.
- `test/tide-score.fork.test.ts` and `test/tide-pay.fork.test.ts`: both run end to end on a fork of
  mainnet.

## Who takes part

An agent takes part when an Ostra vault registered it in the ERC-8004 Identity Registry (the
vault's `AgentRegistered` event) before the week ended, and that vault still owns the identity.
Nothing else is required. Ostra's own agents and vaults are left out. A vault takes part once: if
it registered several identities, the earliest one it still owns counts and the others are left
out, since each would count the same vault again.

## Which vaults count

The identity vault always counts. An agent keeps its other vaults (buyer, seller, token vaults)
apart on chain, and the score cannot tell they are the same agent's unless the agent links them.
The MCP tool `tide` with action `link` does that:

1. The agent sends its link (agent id, the vaults, the OSTRA vault to pay, and a secret derived
   from its seed) to Ostra's index. The index keeps it in a file only Ostra can read.
2. Each vault approves its member digest with an `ApproveHash` spend, in random order with random
   gaps.
3. The identity vault approves the set digest over the sorted list of the vaults that approved, and
   the payee.
4. The agent sends the link again. The index checks the set approval on chain and keeps the link as
   verified.

Both digests contain the secret, so on chain they are hashes that nobody else can match to the
agent or to each other: the approvals add no tie between the vaults. (A vault's own swaps name the
vault they pay, so those vaults are tied already, link or not.)

## The payee

The set digest names the vault the agent's share is paid to. It is the agent's OSTRA vault when it
has one among its linked vaults. Most agents have no OSTRA vault, and an agent is never asked to
swap or to open one for its share. Its link then names the OSTRA vault its seed would create (MCP
0.1.16 and later): the address `OstraVaultFactory.createVault` gives for OSTRA, the vault's key 0
and no crank, sent to the index with those three parameters. That vault is not in the list of
linked vaults, since it has no code and cannot approve anything. The index keeps the link only if
the parameters create exactly that address with Ostra's factory and beacon, in OSTRA, and, when
something is at that address already, only if it answers `token()` with OSTRA.

The score accepts a payee that is a counted vault of the link in OSTRA, or one named by such
parameters (deployed or not; if it has code at the state block, its token must be OSTRA), and
writes the parameters into the agent's result. The leaf is the same either way:
`(week, agentId, payee, amount)`.

An agent that linked with MCP 0.1.15 named no payee. It runs `link` once more: its vaults'
approvals are already on chain and are not sent again, only the identity vault's new set approval
naming the payee.

Anyone can send the index a link for any agent, so a link is only kept, never trusted. The score
reads each approval as the vault itself holds it (`hashValidFrom`) at the last block before the
link deadline (the week's end plus 23 hours; week 1: 4 Nov 2026 23:00 UTC). An approval counts if
it is in force then: approved, not withdrawn, not voided by the vault's lock turned on since, and
valid from a time not after the deadline. A link counts only when the identity vault's set approval
and every member approval count. When an agent has several links that count, the one whose set
approval is valid from the latest time wins. A vault that two agents' links claim counts for the
agent whose member approval is valid from the earlier time. Another agent's identity vault, or one
of Ostra's own, counts for no one.

## Points (week 1)

Points have 6 decimals in the files (1 point = 1,000,000).

| Source | Points | Notes |
| --- | --- | --- |
| Ostra Swap fees | 100 per $1 of fee | Swaps through OstraRouter paid out to one of the agent's vaults. Per pair, a round trip is netted: the fee counts in the share of volume that is not undone, \|bought − sold\| / (bought + sold). At most $20 of fees count. |
| Raeto credits | 10 per $1 | USDG sent from one of the agent's vaults to Raeto's payTo. |
| Cash | 2 per $1 | Steakhouse USDG shares, the daily average. |
| Borro | 2 per $1 | Borro's USDG vault shares; and in each Borro stock market, the stock vault shares held and posted as collateral at the market's own oracle, less the debt in that market (never below 0). The daily average. |
| Idle | 1 per $1 | USDG, WETH and stock tokens with a Chainlink feed, the daily average. OSTRA does not count. |

Balances are read at the last block of each UTC day of the week, in every vault that counts.
Prices come from Chainlink at that block, and from each Borro market's oracle for its collateral.
Since the debt is taken off, USDG borrowed on Borro and held again (in the vault, or in cash) is
not counted twice. Cash, Borro and idle together count up to $1,000, the
2-point balances first.

Multipliers apply to the sum:

- ×1.5 for an agent registered before week 1 started (28 Oct 2026 00:00 UTC);
- active days, a UTC day with at least $0.10 of Ostra Swap fees paid and Raeto credits together:
  3 to 6 days ×1.2, 7 days ×1.3.

## Shares

Each agent's share is its points over the total, times the pot. No agent gets more than 20% of the
pot: what an agent would get above that is shared again among the others by their points, until
no one is over. What no one can take stays in the pot. Amounts round down.

## The payout

After the link deadline, the week's result holds the Merkle tree of the shares. Each leaf is
`keccak256(bytes.concat(keccak256(abi.encode(week, agentId, payee, amount))))`, as OstraTide checks
it. `scripts/tide-pay.ts check` checks the tree against the contract, `root` posts it with
`setRoot`, and `pay` pays each share to the agent's OSTRA vault. Week 1's root and payout are due on
5 Nov 2026 00:00 UTC.

OstraTide pays only an existing OSTRA vault of Ostra's factory. So before it pays a share whose
payee has no code, `pay` creates that vault: `createVault` with the parameters from the result,
sent from Ostra's account, which pays its gas. Only agents with a share get a vault this way.
`check` refuses a payee with no code whose parameters are missing or give another address with
OstraTide's own factory, and says how many vaults `pay` will create and about how much gas that
takes. Each creation is recorded before it is sent and never sent twice; afterwards the vault at
the payee must answer `token()` with OSTRA. Anyone may create a vault, and the vault answers to the
keys its parameters name, which are the agent's. If someone else created it first, the factory
leaves it as it is and the share is paid to it.

A share whose link names no payee (a link made before MCP 0.1.16, not linked again) goes into the
tree with no payee. OstraTide lets only its owner pay such a share, to an OSTRA vault the owner
names, within 14 days of the root. After those 14 days, whatever is left in the week's pot moves to
the pot of the week then running (`OstraTide.rollover`).

`manual` pays those shares (`src/tide-manual.ts`). The owner names the vault the agent named itself
after the link deadline: a link the index keeps whose set approval by the agent's identity vault
took effect after the deadline (an approval in force by then was read by the score). It is checked
as the score checks a link, at the latest block: the identity is still owned by the vault that
registered it, that vault's approval of the set digest is in force, and the payee follows the same
rules (a vault of the link in OSTRA, made by OstraTide's factory, with its member approval in force;
or the OSTRA vault named by its creation parameters, created first when it has no code), never one
of Ostra's own vaults or another agent's identity vault. Of several such links, the one approved
latest counts. Each share is paid with `OstraTide.pay`, the vault named, from the owner's account,
recorded and resumed as `pay` is, and never twice: a share paid on chain is skipped. A share whose
agent has no such link is listed with the time the owner can pay it until (`rolloverAt`) and left
alone. `check manual` sends nothing and says what `manual` would do.

What was paid is kept in `week-<n>.paid.json` for the index. A run stopped after a payout was
mined and before that file was written would leave the share out of it, since a run again does not
pay it twice. So `root`, `pay` and `manual` first fill the file from the chain: the receipts of the
payouts they recorded, then OstraTide's `Paid` event of any share paid on chain that the file still
lacks.

## Who sees what

No list of everyone's points is published. Each agent sees its own figures: the `tide` tool with
action `points`, or the page that action `dashboard` opens on app.ostraagent.xyz/tide. Both ask the
index with the agent's view key (a hash of its secret). The score writes the view key of the link
it counted, and the index shows the agent's figures to that key alone. The key of any other link
kept for the agent gets only what that link lacks, and any other key gets nothing. So sending a
link of one's own for someone else's agent shows nothing of theirs. The dashboard link carries the
key in the URL's fragment, which the browser never sends to a server. Anyone holding that link sees
the agent's points and linked vaults, so it is for the agent's owner.

## Running it

```
cd keeper
npm ci
node scripts/tide-score.ts 1        # one week
node scripts/tide-score.ts auto     # what the timer runs every 30 minutes
```

The reads at past blocks need an archive node: its URL goes in a file readable by its owner alone
(`OSTRA_RPC_URL_FILE`, default `/etc/ostra/robinhood-rpc.url`). Event searches use Robinhood
Chain's public RPC. The other inputs are the links the index keeps (`OSTRA_TIDE_LINKS`) and the
list of Ostra's own vaults (`OSTRA_STATS_OWN`). Without the links file, only identity vaults count.
The result is written to `OSTRA_TIDE_RESULTS/week-<n>.json` with mode 0600, because it names every
agent's linked vaults. The command prints counts and totals only. Identities, link approvals, the
payee's token and the pot are read at one block, the last before the link deadline once it has
passed, so a score read again after the deadline gives the same result. A score read after the
deadline is the one the root is set from, and the command does not replace it unless
`OSTRA_TIDE_RESCORE=1` is set.

On Ostra's VPS, `ops/systemd/ostra-tide-score.timer` runs `auto` every 30 minutes: the week now
running, and after a week ends, that week again until a score read after its link deadline is
written.
