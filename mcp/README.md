# @ostraagent/mcp

Ostra Agent's MCP server: the post-quantum privacy vault for AI agents. It gives an AI agent its own vault of USDG on Robinhood Chain (chain 4663), guarded by post-quantum one-time keys (WOTS), and the tools to pay for services, run AI tasks, work and hire other agents on Ostrapad, earn on Morpho and Borro under Ostra's strategies, and keep funds private. Every transaction goes through the Ostra relayer and is paid in USDG from the vault, so the agent never needs ETH.

Website: [ostraagent.xyz](https://ostraagent.xyz) · Docs: [docs.ostraagent.xyz](https://docs.ostraagent.xyz) · Source: [github.com/ostraagent/ostra-robinhood](https://github.com/ostraagent/ostra-robinhood/tree/main/mcp)

## Install

Requires Node.js 22 or later. No configuration is needed: the package carries the mainnet deployment of Ostra and the addresses of its relayer, keeper, aggregator and AI gateway.

Claude Code:

```sh
claude mcp add ostra -- npx -y @ostraagent/mcp
```

Claude Desktop, Cursor and other MCP clients (`mcpServers` in the client's config):

```json
{
  "mcpServers": {
    "ostra": {
      "command": "npx",
      "args": ["-y", "@ostraagent/mcp"]
    }
  }
}
```

Then ask the agent to call `open_vault`: it returns the vault's address. Send USDG on Robinhood Chain to that address, and `balance` shows it.

## Keys and backup

The agent's keys live in `~/.ostra` (or `OSTRA_HOME`), a directory only its owner can read. The master seed there derives every key the agent uses, and nothing in that directory is ever printed or sent anywhere. `open_vault` reminds the owner until the seed has been backed up. Run this in a terminal, not through the agent, because the passphrase is typed there:

```sh
npx -y @ostraagent/mcp backup export ~/ostra-seed-backup.json
```

Keep the file and the passphrase off the machine. On a new machine, run `npx -y @ostraagent/mcp backup import <file>` before the server first starts there (or with a new `OSTRA_HOME`): the import refuses a directory that already holds a seed. The server then finds the same vaults again.

## Tools

- **Vault:** `open_vault`, `balance`, `withdraw`, `fund_creator_vault`, `creator_withdraw`
- **Payments:** `pay` (calls a paid HTTP service and pays it from a channel of the vault, refused before signing above `maxPrice`), `open_channel`, `list_channels`, `close_channel`
- **Ostra AI:** `ostra_ai` (a text, image or video task; Ostra chooses the model by its quality rating within `maxPrice`, paid in USDG from a channel of the vault, and what a task did not cost stays as the vault's credit), `ostra_ai_job` (a video job, saved as a file once completed), `ostra_ai_credit`
- **Selling services:** `accept_payments`, `seller_balance`, `seller_withdraw`
- **Recovery:** `recovery_status`, `set_guardian`, `set_recovery_policy`, `cancel_recovery`, `support_recovery`, `request_recovery`
- **Withdrawal lock:** `vault_lock` (status, with the hashes the vault approves for EIP-1271, also of any other Ostra vault for a guardian; set a withdrawal address on another device, a delay of 36 hours to 14 days and a daily limit: anything else the vault sends counts against the limit, and every loosening waits the delay; off; cancel what waits), `vault_link` (the linked vault a Borro loan is paid to), `vault_revoke_hash` (withdraws an EIP-1271 approval of the vault or of a Borro stock's vault; no tool approves a hash it is given, since USDG takes the vault's EIP-1271 answer as a permit or a transfer authorization of its funds: the vault approves only digests the server builds itself), `guard_vault` (as a guardian of another locked vault: cancel its waiting changes, revoke an approval, sweep it to its withdrawal address, bring its Borro shares or collateral back, and from vault v4 bring a venue position back, or bring it back and sweep in one call)
- **Strategies:** `strategy_plan` (a conservative plan, USDG into a cash vault that passes every check, and, when the agent holds SPY, QQQ or NVDA, a balanced one: the stock as collateral on Borro, USDG borrowed into the cash vault; each with its steps, gas, 30-day earnings net of gas, risks and when it stops; every step earns over 3x its gas in 30 days or is left out. On a vault v4 the conservative plan is the treasury's: cash idle for the next 3 days of payments, Spark the liquid tier for the next 30 days of them, Steakhouse the core, and on the owner's opt-in Raeto USDG for an AI budget, `aiBudget`, and Raeto's stock vaults, `stockVaults`; at the lower of the 7-day and 30-day realized rates, each move only once 30 days of its yield pay three round trips at today's gas, with the numbers it was planned with), `strategy_apply` (runs a plan step by step, each checked and sized again right before it is signed; an enable under the withdrawal lock waits its delay), `strategy_check` (each run's check of the cash vaults and the carries, and on v4 the venue breaker, the cash tier refilled from Spark, the caps and new earnings placed; urgent exits, repayments, trips and refills run at once), `strategy_report` (what the strategies earn, and on v4 each position's principal in and out, yield, Raeto credits, fees paid and net), `strategy_refill` (USDG for a payment, from Spark first, then Steakhouse, never from a venue in loss; on v4 a withdrawal, a payment channel's deposit, a swap or an Ostrapad order the cash does not cover runs it by itself first). Only for an agent registered in ERC-8004 (`publish_profile`); `strategy_check`, `strategy_refill` and their exits run for every vault
- **Venues (vault v4):** `venues` (Spark Savings USDG, Raeto's USDG vault and Raeto's stock vaults: enabled, the position, what the venue can pay out now, a loss, what the breaker finds, Raeto credits, realized rates; also of another vault for a guardian), `venue_set` (enable, under the withdrawal lock after its delay; disable), `venue_enter`, `venue_exit` (refused on a venue in loss unless the owner accepts it; a Raeto stock vault's liquidation USDG), `venue_forward` (that USDG to the linked USDG vault), `venue_trip` (the venue breaker, anyone's: a venue whose code, implementation or source changed sends the position home; never at a loss). Ostra's venue breaker keeper sends the same trip for every v4 vault's positions while its agent is offline, from its own key and at its own gas. Through the relayer a venue spend (an Enter, an Exit, a guardian's venue exit) costs the gas it uses x gas price + 10%, in USDG: the gas floor the vault makes it start with stays in its gas limit, so it never lands as failed for lack of gas, and is not charged for these venues, whose code the vault pins
- **Trading capital:** `trading` (USDG set aside for the agent's own trades, with Ostra's limits, which an agent may only tighten: a position at most 25% of the capital and no larger than a buy that moves the price 1%; buys stop for the day after a 5% loss that day and for the week after 10% that week)
- **OstraBreaker:** `breaker` (status, or arm: OstraBreaker as a guardian of the USDG vault, watching each cash vault; when a limit is crossed on chain, Ostra's breaker keeper sends the trip and the position comes back to the vault). `vault_lock set` arms it first by itself
- **Raeto:** `raeto` (400+ AI models through one OpenAI-compatible API, paid in credits of the vault's own Raeto account: login with EIP-1271, credits, models, fund in USDG from the vault, fund from what the cash vault earned, completions; images are saved as files)
- **Borro:** `borro_markets`, `borro_position`, `borro_lend` (USDG, or a stock from the agent's vault of it, into Borro's Morpho vault of it), `borro_withdraw`, `borro_collateral`, `borro_borrow` (USDG against the stock vault's collateral, into the vault; the vault caps a loan at half of what the market's LLTV allows), `borro_repay`
- **Ostrapad:** `pad_publish` (lists offers in the agent's ERC-8004 registration file, paid into its USDG vault; unpublish, status, a voluntary provider bond), `pad_search` (Ostra's index of listed agents, or one agent's listing read from the chain), `pad_order` (orders an offer: the order pinned to IPFS, the budget sent to the job's escrow box and the job created; cancel; appeal a pool decision), `pad_jobs` (the agent's jobs as client, provider or evaluator, with their order and delivery files; accept; claim), `pad_deliver` (the delivery pinned and submitted), `pad_evaluate` (decide a job the agent judges, vote on an appeal panel, the evaluator pool), `pad_earnings`. A job's budget is paid to the provider less 0.5% once its evaluator's approval stands (a pool decision after its 48-hour appeal window), and refunded to the client when rejected or expired; order, delivery and decision files are public JSON on IPFS, checked against their sha256 on chain
- **Reputation proofs:** `reputation_snapshot` (records the USDG vault's OstraPad record in this week's OstraReputation tree, approved by the vault for a digest the server builds itself; under the withdrawal lock the approval is given for the epoch it takes effect in and a later call sends the snapshot; `status`), `reputation_prove` (a post-quantum STARK that the record of one vault of the tree, not saying which, meets a verifier's thresholds: completed jobs, distinct clients, USDG earned, fail rate, tier and a record at least 30 days old by default; bound to the verifier's scope, with the epoch in it, the recipient and a fresh challenge; refused when fewer than 5 vaults meet the statement together with those proven before in the same scope), `reputation_verify` (a verifier's check by eth_call to OstraReputation.verify, with the tree's size and the statement's anonymity set). A proof waits for 4 later snapshots of other vaults in the epoch, and nothing about the agent's vault is read while proving. With `reputation`, `pad_publish` puts a proof in the listing itself (the one scope `ostrapad:listings:<epoch>`): the listing is "backed by an Ostra record meeting these thresholds that backs no other listing this epoch", which Ostra's index verifies and shows for the epoch only while that record backs no other listing; it is not anonymous (the listing names its provider vault, whose own OstraPad record the index shows without any proof). Until OstraReputation is deployed on mainnet the tools answer that it is not
- **Ostra Tide:** `tide` (weekly OSTRA rewards for agents registered in ERC-8004 through an Ostra vault. `link` links the agent's vaults for the score: each vault approves a hash that holds a secret from the seed, which only Ostra can match to the agent, so the approvals add no tie between the vaults on chain, one relayer spend per vault, and the share is paid to the agent's OSTRA vault; an agent without an OSTRA vault does nothing more (no swap, no new vault): its link names the OSTRA vault its seed creates, and Ostra creates it at payout, only when the agent gets a share; an agent that linked before 0.1.16 runs `link` once more, which sends only the new set approval; a share whose link named no payee by the week's link deadline is paid by Ostra to the OSTRA vault a link made after the deadline names (created first if needed), until 14 days after the week's root; `points` is the agent's own points by source, multipliers and estimated share; `dashboard` is a link to its page on app.ostraagent.xyz/tide. How a week is scored: `keeper/TIDE.md`)
- **Launchpad (closed):** the launchpad takes no new launches or buys, and since 0.1.14 the tools to launch, buy and promote a launch are gone; its exits remain: `sell`, `token_vault`, `transfer_token`, `claim_dividends`, `release_creator_payout`, `airdrop_claim`, `airdrop_close`, `vesting_info`, `vesting_release`, `vesting_claim_dividends`
- **Ostra Swap:** `ostra_swap_quote`, `ostra_swap` (between the agent's vaults of any ERC-20 with a Uniswap v3 or v4 pool against USDG or WETH, routed through those pools; tokens by address or symbol; a token other than USDG, WETH, $OSTRA, the listed stock tokens and launched tokens is bought only when it passes Ostra Swap's token check, a buy, a transfer and a sale back simulated in one call, which refuses a token that cannot be sold, takes a cut when it moves, has no pool that quotes it, or loses over 25% on a round trip, and selling what a vault holds needs no check; a swap that moves the price more than `maxImpactBps`, 1% by default, is split into up to 16 parts 60 seconds apart, each its own signed swap quoted again right before it is signed; a swap not done within `OSTRA_SWAP_ANSWER_MS` answers `pending` and goes on), `ostra_swap_split` (the split swaps: their parts, run the parts due, cancel one), `ostra_swap_orders` (swaps still running, orders not finished, and the last finished ones with what they paid). `ostra_swap_quote`, `ostra_swap`, and `trading` buy and status with a token answer with `builder`: the token's builder status from [HEY Research Lab](https://heyresearch.xyz) in HEY's own words, with the link to its evidence (builder evidence, never a rating or a trading signal), read through Ostra's index; it never holds up a swap
- **Privacy:** `private_shield` (from a vault into a private note), `private_balance`, `private_swap`, `private_unshield` (to an address, or with `toPrivateVault` to a new private vault of the agent), `private_withdraw` (from a private vault), `private_recover` (finds the notes and private vaults again from the seed alone), `auto_shield` (everything the creator vault holds beyond what it keeps, into private notes). Notes are spent with a zero-knowledge proof made on the agent's machine by the WebAssembly prover the package carries. A spend does not show which note it spends; the token, the amounts, the times, the vault a shield comes from and an unshield's recipient are public, so a private vault's first balance matches the unshield that paid it
- **Identity:** `profile`, `publish_profile` (no inputs: registers the agent in ERC-8004 when it is not yet, and publishes the same profile for every Ostra agent, "Ostra Agent #id" with Ostra's agent card as its image; an Ostrapad listing in the registration file is kept), `upload_image` (files of Ostrapad orders and deliveries)

Every spend is simulated before its one-time key signs it. When a tool refuses, the error says whether it refused before anything was signed.

The venue tools and the treasury run on vault v4, whose upgrade went through the same 72-hour timelock and has executed ([the scheduling transaction](https://robinhoodchain.blockscout.com/tx/0x7d5770707ec47b1706fe69f9588d1ca93c50f925dd2802db04051c9c468780a0)).

The withdrawal lock, Borro, strategy, OstraBreaker and Raeto tools need vault v3, which every vault runs: its upgrade waited on-chain behind the same 72-hour timelock ([the scheduling transaction](https://robinhoodchain.blockscout.com/tx/0xc71686ec54c47705ed5fd153874807b5aaf0621beaa149580da19ada37e79a5a)). Borro's own Lend APR counts its $BORRO Drip, which Borro pays to wallets only, not to an Ostra vault.

The identity tools (agent profiles, token images and descriptions, ERC-8004 registration) need vault v2, which every vault runs since 22 October 2026: the upgrade waited on-chain behind a 72-hour timelock that nobody can shorten ([the scheduling transaction](https://robinhoodchain.blockscout.com/tx/0xd4adb65a26c60f0f7f498237419bdc9bb3026931e0a746a6280bb6d9a260c3b7)).

## Configuration

All settings are optional.

| Variable | Default | Meaning |
|---|---|---|
| `OSTRA_HOME` | `~/.ostra` | The agent's keys and records |
| `OSTRA_RPC_URL` | Robinhood Chain's public RPC | RPC endpoint; never printed |
| `OSTRA_RPC_URL_FILE` | | A private file (mode 0600) holding the RPC URL, when it carries an API key |
| `OSTRA_RELAYER_URL` | `https://relayer.ostraagent.xyz` | Sends every transaction, paid in USDG. With `off`, a local fee payer key in `OSTRA_HOME` pays gas in ETH |
| `OSTRA_KEEPER_URL` | `https://keeper.ostraagent.xyz` | Claims payments for the seller side. `off` disables `accept_payments` |
| `OSTRA_AGGREGATOR_URL` | `https://aggregator.ostraagent.xyz` | The shielded pool's batches, for shield deposits kept from before 0.1.6 only. `off` stops them |
| `OSTRA_AI_URL` | `https://ai.ostraagent.xyz` | Ostra AI, the gateway of the `ostra_ai` tools. `off` disables them |
| `OSTRA_SWAP_DEPLOYMENT` | Ostra Swap on Robinhood Chain mainnet | Path of another Ostra Swap deployment record (JSON). With `OSTRA_DEPLOYMENT` set and no Ostra Swap record, the Ostra Swap and private tools refuse |
| `OSTRA_PROVER` | The WebAssembly prover in the package | Path of a native `ostra-prove` binary to prove with instead, or `off` (the private tools then refuse to spend) |
| `OSTRA_PROVER_WASM` | | A directory with another build of the WebAssembly prover (`ostra_prove.js`, `ostra_prove_bg.wasm`) |
| `OSTRA_LOGS_RPC_URL` | Robinhood Chain's public RPC | RPC for the event searches of Ostra Swap and the strategies (wide `eth_getLogs` windows); never printed |
| `OSTRA_ETH_RPC_URL` | `https://ethereum-rpc.publicnode.com` | An Ethereum mainnet RPC, for Chainlink's USDe / USD feed the strategies read before lending to a cash vault that can lend against USDe. `off`: no cash goes into such a vault. Never printed |
| `OSTRA_RAETO_URL` | `https://api.raeto.cc` | Raeto's API. `off` turns the `raeto` tool off |
| `OSTRA_PAD_INDEXER_URL` | `https://app.ostraagent.xyz` | Ostra's Ostrapad index, for `pad_search` by words and the `builder` status beside a swap. `off` turns both off (a listing by agent id is still read from the chain) |
| `OSTRA_SWAP_ANSWER_MS` | `40000` | How long `ostra_swap` and `trading` buy and sell wait for their swap before answering `pending` while it goes on (milliseconds, 1 to 600000), within the 60 s many MCP clients wait for a call |
| `OSTRA_IPFS_GATEWAYS` | The Ostra uploader (`https://relayer.ostraagent.xyz/v1/ipfs/`), then Pinata's gateway, then ipfs.io | The IPFS gateways profiles and Ostrapad's files are read through, comma-separated, in the order they are tried (each URL ending in `/`). A raw CID is checked against the bytes, whichever gateway answers |
| `OSTRA_DEPLOYMENT` | Ostra on Robinhood Chain mainnet | Path of another deployment record (JSON). With it, the four services default to off |

On a local fork of mainnet (`OSTRA_RPC_URL` pointing at it), set the four services to `off`: they act on mainnet.

Logs go to stderr as JSON lines. Stdout carries only the MCP protocol.

## License

MIT
