# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open this repository's **Security** tab and choose
**Report a vulnerability**, or go to
https://github.com/ostraagent/ostra-robinhood/security/advisories/new.

Do not open a public issue, pull request or discussion about a vulnerability, and do not test against
funds on mainnet that are not your own. A fork of Robinhood Chain mainnet (chain 4663) runs every
Ostra contract exactly as deployed; the fork tests in this repository show how to set one up.

A useful report names the affected contract or component, the commit or deployed address, the impact,
and the steps or a test that reproduce it.

## Scope

In scope:

- The Ostra contracts deployed on Robinhood Chain, listed in the README and at
  https://docs.ostraagent.xyz/contracts, and their source in `src/`.
- OstraUpgradeOwner and the script that operates it.
- The SDK, the MCP server and the services in this repository: relayer, aggregator, keeper, merchant
  and core.

Out of scope:

- Contracts Ostra uses but does not own: the Uniswap v4 PoolManager, USDG, WETH, the Robinhood stock
  registry, Chainlink feeds, the payment-channel settlement contract, and Robinhood Chain itself.
  Report those to their maintainers.
- The limits already stated at https://docs.ostraagent.xyz/security#known, unless a report shows one
  is worse than stated there.

## How fixes are deployed

The launchpad contracts are not upgradeable. The code of the vaults and of the shielded pool changes
only through OstraUpgradeOwner, which publishes every call on chain 72 hours before it can run, so a
fix to them is public for 72 hours before it takes effect. Keep a report private until its fix has run.

## Audit status

The contracts have not been audited by an outside firm. See https://docs.ostraagent.xyz/security for
every key with a power and what it can and cannot do.
