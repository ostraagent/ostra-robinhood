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

/// @notice A plain client of the deployed PoolManager for the fork tests: swaps (exact input or exact output; one or
///         several in one transaction; with hookData) and adds liquidity, paying from its own balance after each
///         PoolManager call (flash accounting), like the Uniswap routers. It sends what it receives to `recipient`.
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
        return _swaps(key, _one(zeroForOne), _one(amountSpecified), recipient, "", 0);
    }

    /// @notice A swap that stops at `sqrtPriceLimitX96` instead of the extreme price.
    function swapToLimit(
        PoolKey memory key,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        address recipient
    ) external returns (BalanceDelta) {
        return _swaps(key, _one(zeroForOne), _one(amountSpecified), recipient, "", sqrtPriceLimitX96);
    }

    function swapWithData(
        PoolKey memory key,
        bool zeroForOne,
        int256 amountSpecified,
        address recipient,
        bytes memory hookData
    ) external returns (BalanceDelta) {
        return _swaps(key, _one(zeroForOne), _one(amountSpecified), recipient, hookData, 0);
    }

    /// @notice Several swaps on one pool within one unlock, so within one transaction; returns the last delta.
    function swaps(PoolKey memory key, bool[] memory zeroForOne, int256[] memory amountSpecified, address recipient)
        external
        returns (BalanceDelta)
    {
        return _swaps(key, zeroForOne, amountSpecified, recipient, "", 0);
    }

    function _swaps(
        PoolKey memory key,
        bool[] memory zeroForOne,
        int256[] memory amountSpecified,
        address recipient,
        bytes memory hookData,
        uint160 limit
    ) private returns (BalanceDelta) {
        return abi.decode(
            POOL_MANAGER.unlock(
                abi.encode(uint8(1), abi.encode(key, zeroForOne, amountSpecified, recipient, hookData, limit))
            ),
            (BalanceDelta)
        );
    }

    function _one(bool b) private pure returns (bool[] memory list) {
        list = new bool[](1);
        list[0] = b;
    }

    function _one(int256 a) private pure returns (int256[] memory list) {
        list = new int256[](1);
        list[0] = a;
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
            bool[] memory zeroForOne;
            int256[] memory amountSpecified;
            bytes memory hookData;
            uint160 limit;
            (key, zeroForOne, amountSpecified, recipient, hookData, limit) =
                abi.decode(args, (PoolKey, bool[], int256[], address, bytes, uint160));
            for (uint256 i = 0; i < zeroForOne.length; ++i) {
                uint160 extreme = zeroForOne[i] ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
                delta = POOL_MANAGER.swap(
                    key,
                    IPoolManager.SwapParams({
                        zeroForOne: zeroForOne[i],
                        amountSpecified: amountSpecified[i],
                        sqrtPriceLimitX96: limit == 0 ? extreme : limit
                    }),
                    hookData
                );
                if (i + 1 < zeroForOne.length) {
                    _settle(key.currency0, delta.amount0(), recipient);
                    _settle(key.currency1, delta.amount1(), recipient);
                }
            }
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
