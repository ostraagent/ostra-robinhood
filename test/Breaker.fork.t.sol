// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OstraBreaker} from "../src/OstraBreaker.sol";
import {OstraRegistry} from "../src/OstraRegistry.sol";
import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {IMorphoBlue, IMorphoOracle, MarketParams, OstraVaultModule} from "../src/OstraVaultModule.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";
import {VaultStack} from "./utils/VaultStack.sol";

/// @notice What the tests read and do on a Morpho Vault V2 and its market adapter (vault-v2, as verified on Sourcify).
interface IVaultV2Test {
    function curator() external view returns (address);
    function liquidityAdapter() external view returns (address);
    function liquidityData() external view returns (bytes memory);
    function totalAssets() external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function deposit(uint256 assets, address onBehalf) external returns (uint256);
    function redeem(uint256 shares, address receiver, address onBehalf) external returns (uint256);
}

interface IMarketAdapterTest {
    function marketIdsLength() external view returns (uint256);
    function marketIds(uint256 i) external view returns (bytes32);
    function expectedSupplyAssets(bytes32 id) external view returns (uint256);
    function timelock(bytes4 selector) external view returns (uint256);
    function abdicated(bytes4 selector) external view returns (bool);
    function submit(bytes calldata data) external;
    function burnShares(bytes32 marketId) external;
}

interface IMorphoRepay {
    function repay(MarketParams memory m, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256, uint256);
}

interface IMorphoBorrow {
    function supplyCollateral(MarketParams memory m, uint256 assets, address onBehalf, bytes memory data) external;
    function borrow(MarketParams memory m, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256, uint256);
    function withdrawCollateral(MarketParams memory m, uint256 assets, address onBehalf, address receiver) external;
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// @notice An attacker with no capital of its own: inside one transaction it flash-borrows the liquidity market's
///         collateral from Morpho Blue, borrows the market up to near full use, tries the trip, then repays all of it.
///         With a `first` vault (its own, whose limits it chose) it trips that one first, which touches only the
///         market's second, not the Vault V2's, so that a snapshot taken then would let the victim trip.
contract FlashTripper {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    OstraBreaker internal immutable BREAKER;
    address internal immutable VAULT;
    address internal immutable TARGET;
    address internal immutable FIRST;
    MarketParams internal market;
    uint256 internal want;
    bytes public tripError;
    bool public tripped;
    uint256 public useDuring;
    uint256 public payoutDuring;
    uint256 public positionDuring;
    bool public vaultTouchedBeforeFirst;
    uint8 public firstReasons;

    constructor(OstraBreaker breaker, address vault, address target, MarketParams memory m, address first) {
        BREAKER = breaker;
        VAULT = vault;
        TARGET = target;
        market = m;
        FIRST = first;
    }

    function run(uint256 collateral, uint256 borrow) external {
        want = borrow;
        IMorphoBorrow(MORPHO).flashLoan(market.collateralToken, collateral, "");
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata) external {
        require(msg.sender == MORPHO, "only Morpho");
        IERC20(market.collateralToken).approve(MORPHO, type(uint256).max);
        IMorphoBorrow(MORPHO).supplyCollateral(market, assets, address(this), "");
        (, uint256 shares) = IMorphoBorrow(MORPHO).borrow(market, want, 0, address(this), address(this));
        IMorphoBlue.Market memory mk = IMorphoBlue(MORPHO).market(keccak256(abi.encode(market)));
        useDuring = uint256(mk.totalBorrowAssets) * 10_000 / mk.totalSupplyAssets;
        OstraBreaker.State memory s = BREAKER.check(VAULT, TARGET);
        (payoutDuring, positionDuring) = (s.payout, s.position);
        vaultTouchedBeforeFirst = s.vaultTouched;
        if (FIRST != address(0)) (firstReasons,) = BREAKER.trip(FIRST, TARGET);
        try BREAKER.trip(VAULT, TARGET) {
            tripped = true;
        } catch (bytes memory e) {
            tripError = e;
        }
        IERC20(USDG).approve(MORPHO, type(uint256).max);
        IMorphoRepay(MORPHO).repay(market, 0, shares, address(this), "");
        IMorphoBorrow(MORPHO).withdrawCollateral(market, assets, address(this), address(this));
    }
}

/// @notice OstraBreaker on a fork of Robinhood Chain mainnet, against the live Steakhouse USDG (a Morpho Vault V2),
///         its MorphoMarketV1AdapterV2 and liquidity market on Morpho Blue, Morpho's factories and USDG, with a fresh
///         Ostra vault stack (version 3): the limits signed by the vault (EIP-1271), the guardian and lock it needs,
///         and a trip for each limit crossed by real actions (a borrower, a depositor leaving, the curator's
///         burnShares), never by a crossed limit that is not there.
/// forge-config: default.isolate = true
contract BreakerForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant VAULT_V2_FACTORY = 0x0FBad98595b0186dA120E41f77C102beb49f803c;
    address internal constant ADAPTER_FACTORY = 0x79370Ed003CE325C088E530d5e8655c99c2993e1;
    address internal constant STEAK_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    /// @dev Borro's USDG vault: a Vault V2 of USDG too.
    address internal constant BUSDG = 0xF8e0ab443098c0738489B5BAFFbd32A1341F2289;
    /// @dev Borro's NVDA vault: a Vault V2 of another asset.
    address internal constant BNVDA = 0x508E23274C39C60c345e35B1f0188bE180717CB9;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant AGENT = keccak256("OSTRA/EVM/TEST/breaker-agent");
    bytes32 internal constant OTHER = keccak256("OSTRA/EVM/TEST/breaker-other");
    address internal constant WITHDRAWAL = address(0xC01D);
    address internal constant SUBMITTER = address(0x5EB);
    uint32 internal constant DELAY = 36 hours;

