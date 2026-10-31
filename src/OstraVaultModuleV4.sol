// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IOstraVaultFactory, IOstraVaultView, OstraVaultV3} from "./OstraVaultV3.sol";
import {OstraVaultV4} from "./OstraVaultV4.sol";
import {IOstraVaultGuarded, IVaultV2Factory, OstraVaultModule} from "./OstraVaultModule.sol";

/// @notice What a RAETO_USDG venue is called for (Raeto's RaetoVault, verified on Sourcify, src/RaetoVault.sol).
interface IRaetoVault {
    function asset() external view returns (address);
    function source() external view returns (address);
    function queuedSourceEta() external view returns (uint256);
    function SOURCE_DELAY() external view returns (uint256);
    function SOURCE_GRACE() external view returns (uint256);
    function dustTolerance() external view returns (uint256);
    function principalOf(address user) external view returns (uint256);
    function inLoss() external view returns (bool);
    function deposit(uint256 amount) external returns (uint256 credited);
    function withdrawTo(uint256 amount, address receiver) external returns (uint256 paid);
}

/// @notice What a RAETO_STOCK venue is called for (Raeto's RaetoStockVault, verified on Sourcify,
///         src/RaetoStockVault.sol).
interface IRaetoStockVault {
    function stock() external view returns (address);
    function stockOf(address user) external view returns (uint256);
    function sharesOf(address user) external view returns (uint256);
    function ltv() external view returns (uint256);
    function maxLtv() external view returns (uint256);
    function inLoss() external view returns (bool);
    function deposit(uint256 amount) external returns (uint256 shares);
    function withdrawTo(uint256 shares, address receiver, uint256 minStockOut, uint256 maxShortfallIn)
        external
        returns (uint256 stockOut);
    function claimLiquidation() external returns (uint256);
    function deleverage() external;
}

