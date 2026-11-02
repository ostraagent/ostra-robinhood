// Ostra Tide's shares with no payee, paid by OstraTide's owner (scripts/tide-pay.ts manual). A share goes into a week's
// tree with no payee when the link the score counted named none (a link made before MCP 0.1.16) or none counted by
// the link deadline. OstraTide lets only its owner pay such a share, to an OSTRA vault the owner names, until the week
// rolls over (rolloverAt: its root's time + HOLD). The owner names the vault the agent itself named afterwards: a link
// the index keeps whose set approval by the agent's identity vault took effect after the week's link deadline (one in
// force by then was read by the score), verified as the score verifies a link (src/tide-score.ts), read at the latest
// block:
//   * the agent's identity is still owned by the vault that registered it (the result's identity vault);
//   * that vault approves the link's set digest (hashValidFrom: approved, in force now, valid from a time after the
//     deadline); of several such links, the one valid from the latest time counts;
//   * the payee, as 0.1.16 names it: a vault of the link in OSTRA (with its member approval in force, unless it is the
//     identity vault itself) that OstraTide's factory made, or an address outside the link named by the createVault
//     params that make it with that factory in OSTRA (created before it is paid when it has no code yet; with code, it
//     must answer token() OSTRA); never one of Ostra's own vaults nor another agent's identity vault.
// Nothing here is signed: tide-pay records and sends what this finds.

import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { ERC8004_IDENTITY_REGISTRY, OSTRA, ostraVaultFactoryAbi, tideMemberDigest, tidePayeeCreation, tideSetDigest, tideSortVaults, tideViewKey, type TidePayeeCreation } from "@ostraagent/sdk";
import type { TideAgentResult, TideLinkRecord } from "./tide-score.ts";

const identityAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);
const vaultAbi = parseAbi(["function hashValidFrom(bytes32 hash) view returns (uint64)", "function token() view returns (address)", "function initialKeyRoot() view returns (bytes32)", "function initialCrank() view returns (address)"]);

/** One share with no payee: the vault the owner pays it to (and its creation params when it has no code yet), or why none. */
export type ManualShare = {
  agentId: string;
  amount: string;
  proof: Hex[];
  payee: Address | null;
  creation: TidePayeeCreation | null;
  /** When the counted link's set approval took effect (unix seconds), and its view key. */
  setApprovedAt: number | null;
  viewKey: Hex | null;
  why: string | null;
};

const noFunction = (err: unknown) => err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;

/** When `vault` approves `hash` from (hashValidFrom), or null when it does not, not yet, or cannot (a vault before version 3). */
async function validFrom(client: PublicClient, vault: Address, hash: Hex, now: number): Promise<number | null> {
  let from: bigint;
  try {
    from = (await client.readContract({ address: vault, abi: vaultAbi, functionName: "hashValidFrom", args: [hash] })) as bigint;
  } catch (err) {
    if (noFunction(err)) return null;
    throw err;
  }
  const t = Number(from);
  return t !== 0 && t <= now ? t : null;
}

/** The token `vault` answers, or null when it answers none (no code, or code without token()). */
async function tokenOf(client: PublicClient, vault: Address): Promise<Address | null> {
  const code = await client.getCode({ address: vault });
  if (code === undefined || code === "0x") return null;
  try {
    return getAddress((await client.readContract({ address: vault, abi: vaultAbi, functionName: "token" })) as Address);
  } catch (err) {
    if (noFunction(err)) return null;
    throw err;
  }
}

/**
 * The payee and creation params for each share in `leaves` (shares with no payee, not paid yet), from the links kept:
 * the vault the owner pays it to, or why there is none (the share is then left alone).
 */
