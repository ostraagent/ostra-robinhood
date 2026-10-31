// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title OstraVaultV4
/// @notice The state OstraVault version 4 adds (the venues a vault enabled, with what it pinned of each), kept at its
///         own ERC-7201 slot so that OstraVault and the module it runs its version 4 spends in (OstraVaultModuleV4)
///         read and write the same fields; and the helpers both use. The storage of versions 1 to 3 is untouched.
///
/// A venue is a (kind, address) pair. Its kind is code in OstraVaultModuleV4 that calls only that kind's fixed
/// functions, always names this vault as the receiver and reads the position itself; the address is what the owner
/// enabled with a SetVenue spend. Under the withdrawal lock an enable waits the lock's delay, and a cancel (the owner's
/// CancelPendingChanges, guard op 0) or a guardian recovery that starts meanwhile drops it: each such event ends the
/// current cancel epoch, and an enable scheduled in an epoch that ended before the enable took effect never counts.
library OstraVaultV4 {
    /// @notice A Raeto USDG vault (RaetoVault): deposit(amount), withdrawTo(amount, this vault); position
    ///         principalOf(this vault).
    uint8 internal constant RAETO_USDG = 1;
    /// @notice A Raeto stock vault (RaetoStockVault): deposit(amount), withdrawTo(shares, this vault, minStockOut, 0)
    ///         and claimLiquidation(); position stockOf(this vault).
    uint8 internal constant RAETO_STOCK = 2;
    /// @notice An ERC-4626 vault (Spark Savings USDG first): deposit(assets, this vault), redeem(shares, this vault,
    ///         this vault); position convertToAssets(balanceOf(this vault)).
    uint8 internal constant ERC4626 = 3;

    struct Venue {
        /// @dev The owner's last SetVenue for it.
        bool enabled;
        /// @dev An Enter into it landed once: Exit stays allowed after it is disabled.
        bool entered;
        /// @dev When the enable takes effect (at once, or the lock's delay after it was signed).
        uint64 from;
        /// @dev The cancel epoch it was enabled in.
        uint64 epoch;
        /// @dev The venue's code hash when it was enabled: other code is refused for Enter and trips the breaker.
        bytes32 codeHash;
        /// @dev ERC4626: the implementation getImplementation() answered when it was enabled (0: none).
        ///      RAETO_USDG: its source() when it was enabled.
        address pinned;
        /// @dev RAETO_USDG: its dustTolerance() when it was enabled (at most MAX_TOLERANCE).
        uint64 tolerance;
        /// @dev ERC4626: the highest share price this vault read of it (price(): assets of PRICE_SCALE whole shares).
        uint256 priceMark;
    }

    /// @custom:storage-location erc7201:ostra.vault.v4
    struct Layout {
        mapping(bytes32 key => Venue) venues;
        /// @dev The current cancel epoch.
        uint64 epoch;
        /// @dev The latest time an enable of the current epoch takes effect (0: none waiting).
        uint64 waitingUntil;
        /// @dev When each ended epoch ended.
        mapping(uint64 epoch => uint64) endedAt;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("ostra.vault.v4")) - 1)) & ~bytes32(uint256(0xff)) (ERC-7201).
    bytes32 internal constant SLOT = 0x041142257ce3186a412fed729b7a3ab63ef6a55d4358e7ac1bc4b2f6a8b54400;

    /// @notice The most a venue's rounding may be counted at, in the vault token's smallest units.
    uint64 internal constant MAX_TOLERANCE = 1_000;

    event VenueSet(uint8 indexed kind, address indexed venue, bool enabled, uint64 effectiveAt);
    /// @notice The venue enables still waiting were dropped, by the vault's owner (`by` zero), by `by` (a guardian or
    ///         the withdrawal address), or by a guardian recovery that started (`by` the vault itself).
    event WaitingVenuesCancelled(address indexed by);
    event Entered(uint8 indexed kind, address indexed venue, uint256 amount, uint256 positionGain);
    event Exited(uint8 indexed kind, address indexed venue, uint256 amount, uint256 received, address indexed by);
    /// @notice A version 4 spend (26 Enter, 27 Exit) failed and moved nothing; `reason` is its error's selector.
    event VenueFailed(uint8 indexed action, bytes4 reason);
    event Forwarded(address indexed token, address indexed to, uint256 amount);
    /// @notice The breaker brought a position home: `reasons` is what it found (CODE, IMPLEMENTATION, SOURCE, LTV).
    event VenueTripped(uint8 indexed kind, address indexed venue, uint8 reasons, uint256 amount, address indexed by);

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            l.slot := slot
        }
    }

    function key(uint8 kind, address venue) internal pure returns (bytes32) {
        return keccak256(abi.encode(kind, venue));
    }

    /// @dev Whether the enable of `v` is in force now: enabled, its wait over, and not dropped before it took effect.
    function inForce(Layout storage l, Venue storage v) internal view returns (bool) {
        if (!v.enabled || block.timestamp < v.from) return false;
        uint64 e = v.epoch;
        return e == l.epoch || v.from <= l.endedAt[e];
    }

    /// @dev Whether an enable is still waiting in the current epoch.
    function waiting(Layout storage l) internal view returns (bool) {
        return l.waitingUntil > block.timestamp;
    }

    /// @dev Drops every enable still waiting (those already in force stay): ends the current epoch.
    function cancelWaiting(Layout storage l, address by) internal {
        uint64 e = l.epoch;
        l.endedAt[e] = uint64(block.timestamp);
        l.epoch = e + 1;
        l.waitingUntil = 0;
        emit WaitingVenuesCancelled(by);
    }
}