    OstraVaultFactory internal factory;
    OstraBreaker internal breaker;
    MarketParams internal liquidityMarket;
    bytes32 internal liquidityId;
    address internal adapter;

    function setUp() public {
        vm.createSelectFork("robinhood");
        assertEq(block.chainid, 4663);
        (factory,) = VaultStack.deploy(address(new OstraRegistry()));
        breaker = new OstraBreaker(address(factory), VAULT_V2_FACTORY, MORPHO, ADAPTER_FACTORY);
        // Steakhouse USDG as these tests expect it: a market adapter serving exits from a USDG market.
        adapter = IVaultV2Test(STEAK_USDG).liquidityAdapter();
        bytes memory data = IVaultV2Test(STEAK_USDG).liquidityData();
        assertEq(data.length, 160);
        liquidityMarket = abi.decode(data, (MarketParams));
        assertEq(liquidityMarket.loanToken, USDG);
        liquidityId = keccak256(abi.encode(liquidityMarket));
        OstraBreaker.State memory s = breaker.check(address(0xdead), STEAK_USDG);
        assertTrue(s.hasLiquidityMarket, "the liquidity market is read");
        assertGt(s.payout, 0);
        assertGt(s.price, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _vault(bytes32 keychain) internal returns (OstraVault) {
        return OstraVault(factory.createVault(USDG, WotsSigner.keyRoot(WotsSigner.deriveSeed(MASTER, keychain, 0)), address(0)));
    }

    function _spend(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        uint64 n = vault.nonce();
        bytes32 next = WotsSigner.keyRoot(WotsSigner.deriveSeed(MASTER, keychain, n + 1));
        bytes memory signature =
            WotsSigner.sign(WotsSigner.deriveSeed(MASTER, keychain, n), vault.spendMessage(action, next, params));
        vm.prank(SUBMITTER, SUBMITTER);
        vault.spend(action, next, params, signature);
    }

    function _limits(uint16 price, uint16 assets, uint16 utilization, uint32 liquidity)
        internal
        pure
        returns (OstraBreaker.Limits memory)
    {
        return OstraBreaker.Limits({
            priceDropBps: price,
            assetsDropBps: assets,
            maxUtilizationBps: utilization,
            minLiquidityBps: liquidity,
            assetsMarkCap: 0
        });
    }

    /// @dev The next block, a second later: what the last transactions left is settled state.
    function _next() internal {
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
    }

    /// @dev The vault signs `limits` for STEAK_USDG (ApproveHash), with the assets mark capped at the Vault V2's total
    ///      when it signs (as the SDK signs them), and anyone sends them.
    function _configure(OstraVault v, bytes32 keychain, OstraBreaker.Limits memory limits) internal {
        if (limits.assetsDropBps != 0 && limits.assetsMarkCap == 0) {
            limits.assetsMarkCap = uint128(IVaultV2Test(STEAK_USDG).totalAssets());
        }
        bytes32 h = breaker.limitsHash(address(v), STEAK_USDG, limits, breaker.nonces(address(v), STEAK_USDG));
        _spend(v, keychain, 23, abi.encode(h, true));
        breaker.configure(address(v), STEAK_USDG, limits);
    }

    /// @dev An agent's USDG vault that lent `assets` to Steakhouse USDG, made the breaker a guardian, signed `limits`
    ///      and turned its withdrawal lock on: the order the vault requires (guardians and fresh approvals before the
    ///      lock).
    function _armed(uint256 assets, OstraBreaker.Limits memory limits) internal returns (OstraVault v, uint256 shares) {
        (v, shares) = _armedAs(AGENT, assets, limits);
        _next();
    }

    /// @dev The same for the vault of `keychain`, in this block.
    function _armedAs(bytes32 keychain, uint256 assets, OstraBreaker.Limits memory limits)
        internal
        returns (OstraVault v, uint256 shares)
    {
        v = _vault(keychain);
        deal(USDG, address(v), assets);
        _spend(v, keychain, 17, abi.encode(STEAK_USDG, assets, uint256(1)));
        shares = IERC20(STEAK_USDG).balanceOf(address(v));
        assertGt(shares, 0);
        _spend(v, keychain, 6, abi.encode(address(breaker), true));
        _configure(v, keychain, limits);
        _spend(v, keychain, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        assertTrue(v.lockActive());
    }

    /// @dev A real borrower takes the liquidity market to `bps` of its supply (and holds it: the next block sees it).
    function _borrowTo(uint256 bps) internal {
        IMorphoBlue.Market memory m = IMorphoBlue(MORPHO).market(liquidityId);
        uint256 want = uint256(m.totalSupplyAssets) * bps / 10_000 - m.totalBorrowAssets;
        uint256 price = IMorphoOracle(liquidityMarket.oracle).price();
        // Collateral worth twice the loan at the market's LLTV.
        uint256 collateral = want * 1e36 / price * 1e18 / liquidityMarket.lltv * 2;
        address borrower = address(0xB0BB);
        deal(liquidityMarket.collateralToken, borrower, collateral);
        vm.startPrank(borrower);
        IERC20(liquidityMarket.collateralToken).approve(MORPHO, collateral);
        IMorphoBorrow(MORPHO).supplyCollateral(liquidityMarket, collateral, borrower, "");
        IMorphoBorrow(MORPHO).borrow(liquidityMarket, want, 0, borrower, borrower);
        vm.stopPrank();
        m = IMorphoBlue(MORPHO).market(liquidityId);
        assertGe(uint256(m.totalBorrowAssets) * 10_000 / m.totalSupplyAssets, bps - 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Limits signed by the vault
    // ---------------------------------------------------------------------------------------------

    function test_limitsNeedTheVaultsApprovalAndWorkOnce() public {
        OstraVault v = _vault(AGENT);
        OstraBreaker.Limits memory l = _limits(10, 0, 9_900, 20_000);
        vm.expectRevert(OstraBreaker.NotSigned.selector);
        breaker.configure(address(v), STEAK_USDG, l);
        _configure(v, AGENT, l);
        assertEq(breaker.nonces(address(v), STEAK_USDG), 1);
        assertEq(breaker.nonces(address(v), BUSDG), 0, "a nonce per vault and target");
        OstraBreaker.Watch memory w = breaker.watchOf(address(v), STEAK_USDG);
        assertEq(w.limits.maxUtilizationBps, 9_900);
        assertEq(w.assetsMark, 0, "no run limit, no assets mark");
        assertGt(breaker.priceMark(STEAK_USDG), 0);
        // The same approval again: the nonce moved on.
        vm.expectRevert(OstraBreaker.NotSigned.selector);
        breaker.configure(address(v), STEAK_USDG, l);
        // Another vault's approval does not count for this one, nor for another target.
        OstraVault other = _vault(OTHER);
        bytes32 h = breaker.limitsHash(address(other), BUSDG, l, 0);
        _spend(other, OTHER, 23, abi.encode(h, true));
        vm.expectRevert(OstraBreaker.NotSigned.selector);
        breaker.configure(address(other), STEAK_USDG, l);
        breaker.configure(address(other), BUSDG, l);
        assertEq(breaker.nonces(address(other), BUSDG), 1);
        assertEq(breaker.nonces(address(other), STEAK_USDG), 0);
        // All four 0 stop watching.
        _configure(v, AGENT, _limits(0, 0, 0, 0));
        w = breaker.watchOf(address(v), STEAK_USDG);
        assertEq(w.limits.maxUtilizationBps, 0);
        assertEq(w.assetsMark, 0);
        vm.expectRevert(OstraBreaker.NotWatched.selector);
        breaker.trip(address(v), STEAK_USDG);
    }

    function test_limitsAreChecked() public {
        OstraVault v = _vault(AGENT);
        vm.expectRevert(OstraBreaker.NotOstraVault.selector);
        breaker.configure(address(this), STEAK_USDG, _limits(10, 0, 0, 0));
        vm.expectRevert(OstraBreaker.BadTarget.selector);
        breaker.configure(address(v), BNVDA, _limits(10, 0, 0, 0));
        vm.expectRevert(OstraBreaker.BadTarget.selector);
        breaker.configure(address(v), USDG, _limits(10, 0, 0, 0));
        vm.expectRevert(OstraBreaker.BadLimits.selector);
        breaker.configure(address(v), STEAK_USDG, _limits(10_000, 0, 0, 0));
        vm.expectRevert(OstraBreaker.BadLimits.selector);
        breaker.configure(address(v), STEAK_USDG, _limits(0, 10_000, 0, 0));
        vm.expectRevert(OstraBreaker.BadLimits.selector);
        breaker.configure(address(v), STEAK_USDG, _limits(0, 0, 10_001, 0));
        vm.expectRevert(OstraBreaker.BadLimits.selector);
        breaker.configure(address(v), STEAK_USDG, _limits(0, 0, 0, 1_000_001));
        // A run limit needs a signed cap on its mark.
        vm.expectRevert(OstraBreaker.BadLimits.selector);
        breaker.configure(address(v), STEAK_USDG, _limits(0, 1_000, 0, 0));
        vm.expectRevert(OstraBreaker.BadTarget.selector);
        breaker.poke(USDG);
    }

    // ---------------------------------------------------------------------------------------------
    // No trip without a crossed limit, a guardian and the lock
    // ---------------------------------------------------------------------------------------------

    function test_aHealthyVaultIsNotTripped() public {
        (OstraVault v, uint256 shares) = _armed(1_000e6, _limits(10, 1_000, 9_900, 20_000));
        OstraBreaker.State memory s = breaker.check(address(v), STEAK_USDG);
        assertEq(s.reasons, 0, "Steakhouse USDG crosses none of the limits now");
        assertEq(s.shares, shares);
        vm.expectRevert(OstraBreaker.Healthy.selector);
        breaker.trip(address(v), STEAK_USDG);
        assertEq(IERC20(STEAK_USDG).balanceOf(address(v)), shares);
    }

    function test_aTripNeedsTheBreakerAsGuardianAndTheLock() public {
        OstraVault v = _vault(AGENT);
        deal(USDG, address(v), 1_000e6);
        _spend(v, AGENT, 17, abi.encode(STEAK_USDG, uint256(1_000e6), uint256(1)));
        // A limit every market crosses: utilization at least 0.01%.
        _configure(v, AGENT, _limits(0, 0, 1, 0));
        _next();
        vm.expectRevert(OstraVault.Locked.selector);
        breaker.trip(address(v), STEAK_USDG);
        _spend(v, AGENT, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        _next();
        vm.expectRevert(OstraVault.NotGuardian.selector);
        breaker.trip(address(v), STEAK_USDG);
    }

    function test_nothingLentNothingToTrip() public {
        (OstraVault v,) = _armed(1_000e6, _limits(0, 0, 1, 0));
        _spend(v, AGENT, 18, abi.encode(STEAK_USDG, IERC20(STEAK_USDG).balanceOf(address(v)), uint256(1)));
        vm.expectRevert(OstraBreaker.NothingLent.selector);
        breaker.trip(address(v), STEAK_USDG);
    }

    // ---------------------------------------------------------------------------------------------
    // Each limit, crossed by real actions
    // ---------------------------------------------------------------------------------------------

    function test_theLiquidityMarketPast99PercentTripsAndTheValueComesBackToTheVault() public {
        (OstraVault v, uint256 shares) = _armed(1_000e6, _limits(0, 0, 9_900, 0));
        _borrowTo(9_950);
        _next();
        uint256 value = IVaultV2Test(STEAK_USDG).previewRedeem(shares);
        uint256 usdgBefore = IERC20(USDG).balanceOf(address(v));
        vm.expectEmit(true, true, true, false, address(breaker));
        emit OstraBreaker.Tripped(address(v), STEAK_USDG, 4, 0, address(this));
        (uint8 reasons, uint256 redeemed) = breaker.trip(address(v), STEAK_USDG);
        assertEq(reasons, breaker.UTILIZATION());
        assertEq(redeemed, shares, "the whole position fits what the market can pay");
        assertEq(IERC20(STEAK_USDG).balanceOf(address(v)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(v)) - usdgBefore, value, 2, "the value is back in the vault");
        assertEq(IERC20(USDG).balanceOf(WITHDRAWAL), 0);
        assertEq(IERC20(USDG).balanceOf(address(breaker)), 0);
        assertEq(v.outflowAvailable(), 1e6, "a redeem uses none of the daily limit");
    }

    function test_littleLiquidityLeftTripsAndRedeemsWhatCanBePaid() public {
        OstraBreaker.State memory s0 = breaker.check(address(0xdead), STEAK_USDG);
        // A position of about a fortieth of what can be paid out now, watched for 100 times its size.
        uint256 assets = s0.payout / 40;
        (OstraVault v, uint256 shares) = _armed(assets, _limits(0, 0, 0, 1_000_000));
        OstraBreaker.State memory s = breaker.check(address(v), STEAK_USDG);
        assertEq(s.reasons, breaker.LIQUIDITY());
        (uint8 reasons, uint256 redeemed) = breaker.trip(address(v), STEAK_USDG);
        assertEq(reasons, breaker.LIQUIDITY());
        assertEq(redeemed, shares);
        assertGe(IERC20(USDG).balanceOf(address(v)) + 2, assets);
    }

    function test_aMarketTooFullForTheWholePositionPaysWhatIsThereThenMoreOnceLiquidityReturns() public {
        OstraBreaker.State memory s0 = breaker.check(address(0xdead), STEAK_USDG);
        (OstraVault v, uint256 shares) = _armed(s0.payout / 4, _limits(0, 0, 9_900, 0));
        // The market nearly empty: less than the position can be paid out.
        _borrowTo(9_999);
        _next();
        OstraBreaker.State memory s = breaker.check(address(v), STEAK_USDG);
        assertLt(s.payout, s.position, "the market cannot pay the whole position");
        assertGt(s.payout, 0);
        (, uint256 redeemed) = breaker.trip(address(v), STEAK_USDG);
        assertLt(redeemed, shares);
        assertGt(redeemed, 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(v)), s.payout, s.payout / 1e6 + 2, "what could be paid");
        assertLe(IERC20(USDG).balanceOf(address(v)), s.payout);
        // Nothing more can be paid until someone repays or supplies.
        _next();
        vm.expectRevert(OstraBreaker.NothingPayable.selector);
        breaker.trip(address(v), STEAK_USDG);
        // The borrower repays a little: the market is still past the limit, and what came back is redeemed.
        address borrower = address(0xB0BB);
        uint256 back = s.position / 10;
        deal(USDG, borrower, back);
        vm.startPrank(borrower);
        IERC20(USDG).approve(MORPHO, back);
        IMorphoRepay(MORPHO).repay(liquidityMarket, back, 0, borrower, "");
        vm.stopPrank();
        _next();
        uint256 before = IERC20(USDG).balanceOf(address(v));
        (uint8 reasons, uint256 more) = breaker.trip(address(v), STEAK_USDG);
        assertEq(reasons, breaker.UTILIZATION());
        assertGt(more, 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(v)) - before, back, back / 1e6 + 2);
    }

    function test_aRunOnTheVaultTripsButADepositMadeToFakeOneCannot() public {
        // A depositor holds a tenth of Steakhouse USDG when the limits are signed, then leaves: a 10% drop.
        uint256 total = IVaultV2Test(STEAK_USDG).totalAssets();
        address whale = address(0xFA11);
        uint256 big = total / 8;
        deal(USDG, whale, big);
        vm.startPrank(whale);
        IERC20(USDG).approve(STEAK_USDG, big);
        IVaultV2Test(STEAK_USDG).deposit(big, whale);
        vm.stopPrank();
        (OstraVault v, uint256 shares) = _armed(1_000e6, _limits(0, 1_000, 0, 0));
        vm.expectRevert(OstraBreaker.Healthy.selector);
        breaker.trip(address(v), STEAK_USDG);
        vm.startPrank(whale);
        IVaultV2Test(STEAK_USDG).redeem(IERC20(STEAK_USDG).balanceOf(whale), whale, whale);
        vm.stopPrank();
        // In the second it left, the Vault V2 was touched: a run counts from the next block.
        vm.expectRevert(OstraBreaker.Healthy.selector);
        breaker.trip(address(v), STEAK_USDG);
        _next();
        (uint8 reasons, uint256 redeemed) = breaker.trip(address(v), STEAK_USDG);
        assertEq(reasons, breaker.ASSETS());
        assertEq(redeemed, shares);
        // The mark came down to the vault's totalAssets now: lending again does not trip at once.
        assertEq(breaker.watchOf(address(v), STEAK_USDG).assetsMark, IVaultV2Test(STEAK_USDG).totalAssets());

        // Someone else deposits a lot and leaves: the mark was set when the limits were signed, so no run shows.
        OstraVault w = _vault(OTHER);
        deal(USDG, address(w), 1_000e6);
        _spend(w, OTHER, 17, abi.encode(STEAK_USDG, uint256(1_000e6), uint256(1)));
        _spend(w, OTHER, 6, abi.encode(address(breaker), true));
        _configure(w, OTHER, _limits(0, 1_000, 0, 0));
        _spend(w, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        deal(USDG, whale, big);
        vm.startPrank(whale);
        IERC20(USDG).approve(STEAK_USDG, big);
        IVaultV2Test(STEAK_USDG).deposit(big, whale);
        breaker.poke(STEAK_USDG);
        IVaultV2Test(STEAK_USDG).redeem(IERC20(STEAK_USDG).balanceOf(whale), whale, whale);
        vm.stopPrank();
        _next();
        vm.expectRevert(OstraBreaker.Healthy.selector);
        breaker.trip(address(w), STEAK_USDG);
    }

    function test_aLossTripsOnThePrice() public {
        (OstraVault v, uint256 shares) = _armed(1_000e6, _limits(10, 0, 0, 0));
        // The curator burns the adapter's shares of its largest market other than the liquidity market, after the
        // adapter's own timelock: a loss the vault realizes, so its share price falls.
        IMarketAdapterTest a = IMarketAdapterTest(adapter);
        bytes4 burn = IMarketAdapterTest.burnShares.selector;
        assertFalse(a.abdicated(burn));
        bytes32 target;
        uint256 most;
        for (uint256 i = 0; i < a.marketIdsLength(); i++) {
            bytes32 id = a.marketIds(i);
            uint256 assets = a.expectedSupplyAssets(id);
            if (id != liquidityId && assets > most) (target, most) = (id, assets);
        }
        assertGt(most * 100, IVaultV2Test(STEAK_USDG).totalAssets(), "a market worth over 1% of the vault");
        uint256 priceBefore = breaker.check(address(v), STEAK_USDG).price;
        bytes memory call = abi.encodeCall(IMarketAdapterTest.burnShares, (target));
        vm.prank(IVaultV2Test(STEAK_USDG).curator());
        a.submit(call);
        vm.warp(block.timestamp + a.timelock(burn));
        a.burnShares(target);
        OstraBreaker.State memory s = breaker.check(address(v), STEAK_USDG);
        assertLt(s.price, priceBefore, "the share price fell");
        assertEq(s.reasons, breaker.PRICE());
        (uint8 reasons, uint256 redeemed) = breaker.trip(address(v), STEAK_USDG);
        assertEq(reasons, breaker.PRICE());
        assertEq(redeemed, shares);
        assertEq(IERC20(STEAK_USDG).balanceOf(address(v)), 0);
    }

    function test_thePriceMarkOnlyRises() public {
        breaker.poke(STEAK_USDG);
        uint256 m0 = breaker.priceMark(STEAK_USDG);
        vm.warp(block.timestamp + 1 days);
        breaker.poke(STEAK_USDG);
        uint256 m1 = breaker.priceMark(STEAK_USDG);
        assertGt(m1, m0, "a day of interest raises the mark");
        // A lower price never lowers the mark: rewind time and poke again.
        vm.warp(block.timestamp - 1 days);
        breaker.poke(STEAK_USDG);
        assertEq(breaker.priceMark(STEAK_USDG), m1);
    }

    function test_theBreakerCanOnlyRedeemIntoTheVault() public {
        (OstraVault v,) = _armed(1_000e6, _limits(0, 0, 9_900, 0));
        _borrowTo(9_950);
        _next();
        uint256 total = IERC20(USDG).balanceOf(address(v)) + IVaultV2Test(STEAK_USDG).previewRedeem(IERC20(STEAK_USDG).balanceOf(address(v)));
        vm.recordLogs();
        breaker.trip(address(v), STEAK_USDG);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 transfer = keccak256("Transfer(address,address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == USDG && logs[i].topics.length == 3 && logs[i].topics[0] == transfer) {
                address to = address(uint160(uint256(logs[i].topics[2])));
                assertTrue(to == address(v) || to == adapter || to == STEAK_USDG, "USDG moves only toward the vault");
            }
        }
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(v)), total, 2);
    }

    // ---------------------------------------------------------------------------------------------
    // What an attacker can and cannot do
    // ---------------------------------------------------------------------------------------------

    function test_aFlashLoanCannotTripOnUseOrLiquidity() public {
        // A position watched for 100 times its size, which the market can pay now but not while it is flashed full.
        (OstraVault v, uint256 shares) = _armed(100_000e6, _limits(0, 0, 9_900, 1_000_000));
        vm.expectRevert(OstraBreaker.Healthy.selector);
        breaker.trip(address(v), STEAK_USDG);
        IMorphoBlue.Market memory m = IMorphoBlue(MORPHO).market(liquidityId);
        uint256 want = uint256(m.totalSupplyAssets) * 9_950 / 10_000 - m.totalBorrowAssets;
        uint256 collateral = want * 1e36 / IMorphoOracle(liquidityMarket.oracle).price() * 1e18 / liquidityMarket.lltv * 2;
        assertGe(IERC20(liquidityMarket.collateralToken).balanceOf(MORPHO), collateral, "Morpho Blue lends that much collateral");
        FlashTripper attacker = new FlashTripper(breaker, address(v), STEAK_USDG, liquidityMarket, address(0));
        // A few units of USDG for the rounding of the repay: all the capital it has.
        deal(USDG, address(attacker), 10);
        attacker.run(collateral, want);
        assertGe(attacker.useDuring(), 9_900, "inside its transaction the market was past the limit");
        assertLt(attacker.payoutDuring() * 10_000, attacker.positionDuring() * 1_000_000, "and paid out less than the limit");
        assertFalse(attacker.tripped());
        assertEq(bytes4(attacker.tripError()), OstraBreaker.Healthy.selector, "a market touched in this second does not count");
        assertEq(IERC20(STEAK_USDG).balanceOf(address(v)), shares);
        // And the next block sees the market as it really is.
        _next();
        vm.expectRevert(OstraBreaker.Healthy.selector);
        breaker.trip(address(v), STEAK_USDG);
    }

    function test_aRealBorrowCountsFromTheNextBlock() public {
        (OstraVault v,) = _armed(1_000e6, _limits(0, 0, 9_900, 0));
        _borrowTo(9_950);
        OstraBreaker.State memory s = breaker.check(address(v), STEAK_USDG);
        assertTrue(s.marketTouched);
        assertEq(s.reasons, 0);
        vm.expectRevert(OstraBreaker.Healthy.selector);
        breaker.trip(address(v), STEAK_USDG);
        _next();
        s = breaker.check(address(v), STEAK_USDG);
        assertFalse(s.marketTouched);
        assertEq(s.reasons, breaker.UTILIZATION());
        breaker.trip(address(v), STEAK_USDG);
    }

    function test_aDepositMadeJustForTheLimitsCannotRaiseTheAssetsMark() public {
        OstraVault v = _vault(AGENT);
        deal(USDG, address(v), 1_000e6);
        _spend(v, AGENT, 17, abi.encode(STEAK_USDG, uint256(1_000e6), uint256(1)));
        _spend(v, AGENT, 6, abi.encode(address(breaker), true));
        _next();
        // The vault signs its limits with the cap at the total it reads; the approval is public once sent.
        OstraBreaker.Limits memory l = _limits(0, 500, 0, 0);
        l.assetsMarkCap = uint128(IVaultV2Test(STEAK_USDG).totalAssets());
        bytes32 h = breaker.limitsHash(address(v), STEAK_USDG, l, 0);
        _spend(v, AGENT, 23, abi.encode(h, true));
        // Someone deposits a tenth of the Vault V2, sends the limits themselves, and leaves.
        address whale = address(0xFA11);
        uint256 big = IVaultV2Test(STEAK_USDG).totalAssets() / 10;
        deal(USDG, whale, big);
        vm.startPrank(whale);
        IERC20(USDG).approve(STEAK_USDG, big);
        IVaultV2Test(STEAK_USDG).deposit(big, whale);
        breaker.configure(address(v), STEAK_USDG, l);
        IVaultV2Test(STEAK_USDG).redeem(IERC20(STEAK_USDG).balanceOf(whale), whale, whale);
        vm.stopPrank();
        assertEq(breaker.watchOf(address(v), STEAK_USDG).assetsMark, l.assetsMarkCap, "the mark is the signed cap");
        _spend(v, AGENT, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        _next();
        vm.expectRevert(OstraBreaker.Healthy.selector);
        breaker.trip(address(v), STEAK_USDG);
    }

    function test_aTripNeverRaisesTheAssetsMark() public {
        (OstraVault v,) = _armed(1_000e6, _limits(0, 2_000, 9_900, 0));
        uint256 mark = breaker.watchOf(address(v), STEAK_USDG).assetsMark;
        // Someone deposits a lot just before a real trip.
        address whale = address(0xFA11);
        uint256 big = IVaultV2Test(STEAK_USDG).totalAssets() / 10;
        deal(USDG, whale, big);
        vm.startPrank(whale);
        IERC20(USDG).approve(STEAK_USDG, big);
        IVaultV2Test(STEAK_USDG).deposit(big, whale);
        vm.stopPrank();
        _borrowTo(9_950);
        _next();
        breaker.trip(address(v), STEAK_USDG);
        assertLt(mark, IVaultV2Test(STEAK_USDG).totalAssets());
        assertEq(breaker.watchOf(address(v), STEAK_USDG).assetsMark, mark, "the mark stays where it was");
    }

    function test_underTheLockNewLimitsWaitAndTheWithdrawalAddressCanRefuseThem() public {
        (OstraVault v,) = _armed(1_000e6, _limits(0, 0, 9_900, 20_000));
        // A thief who took the key tries to stop the breaker: its approval waits the lock's delay.
        OstraBreaker.Limits memory off = _limits(0, 0, 0, 0);
        bytes32 h = breaker.limitsHash(address(v), STEAK_USDG, off, breaker.nonces(address(v), STEAK_USDG));
        _spend(v, AGENT, 23, abi.encode(h, true));
        vm.expectRevert(OstraBreaker.NotSigned.selector);
        breaker.configure(address(v), STEAK_USDG, off);
        // The owner's way out drops it before it takes effect.
        vm.prank(WITHDRAWAL);
        v.guard(1, abi.encode(h));
        vm.warp(block.timestamp + DELAY + 1);
        vm.expectRevert(OstraBreaker.NotSigned.selector);
        breaker.configure(address(v), STEAK_USDG, off);
        assertEq(breaker.watchOf(address(v), STEAK_USDG).limits.maxUtilizationBps, 9_900, "still watched");
        // An approval nobody drops works once its delay is over.
        h = breaker.limitsHash(address(v), STEAK_USDG, off, breaker.nonces(address(v), STEAK_USDG));
        _spend(v, AGENT, 23, abi.encode(h, true));
        vm.warp(block.timestamp + DELAY);
        breaker.configure(address(v), STEAK_USDG, off);
        assertEq(breaker.watchOf(address(v), STEAK_USDG).limits.maxUtilizationBps, 0);
    }

    function test_aRunDuringTheApprovalWaitIsMeasuredFromTheSigning() public {
        // A depositor holds a ninth of Steakhouse USDG when the vault, already under its lock, signs a run limit.
        address whale = address(0xFA11);
        uint256 big = IVaultV2Test(STEAK_USDG).totalAssets() / 8;
        deal(USDG, whale, big);
        vm.startPrank(whale);
        IERC20(USDG).approve(STEAK_USDG, big);
        IVaultV2Test(STEAK_USDG).deposit(big, whale);
        vm.stopPrank();
        (OstraVault v, uint256 shares) = _armed(1_000e6, _limits(0, 0, 9_900, 0));
        OstraBreaker.Limits memory l = _limits(0, 1_000, 9_900, 0);
        l.assetsMarkCap = uint128(IVaultV2Test(STEAK_USDG).totalAssets());
        bytes32 h = breaker.limitsHash(address(v), STEAK_USDG, l, breaker.nonces(address(v), STEAK_USDG));
        _spend(v, AGENT, 23, abi.encode(h, true));
        vm.expectRevert(OstraBreaker.NotSigned.selector);
        breaker.configure(address(v), STEAK_USDG, l);
        // It leaves while the approval waits the lock's delay.
        vm.startPrank(whale);
        IVaultV2Test(STEAK_USDG).redeem(IERC20(STEAK_USDG).balanceOf(whale), whale, whale);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY + 1);
        vm.roll(block.number + 1);
        breaker.configure(address(v), STEAK_USDG, l);
        assertEq(breaker.watchOf(address(v), STEAK_USDG).assetsMark, l.assetsMarkCap, "the mark is the signed total");
        _next();
        (uint8 reasons, uint256 redeemed) = breaker.trip(address(v), STEAK_USDG);
        assertEq(reasons, breaker.ASSETS(), "the run that happened during the wait shows");
        assertEq(redeemed, shares);
    }

    function test_aCrisisLetsEveryWatchingVaultOutInTheSameSecond() public {
        (OstraVault a, uint256 sharesA) = _armedAs(AGENT, 1_000e6, _limits(0, 0, 9_900, 0));
        (OstraVault b, uint256 sharesB) = _armedAs(OTHER, 2_000e6, _limits(0, 0, 9_900, 0));
        _borrowTo(9_950);
        _next();
        OstraBreaker.State memory pre = breaker.check(address(b), STEAK_USDG);
        assertFalse(pre.fromSnapshot);
        (uint8 reasons, uint256 redeemed) = breaker.trip(address(a), STEAK_USDG);
        assertEq(reasons, breaker.UTILIZATION());
        assertEq(redeemed, sharesA);
        // The first trip kept what it read before its redeem moved anything.
        OstraBreaker.Snapshot memory j = breaker.snapshotOf(STEAK_USDG);
        assertEq(j.at, block.timestamp);
        assertTrue(j.hasLiquidityMarket);
        assertEq(j.totalAssets, pre.totalAssets);
        assertEq(j.payout, pre.payout);
        assertEq(j.utilizationBps, pre.utilizationBps);
        assertLt(IVaultV2Test(STEAK_USDG).totalAssets(), pre.totalAssets, "the redeem moved the live total");
        // The first redeem touched the Vault V2 and its market in this second: the second vault is judged on what
        // the first trip read, before anything this second moved it.
        OstraBreaker.State memory s = breaker.check(address(b), STEAK_USDG);
        assertTrue(s.vaultTouched);
        assertTrue(s.fromSnapshot);
        assertEq(s.reasons, breaker.UTILIZATION());
        uint256 usdgBefore = IERC20(USDG).balanceOf(address(b));
        uint256 value = IVaultV2Test(STEAK_USDG).previewRedeem(sharesB);
        (reasons, redeemed) = breaker.trip(address(b), STEAK_USDG);
        assertEq(reasons, breaker.UTILIZATION());
        assertEq(redeemed, sharesB);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(b)) - usdgBefore, value, 2);
        // A second later the snapshot is past: live readings again.
        _next();
        assertFalse(breaker.check(address(b), STEAK_USDG).fromSnapshot);
    }

