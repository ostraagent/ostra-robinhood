// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {OstraVaultV3} from "./OstraVaultV3.sol";

/// @title OstraVaultV5
/// @notice The state OstraVault version 5 adds (the agent key, the policy that bounds it, the allowlists, the budget
///         and the standing orders), kept at its own ERC-7201 slot so that OstraVault and the module it runs its
///         version 5 spends in (OstraVaultModuleV5) read and write the same fields; and the helpers both use. The
///         storage of versions 1 to 4 is untouched.
///
/// Changes follow the version 3 rule: a change that only tightens takes effect at once (and drops a loosening still
/// waiting); a change that loosens takes effect at once while the withdrawal lock is off, and otherwise only the lock's
/// delay after it was signed, and meanwhile the owner (CancelPendingChanges), a guardian or the withdrawal address
/// (guard op 0) or a guardian recovery that starts drops it. Allowlist entries use version 4's cancel epochs.
library OstraVaultV5 {
    /// @notice Allowlist kinds: a recipient (Transfer, PAY orders, a Swap's recipient other than this vault; the agent
    ///         key's ClaimDividend goes only to this vault or its linked vault), an x402 channel receiver, a Uniswap v4
    ///         pool (its PoolId), a Morpho Vault V2 to Lend into and Redeem from, a Priors root to be sponsored by (its
    ///         agent id), an agent the agent key may give a line from this vault's Priors root (its agent id).
    uint8 internal constant ALLOW_RECIPIENT = 1;
    uint8 internal constant ALLOW_CHANNEL = 2;
    uint8 internal constant ALLOW_POOL = 3;
    uint8 internal constant ALLOW_LEND = 4;
    uint8 internal constant ALLOW_SPONSOR = 5;
    uint8 internal constant ALLOW_BORROWER = 6;

    /// @notice Standing order kinds.
    uint8 internal constant ORDER_SWEEP = 1;
    uint8 internal constant ORDER_REFILL = 2;
    uint8 internal constant ORDER_PAY = 3;

    /// @notice The budget refills over this time, as the withdrawal lock's daily limit does.
    uint256 internal constant LIMIT_WINDOW = 1 days;

    /// @notice What bounds the agent key and the standing orders (and, for the Priors fields, every Priors spend).
    ///         All zero (the state after the upgrade): the agent key can do nothing, no order runs, no Priors loan.
    struct Policy {
        /// @dev Bit `a` set: the agent key may use action `a` (only within OstraVaultModuleV5.AGENT_ACTIONS).
        uint64 actions;
        /// @dev The most one agent spend or one order run may count, in this vault's token.
        uint128 perTx;
        /// @dev The most that may be counted at once; what was counted drains at `daily` per LIMIT_WINDOW.
        uint128 daily;
        /// @dev Priors: the most principal an agent this vault owns may owe (0: no borrowing).
        uint128 maxDebt;
        /// @dev Priors: the longest term of a loan.
        uint32 maxTerm;
        /// @dev Priors: the most fee (base and sponsor premium) per 30 days of term, in basis points of principal; also
        ///      the most premium a consent may allow.
        uint16 maxFeeBps;
        /// @dev Priors: open principal at most `coverBps` of the escrowed OstraPad budgets this vault provides
        ///      (0: no cover needed).
        uint16 coverBps;
        /// @dev Priors: how long before a loan is due anyone may repay it from this vault (0: one day).
        uint32 repayLead;
        /// @dev Priors: the venue (version 4 kind and address) a repay that is short exits first (0: none).
        uint8 repayKind;
        address repayVenue;
        /// @dev Priors root: the largest line one agent may hold from this vault's root.
        uint128 vouchPerAgent;
        /// @dev Priors root: the most this vault's root may vouch in all.
        uint128 vouchTotal;
        /// @dev Priors root: the highest premium this vault's root charges.
        uint16 maxPremiumBps;
    }

    struct Allow {
        /// @dev When the entry takes effect; 0 = not on the list.
        uint64 from;
        /// @dev The cancel epoch it was added in.
        uint64 epoch;
    }

    struct Order {
        /// @dev ORDER_SWEEP, ORDER_REFILL or ORDER_PAY; 0 = none.
        uint8 kind;
        /// @dev SWEEP and REFILL: the version 4 venue kind.
        uint8 venueKind;
        /// @dev The shortest time between two runs.
        uint32 interval;
        /// @dev PAY: runs left (the order ends after the last).
        uint32 runsLeft;
        uint64 lastRun;
        /// @dev No run from then on (0: none).
        uint64 endAt;
        /// @dev The order epoch it was set in: it runs only while that is the current one.
        uint64 epoch;
        /// @dev SWEEP and REFILL: the venue; PAY: the recipient.
        address target;
        /// @dev Set by the agent key: the agent key generation that set it (it runs only while that key is in force);
        ///      0: set by the owner.
        uint32 agentGen;
        /// @dev SWEEP and REFILL: the most one run moves; PAY: what one run pays.
        uint128 amount;
        /// @dev SWEEP: the balance kept; REFILL: the balance refilled to.
        uint128 threshold;
    }

    /// @custom:storage-location erc7201:ostra.vault.v5
    struct Layout {
        /// @dev The agent key: root of its current one-time key (0: none), the nonce of its next spend, from when and
        ///      until when it may sign.
        bytes32 agentRoot;
        uint64 agentNonce;
        uint64 agentFrom;
        uint64 agentExpiry;
        Policy policy;
        Policy pendingPolicy;
        /// @dev When the waiting policy takes effect; 0 = none waiting.
        uint64 pendingPolicyAt;
        /// @dev What the agent key and the orders counted, as of `budgetAt`; it drains at `policy.daily` a day.
        uint64 budgetAt;
        uint128 budgetUsed;
        mapping(bytes32 key => Allow) allows;
        /// @dev The current cancel epoch of the allowlist, the latest time an entry of it takes effect, and when each
        ///      ended epoch ended (OstraVaultV4's pattern).
        uint64 epoch;
        uint64 waitingUntil;
        mapping(uint64 epoch => uint64) endedAt;
        mapping(uint256 id => Order) orders;
        uint64 orderCount;
        uint64 orderEpoch;
        /// @dev Priors loans this vault borrowed itself (PriorsBorrow): the only loans it ever repays.
        mapping(uint256 loanId => bool) ownLoans;
        /// @dev Advances with every SetAgentKey and every end of the agent key: the orders an agent key set run only in
        ///      its own generation.
        uint32 agentGen;
        /// @dev The Priors consent still waiting (its digest, approved for EIP-1271 from `pendingConsentAt`), which the
        ///      cancels drop; one at a time.
        bytes32 pendingConsent;
        uint64 pendingConsentAt;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("ostra.vault.v5")) - 1)) & ~bytes32(uint256(0xff)) (ERC-7201).
    bytes32 internal constant SLOT = 0x08a2d09332cd6f2fc6deb9ea94fe2d0f53207701b1a66b5a4c0e51e4ea1c3c00;

    event PolicySet(Policy policy, uint64 effectiveAt);
    event AllowSet(uint8 indexed kind, bytes32 indexed value, bool allowed, uint64 effectiveAt);
    event AgentKeySet(bytes32 indexed root, uint64 from, uint64 expiry);
    event AgentKeyRevoked(address indexed by);
    /// @notice The version 5 changes still waiting were dropped, by the owner (`by` zero), by `by` (a guardian or the
    ///         withdrawal address), or by a guardian recovery that started (`by` the vault itself).
    event WaitingV5Cancelled(address indexed by);
    /// @notice Every standing order was cancelled: by a guardian or the withdrawal address (guard op 7), a recovery (`by`
    ///         the vault itself), or the owner's CancelOrder of id 0 (`by` zero).
    event OrdersStopped(address indexed by);
    event Counted(uint256 amount, uint128 used);

    error OverBudget(uint256 available);
    error OverPerTx(uint256 perTx);

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            l.slot := slot
        }
    }

    function allowKey(uint8 kind, bytes32 value) internal pure returns (bytes32) {
        return keccak256(abi.encode(kind, value));
    }

    /// @dev Makes the waiting policy current when its wait is over.
    function applyPending(Layout storage l) internal {
        uint64 at = l.pendingPolicyAt;
        if (at != 0 && block.timestamp >= at) {
            l.policy = l.pendingPolicy;
            delete l.pendingPolicy;
            l.pendingPolicyAt = 0;
            emit PolicySet(l.policy, at);
        }
    }

    /// @dev The policy in force now (a waiting one whose wait is over counts as made).
    function current(Layout storage l) internal view returns (Policy memory) {
        uint64 at = l.pendingPolicyAt;
        return at != 0 && block.timestamp >= at ? l.pendingPolicy : l.policy;
    }

    function allowed(Layout storage l, uint8 kind, bytes32 value) internal view returns (bool) {
        Allow storage a = l.allows[allowKey(kind, value)];
        uint64 from = a.from;
        if (from == 0 || block.timestamp < from) return false;
        uint64 e = a.epoch;
        return e == l.epoch || from <= l.endedAt[e];
    }

    function agentInForce(Layout storage l) internal view returns (bool) {
        return l.agentRoot != bytes32(0) && block.timestamp >= l.agentFrom && block.timestamp < l.agentExpiry;
    }

    /// @dev Whether a version 5 change is still waiting: a policy, an agent key, an allowlist entry, a Priors consent.
    function waiting(Layout storage l) internal view returns (bool) {
        return l.pendingPolicyAt > block.timestamp || (l.agentRoot != bytes32(0) && l.agentFrom > block.timestamp)
            || l.waitingUntil > block.timestamp || l.pendingConsentAt > block.timestamp;
    }

    /// @dev Drops every version 5 change still waiting (those whose wait is over are made first).
    function cancelWaiting(Layout storage l, address by) internal {
        applyPending(l);
        delete l.pendingPolicy;
        l.pendingPolicyAt = 0;
        if (l.agentRoot != bytes32(0) && l.agentFrom > block.timestamp) revokeAgent(l, by);
        if (l.waitingUntil > block.timestamp) {
            uint64 e = l.epoch;
            l.endedAt[e] = uint64(block.timestamp);
            l.epoch = e + 1;
            l.waitingUntil = 0;
        }
        dropConsent(l, by);
        emit WaitingV5Cancelled(by);
    }

    /// @dev Withdraws the Priors consent still waiting, if any (a version 3 hash approval of this approval epoch).
    function dropConsent(Layout storage l, address by) internal {
        if (l.pendingConsentAt > block.timestamp) {
            OstraVaultV3.Layout storage l3 = OstraVaultV3.layout();
            bytes32 key = OstraVaultV3.approvalKey(l3, l.pendingConsent);
            if (l3.hashValidFrom[key] != 0) {
                delete l3.hashValidFrom[key];
                emit OstraVaultV3.HashRevoked(l.pendingConsent, by);
            }
        }
        l.pendingConsent = bytes32(0);
        l.pendingConsentAt = 0;
    }

    /// @dev Ends the agent key: its root goes, and its nonce moves on so that nothing it signed can ever count.
    function revokeAgent(Layout storage l, address by) internal {
        l.agentRoot = bytes32(0);
        l.agentFrom = 0;
        l.agentExpiry = 0;
        ++l.agentNonce;
        ++l.agentGen;
        emit AgentKeyRevoked(by);
    }

    /// @dev Whether order `o` may run now as far as its setter goes: the owner's always; the agent key's only while the
    ///      key generation that set it is in force.
    function setterLive(Layout storage l, Order storage o) internal view returns (bool) {
        uint32 g = o.agentGen;
        return g == 0 || (g == l.agentGen && agentInForce(l));
    }

    /// @dev Ends every standing order.
    function stopOrders(Layout storage l, address by) internal {
        ++l.orderEpoch;
        emit OrdersStopped(by);
    }

    /// @dev What the agent key and the orders counted, as of now.
    function used(Layout storage l, uint128 daily) internal view returns (uint256) {
        uint256 drained = (block.timestamp - l.budgetAt) * uint256(daily) / LIMIT_WINDOW;
        uint256 u = l.budgetUsed;
        return u > drained ? u - drained : 0;
    }

    /// @dev Counts `amount` against `p`'s per-spend and daily bounds.
    function count(Layout storage l, Policy memory p, uint256 amount) internal {
        if (amount == 0) return;
        if (amount > p.perTx) revert OverPerTx(p.perTx);
        uint256 u = used(l, p.daily);
        uint256 total = u + amount;
        if (total > p.daily) revert OverBudget(p.daily > u ? p.daily - u : 0);
        l.budgetUsed = uint128(total);
        l.budgetAt = uint64(block.timestamp);
        emit Counted(amount, uint128(total));
    }
}
