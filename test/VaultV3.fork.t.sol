// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraRegistry} from "../src/OstraRegistry.sol";
import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {
    IMorphoBlue, IMorphoOracle, IVaultV2, IVaultV2Factory, MarketParams, OstraVaultModule
} from "../src/OstraVaultModule.sol";
import {OstraVaultV3} from "../src/OstraVaultV3.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";
import {VaultStack} from "./utils/VaultStack.sol";

/// @notice What the tests read of BorroBuilders and BorroRouter (github.com/Borro-Markets/contracts, commit 129f1e8).
interface IBorroBuildersView {
    function builders(bytes32 code) external view returns (address);
    function vaults(address vault) external view returns (bool);
}

interface IBorroRouterView {
    function listed(bytes32 id) external view returns (bool);
}

/// @notice OstraVault version 3 on a fork of Robinhood Chain mainnet, against the deployed Morpho Blue, Morpho's
///         VaultV2Factory, Borro's BorroBuilders, BorroRouter, vaults and markets, NVDA and USDG: the Morpho spends,
///         the withdrawal lock, the linked vault and EIP-1271.
contract VaultV3ForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant BATCH = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    /// @dev Morpho Blue, and Morpho's VaultV2Factory (BorroLib.VAULT_FACTORY), on Robinhood Chain.
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant VAULT_V2_FACTORY = 0x0FBad98595b0186dA120E41f77C102beb49f803c;
    /// @dev Borro (borro.markets/developers registry, read on chain 23 Oct 2026).
    address internal constant BORRO_BUILDERS = 0x082Ae609bdC7ccEec0C58B2361a21c49dc2aE291;
    address internal constant BORRO_ROUTER = 0x85ccddcb0588A434BD57F86A59381E40154650Ca;
    address internal constant BUSDG = 0xF8e0ab443098c0738489B5BAFFbd32A1341F2289;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant BNVDA = 0x508E23274C39C60c345e35B1f0188bE180717CB9;
    address internal constant NVDA_ORACLE = 0x62c20e5AfCFCB1A2Bbe30891aB77334C31c956d2;
    address internal constant BORRO_IRM = 0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1;
    uint256 internal constant NVDA_LLTV = 625000000000000000;
    bytes32 internal constant NVDA_MARKET_ID = 0xf3524baf7647833311fe49cfea9153664b0284574e804f5078ec7e100fb86529;
    /// @dev Steakhouse USDG: a Morpho Vault V2 that Borro does not list.
    address internal constant STEAK_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    bytes32 internal constant CODE = bytes32("ostraagent");

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant STOCK = keccak256("OSTRA/EVM/TEST/v3-stock-vault");
    bytes32 internal constant CASH = keccak256("OSTRA/EVM/TEST/v3-usdg-vault");
    bytes32 internal constant OTHER = keccak256("OSTRA/EVM/TEST/v3-other-vault");
    address internal constant WITHDRAWAL = address(0xC01D);
    address internal constant GUARDIAN = address(0x6A2D);
    uint32 internal constant DELAY = 36 hours;

    OstraVaultFactory internal factory;
    OstraVaultModule internal module;
    MarketParams internal nvdaMarket;

    function setUp() public {
        vm.createSelectFork("robinhood");
        assertEq(block.chainid, 4663);
        // Borro as this test expects it: the code registered, both vaults and the NVDA market listed.
        assertTrue(IBorroBuildersView(BORRO_BUILDERS).builders(CODE) != address(0));
        assertTrue(IBorroBuildersView(BORRO_BUILDERS).vaults(BNVDA));
        assertTrue(IBorroBuildersView(BORRO_BUILDERS).vaults(BUSDG));
        assertFalse(IBorroBuildersView(BORRO_BUILDERS).vaults(STEAK_USDG));
        assertTrue(IVaultV2Factory(VAULT_V2_FACTORY).isVaultV2(STEAK_USDG));
        nvdaMarket = MarketParams({
            loanToken: USDG, collateralToken: BNVDA, oracle: NVDA_ORACLE, irm: BORRO_IRM, lltv: NVDA_LLTV
        });
        assertEq(keccak256(abi.encode(nvdaMarket)), NVDA_MARKET_ID);
        assertTrue(IBorroRouterView(BORRO_ROUTER).listed(NVDA_MARKET_ID));

        OstraRegistry registry = new OstraRegistry();
        (factory, module) = VaultStack.deploy(address(registry));
        assertEq(address(module.FACTORY()), address(factory));
        assertEq(address(module.MORPHO()), MORPHO);
        assertEq(module.BORRO_CODE(), CODE);
        OstraVault implementation = OstraVault(UpgradeableBeacon(factory.BEACON()).implementation());
        assertEq(implementation.VERSION(), 3);
        assertEq(implementation.MODULE(), address(module));
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _seed(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keychain, index);
    }

    function _vault(bytes32 keychain, address token) internal returns (OstraVault) {
        return OstraVault(factory.createVault(token, WotsSigner.keyRoot(_seed(keychain, 0)), address(0)));
    }

    function _signed(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params)
        internal
        view
        returns (bytes32 next, bytes memory signature)
    {
        uint64 n = vault.nonce();
        next = WotsSigner.keyRoot(_seed(keychain, n + 1));
        signature = WotsSigner.sign(_seed(keychain, n), vault.spendMessage(action, next, params));
    }

    /// @dev A relayer's own account: spends are sent as its transaction's own call (msg.sender is tx.origin).
    address internal constant SUBMITTER = address(0x5EB);

    function _spend(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        (bytes32 next, bytes memory signature) = _signed(vault, keychain, action, params);
        vm.prank(SUBMITTER, SUBMITTER);
        vault.spend(action, next, params, signature);
    }

    /// @dev A spend refused with `err`: one of actions 0 to 16, 23 and 24 reverts and keeps its key; a Morpho spend
    ///      (17 to 22) lands, moves nothing and emits MorphoFailed with the error's selector.
    function _spendReverts(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params, bytes memory err)
        internal
    {
        (bytes32 next, bytes memory signature) = _signed(vault, keychain, action, params);
        uint64 n = vault.nonce();
        if (action >= 17 && action <= 22) {
            vm.expectEmit(address(vault));
            emit OstraVaultModule.MorphoFailed(action, bytes4(err));
            vm.prank(SUBMITTER, SUBMITTER);
            vault.spend(action, next, params, signature);
            assertEq(vault.nonce(), n + 1, "a failed Morpho spend lands");
        } else {
            vm.expectRevert(err);
            vault.spend(action, next, params, signature);
            assertEq(vault.nonce(), n, "a refused spend keeps its key");
        }
    }

    /// @dev A stock vault holding `nvda` NVDA and a USDG vault, linked to each other.
    function _pair(uint256 nvda) internal returns (OstraVault stock, OstraVault cash) {
        stock = _vault(STOCK, NVDA);
        cash = _vault(CASH, USDG);
        deal(NVDA, address(stock), nvda);
        assertEq(IERC20(NVDA).balanceOf(address(stock)), nvda);
        _spend(stock, STOCK, 16, abi.encode(address(cash)));
        _spend(cash, CASH, 16, abi.encode(address(stock)));
        assertEq(stock.linkedVault(), address(cash));
        assertEq(cash.linkedVault(), address(stock));
    }

    function _lendAndPost(OstraVault stock, uint256 nvda) internal returns (uint256 shares) {
        _spend(stock, STOCK, 17, abi.encode(BNVDA, nvda, uint256(1)));
        shares = IERC20(BNVDA).balanceOf(address(stock));
        assertGt(shares, 0);
        _spend(stock, STOCK, 19, abi.encode(nvdaMarket, shares));
        assertEq(IERC20(BNVDA).balanceOf(address(stock)), 0);
        assertEq(IMorphoBlue(MORPHO).position(NVDA_MARKET_ID, address(stock)).collateral, shares);
    }

    /// @dev What half of the market's LLTV allows `collateral` shares to borrow, as the module rounds it.
    function _halfLltvLimit(uint256 collateral) internal view returns (uint256) {
        uint256 value = collateral * IMorphoOracle(NVDA_ORACLE).price() / 1e36;
        return value * NVDA_LLTV * 5_000 / (1e18 * 10_000);
    }

    // ---------------------------------------------------------------------------------------------
    // Layout and module
    // ---------------------------------------------------------------------------------------------

    function test_v3StorageSitsAtItsErc7201Slot() public pure {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("ostra.vault.v3")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(OstraVaultV3.SLOT, expected);
    }

    function test_lockDelayBoundsAreTheRecoveryDelayBounds() public {
        OstraVault v = _vault(OTHER, USDG);
        assertEq(OstraVaultV3.MIN_LOCK_DELAY, v.MIN_RECOVERY_DELAY());
        assertEq(OstraVaultV3.MAX_LOCK_DELAY, v.MAX_RECOVERY_DELAY());
        assertEq(v.LIMIT_WINDOW(), 1 days);
    }

    function test_theModuleRefusesADirectCall() public {
        vm.expectRevert(OstraVaultModule.OnlyDelegated.selector);
        module.run(17, abi.encode(BNVDA, uint256(1), uint256(1)), IERC20(NVDA), false);
    }

    function test_aV3ActionWithParamsOfTheWrongLengthIsRefused() public {
        OstraVault v = _vault(OTHER, USDG);
        // The vault checks every params length itself, before the key moves: a malformed spend never lands.
        (bytes32 next, bytes memory sig) = _signed(v, OTHER, 17, abi.encode(BUSDG, uint256(1)));
        vm.expectRevert(OstraVault.BadParams.selector);
        v.spend(17, next, abi.encode(BUSDG, uint256(1)), sig);
        _spendReverts(v, OTHER, 15, abi.encode(uint256(0)), abi.encodeWithSelector(OstraVault.BadParams.selector));
        _spendReverts(v, OTHER, 25, "", abi.encodeWithSelector(OstraVault.BadAction.selector));
    }

    // ---------------------------------------------------------------------------------------------
    // Borro: lend, post, borrow, repay, withdraw, redeem
    // ---------------------------------------------------------------------------------------------

    function test_lendGoesThroughBorroBuildersWithOstrasCode() public {
        OstraVault stock = _vault(STOCK, NVDA);
        deal(NVDA, address(stock), 2e18);
        vm.expectEmit(true, true, true, false, BORRO_BUILDERS);
        emit IBorroBuildersEvents.Referred(CODE, address(stock), BNVDA, 1e18, 0);
        _spend(stock, STOCK, 17, abi.encode(BNVDA, uint256(1e18), uint256(1)));
        assertEq(IERC20(NVDA).balanceOf(address(stock)), 1e18);
        assertGt(IERC20(BNVDA).balanceOf(address(stock)), 0);
        assertEq(IERC20(NVDA).allowance(address(stock), BORRO_BUILDERS), 0);
    }

    function test_lendRefusesTooFewShares() public {
        OstraVault stock = _vault(STOCK, NVDA);
        deal(NVDA, address(stock), 1e18);
        // BorroBuilders refuses (TooFewShares): the spend lands and nothing moves.
        _spend(stock, STOCK, 17, abi.encode(BNVDA, uint256(1e18), type(uint256).max));
        assertEq(stock.nonce(), 1);
        assertEq(IERC20(NVDA).balanceOf(address(stock)), 1e18);
        assertEq(IERC20(BNVDA).balanceOf(address(stock)), 0);
    }

    function test_lendRefusesAVaultOfAnotherAssetAndANonVault() public {
        OstraVault stock = _vault(STOCK, NVDA);
        deal(NVDA, address(stock), 1e18);
        _spendReverts(
            stock, STOCK, 17, abi.encode(BUSDG, uint256(1e18), uint256(1)), abi.encodeWithSelector(OstraVaultModule.WrongToken.selector)
        );
        _spendReverts(
            stock, STOCK, 17, abi.encode(USDG, uint256(1e18), uint256(1)), abi.encodeWithSelector(OstraVaultModule.BadVault.selector)
        );
    }

    function test_borrowRepayWithdrawRedeemRoundTrip() public {
        (OstraVault stock, OstraVault cash) = _pair(1e18);
        uint256 shares = _lendAndPost(stock, 1e18);
        uint256 limit = _halfLltvLimit(shares);
        assertGt(limit, 10e6, "one NVDA backs more than 10 USDG at half the LLTV");

        // Above half the LLTV is refused, though Morpho alone would allow it.
        _spendReverts(stock, STOCK, 21, abi.encode(nvdaMarket, limit + 1e6), abi.encodeWithSelector(OstraVaultModule.LtvTooHigh.selector));
        uint256 borrowed = limit / 2;
        _spend(stock, STOCK, 21, abi.encode(nvdaMarket, borrowed));
        assertEq(IERC20(USDG).balanceOf(address(cash)), borrowed, "the loan is paid to the linked vault");
        assertEq(IERC20(USDG).balanceOf(address(stock)), 0);

        // Taking collateral out past half the LLTV is refused, though Morpho alone would allow it: the debt is a
        // quarter of what the LLTV allows, so with 40% of the collateral left it is 62.5% of it.
        _spendReverts(stock, STOCK, 20, abi.encode(nvdaMarket, shares * 6 / 10), abi.encodeWithSelector(OstraVaultModule.LtvTooHigh.selector));
        _spend(stock, STOCK, 20, abi.encode(nvdaMarket, shares / 10));
        _spend(stock, STOCK, 19, abi.encode(nvdaMarket, shares / 10));

        // The USDG vault repays the whole debt by shares, a little USDG on top for interest.
        deal(USDG, address(cash), borrowed + 1e6);
        uint256 debtShares = IMorphoBlue(MORPHO).position(NVDA_MARKET_ID, address(stock)).borrowShares;
        _spend(cash, CASH, 22, abi.encode(nvdaMarket, uint256(0), debtShares, address(stock), borrowed + 1e6));
        assertEq(IMorphoBlue(MORPHO).position(NVDA_MARKET_ID, address(stock)).borrowShares, 0);
        assertEq(IERC20(USDG).allowance(address(cash), MORPHO), 0);

        _spend(stock, STOCK, 20, abi.encode(nvdaMarket, shares));
        assertEq(IERC20(BNVDA).balanceOf(address(stock)), shares);
        _spend(stock, STOCK, 18, abi.encode(BNVDA, shares, uint256(1)));
        assertEq(IERC20(BNVDA).balanceOf(address(stock)), 0);
        assertApproxEqAbs(IERC20(NVDA).balanceOf(address(stock)), 1e18, 1e6, "the NVDA comes back");
    }

    function test_borrowNeedsALinkedVaultOfTheLoanToken() public {
        OstraVault stock = _vault(STOCK, NVDA);
        deal(NVDA, address(stock), 1e18);
        uint256 shares = _lendAndPost(stock, 1e18);
        _spendReverts(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(1e6)), abi.encodeWithSelector(OstraVaultModule.NotLinked.selector));
        OstraVault otherStock = _vault(OTHER, NVDA);
        _spend(stock, STOCK, 16, abi.encode(address(otherStock)));
        _spendReverts(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(1e6)), abi.encodeWithSelector(OstraVaultModule.WrongToken.selector));
        shares;
    }

    function test_onlyBorroListedMarketsTakeCollateralAndLend() public {
        (OstraVault stock,) = _pair(1e18);
        _spend(stock, STOCK, 17, abi.encode(BNVDA, uint256(1e18), uint256(1)));
        uint256 shares = IERC20(BNVDA).balanceOf(address(stock));
        MarketParams memory unlisted = nvdaMarket;
        unlisted.lltv = 385000000000000000;
        _spendReverts(stock, STOCK, 19, abi.encode(unlisted, shares), abi.encodeWithSelector(OstraVaultModule.BadMarket.selector));
        _spendReverts(stock, STOCK, 21, abi.encode(unlisted, uint256(1e6)), abi.encodeWithSelector(OstraVaultModule.BadMarket.selector));
    }

    function test_repayOnlyForAVaultLinkedHere() public {
        (OstraVault stock, OstraVault cash) = _pair(1e18);
        _lendAndPost(stock, 1e18);
        _spend(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(5e6)));
        OstraVault stranger = _vault(OTHER, USDG);
        deal(USDG, address(stranger), 10e6);
        _spendReverts(
            stranger, OTHER, 22, abi.encode(nvdaMarket, uint256(1e6), uint256(0), address(stock), uint256(1e6)),
            abi.encodeWithSelector(OstraVaultModule.NotLinked.selector)
        );
        _spendReverts(
            stranger, OTHER, 22, abi.encode(nvdaMarket, uint256(1e6), uint256(0), address(this), uint256(1e6)),
            abi.encodeWithSelector(OstraVaultModule.NotOstraVault.selector)
        );
        _spendReverts(
            cash, CASH, 22, abi.encode(nvdaMarket, uint256(1e6), uint256(0), address(cash), uint256(1e6)),
            abi.encodeWithSelector(OstraVaultModule.NotOstraVault.selector)
        );
    }

    function test_linkOnlyToAnotherOstraVault() public {
        OstraVault v = _vault(OTHER, USDG);
        _spendReverts(v, OTHER, 16, abi.encode(address(v)), abi.encodeWithSelector(OstraVaultModule.NotOstraVault.selector));
        _spendReverts(v, OTHER, 16, abi.encode(BUSDG), abi.encodeWithSelector(OstraVaultModule.NotOstraVault.selector));
        _spendReverts(v, OTHER, 16, abi.encode(address(0xBEEF)), abi.encodeWithSelector(OstraVaultModule.NotOstraVault.selector));
    }

    function test_usdgLendsToBorroAndToAnotherMorphoVault() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 20e6);
        _spend(cash, CASH, 17, abi.encode(BUSDG, uint256(10e6), uint256(1)));
        assertGt(IERC20(BUSDG).balanceOf(address(cash)), 0);
        _spend(cash, CASH, 17, abi.encode(STEAK_USDG, uint256(10e6), uint256(1)));
        uint256 steak = IERC20(STEAK_USDG).balanceOf(address(cash));
        assertGt(steak, 0);
        assertEq(IERC20(USDG).allowance(address(cash), STEAK_USDG), 0);
        _spend(cash, CASH, 18, abi.encode(STEAK_USDG, steak, uint256(1)));
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(cash)), 10e6, 2);
    }

    // ---------------------------------------------------------------------------------------------
    // Withdrawal lock
    // ---------------------------------------------------------------------------------------------

    function _locked(uint128 limit) internal returns (OstraVault v) {
        v = _vault(OTHER, USDG);
        deal(USDG, address(v), 100e6);
        // Guardians are set before the lock: under it they stay as they are.
        _spend(v, OTHER, 6, abi.encode(GUARDIAN, true));
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, limit));
        assertTrue(v.lockActive());
        OstraVaultV3.LockConfig memory l = v.withdrawalLock();
        assertEq(l.withdrawal, WITHDRAWAL);
        assertEq(l.delay, DELAY);
        assertEq(l.dailyLimit, limit);
    }

    function test_lockLimitsOutflowsButNotTheWithdrawalAddress() public {
        OstraVault v = _locked(10e6);
        _spend(v, OTHER, 0, abi.encode(address(0xBEEF), uint256(6e6)));
        assertEq(v.outflowAvailable(), 4e6);
        _spendReverts(
            v, OTHER, 0, abi.encode(address(0xBEEF), uint256(5e6)), abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 4e6)
        );
        _spend(v, OTHER, 0, abi.encode(WITHDRAWAL, uint256(50e6)));
        assertEq(IERC20(USDG).balanceOf(WITHDRAWAL), 50e6);
        assertEq(v.outflowAvailable(), 4e6);
        vm.warp(block.timestamp + 1 days);
        assertEq(v.outflowAvailable(), 10e6);
        _spend(v, OTHER, 0, abi.encode(address(0xBEEF), uint256(10e6)));
        assertEq(IERC20(USDG).balanceOf(address(0xBEEF)), 16e6);
    }

    function test_lockCountsLendOutsideBorroButNotInto() public {
        OstraVault v = _locked(5e6);
        _spend(v, OTHER, 17, abi.encode(BUSDG, uint256(20e6), uint256(1)));
        assertEq(v.outflowAvailable(), 5e6, "Borro's vault is the owner's own");
        _spendReverts(
            v, OTHER, 17, abi.encode(STEAK_USDG, uint256(6e6), uint256(1)), abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 5e6)
        );
        _spend(v, OTHER, 17, abi.encode(STEAK_USDG, uint256(5e6), uint256(1)));
        assertEq(v.outflowAvailable(), 0);
    }

    function test_lockedClaimDividendOnlyPaysTheWithdrawalAddressOrALockedLink() public {
        OstraVault v = _locked(5e6);
        _spendReverts(v, OTHER, 5, abi.encode(address(0xBEEF)), abi.encodeWithSelector(OstraVault.Locked.selector));
    }

    function test_looseningWaitsTheDelayAndTighteningIsAtOnce() public {
        OstraVault v = _locked(5e6);
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(50e6)));
        assertEq(v.withdrawalLock().dailyLimit, 5e6, "a higher limit waits");
        (OstraVaultV3.LockConfig memory p, uint64 at,,) = v.pendingChanges();
        assertEq(p.dailyLimit, 50e6);
        assertEq(at, block.timestamp + DELAY);
        // Tightening drops it.
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        assertEq(v.withdrawalLock().dailyLimit, 1e6);
        (, at,,) = v.pendingChanges();
        assertEq(at, 0);
        // Another withdrawal address waits, then applies.
        _spend(v, OTHER, 14, abi.encode(address(0xD00D), DELAY, uint128(1e6)));
        assertEq(v.withdrawalLock().withdrawal, WITHDRAWAL);
        vm.warp(block.timestamp + DELAY);
        assertEq(v.withdrawalLock().withdrawal, address(0xD00D));
        // Turning it off waits too.
        _spend(v, OTHER, 14, abi.encode(address(0), uint32(0), uint128(0)));
        assertTrue(v.lockActive());
        vm.warp(block.timestamp + DELAY);
        assertFalse(v.lockActive());
        _spend(v, OTHER, 0, abi.encode(address(0xBEEF), uint256(90e6)));
    }

    function test_aGuardianOrTheOwnerCancelsAWaitingChange() public {
        OstraVault v = _locked(5e6);
        _spend(v, OTHER, 14, abi.encode(address(0xD00D), DELAY, uint128(5e6)));
        vm.expectRevert(OstraVault.NotGuardian.selector);
        v.guard(0, "");
        vm.prank(GUARDIAN);
        v.guard(0, "");
        vm.warp(block.timestamp + DELAY);
        assertEq(v.withdrawalLock().withdrawal, WITHDRAWAL);
        _spend(v, OTHER, 14, abi.encode(address(0xD00D), DELAY, uint128(5e6)));
        _spend(v, OTHER, 15, "");
        vm.warp(block.timestamp + DELAY);
        assertEq(v.withdrawalLock().withdrawal, WITHDRAWAL);
    }

    function test_lockedLinkWaitsAndABorrowOnlyGoesToALockedLink() public {
        (OstraVault stock, OstraVault cash) = _pair(1e18);
        _lendAndPost(stock, 1e18);
        _spend(stock, STOCK, 14, abi.encode(WITHDRAWAL, DELAY, uint128(0)));
        _spendReverts(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(1e6)), abi.encodeWithSelector(OstraVaultModule.Locked.selector));
        // A lock the USDG vault turns on after the link does not count (it may be a thief's: turning on is at once).
        vm.warp(block.timestamp + 1);
        _spend(cash, CASH, 14, abi.encode(WITHDRAWAL, DELAY, uint128(0)));
        _spendReverts(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(1e6)), abi.encodeWithSelector(OstraVaultModule.Locked.selector));
        // Linked again under the stock vault's lock, after its delay: now the USDG vault was locked first.
        _spend(stock, STOCK, 16, abi.encode(address(cash)));
        vm.warp(block.timestamp + DELAY);
        _spend(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(1e6)));
        assertEq(IERC20(USDG).balanceOf(address(cash)), 1e6);
        // A new link under the lock waits; unlinking is at once.
        OstraVault other = _vault(OTHER, USDG);
        _spend(stock, STOCK, 16, abi.encode(address(other)));
        assertEq(stock.linkedVault(), address(cash));
        vm.warp(block.timestamp + DELAY);
        assertEq(stock.linkedVault(), address(other));
        _spend(stock, STOCK, 16, abi.encode(address(0)));
        assertEq(stock.linkedVault(), address(0));
    }

    function test_lockParamsAreChecked() public {
        OstraVault v = _vault(OTHER, USDG);
        bytes memory bad = abi.encodeWithSelector(OstraVaultModule.BadParams.selector);
        _spendReverts(v, OTHER, 14, abi.encode(WITHDRAWAL, uint32(36 hours - 1), uint128(1)), bad);
        _spendReverts(v, OTHER, 14, abi.encode(WITHDRAWAL, uint32(14 days + 1), uint128(1)), bad);
        _spendReverts(v, OTHER, 14, abi.encode(address(v), DELAY, uint128(1)), bad);
        _spendReverts(v, OTHER, 14, abi.encode(address(0), uint32(0), uint128(0)), bad);
        _spendReverts(v, OTHER, 14, abi.encode(address(0), DELAY, uint128(0)), bad);
    }

    // ---------------------------------------------------------------------------------------------
    // A thief with the seed of a locked vault (independent review, 24 Oct 2026)
    // ---------------------------------------------------------------------------------------------

    bytes32 internal constant THIEF = keccak256("OSTRA/EVM/TEST/v3-thief-stock");
    bytes32 internal constant THIEF_CASH = keccak256("OSTRA/EVM/TEST/v3-thief-usdg");
    bytes32 internal constant THIEF_KEYS = keccak256("OSTRA/EVM/TEST/v3-thief-keys");

    /// @dev A thief's own unlocked NVDA vault with a USDG debt on Borro's NVDA market, its loan paid to its own vault.
    function _thiefDebt() internal returns (OstraVault t, uint256 debtShares) {
        t = _vault(THIEF, NVDA);
        OstraVault t2 = _vault(THIEF_CASH, USDG);
        deal(NVDA, address(t), 1e18);
        _spend(t, THIEF, 17, abi.encode(BNVDA, uint256(1e18), uint256(1)));
        uint256 shares = IERC20(BNVDA).balanceOf(address(t));
        _spend(t, THIEF, 19, abi.encode(nvdaMarket, shares));
        _spend(t, THIEF, 16, abi.encode(address(t2)));
        _spend(t, THIEF, 21, abi.encode(nvdaMarket, _halfLltvLimit(shares) / 2));
        debtShares = IMorphoBlue(MORPHO).position(NVDA_MARKET_ID, address(t)).borrowShares;
    }

    function test_aLockedVaultCannotRepayAStrangersDebtPastItsLimit() public {
        OstraVault v = _locked(1e6);
        (OstraVault t, uint256 debtShares) = _thiefDebt();
        // The thief points its own vault's link at the victim: Repay is then allowed, but it is no longer free.
        _spend(t, THIEF, 16, abi.encode(address(v)));
        bytes memory params = abi.encode(nvdaMarket, uint256(0), debtShares, address(t), uint256(100e6));
        _spendReverts(v, OTHER, 22, params, abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 1e6));
        assertEq(IERC20(USDG).balanceOf(address(v)), 100e6);
    }

    function test_aLockedVaultsRepayOfAnUnlockedLinkCounts() public {
        // The owner's USDG vault is locked and linked both ways with the owner's stock vault, which is not locked: a
        // seed thief borrows from the stock vault to himself, links it back, and has the USDG vault repay.
        (OstraVault stock, OstraVault cash) = _pair(1e18);
        _lendAndPost(stock, 1e18);
        deal(USDG, address(cash), 100e6);
        _spend(cash, CASH, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        OstraVault t2 = _vault(THIEF_CASH, USDG);
        _spend(stock, STOCK, 16, abi.encode(address(t2)));
        _spend(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(5e6)));
        _spend(stock, STOCK, 16, abi.encode(address(cash)));
        uint256 debtShares = IMorphoBlue(MORPHO).position(NVDA_MARKET_ID, address(stock)).borrowShares;
        bytes memory params = abi.encode(nvdaMarket, uint256(0), debtShares, address(stock), uint256(10e6));
        _spendReverts(cash, CASH, 22, params, abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 1e6));
        // Locking the stock vault now does not make it the owner's own (a thief can lock it to himself at once).
        vm.warp(block.timestamp + 1);
        _spend(stock, STOCK, 14, abi.encode(address(0xBAD), DELAY, uint128(type(uint128).max)));
        _spendReverts(cash, CASH, 22, params, abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 1e6));
        // Linked again under the USDG vault's lock, after its delay: the stock vault was locked first, so it counts
        // as the owner's own, and the repay is free.
        _spend(cash, CASH, 16, abi.encode(address(stock)));
        vm.warp(block.timestamp + DELAY);
        deal(USDG, address(cash), 100e6);
        _spend(cash, CASH, 22, params);
        assertEq(IMorphoBlue(MORPHO).position(NVDA_MARKET_ID, address(stock)).borrowShares, 0);
        assertEq(cash.outflowAvailable(), 1e6);
    }

    function test_aLinkedVaultLockedAfterTheLinkReceivesNoLoan() public {
        // The stock vault is locked with a limit of 0; its USDG vault is not. A seed thief locks the USDG vault to
        // himself (at once) and borrows into it: refused.
        (OstraVault stock, OstraVault cash) = _pair(1e18);
        _lendAndPost(stock, 1e18);
        _spend(stock, STOCK, 14, abi.encode(WITHDRAWAL, DELAY, uint128(0)));
        vm.warp(block.timestamp + 1);
        _spend(cash, CASH, 14, abi.encode(address(0xBAD), DELAY, uint128(0)));
        assertTrue(cash.lockActive());
        assertEq(cash.lockedSince(), block.timestamp);
        _spendReverts(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(1e6)), abi.encodeWithSelector(OstraVaultModule.Locked.selector));
    }

    function test_aWithdrawalVaultMustHoldThisVaultsToken() public {
        OstraVault v = _vault(OTHER, USDG);
        OstraVault nvdaVault = _vault(STOCK, NVDA);
        OstraVault usdgVault = _vault(CASH, USDG);
        _spendReverts(v, OTHER, 14, abi.encode(address(nvdaVault), DELAY, uint128(0)), abi.encodeWithSelector(OstraVaultModule.WrongToken.selector));
        _spend(v, OTHER, 14, abi.encode(address(usdgVault), DELAY, uint128(0)));
        assertEq(v.withdrawalLock().withdrawal, address(usdgVault));
    }

    function test_aLowerLimitThanWhatIsUsedRefusesCleanly() public {
        OstraVault v = _locked(10e6);
        _spend(v, OTHER, 0, abi.encode(address(0xBEEF), uint256(8e6)));
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(5e6)));
        assertEq(v.outflowAvailable(), 0);
        _spendReverts(v, OTHER, 0, abi.encode(address(0xBEEF), uint256(1)), abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 0));
    }

    function test_aRecoveryDropsEveryHashApproval() public {
        OstraVault v = _vault(OTHER, USDG);
        _spend(v, OTHER, 6, abi.encode(GUARDIAN, true));
        _spend(v, OTHER, 7, abi.encode(uint8(1), DELAY));
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        bytes32 h = keccak256("approved by the key holder");
        _spend(v, OTHER, 23, abi.encode(h, true));
        vm.warp(block.timestamp + DELAY);
        assertEq(v.isValidSignature(h, ""), bytes4(0x1626ba7e));
        vm.prank(GUARDIAN);
        v.supportRecovery(WotsSigner.keyRoot(_seed(STOCK, 0)));
        assertEq(v.isValidSignature(h, ""), bytes4(0xffffffff));
        assertEq(v.hashValidFrom(h), 0);
    }

    function test_aLinkedVaultLockedWhileTheLinkWaitsIsNotALockedLink() public {
        (OstraVault stock, OstraVault cash) = _pair(1e18);
        _lendAndPost(stock, 1e18);
        _spend(stock, STOCK, 16, abi.encode(address(0)));
        _spend(stock, STOCK, 14, abi.encode(WITHDRAWAL, DELAY, uint128(0)));
        _spend(stock, STOCK, 16, abi.encode(address(cash)));
        // The USDG vault is locked (to the thief) while the link waits, and when it takes effect.
        vm.warp(block.timestamp + DELAY);
        _spend(cash, CASH, 14, abi.encode(address(0xBAD), DELAY, uint128(0)));
        assertEq(stock.linkedVault(), address(cash));
        _spendReverts(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(1e6)), abi.encodeWithSelector(OstraVaultModule.Locked.selector));
        assertEq(IERC20(USDG).balanceOf(address(cash)), 0);
    }

    function test_aFullRepayGoesThroughAfterSomeoneRepaidALittle() public {
        (OstraVault stock, OstraVault cash) = _pair(1e18);
        _lendAndPost(stock, 1e18);
        _spend(stock, STOCK, 21, abi.encode(nvdaMarket, uint256(5e6)));
        uint256 debtShares = IMorphoBlue(MORPHO).position(NVDA_MARKET_ID, address(stock)).borrowShares;
        bytes memory params = abi.encode(nvdaMarket, uint256(0), debtShares, address(stock), uint256(10e6));
        (bytes32 next, bytes memory sig) = _signed(cash, CASH, 22, params);
        // Someone repays one share of the debt for the stock vault, on Morpho directly.
        deal(USDG, address(this), 1e6);
        IERC20(USDG).approve(MORPHO, 1e6);
        IMorphoBlue(MORPHO).repay(nvdaMarket, 0, 1, address(stock), "");
        cash.spend(22, next, params, sig);
        assertEq(IMorphoBlue(MORPHO).position(NVDA_MARKET_ID, address(stock)).borrowShares, 0);
    }

    /// @dev Whether the last recorded logs hold `topic0` from `emitter`.
    function _logged(address emitter, bytes32 topic0) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == topic0) return true;
        }
        return false;
    }

    function test_noGasLimitMakesAValidMorphoOrGuardSpendLandAsFailed() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 10e6);
        bytes memory params = abi.encode(BUSDG, uint256(1e6), uint256(1));
        (bytes32 next, bytes memory sig) = _signed(cash, CASH, 17, params);
        uint256 landed;
        for (uint256 g = 150_000; g <= 2_600_000; g += 20_000) {
            uint256 snap = vm.snapshotState();
            vm.recordLogs();
            vm.prank(SUBMITTER, SUBMITTER);
            try cash.spend{gas: g}(17, next, params, sig) {
                ++landed;
                assertFalse(_logged(address(cash), OstraVaultModule.MorphoFailed.selector), "a valid Lend never lands as failed");
                assertGt(IERC20(BUSDG).balanceOf(address(cash)), 0);
            } catch {}
            vm.revertToState(snap);
        }
        assertGt(landed, 0);

        OstraVault g2 = _vault(GUARD_VAULT, USDG);
        OstraVault v = _vault(OTHER, USDG);
        deal(USDG, address(v), 10e6);
        _spend(v, OTHER, 6, abi.encode(address(g2), true));
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        params = abi.encode(address(v), uint8(2), bytes32(uint256(uint160(WITHDRAWAL))), uint256(0));
        (next, sig) = _signed(g2, GUARD_VAULT, 24, params);
        landed = 0;
        for (uint256 g = 120_000; g <= 1_000_000; g += 10_000) {
            uint256 snap = vm.snapshotState();
            vm.recordLogs();
            vm.prank(SUBMITTER, SUBMITTER);
            try g2.spend{gas: g}(24, next, params, sig) {
                ++landed;
                assertEq(IERC20(USDG).balanceOf(WITHDRAWAL), 10e6, "a valid Guard sweep that lands sweeps");
            } catch {}
            vm.revertToState(snap);
        }
        assertGt(landed, 0);
    }

    function test_aTransferToAnUnlockedWithdrawalVaultCounts() public {
        // The withdrawal address is a vault (it may share the stolen seed): only free once it is locked first.
        OstraVault w = _vault(CASH, USDG);
        OstraVault v = _vault(OTHER, USDG);
        deal(USDG, address(v), 100e6);
        _spend(v, OTHER, 14, abi.encode(address(w), DELAY, uint128(1e6)));
        _spendReverts(v, OTHER, 0, abi.encode(address(w), uint256(50e6)), abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 1e6));
        // Locked after it was chosen: still counts.
        vm.warp(block.timestamp + 1);
        _spend(w, CASH, 14, abi.encode(WITHDRAWAL, DELAY, uint128(0)));
        _spendReverts(v, OTHER, 0, abi.encode(address(w), uint256(50e6)), abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 1e6));
        // Chosen again (it waits the delay) while locked: now free.
        _spend(v, OTHER, 14, abi.encode(address(0x1234), DELAY, uint128(1e6)));
        vm.warp(block.timestamp + DELAY);
        _spend(v, OTHER, 14, abi.encode(address(w), DELAY, uint128(1e6)));
        vm.warp(block.timestamp + DELAY);
        assertEq(v.withdrawalLock().withdrawal, address(w));
        _spend(v, OTHER, 0, abi.encode(address(w), uint256(50e6)));
        assertEq(IERC20(USDG).balanceOf(address(w)), 50e6);
    }

    function test_theWithdrawalAddressBringsLentValueBackAndSweepsIt() public {
        (OstraVault stock,) = _pair(1e18);
        _spend(stock, STOCK, 14, abi.encode(WITHDRAWAL, DELAY, uint128(0)));
        // The key holder lends everything to Borro (free) and posts half as collateral.
        _spend(stock, STOCK, 17, abi.encode(BNVDA, uint256(1e18), uint256(1)));
        uint256 shares = IERC20(BNVDA).balanceOf(address(stock));
        _spend(stock, STOCK, 19, abi.encode(nvdaMarket, shares / 2));
        vm.startPrank(WITHDRAWAL);
        vm.expectRevert(OstraVault.ZeroAmount.selector);
        stock.guard(2, abi.encode(WITHDRAWAL));
        stock.guard(4, abi.encode(NVDA_MARKET_ID, shares / 2));
        stock.guard(3, abi.encode(BNVDA, shares));
        stock.guard(2, abi.encode(WITHDRAWAL));
        vm.stopPrank();
        assertApproxEqAbs(IERC20(NVDA).balanceOf(WITHDRAWAL), 1e18, 1e6);
        vm.prank(address(0xBAD));
        vm.expectRevert(OstraVault.NotGuardian.selector);
        stock.guard(2, abi.encode(WITHDRAWAL));
    }

    function test_aSupportRecoveryTheOtherVaultRefusesLands() public {
        OstraVault g = _vault(GUARD_VAULT, USDG);
        OstraVault v = _vault(OTHER, USDG);
        // v never made g a guardian: the support is refused, and g's spend lands.
        uint64 n = g.nonce();
        vm.expectEmit(address(g));
        emit OstraVaultModule.Guarded(address(v), 255, false, OstraVault.NotGuardian.selector);
        _spend(g, GUARD_VAULT, 8, abi.encode(address(v), keccak256("root")));
        assertEq(g.nonce(), n + 1);
    }

    function test_aRevokeOfAnApprovalAlreadyGoneLands() public {
        OstraVault v = _locked(1e6);
        bytes32 h = keccak256("approved");
        _spend(v, OTHER, 23, abi.encode(h, true));
        vm.prank(GUARDIAN);
        v.guard(1, abi.encode(h));
        uint64 n = v.nonce();
        _spend(v, OTHER, 23, abi.encode(h, false));
        assertEq(v.nonce(), n + 1);
    }

    function test_aFailedSpendSentFromInsideAnotherCallRevertsAndKeepsItsKey() public {
        OstraVault g = _vault(GUARD_VAULT, USDG);
        OstraVault v = _vault(OTHER, USDG);
        bytes memory guardParams = abi.encode(address(v), uint8(0), bytes32(0), uint256(0));
        (bytes32 next, bytes memory sig) = _signed(g, GUARD_VAULT, 24, guardParams);
        // Sent by a contract (this test), not as a transaction's own call: v refuses (its lock is off), and the
        // spend reverts with v's refusal instead of landing.
        vm.expectRevert(OstraVault.Locked.selector);
        g.spend(24, next, guardParams, sig);
        assertEq(g.nonce(), 0);
        OstraVault cash = _vault(CASH, USDG);
        bytes memory lend = abi.encode(BUSDG, uint256(1e6), uint256(1));
        (next, sig) = _signed(cash, CASH, 17, lend);
        vm.expectRevert();
        cash.spend(17, next, lend, sig);
        assertEq(cash.nonce(), 0);
        // Sent on its own, the same signed spends land.
        vm.prank(SUBMITTER, SUBMITTER);
        cash.spend(17, next, lend, sig);
        assertEq(cash.nonce(), 1);
    }

    function test_aSweepOnlyGoesToAWithdrawalThatKeepsIt() public {
        OstraVault w = _vault(CASH, USDG);
        OstraVault v = _vault(OTHER, USDG);
        deal(USDG, address(v), 10e6);
        _spend(v, OTHER, 6, abi.encode(GUARDIAN, true));
        _spend(v, OTHER, 14, abi.encode(address(w), DELAY, uint128(1e6)));
        vm.prank(GUARDIAN);
        vm.expectRevert(OstraVault.Locked.selector);
        v.guard(2, abi.encode(address(w)));
        vm.prank(address(w));
        vm.expectRevert(OstraVault.Locked.selector);
        v.guard(2, abi.encode(address(w)));
    }

    function test_aGuardSpendLandsWhenTheOtherVaultRefuses() public {
        OstraVault g = _vault(GUARD_VAULT, USDG);
        OstraVault v = _vault(OTHER, USDG);
        deal(USDG, address(v), 10e6);
        _spend(v, OTHER, 6, abi.encode(address(g), true));
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        uint64 n = g.nonce();
        vm.expectEmit(address(g));
        emit OstraVaultModule.Guarded(address(v), 2, false, OstraVault.BadParams.selector);
        _spend(g, GUARD_VAULT, 24, abi.encode(address(v), uint8(2), bytes32(uint256(uint160(address(0xBAD)))), uint256(0)));
        assertEq(g.nonce(), n + 1, "the key moves on");
        assertEq(IERC20(USDG).balanceOf(address(v)), 10e6);
    }

    /// @dev Signs with the thief's own key chain from the vault's current nonce on: the first such spend is signed by
    ///      the stolen key (OTHER) and hands the vault to the thief's chain.
    function _thiefSpend(OstraVault v, uint8 action, bytes memory params, bool first) internal {
        uint64 n = v.nonce();
        bytes32 signing = first ? _seed(OTHER, n) : _seed(THIEF_KEYS, n);
        bytes32 next = WotsSigner.keyRoot(_seed(THIEF_KEYS, n + 1));
        v.spend(action, next, params, WotsSigner.sign(signing, v.spendMessage(action, next, params)));
    }

    function _thiefSpendReverts(OstraVault v, uint8 action, bytes memory params, bytes4 err) internal {
        uint64 n = v.nonce();
        bytes32 next = WotsSigner.keyRoot(_seed(THIEF_KEYS, n + 1));
        bytes memory sig = WotsSigner.sign(_seed(THIEF_KEYS, n), v.spendMessage(action, next, params));
        vm.expectRevert(err);
        v.spend(action, next, params, sig);
    }

    function test_aThiefWhoTakesTheKeyCannotEndTheGuardiansWayOut() public {
        OstraVault v = _vault(OTHER, USDG);
        deal(USDG, address(v), 100e6);
        _spend(v, OTHER, 6, abi.encode(GUARDIAN, true));
        _spend(v, OTHER, 7, abi.encode(uint8(1), DELAY));
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));

        // The thief's first spend moves the key to his own chain: the owner's seed signs nothing any more.
        _thiefSpend(v, 0, abi.encode(address(0xBAD), uint256(1e6)), true);
        // Under the lock he cannot take the guardians or the policy away, nor change the crank or a pool.
        _thiefSpendReverts(v, 6, abi.encode(GUARDIAN, false), OstraVault.Locked.selector);
        _thiefSpendReverts(v, 7, abi.encode(uint8(0), uint32(0)), OstraVault.Locked.selector);
        _thiefSpendReverts(v, 2, abi.encode(address(0xBAD)), OstraVault.Locked.selector);
        _thiefSpendReverts(v, 4, abi.encode(address(0xBAD), bytes32(0), uint8(0), uint256(0)), OstraVault.Locked.selector);
        // He schedules himself as the withdrawal address; the guardian cancels it, and sweeps the balance out.
        _thiefSpend(v, 14, abi.encode(address(0xBAD), DELAY, uint128(1e6)), false);
        vm.prank(GUARDIAN);
        v.guard(0, "");
        vm.prank(GUARDIAN);
        v.guard(2, abi.encode(WITHDRAWAL));
        assertEq(IERC20(USDG).balanceOf(WITHDRAWAL), 99e6);
        assertEq(IERC20(USDG).balanceOf(address(v)), 0);

        // The guardian recovers the vault to the owner's new seed; the thief's spends no longer stop it.
        bytes32 newRoot = WotsSigner.keyRoot(_seed(STOCK, 0));
        vm.prank(GUARDIAN);
        v.supportRecovery(newRoot);
        deal(USDG, address(v), 1e6);
        _thiefSpend(v, 0, abi.encode(WITHDRAWAL, uint256(1e6)), false);
        vm.warp(block.timestamp + DELAY);
        v.finishRecovery();
        assertEq(v.keyRoot(), newRoot);
        assertEq(v.withdrawalLock().withdrawal, WITHDRAWAL);
    }

    function test_theWithdrawalAddressCancelsAndSweepsWithoutGuardians() public {
        OstraVault v = _vault(OTHER, USDG);
        deal(USDG, address(v), 100e6);
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        assertEq(v.guardianCount(), 0);
        _thiefSpend(v, 14, abi.encode(address(0xBAD), DELAY, uint128(1e6)), true);
        vm.prank(address(0xBAD));
        vm.expectRevert(OstraVault.NotGuardian.selector);
        v.guard(2, abi.encode(WITHDRAWAL));
        vm.startPrank(WITHDRAWAL);
        v.guard(0, "");
        v.guard(2, abi.encode(WITHDRAWAL));
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(WITHDRAWAL), 100e6);
        vm.warp(block.timestamp + DELAY);
        assertEq(v.withdrawalLock().withdrawal, WITHDRAWAL);
    }

    function test_sweepNeedsTheLock() public {
        OstraVault v = _vault(OTHER, USDG);
        deal(USDG, address(v), 1e6);
        _spend(v, OTHER, 6, abi.encode(GUARDIAN, true));
        vm.prank(GUARDIAN);
        vm.expectRevert(OstraVault.Locked.selector);
        v.guard(2, abi.encode(WITHDRAWAL));
    }

    function test_turningTheLockOnDropsEarlierApprovals() public {
        OstraVault v = _vault(OTHER, USDG);
        bytes32 h = keccak256("approved before the lock");
        _spend(v, OTHER, 23, abi.encode(h, true));
        assertEq(v.isValidSignature(h, ""), bytes4(0x1626ba7e));
        vm.warp(block.timestamp + 1);
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        assertEq(v.isValidSignature(h, ""), bytes4(0xffffffff));
    }

    bytes32 internal constant GUARD_VAULT = keccak256("OSTRA/EVM/TEST/v3-guardian-vault");

    function test_aGuardianVaultCancelsAndSweepsThroughGuard() public {
        OstraVault g = _vault(GUARD_VAULT, USDG);
        OstraVault w = _vault(CASH, USDG);
        OstraVault v = _vault(OTHER, USDG);
        deal(USDG, address(v), 100e6);
        // The withdrawal vault keeps what it gets: it is locked before it is chosen.
        _spend(w, CASH, 14, abi.encode(WITHDRAWAL, DELAY, uint128(0)));
        _spend(v, OTHER, 6, abi.encode(address(g), true));
        _spend(v, OTHER, 14, abi.encode(address(w), DELAY, uint128(1e6)));
        _thiefSpend(v, 14, abi.encode(address(0xBAD), DELAY, uint128(1e6)), true);
        _spend(g, GUARD_VAULT, 24, abi.encode(address(v), uint8(0), bytes32(0), uint256(0)));
        (, uint64 at,,) = v.pendingChanges();
        assertEq(at, 0);
        _spend(g, GUARD_VAULT, 24, abi.encode(address(v), uint8(2), bytes32(uint256(uint160(address(w)))), uint256(0)));
        assertEq(IERC20(USDG).balanceOf(address(w)), 100e6);
        // Only on an Ostra vault, and only with a known operation.
        _spendReverts(g, GUARD_VAULT, 24, abi.encode(address(this), uint8(0), bytes32(0), uint256(0)), abi.encodeWithSelector(OstraVaultModule.NotOstraVault.selector));
        _spendReverts(g, GUARD_VAULT, 24, abi.encode(address(v), uint8(9), bytes32(0), uint256(0)), abi.encodeWithSelector(OstraVaultModule.BadParams.selector));
    }

    function test_aRecoveryUnderWayDropsWaitingChangesAndFreezesNewOnes() public {
        OstraVault v = _vault(OTHER, USDG);
        deal(USDG, address(v), 100e6);
        _spend(v, OTHER, 6, abi.encode(GUARDIAN, true));
        _spend(v, OTHER, 7, abi.encode(uint8(1), DELAY));
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        _thiefSpend(v, 14, abi.encode(address(0), uint32(0), uint128(0)), true);
        bytes32 newRoot = WotsSigner.keyRoot(_seed(STOCK, 0));
        vm.prank(GUARDIAN);
        v.supportRecovery(newRoot);
        (, uint64 at,,) = v.pendingChanges();
        assertEq(at, 0, "the lock-off the thief scheduled is dropped");
        _thiefSpendReverts(v, 14, abi.encode(address(0), uint32(0), uint128(0)), OstraVaultModule.Locked.selector);
        _thiefSpendReverts(v, 16, abi.encode(address(_vault(CASH, USDG))), OstraVaultModule.Locked.selector);
        _thiefSpendReverts(v, 23, abi.encode(keccak256("permit"), true), OstraVaultModule.Locked.selector);
        // Tightening still works, and the recovery goes through.
        _thiefSpend(v, 14, abi.encode(WITHDRAWAL, DELAY, uint128(0)), false);
        vm.warp(block.timestamp + DELAY);
        v.finishRecovery();
        assertEq(v.keyRoot(), newRoot);
        assertTrue(v.lockActive());
    }

    function test_aCancelOrSweepAfterAChangeTookEffectIsRefused() public {
        OstraVault v = _locked(1e6);
        _thiefSpend(v, 14, abi.encode(address(0xBAD), DELAY, uint128(1e6)), true);
        vm.warp(block.timestamp + DELAY);
        vm.startPrank(GUARDIAN);
        vm.expectRevert(OstraVault.BadParams.selector);
        v.guard(0, "");
        vm.expectRevert(OstraVault.BadParams.selector);
        v.guard(2, abi.encode(WITHDRAWAL));
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(address(v)), 100e6);
    }

    function test_guardianPowersNeedTheLock() public {
        OstraVault v = _vault(OTHER, USDG);
        _spend(v, OTHER, 6, abi.encode(GUARDIAN, true));
        bytes32 h = keccak256("owner's message");
        _spend(v, OTHER, 23, abi.encode(h, true));
        vm.startPrank(GUARDIAN);
        vm.expectRevert(OstraVault.Locked.selector);
        v.guard(1, abi.encode(h));
        vm.expectRevert(OstraVault.Locked.selector);
        v.guard(0, "");
        vm.stopPrank();
        assertEq(v.isValidSignature(h, ""), bytes4(0x1626ba7e));
    }

    function test_theDailyLimitRefillsOverADay() public {
        OstraVault v = _locked(10e6);
        _spend(v, OTHER, 0, abi.encode(address(0xBEEF), uint256(10e6)));
        assertEq(v.outflowAvailable(), 0);
        vm.warp(block.timestamp + 12 hours);
        assertEq(v.outflowAvailable(), 5e6);
        _spend(v, OTHER, 0, abi.encode(address(0xBEEF), uint256(5e6)));
        _spendReverts(v, OTHER, 0, abi.encode(address(0xBEEF), uint256(1)), abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 0));
        vm.warp(block.timestamp + 2 days);
        assertEq(v.outflowAvailable(), 10e6);
    }

    function test_aRecoveryFinishedByTheNewSeedExpiresEarlierSupports() public {
        OstraVault v = _vault(OTHER, USDG);
        address g1 = address(0x6A21);
        address g2 = address(0x6A22);
        address g3 = address(0x6A23);
        _spend(v, OTHER, 6, abi.encode(g1, true));
        _spend(v, OTHER, 6, abi.encode(g2, true));
        _spend(v, OTHER, 6, abi.encode(g3, true));
        _spend(v, OTHER, 7, abi.encode(uint8(2), DELAY));
        _spend(v, OTHER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        bytes32 stale = keccak256("a root nobody holds");
        vm.prank(g3);
        v.supportRecovery(stale);
        bytes32 newRoot = WotsSigner.keyRoot(_seed(STOCK, 0));
        vm.prank(g1);
        v.supportRecovery(newRoot);
        vm.prank(g2);
        v.supportRecovery(newRoot);
        vm.warp(block.timestamp + DELAY);
        // Under the lock the new seed's key does not sign first (a key holder's spend could land before it and
        // move the nonce): its spend is refused, and finishRecovery comes first.
        uint64 n = v.nonce();
        bytes32 next = WotsSigner.keyRoot(_seed(STOCK, 1));
        bytes memory sig = WotsSigner.sign(_seed(STOCK, 0), v.spendMessage(15, next, ""));
        vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
        v.spend(15, next, "", sig);
        v.finishRecovery();
        assertEq(v.keyRoot(), newRoot);
        assertEq(v.nonce(), n);
        // The same signed message (the nonce did not move) now lands: the key signed once.
        v.spend(15, next, "", sig);
        assertEq(v.keyRoot(), next);
        // g3's old support no longer counts: one more support does not start a recovery to the stale root.
        vm.prank(g2);
        v.supportRecovery(stale);
        (, uint64 executableAt,) = v.pendingRecovery();
        assertEq(executableAt, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // EIP-1271
    // ---------------------------------------------------------------------------------------------

    function test_approvedHashesSignForTheVault() public {
        OstraVault v = _vault(OTHER, USDG);
        bytes32 h = keccak256("a message");
        assertEq(v.isValidSignature(h, ""), bytes4(0xffffffff));
        _spend(v, OTHER, 23, abi.encode(h, true));
        assertEq(v.isValidSignature(h, ""), bytes4(0x1626ba7e));
        assertEq(v.isValidSignature(keccak256("another"), ""), bytes4(0xffffffff));
        _spend(v, OTHER, 23, abi.encode(h, false));
        assertEq(v.isValidSignature(h, ""), bytes4(0xffffffff));
    }

    function test_underTheLockAnApprovalWaitsAndAGuardianRevokesIt() public {
        OstraVault v = _locked(5e6);
        bytes32 h = keccak256("a permit");
        _spend(v, OTHER, 23, abi.encode(h, true));
        assertEq(v.isValidSignature(h, ""), bytes4(0xffffffff));
        assertEq(v.hashValidFrom(h), block.timestamp + DELAY);
        vm.warp(block.timestamp + DELAY);
        assertEq(v.isValidSignature(h, ""), bytes4(0x1626ba7e));
        vm.prank(GUARDIAN);
        v.guard(1, abi.encode(h));
        assertEq(v.isValidSignature(h, ""), bytes4(0xffffffff));
    }
}

/// @notice BorroBuilders' Referred event, as it emits it.
interface IBorroBuildersEvents {
    event Referred(bytes32 indexed code, address indexed who, address indexed vault, uint256 assets, uint256 shares);
}
