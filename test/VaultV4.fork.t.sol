// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraRegistry} from "../src/OstraRegistry.sol";
import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraVaultModule} from "../src/OstraVaultModule.sol";
import {
    IERC4626Venue, IRaetoStockVault, IRaetoVault, OstraVaultModuleV4
} from "../src/OstraVaultModuleV4.sol";
import {OstraVaultV3} from "../src/OstraVaultV3.sol";
import {OstraVaultV4} from "../src/OstraVaultV4.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";
import {VaultStack} from "./utils/VaultStack.sol";

/// @notice What the tests call on the venues as their owners (RaetoVault, RaetoStockVault; Sourcify sources).
interface IRaetoOwned {
    function owner() external view returns (address);
    function queueSource(address newSource) external;
    function cancelSource() external;
    function setParams(uint256 minLtv, uint256 targetLtv, uint256 maxLtv, uint256 maxUtilization) external;
    function minLtv() external view returns (uint256);
    function targetLtv() external view returns (uint256);
    function maxUtilization() external view returns (uint256);
    function oracle() external view returns (address);
    function earned(address user) external view returns (uint256);
    function totalPrincipal() external view returns (uint256);
    function accrue() external;
    function liquidationOwed(address user) external view returns (uint256);
    function marketParams() external view returns (MarketParamsLite memory);
    function collateral() external view returns (uint256);
    function debt() external view returns (uint256);
    function keeper() external view returns (address);
    function rebalance() external;
}

struct MarketParamsLite {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorphoLiquidate {
    function liquidate(
        MarketParamsLite memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes memory data
    ) external returns (uint256, uint256);
}

interface IOraclePrice {
    function price() external view returns (uint256);
}

/// @notice A plain ERC-4626 vault of USDG with no implementation to name (OpenZeppelin's ERC4626, unchanged).
contract PlainVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("Plain USDG", "pUSDG") ERC4626(asset_) {}
}

