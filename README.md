# Ostra on Robinhood Chain

Ostra Agent's contracts for Robinhood Chain (chain ID 4663), ported from the Solana program in
`ostraagent/ostra` with the same behavior. The design is "Agent Ostra — Rancangan v0.4".

Contents:

- `src/Wots.sol`, `src/LtHash.sol`: the WOTS verifier and the LtHash accumulator, byte-compatible
  with the Solana program and the Ostra TypeScript SDK, tested against vectors made by that SDK.
- `src/OstraVault.sol`, `src/OstraVaultFactory.sol`: vaults spent only with rotating WOTS keys
  (Transfer, OpenChannel, SetCrankKey, Swap, ConfigurePool, ClaimDividend, SetGuardian,
  SetRecoveryPolicy, SupportRecovery, DevBuy), as beacon proxies at addresses fixed by token, initial
  key root and initial crank. Channels are x402 batch-settlement channels on the deployed
  x402BatchSettlement; a seller vault is the channels' receiverAuthorizer, so only its crank claims
  vouchers and refunds unclaimed escrow. Swap is an exact-input swap of the vault's token on a
  Uniswap v4 pool of the deployed PoolManager, with the vault itself as the swapper (what the pool's
  hook sees); the output goes to the signed recipient, such as another vault, with an optional
  referrer as the hook's hookData and a signed gas for the swap, which it gets exactly. A swap that
  fails inside the PoolManager (below its minimum, refused by the pool's hook or a token, or out of
  its signed gas) moves nothing but uses the spend (`SwapFailed`), so the one-time key is never held
  by a swap the market moved; a spend sent from inside another unlock reverts. ConfigurePool is a
  launch creator's change to its pool's rules (`OstraHook.configure`); ClaimDividend claims an
  `OstraToken`'s dividends owed to the vault, to the signed recipient (the owner's vault for the
  dividend token). DevBuy pays a launch's dev buy from a creator vault: only `OstraDevBuy` can send
  it, and only inside the launch whose hash it signed (`OstraDevBuy.pendingLaunch`). A vault whose seed is lost is recovered by its guardians (other vaults): once the
  threshold supports the same new key root, the recovery waits its delay (36 hours to 14 days) and
  anyone finishes it, or the new key's first spend does; any spend by the current key cancels it.
  `lib/v4-core` is `src/` and `licenses/` of Uniswap v4-core v4.0.0 (commit e50237c), the release
  whose PoolManager runs on chain 4663.
- `src/OstraSplit.sol`: the receiver of a seller's channels, paying fixed bps shares (the keeper fee)
  and the rest to the seller vault.
- `src/OstraPool.sol`: the shielded pool for one token. Deposits (also relayed with EIP-3009) that
  record nothing about their leaves, batches of standard leaves whose state (an LtHash of the leaves)
  every consumed deposit approves with its WOTS key, sealing when the deposits add up to the
  leaves, WOTS leaf spends, refunds after 48 hours. Version 2 (19 Oct 2026): version 1 recorded each
  deposit's LtHash commitment, from which anyone could match every deposit to its leaves; the live
  pool is upgraded through its beacon (`sdk/scripts/upgrade-pool.ts`, same storage layout).
  `test/Pool.fork.t.sol` runs it on the mainnet fork with the real USDG, including that upgrade of
  the live pool.
- `src/OstraUpgradeOwner.sol`: the owner of the vault and pool beacons. Every call it makes (an
  upgrade, a change of owner, the final renounceOwnership) is signed by a rotating WOTS one-time key,
  never an ECDSA key, and waits 72 hours in public before anyone may execute it, so every vault owner
  can withdraw before an upgrade it does not accept. A valid cancel never reverts (a cancel that lost
  the race to execute only rotates the key), so no third party can leave a signature public without
  its key rotating. Without the owner seed and its passphrase no upgrade can ever be scheduled again:
  the beacons then stay as they are, as if renounced. `test/UpgradeOwner.fork.t.sol` hands the live
  beacons to it on the mainnet fork.