export async function manualPayees(o: {
  client: PublicClient;
  /** OstraTide's FACTORY: the factory whose vaults it pays. */
  factory: Address;
  chainId: number;
  /** The week's link deadline (unix seconds): a set approval in force by then was read by the score. */
  linkDeadline: number;
  now: number;
  leaves: readonly { agentId: string; amount: string; proof: Hex[] }[];
  agents: readonly TideAgentResult[];
  links: readonly TideLinkRecord[];
  own: ReadonlySet<Address>;
}): Promise<ManualShare[]> {
  const identityVaults = new Set(o.agents.map((a) => getAddress(a.identityVault)));
  const deadline = new Date(o.linkDeadline * 1000).toISOString();
  const factoryVault = (token: Address, root: Hex, crank: Address) => o.client.readContract({ address: o.factory, abi: ostraVaultFactoryAbi, functionName: "vaultAddress", args: [token, root, crank] }) as Promise<Address>;
  const out: ManualShare[] = [];
  for (const l of o.leaves) {
    const none = (why: string): ManualShare => ({ agentId: l.agentId, amount: l.amount, proof: l.proof, payee: null, creation: null, setApprovedAt: null, viewKey: null, why });
    const agent = o.agents.find((a) => a.agentId === l.agentId);
    if (agent === undefined) {
      out.push(none("the agent is not in the week's result"));
      continue;
    }
    const identity = getAddress(agent.identityVault);
    let owner: Address;
    try {
      owner = getAddress((await o.client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [BigInt(l.agentId)] })) as Address);
    } catch (err) {
      if (!noFunction(err)) throw err;
      out.push(none("its ERC-8004 identity does not exist"));
      continue;
    }
    if (owner !== identity) {
      out.push(none(`its identity is now owned by ${owner}, not its identity vault ${identity}`));
      continue;
    }
    const tried: string[] = [];
    let best: { payee: Address; creation: TidePayeeCreation | null; setFrom: number; at: number; viewKey: Hex } | null = null;
    for (const r of o.links.filter((x) => x.agentId === l.agentId)) {
      if (r.payee === null) {
        tried.push("a link that names no payee");
        continue;
      }
      const payee = getAddress(r.payee);
      const list = tideSortVaults([...r.vaults, identity]);
      const outside = !list.includes(payee);
      const setFrom = await validFrom(o.client, identity, tideSetDigest({ chainId: o.chainId, agentId: l.agentId, vaults: list, payee, secret: r.secret, outsidePayee: outside }), o.now);
      if (setFrom === null) {
        tried.push(`the identity vault ${identity} has no approval of a link's set digest naming ${payee} in force now`);
        continue;
      }
      if (setFrom <= o.linkDeadline) {
        tried.push(`the link naming ${payee} was in force by the link deadline ${deadline}: the score read it`);
        continue;
      }
      if (o.own.has(payee) || (payee !== identity && identityVaults.has(payee))) {
        tried.push(`${payee} is ${o.own.has(payee) ? "one of Ostra's own vaults" : "another agent's identity vault"}`);
        continue;
      }
      let creation: TidePayeeCreation | null = null;
      if (outside) {
        let c: TidePayeeCreation;
        try {
          c = tidePayeeCreation(r.payeeCreation);
        } catch {
          tried.push(`the payee ${payee} is not a vault of the link, and the link names no OSTRA vault's creation params`);
          continue;
        }
        if (getAddress(await factoryVault(OSTRA, c.initialKeyRoot, c.initialCrank)) !== payee) {
          tried.push(`the creation params of ${payee} create another vault with OstraTide's factory`);
          continue;
        }
        const token = await tokenOf(o.client, payee);
        if (token !== null && token !== OSTRA) {
          tried.push(`${payee} is not an OSTRA vault`);
          continue;
        }
        if (token === null) creation = c;
      } else {
        if ((await tokenOf(o.client, payee)) !== OSTRA) {
          tried.push(`${payee} is not an OSTRA vault`);
          continue;
        }
        const [root, crank] = await Promise.all([
          o.client.readContract({ address: payee, abi: vaultAbi, functionName: "initialKeyRoot" }) as Promise<Hex>,
          o.client.readContract({ address: payee, abi: vaultAbi, functionName: "initialCrank" }) as Promise<Address>,
        ]);
        if (getAddress(await factoryVault(OSTRA, root, crank)) !== payee) {
          tried.push(`${payee} is not a vault of OstraTide's factory`);
          continue;
        }
        if (payee !== identity && (await validFrom(o.client, payee, tideMemberDigest({ chainId: o.chainId, agentId: l.agentId, vault: payee, secret: r.secret }), o.now)) === null) {
          tried.push(`${payee} has no approval of its member digest in force now`);
          continue;
        }
      }
      if (best === null || setFrom > best.setFrom || (setFrom === best.setFrom && r.at > best.at)) best = { payee, creation, setFrom, at: r.at, viewKey: tideViewKey(r.secret) };
    }
    if (best === null) {
      out.push(none(tried.length === 0 ? `no link made after the link deadline ${deadline}` : `no link made after the link deadline ${deadline} counts: ${[...new Set(tried)].join("; ")}`));
      continue;
    }
    out.push({ agentId: l.agentId, amount: l.amount, proof: l.proof, payee: best.payee, creation: best.creation, setApprovedAt: best.setFrom, viewKey: best.viewKey, why: null });
  }
  return out;
}
