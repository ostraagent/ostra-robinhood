// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {OstraHook} from "./OstraHook.sol";
import {OstraLaunchpad} from "./OstraLaunchpad.sol";
import {OstraVesting} from "./OstraVesting.sol";

/// @title OstraDevBuy
/// @notice Launches a token through OstraLaunchpad and makes the creator's dev buy in the same transaction (design
///         v0.4, "Blok modular", approved 18 Oct 2026): the launching account pays `quoteIn` of the pool's quote, the
///         buy goes through the pool like any other, paying the hook fee and the buy tax, bounded by the max buy, the
///         max wallet and the circuit breaker (only the anti-snipe tax does not apply: nobody can buy before it in
///         the launch transaction), and the tokens go to a new OstraVesting clone for the pool, which pays them to
///         the creator's token vault after a cliff of MIN_CLIFF to MAX_CLIFF, linearly over at most MAX_VESTING. A
///         dev buy is at most MAX_DEV_BUY_BPS of the supply. Its terms and amounts are in the DevBought event.
///         The launch salt is bound to the launching account (launchSalt), so nobody else can take a launch's
///         token address first.
contract OstraDevBuy is IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @notice At most 5% of the supply (Hookr's max buy, read 18 Oct 2026).
    uint256 public constant MAX_DEV_BUY_BPS = 500;
    /// @notice Clanker's shortest vault lock (7 days) to Hookr's longest dev buy lock (365 days).
    uint32 public constant MIN_CLIFF = 7 days;
    uint32 public constant MAX_CLIFF = 365 days;
    uint32 public constant MAX_VESTING = 365 days;

    IPoolManager public immutable POOL_MANAGER;
    OstraLaunchpad public immutable LAUNCHPAD;
    OstraHook public immutable HOOK;
    /// @notice The OstraVesting implementation every dev buy's vesting clones.
    address public immutable VESTING;

    struct DevBuy {
        /// @notice Paid in the pool's quote by the launching account (with the launch fee, in ETH, for an ETH pool).
        uint256 quoteIn;
        /// @notice The creator's vault for the token: receives the tokens as they vest.
        address beneficiary;
        /// @notice Receives the dividends the vesting tokens earn; required when the pool pays dividends.
        address dividendRecipient;
        uint32 cliff;
        uint32 duration;
    }

    event DevBought(
        PoolId indexed poolId,
        address indexed token,
        address vesting,
        uint256 quotePaid,
        uint256 tokens,
        uint256 cliffEnd,
        uint256 vestingEnd
    );

    error BadDevBuy(string what);
    error WrongValue();
    error DevBuyTooLarge();
    error UnexpectedCallback();

    bool private transient _buying;

    constructor(address poolManager, address launchpad) {
        POOL_MANAGER = IPoolManager(poolManager);
        LAUNCHPAD = OstraLaunchpad(launchpad);
        HOOK = LAUNCHPAD.HOOK();
        VESTING = address(new OstraVesting());
    }

    /// @notice The salt OstraLaunchpad gets for `creator`'s launch with `salt`.
    function launchSalt(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    /// @notice The address `launch` gives the token when `creator` launches with `p`.
    function tokenAddress(address creator, OstraLaunchpad.LaunchParams calldata p) external view returns (address) {
        OstraLaunchpad.LaunchParams memory q = p;
        q.salt = launchSalt(creator, p.salt);
        return LAUNCHPAD.tokenAddress(address(this), q);
    }

    /// @notice Launches with `p` and makes the dev buy `d`. msg.value is the launch fee, plus `d.quoteIn` for an ETH
    ///         pool; for an ERC-20 quote this contract must be allowed to take `d.quoteIn` from the caller. What the
    ///         swap does not spend comes back to the caller.
    function launch(OstraLaunchpad.LaunchParams calldata p, DevBuy calldata d)
        external
        payable
        nonReentrant
        returns (address token, PoolId id, address vesting)
    {
        _check(p, d);
        address quote = Currency.unwrap(p.quote);
        (token, id) = _launch(p, quote == address(0) ? d.quoteIn : 0);
        vesting = _vesting(token, id, d);
        _devBuy(id, token, vesting, quote, d);
    }

    function _launch(OstraLaunchpad.LaunchParams calldata p, uint256 ethIn) private returns (address, PoolId) {
        uint256 fee = LAUNCHPAD.LAUNCH_FEE();
        if (msg.value != fee + ethIn) revert WrongValue();
        OstraLaunchpad.LaunchParams memory q = p;
        q.salt = launchSalt(msg.sender, p.salt);
        return LAUNCHPAD.launch{value: fee}(q);
    }

    function _vesting(address token, PoolId id, DevBuy calldata d) private returns (address) {
        OstraVesting.Terms memory t = OstraVesting.Terms({
            token: token,
            beneficiary: d.beneficiary,
            dividendRecipient: d.dividendRecipient,
            start: uint40(block.timestamp),
            cliff: d.cliff,
            duration: d.duration
        });
        address vesting = Clones.cloneDeterministicWithImmutableArgs(VESTING, abi.encode(t), PoolId.unwrap(id));
        // The vesting paying itself would lock the tokens (or dividends) forever.
        if (d.beneficiary == vesting || d.dividendRecipient == vesting) revert BadDevBuy("beneficiary");
        return vesting;
    }

    function _devBuy(PoolId id, address token, address vesting, address quote, DevBuy calldata d) private {
        if (quote != address(0)) IERC20(quote).safeTransferFrom(msg.sender, address(this), d.quoteIn);
        (uint256 paid, uint256 tokens) = _buy(HOOK.poolKey(id), token, d.quoteIn, vesting);
        if (tokens > (LAUNCHPAD.SUPPLY() * MAX_DEV_BUY_BPS) / BPS) revert DevBuyTooLarge();
        _refund(quote, d.quoteIn - paid);
        uint256 cliffEnd = block.timestamp + d.cliff;
        emit DevBought(id, token, vesting, paid, tokens, cliffEnd, cliffEnd + d.duration);
    }

    function _check(OstraLaunchpad.LaunchParams calldata p, DevBuy calldata d) private pure {
        if (d.quoteIn == 0) revert BadDevBuy("quoteIn");
        if (d.beneficiary == address(0)) revert BadDevBuy("beneficiary");
        if (p.dividendToken != address(0) && d.dividendRecipient == address(0)) revert BadDevBuy("dividendRecipient");
        if (d.cliff < MIN_CLIFF || d.cliff > MAX_CLIFF) revert BadDevBuy("cliff");
        if (d.duration > MAX_VESTING) revert BadDevBuy("duration");
    }

    function _buy(PoolKey memory key, address token, uint256 quoteIn, address to)
        private
        returns (uint256 paid, uint256 tokens)
    {
        _buying = true;
        (paid, tokens) = abi.decode(POOL_MANAGER.unlock(abi.encode(key, token, quoteIn, to)), (uint256, uint256));
        if (_buying) revert UnexpectedCallback();
    }

    function _refund(address quote, uint256 amount) private {
        if (amount == 0) return;
        if (quote == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert WrongValue();
        } else {
            IERC20(quote).safeTransfer(msg.sender, amount);
        }
    }

    /// @notice PoolManager callback: works only inside this contract's own dev buy.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER) || !_buying) revert UnexpectedCallback();
        _buying = false;
        (PoolKey memory key, address token, uint256 quoteIn, address to) =
            abi.decode(data, (PoolKey, address, uint256, address));
        bool tokenIs0 = Currency.unwrap(key.currency0) == token;
        // A buy spends the quote: currency1 in when the token is currency0.
        bool zeroForOne = !tokenIs0;
        BalanceDelta delta = POOL_MANAGER.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(quoteIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 quoteDelta = tokenIs0 ? delta.amount1() : delta.amount0();
        int128 tokenDelta = tokenIs0 ? delta.amount0() : delta.amount1();
        uint256 paid = uint256(-int256(quoteDelta));
        uint256 tokens = uint256(int256(tokenDelta));
        Currency quote = tokenIs0 ? key.currency1 : key.currency0;
        if (quote.isAddressZero()) {
            POOL_MANAGER.settle{value: paid}();
        } else {
            POOL_MANAGER.sync(quote);
            IERC20(Currency.unwrap(quote)).safeTransfer(address(POOL_MANAGER), paid);
            POOL_MANAGER.settle();
        }
        POOL_MANAGER.take(Currency.wrap(token), to, tokens);
        return abi.encode(paid, tokens);
    }
}
