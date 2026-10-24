// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IOstraVaultFactory, IOstraVaultView, OstraVaultV3} from "./OstraVaultV3.sol";

/// @notice Morpho Blue's MarketParams (morpho-blue src/interfaces/IMorpho.sol).
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @notice What the Morpho spends call on Morpho Blue (morpho-blue src/interfaces/IMorpho.sol).
interface IMorphoBlue {
    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }

    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;
    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;
    function borrow(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256 assetsBorrowed, uint256 sharesBorrowed);
    function repay(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256 assetsRepaid, uint256 sharesRepaid);
    function position(bytes32 id, address user) external view returns (Position memory);
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
    function market(bytes32 id) external view returns (Market memory);
}

/// @notice A Morpho Blue oracle: the collateral's price in the loan token, scaled by 1e36 (morpho-blue IOracle).
interface IMorphoOracle {
    function price() external view returns (uint256);
}

/// @notice Morpho's VaultV2Factory: whether an address is a Morpho Vault V2 it created (vault-v2 IVaultV2Factory).
interface IVaultV2Factory {
    function isVaultV2(address account) external view returns (bool);
}

/// @notice A Morpho Vault V2 seen as an ERC-4626 vault (vault-v2 src/interfaces/IERC4626.sol).
interface IVaultV2 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address onBehalf) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address onBehalf) external returns (uint256 assets);
}

/// @notice Borro's referral contract (github.com/Borro-Markets/contracts src/BorroBuilders.sol): a deposit into one
///         of the vaults it lists, credited to a builder code; the shares go to the caller.
interface IBorroBuilders {
    function vaults(address vault) external view returns (bool);
    function deposit(address vault, uint256 assets, bytes32 code, uint256 minShares) external returns (uint256 shares);
}

/// @notice What a Guard spend calls on a vault this vault guards, or is the withdrawal address of (OstraVault); and
///         what a SupportRecovery spend calls on the vault being recovered.
interface IOstraVaultGuarded {
    function supportRecovery(bytes32 newKeyRoot) external;
    function guard(uint8 op, bytes calldata params) external;
}

/// @notice What a ClaimDividend spend calls (OstraToken.claimTo), and the token it pays (OstraToken.DIVIDEND_TOKEN).
interface IOstraDividends {
    function claimTo(address recipient) external returns (uint256 amount);
    function DIVIDEND_TOKEN() external view returns (address);
}

/// @notice Borro's list of its USDG markets on Morpho Blue (src/BorroRouter.sol): USDG lent against a stock vault's
///         shares, listed by Borro's Safe.
interface IBorroRouter {
    function listed(bytes32 id) external view returns (bool);
}

