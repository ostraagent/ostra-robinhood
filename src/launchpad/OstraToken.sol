// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title OstraToken
/// @notice A token launched by OstraLaunchpad: a fixed supply minted once to OstraLocker, which puts all of it
///         into the token's Ostra pool. Three rules come from the pool's launch settings and are enforced here,
///         because a Uniswap v4 hook only sees the router, never the wallet that ends up holding the tokens:
/// * Max wallet: until the pool graduates (OstraHook calls releaseLimits) or LIMITS_END_AT, whichever is first,
///   no holder may end a transfer above MAX_WALLET. The PoolManager, the hook, the locker, the launchpad, this
///   contract and the dead address are the only accounts the rule does not apply to; there is no other list.
/// * Anti-farmer: until ANTI_FARMER_END_AT the token enters the Uniswap v4 PoolManager only to pay what a swap in
///   the token's Ostra pool owes (OstraHook credits that exact amount) or from the hook and the locker, so the
///   token's v4 liquidity and trading stay in the Ostra pool. Pools on other exchanges are not covered.
/// * Dividends: when DIVIDEND_TOKEN is set, every holder with at least MIN_DIVIDEND_BALANCE earns a share of what
///   the hook distributes, in proportion to its balance. Anyone may pay a holder what it has earned (claim); it
///   always goes to the holder itself.
contract OstraToken is ERC20Burnable {
    using SafeERC20 for IERC20;

    struct Settings {
        string name;
        string symbol;
        uint256 supply;
        address poolManager;
        address hook;
        address locker;
        address launchpad;
        uint256 maxWallet;
        uint40 limitsEndAt;
        uint40 antiFarmerEndAt;
        address dividendToken;
        uint256 minDividendBalance;
    }

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant MAGNITUDE = 2 ** 128;

    address public immutable POOL_MANAGER;
    address public immutable HOOK;
    address public immutable LOCKER;
    address public immutable LAUNCHPAD;
    /// @notice 0 = no max wallet.
    uint256 public immutable MAX_WALLET;
    uint40 public immutable LIMITS_END_AT;
    uint40 public immutable ANTI_FARMER_END_AT;
    /// @notice address(0) = no dividends; address(this) = dividends in this token.
    address public immutable DIVIDEND_TOKEN;
    uint256 public immutable MIN_DIVIDEND_BALANCE;

    /// @notice Set once by the hook when the pool graduates: the max wallet no longer applies.
    bool public limitsReleased;

    uint256 public magnifiedDividendPerShare;
    uint256 public totalDividendShares;
    mapping(address account => uint256) public dividendSharesOf;
    mapping(address account => int256) private _dividendCorrection;
    mapping(address account => uint256) public withdrawnDividendOf;

    /// @dev What the token may still move into the PoolManager in this transaction during the anti-farmer period.
    uint256 private transient _poolManagerCredit;

    event LimitsReleased();
    event DividendsDistributed(uint256 amount);
    event DividendClaimed(address indexed holder, uint256 amount);

    error OnlyHook();
    error MaxWalletExceeded(address holder);
    error AntiFarmer();
    error NoDividends();
    error NoShares();

    constructor(Settings memory s) ERC20(s.name, s.symbol) {
        POOL_MANAGER = s.poolManager;
        HOOK = s.hook;
        LOCKER = s.locker;
        LAUNCHPAD = s.launchpad;
        MAX_WALLET = s.maxWallet;
        LIMITS_END_AT = s.limitsEndAt;
        ANTI_FARMER_END_AT = s.antiFarmerEndAt;
        // The launchpad cannot name this token's address before it exists: its own address stands for it.
        DIVIDEND_TOKEN = s.dividendToken == s.launchpad ? address(this) : s.dividendToken;
        MIN_DIVIDEND_BALANCE = s.minDividendBalance;
        _mint(s.locker, s.supply);
    }

    modifier onlyHook() {
        if (msg.sender != HOOK) revert OnlyHook();
        _;
    }

    // ---------------------------------------------------------------------------------------------
    // Hook calls
    // ---------------------------------------------------------------------------------------------

    function releaseLimits() external onlyHook {
        if (!limitsReleased) {
            limitsReleased = true;
            emit LimitsReleased();
        }
    }

    /// @notice Lets `amount` more of the token enter the PoolManager in this transaction: what a swap in the
    ///         token's Ostra pool owes the PoolManager.
    function creditPoolManager(uint256 amount) external onlyHook {
        _poolManagerCredit += amount;
    }

    /// @notice Shares `amount` of DIVIDEND_TOKEN, already sent to this contract, among the holders.
    function distributeDividends(uint256 amount) external onlyHook {
        if (DIVIDEND_TOKEN == address(0)) revert NoDividends();
        if (totalDividendShares == 0) revert NoShares();
        magnifiedDividendPerShare += (amount * MAGNITUDE) / totalDividendShares;
        emit DividendsDistributed(amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Dividends
    // ---------------------------------------------------------------------------------------------

    function dividendOf(address holder) public view returns (uint256) {
        int256 accumulated = int256(magnifiedDividendPerShare * dividendSharesOf[holder]) + _dividendCorrection[holder];
        return uint256(accumulated) / MAGNITUDE - withdrawnDividendOf[holder];
    }

    /// @notice Pays `holder` the dividends it has earned; anyone may call, the tokens only go to the holder.
    function claim(address holder) external returns (uint256 amount) {
        amount = dividendOf(holder);
        if (amount == 0) return 0;
        withdrawnDividendOf[holder] += amount;
        emit DividendClaimed(holder, amount);
        if (DIVIDEND_TOKEN == address(this)) {
            _transfer(address(this), holder, amount);
        } else {
            IERC20(DIVIDEND_TOKEN).safeTransfer(holder, amount);
        }
    }

    /// @notice True for the accounts the max wallet and dividend shares never apply to.
    function isSystemAccount(address account) public view returns (bool) {
        return account == POOL_MANAGER || account == HOOK || account == LOCKER || account == LAUNCHPAD
            || account == address(this) || account == DEAD || account == address(0);
    }

    // ---------------------------------------------------------------------------------------------
    // Transfers
    // ---------------------------------------------------------------------------------------------

    function _update(address from, address to, uint256 value) internal override {
        if (to == POOL_MANAGER && block.timestamp < ANTI_FARMER_END_AT && from != HOOK && from != LOCKER) {
            uint256 credit = _poolManagerCredit;
            if (value > credit) revert AntiFarmer();
            _poolManagerCredit = credit - value;
        }
        super._update(from, to, value);
        if (MAX_WALLET != 0 && !limitsReleased && block.timestamp < LIMITS_END_AT && !isSystemAccount(to)) {
            if (balanceOf(to) > MAX_WALLET) revert MaxWalletExceeded(to);
        }
        if (DIVIDEND_TOKEN != address(0)) {
            _setDividendShares(from);
            _setDividendShares(to);
        }
    }

    function _setDividendShares(address account) private {
        uint256 shares;
        if (!isSystemAccount(account)) {
            uint256 balance = balanceOf(account);
            if (balance >= MIN_DIVIDEND_BALANCE) shares = balance;
        }
        uint256 current = dividendSharesOf[account];
        if (shares == current) return;
        if (shares > current) {
            uint256 added = shares - current;
            totalDividendShares += added;
            _dividendCorrection[account] -= int256(magnifiedDividendPerShare * added);
        } else {
            uint256 removed = current - shares;
            totalDividendShares -= removed;
            _dividendCorrection[account] += int256(magnifiedDividendPerShare * removed);
        }
        dividendSharesOf[account] = shares;
    }
}
