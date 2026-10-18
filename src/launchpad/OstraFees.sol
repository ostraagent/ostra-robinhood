// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {OstraHook} from "./OstraHook.sol";

/// @dev The base LP fee (pips), shared with OstraHook, which emits LpFeeCharged above it.
uint24 constant OSTRA_BASE_LP_FEE = 2_500;

/// @title OstraFees
/// @notice The LP fee of every Ostra pool, swap by swap (design v0.4, Patch B, approved 18 Oct 2026, calibrated on
///         Robinhood Chain mainnet data). Stateless: OstraHook keeps each pool's FeeState and asks this contract for
///         the fee and the next state. In pips (1,000,000 = 100%), as Uniswap v4 takes an LP fee:
/// * the base LP fee, BASE_LP_FEE (0.25%);
/// * a pool quoted in a Robinhood stock token pays CLOSED_LP_FEE (0.50%) while the stock's market is closed: from
///   20:00 ET on the day before a weekend day or an NYSE holiday to 20:00 ET on that day (the Robinhood 24/5 market
///   runs from 20:00 ET Sunday to 20:00 ET Friday). Over 13 weekends the USDG/AAPL pool moved a median 0.44% (most
///   2.0%) between the Friday and Monday sessions, while its realized volatility on weekdays, the overnight session
///   included, stayed live: the surcharge is for the weekend and holiday gap only. US daylight saving time is
///   computed here; the NYSE holidays are those NYSE published for 2026 to 2028 (HOLIDAYS_*), after which only
///   weekends count;
/// * a pool whose creator chose the volatility fee pays, at least, an LP fee rising linearly from BASE_LP_FEE to
///   MAX_LP_FEE (1%, Uniswap's tier for volatile tokens) as the price moves from 0 to VOLATILITY_FULL_TICKS
///   (about 3%) away from its time-weighted EMA with an EMA_HALF_LIFE (60 seconds) half-life. The larger of this and
///   the session fee applies, never their sum, and never more than MAX_LP_FEE;
/// * on top, the MEV surcharge: the first swap of a pool in each second records its actor (tx.origin and the
///   swapper together, so two users relayed by one sender are two actors), its direction and the tick before it.
///   A later swap in that second by the same actor in the other direction pays MEV_PIPS_PER_TICK for every tick
///   the price moved since that first swap (a tick is about 1 bp), at most MAX_MEV_SURCHARGE (5%). That is what a
///   sandwich's back-run, or a bot reversing its own trade, does; no other trader is ever charged it. On mainnet
///   in two hours of 80,851 swaps, 396 such reversals happened (all bots), 93% by the first actor of the block.
contract OstraFees {
    uint24 public constant BASE_LP_FEE = OSTRA_BASE_LP_FEE;
    uint24 public constant CLOSED_LP_FEE = 5_000;
    uint24 public constant MAX_LP_FEE = 10_000;
    uint256 public constant VOLATILITY_FULL_TICKS = 300;
    uint256 public constant EMA_HALF_LIFE = 60;
    uint24 public constant MEV_PIPS_PER_TICK = 100;
    uint24 public constant MAX_MEV_SURCHARGE = 50_000;

    /// @notice The NYSE holidays (full-day closures) NYSE published for 2026 to 2028: bit i of HOLIDAYS_<i / 256> is
    ///         day HOLIDAYS_FROM_DAY + i (days since 1970-01-01).
    uint256 public constant HOLIDAYS_FROM_DAY = 20_454; // 2026-01-01
    uint256 public constant HOLIDAYS_UNTIL_DAY = 21_550; // 2029-01-01, excluded
    uint256 public constant HOLIDAYS_0 = 0x200000000000000008002000001000000000000100000000000400000040001;
    uint256 public constant HOLIDAYS_1 = 0x2000000000400000040002040000002000000000000000000;
    uint256 public constant HOLIDAYS_2 = 0x40000040000002000000000000000000020000000000000004000200008;
    uint256 public constant HOLIDAYS_3 = 0x20000000000000008001000008000000000040000000000002000;
    uint256 public constant HOLIDAYS_4 = 0x20000000200000000;

    int256 private constant ONE = 1e18;
    int256 private constant TICK_SCALE = 1e6;

    /// @notice What OstraHook keeps per pool for its fees, in one word (pack and unpack below): bits 0-63 the price
    ///         EMA in ticks times 1e6, 64-103 when it was last moved (0: not started), 104-143 the second of the
    ///         pool's last MEV window, 144-167 the tick before that window's first swap, 168 its direction, and
    ///         169-232 its actor (the low 64 bits of actorOf: a stranger matching it by chance is a 2^-64 event).
    struct FeeState {
        int64 emaTickE6;
        uint40 emaAt;
        uint40 windowAt;
        int24 windowTick;
        bool windowZeroForOne;
        uint64 windowActor;
    }

    /// @notice The LP fee (without the MEV surcharge) and the surcharge of a swap at `time` from pool tick `tick`
    ///         (before the swap), and the pool's fee state after it.
    function quote(
        uint256 state,
        int24 tick,
        bool zeroForOne,
        uint64 actor,
        bool stockQuote,
        bool volatilityFee,
        uint256 time
    ) public pure returns (uint24 lpFee, uint24 mevSurcharge, uint256 nextState) {
        FeeState memory st = unpack(state);
        lpFee = stockQuote && nyseClosed(time) ? CLOSED_LP_FEE : BASE_LP_FEE;
        if (volatilityFee) {
            int256 ema = st.emaAt == 0 ? int256(tick) * TICK_SCALE : _ema(st.emaTickE6, tick, time - st.emaAt);
            uint24 v = volatilityLpFee(tick, ema);
            if (v > lpFee) lpFee = v;
            st.emaTickE6 = int64(ema);
            st.emaAt = uint40(time);
        }
        if (st.windowAt != time) {
            st.windowAt = uint40(time);
            st.windowTick = tick;
            st.windowZeroForOne = zeroForOne;
            st.windowActor = actor;
        } else if (st.windowActor == actor && st.windowZeroForOne != zeroForOne) {
            int256 moved = int256(tick) - int256(st.windowTick);
            uint256 s = uint256(moved < 0 ? -moved : moved) * MEV_PIPS_PER_TICK;
            mevSurcharge = s > MAX_MEV_SURCHARGE ? MAX_MEV_SURCHARGE : uint24(s);
        }
        nextState = pack(st);
    }

    function pack(FeeState memory st) public pure returns (uint256) {
        return uint256(uint64(st.emaTickE6)) | (uint256(st.emaAt) << 64) | (uint256(st.windowAt) << 104)
            | (uint256(uint24(st.windowTick)) << 144) | (st.windowZeroForOne ? uint256(1) << 168 : 0)
            | (uint256(st.windowActor) << 169);
    }

    function unpack(uint256 word) public pure returns (FeeState memory st) {
        st.emaTickE6 = int64(uint64(word));
        st.emaAt = uint40(word >> 64);
        st.windowAt = uint40(word >> 104);
        st.windowTick = int24(uint24(word >> 144));
        st.windowZeroForOne = (word >> 168) & 1 == 1;
        st.windowActor = uint64(word >> 169);
    }

    /// @notice Who a swap is for the MEV surcharge: the low 64 bits of keccak256(tx.origin, swapper), the swapper
    ///         being the hook's sender (a router, or a vault swapping itself), as OstraHook computes it.
    function actorOf(address origin, address swapper) public pure returns (uint64) {
        return uint64(uint256(keccak256(abi.encode(origin, swapper))));
    }

    /// @notice The LP fee (pips) a swap in pool `id` of `hook` pays right now, without the MEV surcharge.
    function lpFeeOf(OstraHook hook, PoolId id) external view returns (uint24 fee) {
        OstraHook.PoolConfig memory c = hook.poolConfig(id);
        (fee,,) = quote(hook.feeState(id), _tick(hook, id), false, 0, c.stockQuote, c.volatilityFee, block.timestamp);
    }

    /// @notice The MEV surcharge (pips) a swap in direction `zeroForOne` by `origin` through `swapper` pays right now.
    function mevSurchargeOf(OstraHook hook, PoolId id, address origin, address swapper, bool zeroForOne)
        external
        view
        returns (uint24 surcharge)
    {
        OstraHook.PoolConfig memory c = hook.poolConfig(id);
        (, surcharge,) = quote(
            hook.feeState(id), _tick(hook, id), zeroForOne, actorOf(origin, swapper), c.stockQuote, c.volatilityFee, block.timestamp
        );
    }

    /// @dev slot0's tick (v4-core StateLibrary.getSlot0: pools mapping at slot 6, the 24 bits above the sqrt price).
    function _tick(OstraHook hook, PoolId id) private view returns (int24 tick) {
        bytes32 data = IPoolManager(address(hook.POOL_MANAGER())).extsload(keccak256(abi.encodePacked(PoolId.unwrap(id), bytes32(uint256(6)))));
        assembly ("memory-safe") {
            tick := signextend(2, shr(160, data))
        }
    }

    /// @notice The volatility LP fee at `tick` with the price EMA at `emaTickE6` (ticks times 1e6).
    function volatilityLpFee(int24 tick, int256 emaTickE6) public pure returns (uint24) {
        int256 d = int256(tick) * TICK_SCALE - emaTickE6;
        uint256 dist = uint256(d < 0 ? -d : d) / uint256(TICK_SCALE);
        if (dist >= VOLATILITY_FULL_TICKS) return MAX_LP_FEE;
        return uint24(BASE_LP_FEE + (uint256(MAX_LP_FEE - BASE_LP_FEE) * dist) / VOLATILITY_FULL_TICKS);
    }

    /// @dev The EMA after `dt` seconds at `tick`: weight 2^(-dt / EMA_HALF_LIFE) on the old EMA.
    function _ema(int64 emaTickE6, int24 tick, uint256 dt) private pure returns (int256) {
        int256 w = _halfPower(dt);
        return (int256(emaTickE6) * w + int256(tick) * TICK_SCALE * (ONE - w)) / ONE;
    }

    /// @dev 2^(-dt / EMA_HALF_LIFE) in 1e18: whole half-lives as shifts, the rest by the series of e^(-x ln 2) to the
    ///      fifth power (error under 2e-4 of the weight, nothing next to the fee's 300-tick scale).
    function _halfPower(uint256 dt) private pure returns (int256) {
        uint256 halves = dt / EMA_HALF_LIFE;
        if (halves >= 64) return 0;
        int256 x = (int256(dt % EMA_HALF_LIFE) * 693_147_180_559_945_309) / int256(EMA_HALF_LIFE); // x * ln 2, 1e18
        int256 term = ONE;
        int256 sum = ONE;
        for (int256 k = 1; k <= 5; ++k) {
            term = (-term * x) / (ONE * k);
            sum += term;
        }
        return sum >> halves;
    }

    // ---------------------------------------------------------------------------------------------
    // The NYSE calendar
    // ---------------------------------------------------------------------------------------------

    /// @notice True while the stock market is closed at `time` (unix seconds): the trading day that time belongs to
    ///         (its New York date four hours later, so a day runs from 20:00 ET the evening before) is a Saturday, a
    ///         Sunday or an NYSE holiday.
    function nyseClosed(uint256 time) public pure returns (bool) {
        uint256 ny = time - (isUsDaylightTime(time) ? 4 hours : 5 hours);
        uint256 day = (ny + 4 hours) / 1 days;
        uint256 weekday = (day + 3) % 7; // 1970-01-01 was a Thursday; 0 is Monday
        if (weekday >= 5) return true;
        return isNyseHoliday(day);
    }

    /// @notice True when day `day` (days since 1970-01-01) is one of the NYSE holidays HOLIDAYS_* list.
    function isNyseHoliday(uint256 day) public pure returns (bool) {
        if (day < HOLIDAYS_FROM_DAY || day >= HOLIDAYS_UNTIL_DAY) return false;
        uint256 i = day - HOLIDAYS_FROM_DAY;
        uint256 word = i < 256 ? HOLIDAYS_0 : i < 512 ? HOLIDAYS_1 : i < 768 ? HOLIDAYS_2 : i < 1024 ? HOLIDAYS_3 : HOLIDAYS_4;
        return (word >> (i % 256)) & 1 == 1;
    }

    /// @notice True when `time` is in US daylight saving time: from 07:00 UTC on the second Sunday of March (2:00
    ///         EST) to 06:00 UTC on the first Sunday of November (2:00 EDT).
    function isUsDaylightTime(uint256 time) public pure returns (bool) {
        (uint256 year,,) = _civil(time / 1 days);
        uint256 march1 = _days(year, 3, 1);
        uint256 nov1 = _days(year, 11, 1);
        // The first Sunday on or after day d: weekday(d) = (d + 3) % 7 with 6 = Sunday.
        uint256 start = march1 + (6 + 7 - (march1 + 3) % 7) % 7 + 7;
        uint256 end = nov1 + (6 + 7 - (nov1 + 3) % 7) % 7;
        return time >= start * 1 days + 7 hours && time < end * 1 days + 6 hours;
    }

    /// @dev The civil date of day `z` since 1970-01-01 (Howard Hinnant's civil_from_days, for z >= 0).
    function _civil(uint256 z) private pure returns (uint256 year, uint256 month, uint256 dayOfMonth) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        dayOfMonth = doy - (153 * mp + 2) / 5 + 1;
        month = mp < 10 ? mp + 3 : mp - 9;
        year = yoe + era * 400 + (month <= 2 ? 1 : 0);
    }

    /// @dev Days since 1970-01-01 of a civil date (Howard Hinnant's days_from_civil, for years from 1970).
    function _days(uint256 year, uint256 month, uint256 dayOfMonth) private pure returns (uint256) {
        if (month <= 2) year -= 1;
        uint256 era = year / 400;
        uint256 yoe = year - era * 400;
        uint256 mp = month > 2 ? month - 3 : month + 9;
        uint256 doy = (153 * mp + 2) / 5 + dayOfMonth - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }
}
