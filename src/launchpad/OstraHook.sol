// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {OstraLocker} from "./OstraLocker.sol";
import {OstraToken} from "./OstraToken.sol";

interface IWETH9 {
    function deposit() external payable;
}

/// @title OstraHook
/// @notice The one Uniswap v4 hook of every pool OstraLaunchpad creates (design v0.4, "Hook Ostra di Robinhood
///         Chain", approved 18 Oct 2026). Per swap, in the pool's quote currency, buys and sells, exact input and
///         exact output alike:
/// * the hook fee, HOOK_FEE_BPS (1%), shared 70% to the creator and 30% to the protocol, half of which is kept
///   for the OSTRA buyback-and-burn;
/// * the pool's buy or sell tax (at most 10% each; the post-graduation rate after graduation, nothing after the
///   tax end), shared among the pool's buckets: creator, holder dividends, burn, added liquidity;
/// * on buys, the anti-snipe tax, falling linearly to zero over its duration, shared like the tax.
/// The quote side that is the swap's specified currency is charged in beforeSwap, the unspecified side in
/// afterSwap. What is charged is held as PoolManager claims (ERC-6909) and paid out by dispatch, which anyone may
/// call: it collects the locked positions' LP fees (shared 70/30 like the hook fee), turns token-side fees into
/// quote, buys and burns for the burn bucket, adds full-range liquidity for the LP bucket, pays dividends, and pays
/// the creator's vault. Every amount charged is in the Charged event, and every rate is readable (rates).
/// Before graduation only the locker adds liquidity, buys are capped at the pool's max buy, and the token's
/// max wallet applies; graduation happens once, when the pool's threshold is reached, and lifts all three.
contract OstraHook is IHooks, IUnlockCallback, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @notice Hook fee on every swap (Pons V2's hookFeeBps, read on chain 18 Oct 2026).
    uint256 public constant HOOK_FEE_BPS = 100;
    /// @notice Creator's share of the hook fee and of the locked positions' LP fees.
    uint256 public constant CREATOR_FEE_SHARE_BPS = 7_000;
    /// @notice Part of the protocol's share kept for the OSTRA buyback-and-burn.
    uint256 public constant BUYBACK_SHARE_BPS = 5_000;
    /// @notice LP fee of every Ostra pool (dynamic-fee pools; set on every swap).
    uint24 public constant LP_FEE = 2_500;
    int24 public constant TICK_SPACING = 200;
    /// @notice A dispatch conversion moves the pool's sqrt price by at most this (about 1% of the price).
    uint256 public constant MAX_DISPATCH_SQRT_MOVE_BPS = 50;

    uint8 public constant GRADUATION_TOKENS_SOLD = 1;
    uint8 public constant GRADUATION_QUOTE_RAISED = 2;

    struct PoolConfig {
        address token;
        bool tokenIs0;
        /// @notice The creator's OstraVault for the quote currency (for WETH when the quote is ETH).
        address creatorVault;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 postBuyTaxBps;
        uint16 postSellTaxBps;
        uint40 taxEndAt;
        uint16 creatorBucketBps;
        uint16 dividendBucketBps;
        uint16 burnBucketBps;
        uint16 lpBucketBps;
        uint16 antiSnipeBps;
        uint32 antiSnipeDuration;
        uint128 maxBuy;
        uint40 limitsEndAt;
        uint40 antiFarmerEndAt;
        uint8 graduationKind;
        uint128 graduationThreshold;
        uint40 launchedAt;
        /// @notice address(0) none; the token; the quote (WETH for ETH); or another ERC-20 bought via dividendKey.
        address dividendToken;
    }

    struct PoolState {
        bool registered;
        bool graduated;
        uint256 supply;
        int256 tokensSold;
        int256 quoteRaised;
    }

    /// @notice What the hook holds for a pool, as PoolManager claims, until dispatch pays it out.
    struct Pending {
        uint256 creator;
        uint256 dividend;
        uint256 burn;
        uint256 lp;
        /// @notice LP fees the locked positions earned in the token, turned into quote by dispatch.
        uint256 tokenFees;
    }

    IPoolManager public immutable POOL_MANAGER;
    address public immutable WETH;

    address public launchpad;
    OstraLocker public locker;

    mapping(PoolId => PoolKey) private _keys;
    mapping(PoolId => PoolConfig) private _configs;
    mapping(PoolId => PoolState) private _states;
    mapping(PoolId => Pending) private _pending;
    mapping(PoolId => PoolKey) private _dividendKeys;
    /// @notice Protocol share owed per currency (claims), and the part kept for the OSTRA buyback.
    mapping(Currency => uint256) public protocolOwed;
    mapping(Currency => uint256) public buybackOwed;

    uint8 private constant OP_DISPATCH = 1;
    uint8 private constant OP_CLAIM_PROTOCOL = 2;

    event Initialized(address launchpad, address locker);
    event PoolRegistered(PoolId indexed poolId, address indexed token, address creatorVault);
    event Charged(
        PoolId indexed poolId, bool buy, uint256 fee, uint256 hookFee, uint256 tax, uint256 antiSnipe
    );
    event Graduated(PoolId indexed poolId, int256 tokensSold, int256 quoteRaised);
    event Dispatched(
        PoolId indexed poolId, uint256 creatorPaid, uint256 dividends, uint256 burned, uint256 liquidity
    );
    event ProtocolClaimed(Currency indexed currency, address to, uint256 amount);

    error AlreadyInitialized();
    error OnlyPoolManager();
    error OnlyLaunchpad();
    error NotRegistered();
    error AlreadyRegistered();
    error BadPool();
    error LiquidityClosed();
    error MaxBuyExceeded();
    error HookNotImplemented();
    error NothingToClaim();

    constructor(address poolManager, address weth, address admin) Ownable(admin) {
        POOL_MANAGER = IPoolManager(poolManager);
        WETH = weth;
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    /// @notice Binds the hook to its launchpad and locker, once.
    function initialize(address launchpad_, address locker_) external onlyOwner {
        if (launchpad != address(0)) revert AlreadyInitialized();
        launchpad = launchpad_;
        locker = OstraLocker(locker_);
        emit Initialized(launchpad_, locker_);
    }

    receive() external payable {}

    // ---------------------------------------------------------------------------------------------
    // Registration and views
    // ---------------------------------------------------------------------------------------------

    function registerPool(PoolKey calldata key, PoolConfig calldata config, uint256 supply, PoolKey calldata dividendPool)
        external
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        PoolId id = key.toId();
        if (_states[id].registered) revert AlreadyRegistered();
        _keys[id] = key;
        _configs[id] = config;
        _states[id] = PoolState({registered: true, graduated: false, supply: supply, tokensSold: 0, quoteRaised: 0});
        _dividendKeys[id] = dividendPool;
        emit PoolRegistered(id, config.token, config.creatorVault);
    }

    function poolKey(PoolId id) external view returns (PoolKey memory) {
        return _keys[id];
    }

    function poolConfig(PoolId id) external view returns (PoolConfig memory) {
        return _configs[id];
    }

    function poolState(PoolId id) external view returns (PoolState memory) {
        return _states[id];
    }

    function pending(PoolId id) external view returns (Pending memory) {
        return _pending[id];
    }

    function dividendKey(PoolId id) external view returns (PoolKey memory) {
        return _dividendKeys[id];
    }

    /// @notice The rates a buy and a sell pay right now: hook fee, tax and anti-snipe, in bps of the quote leg.
    function rates(PoolId id) external view returns (uint256 buyTax, uint256 sellTax, uint256 antiSnipe) {
        PoolConfig memory c = _configs[id];
        bool graduated = _states[id].graduated;
        buyTax = _tax(c, graduated, true);
        sellTax = _tax(c, graduated, false);
        antiSnipe = _antiSnipe(c, graduated);
    }

    function _tax(PoolConfig memory c, bool graduated, bool buy) private view returns (uint256) {
        if (block.timestamp >= c.taxEndAt) return 0;
        if (graduated) return buy ? c.postBuyTaxBps : c.postSellTaxBps;
        return buy ? c.buyTaxBps : c.sellTaxBps;
    }

    function _antiSnipe(PoolConfig memory c, bool graduated) private view returns (uint256) {
        if (graduated || c.antiSnipeDuration == 0) return 0;
        uint256 end = uint256(c.launchedAt) + c.antiSnipeDuration;
        if (block.timestamp >= end) return 0;
        return (uint256(c.antiSnipeBps) * (end - block.timestamp)) / c.antiSnipeDuration;
    }

    // ---------------------------------------------------------------------------------------------
    // Hook callbacks
    // ---------------------------------------------------------------------------------------------

    modifier onlyPoolManager() {
        if (msg.sender != address(POOL_MANAGER)) revert OnlyPoolManager();
        _;
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != launchpad) revert OnlyLaunchpad();
        if (!_states[key.toId()].registered) revert NotRegistered();
        if (key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG || key.tickSpacing != TICK_SPACING) revert BadPool();
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != address(locker)) {
            PoolId id = key.toId();
            if (!_states[id].graduated || block.timestamp < _configs[id].antiFarmerEndAt) revert LiquidityClosed();
        }
        return IHooks.beforeAddLiquidity.selector;
    }

    /// @dev Whether the swap buys the token (pays quote) and whether the quote is the swap's specified currency.
    function _sides(PoolConfig memory c, IPoolManager.SwapParams calldata params)
        private
        pure
        returns (bool buy, bool quoteSpecified)
    {
        // The input is currency0 when zeroForOne; a buy's input is the quote.
        buy = c.tokenIs0 ? !params.zeroForOne : params.zeroForOne;
        bool exactInput = params.amountSpecified < 0;
        quoteSpecified = exactInput ? buy : !buy;
    }

    function _quote(PoolKey calldata key, PoolConfig memory c) private pure returns (Currency) {
        return c.tokenIs0 ? key.currency1 : key.currency0;
    }

    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        int128 fee = _beforeSwapFee(key, params);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(fee, 0), LP_FEE | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function afterSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        return (IHooks.afterSwap.selector, _afterSwapFee(key, params, delta));
    }

    /// @dev Exact input buy: the fee is part of what the buyer pays. Exact output sell: the fee comes on top of
    ///      what the seller receives, so the pool pays out net + fee.
    function _beforeSwapFee(PoolKey calldata key, IPoolManager.SwapParams calldata params) private returns (int128) {
        PoolId id = key.toId();
        PoolConfig memory c = _configs[id];
        (bool buy, bool quoteSpecified) = _sides(c, params);
        if (!quoteSpecified) return 0;
        int256 specified = params.amountSpecified;
        uint256 amount = specified < 0 ? uint256(-specified) : uint256(specified);
        return int128(int256(_charge(id, _quote(key, c), c, buy, amount, specified > 0)));
    }

    /// @dev Exact input sell: the fee comes out of the quote the pool pays. Exact output buy: the fee comes on top
    ///      of the quote the pool takes in.
    function _afterSwapFee(PoolKey calldata key, IPoolManager.SwapParams calldata params, BalanceDelta delta)
        private
        returns (int128 fee)
    {
        PoolId id = key.toId();
        PoolConfig memory c = _configs[id];
        (bool buy, bool quoteSpecified) = _sides(c, params);
        if (!quoteSpecified) fee = _afterCharge(id, key, c, buy, delta, params.amountSpecified > 0);
        _afterTrade(id, c, buy, delta);
    }

    function _afterCharge(PoolId id, PoolKey calldata key, PoolConfig memory c, bool buy, BalanceDelta delta, bool onTop)
        private
        returns (int128)
    {
        int128 quoteDelta = c.tokenIs0 ? delta.amount1() : delta.amount0();
        uint256 amount = quoteDelta < 0 ? uint256(-int256(quoteDelta)) : uint256(int256(quoteDelta));
        return int128(int256(_charge(id, _quote(key, c), c, buy, amount, onTop)));
    }

    /// @dev Charges a swap whose quote leg is `amount`: the fee is minted to this hook as PoolManager claims and
    ///      shared among the pending balances. `onTop`: the amount is net of the fee (exact output sell, exact
    ///      output buy), so fee = amount * rate / (BPS - rate); otherwise fee = amount * rate / BPS.
    function _charge(PoolId id, Currency quote, PoolConfig memory c, bool buy, uint256 amount, bool onTop)
        private
        returns (uint256 fee)
    {
        bool graduated = _states[id].graduated;
        uint256 tax = _tax(c, graduated, buy);
        uint256 snipe = buy ? _antiSnipe(c, graduated) : 0;
        uint256 rate = HOOK_FEE_BPS + tax + snipe;
        fee = onTop ? (amount * rate) / (BPS - rate) : (amount * rate) / BPS;
        if (fee == 0) return 0;
        POOL_MANAGER.mint(address(this), quote.toId(), fee);
        _book(id, quote, c, buy, fee, rate, snipe);
    }

    function _book(PoolId id, Currency quote, PoolConfig memory c, bool buy, uint256 fee, uint256 rate, uint256 snipe)
        private
    {
        uint256 hookFee = (fee * HOOK_FEE_BPS) / rate;
        uint256 taxed = fee - hookFee;
        _shareFee(id, quote, hookFee);
        if (taxed != 0) _shareTax(id, c, taxed);
        uint256 taxAndSnipe = rate - HOOK_FEE_BPS;
        uint256 snipePart = taxAndSnipe == 0 ? 0 : (taxed * snipe) / taxAndSnipe;
        emit Charged(id, buy, fee, hookFee, taxed - snipePart, snipePart);
    }

    /// @dev The hook fee (and the locked positions' LP fees): 70% creator, 30% protocol, half of it for buyback.
    function _shareFee(PoolId id, Currency quote, uint256 amount) private {
        uint256 creator = (amount * CREATOR_FEE_SHARE_BPS) / BPS;
        uint256 protocol = amount - creator;
        uint256 buyback = (protocol * BUYBACK_SHARE_BPS) / BPS;
        _pending[id].creator += creator;
        buybackOwed[quote] += buyback;
        protocolOwed[quote] += protocol - buyback;
    }

    function _shareTax(PoolId id, PoolConfig memory c, uint256 amount) private {
        Pending storage p = _pending[id];
        uint256 dividend = (amount * c.dividendBucketBps) / BPS;
        uint256 burn = (amount * c.burnBucketBps) / BPS;
        uint256 lp = (amount * c.lpBucketBps) / BPS;
        p.dividend += dividend;
        p.burn += burn;
        p.lp += lp;
        // The creator bucket also takes what rounding leaves.
        p.creator += amount - dividend - burn - lp;
    }

    function _afterTrade(PoolId id, PoolConfig memory c, bool buy, BalanceDelta delta) private {
        int128 tokenDelta = c.tokenIs0 ? delta.amount0() : delta.amount1();
        int128 quoteDelta = c.tokenIs0 ? delta.amount1() : delta.amount0();
        PoolState storage s = _states[id];
        // Caller-side deltas: a buy receives the token (positive) and pays the quote (negative).
        s.tokensSold += int256(tokenDelta);
        s.quoteRaised -= int256(quoteDelta);
        if (!s.graduated) {
            if (buy && c.maxBuy != 0 && block.timestamp < c.limitsEndAt && uint256(int256(tokenDelta)) > c.maxBuy) {
                revert MaxBuyExceeded();
            }
            bool reached = c.graduationKind == GRADUATION_TOKENS_SOLD
                ? s.tokensSold > 0 && uint256(s.tokensSold) * BPS >= s.supply * c.graduationThreshold
                : s.quoteRaised > 0 && uint256(s.quoteRaised) >= c.graduationThreshold;
            if (reached) {
                s.graduated = true;
                OstraToken(c.token).releaseLimits();
                emit Graduated(id, s.tokensSold, s.quoteRaised);
            }
        }
        if (!buy && block.timestamp < c.antiFarmerEndAt) {
            // The seller owes the PoolManager this much token; the token lets exactly that in.
            OstraToken(c.token).creditPoolManager(uint256(-int256(tokenDelta)));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Dispatch
    // ---------------------------------------------------------------------------------------------

    /// @notice Pays out what a pool has accrued (see the contract notice). Anyone may call it.
    function dispatch(PoolId id) external nonReentrant {
        if (!_states[id].registered) revert NotRegistered();
        POOL_MANAGER.unlock(abi.encode(OP_DISPATCH, abi.encode(id)));
    }

    /// @notice Pays the protocol's share in `currency` to `to` (the operator's vault; WETH for ETH).
    function claimProtocol(Currency currency, address to) external onlyOwner nonReentrant {
        if (protocolOwed[currency] == 0) revert NothingToClaim();
        POOL_MANAGER.unlock(abi.encode(OP_CLAIM_PROTOCOL, abi.encode(currency, to)));
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 op, bytes memory args) = abi.decode(data, (uint8, bytes));
        if (op == OP_DISPATCH) {
            _dispatch(abi.decode(args, (PoolId)));
        } else {
            (Currency currency, address to) = abi.decode(args, (Currency, address));
            uint256 amount = protocolOwed[currency];
            protocolOwed[currency] = 0;
            _payOut(currency, amount, to);
            emit ProtocolClaimed(currency, to, amount);
        }
        return "";
    }

    function _dispatch(PoolId id) private {
        PoolKey memory key = _keys[id];
        PoolConfig memory c = _configs[id];
        Pending storage p = _pending[id];
        Currency quote = c.tokenIs0 ? key.currency1 : key.currency0;
        Currency token = c.tokenIs0 ? key.currency0 : key.currency1;

        // 1. The locked positions' LP fees, as claims of this hook.
        (uint256 fees0, uint256 fees1) = locker.collectToHook(key);
        uint256 quoteFees = c.tokenIs0 ? fees1 : fees0;
        p.tokenFees += c.tokenIs0 ? fees0 : fees1;
        if (quoteFees != 0) _shareFee(id, quote, quoteFees);

        // 2. Token-side LP fees become quote, within the price-move bound.
        if (p.tokenFees != 0) {
            (uint256 spent, uint256 got) = _swapClaims(key, c, false, p.tokenFees);
            p.tokenFees -= spent;
            if (got != 0) _shareFee(id, quote, got);
        }

        // 3. Burn bucket: buy the token and burn it.
        uint256 burned;
        if (p.burn != 0) {
            (uint256 spent, uint256 got) = _swapClaims(key, c, true, p.burn);
            p.burn -= spent;
            if (got != 0) {
                POOL_MANAGER.burn(address(this), token.toId(), got);
                POOL_MANAGER.take(token, address(this), got);
                OstraToken(c.token).burn(got);
                burned = got;
            }
        }

        // 4. LP bucket: buy half, add both to the locker's full-range position.
        uint256 liquidity;
        if (p.lp != 0) liquidity = _addLiquidity(key, c, p);

        // 5. Dividends.
        uint256 dividends;
        if (p.dividend != 0 && OstraToken(c.token).totalDividendShares() != 0) dividends = _payDividends(id, key, c, p);

        // 6. The creator's share, to the creator's vault.
        uint256 creatorPaid = p.creator;
        if (creatorPaid != 0) {
            p.creator = 0;
            _payOut(quote, creatorPaid, c.creatorVault);
        }
        emit Dispatched(id, creatorPaid, dividends, burned, liquidity);
    }

    /// @dev Swaps `amount` of this hook's claims on the pool (buy: quote for token; else token for quote), paid by
    ///      burning claims, the output minted back as claims. The price may move by at most
    ///      MAX_DISPATCH_SQRT_MOVE_BPS; what does not fit stays for the next dispatch. The hook's own swaps skip
    ///      its hooks, so they pay no hook fee, tax or LP fee override.
    function _swapClaims(PoolKey memory key, PoolConfig memory c, bool buy, uint256 amount)
        private
        returns (uint256 spent, uint256 got)
    {
        bool zeroForOne = c.tokenIs0 ? !buy : buy;
        BalanceDelta d = POOL_MANAGER.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: _limit(key, zeroForOne)
            }),
            ""
        );
        int128 in_ = zeroForOne ? d.amount0() : d.amount1();
        int128 out = zeroForOne ? d.amount1() : d.amount0();
        spent = uint256(-int256(in_));
        got = uint256(int256(out));
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        if (spent != 0) POOL_MANAGER.burn(address(this), input.toId(), spent);
        if (got != 0) POOL_MANAGER.mint(address(this), output.toId(), got);
    }

    function _addLiquidity(PoolKey memory key, PoolConfig memory c, Pending storage p) private returns (uint256) {
        (uint256 spent, uint256 tokens) = _swapClaims(key, c, true, p.lp / 2);
        uint256 quoteLeft = p.lp - spent;
        uint128 liquidity = _fullRangeLiquidity(key, c.tokenIs0 ? tokens : quoteLeft, c.tokenIs0 ? quoteLeft : tokens);
        if (liquidity == 0) {
            // Too little to add: the bought tokens wait as claims with the token fees, the quote stays in the bucket.
            p.lp = quoteLeft;
            p.tokenFees += tokens;
            return 0;
        }
        (uint256 tokenCost, uint256 quoteCost) = _addFullRange(key, c.tokenIs0, liquidity);
        p.lp = quoteLeft - quoteCost;
        // Bought tokens the position did not take wait with the token fees (they turn back into quote).
        if (tokens > tokenCost) p.tokenFees += tokens - tokenCost;
        return liquidity;
    }

    function _fullRangeLiquidity(PoolKey memory key, uint256 amount0, uint256 amount1) private view returns (uint128) {
        return _liquidityFor(
            _sqrtPrice(key.toId()),
            TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(TICK_SPACING)),
            TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(TICK_SPACING)),
            amount0,
            amount1
        );
    }

    /// @dev Adds `liquidity` to the locker's full-range position and pays for it; returns the token and quote cost.
    function _addFullRange(PoolKey memory key, bool tokenIs0, uint128 liquidity)
        private
        returns (uint256 tokenCost, uint256 quoteCost)
    {
        BalanceDelta d = locker.addFullRange(
            key, TickMath.minUsableTick(TICK_SPACING), TickMath.maxUsableTick(TICK_SPACING), liquidity
        );
        uint256 cost0 = uint256(-int256(d.amount0()));
        uint256 cost1 = uint256(-int256(d.amount1()));
        _payFor(key.currency0, cost0);
        _payFor(key.currency1, cost1);
        (tokenCost, quoteCost) = tokenIs0 ? (cost0, cost1) : (cost1, cost0);
    }

    /// @dev Settles `amount` of `currency` the locker owes for an added position, out of this hook's claims.
    function _payFor(Currency currency, uint256 amount) private {
        if (amount == 0) return;
        POOL_MANAGER.burn(address(this), currency.toId(), amount);
        POOL_MANAGER.take(currency, address(this), amount);
        if (currency.isAddressZero()) {
            POOL_MANAGER.settleFor{value: amount}(address(locker));
        } else {
            POOL_MANAGER.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(POOL_MANAGER), amount);
            POOL_MANAGER.settleFor(address(locker));
        }
    }

    function _payDividends(PoolId id, PoolKey memory key, PoolConfig memory c, Pending storage p)
        private
        returns (uint256 paid)
    {
        Currency quote = c.tokenIs0 ? key.currency1 : key.currency0;
        address dividendToken = c.dividendToken;
        if (dividendToken == c.token) {
            (uint256 spent, uint256 got) = _swapClaims(key, c, true, p.dividend);
            p.dividend -= spent;
            if (got == 0) return 0;
            Currency token = c.tokenIs0 ? key.currency0 : key.currency1;
            POOL_MANAGER.burn(address(this), token.toId(), got);
            POOL_MANAGER.take(token, c.token, got);
            paid = got;
        } else if (dividendToken == Currency.unwrap(quote) || (quote.isAddressZero() && dividendToken == WETH)) {
            paid = p.dividend;
            p.dividend = 0;
            _payOut(quote, paid, c.token);
        } else {
            paid = _swapDividendToken(_dividendKeys[id], quote, dividendToken, p, c.token);
            if (paid == 0) return 0;
        }
        OstraToken(c.token).distributeDividends(paid);
    }

    /// @dev Buys the dividend token with the bucket's quote in the pool `dk` (another pool, with its own rules),
    ///      within the same price-move bound as the hook's own conversions, and sends it to the token contract.
    function _swapDividendToken(PoolKey memory dk, Currency quote, address dividendToken, Pending storage p, address to)
        private
        returns (uint256 got)
    {
        bool zeroForOne = Currency.unwrap(dk.currency0) == Currency.unwrap(quote);
        BalanceDelta d = POOL_MANAGER.swap(
            dk,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(p.dividend),
                sqrtPriceLimitX96: _limit(dk, zeroForOne)
            }),
            ""
        );
        int128 in_ = zeroForOne ? d.amount0() : d.amount1();
        int128 out = zeroForOne ? d.amount1() : d.amount0();
        uint256 spent = uint256(-int256(in_));
        got = uint256(int256(out));
        p.dividend -= spent;
        POOL_MANAGER.burn(address(this), quote.toId(), spent);
        if (got != 0) POOL_MANAGER.take(Currency.wrap(dividendToken), to, got);
    }

    /// @dev Pays `amount` of this hook's claims in `currency` to `to`; native ETH is wrapped and paid as WETH.
    function _payOut(Currency currency, uint256 amount, address to) private {
        if (amount == 0) return;
        POOL_MANAGER.burn(address(this), currency.toId(), amount);
        if (currency.isAddressZero()) {
            POOL_MANAGER.take(currency, address(this), amount);
            IWETH9(WETH).deposit{value: amount}();
            IERC20(WETH).safeTransfer(to, amount);
        } else {
            POOL_MANAGER.take(currency, to, amount);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Pool math
    // ---------------------------------------------------------------------------------------------

    /// @dev The sqrt price a dispatch swap may move the pool to: MAX_DISPATCH_SQRT_MOVE_BPS from where it is.
    function _limit(PoolKey memory key, bool zeroForOne) private view returns (uint160 limit) {
        uint256 sqrtPrice = _sqrtPrice(key.toId());
        limit = zeroForOne
            ? uint160((sqrtPrice * (BPS - MAX_DISPATCH_SQRT_MOVE_BPS)) / BPS)
            : uint160((sqrtPrice * (BPS + MAX_DISPATCH_SQRT_MOVE_BPS)) / BPS);
        if (limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;
        if (limit >= TickMath.MAX_SQRT_PRICE) limit = TickMath.MAX_SQRT_PRICE - 1;
    }

    /// @dev slot0's sqrt price (v4-core StateLibrary.getSlot0, read the same way: pools mapping at slot 6).
    function _sqrtPrice(PoolId id) private view returns (uint160 sqrtPriceX96) {
        bytes32 slot = keccak256(abi.encodePacked(PoolId.unwrap(id), bytes32(uint256(6))));
        bytes32 data = POOL_MANAGER.extsload(slot);
        sqrtPriceX96 = uint160(uint256(data));
    }

    /// @dev The largest liquidity amount0 and amount1 can pay for in [sqrtA, sqrtB] at sqrtP.
    function _liquidityFor(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint256 amount0, uint256 amount1)
        private
        pure
        returns (uint128)
    {
        uint256 l0 = FullMath.mulDiv(amount0, FullMath.mulDiv(sqrtP, sqrtB, 1 << 96), sqrtB - sqrtP);
        uint256 l1 = FullMath.mulDiv(amount1, 1 << 96, sqrtP - sqrtA);
        uint256 l = l0 < l1 ? l0 : l1;
        return l > type(uint128).max ? type(uint128).max : uint128(l);
    }

    // ---------------------------------------------------------------------------------------------
    // Callbacks this hook does not use
    // ---------------------------------------------------------------------------------------------

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
