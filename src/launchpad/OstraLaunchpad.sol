// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {OstraHook} from "./OstraHook.sol";
import {OstraLocker} from "./OstraLocker.sol";
import {OstraToken} from "./OstraToken.sol";

interface IOstraVaultToken {
    function token() external view returns (address);
}

interface IWETH9Deposit {
    function deposit() external payable;
}

/// @title OstraLaunchpad
/// @notice Launches a token on Robinhood Chain's Uniswap v4 with OstraHook from its first block: a fixed supply of
///         SUPPLY tokens, all of it single-sided liquidity in tiers above the starting price (the top tier open to
///         the highest price), held by OstraLocker forever; no bonding-curve contract and no migration. The pool's
///         rules (taxes, buckets, anti-snipe, limits, anti-farmer, graduation) are the creator's, fixed at launch,
///         inside the bounds below. The launch fee is LAUNCH_FEE in ETH (paying it in OSTRA, at 30% off and burned,
///         comes once OSTRA exists). A pool quoted in a Robinhood stock token (one whose access registry is
///         ROBINHOOD_STOCK_REGISTRY, as every stock token's is) pays OstraFees' session fee; the volatility fee is the
///         creator's choice.
contract OstraLaunchpad is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint256 public constant LAUNCH_FEE = 0.0002 ether;
    uint16 public constant MAX_TAX_BPS = 1_000;
    uint16 public constant MAX_ANTI_SNIPE_BPS = 8_000;
    uint32 public constant MAX_ANTI_SNIPE_DURATION = 1 hours;
    uint32 public constant MAX_ANTI_FARMER_DURATION = 365 days;
    uint256 public constant MAX_TIERS = 8;
    /// @notice The access registry (and beacon) every Robinhood stock token reports (ACCESS_CONTROLLED_REGISTRY;
    ///         read on chain 18 Oct 2026 for AAPL, TSLA, NVDA and SPY).
    address public constant ROBINHOOD_STOCK_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    uint256 private constant STOCK_PROBE_GAS = 20_000;

    struct Tier {
        /// @notice Width in ticks, a multiple of the tick spacing; 0 only for the last tier (open to the top).
        uint24 width;
        uint16 supplyBps;
    }

    struct LaunchParams {
        string name;
        string symbol;
        bytes32 salt;
        Currency quote;
        /// @notice The creator's OstraVault for the quote (for WETH when the quote is ETH): payouts and owner.
        address creatorVault;
        /// @notice The pool's starting tick, a multiple of the tick spacing.
        int24 startTick;
        Tier[] tiers;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 postBuyTaxBps;
        uint16 postSellTaxBps;
        uint32 taxDuration;
        uint16 creatorBucketBps;
        uint16 dividendBucketBps;
        uint16 burnBucketBps;
        uint16 lpBucketBps;
        address dividendToken;
        PoolKey dividendKey;
        uint256 minDividendBalance;
        uint16 antiSnipeBps;
        uint32 antiSnipeDuration;
        uint128 maxBuy;
        uint256 maxWallet;
        uint32 limitsDuration;
        uint32 antiFarmerDuration;
        uint8 graduationKind;
        uint128 graduationThreshold;
        /// @notice The LP fee follows the price's distance from its 60-second EMA, up to 1% (OstraFees).
        bool volatilityFee;
    }

    IPoolManager public immutable POOL_MANAGER;
    OstraHook public immutable HOOK;
    address public immutable WETH;
    OstraLocker public locker;
    uint256 public launchFeesOwed;

    event Launched(PoolId indexed poolId, address indexed token, address indexed creatorVault, Currency quote);
    event LaunchFeesClaimed(address to, uint256 amount);

    error AlreadySet();
    error WrongFee();
    error BadParams(string what);

    constructor(address poolManager, address hook, address weth, address admin) Ownable(admin) {
        POOL_MANAGER = IPoolManager(poolManager);
        HOOK = OstraHook(payable(hook));
        WETH = weth;
    }

    function setLocker(address locker_) external onlyOwner {
        if (address(locker) != address(0)) revert AlreadySet();
        locker = OstraLocker(locker_);
    }

    /// @notice The CREATE2 salt of the token `creator` launches with `salt`.
    function tokenSalt(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    /// @notice The address `launch` gives the token when `creator` launches with `p`: it depends only on the
    ///         creator and the launch parameters (never on the block), so the token's side in the pool is known
    ///         before the launch.
    function tokenAddress(address creator, LaunchParams calldata p) external view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(OstraToken).creationCode, abi.encode(_settings(p))));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), tokenSalt(creator, p.salt), initCodeHash))))
        );
    }

    function _settings(LaunchParams calldata p) private view returns (OstraToken.Settings memory) {
        return OstraToken.Settings({
            name: p.name,
            symbol: p.symbol,
            supply: SUPPLY,
            poolManager: address(POOL_MANAGER),
            hook: address(HOOK),
            locker: address(locker),
            launchpad: address(this),
            maxWallet: p.maxWallet,
            limitsDuration: p.limitsDuration,
            antiFarmerDuration: p.antiFarmerDuration,
            dividendToken: p.dividendToken,
            minDividendBalance: p.minDividendBalance
        });
    }

    function launch(LaunchParams calldata p) external payable nonReentrant returns (address token, PoolId id) {
        if (msg.value != LAUNCH_FEE) revert WrongFee();
        launchFeesOwed += msg.value;
        _check(p);
        uint40 now_ = uint40(block.timestamp);
        token = address(new OstraToken{salt: tokenSalt(msg.sender, p.salt)}(_settings(p)));
        bool tokenIs0 = uint160(token) < uint160(Currency.unwrap(p.quote));
        PoolKey memory key = PoolKey({
            currency0: tokenIs0 ? Currency.wrap(token) : p.quote,
            currency1: tokenIs0 ? p.quote : Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: HOOK.TICK_SPACING(),
            hooks: IHooks(address(HOOK))
        });
        id = key.toId();
        HOOK.registerPool(key, _config(p, token, tokenIs0, now_), SUPPLY, p.dividendKey);
        // tokenIs0: the token's price in quote rises with the tick; otherwise it rises as the tick falls, so the
        // pool starts at -startTick in the pool's own tick terms and the tiers go down from there.
        int24 start = tokenIs0 ? p.startTick : -p.startTick;
        POOL_MANAGER.initialize(key, TickMath.getSqrtPriceAtTick(start));
        (int24[] memory lowers, int24[] memory uppers, uint128[] memory liq) = _positions(p, start, tokenIs0);
        locker.lockLaunch(key, token, lowers, uppers, liq);
        emit Launched(id, token, p.creatorVault, p.quote);
    }

    /// @notice Pays the launch fees to `to` as WETH (the operator's WETH vault).
    function claimLaunchFees(address to) external onlyOwner nonReentrant {
        uint256 amount = launchFeesOwed;
        launchFeesOwed = 0;
        IWETH9Deposit(WETH).deposit{value: amount}();
        IERC20(WETH).safeTransfer(to, amount);
        emit LaunchFeesClaimed(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Checks and the pool config
    // ---------------------------------------------------------------------------------------------

    function _check(LaunchParams calldata p) private view {
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert BadParams("name");
        address quote = Currency.unwrap(p.quote);
        address vaultToken = quote == address(0) ? WETH : quote;
        if (p.creatorVault.code.length == 0 || IOstraVaultToken(p.creatorVault).token() != vaultToken) {
            revert BadParams("creatorVault");
        }
        if (p.buyTaxBps > MAX_TAX_BPS || p.sellTaxBps > MAX_TAX_BPS) revert BadParams("tax");
        if (p.postBuyTaxBps > p.buyTaxBps || p.postSellTaxBps > p.sellTaxBps) revert BadParams("postTax");
        bool taxed = p.buyTaxBps != 0 || p.sellTaxBps != 0 || p.antiSnipeBps != 0;
        uint256 buckets = uint256(p.creatorBucketBps) + p.dividendBucketBps + p.burnBucketBps + p.lpBucketBps;
        if (taxed ? buckets != 10_000 : buckets != 0) revert BadParams("buckets");
        if ((p.dividendBucketBps != 0) != (p.dividendToken != address(0))) revert BadParams("dividendToken");
        if (p.dividendToken != address(0)) _checkDividendToken(p, vaultToken);
        if (p.antiSnipeBps > MAX_ANTI_SNIPE_BPS || p.antiSnipeDuration > MAX_ANTI_SNIPE_DURATION) {
            revert BadParams("antiSnipe");
        }
        if ((p.antiSnipeBps == 0) != (p.antiSnipeDuration == 0)) revert BadParams("antiSnipe");
        if (p.maxBuy > SUPPLY || p.maxWallet > SUPPLY) revert BadParams("limits");
        if (p.antiFarmerDuration > MAX_ANTI_FARMER_DURATION) revert BadParams("antiFarmer");
        if (p.graduationKind == HOOK.GRADUATION_TOKENS_SOLD()) {
            if (p.graduationThreshold == 0 || p.graduationThreshold > 10_000) revert BadParams("graduation");
        } else if (p.graduationKind == HOOK.GRADUATION_QUOTE_RAISED()) {
            if (p.graduationThreshold == 0) revert BadParams("graduation");
        } else {
            revert BadParams("graduation");
        }
        _checkTiers(p);
    }

    function _checkDividendToken(LaunchParams calldata p, address vaultToken) private view {
        // The token itself is decided only once it exists (dividendToken == the token's address is impossible to
        // pass in advance), so "dividends in the token" is passed as the launchpad's own address.
        if (p.dividendToken == address(this) || p.dividendToken == vaultToken) return;
        // Another ERC-20: bought with the quote in dividendKey, a pool of the quote and that token.
        address a = Currency.unwrap(p.dividendKey.currency0);
        address b = Currency.unwrap(p.dividendKey.currency1);
        address quote = Currency.unwrap(p.quote);
        if (!((a == quote && b == p.dividendToken) || (b == quote && a == p.dividendToken))) {
            revert BadParams("dividendKey");
        }
    }

    function _checkTiers(LaunchParams calldata p) private view {
        uint256 n = p.tiers.length;
        if (n == 0 || n > MAX_TIERS) revert BadParams("tiers");
        int24 spacing = HOOK.TICK_SPACING();
        if (p.startTick % spacing != 0) revert BadParams("startTick");
        uint256 bps;
        int256 span;
        for (uint256 i = 0; i < n; ++i) {
            Tier calldata t = p.tiers[i];
            bool last = i == n - 1;
            if (t.supplyBps == 0) revert BadParams("tierSupply");
            if (last ? t.width != 0 : (t.width == 0 || int256(uint256(t.width)) % spacing != 0)) {
                revert BadParams("tierWidth");
            }
            bps += t.supplyBps;
            span += int256(uint256(t.width));
        }
        if (bps != 10_000) revert BadParams("tierSupply");
        // Every tier but the last must end below the highest usable tick, in the token's price direction.
        int256 top = int256(p.startTick) + span;
        if (int256(p.startTick) < TickMath.minUsableTick(spacing) || top >= TickMath.maxUsableTick(spacing)) {
            revert BadParams("startTick");
        }
    }

    function _config(LaunchParams calldata p, address token, bool tokenIs0, uint40 now_)
        private
        view
        returns (OstraHook.PoolConfig memory c)
    {
        c.token = token;
        c.tokenIs0 = tokenIs0;
        c.creatorVault = p.creatorVault;
        c.buyTaxBps = p.buyTaxBps;
        c.sellTaxBps = p.sellTaxBps;
        c.postBuyTaxBps = p.postBuyTaxBps;
        c.postSellTaxBps = p.postSellTaxBps;
        c.taxEndAt = now_ + p.taxDuration;
        c.creatorBucketBps = p.creatorBucketBps;
        c.dividendBucketBps = p.dividendBucketBps;
        c.burnBucketBps = p.burnBucketBps;
        c.lpBucketBps = p.lpBucketBps;
        c.antiSnipeBps = p.antiSnipeBps;
        c.antiSnipeDuration = p.antiSnipeDuration;
        c.maxBuy = p.maxBuy;
        c.limitsEndAt = now_ + p.limitsDuration;
        c.antiFarmerEndAt = now_ + p.antiFarmerDuration;
        c.graduationKind = p.graduationKind;
        c.graduationThreshold = p.graduationThreshold;
        c.launchedAt = now_;
        c.dividendToken = p.dividendToken == address(this) ? token : p.dividendToken;
        c.stockQuote = isStockToken(Currency.unwrap(p.quote));
        c.volatilityFee = p.volatilityFee;
    }

    /// @notice True when `token` is a Robinhood stock token: its ACCESS_CONTROLLED_REGISTRY() is
    ///         ROBINHOOD_STOCK_REGISTRY (a static call with bounded gas; ETH and other tokens are not).
    function isStockToken(address token) public view returns (bool isStock) {
        if (token.code.length == 0) return false;
        address registry = ROBINHOOD_STOCK_REGISTRY;
        assembly ("memory-safe") {
            mstore(0x00, 0x50c09be300000000000000000000000000000000000000000000000000000000) // ACCESS_CONTROLLED_REGISTRY()
            let ok := staticcall(STOCK_PROBE_GAS, token, 0x00, 0x04, 0x00, 0x20)
            isStock := and(ok, and(gt(returndatasize(), 0x1f), eq(mload(0x00), registry)))
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Tier positions
    // ---------------------------------------------------------------------------------------------

    function _positions(LaunchParams calldata p, int24 start, bool tokenIs0)
        private
        pure
        returns (int24[] memory lowers, int24[] memory uppers, uint128[] memory liq)
    {
        uint256 n = p.tiers.length;
        lowers = new int24[](n);
        uppers = new int24[](n);
        liq = new uint128[](n);
        int24 spacing = 200;
        int24 offset;
        uint256 left = SUPPLY;
        for (uint256 i = 0; i < n; ++i) {
            Tier calldata t = p.tiers[i];
            bool last = i == n - 1;
            uint256 amount = last ? left : (SUPPLY * t.supplyBps) / 10_000;
            left -= amount;
            int24 width = last ? int24(0) : int24(t.width);
            if (tokenIs0) {
                lowers[i] = start + offset;
                uppers[i] = last ? TickMath.maxUsableTick(spacing) : start + offset + width;
                uint160 a = TickMath.getSqrtPriceAtTick(lowers[i]);
                uint160 b = TickMath.getSqrtPriceAtTick(uppers[i]);
                // Token0 only, the range at or above the price: L = amount0 * sqrtA * sqrtB / Q96 / (sqrtB - sqrtA).
                liq[i] = _u128(FullMath.mulDiv(amount, FullMath.mulDiv(a, b, 1 << 96), b - a));
            } else {
                uppers[i] = start - offset;
                lowers[i] = last ? TickMath.minUsableTick(spacing) : start - offset - width;
                uint160 a = TickMath.getSqrtPriceAtTick(lowers[i]);
                uint160 b = TickMath.getSqrtPriceAtTick(uppers[i]);
                // Token1 only, the range at or below the price: L = amount1 * Q96 / (sqrtB - sqrtA).
                liq[i] = _u128(FullMath.mulDiv(amount, 1 << 96, b - a));
            }
            offset += width;
        }
    }

    function _u128(uint256 x) private pure returns (uint128) {
        if (x > type(uint128).max) revert BadParams("liquidity");
        return uint128(x);
    }
}
