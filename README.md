# Ostra on Robinhood Chain

Ostra Agent's contracts for Robinhood Chain (chain ID 4663), ported from the Solana program in
`ostraagent/ostra` with the same behavior. The design is "Agent Ostra — Rancangan v0.4".

Contents:

- `src/Wots.sol`, `src/LtHash.sol`: the WOTS verifier and the LtHash accumulator, byte-compatible
  with the Solana program and the Ostra TypeScript SDK, tested against vectors made by that SDK.
- `src/OstraVault.sol`, `src/OstraVaultFactory.sol`: vaults spent only with rotating WOTS keys
  (Transfer, OpenChannel, SetCrankKey), as beacon proxies at addresses fixed by token, initial key
  root and initial crank. Channels are x402 batch-settlement channels on the deployed
  x402BatchSettlement; a seller vault is the channels' receiverAuthorizer, so only its crank claims
  vouchers and refunds unclaimed escrow.
- `src/OstraSplit.sol`: the receiver of a seller's channels, paying fixed bps shares (the keeper fee)
  and the rest to the seller vault.
- `src/OstraPool.sol`: the shielded pool for one token. Deposits (also relayed with EIP-3009), batches
  of one-leaf-each leaves checked with LtHash, WOTS approvals, sealing, WOTS leaf spends, refunds after
  48 hours. `test/Pool.fork.t.sol` runs it on the mainnet fork with the real USDG.
- `sdk/`: the TypeScript SDK (`@ostraagent/sdk`, viem). WOTS, LtHash and leaves as on Solana; the
  messages, ids and addresses the contracts compute (spend, approval, leaf, deposit nonce, close
  request, channel id, voucher, vault address); reads of vaults, the pool, batches and channels; the
  aggregator wire format and EIP-191 polls; and `deployOstra`, which deploys the contracts from the
  Foundry build. Its fork tests run every message against the contracts on a fork of mainnet.
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
  (one call, or several sent through Multicall3); the relayer checks them against its policy,
  prices the transaction (eth_estimateGas x gas price + 10%, at Chainlink ETH/USD + 0.5%), charges
  it as an Ostra seller through `merchant/` and sends it from its own account, so agents need no
  ETH. createVault, a leaf spent into a vault, unshield and an open to the relayer are relayed
  before payment as the vault's debt; WOTS signatures are escrowed before anything is simulated.
  `scripts/chain-check.ts` runs the keeper and the relayer end to end with an agent that holds no
  ETH; its fork test runs it on a mainnet fork.
- `core/`: Ostra Agent's logic shared by the MCP package and the web app (`@ostraagent/core`),
  browser-safe, with records behind a storage interface: the keys derived from the master seed,
  the buyer, seller and private vaults (open, withdraw, open a channel, change the crank), the
  relayer client that pays the relayer with vouchers of the vault's channel to it, channels from
  the vault to Ostra sellers (closed on the payer path: requestClose, then finalizeWithdraw after
  the grace period), session keys, shield and unshield. `scripts/chain-check.ts` runs it end to end
  against the keeper, the relayer and a seller server; its fork test runs it on a mainnet fork.
  `test/shield.fork.test.ts` runs shield and unshield against the aggregator on a fork.
- `aggregator/`: the aggregator service (`@ostraagent/aggregator`). It builds the shielded pool's
  batches: a depositor posts the leaves of its pending deposit (checked against the on-chain
  commitment and amount) and polls it with an EIP-191 signature of its depositor key; with at least
  8 deposits polled in the last 10 minutes it creates a batch, appends the leaves shuffled, seals it
  once every deposit approved within 15 minutes or abandons it, and forgets which leaf came from
  which deposit after the seal. A batch takes at most 43 deposits, so its sealBatch transaction
  stays under the sequencer's 95,000-byte limit. `scripts/aggregator-check.ts` runs the aggregator
  process end to end with eight depositors; its fork test runs it on a mainnet fork (it waits out
  the 900-second approval window once, about 20 minutes).

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
```