/// @title OstraVaultModule
/// @notice OstraVault's version 3 spends (14 SetWithdrawalLock to 24 Guard; their params and rules are in
///         OstraVault's notes), run by delegatecall from a vault's own spend, after the vault checked the WOTS
///         signature, rotated its key and applied the lock and link changes whose wait is over. Apart from
///         OstraVault only for the 24,576-byte code size limit. It holds nothing, has no owner and no state of its
///         own: in a vault's context it reads and writes only OstraVaultV3's fields (and the vault's balances), and
///         called directly it refuses (OnlyDelegated).
contract OstraVaultModule {
    using SafeERC20 for IERC20;

    uint8 internal constant ACTION_CLAIM_DIVIDEND = 5;
    uint8 internal constant ACTION_SUPPORT_RECOVERY = 8;
    uint8 internal constant ACTION_SET_WITHDRAWAL_LOCK = 14;
    uint8 internal constant ACTION_CANCEL_PENDING_CHANGES = 15;
    uint8 internal constant ACTION_SET_LINKED_VAULT = 16;
    uint8 internal constant ACTION_APPROVE_HASH = 23;
    uint8 internal constant ACTION_GUARD = 24;

    uint8 internal constant ACTION_LEND = 17;
    uint8 internal constant ACTION_REDEEM = 18;
    uint8 internal constant ACTION_POST_COLLATERAL = 19;
    uint8 internal constant ACTION_WITHDRAW_COLLATERAL = 20;
    uint8 internal constant ACTION_BORROW = 21;
    uint8 internal constant ACTION_REPAY = 22;

    /// @notice The most a Borrow or WithdrawCollateral may leave the position's debt at, in basis points of what the
    ///         market's LLTV allows: half, as Borro's own coin markets open (OPEN_LTV), so a fresh position is
    ///         liquidated only after its collateral loses about half its value.
    uint256 public constant MAX_LTV_OF_LLTV_BPS = 5_000;
    /// @notice The least gas a Morpho spend (17 to 22) and a Guard call must have left when they start; with less the
    ///         spend reverts and keeps its key. A call that fails with this much is not short of gas (each of these
    ///         takes well under it), so no gas limit a submitter picks makes a valid spend land as failed.
    uint256 public constant MORPHO_MIN_GAS = 2_000_000;
    uint256 public constant GUARD_MIN_GAS = 600_000;
    /// @dev OpenZeppelin ReentrancyGuardTransient.ReentrancyGuardReentrantCall().
    bytes4 private constant REENTRANT_CALL = 0x3ee5aeb5;

    /// @notice The OstraVaultFactory every Ostra vault comes from: a linked vault, and the vault a Repay is for, must
    ///         be one it made.
    IOstraVaultFactory public immutable FACTORY;
    /// @notice Morpho Blue.
    IMorphoBlue public immutable MORPHO;
    /// @notice Morpho's VaultV2Factory: Redeem, and Lend outside Borro's list, only on a vault it made.
    IVaultV2Factory public immutable VAULT_V2_FACTORY;
    /// @notice Borro's referral contract: Lend into a vault it lists goes through it, with BORRO_CODE.
    IBorroBuilders public immutable BORRO_BUILDERS;
    /// @notice Borro's list of USDG markets: the only markets a vault posts collateral and borrows on.
    IBorroRouter public immutable BORRO_ROUTER;
    /// @notice Ostra's Borro builder code ("ostraagent", right-padded with zeros).
    bytes32 public immutable BORRO_CODE;
    address private immutable SELF;

    /// @notice A Guard spend called `vault` (op 0 cancel, 1 revoke, 2 sweep; 255: a SupportRecovery spend); `ok`
    ///         false: refused, with `reason`.
    event Guarded(address indexed vault, uint8 op, bool ok, bytes4 reason);
    /// @notice A Morpho spend failed and moved nothing; `reason` is its error's selector. The key has moved on.
    event MorphoFailed(uint8 indexed action, bytes4 reason);
    /// @notice `by`, a guardian or the withdrawal address, sent the whole balance to the withdrawal address.
    event Swept(address indexed withdrawal, uint256 amount, address indexed by);
    event Lent(address indexed vault, uint256 assets, uint256 shares, bool viaBorro);
    event Redeemed(address indexed vault, uint256 shares, uint256 assets);
    event CollateralPosted(bytes32 indexed marketId, uint256 shares);
    event CollateralWithdrawn(bytes32 indexed marketId, uint256 shares);
    event Borrowed(bytes32 indexed marketId, uint256 assets, address indexed receiver);
    event Repaid(bytes32 indexed marketId, address indexed onBehalf, uint256 assets, uint256 shares);

    error OnlyDelegated();
    error OutOfGas();
    error BadParams();
    error ZeroAmount();
    error WrongToken();
    error InsufficientOutput();
    error Locked();
    error NotOstraVault();
    error NotLinked();
    error BadVault();
    error BadMarket();
    error LtvTooHigh();

    constructor(
        address factory,
        address morpho,
        address vaultV2Factory,
        address borroBuilders,
        address borroRouter,
        bytes32 borroCode
    ) {
        if (
            factory == address(0) || morpho == address(0) || vaultV2Factory == address(0)
                || borroBuilders == address(0) || borroRouter == address(0) || borroCode == bytes32(0)
        ) revert BadParams();
        FACTORY = IOstraVaultFactory(factory);
        MORPHO = IMorphoBlue(morpho);
        VAULT_V2_FACTORY = IVaultV2Factory(vaultV2Factory);
        BORRO_BUILDERS = IBorroBuilders(borroBuilders);
        BORRO_ROUTER = IBorroRouter(borroRouter);
        BORRO_CODE = borroCode;
        SELF = address(this);
    }

    /// @notice Runs one version 3 spend for the vault that delegates to it; `token` is that vault's token and
    ///         `recovering` whether a guardian recovery of it is under way. The vault has checked the params' length
    ///         for the action.
    function run(uint8 action, bytes calldata params, IERC20 token, bool recovering) external {
        if (address(this) == SELF) revert OnlyDelegated();
        OstraVaultV3.Layout storage l = OstraVaultV3.layout();
        // While a recovery is under way and the lock is on, the key may be a thief's: nothing new may start to wait.
        bool frozen = recovering && l.lock.withdrawal != address(0);
        if (action == ACTION_CLAIM_DIVIDEND) {
            // Under the lock, dividends go only to this vault, the withdrawal address (if it keeps them locked) or a
            // locked link, and never to a vault that cannot spend the dividend token (an OstraVault only ever spends
            // its own token): anything that answers token() must answer DIVIDEND_TOKEN. Reverts while nothing is
            // owed, so the signed claim can be sent later.
            address recipient = abi.decode(params, (address));
            if (recipient == address(0)) revert BadParams();
            if (l.lock.withdrawal != address(0)) {
                bool kept = recipient == address(this)
                    || (recipient == l.lock.withdrawal && OstraVaultV3.withdrawalKeeps(l))
                    || OstraVaultV3.isLockedLink(l, recipient);
                if (!kept) revert Locked();
                (bool ok, bytes memory t) = recipient.staticcall(abi.encodeCall(IOstraVaultView.token, ()));
                if (ok && t.length == 32 && abi.decode(t, (address)) != IOstraDividends(address(token)).DIVIDEND_TOKEN()) {
                    revert Locked();
                }
            }
            if (IOstraDividends(address(token)).claimTo(recipient) == 0) revert ZeroAmount();
        } else if (action == ACTION_SUPPORT_RECOVERY) {
            // As a guardian of another vault. The spend lands when that vault refuses (it turned recovery off, or
            // dropped this guardian, meanwhile), as Guard does.
            (address vault, bytes32 newKeyRoot) = abi.decode(params, (address, bytes32));
            if (vault == address(0) || vault == address(this) || newKeyRoot == bytes32(0)) revert BadParams();
            _landingCall(vault, abi.encodeCall(IOstraVaultGuarded.supportRecovery, (newKeyRoot)), 255);
        } else if (action == ACTION_SET_WITHDRAWAL_LOCK) {
            _setWithdrawalLock(l, params, frozen, token);
        } else if (action == ACTION_CANCEL_PENDING_CHANGES) {
            OstraVaultV3.cancelPendingChanges(l, address(0));
        } else if (action == ACTION_SET_LINKED_VAULT) {
            _setLinkedVault(l, params, frozen);
        } else if (action == ACTION_APPROVE_HASH) {
            _approveHash(l, params, frozen);
        } else if (action == ACTION_GUARD) {
            // As a guardian (or the withdrawal address) of another Ostra vault: OstraVault.guard(op, ...) on it, with
            // its params built from `arg` and `amount` (op 0 none; 1 the hash; 2 the expected withdrawal address; 3
            // a Vault V2 and shares; 4 a market id and shares).
            (address vault, uint8 op, bytes32 arg, uint256 amount) = abi.decode(params, (address, uint8, bytes32, uint256));
            if (vault == address(this) || !OstraVaultV3.isOstraVault(FACTORY, vault)) revert NotOstraVault();
            bytes memory p;
            if (op == 1 || op == 2) p = abi.encode(arg);
            else if (op == 3 || op == 4) p = abi.encode(arg, amount);
            else if (op != 0) revert BadParams();
            bytes memory call = abi.encodeCall(IOstraVaultGuarded.guard, (op, p));
            // The spend lands even when the call is refused (the other vault moved on meanwhile), so this vault's
            // one-time key is never held by a message that can no longer succeed; not when it ran out of gas.
            _landingCall(vault, call, op);
        } else {
            // A Morpho spend that fails (a minimum not met, a position someone else moved, a check refused) moves
            // nothing but lands, as a failed Swap does, so the one-time key is never held by a message that cannot
            // succeed now. Run in this module again by delegatecall, to catch its revert; it starts with at least
            // MORPHO_MIN_GAS, so a submitter cannot make a spend fail by its gas limit.
            if (gasleft() < MORPHO_MIN_GAS) revert OutOfGas();
            (bool ok, bytes memory ret) = SELF.delegatecall(abi.encodeCall(this.runMorpho, (action, params, token)));
            if (!ok) {
                _landed(ret);
                bytes4 reason;
                if (ret.length >= 4) reason = bytes4(ret);
                emit MorphoFailed(action, reason);
            }
        }
    }

    /// @dev Calls `vault` and lands whatever it answers, with at least GUARD_MIN_GAS to start (op 255: SupportRecovery).
    ///      A refusal lands only for a spend sent on its own (_landed).
    function _landingCall(address vault, bytes memory call, uint8 op) private {
        if (gasleft() < GUARD_MIN_GAS) revert OutOfGas();
        (bool ok, bytes memory ret) = vault.call(call);
        // Refused only because the other vault is in the middle of a call (its reentrancy lock): not a refusal on
        // the merits, so the spend reverts and keeps its key, to be sent again. Only for the calls that touch no
        // contract but the other vault (and its own token): ops 3 and 4 reach a Vault V2 or a market that anyone
        // may have made, whose revert data could imitate it, so they always land.
        if (!ok && op != 3 && op != 4 && ret.length >= 4 && bytes4(ret) == REENTRANT_CALL) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        if (!ok) _landed(ret);
        bytes4 reason;
        if (!ok && ret.length >= 4) reason = bytes4(ret);
        emit Guarded(vault, op, ok, reason);
    }

    /// @dev A failed spend may land (and use up its key) only when it was sent on its own, as a transaction's own
    ///      call (msg.sender is tx.origin): inside another contract's call the failure could be one that call set up
    ///      (a reentrancy lock held, a flash loan out), so the spend reverts instead and keeps its key, to be sent
    ///      again on its own. `ret` is the failure, passed on as it is.
    function _landed(bytes memory ret) private view {
        if (msg.sender != tx.origin) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    /// @notice OstraVault.guard, for a guardian or the withdrawal address `msg.sender` (checked by the vault, while
    ///         its lock is on, after applying the changes whose wait is over). `token` is the vault's token.
    function guard(uint8 op, bytes calldata params, IERC20 token) external {
        if (address(this) == SELF) revert OnlyDelegated();
        OstraVaultV3.Layout storage l = OstraVaultV3.layout();
        if (op == 0) {
            // A change whose wait is over is made, not cancelled: with nothing waiting, say so.
            if (l.pendingLockAt == 0 && l.pendingLinkedAt == 0) revert BadParams();
            OstraVaultV3.cancelPendingChanges(l, msg.sender);
        } else if (op == 1) {
            bytes32 hash = abi.decode(params, (bytes32));
            bytes32 key = OstraVaultV3.approvalKey(l, hash);
            if (l.hashValidFrom[key] == 0) revert BadParams();
            delete l.hashValidFrom[key];
            emit OstraVaultV3.HashRevoked(hash, msg.sender);
        } else if (op == 2) {
            // Only to a withdrawal address that keeps what it gets (OstraVaultV3.withdrawalKeeps): not to an unlocked
            // Ostra vault, which may share the stolen seed.
            address withdrawal = l.lock.withdrawal;
            if (abi.decode(params, (address)) != withdrawal) revert BadParams();
            if (!OstraVaultV3.withdrawalKeeps(l)) revert Locked();
            uint256 amount = token.balanceOf(address(this));
            if (amount == 0) revert ZeroAmount();
            emit Swept(withdrawal, amount, msg.sender);
            token.safeTransfer(withdrawal, amount);
        } else if (op == 3) {
            // At most what the vault holds, so a little redeemed by the key holder first does not stop it.
            (address vault, uint256 shares) = abi.decode(params, (address, uint256));
            if (!VAULT_V2_FACTORY.isVaultV2(vault)) revert BadVault();
            if (IVaultV2(vault).asset() != address(token)) revert WrongToken();
            shares = Math.min(shares, IERC20(vault).balanceOf(address(this)));
            if (shares == 0) revert ZeroAmount();
            emit Redeemed(vault, shares, IVaultV2(vault).redeem(shares, address(this), address(this)));
        } else if (op == 4) {
            // At most the collateral there is.
            (bytes32 id, uint256 shares) = abi.decode(params, (bytes32, uint256));
            MarketParams memory m = MORPHO.idToMarketParams(id);
            shares = Math.min(shares, MORPHO.position(id, address(this)).collateral);
            if (shares == 0) revert ZeroAmount();
            MORPHO.withdrawCollateral(m, shares, address(this), address(this));
            _checkLtv(m, id);
            emit CollateralWithdrawn(id, shares);
        } else {
            revert BadParams();
        }
    }

    /// @notice A Morpho spend (17 to 22), run by `run` in the vault's context; refused anywhere else.
    function runMorpho(uint8 action, bytes calldata params, IERC20 token) external {
        if (address(this) == SELF) revert OnlyDelegated();
        OstraVaultV3.Layout storage l = OstraVaultV3.layout();
        if (action == ACTION_LEND) {
            (address vault, uint256 assets, uint256 minShares) = abi.decode(params, (address, uint256, uint256));
            if (assets == 0) revert ZeroAmount();
            // Only a Morpho Vault V2 (so Redeem can bring it back), through Borro when Borro lists it.
            if (!VAULT_V2_FACTORY.isVaultV2(vault)) revert BadVault();
            bool viaBorro = BORRO_BUILDERS.vaults(vault);
            if (!viaBorro) {
                // Under the lock only Borro's vaults count as the owner's own: another vault's curator is not.
                OstraVaultV3.outflow(l, assets);
            }
            if (IVaultV2(vault).asset() != address(token)) revert WrongToken();
            uint256 shares;
            if (viaBorro) {
                token.forceApprove(address(BORRO_BUILDERS), assets);
                shares = BORRO_BUILDERS.deposit(vault, assets, BORRO_CODE, minShares);
                token.forceApprove(address(BORRO_BUILDERS), 0);
            } else {
                token.forceApprove(vault, assets);
                shares = IVaultV2(vault).deposit(assets, address(this));
                token.forceApprove(vault, 0);
            }
            if (shares < minShares) revert InsufficientOutput();
            emit Lent(vault, assets, shares, viaBorro);
        } else if (action == ACTION_REDEEM) {
            (address vault, uint256 shares, uint256 minAssets) = abi.decode(params, (address, uint256, uint256));
            if (shares == 0) revert ZeroAmount();
            if (!VAULT_V2_FACTORY.isVaultV2(vault)) revert BadVault();
            if (IVaultV2(vault).asset() != address(token)) revert WrongToken();
            uint256 assets = IVaultV2(vault).redeem(shares, address(this), address(this));
            if (assets < minAssets) revert InsufficientOutput();
            emit Redeemed(vault, shares, assets);
        } else if (action == ACTION_REPAY) {
            (MarketParams memory m, uint256 assets, uint256 shares, address onBehalf, uint256 maxAssets) =
                abi.decode(params, (MarketParams, uint256, uint256, address, uint256));
            if (m.loanToken != address(token)) revert WrongToken();
            if (maxAssets == 0) revert ZeroAmount();
            // Only the debt of a vault that names this one its linked vault.
            if (onBehalf == address(this) || !OstraVaultV3.isOstraVault(FACTORY, onBehalf)) revert NotOstraVault();
            if (IOstraVaultView(onBehalf).linkedVault() != address(this)) revert NotLinked();
            // Anyone may repay for anyone on Morpho: never more than the debt there is now, so a full repay signed
            // earlier still goes through after someone repaid a little of it.
            uint256 debtShares = MORPHO.position(_marketId(m), onBehalf).borrowShares;
            if (shares > debtShares) shares = debtShares;
            if (assets != 0) {
                IMorphoBlue.Market memory mk = MORPHO.market(_marketId(m));
                uint256 debt = Math.mulDiv(
                    debtShares, uint256(mk.totalBorrowAssets) + 1, uint256(mk.totalBorrowShares) + 1e6, Math.Rounding.Ceil
                );
                if (assets >= debt) (assets, shares) = (0, debtShares);
            }
            if (shares == 0 && assets == 0) revert ZeroAmount();
            token.forceApprove(address(MORPHO), maxAssets);
            (uint256 paid, uint256 burned) = MORPHO.repay(m, assets, shares, onBehalf, "");
            token.forceApprove(address(MORPHO), 0);
            // It is the owner's own position only if this vault links back to it (under the lock that link only
            // changes after the delay) and, under the lock, that vault was already locked when the link took effect
            // (so its loans only ever came here). Otherwise the payment counts against the daily limit.
            bool own = l.linkedVault == onBehalf
                && (l.lock.withdrawal == address(0) || OstraVaultV3.isLockedLink(l, onBehalf));
            if (!own) OstraVaultV3.outflow(l, paid);
            emit Repaid(_marketId(m), onBehalf, paid, burned);
        } else if (action == ACTION_POST_COLLATERAL || action == ACTION_WITHDRAW_COLLATERAL || action == ACTION_BORROW)
        {
            (MarketParams memory m, uint256 amount) = abi.decode(params, (MarketParams, uint256));
            if (amount == 0) revert ZeroAmount();
            bytes32 id = _marketId(m);
            if (action == ACTION_POST_COLLATERAL) {
                if (!BORRO_ROUTER.listed(id)) revert BadMarket();
                IERC20(m.collateralToken).forceApprove(address(MORPHO), amount);
                MORPHO.supplyCollateral(m, amount, address(this), "");
                IERC20(m.collateralToken).forceApprove(address(MORPHO), 0);
                emit CollateralPosted(id, amount);
            } else if (action == ACTION_WITHDRAW_COLLATERAL) {
                MORPHO.withdrawCollateral(m, amount, address(this), address(this));
                _checkLtv(m, id);
                emit CollateralWithdrawn(id, amount);
            } else {
                if (!BORRO_ROUTER.listed(id)) revert BadMarket();
                address receiver = l.linkedVault;
                if (receiver == address(0)) revert NotLinked();
                if (IOstraVaultView(receiver).token() != m.loanToken) revert WrongToken();
                // Under the lock a loan only goes where it stays locked.
                if (l.lock.withdrawal != address(0) && !OstraVaultV3.isLockedLink(l, receiver)) revert Locked();
                MORPHO.borrow(m, amount, 0, address(this), receiver);
                _checkLtv(m, id);
                emit Borrowed(id, amount, receiver);
            }
        } else {
            revert BadParams();
        }
    }

    function _setWithdrawalLock(OstraVaultV3.Layout storage l, bytes calldata params, bool frozen, IERC20 token)
        private
    {
        (address withdrawal, uint32 delay, uint128 dailyLimit) = abi.decode(params, (address, uint32, uint128));
        if (withdrawal == address(0)) {
            if (delay != 0 || dailyLimit != 0) revert BadParams();
        } else if (
            withdrawal == address(this) || delay < OstraVaultV3.MIN_LOCK_DELAY || delay > OstraVaultV3.MAX_LOCK_DELAY
        ) {
            revert BadParams();
        } else if (
            OstraVaultV3.isOstraVault(FACTORY, withdrawal) && IOstraVaultView(withdrawal).token() != address(token)
        ) {
            // An Ostra vault only ever spends its own token: anything else sent there would be stuck.
            revert WrongToken();
        }
        OstraVaultV3.LockConfig memory current = l.lock;
        OstraVaultV3.LockConfig memory next =
            OstraVaultV3.LockConfig({withdrawal: withdrawal, delay: delay, dailyLimit: dailyLimit});
        if (current.withdrawal == address(0)) {
            // Turning the lock on is at once; with the lock off there is nothing to turn off. Approvals given while
            // it was off stop counting.
            if (withdrawal == address(0)) revert BadParams();
            l.limitUpdatedAt = uint64(block.timestamp);
            l.limitUsed = 0;
            l.lockedSince = uint64(block.timestamp);
            l.withdrawalSince = uint64(block.timestamp);
            ++l.approvalsEpoch;
            l.lock = next;
            emit OstraVaultV3.WithdrawalLockSet(withdrawal, delay, dailyLimit);
        } else if (withdrawal == current.withdrawal && delay >= current.delay && dailyLimit <= current.dailyLimit) {
            // Tightening is at once, and drops a loosening still waiting.
            l.lock = next;
            delete l.pendingLock;
            l.pendingLockAt = 0;
            emit OstraVaultV3.WithdrawalLockSet(withdrawal, delay, dailyLimit);
        } else {
            if (frozen) revert Locked();
            uint64 at = uint64(block.timestamp) + current.delay;
            l.pendingLockScheduledAt = uint64(block.timestamp);
            l.pendingLock = next;
            l.pendingLockAt = at;
            emit OstraVaultV3.WithdrawalLockChangeScheduled(withdrawal, delay, dailyLimit, at);
        }
    }

    function _setLinkedVault(OstraVaultV3.Layout storage l, bytes calldata params, bool frozen) private {
        address v = abi.decode(params, (address));
        if (v != address(0) && (v == address(this) || !OstraVaultV3.isOstraVault(FACTORY, v))) revert NotOstraVault();
        uint32 delay = l.lock.delay;
        // Unlinking, or linking while the lock is off, is at once; a new link under the lock waits its delay.
        if (v == address(0) || l.lock.withdrawal == address(0)) {
            l.linkedVault = v;
            l.linkedSince = uint64(block.timestamp);
            l.pendingLinkedVault = address(0);
            l.pendingLinkedAt = 0;
            emit OstraVaultV3.LinkedVaultSet(v);
        } else {
            if (frozen) revert Locked();
            uint64 at = uint64(block.timestamp) + delay;
            l.pendingLinkedVault = v;
            l.pendingLinkedAt = at;
            l.pendingLinkedScheduledAt = uint64(block.timestamp);
            emit OstraVaultV3.LinkedVaultChangeScheduled(v, at);
        }
    }

    function _approveHash(OstraVaultV3.Layout storage l, bytes calldata params, bool frozen) private {
        (bytes32 hash, bool approved) = abi.decode(params, (bytes32, bool));
        if (hash == bytes32(0)) revert BadParams();
        if (approved) {
            if (frozen) revert Locked();
            // Under the lock an approval waits the lock's delay: a hash may authorize a pull of funds (a permit).
            uint64 from = uint64(block.timestamp) + l.lock.delay;
            l.hashValidFrom[OstraVaultV3.approvalKey(l, hash)] = from;
            emit OstraVaultV3.HashApproved(hash, from);
        } else {
            // Gone already (revoked by a guardian, or a new approval epoch): nothing to do, and the spend lands.
            bytes32 key = OstraVaultV3.approvalKey(l, hash);
            if (l.hashValidFrom[key] == 0) return;
            delete l.hashValidFrom[key];
            emit OstraVaultV3.HashRevoked(hash, address(0));
        }
    }

    /// @dev Morpho Blue's market id: keccak256 of the five words of MarketParams (morpho-blue MarketParamsLib).
    function _marketId(MarketParams memory m) private pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    /// @dev Reverts when the vault's debt on the market is above MAX_LTV_OF_LLTV_BPS of what its LLTV allows, at the
    ///      market's oracle price, rounded as Morpho rounds its own check (debt up, allowance down).
    function _checkLtv(MarketParams memory m, bytes32 id) private view {
        IMorphoBlue.Position memory p = MORPHO.position(id, address(this));
        if (p.borrowShares == 0) return;
        IMorphoBlue.Market memory mk = MORPHO.market(id);
        // SharesMathLib.toAssetsUp, with VIRTUAL_ASSETS 1 and VIRTUAL_SHARES 1e6.
        uint256 debt = Math.mulDiv(
            p.borrowShares, uint256(mk.totalBorrowAssets) + 1, uint256(mk.totalBorrowShares) + 1e6, Math.Rounding.Ceil
        );
        uint256 value = Math.mulDiv(p.collateral, IMorphoOracle(m.oracle).price(), 1e36);
        uint256 allowed = Math.mulDiv(value, m.lltv * MAX_LTV_OF_LLTV_BPS, 1e18 * 10_000);
        if (debt > allowed) revert LtvTooHigh();
    }
}
