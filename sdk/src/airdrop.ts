// OstraAirdrop rounds: the leaves and the merkle tree a creator starts a round
// with, and each account's proof. A leaf is hashed as in OpenZeppelin's
// StandardMerkleTree: keccak256(keccak256(abi.encode(bytes32 poolId, uint256
// round, address account, uint256 amount))); pairs hash sorted, as MerkleProof
// verifies. The tree's shape is this module's own (leaves sorted, a node
// without a sibling moves up), so its root is not @openzeppelin/merkle-tree's
// for the same entries; any proof it gives verifies on chain.

import { concat, encodeAbiParameters, getAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";

export type AirdropEntry = { account: Address; amount: bigint };

export type AirdropTree = {
  root: Hex;
  /** What the entries add up to: the round's amount (airdropRoundAmountParams). */
  total: bigint;
  /** Each account's amount and proof, by checksummed address. */
  claims: ReadonlyMap<Address, { amount: bigint; proof: Hex[] }>;
};

const LEAF_TYPES = [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }] as const;

/** OstraAirdrop.leaf: `account`'s `amount` in round `round` of the pool. */
export function airdropLeaf(poolId: Hex, round: bigint, account: Address, amount: bigint): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) throw new RangeError("poolId must be 32 bytes");
  return keccak256(keccak256(encodeAbiParameters(LEAF_TYPES, [poolId, round, account, amount])));
}

function pair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * The tree of round `round` (the pool's next round number: OstraAirdrop.round's
 * number + 1) sharing `entries`: one per account, every amount above zero.
 */
export function airdropTree(poolId: Hex, round: bigint, entries: readonly AirdropEntry[]): AirdropTree {
  if (round < 1n) throw new RangeError("round must be at least 1");
  if (entries.length === 0) throw new RangeError("an airdrop needs at least one account");
  const seen = new Set<Address>();
  let total = 0n;
  const leaves = entries.map((e) => {
    const account = getAddress(e.account);
    if (account === zeroAddress) throw new RangeError("account must not be the zero address");
    if (seen.has(account)) throw new RangeError(`${account} appears twice`);
    seen.add(account);
    if (e.amount <= 0n) throw new RangeError("every amount must be greater than zero");
    total += e.amount;
    return { account, amount: e.amount, leaf: airdropLeaf(poolId, round, account, e.amount) };
  });
  leaves.sort((x, y) => (BigInt(x.leaf) < BigInt(y.leaf) ? -1 : 1));
  // Levels from the leaves up; a node without a sibling moves up as it is.
  const levels: Hex[][] = [leaves.map((l) => l.leaf)];
  while (levels[levels.length - 1]!.length > 1) {
    const level = levels[levels.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i]!, level[i + 1]!) : level[i]!);
    levels.push(next);
  }
  const claims = new Map<Address, { amount: bigint; proof: Hex[] }>();
  leaves.forEach((l, index) => {
    const proof: Hex[] = [];
    let i = index;
    for (let d = 0; d < levels.length - 1; ++d) {
      const level = levels[d]!;
      const sibling = i ^ 1;
      if (sibling < level.length) proof.push(level[sibling]!);
      i >>= 1;
    }
    claims.set(l.account, { amount: l.amount, proof });
  });
  return { root: levels[levels.length - 1]![0]!, total, claims };
}
