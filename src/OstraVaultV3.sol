// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice What a vault checks of another address it pays or acts for: whether OstraVaultFactory made it
///         (OstraVaultFactory.vaultAddress of its own creation parameters), and its lock and link.
interface IOstraVaultFactory {
    function vaultAddress(address token, bytes32 initialKeyRoot, address initialCrank) external view returns (address);
}

interface IOstraVaultView {
    function token() external view returns (address);
    function initialKeyRoot() external view returns (bytes32);
    function initialCrank() external view returns (address);
    function lockActive() external view returns (bool);
    function lockedSince() external view returns (uint64);
    function linkedVault() external view returns (address);
}

/// @title OstraVaultV3
/// @notice The state OstraVault version 3 adds (the withdrawal lock, the linked vault and EIP-1271 approvals), kept
///         at its own ERC-7201 slot so that OstraVault and the module it delegates its version 3 spends to
///         (OstraVaultModule) read and write the same fields whatever else either declares; and the helpers both
///         use. The storage of versions 1 and 2 is untouched.
library OstraVaultV3 {
    /// @notice A withdrawal lock: on while `withdrawal` is not zero.
    struct LockConfig {
        address withdrawal;
        uint32 delay;
        uint128 dailyLimit;
    }

    /// @custom:storage-location erc7201:ostra.vault.v3
    struct Layout {
        LockConfig lock;
        LockConfig pendingLock;
        /// @dev When the waiting lock change takes effect; 0 = none waiting.
        uint64 pendingLockAt;
        address linkedVault;
        address pendingLinkedVault;
        /// @dev When the waiting link change takes effect; 0 = none waiting.
        uint64 pendingLinkedAt;
        /// @dev What has gone out against the daily limit, as of `limitUpdatedAt`; it drains at `dailyLimit` a day.
        uint64 limitUpdatedAt;
        uint128 limitUsed;
        /// @dev From when an approved hash is valid for EIP-1271, per approval epoch (approvalKey); 0 = not approved.
        mapping(bytes32 key => uint64) hashValidFrom;
        /// @dev Advances when the lock is turned on and when a recovery starts or finishes: every earlier approval
        ///      stops counting.
        uint64 approvalsEpoch;
        /// @dev When the lock was last turned on (it stays on from then while `lock.withdrawal` is not zero).
        uint64 lockedSince;
        /// @dev When the link in `linkedVault` was decided: set at once, or scheduled (a link scheduled under the
        ///      lock takes effect only its delay later).
        uint64 linkedSince;
        /// @dev When the waiting link change was scheduled.
        uint64 pendingLinkedScheduledAt;
        /// @dev When the withdrawal address in force was chosen (the lock turned on, or the change scheduled).
        uint64 withdrawalSince;
        /// @dev When the waiting lock change was scheduled.
        uint64 pendingLockScheduledAt;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("ostra.vault.v3")) - 1)) & ~bytes32(uint256(0xff)) (ERC-7201).
    bytes32 internal constant SLOT = 0xa5f7403588609e9a874083e27e411b9dcd802294b9dfdf2360eac48028015400;

    /// @notice The daily limit refills over this time: at most `dailyLimit` goes out at once, and the used part
    ///         drains at `dailyLimit` per LIMIT_WINDOW, so no 24 hours see more than twice the limit.
    uint256 internal constant LIMIT_WINDOW = 1 days;
    /// @notice The lock's delay bounds: OstraVault's recovery delay bounds (MIN_RECOVERY_DELAY, MAX_RECOVERY_DELAY).
    uint32 internal constant MIN_LOCK_DELAY = 36 hours;
    uint32 internal constant MAX_LOCK_DELAY = 14 days;

    event Outflow(uint256 amount, uint128 used);
    event WithdrawalLockSet(address indexed withdrawal, uint32 delay, uint128 dailyLimit);
    event WithdrawalLockChangeScheduled(address indexed withdrawal, uint32 delay, uint128 dailyLimit, uint64 effectiveAt);
    event LinkedVaultSet(address indexed vault);
    event LinkedVaultChangeScheduled(address indexed vault, uint64 effectiveAt);
    /// @notice The waiting lock and link changes were dropped, by the vault's owner (`by` zero) or by `by`, a guardian.
    event PendingChangesCancelled(address indexed by);
    event HashApproved(bytes32 indexed hash, uint64 validFrom);
    /// @notice An approval was withdrawn, by the vault's owner (`by` zero) or by `by`, a guardian.
    event HashRevoked(bytes32 indexed hash, address indexed by);

    error OverDailyLimit(uint256 available);

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            l.slot := slot
        }
    }

    /// @dev Applies the lock and link changes whose wait is over.
    function applyPendingChanges(Layout storage l) internal {
        uint64 at = l.pendingLockAt;
        if (at != 0 && block.timestamp >= at) {
            LockConfig memory lock = l.pendingLock;
            if (lock.withdrawal != l.lock.withdrawal) l.withdrawalSince = l.pendingLockScheduledAt;
            l.lock = lock;
            delete l.pendingLock;
            l.pendingLockAt = 0;
            emit WithdrawalLockSet(lock.withdrawal, lock.delay, lock.dailyLimit);
        }
        at = l.pendingLinkedAt;
        if (at != 0 && block.timestamp >= at) {
            address v = l.pendingLinkedVault;
            l.linkedVault = v;
            l.linkedSince = l.pendingLinkedScheduledAt;
            l.pendingLinkedVault = address(0);
            l.pendingLinkedAt = 0;
            emit LinkedVaultSet(v);
        }
    }

    function cancelPendingChanges(Layout storage l, address by) internal {
        delete l.pendingLock;
        l.pendingLockAt = 0;
        l.pendingLinkedVault = address(0);
        l.pendingLinkedAt = 0;
        emit PendingChangesCancelled(by);
    }

    /// @dev The part of the daily limit used now: what was used at the last outflow, less what has drained since.
    function used(Layout storage l, uint128 dailyLimit) internal view returns (uint256) {
        uint256 drained = (block.timestamp - l.limitUpdatedAt) * uint256(dailyLimit) / LIMIT_WINDOW;
        uint256 u = l.limitUsed;
        return u > drained ? u - drained : 0;
    }

    /// @dev Counts `amount` of the vault's token against the lock's daily limit; nothing while the lock is off.
    function outflow(Layout storage l, uint256 amount) internal {
        LockConfig memory lock = l.lock;
        if (lock.withdrawal == address(0)) return;
        uint256 u = used(l, lock.dailyLimit);
        uint256 total = u + amount;
        if (total > lock.dailyLimit) revert OverDailyLimit(lock.dailyLimit > u ? lock.dailyLimit - u : 0);
        l.limitUsed = uint128(total);
        l.limitUpdatedAt = uint64(block.timestamp);
        emit Outflow(amount, uint128(total));
    }

    /// @dev Whether the withdrawal address in force keeps what it is sent locked, so a Transfer to it may be free:
    ///      anything that is not an Ostra vault (it does not answer lockedSince), or an Ostra vault whose own lock
    ///      was on when it was chosen and has stayed on (an unlocked vault may share the stolen seed).
    function withdrawalKeeps(Layout storage l) internal view returns (bool) {
        (bool ok, bytes memory r) = l.lock.withdrawal.staticcall(abi.encodeCall(IOstraVaultView.lockedSince, ()));
        if (!ok || r.length != 32) return true;
        uint256 since = uint256(bytes32(r));
        return since != 0 && since <= l.withdrawalSince;
    }

    /// @dev Where the approval of `hash` is kept in the current approval epoch.
    function approvalKey(Layout storage l, bytes32 hash) internal view returns (bytes32) {
        return keccak256(abi.encode(l.approvalsEpoch, hash));
    }

    /// @dev Whether `v` is the linked vault and counts as the owner's own under the lock: its lock was already on
    ///      when the link was decided (set, or scheduled) and has stayed on since. A lock turned on later, even
    ///      while the link waited, may be a thief's: turning a lock on is at once, and nobody can cancel it.
    function isLockedLink(Layout storage l, address v) internal view returns (bool) {
        if (v == address(0) || v != l.linkedVault || !IOstraVaultView(v).lockActive()) return false;
        uint64 since = IOstraVaultView(v).lockedSince();
        return since != 0 && since <= l.linkedSince;
    }

    /// @dev Whether `factory` made `v`: the vault address of `v`'s own creation parameters is `v` (no other contract
    ///      can sit at that CREATE2 address). False for anything that does not answer like a vault.
    function isOstraVault(IOstraVaultFactory factory, address v) internal view returns (bool) {
        if (v.code.length == 0) return false;
        (bool ok1, bytes memory t) = v.staticcall(abi.encodeCall(IOstraVaultView.token, ()));
        (bool ok2, bytes memory r) = v.staticcall(abi.encodeCall(IOstraVaultView.initialKeyRoot, ()));
        (bool ok3, bytes memory c) = v.staticcall(abi.encodeCall(IOstraVaultView.initialCrank, ()));
        if (!ok1 || !ok2 || !ok3 || t.length != 32 || r.length != 32 || c.length != 32) return false;
        uint256 tw = uint256(bytes32(t));
        uint256 cw = uint256(bytes32(c));
        if (tw >> 160 != 0 || cw >> 160 != 0) return false;
        return factory.vaultAddress(address(uint160(tw)), bytes32(r), address(uint160(cw))) == v;
    }
}
