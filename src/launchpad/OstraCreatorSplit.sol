// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {OstraHook} from "./OstraHook.sol";

/// @title OstraCreatorSplit
/// @notice Shares an Ostra pool's creator payouts among up to MAX_RECIPIENTS recipients (design v0.4, "Blok
///         modular", approved 18 Oct 2026). The pool's creator vault, an OstraVault, sets a recipient's share in bps
///         with a ConfigurePool spend whose `hook` is this contract (configure); it may change or remove any share at
///         any time, and keeps whatever the recipients do not hold. A change applies to the payouts that follow it:
///         what was paid before belongs to the shares at that time. Payouts accrue per bps, so a payout, a change and
///         a release each cost the same whatever the number of recipients. Anyone may release what an account is
///         owed, always to that account, so a recipient that cannot call out (an OstraVault) is still paid; a
///         recipient vault with auto-shield then moves it into the shielded pool. While a pool has no recipient,
///         OstraDispatcher pays the creator vault directly and nothing passes through here.
contract OstraCreatorSplit {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_RECIPIENTS = 100;
    uint256 public constant BPS = 10_000;
    /// @notice configure field: value = uint160(recipient) | bps << 160; bps 0 removes the recipient.
    uint8 public constant FIELD_SHARE = 0;
    uint256 private constant MAGNITUDE = 2 ** 128;

    OstraHook public immutable HOOK;

    struct Account {
        uint16 bps;
        /// @dev `acc` when the account was last settled.
        uint256 lastAcc;
        uint256 owed;
    }

    struct Split {
        /// @dev The pool's creator vault, which holds what no recipient does.
        address primary;
        /// @dev The payout token (the pool's quote; WETH for ETH), set by the first payout.
        address token;
        uint16 assigned;
        /// @dev Paid per bps so far, times MAGNITUDE.
        uint256 acc;
        address[] recipients;
        mapping(address => uint256) position;
        mapping(address => Account) accounts;
    }

    mapping(PoolId => Split) private _splits;

    event ShareSet(PoolId indexed poolId, address indexed recipient, uint16 bps);
    event Credited(PoolId indexed poolId, address token, uint256 amount);
    event Released(PoolId indexed poolId, address indexed account, uint256 amount);

    error NotRegistered();
    error OnlyCreatorVault();
    error OnlyDispatcher();
    error BadField();
    error BadShare();
    error TooManyRecipients();
    error WrongPayout();

    constructor(address hook) {
        HOOK = OstraHook(hook);
    }

    // ---------------------------------------------------------------------------------------------
    // Creator vault
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets `recipient`'s share of the pool's creator payouts (see FIELD_SHARE). Only the pool's creator
    ///         vault; a share equal to the current one, a zero recipient, the creator vault itself, or a total above
    ///         10,000 bps reverts.
    function configure(bytes32 poolId, uint8 field, uint256 value) external {
        PoolId id = PoolId.wrap(poolId);
        Split storage sp = _splits[id];
        address primary = _primary(sp, id);
        if (msg.sender != primary) revert OnlyCreatorVault();
        if (field != FIELD_SHARE) revert BadField();
        address recipient = address(uint160(value));
        uint256 bps = value >> 160;
        if (recipient == address(0) || recipient == primary || bps > BPS) revert BadShare();
        Account storage a = sp.accounts[recipient];
        uint256 current = a.bps;
        if (bps == current) revert BadShare();
        uint256 assigned = uint256(sp.assigned) - current + bps;
        if (assigned > BPS) revert BadShare();
        // Both the recipient's and the creator vault's shares change: settle them at the old shares first.
        _settle(sp, primary, BPS - sp.assigned);
        _settle(sp, recipient, current);
        a.bps = uint16(bps);
        sp.assigned = uint16(assigned);
        if (current == 0) {
            if (sp.recipients.length == MAX_RECIPIENTS) revert TooManyRecipients();
            sp.recipients.push(recipient);
            sp.position[recipient] = sp.recipients.length;
        } else if (bps == 0) {
            uint256 index = sp.position[recipient] - 1;
            address last = sp.recipients[sp.recipients.length - 1];
            sp.recipients[index] = last;
            sp.position[last] = index + 1;
            sp.recipients.pop();
            delete sp.position[recipient];
        }
        emit ShareSet(id, recipient, uint16(bps));
    }

    // ---------------------------------------------------------------------------------------------
    // Payouts
    // ---------------------------------------------------------------------------------------------

    /// @notice Books `amount` of `token`, already sent here, as a creator payout of the pool. Only the dispatcher.
    function credit(PoolId id, address token, address primary, uint256 amount) external {
        if (msg.sender != HOOK.dispatcher()) revert OnlyDispatcher();
        Split storage sp = _splits[id];
        if (sp.token == address(0)) sp.token = token;
        else if (sp.token != token) revert WrongPayout();
        if (sp.primary == address(0)) sp.primary = primary;
        else if (sp.primary != primary) revert WrongPayout();
        sp.acc += (amount * MAGNITUDE) / BPS;
        emit Credited(id, token, amount);
    }

    /// @notice Pays `account` what it is owed from the pool's creator payouts. Anyone may call it; the payout only
    ///         ever goes to `account`.
    function release(PoolId id, address account) external returns (uint256 amount) {
        Split storage sp = _splits[id];
        _settle(sp, account, _bpsOf(sp, account));
        Account storage a = sp.accounts[account];
        amount = a.owed;
        if (amount == 0) return 0;
        a.owed = 0;
        emit Released(id, account, amount);
        IERC20(sp.token).safeTransfer(account, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function recipientCount(PoolId id) external view returns (uint256) {
        return _splits[id].recipients.length;
    }

    /// @notice The pool's recipients and their shares; the creator vault holds 10,000 bps minus their sum.
    function recipients(PoolId id) external view returns (address[] memory accounts, uint16[] memory bps) {
        Split storage sp = _splits[id];
        uint256 n = sp.recipients.length;
        accounts = new address[](n);
        bps = new uint16[](n);
        for (uint256 i = 0; i < n; ++i) {
            accounts[i] = sp.recipients[i];
            bps[i] = sp.accounts[accounts[i]].bps;
        }
    }

    /// @notice `account`'s share in bps (the creator vault's is what the recipients do not hold).
    function shareOf(PoolId id, address account) external view returns (uint256) {
        return _bpsOf(_splits[id], account);
    }

    /// @notice What `account` can release now.
    function owedOf(PoolId id, address account) external view returns (uint256) {
        Split storage sp = _splits[id];
        Account storage a = sp.accounts[account];
        return a.owed + (_bpsOf(sp, account) * (sp.acc - a.lastAcc)) / MAGNITUDE;
    }

    function payoutToken(PoolId id) external view returns (address) {
        return _splits[id].token;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _primary(Split storage sp, PoolId id) private returns (address primary) {
        primary = sp.primary;
        if (primary == address(0)) {
            primary = HOOK.poolConfig(id).creatorVault;
            if (primary == address(0)) revert NotRegistered();
            sp.primary = primary;
        }
    }

    function _bpsOf(Split storage sp, address account) private view returns (uint256) {
        if (account == sp.primary && account != address(0)) return BPS - sp.assigned;
        return sp.accounts[account].bps;
    }

    function _settle(Split storage sp, address account, uint256 bps) private {
        Account storage a = sp.accounts[account];
        uint256 acc = sp.acc;
        if (bps != 0) a.owed += (bps * (acc - a.lastAcc)) / MAGNITUDE;
        a.lastAcc = acc;
    }
}
