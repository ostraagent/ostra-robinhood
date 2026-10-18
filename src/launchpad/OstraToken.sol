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
///   the token's Ostra pool owes (OstraHook credits that exact amount) or from the hook and the locker, and it
///   enters no pool of the Uniswap v2 or v3 kind (a contract whose token0() or token1() is this token: Uniswap v2
///   pairs, v3 pools and their forks), so the token's liquidity and trading stay in the Ostra pool.
/// * Dividends: when DIVIDEND_TOKEN is set, every holder with at least MIN_DIVIDEND_BALANCE earns a share of what
///   the hook distributes, in proportion to its balance. A holder claims what it has earned to any recipient
///   (claimTo); an OstraVault holding the token claims through its ClaimDividend spend, to its owner's vault for
///   the dividend token, since a vault only ever spends its own token.
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
        /// @notice From the deployment block (so the token's CREATE2 address does not depend on the block).
        uint32 limitsDuration;
        uint32 antiFarmerDuration;
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

    /// @dev Gas a pool probe (token0() or token1()) may use: a Uniswap v2 pair reads one storage slot, a v3 pool an
    ///      immutable; a contract that needs more is not treated as a pool.
    uint256 private constant POOL_PROBE_GAS = 20_000;

    event LimitsReleased();
    event DividendsDistributed(uint256 amount);
    event DividendClaimed(address indexed holder, address indexed recipient, uint256 amount);

    error OnlyHook();
    error MaxWalletExceeded(address holder);
    error AntiFarmer();
    error NoDividends();
    error NoShares();
    error ZeroRecipient();

    constructor(Settings memory s) ERC20(s.name, s.symbol) {
        POOL_MANAGER = s.poolManager;
        HOOK = s.hook;
        LOCKER = s.locker;
        LAUNCHPAD = s.launchpad;
        MAX_WALLET = s.maxWallet;
        LIMITS_END_AT = uint40(block.timestamp) + s.limitsDuration;
        ANTI_FARMER_END_AT = uint40(block.timestamp) + s.antiFarmerDuration;
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

    /// @notice Pays the caller's earned dividends to `recipient`. Only the holder itself can claim: a holder that
    ///         is a contract decides where its dividends go (an OstraVault cannot spend any token but its own).
    function claimTo(address recipient) external returns (uint256 amount) {
        if (recipient == address(0)) revert ZeroRecipient();
        amount = dividendOf(msg.sender);
        if (amount == 0) return 0;
        withdrawnDividendOf[msg.sender] += amount;
        emit DividendClaimed(msg.sender, recipient, amount);
        if (DIVIDEND_TOKEN == address(this)) {
            _transfer(address(this), recipient, amount);
        } else {
            IERC20(DIVIDEND_TOKEN).safeTransfer(recipient, amount);
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
        if (block.timestamp < ANTI_FARMER_END_AT) {
            if (to == POOL_MANAGER) {
                if (from != HOOK && from != LOCKER) {
                    uint256 credit = _poolManagerCredit;
                    if (value > credit) revert AntiFarmer();
                    _poolManagerCredit = credit - value;
                }
            } else if (to.code.length != 0 && !isSystemAccount(to) && _isPoolOfThisToken(to)) {
                revert AntiFarmer();
            }
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

    /// @dev Whether `account` answers token0() or token1() with this token, as Uniswap v2 pairs and v3 pools do.
    function _isPoolOfThisToken(address account) private view returns (bool) {
        return _probe(account, 0x0dfe1681) || _probe(account, 0xd21220a7); // token0(), token1()
    }

    /// @dev Static call of a no-argument getter with bounded gas, reading at most one word back.
    function _probe(address account, bytes4 selector) private view returns (bool isThis) {
        address self = address(this);
        assembly ("memory-safe") {
            mstore(0x00, selector)
            let ok := staticcall(POOL_PROBE_GAS, account, 0x00, 0x04, 0x00, 0x20)
            isThis := and(ok, and(gt(returndatasize(), 0x1f), eq(mload(0x00), self)))
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
