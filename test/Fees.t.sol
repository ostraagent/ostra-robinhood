// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {OstraFees} from "../src/launchpad/OstraFees.sol";

/// @notice OstraFees on its own: the NYSE calendar against the holidays NYSE published for 2026 to 2028 and against
///         timestamps computed independently (Python zoneinfo, America/New_York), the volatility fee, the EMA, the MEV
///         surcharge and the packed state. The fees charged in real swaps are in Launchpad.fork.t.sol.
contract FeesTest is Test {
    OstraFees internal fees;

    /// @dev The NYSE full-day closures 2026-2028 (nyse.com/markets/hours-calendars, read 18 Oct 2026), as days since
    ///      1970-01-01.
    uint256[29] internal HOLIDAYS = [
        uint256(20454), 20472, 20500, 20546, 20598, 20623, 20637, 20703, 20783, 20812,
        20819, 20836, 20864, 20903, 20969, 20987, 21004, 21067, 21147, 21176,
        21200, 21235, 21288, 21333, 21354, 21369, 21431, 21511, 21543
    ];

    function setUp() public {
        fees = new OstraFees();
    }

    function test_theHolidayTableIsExactlyNysesList() public view {
        for (uint256 i = 0; i < HOLIDAYS.length; ++i) {
            assertTrue(fees.isNyseHoliday(HOLIDAYS[i]));
        }
        uint256 count;
        for (uint256 day = fees.HOLIDAYS_FROM_DAY() - 10; day < fees.HOLIDAYS_UNTIL_DAY() + 10; ++day) {
            if (fees.isNyseHoliday(day)) ++count;
        }
        assertEq(count, HOLIDAYS.length);
    }

    function test_daylightSavingTimeStartsAndEndsOnUsDates() public view {
        uint256[6] memory starts = [uint256(1772953200), 1793512800, 1805007600, 1825567200, 1836457200, 1857016800];
        // 2026-03-08 07:00 UTC .. 2026-11-01 06:00, 2027-03-14 .. 2027-11-07, 2028-03-12 .. 2028-11-05.
        for (uint256 i = 0; i < 6; i += 2) {
            assertFalse(fees.isUsDaylightTime(starts[i] - 1));
            assertTrue(fees.isUsDaylightTime(starts[i]));
            assertTrue(fees.isUsDaylightTime(starts[i + 1] - 1));
            assertFalse(fees.isUsDaylightTime(starts[i + 1]));
        }
    }

    function test_theMarketIsClosedFromFridayEveningToSundayEveningAndOnHolidays() public view {
        // Daylight time: Friday 16 Oct 2026 19:59 EDT open, 20:00 closed; Sunday 18 Oct 19:59 closed, 20:00 open.
        assertFalse(fees.nyseClosed(1792195140));
        assertTrue(fees.nyseClosed(1792195200));
        assertTrue(fees.nyseClosed(1792367940));
        assertFalse(fees.nyseClosed(1792368000));
        // Standard time: Friday 6 Nov 2026 19:30 EST open, 20:00 closed.
        assertFalse(fees.nyseClosed(1794011400));
        assertTrue(fees.nyseClosed(1794013200));
        // Thanksgiving, Thursday 26 Nov 2026: closed from Wednesday 20:00 EST to Thursday 20:00 EST.
        assertFalse(fees.nyseClosed(1795654740));
        assertTrue(fees.nyseClosed(1795654800));
        assertTrue(fees.nyseClosed(1795741200 - 1));
        assertFalse(fees.nyseClosed(1795741200));
        // Martin Luther King Jr. Day, Monday 18 Jan 2027: closed through the weekend to Monday 20:00 EST.
        assertTrue(fees.nyseClosed(1800320340));
        assertFalse(fees.nyseClosed(1800320400));
        // After the table: weekdays are open, holidays are no longer known (4 July 2029, a Wednesday).
        assertFalse(fees.nyseClosed(1862154000));
        assertFalse(fees.nyseClosed(1877878800));
    }

    function _q(uint256 state, int24 tick, bool zeroForOne, uint64 actor, bool stock, bool vol, uint256 time)
        internal
        view
        returns (uint24 lp, uint24 mev, uint256 next)
    {
        return fees.quote(state, tick, zeroForOne, actor, stock, vol, time);
    }

    function test_theSessionFeeAppliesOnlyToStockPoolsWhileClosed() public view {
        (uint24 lp,,) = _q(0, 0, true, 1, true, false, 1792195200); // Saturday, stock pool
        assertEq(lp, fees.CLOSED_LP_FEE());
        (lp,,) = _q(0, 0, true, 1, false, false, 1792195200); // Saturday, other pool
        assertEq(lp, fees.BASE_LP_FEE());
        (lp,,) = _q(0, 0, true, 1, true, false, 1792195140); // Friday 19:59 EDT, stock pool
        assertEq(lp, fees.BASE_LP_FEE());
    }

    function test_theVolatilityFeeFollowsTheDistanceFromTheEma() public view {
        assertEq(fees.volatilityLpFee(0, 0), 2_500);
        assertEq(fees.volatilityLpFee(150, 0), 6_250);
        assertEq(fees.volatilityLpFee(-150, 0), 6_250);
        assertEq(fees.volatilityLpFee(300, 0), 10_000);
        assertEq(fees.volatilityLpFee(5_000, 0), 10_000);
        assertEq(fees.volatilityLpFee(100, 100e6), 2_500);

        // The EMA starts at the first swap's tick; the price then held at tick 0.
        uint256 t = 1_800_000_000;
        (uint24 lp,, uint256 s) = _q(0, 0, true, 1, false, true, t);
        assertEq(lp, 2_500);
        OstraFees.FeeState memory st = fees.unpack(s);
        assertEq(st.emaTickE6, 0);
        assertEq(st.emaAt, t);
        // Tick 300 in the same second: the EMA has not moved, 300 ticks away, the full 1%.
        (lp,,) = _q(s, 300, true, 1, false, true, t);
        assertEq(lp, 10_000);
        // One half-life later the EMA is half way to 300 (exactly: whole half-lives are shifts).
        (lp,, s) = _q(s, 300, true, 1, false, true, t + 60);
        assertEq(fees.unpack(s).emaTickE6, 150e6);
        assertEq(lp, 6_250);
        // Half a half-life: weight 2^-0.5 on the old EMA, from the series.
        (,, uint256 s0) = _q(0, 0, true, 1, false, true, t);
        (lp,, s) = _q(s0, 300, true, 1, false, true, t + 30);
        assertApproxEqAbs(fees.unpack(s).emaTickE6, int64(87_867_965), 30_000);
        // After many half-lives the EMA is the price: back to the base fee.
        (lp,,) = _q(s0, 300, true, 1, false, true, t + 64 * 60);
        assertEq(lp, 2_500);
        // The larger of the session and volatility fees, never their sum, never above 1% (a Saturday, stock pool).
        uint256 sat = 1792195200;
        (,, uint256 sSat) = _q(0, 0, true, 1, true, true, sat);
        (lp,,) = _q(sSat, 120, true, 1, true, true, sat);
        assertEq(lp, 5_500);
        (lp,,) = _q(sSat, 30, true, 1, true, true, sat);
        assertEq(lp, 5_000);
        (lp,,) = _q(sSat, 900, true, 1, true, true, sat);
        assertEq(lp, 10_000);
    }

    function test_onlyTheSameActorReversingWithinTheSecondPaysTheMevSurcharge() public view {
        uint256 t = 1_800_000_000;
        uint64 bot = fees.actorOf(address(0xB0B), address(0xA11CE));
        uint64 user = fees.actorOf(address(0x05E7), address(0xA11CE));
        assertTrue(bot != user);
        assertTrue(bot != fees.actorOf(address(0xB0B), address(0xBEEF)), "another swapper is another actor");
        // The bot's front-run starts the second's window at tick 1,000.
        (, uint24 mev, uint256 s) = _q(0, 1_000, false, bot, false, false, t);
        assertEq(mev, 0);
        // A user's swap in the same direction moves the price on; it pays nothing extra and does not take the window.
        (, mev, s) = _q(s, 1_040, false, user, false, false, t);
        assertEq(mev, 0);
        // A user selling back the other way pays nothing.
        (, mev,) = _q(s, 1_100, true, user, false, false, t);
        assertEq(mev, 0);
        // The bot's back-run pays 100 pips per tick moved since its own first swap: 100 ticks, 1%.
        (, mev,) = _q(s, 1_100, true, bot, false, false, t);
        assertEq(mev, 10_000);
        // The same direction again is no reversal.
        (, mev,) = _q(s, 1_100, false, bot, false, false, t);
        assertEq(mev, 0);
        // At most 5%.
        (, mev,) = _q(s, 2_000, true, bot, false, false, t);
        assertEq(mev, 50_000);
        // The next second is a new window.
        (, mev,) = _q(s, 1_100, true, bot, false, false, t + 1);
        assertEq(mev, 0);
    }

    function test_theStatePacksIntoOneWord() public view {
        OstraFees.FeeState memory st = OstraFees.FeeState({
            emaTickE6: -887_272e6,
            emaAt: type(uint40).max,
            windowAt: 1_800_000_000,
            windowTick: -887_272,
            windowZeroForOne: true,
            windowActor: type(uint64).max
        });
        OstraFees.FeeState memory back = fees.unpack(fees.pack(st));
        assertEq(back.emaTickE6, st.emaTickE6);
        assertEq(back.emaAt, st.emaAt);
        assertEq(back.windowAt, st.windowAt);
        assertEq(back.windowTick, st.windowTick);
        assertTrue(back.windowZeroForOne);
        assertEq(back.windowActor, st.windowActor);
        assertLt(fees.pack(st), uint256(1) << 233);
    }
}