/// @notice OstraVault version 4 on a fork of Robinhood Chain mainnet, against the deployed venues: Spark Savings USDG
///         (ERC4626), Raeto's USDG vault (RAETO_USDG) and NVDA vault (RAETO_STOCK), with USDG, NVDA, Morpho Blue and
///         Steakhouse as they are. Only the price crash that forces a Morpho liquidation is simulated (the NVDA
///         oracle's answer); every other contract runs its own deployed code.
contract VaultV4ForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant SPARK = 0xde770c84FE66E063336b31737cFE9790f18c4087;
    address internal constant RAETO_USDG = 0x6f9c9BD7F89D230Ec2ee34037e09b27848e4bd6B;
    address internal constant RAETO_NVDA = 0xC9Bb4DdBb6E32C1C361A60840318798091Ec5082;
    address internal constant STEAK_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    uint8 internal constant K_RAETO_USDG = 1;
    uint8 internal constant K_RAETO_STOCK = 2;
    uint8 internal constant K_ERC4626 = 3;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant CASH = keccak256("OSTRA/EVM/TEST/v4-usdg-vault");
    bytes32 internal constant STOCK = keccak256("OSTRA/EVM/TEST/v4-stock-vault");
    bytes32 internal constant GUARD_VAULT = keccak256("OSTRA/EVM/TEST/v4-guard-vault");
    address internal constant WITHDRAWAL = address(0xC01D);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant SUBMITTER = address(0x5EB);
    uint32 internal constant DELAY = 36 hours;

    OstraVaultFactory internal factory;
    OstraVaultModuleV4 internal m4;

    function setUp() public {
        vm.createSelectFork("robinhood");
        assertEq(block.chainid, 4663);
        // The venues as this test expects them.
        assertEq(IERC4626Venue(SPARK).asset(), USDG);
        assertEq(IRaetoVault(RAETO_USDG).asset(), USDG);
        assertEq(IRaetoVault(RAETO_USDG).SOURCE_DELAY(), 2 days);
        assertEq(IRaetoVault(RAETO_USDG).queuedSourceEta(), 0);
        assertEq(IRaetoStockVault(RAETO_NVDA).stock(), NVDA);
        OstraRegistry registry = new OstraRegistry();
        (factory,) = VaultStack.deploy(address(registry));
        OstraVault implementation = OstraVault(UpgradeableBeacon(factory.BEACON()).implementation());
        assertEq(implementation.VERSION(), 4);
        m4 = OstraVaultModuleV4(implementation.MODULE_V4());
        assertEq(address(m4.FACTORY()), address(factory));
        assertEq(m4.IDENTITY_REGISTRY(), IDENTITY_REGISTRY);
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

    function _spend(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        (bytes32 next, bytes memory signature) = _signed(vault, keychain, action, params);
        vm.prank(SUBMITTER, SUBMITTER);
        vault.spend(action, next, params, signature);
    }

    /// @dev A spend refused with `err`: Enter and Exit land, move nothing and emit VenueFailed with the error's
    ///      selector; the others revert and keep their key.
    function _refused(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params, bytes memory err) internal {
        (bytes32 next, bytes memory signature) = _signed(vault, keychain, action, params);
        uint64 n = vault.nonce();
        if (action == 26 || action == 27) {
            vm.expectEmit(address(vault));
            emit OstraVaultV4.VenueFailed(action, bytes4(err));
            vm.prank(SUBMITTER, SUBMITTER);
            vault.spend(action, next, params, signature);
            assertEq(vault.nonce(), n + 1, "a failed Enter or Exit lands");
        } else {
            vm.expectRevert(err);
            vm.prank(SUBMITTER, SUBMITTER);
            vault.spend(action, next, params, signature);
            assertEq(vault.nonce(), n, "a refused spend keeps its key");
        }
    }

    function _enable(OstraVault vault, bytes32 keychain, uint8 kind, address venue) internal {
        _spend(vault, keychain, 25, abi.encode(kind, venue, true));
    }

    function _enter(OstraVault vault, bytes32 keychain, uint8 kind, address venue, uint256 amount) internal {
        _spend(vault, keychain, 26, abi.encode(kind, venue, amount, uint256(0)));
    }

    function _exit(OstraVault vault, bytes32 keychain, uint8 kind, address venue, uint256 amount) internal {
        _spend(vault, keychain, 27, abi.encode(kind, venue, amount, uint256(0)));
    }

    function _sparkAssets(address who) internal view returns (uint256) {
        return IERC4626Venue(SPARK).convertToAssets(IERC4626Venue(SPARK).balanceOf(who));
    }

    function _logged(address emitter, bytes32 topic) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == topic) return true;
        }
        return false;
    }

    function _lock(OstraVault vault, bytes32 keychain, uint128 limit) internal {
        _spend(vault, keychain, 6, abi.encode(GUARDIAN, true));
        _spend(vault, keychain, 14, abi.encode(WITHDRAWAL, DELAY, limit));
    }

    // ---------------------------------------------------------------------------------------------
    // Layout, module and params
    // ---------------------------------------------------------------------------------------------

    function test_v4StorageSitsAtItsErc7201Slot() public pure {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("ostra.vault.v4")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(OstraVaultV4.SLOT, expected);
    }

    function test_theModuleRefusesADirectCall() public {
        vm.expectRevert(OstraVaultModuleV4.OnlyDelegated.selector);
        m4.run(25, abi.encode(uint8(3), SPARK, true), IERC20(USDG), false);
        vm.expectRevert(OstraVaultModuleV4.OnlyDelegated.selector);
        m4.runVenue(26, abi.encode(uint8(3), SPARK, uint256(1), uint256(0)), IERC20(USDG));
        vm.expectRevert(OstraVaultModuleV4.OnlyDelegated.selector);
        m4.guard(5, abi.encode(uint8(3), SPARK, uint256(0)), IERC20(USDG));
        vm.expectRevert(OstraVaultModuleV4.OnlyDelegated.selector);
        m4.trip(3, SPARK, 0, IERC20(USDG));
    }

    function test_aV4ActionWithParamsOfTheWrongLengthIsRefused() public {
        OstraVault v = _vault(CASH, USDG);
        bytes[4] memory wrong = [
            abi.encode(uint8(3), SPARK),
            abi.encode(uint8(3), SPARK, uint256(1)),
            abi.encode(uint8(3), SPARK, uint256(1)),
            abi.encode(USDG)
        ];
        for (uint8 i = 0; i < 4; ++i) {
            (bytes32 n, bytes memory g) = _signed(v, CASH, 25 + i, wrong[i]);
            vm.expectRevert(OstraVault.BadParams.selector);
            vm.prank(SUBMITTER, SUBMITTER);
            v.spend(25 + i, n, wrong[i], g);
        }
        (bytes32 next, bytes memory sig) = _signed(v, CASH, 29, "");
        vm.expectRevert(OstraVault.BadAction.selector);
        v.spend(29, next, "", sig);
        assertEq(v.nonce(), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // SetVenue
    // ---------------------------------------------------------------------------------------------

    function test_setVenueChecksTheVenueForItsKind() public {
        OstraVault cash = _vault(CASH, USDG);
        OstraVault stock = _vault(STOCK, NVDA);
        // Not the vault's token, not a venue of that kind, a Morpho Vault V2, no code, the token itself.
        _refused(stock, STOCK, 25, abi.encode(K_ERC4626, SPARK, true), abi.encodeWithSelector(OstraVaultModuleV4.WrongToken.selector));
        _refused(stock, STOCK, 25, abi.encode(K_RAETO_USDG, RAETO_USDG, true), abi.encodeWithSelector(OstraVaultModuleV4.WrongToken.selector));
        _refused(cash, CASH, 25, abi.encode(K_RAETO_STOCK, RAETO_NVDA, true), abi.encodeWithSelector(OstraVaultModuleV4.WrongToken.selector));
        _refused(cash, CASH, 25, abi.encode(K_ERC4626, STEAK_USDG, true), abi.encodeWithSelector(OstraVaultModuleV4.BadVenue.selector));
        _refused(cash, CASH, 25, abi.encode(K_ERC4626, address(0xDEAD), true), abi.encodeWithSelector(OstraVaultModuleV4.BadVenue.selector));
        _refused(cash, CASH, 25, abi.encode(K_ERC4626, USDG, true), abi.encodeWithSelector(OstraVaultModuleV4.BadVenue.selector));
        _refused(cash, CASH, 25, abi.encode(uint8(4), SPARK, true), abi.encodeWithSelector(OstraVaultModuleV4.BadParams.selector));
        _refused(cash, CASH, 25, abi.encode(uint8(0), SPARK, true), abi.encodeWithSelector(OstraVaultModuleV4.BadParams.selector));
        // A RAETO_USDG venue with a source delay under 2 days: Spark answers asset() but not SOURCE_DELAY().
        _refused(cash, CASH, 25, abi.encode(K_RAETO_USDG, SPARK, true), "");
        // Disabling a venue never enabled.
        _refused(cash, CASH, 25, abi.encode(K_ERC4626, SPARK, false), abi.encodeWithSelector(OstraVaultModuleV4.BadParams.selector));

        // Unlocked, an enable is in force at once, and pins what it read.
        _enable(cash, CASH, K_ERC4626, SPARK);
        (bool enabled, bool entered, bool inForce, uint64 from) = cash.venueOf(K_ERC4626, SPARK);
        assertTrue(enabled);
        assertFalse(entered);
        assertTrue(inForce);
        assertEq(from, block.timestamp);
        // Enabling a venue in force again is refused; disabling is at once.
        _refused(cash, CASH, 25, abi.encode(K_ERC4626, SPARK, true), abi.encodeWithSelector(OstraVaultModuleV4.BadParams.selector));
        _spend(cash, CASH, 25, abi.encode(K_ERC4626, SPARK, false));
        (enabled,, inForce,) = cash.venueOf(K_ERC4626, SPARK);
        assertFalse(enabled);
        assertFalse(inForce);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enable(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA);
        (,, inForce,) = stock.venueOf(K_RAETO_STOCK, RAETO_NVDA);
        assertTrue(inForce);
    }

    // ---------------------------------------------------------------------------------------------
    // Enter and Exit, per kind
    // ---------------------------------------------------------------------------------------------

    function test_sparkRoundTrip() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 1_000e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        vm.expectEmit(address(cash));
        emit OstraVaultV4.Entered(K_ERC4626, SPARK, 600e6, 600e6 - 1);
        _enter(cash, CASH, K_ERC4626, SPARK, 600e6);
        assertEq(IERC20(USDG).balanceOf(address(cash)), 400e6);
        assertApproxEqAbs(_sparkAssets(address(cash)), 600e6, 2);
        assertEq(IERC20(USDG).allowance(address(cash), SPARK), 0);
        (, bool entered,,) = cash.venueOf(K_ERC4626, SPARK);
        assertTrue(entered);
        // A month later the shares are worth more; all of them come back into the vault.
        vm.warp(block.timestamp + 30 days);
        uint256 worth = _sparkAssets(address(cash));
        assertGt(worth, 600e6);
        _exit(cash, CASH, K_ERC4626, SPARK, IERC4626Venue(SPARK).balanceOf(address(cash)));
        assertEq(IERC4626Venue(SPARK).balanceOf(address(cash)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(cash)), 400e6 + worth, 1);
    }

    /// @dev Isolated: Steakhouse (a Morpho Vault V2) accrues interest once per transaction, and a test is one
    ///      transaction unless each call is its own.
    /// forge-config: default.isolate = true
    function test_raetoUsdgRoundTripEarnsCredits() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 500e6);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enter(cash, CASH, K_RAETO_USDG, RAETO_USDG, 300e6);
        uint256 principal = IRaetoVault(RAETO_USDG).principalOf(address(cash));
        assertApproxEqAbs(principal, 300e6, 10);
        assertEq(IERC20(USDG).balanceOf(address(cash)), 200e6);
        assertEq(IERC20(USDG).allowance(address(cash), RAETO_USDG), 0);
        // The interest becomes credits in the Raeto account of the vault's address; the principal stays its own.
        vm.warp(block.timestamp + 30 days);
        IRaetoOwned(RAETO_USDG).accrue();
        assertGt(IRaetoOwned(RAETO_USDG).earned(address(cash)), 0);
        _exit(cash, CASH, K_RAETO_USDG, RAETO_USDG, principal);
        assertEq(IRaetoVault(RAETO_USDG).principalOf(address(cash)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(cash)), 200e6 + principal, 10);
    }

    function test_raetoStockRoundTrip() public {
        OstraVault stock = _vault(STOCK, NVDA);
        deal(NVDA, address(stock), 2e18);
        _enable(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA);
        _enter(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA, 1e18);
        assertApproxEqAbs(IRaetoStockVault(RAETO_NVDA).stockOf(address(stock)), 1e18, 10);
        assertEq(IERC20(NVDA).balanceOf(address(stock)), 1e18);
        uint256 shares = IRaetoStockVault(RAETO_NVDA).sharesOf(address(stock));
        _exit(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA, shares);
        assertEq(IRaetoStockVault(RAETO_NVDA).sharesOf(address(stock)), 0);
        assertApproxEqAbs(IERC20(NVDA).balanceOf(address(stock)), 2e18, 10);
    }

    function test_enterNeedsAVenueInForceAndItsMinimum() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        bytes memory enter = abi.encode(K_ERC4626, SPARK, uint256(10e6), uint256(0));
        _refused(cash, CASH, 26, enter, abi.encodeWithSelector(OstraVaultModuleV4.NotEnabled.selector));
        _enable(cash, CASH, K_ERC4626, SPARK);
        _refused(cash, CASH, 26, abi.encode(K_ERC4626, SPARK, uint256(10e6), uint256(10e6 + 1)),
            abi.encodeWithSelector(OstraVaultModuleV4.InsufficientOutput.selector));
        _refused(cash, CASH, 26, abi.encode(K_ERC4626, SPARK, uint256(0), uint256(0)),
            abi.encodeWithSelector(OstraVaultModuleV4.ZeroAmount.selector));
        assertEq(IERC20(USDG).balanceOf(address(cash)), 100e6, "a failed Enter moves nothing");
        // Exit of a venue never entered nor enabled.
        _refused(cash, CASH, 27, abi.encode(K_RAETO_USDG, RAETO_USDG, uint256(1), uint256(0)),
            abi.encodeWithSelector(OstraVaultModuleV4.NotEnabled.selector));
        // A disabled venue takes no Enter, but its position still comes out.
        _enter(cash, CASH, K_ERC4626, SPARK, 10e6);
        _spend(cash, CASH, 25, abi.encode(K_ERC4626, SPARK, false));
        _refused(cash, CASH, 26, enter, abi.encodeWithSelector(OstraVaultModuleV4.NotEnabled.selector));
        _exit(cash, CASH, K_ERC4626, SPARK, IERC4626Venue(SPARK).balanceOf(address(cash)));
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(cash)), 100e6, 2);
    }

    function test_anExitBelowItsMinimumLandsAndMovesNothing() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enter(cash, CASH, K_ERC4626, SPARK, 50e6);
        uint256 shares = IERC4626Venue(SPARK).balanceOf(address(cash));
        _refused(cash, CASH, 27, abi.encode(K_ERC4626, SPARK, shares, uint256(51e6)),
            abi.encodeWithSelector(OstraVaultModuleV4.InsufficientOutput.selector));
        assertEq(IERC4626Venue(SPARK).balanceOf(address(cash)), shares);
    }

    // ---------------------------------------------------------------------------------------------
    // Under the withdrawal lock
    // ---------------------------------------------------------------------------------------------

    function test_underTheLockAnEnableWaitsAndAGuardianOrTheOwnerDropsIt() public {
        OstraVault cash = _vault(CASH, USDG);
        _lock(cash, CASH, 10e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        (bool enabled,, bool inForce, uint64 from) = cash.venueOf(K_ERC4626, SPARK);
        assertTrue(enabled);
        assertFalse(inForce);
        assertEq(from, block.timestamp + DELAY);
        // A guardian drops it (guard op 0, nothing else waiting): it never takes effect.
        vm.prank(GUARDIAN);
        cash.guard(0, "");
        vm.warp(block.timestamp + DELAY);
        (,, inForce,) = cash.venueOf(K_ERC4626, SPARK);
        assertFalse(inForce);
        vm.prank(GUARDIAN);
        vm.expectRevert(OstraVaultModuleV4.BadParams.selector);
        cash.guard(0, "");
        // Enabled again, then dropped by the owner's CancelPendingChanges.
        _enable(cash, CASH, K_ERC4626, SPARK);
        _spend(cash, CASH, 15, "");
        vm.warp(block.timestamp + DELAY);
        (,, inForce,) = cash.venueOf(K_ERC4626, SPARK);
        assertFalse(inForce);
        // Enabled again and left alone: in force after the delay, and a later cancel does not touch it.
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enable(cash, CASH, K_ERC4626, SPARK);
        vm.warp(block.timestamp + DELAY);
        (,, inForce,) = cash.venueOf(K_ERC4626, SPARK);
        assertTrue(inForce);
        _spend(cash, CASH, 15, "");
        (,, inForce,) = cash.venueOf(K_ERC4626, SPARK);
        assertTrue(inForce);
        (,, inForce,) = cash.venueOf(K_RAETO_USDG, RAETO_USDG);
        assertTrue(inForce);
    }

    function test_aRecoveryDropsAWaitingEnableAndFreezesNewOnes() public {
        OstraVault cash = _vault(CASH, USDG);
        _spend(cash, CASH, 6, abi.encode(GUARDIAN, true));
        _spend(cash, CASH, 7, abi.encode(uint8(1), uint32(36 hours)));
        _spend(cash, CASH, 14, abi.encode(WITHDRAWAL, DELAY, uint128(10e6)));
        _enable(cash, CASH, K_ERC4626, SPARK);
        vm.prank(GUARDIAN);
        cash.supportRecovery(keccak256("new root"));
        vm.warp(block.timestamp + DELAY);
        (,, bool inForce,) = cash.venueOf(K_ERC4626, SPARK);
        assertFalse(inForce, "a recovery drops a waiting enable");
        _refused(cash, CASH, 25, abi.encode(K_ERC4626, SPARK, true), abi.encodeWithSelector(OstraVaultModuleV4.Locked.selector));
    }

    function test_underTheLockARaetoEnterCountsAndASparkEnterDoesNot() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _lock(cash, CASH, 5e6);
        _enter(cash, CASH, K_ERC4626, SPARK, 50e6);
        assertEq(cash.outflowAvailable(), 5e6);
        _refused(cash, CASH, 26, abi.encode(K_RAETO_USDG, RAETO_USDG, uint256(6e6), uint256(0)),
            abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, uint256(5e6)));
        _enter(cash, CASH, K_RAETO_USDG, RAETO_USDG, 4e6);
        assertEq(cash.outflowAvailable(), 1e6);
        // Exits are free, and strict: what comes back is at least what the position fell by.
        _exit(cash, CASH, K_ERC4626, SPARK, IERC4626Venue(SPARK).balanceOf(address(cash)));
        _exit(cash, CASH, K_RAETO_USDG, RAETO_USDG, IRaetoVault(RAETO_USDG).principalOf(address(cash)));
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(cash)), 100e6, 12);
    }

    function test_underTheLockAnExitThatRealizesALossIsRefused() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enter(cash, CASH, K_RAETO_USDG, RAETO_USDG, 50e6);
        _lock(cash, CASH, 5e6);
        uint256 principal = IRaetoVault(RAETO_USDG).principalOf(address(cash));
        _inLossRaetoUsdg();
        bytes memory exit = abi.encode(K_RAETO_USDG, RAETO_USDG, principal, uint256(0));
        _refused(cash, CASH, 27, exit, abi.encodeWithSelector(OstraVaultModuleV4.InsufficientOutput.selector));
        assertEq(IRaetoVault(RAETO_USDG).principalOf(address(cash)), principal);
        // Guard op 5 refuses a venue in loss outright.
        vm.prank(GUARDIAN);
        vm.expectRevert(OstraVaultModuleV4.InLoss.selector);
        cash.guard(5, abi.encode(K_RAETO_USDG, RAETO_USDG, uint256(0)));
    }

    function test_withoutTheLockTheOwnerMayTakeALossOnPurpose() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enter(cash, CASH, K_RAETO_USDG, RAETO_USDG, 50e6);
        uint256 principal = IRaetoVault(RAETO_USDG).principalOf(address(cash));
        _inLossRaetoUsdg();
        _exit(cash, CASH, K_RAETO_USDG, RAETO_USDG, principal);
        assertEq(IRaetoVault(RAETO_USDG).principalOf(address(cash)), 0);
        assertLt(IERC20(USDG).balanceOf(address(cash)), 100e6);
    }

    /// @dev Puts Raeto's USDG vault in loss: its totalPrincipal (storage slot 8, read 31 Oct 2026) raised above its
    ///      assets, as a loss in its source would leave it.
    function _inLossRaetoUsdg() internal {
        uint256 tp = uint256(vm.load(RAETO_USDG, bytes32(uint256(8))));
        assertEq(tp, IRaetoOwned(RAETO_USDG).totalPrincipal(), "slot 8 is totalPrincipal");
        vm.store(RAETO_USDG, bytes32(uint256(8)), bytes32(tp + tp / 10));
        assertTrue(IRaetoVault(RAETO_USDG).inLoss());
    }

    // ---------------------------------------------------------------------------------------------
    // Guard op 5 and the breaker
    // ---------------------------------------------------------------------------------------------

    function test_aGuardianBringsEveryPositionHome() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enter(cash, CASH, K_ERC4626, SPARK, 40e6);
        _enter(cash, CASH, K_RAETO_USDG, RAETO_USDG, 40e6);
        // Guard op 5 needs the lock.
        vm.prank(GUARDIAN);
        vm.expectRevert(OstraVault.Locked.selector);
        cash.guard(5, abi.encode(K_ERC4626, SPARK, uint256(0)));
        _lock(cash, CASH, 1e6);
        vm.startPrank(GUARDIAN);
        cash.guard(5, abi.encode(K_ERC4626, SPARK, uint256(0)));
        cash.guard(5, abi.encode(K_RAETO_USDG, RAETO_USDG, uint256(0)));
        cash.guard(2, abi.encode(WITHDRAWAL));
        vm.stopPrank();
        assertEq(IERC4626Venue(SPARK).balanceOf(address(cash)), 0);
        assertEq(IRaetoVault(RAETO_USDG).principalOf(address(cash)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(WITHDRAWAL), 100e6, 12);
    }

    function test_aGuardianVaultBringsAPositionHomeThroughGuard() public {
        OstraVault cash = _vault(CASH, USDG);
        OstraVault g = _vault(GUARD_VAULT, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enter(cash, CASH, K_ERC4626, SPARK, 40e6);
        _spend(cash, CASH, 6, abi.encode(address(g), true));
        _spend(cash, CASH, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        bytes32 arg = bytes32(uint256(K_ERC4626) << 160 | uint256(uint160(SPARK)));
        vm.recordLogs();
        _spend(g, GUARD_VAULT, 24, abi.encode(address(cash), uint8(5), arg, uint256(0)));
        assertTrue(_logged(address(g), OstraVaultModule.Guarded.selector));
        assertEq(IERC4626Venue(SPARK).balanceOf(address(cash)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(cash)), 100e6, 2);
        // Refused by the other vault (nothing there now): the spend lands all the same.
        uint64 n = g.nonce();
        _spend(g, GUARD_VAULT, 24, abi.encode(address(cash), uint8(5), arg, uint256(0)));
        assertEq(g.nonce(), n + 1);
        // A dirty arg is refused and keeps the key.
        _refused(g, GUARD_VAULT, 24, abi.encode(address(cash), uint8(5), bytes32(uint256(1) << 200), uint256(0)),
            abi.encodeWithSelector(OstraVaultModuleV4.BadParams.selector));
    }

    function test_theBreakerBringsARaetoPositionHomeWhenASourceIsQueued() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enter(cash, CASH, K_RAETO_USDG, RAETO_USDG, 60e6);
        vm.expectRevert(OstraVaultModuleV4.Healthy.selector);
        cash.tripVenue(K_RAETO_USDG, RAETO_USDG, 0);
        // Raeto's owner queues a new source (Spark, a USDG ERC-4626): two days before it can apply.
        vm.prank(IRaetoOwned(RAETO_USDG).owner());
        IRaetoOwned(RAETO_USDG).queueSource(SPARK);
        // A new Enter is refused meanwhile, and anyone (no lock needed) brings the position home.
        _refused(cash, CASH, 26, abi.encode(K_RAETO_USDG, RAETO_USDG, uint256(1e6), uint256(0)),
            abi.encodeWithSelector(OstraVaultModuleV4.VenueChanged.selector, uint8(4)));
        vm.recordLogs();
        vm.prank(address(0xBAD));
        cash.tripVenue(K_RAETO_USDG, RAETO_USDG, 0);
        assertTrue(_logged(address(cash), OstraVaultV4.VenueTripped.selector));
        assertEq(IRaetoVault(RAETO_USDG).principalOf(address(cash)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(cash)), 100e6, 10);
    }

    function test_theBreakerBringsASparkPositionHomeWhenItsImplementationChanges() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enter(cash, CASH, K_ERC4626, SPARK, 60e6);
        // Spark's admin upgrades it: here the same code at a new address, which is all the breaker looks at.
        address impl = address(uint160(uint256(vm.load(SPARK, IMPLEMENTATION_SLOT))));
        address copy = address(0x5BA4C0DE);
        vm.etch(copy, impl.code);
        vm.store(SPARK, IMPLEMENTATION_SLOT, bytes32(uint256(uint160(copy))));
        _refused(cash, CASH, 26, abi.encode(K_ERC4626, SPARK, uint256(1e6), uint256(0)),
            abi.encodeWithSelector(OstraVaultModuleV4.VenueChanged.selector, uint8(2)));
        vm.prank(address(0xBAD));
        cash.tripVenue(K_ERC4626, SPARK, 0);
        assertEq(IERC4626Venue(SPARK).balanceOf(address(cash)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(cash)), 100e6, 2);
    }

    function test_theBreakerBringsAStockPositionHomeAboveItsMaxLtv() public {
        OstraVault stock = _vault(STOCK, NVDA);
        deal(NVDA, address(stock), 1e18);
        _enable(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA);
        _enter(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA, 1e18);
        // Raeto's owner lowers the max LTV under the vault's LTV now (as a fall of the stock would leave it).
        IRaetoOwned r = IRaetoOwned(RAETO_NVDA);
        uint256 ltv = IRaetoStockVault(RAETO_NVDA).ltv();
        (address owner, uint256 maxUtilization) = (r.owner(), r.maxUtilization());
        vm.expectRevert(OstraVaultModuleV4.Healthy.selector);
        stock.tripVenue(K_RAETO_STOCK, RAETO_NVDA, 0);
        vm.expectRevert(OstraVaultModuleV4.NotEnabled.selector);
        stock.tripVenue(K_RAETO_STOCK, address(0xDEAD), 0);
        vm.prank(owner);
        r.setParams(ltv / 2 - 1, ltv / 2, ltv - 1, maxUtilization);
        // A market move, not a change of the venue: the breaker deleverages Raeto's loan and the position stays.
        uint256 shares = IRaetoStockVault(RAETO_NVDA).sharesOf(address(stock));
        vm.prank(address(0xBAD));
        stock.tripVenue(K_RAETO_STOCK, RAETO_NVDA, 0);
        assertEq(IRaetoStockVault(RAETO_NVDA).sharesOf(address(stock)), shares);
        assertLe(IRaetoStockVault(RAETO_NVDA).ltv(), IRaetoStockVault(RAETO_NVDA).maxLtv());
        vm.expectRevert(OstraVaultModuleV4.Healthy.selector);
        stock.tripVenue(K_RAETO_STOCK, RAETO_NVDA, 0);
    }

    function test_anExpiredSourceQueueStopsCounting() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enter(cash, CASH, K_RAETO_USDG, RAETO_USDG, 10e6);
        vm.prank(IRaetoOwned(RAETO_USDG).owner());
        IRaetoOwned(RAETO_USDG).queueSource(SPARK);
        // Raeto never executed it: past its eta and grace (2 + 7 days) it can no longer apply.
        vm.warp(block.timestamp + 9 days + 1);
        vm.expectRevert(OstraVaultModuleV4.Healthy.selector);
        cash.tripVenue(K_RAETO_USDG, RAETO_USDG, 0);
        _enter(cash, CASH, K_RAETO_USDG, RAETO_USDG, 10e6);
    }

    function test_aLiquidationsUsdgIsClaimedAndForwardedToTheLinkedVault() public {
        OstraVault stock = _vault(STOCK, NVDA);
        OstraVault cash = _vault(CASH, USDG);
        deal(NVDA, address(stock), 5e18);
        _enable(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA);
        _enter(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA, 5e18);
        // Raeto's keeper borrows against the new stock as far as its market lets it, as it does on chain.
        IRaetoOwned r = IRaetoOwned(RAETO_NVDA);
        vm.prank(r.keeper());
        r.rebalance();
        uint256 ltv = IRaetoStockVault(RAETO_NVDA).ltv();
        assertGt(ltv, 0);
        // A crash of NVDA's price (the one simulated input), to 90% of where the loan reaches the market's LLTV,
        // lets anyone liquidate Raeto's loan on Morpho.
        MarketParamsLite memory mp = r.marketParams();
        uint256 price = IOraclePrice(mp.oracle).price();
        uint256 crashed = price * ltv / mp.lltv * 90 / 100;
        vm.mockCall(mp.oracle, abi.encodeWithSelector(IOraclePrice.price.selector), abi.encode(crashed));
        uint256 seize = r.collateral() / 4;
        address liquidator = address(0x11D);
        deal(USDG, liquidator, 1_000_000e6);
        vm.startPrank(liquidator);
        IERC20(USDG).approve(MORPHO, type(uint256).max);
        IMorphoLiquidate(MORPHO).liquidate(mp, RAETO_NVDA, seize, 0, "");
        vm.stopPrank();
        vm.clearMockedCalls();
        r.accrue();
        uint256 owed = r.liquidationOwed(address(stock));
        assertGt(owed, 0);
        // Exit with amount 0 claims it: USDG arrives in the stock vault, which cannot spend it...
        _exit(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA, 0);
        uint256 usdg = IERC20(USDG).balanceOf(address(stock));
        assertGt(usdg, 0);
        // ... and Forward sends it to the linked USDG vault, nowhere else.
        _refused(stock, STOCK, 28, abi.encode(USDG, usdg), abi.encodeWithSelector(OstraVaultModuleV4.NotLinked.selector));
        _spend(stock, STOCK, 16, abi.encode(address(cash)));
        _spend(stock, STOCK, 28, abi.encode(USDG, usdg));
        assertEq(IERC20(USDG).balanceOf(address(cash)), usdg);
        assertEq(IERC20(USDG).balanceOf(address(stock)), 0);
    }

    function test_forwardRefusesPositionsTheIdentityAndTheVaultsOwnToken() public {
        OstraVault cash = _vault(CASH, USDG);
        OstraVault stock = _vault(STOCK, NVDA);
        _spend(cash, CASH, 16, abi.encode(address(stock)));
        bytes memory wrong = abi.encodeWithSelector(OstraVaultModuleV4.WrongToken.selector);
        _refused(cash, CASH, 28, abi.encode(USDG, uint256(1)), wrong);
        _refused(cash, CASH, 28, abi.encode(SPARK, uint256(1)), wrong);
        _refused(cash, CASH, 28, abi.encode(STEAK_USDG, uint256(1)), wrong);
        _refused(cash, CASH, 28, abi.encode(RAETO_USDG, uint256(1)), wrong);
        _refused(cash, CASH, 28, abi.encode(IDENTITY_REGISTRY, uint256(1)), wrong);
        _refused(cash, CASH, 28, abi.encode(address(0xDEAD), uint256(1)), wrong);
        _refused(cash, CASH, 28, abi.encode(NVDA, uint256(0)), abi.encodeWithSelector(OstraVaultModuleV4.ZeroAmount.selector));
        deal(NVDA, address(cash), 1e18);
        _spend(cash, CASH, 28, abi.encode(NVDA, uint256(1e18)));
        assertEq(IERC20(NVDA).balanceOf(address(stock)), 1e18);
    }

    function test_underTheLockForwardGoesOnlyToALockedLink() public {
        OstraVault stock = _vault(STOCK, NVDA);
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(stock), 5e6);
        _spend(stock, STOCK, 16, abi.encode(address(cash)));
        _lock(stock, STOCK, 1e15);
        _refused(stock, STOCK, 28, abi.encode(USDG, uint256(5e6)), abi.encodeWithSelector(OstraVaultModuleV4.Locked.selector));
        // The link decided while the other vault was locked counts as the owner's own.
        _spend(cash, CASH, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        _spend(stock, STOCK, 16, abi.encode(address(cash)));
        vm.warp(block.timestamp + DELAY);
        _spend(stock, STOCK, 28, abi.encode(USDG, uint256(5e6)));
        assertEq(IERC20(USDG).balanceOf(address(cash)), 5e6);
    }

    function test_guardOp6BringsAPositionHomeAndSweepsInOneCall() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enter(cash, CASH, K_ERC4626, SPARK, 70e6);
        _lock(cash, CASH, 1e6);
        vm.startPrank(GUARDIAN);
        vm.expectRevert(OstraVaultModuleV4.BadParams.selector);
        cash.guard(6, abi.encode(K_ERC4626, SPARK, uint256(0), address(0xBEEF)));
        cash.guard(6, abi.encode(K_ERC4626, SPARK, uint256(0), WITHDRAWAL));
        vm.stopPrank();
        assertEq(IERC4626Venue(SPARK).balanceOf(address(cash)), 0);
        assertEq(IERC20(USDG).balanceOf(address(cash)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(WITHDRAWAL), 100e6, 2);
    }

    function test_aPlainErc4626VenueCountsAgainstTheLimitAndAGuardianExitsItInALoss() public {
        PlainVault plain = new PlainVault(IERC20(USDG));
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_ERC4626, address(plain));
        _lock(cash, CASH, 5e6);
        // It names no implementation: an Enter under the lock counts against the daily limit.
        _refused(cash, CASH, 26, abi.encode(K_ERC4626, address(plain), uint256(6e6), uint256(0)),
            abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, uint256(5e6)));
        _enter(cash, CASH, K_ERC4626, address(plain), 5e6);
        assertEq(cash.outflowAvailable(), 0);
        // The vault loses a fifth of its assets: the shares are worth less than this vault's mark.
        deal(USDG, address(plain), 4e6);
        vm.prank(GUARDIAN);
        cash.guard(5, abi.encode(K_ERC4626, address(plain), uint256(0)));
        assertEq(plain.balanceOf(address(cash)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(cash)), 99e6, 2);
    }

    function test_aFailedEnterFromAnAccountWithCodeRevertsAndKeepsItsKey() public {
        OstraVault cash = _vault(CASH, USDG);
        bytes memory enter = abi.encode(K_ERC4626, SPARK, uint256(1e6), uint256(0));
        (bytes32 next, bytes memory sig) = _signed(cash, CASH, 26, enter);
        // An EIP-7702 account: its code is its delegation (0xef0100 and an address).
        address delegated = address(0x7702);
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0xD1E)));
        vm.prank(delegated, delegated);
        vm.expectRevert(OstraVaultModuleV4.NotEnabled.selector);
        cash.spend(26, next, enter, sig);
        assertEq(cash.nonce(), 0);
    }

    function test_aReEnableCannotSwitchTheBreakerOffForAPositionHeld() public {
        OstraVault cash = _vault(CASH, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enter(cash, CASH, K_ERC4626, SPARK, 60e6);
        address impl = address(uint160(uint256(vm.load(SPARK, IMPLEMENTATION_SLOT))));
        vm.etch(address(0x5BA4C0DE), impl.code);
        vm.store(SPARK, IMPLEMENTATION_SLOT, bytes32(uint256(uint160(address(0x5BA4C0DE)))));
        // Disabled, then enabled again: refused while the position is there and the breaker would act on it.
        _spend(cash, CASH, 25, abi.encode(K_ERC4626, SPARK, false));
        _refused(cash, CASH, 25, abi.encode(K_ERC4626, SPARK, true),
            abi.encodeWithSelector(OstraVaultModuleV4.VenueChanged.selector, uint8(2)));
        vm.prank(address(0xBAD));
        cash.tripVenue(K_ERC4626, SPARK, 0);
        // With the position home, the new implementation may be accepted.
        _enable(cash, CASH, K_ERC4626, SPARK);
        vm.expectRevert(OstraVaultModuleV4.Healthy.selector);
        cash.tripVenue(K_ERC4626, SPARK, 0);
    }

    function test_aGuardianVaultExitsAndSweepsThroughGuardOp6() public {
        OstraVault cash = _vault(CASH, USDG);
        OstraVault g = _vault(GUARD_VAULT, USDG);
        deal(USDG, address(cash), 100e6);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enter(cash, CASH, K_ERC4626, SPARK, 70e6);
        _spend(cash, CASH, 6, abi.encode(address(g), true));
        _spend(cash, CASH, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        bytes32 arg = bytes32(uint256(K_ERC4626) << 160 | uint256(uint160(SPARK)));
        _refused(g, GUARD_VAULT, 24, abi.encode(address(cash), uint8(6), arg, uint256(1) << 160),
            abi.encodeWithSelector(OstraVaultModuleV4.BadParams.selector));
        _spend(g, GUARD_VAULT, 24, abi.encode(address(cash), uint8(6), arg, uint256(uint160(WITHDRAWAL))));
        assertEq(IERC4626Venue(SPARK).balanceOf(address(cash)), 0);
        assertEq(IERC20(USDG).balanceOf(address(cash)), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(WITHDRAWAL), 100e6, 2);
    }

    // ---------------------------------------------------------------------------------------------
    // Gas and landing
    // ---------------------------------------------------------------------------------------------

    function test_aFailedEnterSentFromInsideAnotherCallRevertsAndKeepsItsKey() public {
        OstraVault cash = _vault(CASH, USDG);
        bytes memory enter = abi.encode(K_ERC4626, SPARK, uint256(1e6), uint256(0));
        (bytes32 next, bytes memory sig) = _signed(cash, CASH, 26, enter);
        vm.expectRevert(OstraVaultModuleV4.NotEnabled.selector);
        cash.spend(26, next, enter, sig);
        assertEq(cash.nonce(), 0);
        vm.prank(SUBMITTER, SUBMITTER);
        cash.spend(26, next, enter, sig);
        assertEq(cash.nonce(), 1);
    }

    /// @dev The gas each kind's Enter and Exit takes, for the gas floors (printed with -vv). Isolated: each call is its
    ///      own transaction, so every venue's storage is read cold, as it is on chain.
    /// forge-config: default.isolate = true
    function test_gasOfEachKind() public {
        OstraVault cash = _vault(CASH, USDG);
        OstraVault stock = _vault(STOCK, NVDA);
        deal(USDG, address(cash), 1_000e6);
        deal(NVDA, address(stock), 2e18);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enable(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA);
        _measure(cash, CASH, 26, abi.encode(K_ERC4626, SPARK, uint256(100e6), uint256(0)), "spark enter");
        _measure(cash, CASH, 27, abi.encode(K_ERC4626, SPARK, IERC4626Venue(SPARK).balanceOf(address(cash)), uint256(0)), "spark exit");
        _measure(cash, CASH, 26, abi.encode(K_RAETO_USDG, RAETO_USDG, uint256(100e6), uint256(0)), "raeto usdg enter");
        _measure(cash, CASH, 27, abi.encode(K_RAETO_USDG, RAETO_USDG, IRaetoVault(RAETO_USDG).principalOf(address(cash)), uint256(0)), "raeto usdg exit");
        _measure(stock, STOCK, 26, abi.encode(K_RAETO_STOCK, RAETO_NVDA, uint256(1e18), uint256(0)), "raeto stock enter");
        _measure(stock, STOCK, 27, abi.encode(K_RAETO_STOCK, RAETO_NVDA, IRaetoStockVault(RAETO_NVDA).sharesOf(address(stock)), uint256(0)), "raeto stock exit");
    }

    function _measure(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params, string memory what) internal {
        (bytes32 next, bytes memory sig) = _signed(vault, keychain, action, params);
        vm.recordLogs();
        vm.prank(SUBMITTER, SUBMITTER);
        uint256 g = gasleft();
        vault.spend(action, next, params, sig);
        g -= gasleft();
        assertFalse(_logged(address(vault), OstraVaultV4.VenueFailed.selector), what);
        console.log(what, g);
    }

    function test_noGasLimitMakesAValidEnterOrExitLandAsFailed() public {
        OstraVault cash = _vault(CASH, USDG);
        OstraVault stock = _vault(STOCK, NVDA);
        deal(USDG, address(cash), 100e6);
        deal(NVDA, address(stock), 2e18);
        _enable(cash, CASH, K_ERC4626, SPARK);
        _enable(cash, CASH, K_RAETO_USDG, RAETO_USDG);
        _enable(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA);
        _enter(cash, CASH, K_ERC4626, SPARK, 10e6);
        _enter(cash, CASH, K_RAETO_USDG, RAETO_USDG, 10e6);
        _enter(stock, STOCK, K_RAETO_STOCK, RAETO_NVDA, 1e18);
        _gasSweep(cash, CASH, 26, abi.encode(K_ERC4626, SPARK, uint256(10e6), uint256(0)));
        _gasSweep(cash, CASH, 27, abi.encode(K_ERC4626, SPARK, IERC4626Venue(SPARK).balanceOf(address(cash)), uint256(0)));
        _gasSweep(cash, CASH, 26, abi.encode(K_RAETO_USDG, RAETO_USDG, uint256(10e6), uint256(0)));
        _gasSweep(cash, CASH, 27, abi.encode(K_RAETO_USDG, RAETO_USDG, uint256(5e6), uint256(0)));
        _gasSweep(stock, STOCK, 26, abi.encode(K_RAETO_STOCK, RAETO_NVDA, uint256(1e18), uint256(0)));
        _gasSweep(stock, STOCK, 27, abi.encode(K_RAETO_STOCK, RAETO_NVDA, uint256(5e17), uint256(0)));
    }

    /// @dev Sends the signed spend with every gas limit from 200k to 4M: each one that lands has not failed.
    function _gasSweep(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        (bytes32 next, bytes memory sig) = _signed(vault, keychain, action, params);
        uint256 landed;
        for (uint256 g = 200_000; g <= 4_000_000; g += 100_000) {
            uint256 snap = vm.snapshotState();
            vm.recordLogs();
            vm.prank(SUBMITTER, SUBMITTER);
            try vault.spend{gas: g}(action, next, params, sig) {
                ++landed;
                assertFalse(_logged(address(vault), OstraVaultV4.VenueFailed.selector), "a valid Enter or Exit never lands as failed");
            } catch {}
            vm.revertToState(snap);
        }
        assertGt(landed, 0);
    }
}