/// @notice What an ERC4626 venue is called for (ERC-4626; Spark's SparkVault also answers getImplementation()).
interface IERC4626Venue {
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
    function balanceOf(address owner) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

/// @title OstraVaultModuleV4
/// @notice OstraVault's version 4 spends, run by delegatecall from a vault's own spend after the vault checked the
///         WOTS signature, rotated its key and applied the lock and link changes whose wait is over; and the guard
///         ops and the breaker version 4 adds. Like OstraVaultModule it holds nothing, has no owner and no state of its
///         own: in a vault's context it reads and writes only OstraVaultV3's and OstraVaultV4's fields (and the vault's
///         balances), and called directly it refuses (OnlyDelegated).
///
/// Spends (params and rules; OstraVault checks the params' length):
/// * 15 CancelPendingChanges: params empty. Drops the waiting lock and link changes (as version 3) and the venue
///   enables still waiting.
/// * 24 Guard with op 5 or 6: params abi.encode(address vault, uint8 op, bytes32 arg, uint256 amount), arg
///   bytes32(uint256(kind) << 160 | uint160(venue)). As a guardian or the withdrawal address of `vault`, calls
///   vault.guard(5, abi.encode(kind, venue, amount)), or for op 6 vault.guard(6, abi.encode(kind, venue, 0,
///   address(uint160(amount)))) (the whole position, `amount` the expected withdrawal address) (guard ops below);
///   lands whatever it answers, as Guard does (only when sent on its own, starting with at least GUARD_EXIT_MIN_GAS).
/// * 25 SetVenue: params abi.encode(uint8 kind, address venue, bool enabled). Enabling checks the venue for its kind
///   (its token is this vault's, below) and pins its code hash and, for RAETO_USDG its source and for ERC4626 its
///   implementation; it takes effect at once, or under the withdrawal lock the lock's delay later (refused while a
///   recovery waits under the lock), and a cancel or a recovery that starts meanwhile drops it. Disabling is at once
///   and stops only new Enters. Enabling a venue already in force is refused, and so is re-enabling one where this
///   vault holds a position while the breaker would act on it (exit it first).
/// * 26 Enter: params abi.encode(uint8 kind, address venue, uint256 amount, uint256 minPosition). Puts `amount` of
///   this vault's token into an enabled venue in force: the only allowance is for exactly `amount`, to the venue, back
///   to zero in the same spend; the balance falls by at most `amount`; the position the vault reads rises by at least
///   `amount` less the venue's rounding and by at least `minPosition`. Refused while the venue's code, implementation
///   or source differs from what was pinned, its source change is queued, or (RAETO_STOCK) its LTV is above its max;
///   under the lock a RAETO_USDG or RAETO_STOCK Enter counts against the daily limit (their yield is credits reached
///   only through a Raeto login; a stock position sits in a pooled loan), and so does an ERC4626 Enter into a venue
///   that names no implementation (an upgrade of a proxy that does not say so could not be seen); while a recovery
///   waits under the lock Enter is refused.
/// * 27 Exit: params abi.encode(uint8 kind, address venue, uint256 amount, uint256 minOut). Takes `amount` (RAETO_USDG:
///   principal; RAETO_STOCK: the venue's shares; ERC4626: shares) back into this vault, for at least `minOut`; for a
///   venue this vault entered once, or one in force. RAETO_STOCK with amount 0 claims the USDG a liquidation left this
///   vault (claimLiquidation; it stays here, for Forward). Under the lock the balance must also rise by at least the
///   position's fall less the venue's rounding, so a thief who signs 0 cannot make value leave or realize a loss.
///   A failed Enter or Exit moves nothing but lands (VenueFailed) when sent on its own (a transaction's own call from an
///   account with no code), as a failed Morpho spend does; otherwise it reverts and keeps its key. Each starts with at
///   least its kind's gas floor (RAETO_USDG_MIN_GAS, RAETO_STOCK_MIN_GAS, ERC4626_MIN_GAS).
/// * 28 Forward: params abi.encode(address foreign, uint256 amount). Sends a token that is not this vault's own to
///   the linked vault, whose token it must be, and nowhere else; under the lock only to a locked link. Refused for any
///   token that answers asset() (an ERC-4626 share, a Raeto vault), any Morpho Vault V2 and the ERC-8004 Identity
///   Registry: positions leave only by Exit or Redeem, and an identity never leaves.
///
/// Guard ops (OstraVault.guard, for a guardian or the withdrawal address, under the lock):
/// * 0 drops the venue enables still waiting too (with the lock and link changes, as version 3).
/// * 5 abi.encode(uint8 kind, address venue, uint256 amount), amount 0 for all of it: an Exit back into this vault with
///   the strict check above and minOut 0, refused while a Raeto venue reports a loss (inLoss()), so no exit made for
///   the owner ever makes a Raeto loss permanent (an ERC-4626 redeem pays the shares' value now, which the strict check
///   holds to).
/// * 6 abi.encode(uint8 kind, address venue, uint256 amount, address expected): op 5, then op 2 of version 3 (the whole
///   balance of the token to the withdrawal address, which must be `expected` and keep what it gets) in the same call,
///   so a key held by a thief cannot put the balance back into a venue between the two.
///
/// Breaker (OstraVault.tripVenue, anyone, any vault that entered the venue): when the venue's code or implementation is
/// no longer what was pinned, or its source change is queued (within RaetoVault's grace) or made (RAETO_USDG), the same
/// exit as guard op 5 brings the position home; `amount` 0 for all of it, less to take what the venue can pay now
/// (call it again later for the rest). Never while the venue reports a loss (Raeto inLoss(); ERC4626 a share price
/// below the highest this vault read since it enabled the venue). When a RAETO_STOCK venue's LTV is above its max it
/// calls the venue's own deleverage() instead (a market move, not a change of the venue): the position stays.
contract OstraVaultModuleV4 {
    using SafeERC20 for IERC20;

    uint8 internal constant ACTION_CANCEL_PENDING_CHANGES = 15;
    uint8 internal constant ACTION_GUARD = 24;
    uint8 internal constant ACTION_SET_VENUE = 25;
    uint8 internal constant ACTION_ENTER = 26;
    uint8 internal constant ACTION_EXIT = 27;
    uint8 internal constant ACTION_FORWARD = 28;
    uint8 internal constant GUARD_CANCEL = 0;
    uint8 internal constant GUARD_EXIT = 5;
    uint8 internal constant GUARD_EXIT_SWEEP = 6;

    /// @notice Breaker reasons: the venue's code hash changed; its implementation changed (ERC4626); its source change
    ///         is queued or made (RAETO_USDG); its LTV is above its max (RAETO_STOCK: the breaker deleverages).
    uint8 public constant CODE = 1;
    uint8 public constant IMPLEMENTATION = 2;
    uint8 public constant SOURCE = 4;
    uint8 public constant LTV = 8;

    /// @notice The shortest source delay a RAETO_USDG venue may have (RaetoVault.SOURCE_DELAY is 2 days): the time
    ///         the breaker has to bring a position home before a new source applies.
    uint256 public constant MIN_SOURCE_DELAY = 2 days;
    /// @notice A RAETO_STOCK position's rounding, in the stock's smallest units.
    uint256 public constant STOCK_TOLERANCE = 10;
    /// @notice The shares an ERC4626 venue's price is read for: a billion whole shares.
    uint256 public constant PRICE_SCALE = 1e9;
    /// @notice The least gas an Enter or an Exit must have left when it starts, per kind, and a Guard spend with op 5
    ///         (an Exit in the other vault): about three times the most an Enter or an Exit of that kind used on a fork
    ///         of Robinhood Chain mainnet, every venue's storage read cold (1 Nov 2026: Spark 193k Enter, 91k Exit;
    ///         Raeto USDG 1.00M, 611k; Raeto NVDA 718k, 779k). With less the spend reverts and keeps its key, so no gas
    ///         limit a submitter picks makes a valid spend land as failed.
    uint256 public constant RAETO_USDG_MIN_GAS = 3_000_000;
    uint256 public constant RAETO_STOCK_MIN_GAS = 2_400_000;
    uint256 public constant ERC4626_MIN_GAS = 600_000;
    uint256 public constant GUARD_EXIT_MIN_GAS = 2_500_000;

    /// @notice The OstraVaultFactory every Ostra vault comes from: a Guard spend's vault must be one it made.
    IOstraVaultFactory public immutable FACTORY;
    /// @notice Morpho's VaultV2Factory: a Morpho Vault V2 is lent into through Lend and Redeem, never as a venue, and
    ///         its shares never leave by Forward.
    IVaultV2Factory public immutable VAULT_V2_FACTORY;
    /// @notice The ERC-8004 Identity Registry: its tokens never leave by Forward.
    address public immutable IDENTITY_REGISTRY;
    address private immutable SELF;

    error OnlyDelegated();
    error OutOfGas();
    error BadParams();
    error BadVenue();
    error ZeroAmount();
    error WrongToken();
    error InsufficientOutput();
    error Locked();
    error NotLinked();
    error NotOstraVault();
    error NotEnabled();
    error VenueChanged(uint8 reasons);
    error InLoss();
    error Healthy();

    constructor(address factory, address vaultV2Factory, address identityRegistry) {
        // The factory may not exist yet (a fresh stack makes the modules first, then the factory that names them).
        if (factory == address(0) || vaultV2Factory.code.length == 0 || identityRegistry.code.length == 0) {
            revert BadParams();
        }
        FACTORY = IOstraVaultFactory(factory);
        VAULT_V2_FACTORY = IVaultV2Factory(vaultV2Factory);
        IDENTITY_REGISTRY = identityRegistry;
        SELF = address(this);
    }

    /// @notice Runs one version 4 spend (or CancelPendingChanges, or a Guard spend with op 5) for the vault that
    ///         delegates to it; `token` is that vault's token and `recovering` whether a guardian recovery of it is
    ///         under way.
    function run(uint8 action, bytes calldata params, IERC20 token, bool recovering) external {
        if (address(this) == SELF) revert OnlyDelegated();
        OstraVaultV3.Layout storage l3 = OstraVaultV3.layout();
        OstraVaultV4.Layout storage l4 = OstraVaultV4.layout();
        bool locked = l3.lock.withdrawal != address(0);
        if (action == ACTION_CANCEL_PENDING_CHANGES) {
            OstraVaultV3.cancelPendingChanges(l3, address(0));
            if (OstraVaultV4.waiting(l4)) OstraVaultV4.cancelWaiting(l4, address(0));
        } else if (action == ACTION_SET_VENUE) {
            _setVenue(l3, l4, params, token, locked, recovering && locked);
        } else if (action == ACTION_FORWARD) {
            _forward(l3, params, token);
        } else if (action == ACTION_GUARD) {
            _guardSpend(params);
        } else if (action == ACTION_ENTER || action == ACTION_EXIT) {
            if (action == ACTION_ENTER && recovering && locked) revert Locked();
            (uint8 kind,,,) = abi.decode(params, (uint8, address, uint256, uint256));
            if (gasleft() < _minGas(kind)) revert OutOfGas();
            // Run in this module again by delegatecall, to catch its revert: a failure moves nothing but lands.
            (bool ok, bytes memory ret) = SELF.delegatecall(abi.encodeCall(this.runVenue, (action, params, token)));
            if (!ok) {
                _landed(ret);
                bytes4 reason;
                if (ret.length >= 4) reason = bytes4(ret);
                emit OstraVaultV4.VenueFailed(action, reason);
            }
        } else {
            revert BadParams();
        }
    }

    /// @notice An Enter or an Exit, run by `run` in the vault's context; refused anywhere else.
    function runVenue(uint8 action, bytes calldata params, IERC20 token) external {
        if (address(this) == SELF) revert OnlyDelegated();
        OstraVaultV3.Layout storage l3 = OstraVaultV3.layout();
        OstraVaultV4.Layout storage l4 = OstraVaultV4.layout();
        (uint8 kind, address venue, uint256 amount, uint256 bound) =
            abi.decode(params, (uint8, address, uint256, uint256));
        OstraVaultV4.Venue storage v = l4.venues[OstraVaultV4.key(kind, venue)];
        if (action == ACTION_ENTER) {
            _enter(l3, l4, v, kind, venue, amount, bound, token);
        } else {
            if (!v.entered && !OstraVaultV4.inForce(l4, v)) revert NotEnabled();
            _exit(v, kind, venue, amount, bound, token, l3.lock.withdrawal != address(0), address(0));
        }
    }

    /// @notice OstraVault.guard ops 0, 5 and 6, for a guardian or the withdrawal address `msg.sender` (checked by the
    ///         vault, while its lock is on, after applying the changes whose wait is over).
    function guard(uint8 op, bytes calldata params, IERC20 token) external {
        if (address(this) == SELF) revert OnlyDelegated();
        OstraVaultV3.Layout storage l3 = OstraVaultV3.layout();
        OstraVaultV4.Layout storage l4 = OstraVaultV4.layout();
        if (op == GUARD_CANCEL) {
            // A change whose wait is over is made, not cancelled: with nothing waiting, say so.
            if (l3.pendingLockAt == 0 && l3.pendingLinkedAt == 0 && !OstraVaultV4.waiting(l4)) revert BadParams();
            OstraVaultV3.cancelPendingChanges(l3, msg.sender);
            if (OstraVaultV4.waiting(l4)) OstraVaultV4.cancelWaiting(l4, msg.sender);
        } else if (op == GUARD_EXIT) {
            (uint8 kind, address venue, uint256 amount) = abi.decode(params, (uint8, address, uint256));
            _home(l4, kind, venue, amount, token, false);
        } else if (op == GUARD_EXIT_SWEEP) {
            (uint8 kind, address venue, uint256 amount, address expected) =
                abi.decode(params, (uint8, address, uint256, address));
            // As version 3's op 2: only to the withdrawal address in force, and only one that keeps what it gets.
            address withdrawal = l3.lock.withdrawal;
            if (expected != withdrawal) revert BadParams();
            if (!OstraVaultV3.withdrawalKeeps(l3)) revert Locked();
            _home(l4, kind, venue, amount, token, false);
            uint256 all = token.balanceOf(address(this));
            emit OstraVaultModule.Swept(withdrawal, all, msg.sender);
            token.safeTransfer(withdrawal, all);
        } else {
            revert BadParams();
        }
    }

    /// @notice OstraVault.tripVenue: anyone. Brings the vault's position in `venue` home when the breaker finds a
    ///         reason (CODE, IMPLEMENTATION, SOURCE); `amount` 0 for all of it. For LTV alone (RAETO_STOCK) it calls
    ///         the venue's deleverage() and the position stays.
    function trip(uint8 kind, address venue, uint256 amount, IERC20 token) external {
        if (address(this) == SELF) revert OnlyDelegated();
        OstraVaultV4.Layout storage l4 = OstraVaultV4.layout();
        OstraVaultV4.Venue storage v = l4.venues[OstraVaultV4.key(kind, venue)];
        if (!v.entered) revert NotEnabled();
        uint8 reasons = _reasons(v, kind, venue);
        if (reasons == 0) revert Healthy();
        uint256 taken;
        if (reasons == LTV) IRaetoStockVault(venue).deleverage();
        else taken = _home(l4, kind, venue, amount, token, true);
        emit OstraVaultV4.VenueTripped(kind, venue, reasons, taken, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Spends
    // ---------------------------------------------------------------------------------------------

    function _setVenue(
        OstraVaultV3.Layout storage l3,
        OstraVaultV4.Layout storage l4,
        bytes calldata params,
        IERC20 token,
        bool locked,
        bool frozen
    ) private {
        (uint8 kind, address venue, bool enabled) = abi.decode(params, (uint8, address, bool));
        OstraVaultV4.Venue storage v = l4.venues[OstraVaultV4.key(kind, venue)];
        if (!enabled) {
            if (!v.enabled) revert BadParams();
            v.enabled = false;
            emit OstraVaultV4.VenueSet(kind, venue, false, uint64(block.timestamp));
            return;
        }
        if (OstraVaultV4.inForce(l4, v)) revert BadParams();
        // While a recovery waits under the lock, nothing new may start to wait.
        if (frozen) revert Locked();
        // A position held there keeps what its enable pinned while the breaker would act on it (a re-enable cannot
        // switch the breaker off), and keeps its loss mark; with no position the mark starts again.
        if (v.entered && _position(kind, venue) != 0) {
            uint8 reasons = _reasons(v, kind, venue);
            if (reasons != 0) revert VenueChanged(reasons);
        } else {
            v.priceMark = 0;
        }
        if (venue.code.length == 0 || venue == address(this) || venue == address(token)) revert BadVenue();
        address pinned;
        uint256 tolerance;
        if (kind == OstraVaultV4.RAETO_USDG) {
            if (IRaetoVault(venue).asset() != address(token)) revert WrongToken();
            if (IRaetoVault(venue).SOURCE_DELAY() < MIN_SOURCE_DELAY) revert BadVenue();
            // The breaker reads it while a source is queued.
            IRaetoVault(venue).SOURCE_GRACE();
            tolerance = IRaetoVault(venue).dustTolerance();
            if (tolerance > OstraVaultV4.MAX_TOLERANCE) revert BadVenue();
            pinned = IRaetoVault(venue).source();
        } else if (kind == OstraVaultV4.RAETO_STOCK) {
            if (IRaetoStockVault(venue).stock() != address(token)) revert WrongToken();
        } else if (kind == OstraVaultV4.ERC4626) {
            if (IERC4626Venue(venue).asset() != address(token)) revert WrongToken();
            // A Morpho Vault V2 is lent into through Lend and Redeem (and OstraBreaker), not as a venue.
            if (VAULT_V2_FACTORY.isVaultV2(venue)) revert BadVenue();
            pinned = _implementation(venue);
        } else {
            revert BadParams();
        }
        uint64 from = uint64(block.timestamp) + (locked ? l3.lock.delay : 0);
        v.enabled = true;
        v.from = from;
        v.epoch = l4.epoch;
        v.codeHash = venue.codehash;
        v.pinned = pinned;
        v.tolerance = uint64(tolerance);
        if (from > l4.waitingUntil && from > block.timestamp) l4.waitingUntil = from;
        emit OstraVaultV4.VenueSet(kind, venue, true, from);
    }

    function _enter(
        OstraVaultV3.Layout storage l3,
        OstraVaultV4.Layout storage l4,
        OstraVaultV4.Venue storage v,
        uint8 kind,
        address venue,
        uint256 amount,
        uint256 minPosition,
        IERC20 token
    ) private {
        if (amount == 0) revert ZeroAmount();
        if (!OstraVaultV4.inForce(l4, v)) revert NotEnabled();
        uint8 reasons = _reasons(v, kind, venue);
        if (reasons != 0) revert VenueChanged(reasons);
        // Under the lock: an ERC4626 position stays the vault's own value, where the vault would see an upgrade of the
        // venue (it names its implementation); a Raeto position is counted as gone, and so is one in an ERC4626 venue
        // that names no implementation.
        if (kind != OstraVaultV4.ERC4626 || v.pinned == address(0)) OstraVaultV3.outflow(l3, amount);
        uint256 balance = token.balanceOf(address(this));
        uint256 position = _position(kind, venue);
        token.forceApprove(venue, amount);
        if (kind == OstraVaultV4.RAETO_USDG) IRaetoVault(venue).deposit(amount);
        else if (kind == OstraVaultV4.RAETO_STOCK) IRaetoStockVault(venue).deposit(amount);
        else IERC4626Venue(venue).deposit(amount, address(this));
        token.forceApprove(venue, 0);
        if (token.balanceOf(address(this)) + amount < balance) revert InsufficientOutput();
        uint256 after_ = _position(kind, venue);
        uint256 gain = after_ > position ? after_ - position : 0;
        if (gain + _tolerance(v, kind, venue) < amount || gain < minPosition) revert InsufficientOutput();
        v.entered = true;
        if (kind == OstraVaultV4.ERC4626) _mark(v, venue);
        emit OstraVaultV4.Entered(kind, venue, amount, gain);
    }

    /// @dev Takes `amount` of the position back into the vault, for at least `minOut`; `strict`: also at least the
    ///      position's fall less the venue's rounding. Returns what came back.
    function _exit(
        OstraVaultV4.Venue storage v,
        uint8 kind,
        address venue,
        uint256 amount,
        uint256 minOut,
        IERC20 token,
        bool strict,
        address by
    ) private returns (uint256 received) {
        if (kind == OstraVaultV4.RAETO_STOCK && amount == 0) {
            // The USDG a liquidation left this vault: it comes here (not this vault's token), for Forward.
            received = IRaetoStockVault(venue).claimLiquidation();
            if (received < minOut) revert InsufficientOutput();
            emit OstraVaultV4.Exited(kind, venue, 0, received, by);
            return received;
        }
        if (amount == 0) revert ZeroAmount();
        uint256 balance = token.balanceOf(address(this));
        uint256 position = _position(kind, venue);
        if (kind == OstraVaultV4.RAETO_USDG) IRaetoVault(venue).withdrawTo(amount, address(this));
        else if (kind == OstraVaultV4.RAETO_STOCK) IRaetoStockVault(venue).withdrawTo(amount, address(this), minOut, 0);
        else if (kind == OstraVaultV4.ERC4626) IERC4626Venue(venue).redeem(amount, address(this), address(this));
        else revert BadParams();
        uint256 now_ = token.balanceOf(address(this));
        if (now_ < balance) revert InsufficientOutput();
        received = now_ - balance;
        if (received < minOut) revert InsufficientOutput();
        if (strict) {
            uint256 after_ = _position(kind, venue);
            uint256 fall = position > after_ ? position - after_ : 0;
            if (received + _tolerance(v, kind, venue) < fall) revert InsufficientOutput();
        }
        if (kind == OstraVaultV4.ERC4626) _mark(v, venue);
        emit OstraVaultV4.Exited(kind, venue, amount, received, by);
    }

    /// @dev Guard ops 5 and 6 and the breaker (`breaker`): the position (or `amount` of it) home, strictly; never while
    ///      a Raeto venue reports a loss, and for the breaker never while an ERC4626 venue's price is below its mark.
    function _home(OstraVaultV4.Layout storage l4, uint8 kind, address venue, uint256 amount, IERC20 token, bool breaker)
        private
        returns (uint256)
    {
        OstraVaultV4.Venue storage v = l4.venues[OstraVaultV4.key(kind, venue)];
        if (!v.entered && !OstraVaultV4.inForce(l4, v)) revert NotEnabled();
        if ((breaker || kind != OstraVaultV4.ERC4626) && _inLoss(v, kind, venue)) revert InLoss();
        if (amount == 0) {
            if (kind == OstraVaultV4.RAETO_USDG) amount = IRaetoVault(venue).principalOf(address(this));
            else if (kind == OstraVaultV4.RAETO_STOCK) amount = IRaetoStockVault(venue).sharesOf(address(this));
            else amount = IERC4626Venue(venue).balanceOf(address(this));
            if (amount == 0) revert ZeroAmount();
        }
        return _exit(v, kind, venue, amount, 0, token, true, msg.sender);
    }

    function _forward(OstraVaultV3.Layout storage l3, bytes calldata params, IERC20 token) private {
        (address foreign, uint256 amount) = abi.decode(params, (address, uint256));
        if (amount == 0) revert ZeroAmount();
        if (foreign == address(token) || foreign == IDENTITY_REGISTRY || foreign.code.length == 0) revert WrongToken();
        if (VAULT_V2_FACTORY.isVaultV2(foreign)) revert WrongToken();
        // An ERC-4626 share or a Raeto vault (anything that answers asset()): a position, which leaves only by Exit.
        (bool ok, bytes memory r) = foreign.staticcall(abi.encodeCall(IERC4626Venue.asset, ()));
        if (ok && r.length >= 32) revert WrongToken();
        address to = l3.linkedVault;
        if (to == address(0)) revert NotLinked();
        if (IOstraVaultView(to).token() != foreign) revert WrongToken();
        if (l3.lock.withdrawal != address(0) && !OstraVaultV3.isLockedLink(l3, to)) revert Locked();
        IERC20(foreign).safeTransfer(to, amount);
        emit OstraVaultV4.Forwarded(foreign, to, amount);
    }

    /// @dev A Guard spend with op 5: guard op 5 on another Ostra vault this one guards; lands whatever it answers
    ///      (only when sent on its own), as OstraVaultModule's Guard does for its ops 3 and 4.
    function _guardSpend(bytes calldata params) private {
        (address vault, uint8 op, bytes32 arg, uint256 amount) = abi.decode(params, (address, uint8, bytes32, uint256));
        if ((op != GUARD_EXIT && op != GUARD_EXIT_SWEEP) || uint256(arg) >> 168 != 0) revert BadParams();
        if (vault == address(this) || !OstraVaultV3.isOstraVault(FACTORY, vault)) revert NotOstraVault();
        (uint8 kind, address venue) = (uint8(uint256(arg) >> 160), address(uint160(uint256(arg))));
        bytes memory p;
        if (op == GUARD_EXIT) {
            p = abi.encode(kind, venue, amount);
        } else {
            // Op 6: the whole position, and `amount` is the expected withdrawal address.
            if (amount >> 160 != 0) revert BadParams();
            p = abi.encode(kind, venue, uint256(0), address(uint160(amount)));
        }
        bytes memory call = abi.encodeCall(IOstraVaultGuarded.guard, (op, p));
        if (gasleft() < GUARD_EXIT_MIN_GAS) revert OutOfGas();
        (bool ok, bytes memory ret) = vault.call(call);
        if (!ok) _landed(ret);
        bytes4 reason;
        if (!ok && ret.length >= 4) reason = bytes4(ret);
        emit OstraVaultModule.Guarded(vault, op, ok, reason);
    }

    // ---------------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------------

    /// @dev What the breaker finds now: the code or implementation changed, the source changed or a change is queued,
    ///      the LTV is above its max.
    function _reasons(OstraVaultV4.Venue storage v, uint8 kind, address venue) private view returns (uint8 reasons) {
        if (venue.codehash != v.codeHash) return CODE;
        if (kind == OstraVaultV4.RAETO_USDG) {
            // A queued source counts until it expires (RaetoVault refuses to execute it after SOURCE_GRACE).
            uint256 eta = IRaetoVault(venue).queuedSourceEta();
            if ((eta != 0 && block.timestamp <= eta + IRaetoVault(venue).SOURCE_GRACE()) || IRaetoVault(venue).source() != v.pinned) {
                reasons |= SOURCE;
            }
        } else if (kind == OstraVaultV4.RAETO_STOCK) {
            if (IRaetoStockVault(venue).ltv() > IRaetoStockVault(venue).maxLtv()) reasons |= LTV;
        } else if (_implementation(venue) != v.pinned) {
            reasons |= IMPLEMENTATION;
        }
    }

    /// @dev Whether the venue reports a loss: Raeto's inLoss(), or an ERC4626 share price below the highest this vault
    ///      read of it.
    function _inLoss(OstraVaultV4.Venue storage v, uint8 kind, address venue) private view returns (bool) {
        if (kind == OstraVaultV4.RAETO_USDG) return IRaetoVault(venue).inLoss();
        if (kind == OstraVaultV4.RAETO_STOCK) return IRaetoStockVault(venue).inLoss();
        return _price(venue) < v.priceMark;
    }

    function _position(uint8 kind, address venue) private view returns (uint256) {
        if (kind == OstraVaultV4.RAETO_USDG) return IRaetoVault(venue).principalOf(address(this));
        if (kind == OstraVaultV4.RAETO_STOCK) return IRaetoStockVault(venue).stockOf(address(this));
        return IERC4626Venue(venue).convertToAssets(IERC4626Venue(venue).balanceOf(address(this)));
    }

    /// @dev A venue's rounding: RAETO_USDG its pinned dustTolerance; RAETO_STOCK STOCK_TOLERANCE; ERC4626 the value of
    ///      one share unit plus one; at most MAX_TOLERANCE.
    function _tolerance(OstraVaultV4.Venue storage v, uint8 kind, address venue) private view returns (uint256) {
        if (kind == OstraVaultV4.RAETO_USDG) return v.tolerance;
        if (kind == OstraVaultV4.RAETO_STOCK) return STOCK_TOLERANCE;
        uint256 t = IERC4626Venue(venue).convertToAssets(1) + 1;
        return t > OstraVaultV4.MAX_TOLERANCE ? OstraVaultV4.MAX_TOLERANCE : t;
    }

    function _price(address venue) private view returns (uint256) {
        return IERC4626Venue(venue).convertToAssets(PRICE_SCALE * 10 ** IERC4626Venue(venue).decimals());
    }

    function _mark(OstraVaultV4.Venue storage v, address venue) private {
        uint256 p = _price(venue);
        if (p > v.priceMark) v.priceMark = p;
    }

    /// @dev The implementation an ERC-4626 venue names through getImplementation() (Spark's SparkVault, a UUPS proxy);
    ///      address(0) when it does not answer one.
    function _implementation(address venue) private view returns (address) {
        (bool ok, bytes memory r) = venue.staticcall(abi.encodeWithSignature("getImplementation()"));
        if (!ok || r.length != 32 || uint256(bytes32(r)) >> 160 != 0) return address(0);
        return address(uint160(uint256(bytes32(r))));
    }

    function _minGas(uint8 kind) private pure returns (uint256) {
        if (kind == OstraVaultV4.RAETO_USDG) return RAETO_USDG_MIN_GAS;
        if (kind == OstraVaultV4.RAETO_STOCK) return RAETO_STOCK_MIN_GAS;
        return ERC4626_MIN_GAS;
    }

    /// @dev A failed spend may land (and use up its key) only when it was sent on its own, as a transaction's own
    ///      call from an account with no code (msg.sender is tx.origin and has no code: an EIP-7702 account, whose
    ///      code is its delegation, could set the failure up in the same transaction): otherwise the failure could be
    ///      one the caller set up (a reentrancy lock held, a flash loan out), so the spend reverts and keeps its key.
    function _landed(bytes memory ret) private view {
        if (msg.sender != tx.origin || msg.sender.code.length != 0) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
