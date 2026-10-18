// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @title OstraLocker
/// @notice Owns every liquidity position of the Ostra pools and has no function that removes liquidity, so the
///         launch liquidity (and what the hook's LP bucket adds) stays in the pool forever. Its only other power is
///         collecting the positions' LP fees, which it hands to OstraHook to share 70/30 between the creator and
///         the protocol.
contract OstraLocker is IUnlockCallback {
    using SafeERC20 for IERC20;

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        bytes32 salt;
    }

    /// @notice Salt of the full-range position the hook's LP bucket adds to.
    bytes32 public constant LP_BUCKET_SALT = bytes32(type(uint256).max);

    IPoolManager public immutable POOL_MANAGER;
    address public immutable LAUNCHPAD;
    address public immutable HOOK;

    mapping(PoolId => Position[]) private _positions;
    mapping(PoolId => bool) public hasLpBucketPosition;

    event Locked(PoolId indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, bytes32 salt);

    error OnlyLaunchpad();
    error OnlyHook();
    error OnlyPoolManager();
    error AlreadyLocked();
    error BadPositions();
    error UnexpectedDelta();

    constructor(address poolManager, address launchpad, address hook) {
        POOL_MANAGER = IPoolManager(poolManager);
        LAUNCHPAD = launchpad;
        HOOK = hook;
    }

    function positionsOf(PoolId poolId) external view returns (Position[] memory) {
        return _positions[poolId];
    }

    /// @notice Puts the launch supply into the pool as single-sided positions, one per tier. Only the launchpad,
    ///         once per pool, right after it initialized the pool; `token` is this contract's own launch supply.
    function lockLaunch(
        PoolKey calldata key,
        address token,
        int24[] calldata tickLowers,
        int24[] calldata tickUppers,
        uint128[] calldata liquidities
    ) external {
        if (msg.sender != LAUNCHPAD) revert OnlyLaunchpad();
        PoolId id = key.toId();
        if (_positions[id].length != 0) revert AlreadyLocked();
        uint256 n = tickLowers.length;
        if (n == 0 || tickUppers.length != n || liquidities.length != n) revert BadPositions();
        POOL_MANAGER.unlock(abi.encode(key, token, tickLowers, tickUppers, liquidities));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert OnlyPoolManager();
        (PoolKey memory key, address token, int24[] memory lowers, int24[] memory uppers, uint128[] memory liq) =
            abi.decode(data, (PoolKey, address, int24[], int24[], uint128[]));
        PoolId id = key.toId();
        bool tokenIs0 = Currency.unwrap(key.currency0) == token;
        int256 owed;
        for (uint256 i = 0; i < lowers.length; ++i) {
            bytes32 salt = bytes32(i);
            (BalanceDelta delta,) = POOL_MANAGER.modifyLiquidity(
                key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: lowers[i],
                    tickUpper: uppers[i],
                    liquidityDelta: int256(uint256(liq[i])),
                    salt: salt
                }),
                ""
            );
            // Single-sided: only the token is owed, never the quote.
            int128 tokenDelta = tokenIs0 ? delta.amount0() : delta.amount1();
            int128 quoteDelta = tokenIs0 ? delta.amount1() : delta.amount0();
            if (quoteDelta != 0 || tokenDelta > 0) revert UnexpectedDelta();
            owed += -int256(tokenDelta);
            _positions[id].push(Position({tickLower: lowers[i], tickUpper: uppers[i], salt: salt}));
            emit Locked(id, lowers[i], uppers[i], liq[i], salt);
        }
        Currency currency = Currency.wrap(token);
        POOL_MANAGER.sync(currency);
        IERC20(token).safeTransfer(address(POOL_MANAGER), uint256(owed));
        POOL_MANAGER.settle();
        // What rounding left over is burned: the launch supply is in the pool or gone.
        uint256 left = IERC20(token).balanceOf(address(this));
        if (left != 0) IERC20(token).safeTransfer(0x000000000000000000000000000000000000dEaD, left);
        return "";
    }

    /// @notice Adds `liquidity` to the pool's full-range LP-bucket position. Only the hook, inside its own unlock;
    ///         the hook settles what the position costs for this contract (settleFor).
    function addFullRange(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        returns (BalanceDelta delta)
    {
        if (msg.sender != HOOK) revert OnlyHook();
        PoolId id = key.toId();
        (delta,) = POOL_MANAGER.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: LP_BUCKET_SALT
            }),
            ""
        );
        if (!hasLpBucketPosition[id]) {
            hasLpBucketPosition[id] = true;
            _positions[id].push(Position({tickLower: tickLower, tickUpper: tickUpper, salt: LP_BUCKET_SALT}));
        }
        emit Locked(id, tickLower, tickUpper, liquidity, LP_BUCKET_SALT);
    }

    /// @notice Collects the LP fees of every position of the pool as PoolManager claims of the hook. Only the
    ///         hook, inside its own unlock. Returns the fees in currency0 and currency1.
    function collectToHook(PoolKey calldata key) external returns (uint256 fees0, uint256 fees1) {
        if (msg.sender != HOOK) revert OnlyHook();
        Position[] storage ps = _positions[key.toId()];
        for (uint256 i = 0; i < ps.length; ++i) {
            Position memory p = ps[i];
            (BalanceDelta delta,) = POOL_MANAGER.modifyLiquidity(
                key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: p.tickLower,
                    tickUpper: p.tickUpper,
                    liquidityDelta: 0,
                    salt: p.salt
                }),
                ""
            );
            int128 a0 = delta.amount0();
            int128 a1 = delta.amount1();
            if (a0 < 0 || a1 < 0) revert UnexpectedDelta();
            fees0 += uint256(int256(a0));
            fees1 += uint256(int256(a1));
        }
        // As PoolManager claims of the hook (ERC-6909), like everything the hook holds for a pool.
        if (fees0 != 0) POOL_MANAGER.mint(HOOK, key.currency0.toId(), fees0);
        if (fees1 != 0) POOL_MANAGER.mint(HOOK, key.currency1.toId(), fees1);
    }
}