    function test_aFlashLoanCannotLeaveASnapshotThroughItsOwnVaultsTrip() public {
        (OstraVault victim, uint256 shares) = _armedAs(AGENT, 1_000e6, _limits(0, 0, 9_900, 0));
        // The attacker's own vault, signed to trip on ASSETS whenever the Vault V2 is settled.
        OstraBreaker.Limits memory l = _limits(0, 1, 0, 0);
        l.assetsMarkCap = type(uint128).max;
        (OstraVault own,) = _armedAs(OTHER, 1_000e6, l);
        _next();
        IMorphoBlue.Market memory m = IMorphoBlue(MORPHO).market(liquidityId);
        uint256 want = uint256(m.totalSupplyAssets) * 9_950 / 10_000 - m.totalBorrowAssets;
        uint256 collateral = want * 1e36 / IMorphoOracle(liquidityMarket.oracle).price() * 1e18 / liquidityMarket.lltv * 2;
        FlashTripper attacker = new FlashTripper(breaker, address(victim), STEAK_USDG, liquidityMarket, address(own));
        deal(USDG, address(attacker), 10);
        attacker.run(collateral, want);
        assertGe(attacker.useDuring(), 9_900, "the market flashed past the victim's limit");
        assertFalse(attacker.vaultTouchedBeforeFirst(), "only the market was touched when its own vault tripped");
        assertEq(attacker.firstReasons(), breaker.ASSETS(), "its own vault tripped in that second");
        // A trip in a second whose market was touched keeps nothing: the victim is judged on live readings only.
        assertEq(breaker.snapshotOf(STEAK_USDG).at, 0);
        assertFalse(attacker.tripped());
        assertEq(bytes4(attacker.tripError()), OstraBreaker.Healthy.selector);
        assertEq(IERC20(STEAK_USDG).balanceOf(address(victim)), shares);
    }
}
