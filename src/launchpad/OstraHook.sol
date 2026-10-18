// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {OSTRA_BASE_LP_FEE, OstraFees} from "./OstraFees.sol";
import {OstraToken} from "./OstraToken.sol";

/// @dev The creator's share of the hook fee and of the locked positions' LP fees, and the part of the protocol's
///      share kept for the OSTRA buyback; file-level so that OstraDispatcher shares the locked positions' LP fees
///      the same way.
uint256 constant OSTRA_CREATOR_FEE_SHARE_BPS = 7_000;
uint256 constant OSTRA_BUYBACK_SHARE_BPS = 5_000;
/// @dev The circuit breaker's bounds for a pool's maxTxMoveTicks (0: off), file-level so that OstraLaunchpad checks
///      them at launch: 1,000 ticks is a move of about 10%, 6,932 a halving or a doubling of the price.
uint256 constant OSTRA_MIN_TX_MOVE_TICKS = 1_000;
uint256 constant OSTRA_MAX_TX_MOVE_TICKS = 6_932;

/// @title OstraHook
/// @notice The one Uniswap v4 hook of every pool OstraLaunchpad creates (design v0.4, "Hook Ostra di Robinhood
///         Chain", approved 18 Oct 2026). Per swap, in the pool's quote currency, buys and sells, exact input and
///         exact output alike:
/// * the hook fee, HOOK_FEE_BPS (1%), shared 70% to the creator and 30% to the protocol, half of which is kept
///   for the OSTRA buyback-and-burn;
/// * the pool's buy or sell tax (at most 10% each; the post-graduation rate after graduation, nothing after the
///   tax end), shared among the pool's buckets: creator, holder dividends, burn, added liquidity and the floor bid
///   (OstraDispatcher);
/// * on buys, the anti-snipe tax, falling linearly to zero over its duration, shared like the tax; the creator's
///   dev buy, made by OstraDevBuy in the launch transaction itself, pays the hook fee and the tax but no anti-snipe.
/// A swap whose hookData is exactly abi.encode(referrer) pays half of the protocol's share of the hook fee to that
/// referrer instead (referralOwed, claimed through OstraDispatcher.claimReferral); hookData of any other shape is
/// ignored.
/// The circuit breaker: a pool whose creator chose maxTxMoveTicks (at launch: 0, off, or MIN_TX_MOVE_TICKS to
/// MAX_TX_MOVE_TICKS; Ostra's launch default is 2,231 ticks, -20% / +25%) refuses a swap that leaves the price
/// further than that from where it was before the transaction's first swap on the pool, so one transaction cannot
/// crash or pump it however it splits its swaps; separate transactions are not limited (txMoveBand). It also refuses
/// a swap that leaves the price where the pool has no liquidity: a price moved through empty ticks costs nothing,
/// and could otherwise be walked away, one free transaction at a time, until every swap back is too large. The band
/// is the whole transaction's: swaps of several users in one transaction (a bundle) share it.
/// The LP fee, the pools' dynamic Uniswap v4 fee, is set on every swap from OstraFees: 0.25%; 0.50% for a pool
/// quoted in a stock token while its market is closed (weekends, NYSE holidays); with the volatility fee the
/// creator may choose at launch, up to 1% as the price moves away from its 60-second EMA; plus the MEV surcharge
/// for an actor reversing its own swap within the same second. Every LP fee above the base is in the LpFeeCharged
/// event and readable (OstraFees.lpFeeOf and mevSurchargeOf).
/// The quote side that is the swap's specified currency is charged in beforeSwap, the unspecified side in
/// afterSwap. What is charged is minted as PoolManager claims (ERC-6909) to OstraDispatcher and booked here, per
/// pool (pending), until OstraDispatcher.dispatch pays it out (takePending, restorePending). The dispatcher's own
/// swaps pay no hook fee, tax or LP fee, as the hook's own swaps did before the dispatcher existed. Every amount
/// charged is in the Charged event, and every rate is readable (rates).
/// Before graduation only the locker and the dispatcher (the floor bid) add liquidity, buys are capped at the pool's
/// max buy, and the token's max wallet applies; graduation happens once, when the pool's threshold is reached, and
/// lifts all three.
/// The creator's vault (an OstraVault, through its ConfigurePool spend) may change a pool's rules only in the
/// traders' favour: lower taxes or anti-snipe, an earlier tax end, a higher or no max buy, the launch limits
/// released now, or the volatility fee turned off (configure). Nothing can raise a rate or tighten a limit after
/// launch.
contract OstraHook is IHooks, Ownable2Step {
    uint256 public constant BPS = 10_000;
    /// @notice Hook fee on every swap (Pons V2's hookFeeBps, read on chain 18 Oct 2026).
    uint256 public constant HOOK_FEE_BPS = 100;
    /// @notice Creator's share of the hook fee and of the locked positions' LP fees.
    uint256 public constant CREATOR_FEE_SHARE_BPS = OSTRA_CREATOR_FEE_SHARE_BPS;
    /// @notice Part of the protocol's share kept for the OSTRA buyback-and-burn.
    uint256 public constant BUYBACK_SHARE_BPS = OSTRA_BUYBACK_SHARE_BPS;
    int24 public constant TICK_SPACING = 200;

    uint8 public constant GRADUATION_TOKENS_SOLD = 1;
    uint8 public constant GRADUATION_QUOTE_RAISED = 2;

    /// @notice configure fields. Taxes and anti-snipe (bps) only go down, the tax end only earlier, the max buy
    ///         only up or to 0 (no max buy); RELEASE_LIMITS (value 0) ends the max buy and the max wallet now;
    ///         VOLATILITY_FEE (value 0) turns the volatility fee off.
    uint8 public constant FIELD_BUY_TAX = 0;
    uint8 public constant FIELD_SELL_TAX = 1;
    uint8 public constant FIELD_POST_BUY_TAX = 2;
    uint8 public constant FIELD_POST_SELL_TAX = 3;
    uint8 public constant FIELD_TAX_END_AT = 4;
    uint8 public constant FIELD_ANTI_SNIPE = 5;
    uint8 public constant FIELD_MAX_BUY = 6;
    uint8 public constant FIELD_RELEASE_LIMITS = 7;
    /// @notice Value 0: turns the pool's volatility fee off (the LP fee is then OstraFees' session fee only).
    uint8 public constant FIELD_VOLATILITY_FEE = 8;
    /// @notice The circuit breaker only loosens: a higher maxTxMoveTicks (at most MAX_TX_MOVE_TICKS), or 0 (off).
    uint8 public constant FIELD_MAX_TX_MOVE = 9;

    uint256 public constant MIN_TX_MOVE_TICKS = OSTRA_MIN_TX_MOVE_TICKS;
    uint256 public constant MAX_TX_MOVE_TICKS = OSTRA_MAX_TX_MOVE_TICKS;
    /// @notice A swap's referrer receives this share of the protocol's part of its hook fee (half: 0.15% of the
    ///         quote leg); the protocol's remaining part is shared with the buyback as without a referrer.
    uint256 public constant REFERRAL_SHARE_BPS = 5_000;
    /// @dev Seed of the transient slot holding a pool's tick before the transaction's first swap on it.
    bytes32 private constant TX_START_TICK_SEED = keccak256("OSTRA/HOOK/TX_START_TICK");

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
        /// @notice Kept as a quote bid just below the price (OstraDispatcher's floor bid); what it buys is burned.
        uint16 floorBucketBps;
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
        /// @notice The quote is a Robinhood stock token (OstraLaunchpad checks it at launch): the session fee applies.
        bool stockQuote;
        /// @notice The creator chose the volatility fee (it can only be turned off).
        bool volatilityFee;
        /// @notice The circuit breaker: how far, in ticks, one transaction's swaps may move the price (0: off).
        uint16 maxTxMoveTicks;
    }

    struct PoolState {
        bool registered;
        bool graduated;
        uint256 supply;
        int256 tokensSold;
        int256 quoteRaised;
    }

    /// @notice What OstraDispatcher holds for a pool, as PoolManager claims, until it pays it out: the creator's
    ///         share and the tax buckets, and the locked positions' LP fees in the token (tokenFees, turned into quote
    ///         by dispatch). Two amounts per slot, so a swap writes fewer slots.
    struct Pending {
        uint128 creator;
        uint128 dividend;
        uint128 burn;
        uint128 lp;
        uint128 floor;
        uint128 tokenFees;
    }

    /// @notice The protocol's share of the hook fee in a currency, and the part kept for the OSTRA buyback, held as
    ///         the dispatcher's claims; booked at swap time, so no pool's dispatch can hold it up.
    struct ProtocolShare {
        uint128 protocol;
        uint128 buyback;
    }

    IPoolManager public immutable POOL_MANAGER;
    address public immutable WETH;
    OstraFees public immutable FEES;

    address public launchpad;
    /// @notice OstraLocker: the only account that adds liquidity before graduation, with the dispatcher.
    address public locker;
    /// @notice OstraDispatcher: holds the claims this hook charges and pays them out; its swaps are not charged.
    address public dispatcher;
    /// @notice OstraDevBuy: launches with the creator's dev buy, whose swap in the launch block pays no anti-snipe.
    address public devBuy;
    /// @notice OstraAirdrop: holds the tokens of the creators' airdrop rounds (a system account of every token).
    address public airdrop;

    mapping(PoolId => PoolKey) private _keys;
    mapping(PoolId => PoolConfig) private _configs;
    mapping(PoolId => PoolState) private _states;
    mapping(PoolId => Pending) private _pending;
    mapping(PoolId => PoolKey) private _dividendKeys;
    /// @notice Each pool's OstraFees.FeeState, packed (OstraFees.unpack).
    mapping(PoolId => uint256) public feeState;
    /// @notice The protocol's share per currency, until the dispatcher takes it (takeProtocolShare).
    mapping(Currency => ProtocolShare) public protocolShare;
    /// @notice What referrers are owed per currency, as the dispatcher's claims, until they claim it
    ///         (OstraDispatcher.claimReferral).
    mapping(address referrer => mapping(Currency => uint256)) public referralOwed;
    /// @dev The referrer of the swap being charged (address(0): none), set from its hookData in both callbacks.
    address private transient _referrer;
    /// @dev The swap being charged is OstraDevBuy's, set in both callbacks.
    bool private transient _devBuying;

    event Initialized(address launchpad, address locker, address dispatcher, address devBuy, address airdrop);
    event PoolRegistered(PoolId indexed poolId, address indexed token, address creatorVault);
    event Charged(
        PoolId indexed poolId, bool buy, uint256 fee, uint256 hookFee, uint256 tax, uint256 antiSnipe
    );
    event Graduated(PoolId indexed poolId, int256 tokensSold, int256 quoteRaised);
    event PoolConfigured(PoolId indexed poolId, uint8 field, uint256 value);
    /// @notice A swap's LP fee was above OstraFees.BASE_LP_FEE or carried an MEV surcharge (pips, 1e6 = 100%).
    event LpFeeCharged(PoolId indexed poolId, uint24 lpFee, uint24 mevSurcharge);
    /// @notice A swap's referrer was owed `amount` of the pool's quote.
    event Referred(PoolId indexed poolId, address indexed referrer, uint256 amount);

    error AlreadyInitialized();
    error OnlyPoolManager();
    error OnlyLaunchpad();
    error NotRegistered();
    error AlreadyRegistered();
    error BadPool();
    error LiquidityClosed();
    error MaxBuyExceeded();
    error HookNotImplemented();
    error OnlyDispatcher();
    error OnlyCreatorVault();
    error NotInTradersFavour();
    error BadField();
    error PriceMoveTooLarge();
    error NoLiquidityAtPrice();

    constructor(address poolManager, address weth, address fees, address admin) Ownable(admin) {
        POOL_MANAGER = IPoolManager(poolManager);
        WETH = weth;
        FEES = OstraFees(fees);
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

    /// @notice Binds the hook to its launchpad, locker, dispatcher, dev buy and airdrop contracts, once.
    function initialize(address launchpad_, address locker_, address dispatcher_, address devBuy_, address airdrop_)
        external
        onlyOwner
    {
        if (launchpad != address(0)) revert AlreadyInitialized();
        launchpad = launchpad_;
        locker = locker_;
        dispatcher = dispatcher_;
        devBuy = devBuy_;
        airdrop = airdrop_;
        emit Initialized(launchpad_, locker_, dispatcher_, devBuy_, airdrop_);
    }

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

    /// @notice Hands the dispatcher everything booked for a pool, and books it as paid; what the dispatcher cannot
    ///         pay out yet comes back through restorePending in the same transaction.
    function takePending(PoolId id) external returns (Pending memory p) {
        if (msg.sender != dispatcher) revert OnlyDispatcher();
        p = _pending[id];
        delete _pending[id];
    }

    /// @notice Books back what a dispatch left for later (bounded conversions, a floor bid the price is in).
    function restorePending(PoolId id, Pending calldata left) external {
        if (msg.sender != dispatcher) revert OnlyDispatcher();
        Pending storage p = _pending[id];
        p.creator += left.creator;
        p.dividend += left.dividend;
        p.burn += left.burn;
        p.lp += left.lp;
        p.floor += left.floor;
        p.tokenFees += left.tokenFees;
    }

    /// @notice Hands the dispatcher the protocol's share in `currency` booked so far, and books it as paid.
    function takeProtocolShare(Currency currency) external returns (uint256 protocol, uint256 buyback) {
        if (msg.sender != dispatcher) revert OnlyDispatcher();
        ProtocolShare memory s = protocolShare[currency];
        delete protocolShare[currency];
        return (s.protocol, s.buyback);
    }

    /// @notice Hands the dispatcher what `referrer` is owed in `currency`, and books it as paid.
    function takeReferral(address referrer, Currency currency) external returns (uint256 amount) {
        if (msg.sender != dispatcher) revert OnlyDispatcher();
        amount = referralOwed[referrer][currency];
        delete referralOwed[referrer][currency];
    }

    /// @notice The ticks the pool's price may end a swap between in this transaction: maxTxMoveTicks either side of
    ///         the tick before its first swap on the pool, or of the current tick before any (outside a transaction,
    ///         what the next transaction may do). The whole tick range when the circuit breaker is off. A swap down to
    ///         the price of `lower` may end one tick below it (v4 sets the tick below a crossed boundary): a price
    ///         limit for a swap down stops at lower + 1.
    function txMoveBand(PoolId id) external view returns (int24 lower, int24 upper) {
        int256 cap = int256(uint256(_configs[id].maxTxMoveTicks));
        if (cap == 0) return (TickMath.MIN_TICK, TickMath.MAX_TICK);
        (bool set, int24 start) = _txStartTick(id);
        if (!set) start = _tick(id);
        int256 lo = int256(start) - cap;
        int256 hi = int256(start) + cap;
        lower = lo < TickMath.MIN_TICK ? TickMath.MIN_TICK : int24(lo);
        upper = hi > TickMath.MAX_TICK ? TickMath.MAX_TICK : int24(hi);
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
    // Creator settings
    // ---------------------------------------------------------------------------------------------

    /// @notice Changes one of the pool's rules in the traders' favour (see the FIELD_ constants). Only the pool's
    ///         creator vault may call it; anything else, including a no-op, reverts, except RELEASE_LIMITS once the
    ///         limits are over (released, graduated or past their end), which lands changing nothing: whether they are
    ///         over can change between the creator vault's signature and its landing.
    function configure(PoolId id, uint8 field, uint256 value) external {
        PoolConfig storage c = _configs[id];
        if (!_states[id].registered) revert NotRegistered();
        if (msg.sender != c.creatorVault) revert OnlyCreatorVault();
        // A post-graduation tax is never above its pre-graduation tax (OstraLaunchpad checks it at launch), so that
        // graduating never raises a rate: lowering a tax lowers its post-graduation tax with it when needed.
        if (field == FIELD_BUY_TAX) {
            c.buyTaxBps = uint16(_lower(value, c.buyTaxBps));
            if (c.postBuyTaxBps > value) c.postBuyTaxBps = uint16(value);
        } else if (field == FIELD_SELL_TAX) {
            c.sellTaxBps = uint16(_lower(value, c.sellTaxBps));
            if (c.postSellTaxBps > value) c.postSellTaxBps = uint16(value);
        } else if (field == FIELD_POST_BUY_TAX) {
            c.postBuyTaxBps = uint16(_lower(value, c.postBuyTaxBps));
        } else if (field == FIELD_POST_SELL_TAX) {
            c.postSellTaxBps = uint16(_lower(value, c.postSellTaxBps));
        } else if (field == FIELD_TAX_END_AT) {
            c.taxEndAt = uint40(_lower(value, c.taxEndAt));
        } else if (field == FIELD_ANTI_SNIPE) {
            c.antiSnipeBps = uint16(_lower(value, c.antiSnipeBps));
        } else if (field == FIELD_MAX_BUY) {
            uint256 current = c.maxBuy;
            if (current == 0 || (value != 0 && value <= current) || value > type(uint128).max) {
                revert NotInTradersFavour();
            }
            c.maxBuy = uint128(value);
        } else if (field == FIELD_RELEASE_LIMITS) {
            if (value != 0) revert NotInTradersFavour();
            // Graduation (any trader's buy) or the limits' end can come between the creator vault's signature and
            // its landing; the signed release then lands changing nothing, so it never holds the vault's one-time key.
            if (block.timestamp < c.limitsEndAt && !OstraToken(c.token).limitsReleased()) {
                c.limitsEndAt = uint40(block.timestamp);
                OstraToken(c.token).releaseLimits();
            }
        } else if (field == FIELD_VOLATILITY_FEE) {
            if (value != 0 || !c.volatilityFee) revert NotInTradersFavour();
            c.volatilityFee = false;
        } else if (field == FIELD_MAX_TX_MOVE) {
            uint256 current = c.maxTxMoveTicks;
            if (current == 0 || (value != 0 && (value <= current || value > MAX_TX_MOVE_TICKS))) {
                revert NotInTradersFavour();
            }
            c.maxTxMoveTicks = uint16(value);
        } else {
            revert BadField();
        }
        emit PoolConfigured(id, field, value);
    }

    function _lower(uint256 value, uint256 current) private pure returns (uint256) {
        if (value >= current) revert NotInTradersFavour();
        return value;
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
        if (sender != locker && sender != dispatcher) {
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

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        bool breaker = _configs[key.toId()].maxTxMoveTicks != 0;
        if (breaker) _recordTxStartTick(key.toId());
        // The dispatcher's conversions pay nothing: no hook fee, tax or LP fee, and they leave the fee state alone.
        // The circuit breaker counts them from the transaction's start but does not check them: OstraDispatcher
        // stops each within the band (txMoveBand).
        if (sender == dispatcher) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
        }
        _referrer = _referrerOf(hookData);
        _devBuying = sender == devBuy;
        int128 fee = _beforeSwapFee(key, params);
        uint24 lp = _lpFee(key.toId(), params.zeroForOne, sender);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(fee, 0), lp | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev The swap's LP fee from OstraFees (the MEV surcharge included), keeping the pool's fee state. The actor
    ///      is the swap's tx.origin and its swapper together (OstraFees.actorOf).
    function _lpFee(PoolId id, bool zeroForOne, address sender) private returns (uint24) {
        PoolConfig storage c = _configs[id];
        uint256 state = feeState[id];
        (uint24 fee, uint24 surcharge, uint256 next) = FEES.quote(
            state,
            _tick(id),
            zeroForOne,
            uint64(uint256(keccak256(abi.encode(tx.origin, sender)))),
            c.stockQuote,
            c.volatilityFee,
            block.timestamp
        );
        if (next != state) feeState[id] = next;
        if (fee != OSTRA_BASE_LP_FEE || surcharge != 0) emit LpFeeCharged(id, fee, surcharge);
        return fee + surcharge;
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, int128) {
        if (sender == dispatcher) return (IHooks.afterSwap.selector, 0);
        _referrer = _referrerOf(hookData);
        _devBuying = sender == devBuy;
        return (IHooks.afterSwap.selector, _afterSwapFee(key, params, delta));
    }

    /// @dev The referrer in a swap's hookData: exactly abi.encode(address); anything else is no referrer.
    function _referrerOf(bytes calldata hookData) private pure returns (address) {
        if (hookData.length != 32) return address(0);
        uint256 word = uint256(bytes32(hookData));
        if (word >> 160 != 0) return address(0);
        return address(uint160(word));
    }

    // ---------------------------------------------------------------------------------------------
    // Circuit breaker
    // ---------------------------------------------------------------------------------------------

    /// @dev Bit 24 marks the slot as set, so that tick 0 is told from no swap yet.
    function _txStartSlot(PoolId id) private pure returns (bytes32) {
        return keccak256(abi.encode(TX_START_TICK_SEED, id));
    }

    function _recordTxStartTick(PoolId id) private {
        bytes32 slot = _txStartSlot(id);
        uint256 word;
        assembly ("memory-safe") {
            word := tload(slot)
        }
        if (word != 0) return;
        int24 tick = _tick(id);
        assembly ("memory-safe") {
            tstore(slot, or(shl(24, 1), and(tick, 0xffffff)))
        }
    }

    function _txStartTick(PoolId id) private view returns (bool set, int24 tick) {
        bytes32 slot = _txStartSlot(id);
        uint256 word;
        assembly ("memory-safe") {
            word := tload(slot)
        }
        set = word != 0;
        tick = int24(uint24(word));
    }

    /// @dev After a swap: the price may end at most maxTxMoveTicks from the tick before the transaction's first swap,
    ///      and only where the pool has liquidity.
    function _checkTxMove(PoolId id, uint256 cap) private view {
        (, int24 start) = _txStartTick(id);
        int256 moved = int256(_tick(id)) - int256(start);
        if (moved > int256(cap) || -moved > int256(cap)) revert PriceMoveTooLarge();
        if (_liquidity(id) == 0) revert NoLiquidityAtPrice();
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
        if (c.maxTxMoveTicks != 0) _checkTxMove(id, c.maxTxMoveTicks);
    }

    function _afterCharge(PoolId id, PoolKey calldata key, PoolConfig memory c, bool buy, BalanceDelta delta, bool onTop)
        private
        returns (int128)
    {
        int128 quoteDelta = c.tokenIs0 ? delta.amount1() : delta.amount0();
        uint256 amount = quoteDelta < 0 ? uint256(-int256(quoteDelta)) : uint256(int256(quoteDelta));
        return int128(int256(_charge(id, _quote(key, c), c, buy, amount, onTop)));
    }

    /// @dev Charges a swap whose quote leg is `amount`: the fee is minted to the dispatcher as PoolManager claims
    ///      and shared among the pool's pending balances. `onTop`: the amount is net of the fee (exact output sell, exact
    ///      output buy), so fee = amount * rate / (BPS - rate); otherwise fee = amount * rate / BPS.
    function _charge(PoolId id, Currency quote, PoolConfig memory c, bool buy, uint256 amount, bool onTop)
        private
        returns (uint256 fee)
    {
        bool graduated = _states[id].graduated;
        uint256 tax = _tax(c, graduated, buy);
        // OstraDevBuy only swaps inside its own launch: the dev buy, in the launch block, pays no anti-snipe.
        bool devBuyAtLaunch = _devBuying && block.timestamp == c.launchedAt;
        uint256 snipe = buy && !devBuyAtLaunch ? _antiSnipe(c, graduated) : 0;
        uint256 rate = HOOK_FEE_BPS + tax + snipe;
        fee = onTop ? (amount * rate) / (BPS - rate) : (amount * rate) / BPS;
        if (fee == 0) return 0;
        POOL_MANAGER.mint(dispatcher, quote.toId(), fee);
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

    /// @dev The hook fee: 70% creator, 30% protocol, half of it for buyback (OstraDispatcher shares the locked
    ///      positions' LP fees the same way); with a referrer, half of the protocol's 30% goes to the referrer first.
    function _shareFee(PoolId id, Currency quote, uint256 amount) private {
        uint256 creator = (amount * CREATOR_FEE_SHARE_BPS) / BPS;
        uint256 protocol = amount - creator;
        address referrer = _referrer;
        if (referrer != address(0)) {
            uint256 referral = (protocol * REFERRAL_SHARE_BPS) / BPS;
            if (referral != 0) {
                referralOwed[referrer][quote] += referral;
                protocol -= referral;
                emit Referred(id, referrer, referral);
            }
        }
        uint256 buyback = (protocol * BUYBACK_SHARE_BPS) / BPS;
        _pending[id].creator += uint128(creator);
        ProtocolShare storage s = protocolShare[quote];
        s.protocol += uint128(protocol - buyback);
        s.buyback += uint128(buyback);
    }

    function _shareTax(PoolId id, PoolConfig memory c, uint256 amount) private {
        Pending storage p = _pending[id];
        uint256 dividend = (amount * c.dividendBucketBps) / BPS;
        uint256 burn = (amount * c.burnBucketBps) / BPS;
        uint256 lp = (amount * c.lpBucketBps) / BPS;
        uint256 floor = (amount * c.floorBucketBps) / BPS;
        if (dividend != 0) p.dividend += uint128(dividend);
        if (burn != 0) p.burn += uint128(burn);
        if (lp != 0) p.lp += uint128(lp);
        if (floor != 0) p.floor += uint128(floor);
        // The creator bucket also takes what rounding leaves.
        p.creator += uint128(amount - dividend - burn - lp - floor);
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
    // Pool math
    // ---------------------------------------------------------------------------------------------

    /// @dev slot0's tick (StateLibrary.getSlot0: the 24 bits above the sqrt price, sign-extended).
    function _tick(PoolId id) private view returns (int24 tick) {
        bytes32 data = _slot0(id);
        assembly ("memory-safe") {
            tick := signextend(2, shr(160, data))
        }
    }

    /// @dev slot0 of the pool (v4-core StateLibrary.getSlot0, read the same way: pools mapping at slot 6).
    function _slot0(PoolId id) private view returns (bytes32) {
        return POOL_MANAGER.extsload(_stateSlot(id));
    }

    /// @dev The pool's active liquidity (StateLibrary.getLiquidity: the state slot + LIQUIDITY_OFFSET, 3).
    function _liquidity(PoolId id) private view returns (uint128) {
        return uint128(uint256(POOL_MANAGER.extsload(bytes32(uint256(_stateSlot(id)) + 3))));
    }

    function _stateSlot(PoolId id) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(PoolId.unwrap(id), bytes32(uint256(6))));
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
