# Ostra on Robinhood Chain

Ostra Agent's contracts for Robinhood Chain (chain ID 4663), ported from the Solana program in
`ostraagent/ostra` with the same behavior. The design is "Agent Ostra — Rancangan v0.4".

Current contents: the WOTS verifier and the LtHash accumulator, byte-compatible with the Solana
program and the Ostra TypeScript SDK, with tests against vectors made by that SDK and gas
measurements.

```
node vectors/generate.ts   # vectors from the SDK (OSTRA_SDK_SRC, default /srv/apps/ostra/sdk/src)
forge test -vv
```