- `src/launchpad/`: the Ostra launchpad on the deployed Uniswap v4 PoolManager. `OstraLaunchpad`
  launches a fixed-supply `OstraToken` whose whole supply goes into single-sided tiers of one pool
  (the top tier open to the highest price), held forever by `OstraLocker`; `OstraHook`, the pools'
  one hook, charges every swap 1% hook fee (70% creator, 30% protocol, half of that for the OSTRA
  buyback) plus the pool's buy or sell tax and anti-snipe tax in the quote, as PoolManager claims
  held by `OstraDispatcher`, which pays them out in `dispatch` (anyone may call it): the creator's
  share, the burn bucket (bought and burned), the LP bucket (full-range liquidity in the locker),
  the floor bid (a quote-only position one tick spacing below the price that buys when the price
  falls; what it buys is burned, and it rises with the price by at most one spacing a minute) and
  holder dividends. The creator's share goes to the creator vault, or through `OstraCreatorSplit`
  to up to 100 recipients whose shares the creator vault changes at any time with ConfigurePool.
  A payout the creator's token refuses, or dividends the dividend pool refuses, wait for the next
  dispatch without holding up the rest; the protocol's share is booked per currency at swap time
  and claimed by the owner (protocol and OSTRA buyback parts). Before graduation only the locker
  and the dispatcher add liquidity and the max buy and the token's max wallet apply. During the
  anti-farmer period the token enters no other v4 pool and no Uniswap v2 or v3 style pool. The
  creator vault can change the rules only in the traders' favour (lower taxes, earlier tax end,
  higher max buy, limits released, volatility fee off, a looser or no circuit breaker). The circuit
  breaker, chosen at launch (off, or 1,000 to 6,932 ticks; Ostra's default 2,231, -20% / +25%),
  refuses a swap that leaves the price further from where it was before the transaction's first
  swap, however the transaction splits it, or where the pool has no liquidity; a dispatch in the
  same transaction stops at its band. A swap whose hookData is `abi.encode(referrer)` (an OstraVault
  Swap carries it as its referrer word) pays that referrer half of the protocol's share of the
  hook fee (0.15% of the quote leg), which anyone can pay out to it with
  `OstraDispatcher.claimReferral`. `OstraDevBuy` launches with the creator's dev buy in the same
  transaction (the hook fee, the tax, the max buy, the max wallet and the circuit breaker apply, the
  anti-snipe tax does not), at most 5% of the supply, into an `OstraVesting` clone that pays the
  creator's token vault after a 7 to 365 day cliff, linearly over up to 365 days, and earns the
  pool's dividends for the creator meanwhile. `OstraDevBuy.launchFromVault` is the launch an agent
  without ETH makes: the creator vault signs one DevBuy spend of the launch's hash
  (keccak256(abi.encode(params, devBuy))) and the dev buy is paid from the vault inside exactly that
  launch, whoever sends it (the Ostra relayer, which fronts the 0.0002 ETH launch fee); the token's
  salt is bound to the creator vault, so nobody can take its address first, and what the dev buy
  did not spend goes back to the vault (WETH again for an ETH pool). `OstraLaunchpad.poolOf` and
  `OstraDevBuy.vestingPool` prove a token or a vesting is the launchpad's. `OstraAirdrop` runs the creator's airdrop rounds: the
  creator vault buys the tokens into it, sets a round's amount (at most 10% of the supply) and starts
  it with a merkle root; anyone claims for an account for 7 days, then anyone closes the round and
  what was not claimed is burned; one round at a time. A pool's quote is ETH or any ERC-20, a
  stock token among them; dividends in another ERC-20 are bought in an existing hookless pool or
  a launched Ostra pool. The LP fee is set per swap by `OstraFees`: 0.25%; 0.50% in a pool quoted
  in a Robinhood stock token while the NYSE is closed (weekends and the NYSE holidays of 2026 to
  2028, US daylight time computed on chain); if the creator chose it at launch, up to 1% as the
  price moves away from its 60-second EMA (the larger of the two, never above 1%); and a surcharge
  only for an actor reversing its own swap within the same second (100 pips per tick moved since
  its first swap of that second, at most 5%). `test/Fees.t.sol` checks the calendar against NYSE's
  published holidays and independently computed times. `test/Launchpad.fork.t.sol` runs it against
  the real PoolManager, USDG, WETH and AAPL pools, a TEST/AAPL pool quoted in the AAPL stock token,
  Uniswap v2 and v3 factories, the v3 position manager and Universal Router 2.1.2.
- `sdk/`: the TypeScript SDK (`@ostraagent/sdk`, viem). WOTS, LtHash and leaves as on Solana; the
  messages, ids and addresses the contracts compute (spend, approval, leaf, deposit nonce, close
  request, channel id, voucher, vault address); reads of vaults, the pool, batches and channels; the
  aggregator wire format and EIP-191 polls; and `deployOstra`, which deploys the contracts from the
  Foundry build, and `deployLaunchpad` (the hook at a CREATE2 address mined for its flags, wired).
  The launchpad: launch params with Ostra's defaults, the launch hash and DevBuy spend of a
  vault-funded launch, airdrop trees; and quotes made before the owner's key signs anything: a vault
  Swap (`quoteVaultSwap`: the exact spend signed by a throwaway key, simulated with the vault's key
  root overridden to the throwaway's; the smallest swapGas that swaps, x 1.5 + 50,000; minOut at the
  slippage; refused above 80% of the circuit breaker's room), a vault-funded launch
  (`quoteVaultLaunch`) and any other spend (`simulateVaultSpend`). Its fork tests run every message
  against the contracts on a fork of mainnet.
- `keeper/`: the keeper service (`@ostraagent/keeper`). It guards channels paid to Ostra seller
  vaults whose crank is its per-merchant crank: it claims a forwarded voucher once 1 token is
  unclaimed or the oldest unclaimed voucher is an hour old, and on a buyer's close request (seen
  within its 30-second watch) or a seller's signed close request it claims the last voucher, refunds
  the rest and pays the seller's split out (settle, distribute, release). `scripts/chain-check.ts`
  runs the keeper process end to end against a chain; its fork test runs it on a mainnet fork.
- `merchant/`: the seller server (`@ostraagent/merchant`) and the library the relayer and the AI
  gateway sell through. Paid routes are x402 batch-settlement channels (`@x402/evm` 2.28.0) paid to
  the seller's OstraSplit with the seller's Ostra vault as receiverAuthorizer; vouchers are checked
  by this server's own in-process facilitator, which also sends buyers' EIP-3009 deposits. Every
  paid voucher is forwarded to the keeper; a buyer's refund and a channel idle for 300 seconds are
  closed through the keeper; channels a buyer's Ostra vault opened on-chain are adopted from the
  chain. `scripts/chain-check.ts` runs the keeper and the seller server end to end against a chain
  with the stock x402 client as buyer; its fork test runs it on a mainnet fork (it waits out the
  300-second idle close).
- `relayer/`: the relayer gate (`@ostraagent/relayer`). Agents post calls to Ostra's contracts
  (one call, or several sent through Multicall3); the relayer checks them against its policy, prices
  the transaction (the gas it uses, simulated with eth_simulateV1, plus its L1 data component and
  the swapGas each vault Swap in it reserves, since code the agent picks runs inside a Swap and can
  use all of it, x gas price + 10%, at Chainlink ETH/USD + 0.5%), charges it as an Ostra seller
  through `merchant/` and sends it from its own account, so agents need no ETH. A vault Swap the
  simulation shows failing (SwapFailed: it would move nothing and only use the key) is refused (422
  swap_fails) unless the request sets allowFailedSwaps; a quoted Swap is simulated again when it
  comes back to be paid and once more just before it is sent. createVault, a leaf spent into a
  vault, unshield and an open to the relayer are relayed before payment as the vault's debt; WOTS
  signatures are escrowed before anything is simulated. On the launchpad it relays
  `OstraDevBuy.launchFromVault` alone, from a creator vault in USDG (or WETH, with a payer), fronting
  the launch fee and charging it with the gas; the airdrop's claims and closes, referral claims,
  creator split releases, and an Ostra dev buy vesting's release and dividends; and spends of vaults
  in WETH or a launched token (Transfer, Swap, ClaimDividend; ConfigurePool for WETH), paid by a
  `payer` vault in USDG. The gas of a transaction that reverts on-chain is kept from what was paid.
  The signature escrow keeps every WOTS signature until the chain shows its key used: a restored
  device reads it (GET /v1/signatures/<key root>) before signing, and an agent sending with its own
  fee payer escrows first (POST /v1/escrow); a recovering vault's new key is escrowed too.
  Passkey backups (GET and POST /v1/backups/<name>) keep a seed encrypted under a passkey's PRF
  output, which the relayer cannot open, named by the hash of the credential id; the seed's backup
  key binds the name with its first write and alone replaces or deletes it.
  `scripts/chain-check.ts` runs the keeper and the relayer end to end with an agent that holds no
  ETH; its fork test runs it on a mainnet fork.
- `core/`: Ostra Agent's logic shared by the MCP package and the web app (`@ostraagent/core`),
  browser-safe, with records behind a storage interface: the keys derived from the master seed,
  the buyer, seller and private vaults (open, withdraw, open a channel, change the crank), the
  relayer client that pays the relayer with vouchers of the vault's channel to it, channels from
  the vault to Ostra sellers (closed on the payer path: requestClose, then finalizeWithdraw after
  the grace period), session keys, shield and unshield, guardian recovery (set guardians and the
  policy, support another vault's recovery, adopt a vault on a new device and cancel a recovery),
  the relayer's signature escrow (a key with no record on this device asks it before signing,
  so a device restored from the seed sends a signature still in flight instead of signing again),
  the passkey backup of the seed (AES-256-GCM under HKDF of the WebAuthn PRF output, kept by the
  relayer), and the creator vault a launch pays its creator's share to, with its own records and
  relayer client and an optional auto-shield of its balance into the shielded pool; `pay`, which
  pays an x402 batch-settlement offer of an Ostra seller from a channel of the vault; and the
  launchpad (`launchpad.ts`): buy (USDG from the buyer vault into the agent's vault for that token,
  created in the same request) and sell back, launch with a dev buy from the creator vault, pool
  settings, creator shares, airdrop rounds, vesting and referral claims, every vault spend quoted or
  simulated before its key signs it. A launch signed and not landed is sent again from the launch
  kept before signing, or from the call in the relayer's signature escrow on a restored device.
  `scripts/chain-check.ts` runs it end to end against the keeper, the relayer and a seller server;
  its fork test runs it on a mainnet fork. `test/recovery.fork.test.ts` runs a guardian recovery
  on a fork.
  `test/shield.fork.test.ts` runs shield, the creator vault's auto-shield, an abandoned batch with
  the new leaf sets after it, and unshield against the aggregator on a fork. `test/launchpad.fork.test.ts` runs the launchpad service on a fork.
- `mcp/`: Ostra Agent's MCP server (`@ostraagent/mcp`, stdio, `@modelcontextprotocol/sdk` 1.32.1).
  Its keys and records stay in OSTRA_HOME (0700; files 0600; the seed backed up with
  `node src/backup-cli.ts export <file>`, encrypted under a passphrase typed in a terminal). Tools:
  the vault (open_vault, balance, withdraw), channels and pay, the seller side (accept_payments),
  shield and unshield, recovery, and the launchpad (pool_info, quote_swap, buy, sell, token_vault,
  transfer_token, claim_dividends, launch, set_pool_setting, set_creator_share, airdrop_fund,
  airdrop_start, airdrop_claim, airdrop_close, vesting_release, claim_referral and more). A refused
  tool says whether it was refused before anything was signed. With OSTRA_RELAYER_URL the agent needs
  no ETH. `test/mcp.fork.test.ts` drives the server over stdio on a fork.
- `aggregator/`: the aggregator service (`@ostraagent/aggregator`). It builds the shielded pool's
  batches: a depositor posts a leaf set of its pending deposit, signed (EIP-191) by its depositor
  key and checked against the deposit's amount after the pool fee, with that key and its deposit
  id (checked to derive the deposit key, so no event log is read and an RPC that limits
  eth_getLogs serves it), and polls it with an EIP-191 signature of the same key. A batch that
  does not seal has published its leaves, so each of its deposits must send a new leaf set (the
  next attempt) before it is batched again, and no two batches share a leaf; with at least
  8 deposits polled in the last 10 minutes it creates a batch, appends the leaves shuffled, seals it
  once every deposit approved within 15 minutes or abandons it, and forgets which leaf came from
  which deposit after the seal. A batch takes at most 43 deposits. `scripts/aggregator-check.ts` runs the aggregator
  process end to end with sixteen depositors in two groups of eight; its fork test runs it on a
  mainnet fork (it waits out the 900-second approval window once, about 20 minutes).
- `rpc-proxy/`: the RPC proxy for the web app (`@ostraagent/rpc-proxy`). It forwards one JSON-RPC
  request per POST to the private RPC (OSTRA_RPC_URL, never in an answer or a log line), only the
  eth_ reads and simulations core and the SDK call (eth_call, eth_simulateV1, eth_getLogs only for
  one channel's ChannelOpened logs over at most 10,000,000 blocks, and the like); anything that
  sends is refused (403), since the web app's transactions go through the relayer. Rates per
  client IP and in total (OSTRA_RPC_PROXY_PER_IP, OSTRA_RPC_PROXY_TOTAL) have no default; over a
  rate it answers 429 with Retry-After. The chain is checked by eth_chainId at start. Its tests run
  viem's calls through it against a mainnet fork.

## Running on mainnet

The contracts are deployed on Robinhood Chain mainnet; their addresses are in
`deployments/robinhood-mainnet.json` (the record the services read, from block 91991509). One
deployer account owns the beacons, the pool (treasury and init authority), the hook, the launchpad
and the dispatcher.

- `sdk/scripts/deploy.ts` deploys from the Foundry build with the deployer key in a 0600 file and
  writes the record; run again, it resumes or only checks. Its fork test runs it as on mainnet.
- `sdk/scripts/upgrade-owner.ts` makes the owner seed (encrypted under a passphrase typed without
  echo; never written in the clear), deploys OstraUpgradeOwner and hands both beacons to it, then
  schedules, cancels and executes calls. Its keychain is bound to the chain and the owner contract's
  address; a call is recorded before it is signed, and a signed call that did not land is sent again,
  identical, before anything new is signed, so no key signs twice (keep the state directory with the
  seed). One run at a time. Its fork test runs it against the live beacons.
- `sdk/scripts/upgrade-pool.ts` upgrades the pool to OstraPool version 2 with the beacon owner's key
  (only an empty pool), compares every pool setting before and after, and rewrites
  `poolImplementation` in the record; run again, it only checks. Its fork test upgrades the live
  pool on a mainnet fork.
- `relayer/scripts/setup-mainnet.ts` then creates the services' keys under `/etc/ostra/robinhood`
  (0700), the operator vault (the keeper fee recipient) and the relayer's seller vault with the
  keeper crank, tops up the keeper, relayer and aggregator accounts with ETH from the deployer, and
  writes each service's environment file (0600). Run again, it sends nothing. Its fork test starts
  every service from those files.
- `ops/systemd/` holds the services' units and `ops/nginx/ostra-robinhood.conf` the server blocks of
  relayer., keeper., aggregator. and rpc.ostraagent.xyz behind Cloudflare (proxied DNS, so the VPS
  address is in no public record): `ops/nginx/render-cloudflare.py` renders it with Cloudflare's
  published ranges, nginx serves only connections from them (any other is closed), takes the client
  address from CF-Connecting-IP on those alone and passes it to the relayer and the RPC proxy for
  their rates, and serves TLS with a Cloudflare origin certificate whose key was made on the VPS.

The fork tests fork mainnet through `OSTRA_FORK_RPC` (default the public RPC, which drops the fork
block's state after some minutes; an archive RPC keeps it). Its URL may carry an API key, so it is
never printed: anvil's errors are passed on with it replaced. `core/test/recover-logs.test.ts` runs
against mainnet itself with `OSTRA_LIMITED_RPC`, an RPC that limits eth_getLogs (Alchemy Free: 10
blocks a request), and checks that channel recovery still reads every log window.

```
node vectors/generate.ts   # vectors from the SDK (OSTRA_SDK_SRC, default /srv/apps/ostra/sdk/src)
forge test -vv             # Vault.fork.t.sol forks Robinhood Chain mainnet (rpc_endpoints.robinhood)
cd sdk && npm ci && npm run typecheck && npm test   # needs forge build (../out) and anvil
node scripts/abi.ts        # in sdk/: rewrite src/abi.ts after a contract change
cd keeper && npm ci && npm run typecheck && npm test   # after the sdk's npm ci; needs ../out and anvil
cd merchant && npm ci && npm run typecheck && npm test   # after the sdk's and the keeper's npm ci
cd relayer && npm ci && npm run typecheck && npm test   # after the sdk's, the keeper's and the merchant's npm ci
cd aggregator && npm ci && npm run typecheck && npm test   # after the sdk's npm ci; needs ../out and anvil
cd core && npm ci && npm run typecheck && npm test   # after the sdk's, the keeper's, the merchant's, the relayer's and the aggregator's npm ci
cd mcp && npm ci && npm run typecheck && npm test   # after the core's npm ci
cd rpc-proxy && npm ci && npm run typecheck && npm test   # after the sdk's, the merchant's and the core's npm ci; needs anvil
```
