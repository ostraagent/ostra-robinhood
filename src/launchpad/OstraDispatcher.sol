// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {OSTRA_BUYBACK_SHARE_BPS, OSTRA_CREATOR_FEE_SHARE_BPS, OstraHook} from "./OstraHook.sol";
import {OstraCreatorSplit} from "./OstraCreatorSplit.sol";
import {OstraLocker} from "./OstraLocker.sol";
import {OstraToken} from "./OstraToken.sol";

interface IWETH9 {
    function deposit() external payable;
}

/// @title OstraDispatcher
/// @notice Pays out what OstraHook charges (design v0.4, "Blok modular", approved 18 Oct 2026). The hook mints every
///         fee and tax it charges to this contract as PoolManager claims (ERC-6909) and books them per pool;
///         dispatch, which anyone may call, takes a pool's booked amounts from the hook and:
/// 1. collects the locked positions' LP fees (shared 70/30 like the hook fee);
/// 2. turns the token-side fees into quote;
/// 3. buys the token and burns it (burn bucket);
/// 4. buys half and adds both to the locker's full-range position (LP bucket);
/// 5. keeps the floor bucket as a quote-only position one tick spacing wide just below the price (the floor bid),
///    and moves it to the price when the price has left it, burning the tokens it bought;
/// 6. pays the dividends;
/// 7. pays the creator's share to the creator vault, or through OstraCreatorSplit while the pool has recipients; a
///    payout the creator's token refuses waits for the next dispatch, so it never holds up the rest.
/// Every conversion moves the price by at most MAX_DISPATCH_SQRT_MOVE_BPS, and a conversion sell stops at the floor
/// bid, so token fees are never sold into the bid. A conversion buy (burn, LP, dividends in the token) made while
/// the price is inside the bid buys back tokens the bid bought: the bid gets its quote back and the tokens are
/// burned or added as the bucket intends. What does not fit, and a floor bucket the price is inside of, goes back to
/// the hook for the next dispatch. The floor bid follows a rising price by at most one tick spacing every
/// FLOOR_STEP_INTERVAL, so a pump cannot lift the whole bucket to a pumped price at once. Dividends run in a call of
/// their own: a dividend pool or token that refuses them defers only the dividend bucket. The protocol's share of the
/// hook fee is booked per currency at swap time (OstraHook.protocolShare) and that of the locked positions' LP fees here,
/// so no pool's dispatch can hold it up; the owner claims the protocol's part (claimProtocol) and the OSTRA buyback
/// part (claimBuyback, to the buyback-and-burn). This contract's swaps pay no hook fee, tax or LP fee (OstraHook
/// skips them). Only the floor bid's own position can ever be removed, by this contract when it moves it; the launch
/// liquidity and the LP bucket stay in OstraLocker forever.
contract OstraDispatcher is IUnlockCallback, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    int24 public constant TICK_SPACING = 200;
    /// @notice A dispatch conversion moves the pool's sqrt price by at most this (about 1% of the price).
    uint256 public constant MAX_DISPATCH_SQRT_MOVE_BPS = 50;
    /// @notice The floor bid's position salt (the position belongs to this contract).
    bytes32 public constant FLOOR_SALT = bytes32(0);
    /// @notice The floor bid rises by one tick spacing at most this often: OstraFees' 60-second EMA half-life, the
    ///         timescale on which Ostra already tells a price move from a one-off push. Dispatch is open to anyone,
    ///         so a limit per call would not hold; this one holds however often dispatch is called.
    uint256 public constant FLOOR_STEP_INTERVAL = 60;

    IPoolManager public immutable POOL_MANAGER;
    OstraHook public immutable HOOK;
    address public immutable WETH;
    OstraCreatorSplit public immutable SPLIT;

    struct FloorBid {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        /// @notice When the bid last rose a spacing.
        uint40 steppedAt;
    }

    /// @notice Each pool's floor bid position (liquidity 0: none).
    mapping(PoolId => FloorBid) public floorBid;
    /// @dev The protocol's share of the locked positions' LP fees per currency (claims), and its buyback part; the
    ///      hook fee's share is in OstraHook.protocolShare until a claim takes it.
    mapping(Currency => uint256) private _protocolOwed;
    mapping(Currency => uint256) private _buybackOwed;

    uint8 private constant OP_DISPATCH = 1;
    uint8 private constant OP_CLAIM_PROTOCOL = 2;
    uint8 private constant OP_CLAIM_BUYBACK = 3;

    event Dispatched(
        PoolId indexed poolId, uint256 creatorPaid, uint256 dividends, uint256 burned, uint256 liquidity
    );
    /// @notice The floor bid is now [tickLower, tickUpper) with `liquidity`; `burned` tokens it had bought were burned.
    event FloorBidSet(PoolId indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 burned);
    /// @notice The creator's token refused the payout (a blocked account, a paused token): it waits in the pool.
    event CreatorPayoutDeferred(PoolId indexed poolId, uint256 amount);
    /// @notice The dividend step failed (the dividend pool or token refused it): the bucket waits in the pool.
    event DividendsDeferred(PoolId indexed poolId, uint256 amount);
    event ProtocolClaimed(Currency indexed currency, address to, uint256 amount);
    event BuybackClaimed(Currency indexed currency, address to, uint256 amount);

    error OnlyPoolManager();
    error NotRegistered();
    error NothingToClaim();
    error BadDividendSwap();
    error OnlySelf();

    constructor(address poolManager, address hook, address weth, address split, address admin) Ownable(admin) {
        POOL_MANAGER = IPoolManager(poolManager);
        HOOK = OstraHook(hook);
        WETH = weth;
        SPLIT = OstraCreatorSplit(split);
    }

    receive() external payable {}

    /// @notice Pays out what a pool has accrued (see the contract notice). Anyone may call it.
    function dispatch(PoolId id) external nonReentrant {
        if (!HOOK.poolState(id).registered) revert NotRegistered();
        POOL_MANAGER.unlock(abi.encode(OP_DISPATCH, abi.encode(id)));
    }

    /// @notice The protocol's share owed in `currency`: of the hook fee (booked in the hook) and of the locked
    ///         positions' LP fees.
    function protocolOwed(Currency currency) public view returns (uint256) {
        (uint128 protocol,) = HOOK.protocolShare(currency);
        return _protocolOwed[currency] + protocol;
    }

    /// @notice The part of the protocol's share kept for the OSTRA buyback-and-burn, owed in `currency`.
    function buybackOwed(Currency currency) public view returns (uint256) {
        (, uint128 buyback) = HOOK.protocolShare(currency);
        return _buybackOwed[currency] + buyback;
    }

    /// @notice Pays the protocol's share in `currency` to `to` (the operator's vault; WETH for ETH).
    function claimProtocol(Currency currency, address to) external onlyOwner nonReentrant {
        if (protocolOwed(currency) == 0) revert NothingToClaim();
        POOL_MANAGER.unlock(abi.encode(OP_CLAIM_PROTOCOL, abi.encode(currency, to)));
    }

    /// @notice Pays the buyback part in `currency` to `to`, the account that buys OSTRA with it and burns it.
    function claimBuyback(Currency currency, address to) external onlyOwner nonReentrant {
        if (buybackOwed(currency) == 0) revert NothingToClaim();
        POOL_MANAGER.unlock(abi.encode(OP_CLAIM_BUYBACK, abi.encode(currency, to)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert OnlyPoolManager();
        (uint8 op, bytes memory args) = abi.decode(data, (uint8, bytes));
        if (op == OP_DISPATCH) {
            _dispatch(abi.decode(args, (PoolId)));
        } else {
            (Currency currency, address to) = abi.decode(args, (Currency, address));
            (uint256 protocol, uint256 buyback) = HOOK.takeProtocolShare(currency);
            _protocolOwed[currency] += protocol;
            _buybackOwed[currency] += buyback;
            uint256 amount;
            if (op == OP_CLAIM_PROTOCOL) {
                amount = _protocolOwed[currency];
                _protocolOwed[currency] = 0;
                emit ProtocolClaimed(currency, to, amount);
            } else {
                amount = _buybackOwed[currency];
                _buybackOwed[currency] = 0;
                emit BuybackClaimed(currency, to, amount);
            }
            _payOut(currency, amount, to);
        }
        return "";
    }

    // ---------------------------------------------------------------------------------------------
    // Dispatch
    // ---------------------------------------------------------------------------------------------

    function _dispatch(PoolId id) private {
        PoolKey memory key = HOOK.poolKey(id);
        OstraHook.PoolConfig memory c = HOOK.poolConfig(id);
        OstraHook.Pending memory p = HOOK.takePending(id);
        Currency quote = c.tokenIs0 ? key.currency1 : key.currency0;

        // 1. The locked positions' LP fees, as claims of this contract.
        (uint256 fees0, uint256 fees1) = OstraLocker(HOOK.locker()).collectToDispatcher(key);
        uint256 quoteFees = c.tokenIs0 ? fees1 : fees0;
        p.tokenFees += uint128(c.tokenIs0 ? fees0 : fees1);
        if (quoteFees != 0) _shareFee(p, quote, quoteFees);

        // 2. Token-side LP fees become quote, within the price-move bound and above the floor bid.
        if (p.tokenFees != 0) {
            (uint256 spent, uint256 got) = _sellClaims(id, key, c, p.tokenFees);
            p.tokenFees -= uint128(spent);
            if (got != 0) _shareFee(p, quote, got);
        }

        // 3. Burn bucket: buy the token and burn it.
        uint256 burned;
        if (p.burn != 0) {
            (uint256 spent, uint256 got) = _swapClaims(key, c, true, p.burn);
            p.burn -= uint128(spent);
            burned = _burnClaims(key, c, got);
        }

        // 4. LP bucket: buy half, add both to the full-range position.
        uint256 liquidity;
        if (p.lp != 0) liquidity = _addLiquidity(key, c, p);

        // 5. Floor bid.
        burned += _floorBid(id, key, c, p);

        // 6. Dividends, in a call of their own: a dividend pool or token that refuses only defers the bucket.
        uint256 dividends;
        if (p.dividend != 0 && OstraToken(c.token).totalDividendShares() != 0) {
            try this.dividendStep(id, key, c, p.dividend) returns (uint256 spent, uint256 paid) {
                p.dividend -= uint128(spent);
                dividends = paid;
            } catch {
                emit DividendsDeferred(id, p.dividend);
            }
        }

        // 7. The creator's share: to the creator vault, or through the split while the pool has recipients.
        uint256 creatorPaid = p.creator;
        if (creatorPaid != 0) {
            bool split = SPLIT.recipientCount(id) != 0;
            if (_tryPayOut(quote, creatorPaid, split ? address(SPLIT) : c.creatorVault)) {
                p.creator = 0;
                if (split) {
                    SPLIT.credit(id, quote.isAddressZero() ? WETH : Currency.unwrap(quote), c.creatorVault, creatorPaid);
                }
            } else {
                emit CreatorPayoutDeferred(id, creatorPaid);
                creatorPaid = 0;
            }
        }

        if (
            p.creator != 0 || p.dividend != 0 || p.burn != 0 || p.lp != 0 || p.floor != 0 || p.tokenFees != 0
        ) HOOK.restorePending(id, p);
        emit Dispatched(id, creatorPaid, dividends, burned, liquidity);
    }

    /// @dev The locked positions' LP fees in quote: 70% creator, 30% protocol, half of it for buyback, like the
    ///      hook fee (OstraHook).
    function _shareFee(OstraHook.Pending memory p, Currency quote, uint256 amount) private {
        uint256 creator = (amount * OSTRA_CREATOR_FEE_SHARE_BPS) / BPS;
        uint256 protocol = amount - creator;
        uint256 buyback = (protocol * OSTRA_BUYBACK_SHARE_BPS) / BPS;
        p.creator += uint128(creator);
        _buybackOwed[quote] += buyback;
        _protocolOwed[quote] += protocol - buyback;
    }

    /// @dev Swaps `amount` of this contract's claims on the pool (buy: quote for token; else token for quote), paid
    ///      by burning claims, the output minted back as claims. The price may move by at most
    ///      MAX_DISPATCH_SQRT_MOVE_BPS; what does not fit stays for the next dispatch.
    function _swapClaims(PoolKey memory key, OstraHook.PoolConfig memory c, bool buy, uint256 amount)
        private
        returns (uint256 spent, uint256 got)
    {
        bool zeroForOne = c.tokenIs0 ? !buy : buy;
        return _swapClaimsTo(key, zeroForOne, amount, _limit(key, zeroForOne));
    }

    /// @dev A conversion sell (token for quote) that also stops where the floor bid starts, so the dispatcher never
    ///      fills its own bid; nothing is sold while the price is at or inside the bid.
    function _sellClaims(PoolId id, PoolKey memory key, OstraHook.PoolConfig memory c, uint256 amount)
        private
        returns (uint256, uint256)
    {
        bool zeroForOne = c.tokenIs0;
        uint160 limit = _limit(key, zeroForOne);
        FloorBid memory f = floorBid[id];
        if (f.liquidity != 0) {
            // tokenIs0: a sell lowers the price toward the bid's upper tick; otherwise it raises it toward the lower.
            uint160 edge = TickMath.getSqrtPriceAtTick(zeroForOne ? f.tickUpper : f.tickLower);
            uint160 price = _sqrtPrice(id);
            if (zeroForOne ? price <= edge : price >= edge) return (0, 0);
            if (zeroForOne ? edge > limit : edge < limit) limit = edge;
        }
        return _swapClaimsTo(key, zeroForOne, amount, limit);
    }

    function _swapClaimsTo(PoolKey memory key, bool zeroForOne, uint256 amount, uint160 limit)
        private
        returns (uint256 spent, uint256 got)
    {
        // v4 refuses a zero-amount swap: a bucket of 1 wei halved, for one, must not stop the dispatch.
        if (amount == 0) return (0, 0);
        BalanceDelta d = POOL_MANAGER.swap(
            key, IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit}), ""
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

    /// @dev Burns `amount` of the pool's token held as claims of this contract.
    function _burnClaims(PoolKey memory key, OstraHook.PoolConfig memory c, uint256 amount) private returns (uint256) {
        if (amount == 0) return 0;
        Currency token = c.tokenIs0 ? key.currency0 : key.currency1;
        POOL_MANAGER.burn(address(this), token.toId(), amount);
        POOL_MANAGER.take(token, address(this), amount);
        OstraToken(c.token).burn(amount);
        return amount;
    }

    function _addLiquidity(PoolKey memory key, OstraHook.PoolConfig memory c, OstraHook.Pending memory p)
        private
        returns (uint256)
    {
        (uint256 spent, uint256 tokens) = _swapClaims(key, c, true, p.lp / 2);
        uint256 quoteLeft = p.lp - spent;
        uint128 liquidity = _fullRangeLiquidity(key, c.tokenIs0 ? tokens : quoteLeft, c.tokenIs0 ? quoteLeft : tokens);
        if (liquidity == 0) {
            // Too little to add: the bought tokens wait as claims with the token fees, the quote stays in the bucket.
            p.lp = uint128(quoteLeft);
            p.tokenFees += uint128(tokens);
            return 0;
        }
        (uint256 tokenCost, uint256 quoteCost) = _addFullRange(key, c.tokenIs0, liquidity);
        p.lp = uint128(quoteLeft - quoteCost);
        // Bought tokens the position did not take wait with the token fees (they turn back into quote).
        if (tokens > tokenCost) p.tokenFees += uint128(tokens - tokenCost);
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
        OstraLocker locker = OstraLocker(HOOK.locker());
        BalanceDelta d = locker.addFullRange(
            key, TickMath.minUsableTick(TICK_SPACING), TickMath.maxUsableTick(TICK_SPACING), liquidity
        );
        uint256 cost0 = uint256(-int256(d.amount0()));
        uint256 cost1 = uint256(-int256(d.amount1()));
        _payFor(key.currency0, cost0, address(locker));
        _payFor(key.currency1, cost1, address(locker));
        (tokenCost, quoteCost) = tokenIs0 ? (cost0, cost1) : (cost1, cost0);
    }

    /// @dev Settles `amount` of `currency` the locker owes for an added position, out of this contract's claims.
    function _payFor(Currency currency, uint256 amount, address locker) private {
        if (amount == 0) return;
        POOL_MANAGER.burn(address(this), currency.toId(), amount);
        POOL_MANAGER.take(currency, address(this), amount);
        if (currency.isAddressZero()) {
            POOL_MANAGER.settleFor{value: amount}(locker);
        } else {
            POOL_MANAGER.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(POOL_MANAGER), amount);
            POOL_MANAGER.settleFor(locker);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Floor bid
    // ---------------------------------------------------------------------------------------------

    /// @notice The range the floor bid takes at the pool's current price: one tick spacing on the quote side,
    ///         adjacent to the price (below the token's price), so the position holds only quote.
    function floorRange(PoolId id) public view returns (int24 tickLower, int24 tickUpper) {
        return _floorRange(_tick(id), HOOK.poolConfig(id).tokenIs0);
    }

    function _floorRange(int24 tick, bool tokenIs0) private pure returns (int24 tickLower, int24 tickUpper) {
        int24 compressed = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) compressed--;
        if (tokenIs0) {
            // The token's price rises with the tick: the bid sits in the spacing below, all currency1 (the quote).
            tickUpper = compressed * TICK_SPACING;
            tickLower = tickUpper - TICK_SPACING;
        } else {
            // The token's price rises as the tick falls: the bid sits in the spacing above, all currency0.
            tickLower = (compressed + 1) * TICK_SPACING;
            tickUpper = tickLower + TICK_SPACING;
        }
    }

    /// @dev Keeps the floor bid at the price: adds the floor bucket to it while it is where it should be, moves it
    ///      there when the price has left it (burning the tokens it bought), and waits while the price is inside it.
    function _floorBid(PoolId id, PoolKey memory key, OstraHook.PoolConfig memory c, OstraHook.Pending memory p)
        private
        returns (uint256 burned)
    {
        FloorBid memory f = floorBid[id];
        if (f.liquidity == 0 && p.floor == 0) return 0;
        int24 tick = _tick(id);
        (int24 lower, int24 upper) = _floorRange(tick, c.tokenIs0);
        uint40 steppedAt = f.steppedAt;
        // Once a bid has been placed (even if it is empty now), it rises from where it was.
        if (f.tickLower != f.tickUpper && (c.tokenIs0 ? lower > f.tickLower : upper < f.tickUpper)) {
            // Up (toward a higher token price): one spacing every FLOOR_STEP_INTERVAL at most, and the step is still
            // outside the price (the price is above the target, which is at or above the step).
            if (block.timestamp < uint256(steppedAt) + FLOOR_STEP_INTERVAL) {
                (lower, upper) = (f.tickLower, f.tickUpper);
            } else {
                steppedAt = uint40(block.timestamp);
                if (c.tokenIs0) {
                    lower = f.tickLower + TICK_SPACING;
                    upper = lower + TICK_SPACING;
                } else {
                    upper = f.tickUpper - TICK_SPACING;
                    lower = upper - TICK_SPACING;
                }
            }
        }
        if (lower < TickMath.minUsableTick(TICK_SPACING) || upper > TickMath.maxUsableTick(TICK_SPACING)) return 0;
        if (f.liquidity != 0 && (f.tickLower != lower || f.tickUpper != upper)) {
            // The price is inside the bid: it is buying; the bucket waits until the price leaves it.
            if (tick >= f.tickLower && tick < f.tickUpper) return 0;
            burned = _modifyFloor(key, c, p, f.tickLower, f.tickUpper, -int256(uint256(f.liquidity)));
            f.liquidity = 0;
        }
        uint128 added;
        if (p.floor > 2) {
            // Two wei short of the bucket, so the position's rounded-up cost never exceeds it.
            added = _quoteLiquidity(c.tokenIs0, lower, upper, p.floor - 2);
            if (added != 0) burned += _modifyFloor(key, c, p, lower, upper, int256(uint256(added)));
        }
        uint128 total = f.liquidity + added;
        floorBid[id] = FloorBid({tickLower: lower, tickUpper: upper, liquidity: total, steppedAt: steppedAt});
        if (added != 0 || burned != 0) emit FloorBidSet(id, lower, upper, total, burned);
    }

    /// @dev Adds or removes floor-bid liquidity and settles it with this contract's claims: quote it costs comes out
    ///      of the floor bucket, quote it returns (fees included) goes back into it, and tokens it returns (what the
    ///      bid bought, and fees) are burned.
    function _modifyFloor(
        PoolKey memory key,
        OstraHook.PoolConfig memory c,
        OstraHook.Pending memory p,
        int24 lower,
        int24 upper,
        int256 liquidityDelta
    ) private returns (uint256 burned) {
        (BalanceDelta d,) = POOL_MANAGER.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: lower,
                tickUpper: upper,
                liquidityDelta: liquidityDelta,
                salt: FLOOR_SALT
            }),
            ""
        );
        int128 quoteDelta = c.tokenIs0 ? d.amount1() : d.amount0();
        int128 tokenDelta = c.tokenIs0 ? d.amount0() : d.amount1();
        Currency quote = c.tokenIs0 ? key.currency1 : key.currency0;
        if (quoteDelta < 0) {
            uint256 cost = uint256(-int256(quoteDelta));
            POOL_MANAGER.burn(address(this), quote.toId(), cost);
            p.floor -= uint128(cost);
        } else if (quoteDelta > 0) {
            uint256 back = uint256(int256(quoteDelta));
            POOL_MANAGER.mint(address(this), quote.toId(), back);
            p.floor += uint128(back);
        }
        if (tokenDelta > 0) {
            uint256 tokens = uint256(int256(tokenDelta));
            Currency token = c.tokenIs0 ? key.currency0 : key.currency1;
            POOL_MANAGER.take(token, address(this), tokens);
            OstraToken(c.token).burn(tokens);
            burned = tokens;
        }
    }

    /// @dev The liquidity `amount` of quote buys in [lower, upper) when the range holds only quote.
    function _quoteLiquidity(bool tokenIs0, int24 lower, int24 upper, uint256 amount) private pure returns (uint128) {
        uint160 a = TickMath.getSqrtPriceAtTick(lower);
        uint160 b = TickMath.getSqrtPriceAtTick(upper);
        // tokenIs0: the quote is currency1, below the price: L = amount1 * Q96 / (sqrtB - sqrtA). Otherwise the
        // quote is currency0, above the price: L = amount0 * sqrtA * sqrtB / Q96 / (sqrtB - sqrtA).
        uint256 l = tokenIs0
            ? FullMath.mulDiv(amount, 1 << 96, b - a)
            : FullMath.mulDiv(amount, FullMath.mulDiv(a, b, 1 << 96), b - a);
        return l > type(uint128).max ? type(uint128).max : uint128(l);
    }

    // ---------------------------------------------------------------------------------------------
    // Dividends and payouts
    // ---------------------------------------------------------------------------------------------

    /// @notice The dividend step of a dispatch, called by this contract on itself inside its unlock so that a
    ///         failure reverts only this step: pays `amount` of the pool's dividend bucket (quote claims) as
    ///         dividends. Returns the quote spent and the dividends paid.
    function dividendStep(PoolId id, PoolKey calldata key, OstraHook.PoolConfig calldata c, uint256 amount)
        external
        returns (uint256 spent, uint256 paid)
    {
        if (msg.sender != address(this)) revert OnlySelf();
        Currency quote = c.tokenIs0 ? key.currency1 : key.currency0;
        address dividendToken = c.dividendToken;
        if (dividendToken == c.token) {
            uint256 got;
            (spent, got) = _swapClaims(key, c, true, amount);
            if (got == 0) return (spent, 0);
            Currency token = c.tokenIs0 ? key.currency0 : key.currency1;
            POOL_MANAGER.burn(address(this), token.toId(), got);
            POOL_MANAGER.take(token, c.token, got);
            paid = got;
        } else if (dividendToken == Currency.unwrap(quote) || (quote.isAddressZero() && dividendToken == WETH)) {
            spent = amount;
            paid = amount;
            _payOut(quote, amount, c.token);
        } else {
            (spent, paid) = _swapDividendToken(HOOK.dividendKey(id), quote, dividendToken, amount, c.token);
            if (paid == 0) return (spent, 0);
        }
        OstraToken(c.token).distributeDividends(paid);
    }

    /// @dev Buys the dividend token with `amount` of the bucket's quote in the pool `dk` (another pool, with its own
    ///      rules), within the same price-move bound as the conversions, and sends it to the token contract.
    function _swapDividendToken(PoolKey memory dk, Currency quote, address dividendToken, uint256 amount, address to)
        private
        returns (uint256 spent, uint256 got)
    {
        bool zeroForOne = Currency.unwrap(dk.currency0) == Currency.unwrap(quote);
        BalanceDelta d = POOL_MANAGER.swap(
            dk,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: _limit(dk, zeroForOne)
            }),
            ""
        );
        int128 in_ = zeroForOne ? d.amount0() : d.amount1();
        int128 out = zeroForOne ? d.amount1() : d.amount0();
        if (in_ > 0 || out < 0) revert BadDividendSwap();
        spent = uint256(-int256(in_));
        got = uint256(int256(out));
        POOL_MANAGER.burn(address(this), quote.toId(), spent);
        if (got != 0) POOL_MANAGER.take(Currency.wrap(dividendToken), to, got);
    }

    /// @dev Like _payOut, but returns false, with nothing paid, when the token refuses the transfer to `to`.
    function _tryPayOut(Currency currency, uint256 amount, address to) private returns (bool) {
        if (currency.isAddressZero()) {
            _payOut(currency, amount, to);
            return true;
        }
        try POOL_MANAGER.take(currency, to, amount) {
            POOL_MANAGER.burn(address(this), currency.toId(), amount);
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Pays `amount` of this contract's claims in `currency` to `to`; native ETH is wrapped and paid as WETH.
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

    /// @dev The pool's state slot in the PoolManager (v4-core StateLibrary: pools mapping at slot 6).
    function _stateSlot(PoolId id) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(PoolId.unwrap(id), bytes32(uint256(6))));
    }

    /// @dev slot0's sqrt price (StateLibrary.getSlot0).
    function _sqrtPrice(PoolId id) private view returns (uint160) {
        return uint160(uint256(POOL_MANAGER.extsload(_stateSlot(id))));
    }

    /// @dev slot0's tick (StateLibrary.getSlot0: the 24 bits above the sqrt price, sign-extended).
    function _tick(PoolId id) private view returns (int24 tick) {
        bytes32 data = POOL_MANAGER.extsload(_stateSlot(id));
        assembly ("memory-safe") {
            tick := signextend(2, shr(160, data))
        }
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
}
