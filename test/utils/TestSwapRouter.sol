// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @notice A plain client of the deployed PoolManager for the fork tests: swaps (exact input or exact output) and
///         adds liquidity, paying from its own balance after the PoolManager call (flash accounting), like the
///         Uniswap routers. It sends what it receives to `recipient`.
contract TestSwapRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable POOL_MANAGER;

    constructor(address poolManager) {
        POOL_MANAGER = IPoolManager(poolManager);
    }

    receive() external payable {}

    function swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified, address recipient)
        external
        returns (BalanceDelta)
    {
        return abi.decode(
            POOL_MANAGER.unlock(abi.encode(uint8(1), abi.encode(key, zeroForOne, amountSpecified, recipient))),
            (BalanceDelta)
        );
    }

    function addLiquidity(PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidity)
        external
        returns (BalanceDelta)
    {
        return abi.decode(
            POOL_MANAGER.unlock(abi.encode(uint8(2), abi.encode(key, tickLower, tickUpper, liquidity))), (BalanceDelta)
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(POOL_MANAGER), "only pool manager");
        (uint8 op, bytes memory args) = abi.decode(data, (uint8, bytes));
        BalanceDelta delta;
        PoolKey memory key;
        address recipient = address(this);
        if (op == 1) {
            bool zeroForOne;
            int256 amountSpecified;
            (key, zeroForOne, amountSpecified, recipient) = abi.decode(args, (PoolKey, bool, int256, address));
            delta = POOL_MANAGER.swap(
                key,
                IPoolManager.SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: amountSpecified,
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
        } else {
            int24 lower;
            int24 upper;
            int256 liquidity;
            (key, lower, upper, liquidity) = abi.decode(args, (PoolKey, int24, int24, int256));
            (delta,) = POOL_MANAGER.modifyLiquidity(
                key,
                IPoolManager.ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liquidity, salt: 0}),
                ""
            );
        }
        _settle(key.currency0, delta.amount0(), recipient);
        _settle(key.currency1, delta.amount1(), recipient);
        return abi.encode(delta);
    }

    function _settle(Currency currency, int128 amount, address recipient) private {
        if (amount < 0) {
            uint256 owed = uint256(-int256(amount));
            if (currency.isAddressZero()) {
                POOL_MANAGER.settle{value: owed}();
            } else {
                POOL_MANAGER.sync(currency);
                IERC20(Currency.unwrap(currency)).safeTransfer(address(POOL_MANAGER), owed);
                POOL_MANAGER.settle();
            }
        } else if (amount > 0) {
            POOL_MANAGER.take(currency, recipient, uint256(int256(amount)));
        }
    }
}
