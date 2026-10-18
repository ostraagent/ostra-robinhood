// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraHook} from "../src/launchpad/OstraHook.sol";
import {OstraLaunchpad} from "../src/launchpad/OstraLaunchpad.sol";
import {OstraLocker} from "../src/launchpad/OstraLocker.sol";
import {OstraToken} from "../src/launchpad/OstraToken.sol";
import {TestSwapRouter} from "./utils/TestSwapRouter.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";

interface IERC6909Balance {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
}

/// @dev The deployed Uniswap v2 and v3 contracts and Universal Router on Robinhood Chain (Uniswap's
///      universal-router deploy-addresses/robinhood.json and script/deployParameters/DeployRobinhood.s.sol).
interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
    function liquidity() external view returns (uint128);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev v4-periphery IV4Router.ExactInputSingleParams as Universal Router 2.1.2 decodes it.
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

/// @notice The Ostra launchpad, locker, token and hook on a fork of Robinhood Chain mainnet, against the deployed
///         Uniswap v4 PoolManager, USDG and WETH. Swaps go through a plain PoolManager client and through an
///         OstraVault's Swap action.
contract LaunchpadForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant BATCH = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint160 internal constant HOOK_FLAGS = 0x28CC;
    address internal constant V2_FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant V3_POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;

    IPoolManager internal pm = IPoolManager(POOL_MANAGER);
    OstraVaultFactory internal factory;
    OstraHook internal hook;
    OstraLocker internal locker;
    OstraLaunchpad internal launchpad;
    TestSwapRouter internal router;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant CREATOR = keccak256("OSTRA/EVM/TEST/creator-usdg-vault");
    bytes32 internal constant CREATOR_WETH = keccak256("OSTRA/EVM/TEST/creator-weth-vault");
    bytes32 internal constant BUYER = keccak256("OSTRA/EVM/TEST/buyer-usdg-vault");
    bytes32 internal constant BUYER_TOKEN = keccak256("OSTRA/EVM/TEST/buyer-token-vault");

    function setUp() public {
        vm.createSelectFork("robinhood");
        assertGt(POOL_MANAGER.code.length, 0);
        assertGt(WETH.code.length, 0);
        OstraVault implementation = new OstraVault(BATCH, POOL_MANAGER);
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(implementation), address(this));
        factory = new OstraVaultFactory(address(beacon));

        // The hook's address carries its permission bits (v4-core Hooks): mine a CREATE2 salt for them.
        bytes32 initHash = keccak256(abi.encodePacked(type(OstraHook).creationCode, abi.encode(POOL_MANAGER, WETH, address(this))));
        bytes32 salt;
        for (uint256 i = 0; i < 500_000; ++i) {
            address a = vm.computeCreate2Address(bytes32(i), initHash, address(this));
            if (uint160(a) & 0x3FFF == HOOK_FLAGS) {
                salt = bytes32(i);
                break;
            }
        }
        hook = new OstraHook{salt: salt}(POOL_MANAGER, WETH, address(this));
        assertEq(uint160(address(hook)) & 0x3FFF, HOOK_FLAGS);
        launchpad = new OstraLaunchpad(POOL_MANAGER, address(hook), WETH, address(this));
        locker = new OstraLocker(POOL_MANAGER, address(launchpad), address(hook));
        hook.initialize(address(launchpad), address(locker));
        launchpad.setLocker(address(locker));
        router = new TestSwapRouter(POOL_MANAGER);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _seed(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keychain, index);
    }

    function _vault(address token, bytes32 keychain) internal returns (OstraVault) {
        return OstraVault(factory.createVault(token, WotsSigner.keyRoot(_seed(keychain, 0)), address(0)));
    }

    function _spend(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        uint64 n = vault.nonce();
        bytes32 next = WotsSigner.keyRoot(_seed(keychain, n + 1));
        bytes memory signature = WotsSigner.sign(_seed(keychain, n), vault.spendMessage(action, next, params));
        vault.spend(action, next, params, signature);
    }

    function _tiers() internal pure returns (OstraLaunchpad.Tier[] memory t) {
        t = new OstraLaunchpad.Tier[](3);
        t[0] = OstraLaunchpad.Tier({width: 40_000, supplyBps: 4_000});
        t[1] = OstraLaunchpad.Tier({width: 40_000, supplyBps: 3_000});
        t[2] = OstraLaunchpad.Tier({width: 0, supplyBps: 3_000});
    }

    /// @dev A USDG pool starting at a 50,000 USDG market cap (5e-5 USDG a token: tick -375,400), with taxes, all
    ///      four buckets, dividends in the token itself, anti-snipe, limits, anti-farmer, and graduation at
    ///      1,000 USDG raised.
    function _params(Currency quote, address creatorVault, int24 startTick, bytes32 salt)
        internal
        view
        returns (OstraLaunchpad.LaunchParams memory p)
    {
        p.name = "Ostra Test";
        p.symbol = "OTEST";
        p.salt = salt;
        p.quote = quote;
        p.creatorVault = creatorVault;
        p.startTick = startTick;
        p.tiers = _tiers();
        p.buyTaxBps = 300;
        p.sellTaxBps = 500;
        p.postBuyTaxBps = 100;
        p.postSellTaxBps = 200;
        p.taxDuration = 30 days;
        p.creatorBucketBps = 2_500;
        p.dividendBucketBps = 2_500;
        p.burnBucketBps = 2_500;
        p.lpBucketBps = 2_500;
        p.dividendToken = address(launchpad);
        p.minDividendBalance = 1_000e18;
        p.antiSnipeBps = 5_000;
        p.antiSnipeDuration = 600;
        p.maxBuy = 10_000_000e18;
        p.maxWallet = 20_000_000e18;
        p.limitsDuration = 1 days;
        p.antiFarmerDuration = 1 days;
        p.graduationKind = 2;
        p.graduationThreshold = 1_000e6;
    }

    function _launchUsdg(bytes32 salt) internal returns (OstraToken token, PoolKey memory key, OstraVault creatorVault) {
        creatorVault = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(creatorVault), -375_400, salt);
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        token = OstraToken(t);
        key = hook.poolKey(id);
    }

    function _claims(Currency c) internal view returns (uint256) {
        return IERC6909Balance(POOL_MANAGER).balanceOf(address(hook), c.toId());
    }

    /// @dev creatorPaid of the Dispatched event in the recorded logs.
    function _creatorPaid() internal returns (uint256 paid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = OstraHook.Dispatched.selector;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == topic) {
                (paid,,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            }
        }
    }

    function _buyExactIn(PoolKey memory key, OstraToken token, uint256 quoteIn, address to) internal returns (BalanceDelta) {
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        return router.swap(key, !tokenIs0, -int256(quoteIn), to);
    }

    // ---------------------------------------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------------------------------------

    function test_onlyTheLaunchpadCreatesOstraPools() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(USDG),
            currency1: Currency.wrap(WETH),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
        vm.expectRevert();
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
    }

    function test_launchLocksTheWholeSupplyInTiers() public {
        uint256 pmBefore = IERC20(USDG).balanceOf(POOL_MANAGER);
        OstraVault creatorVault = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory lp = _params(Currency.wrap(USDG), address(creatorVault), -375_400, bytes32(uint256(1)));
        address predicted = launchpad.tokenAddress(address(this), lp);
        uint256 fee = launchpad.LAUNCH_FEE();
        uint256 before = gasleft();
        (address t, PoolId launchedId) = launchpad.launch{value: fee}(lp);
        console.log("gas launch", before - gasleft());
        // The token's address is known before the launch, and does not depend on the block.
        assertEq(t, predicted);
        OstraToken token = OstraToken(t);
        PoolKey memory key = hook.poolKey(launchedId);
        assertEq(token.LIMITS_END_AT(), block.timestamp + 1 days);
        assertEq(token.ANTI_FARMER_END_AT(), block.timestamp + 1 days);
        PoolId id = key.toId();
        OstraHook.PoolConfig memory c = hook.poolConfig(id);
        assertEq(c.token, address(token));
        assertEq(c.tokenIs0, uint160(address(token)) < uint160(USDG));
        assertEq(token.totalSupply(), launchpad.SUPPLY());
        uint256 dust = token.balanceOf(token.DEAD());
        assertEq(token.balanceOf(POOL_MANAGER) + dust, launchpad.SUPPLY());
        assertLt(dust, 1e18, "rounding dust only");
        assertEq(token.balanceOf(address(locker)), 0);
        assertEq(IERC20(USDG).balanceOf(POOL_MANAGER), pmBefore, "no quote at launch");
        assertEq(locker.positionsOf(id).length, 3);
        assertEq(address(launchpad).balance, launchpad.LAUNCH_FEE());
        // The launch fee is exact.
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(_vault(USDG, CREATOR)), -375_400, bytes32(uint256(2)));
        vm.expectRevert(OstraLaunchpad.WrongFee.selector);
        launchpad.launch{value: 1}(p);
    }

    function test_launchRefusesOutOfBoundsRules() public {
        OstraVault v = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(v), -375_400, bytes32(uint256(3)));
        uint256 fee = launchpad.LAUNCH_FEE();
        p.buyTaxBps = 1_001;
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "tax"));
        launchpad.launch{value: fee}(p);
        p.buyTaxBps = 300;
        p.postSellTaxBps = 600;
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "postTax"));
        launchpad.launch{value: fee}(p);
        p.postSellTaxBps = 200;
        p.lpBucketBps = 2_000;
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "buckets"));
        launchpad.launch{value: fee}(p);
        p.lpBucketBps = 2_500;
        p.antiSnipeBps = 8_001;
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "antiSnipe"));
        launchpad.launch{value: fee}(p);
        p.antiSnipeBps = 5_000;
        p.creatorVault = address(_vault(WETH, CREATOR_WETH));
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "creatorVault"));
        launchpad.launch{value: fee}(p);
        p.creatorVault = address(v);
        p.startTick = -398_401;
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "startTick"));
        launchpad.launch{value: fee}(p);
    }

    // ---------------------------------------------------------------------------------------------
    // Fees and taxes
    // ---------------------------------------------------------------------------------------------

    function test_everySwapPaysTheHookFeeAndTaxInQuote() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(4)));
        PoolId id = key.toId();
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        Currency usdg = Currency.wrap(USDG);
        vm.warp(block.timestamp + 601); // after the anti-snipe
        deal(USDG, address(router), 1_000e6);

        // Exact input buy of 100 USDG: 1% hook fee + 3% buy tax = 4% of what the buyer pays.
        uint256 claims0 = _claims(usdg);
        uint256 protocol0 = hook.protocolOwed(usdg);
        uint256 before = gasleft();
        BalanceDelta d = _buyExactIn(key, token, 100e6, address(router));
        console.log("gas buy exact input", before - gasleft());
        int128 paid = tokenIs0 ? d.amount1() : d.amount0();
        assertEq(paid, -100e6);
        assertEq(_claims(usdg) - claims0, 4e6);
        // Hook fee 1e6: 70% creator, 30% protocol, half of that kept for buyback.
        assertEq(hook.protocolOwed(usdg) - protocol0, 0.15e6);
        assertEq(hook.buybackOwed(usdg), 0.15e6);
        OstraHook.Pending memory pend = hook.pending(id);
        assertEq(pend.creator, 0.7e6 + 0.75e6);
        assertEq(pend.dividend, 0.75e6);
        assertEq(pend.burn, 0.75e6);
        assertEq(pend.lp, 0.75e6);

        // Exact output buy of 1,000,000 tokens: the fee comes on top, fee = poolIn * 400 / 9,600.
        claims0 = _claims(usdg);
        d = router.swap(key, !tokenIs0, 1_000_000e18, address(router));
        uint256 total = uint256(-int256(tokenIs0 ? d.amount1() : d.amount0()));
        uint256 fee = _claims(usdg) - claims0;
        assertEq(fee, ((total - fee) * 400) / 9_600);
        assertEq(uint256(int256(tokenIs0 ? d.amount0() : d.amount1())), 1_000_000e18);

        // Exact input sell of 500,000 tokens: 1% + 5% out of the quote the pool pays.
        claims0 = _claims(usdg);
        d = router.swap(key, tokenIs0, -500_000e18, address(router));
        uint256 got = uint256(int256(tokenIs0 ? d.amount1() : d.amount0()));
        fee = _claims(usdg) - claims0;
        assertEq(fee, ((got + fee) * 600) / 10_000);

        // Exact output sell for 1 USDG: fee = 1e6 * 600 / 9,400 on top of what the pool pays out.
        claims0 = _claims(usdg);
        d = router.swap(key, tokenIs0, 1e6, address(router));
        assertEq(uint256(int256(tokenIs0 ? d.amount1() : d.amount0())), 1e6);
        assertEq(_claims(usdg) - claims0, (uint256(1e6) * 600) / 9_400);
    }

    function test_antiSnipeFallsLinearlyToZero() public {
        (, PoolKey memory key,) = _launchUsdg(bytes32(uint256(5)));
        PoolId id = key.toId();
        (uint256 buyTax, uint256 sellTax, uint256 snipe) = hook.rates(id);
        assertEq(buyTax, 300);
        assertEq(sellTax, 500);
        assertEq(snipe, 5_000);
        vm.warp(block.timestamp + 300);
        (,, snipe) = hook.rates(id);
        assertEq(snipe, 2_500);
        vm.warp(block.timestamp + 300);
        (,, snipe) = hook.rates(id);
        assertEq(snipe, 0);
    }

    function test_maxBuyMaxWalletAndClosedLiquidityBeforeGraduation() public {
        OstraVault v = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(v), -375_400, bytes32(uint256(6)));
        p.graduationThreshold = 100_000e6; // far away: the launch rules hold for this whole test
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        OstraToken token = OstraToken(t);
        PoolKey memory key = hook.poolKey(id);
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 10_000e6);
        // More than the max buy in one swap.
        vm.expectRevert();
        router.swap(key, !tokenIs0, 10_000_001e18, address(router));
        // Two max buys into one wallet: above the max wallet.
        router.swap(key, !tokenIs0, 10_000_000e18, address(router));
        router.swap(key, !tokenIs0, 9_000_000e18, address(router));
        // The PoolManager's transfer to the wallet fails with the token's MaxWalletExceeded inside.
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(token),
                IERC20.transfer.selector,
                abi.encodeWithSelector(OstraToken.MaxWalletExceeded.selector, address(router)),
                abi.encodePacked(CurrencyLibrary.ERC20TransferFailed.selector)
            )
        );
        router.swap(key, !tokenIs0, 2_000_000e18, address(router));
        // Outside liquidity is refused before graduation.
        vm.expectRevert();
        router.addLiquidity(key, -887_200, 887_200, 1e18);
    }

    function test_antiFarmerKeepsTheTokenOutOfOtherV4Pools() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(7)));
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 100e6);
        _buyExactIn(key, token, 50e6, address(this));
        // A plain transfer into the PoolManager (what another v4 pool's settle needs) is refused...
        vm.expectRevert(OstraToken.AntiFarmer.selector);
        token.transfer(POOL_MANAGER, 1e18);
        // ...while a sell through the Ostra pool pays its exact amount in.
        token.transfer(address(router), 1_000e18);
        router.swap(key, tokenIs0, -1_000e18, address(router));
        // After the anti-farmer period the token moves freely.
        vm.warp(block.timestamp + 1 days);
        token.transfer(POOL_MANAGER, 1e18);
    }

    // ---------------------------------------------------------------------------------------------
    // Graduation
    // ---------------------------------------------------------------------------------------------

    function test_graduationLiftsTheLaunchRules() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(8)));
        PoolId id = key.toId();
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 5_000e6);
        address[4] memory buyers = [makeAddr("b1"), makeAddr("b2"), makeAddr("b3"), makeAddr("b4")];
        uint256 i;
        while (!hook.poolState(id).graduated) {
            _buyExactIn(key, token, 300e6, buyers[i % 4]);
            ++i;
            assertLt(i, 12);
        }
        OstraHook.PoolState memory s = hook.poolState(id);
        assertGe(uint256(s.quoteRaised), 1_000e6);
        assertTrue(token.limitsReleased());
        (uint256 buyTax, uint256 sellTax, uint256 snipe) = hook.rates(id);
        assertEq(buyTax, 100);
        assertEq(sellTax, 200);
        assertEq(snipe, 0);
        // No max buy or max wallet any more.
        router.swap(key, !tokenIs0, 30_000_000e18, address(router));
        assertGt(token.balanceOf(address(router)), 20_000_000e18);
        // Outside liquidity opens once the anti-farmer period is over too.
        vm.expectRevert();
        router.addLiquidity(key, -887_200, 887_200, 1e15);
        vm.warp(block.timestamp + 1 days);
        router.addLiquidity(key, -887_200, 887_200, 1e15);
    }

    // ---------------------------------------------------------------------------------------------
    // Dispatch
    // ---------------------------------------------------------------------------------------------

    function test_dispatchPaysTheCreatorBurnsAddsLiquidityAndPaysDividends() public {
        (OstraToken token, PoolKey memory key, OstraVault creatorVault) = _launchUsdg(bytes32(uint256(9)));
        PoolId id = key.toId();
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 2_000e6);
        address holder = makeAddr("holder");
        _buyExactIn(key, token, 200e6, holder);
        _buyExactIn(key, token, 200e6, address(router));
        router.swap(key, tokenIs0, -1_000_000e18, address(router));
        OstraHook.Pending memory before_ = hook.pending(id);
        assertGt(before_.burn, 0);
        uint256 supply = token.totalSupply();
        uint256 vaultBefore = IERC20(USDG).balanceOf(address(creatorVault));

        vm.recordLogs();
        uint256 g = gasleft();
        hook.dispatch(id);
        console.log("gas dispatch", g - gasleft());
        uint256 paid = _creatorPaid();

        OstraHook.Pending memory after_ = hook.pending(id);
        assertEq(after_.creator, 0);
        assertGt(paid, before_.creator, "plus 70% of the LP fees");
        assertEq(IERC20(USDG).balanceOf(address(creatorVault)) - vaultBefore, paid);
        assertLt(token.totalSupply(), supply, "burn bucket burned tokens");
        assertTrue(locker.hasLpBucketPosition(id), "LP bucket added liquidity");
        assertLt(after_.burn, before_.burn);
        assertLt(after_.dividend, before_.dividend);
        // Dividends in the token itself, claimable by any holder above the minimum.
        uint256 owed = token.dividendOf(holder);
        assertGt(owed, 0);
        uint256 held = token.balanceOf(holder);
        vm.prank(holder);
        token.claimTo(holder);
        assertEq(token.balanceOf(holder), held + owed);
        assertEq(token.dividendOf(holder), 0);
        // The protocol's share goes to the operator's vault.
        OstraVault operator = _vault(USDG, keccak256("OSTRA/EVM/TEST/operator-vault"));
        uint256 owedProtocol = hook.protocolOwed(Currency.wrap(USDG));
        hook.claimProtocol(Currency.wrap(USDG), address(operator));
        assertEq(IERC20(USDG).balanceOf(address(operator)), owedProtocol);
        // A second dispatch right away has little left to do and still works.
        hook.dispatch(id);
    }

    // ---------------------------------------------------------------------------------------------
    // Vault swaps and ETH pools
    // ---------------------------------------------------------------------------------------------

    function test_aVaultBuysIntoItsOwnTokenVault() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(10)));
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.warp(block.timestamp + 601);
        OstraVault buyer = _vault(USDG, BUYER);
        OstraVault bunker = _vault(address(token), BUYER_TOKEN);
        deal(USDG, address(buyer), 100e6);
        bytes memory params = abi.encode(key, !tokenIs0, uint128(20e6), uint128(1), address(bunker));
        bytes32 next = WotsSigner.keyRoot(_seed(BUYER, 1));
        bytes memory signature = WotsSigner.sign(_seed(BUYER, 0), buyer.spendMessage(3, next, params));
        uint256 g = gasleft();
        buyer.spend(3, next, params, signature);
        console.log("gas vault Swap into a token vault (Ostra pool)", g - gasleft());
        assertGt(token.balanceOf(address(bunker)), 0);
        assertEq(IERC20(USDG).balanceOf(address(buyer)), 80e6);
        // The vault seen by the hook is the swapper; the token vault spends its tokens with its own key.
        _spend(bunker, BUYER_TOKEN, 0, abi.encode(makeAddr("out"), uint256(1e18)));
        assertEq(token.balanceOf(makeAddr("out")), 1e18);
    }

    function test_anEthPoolPaysTheCreatorInWeth() public {
        OstraVault wethVault = _vault(WETH, CREATOR_WETH);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(address(0)), address(wethVault), -168_200, bytes32(uint256(11)));
        p.dividendToken = WETH;
        p.graduationThreshold = 1 ether;
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        OstraToken token = OstraToken(t);
        PoolKey memory key = hook.poolKey(id);
        assertEq(Currency.unwrap(key.currency0), address(0));
        vm.warp(block.timestamp + 601);
        vm.deal(address(router), 2 ether);
        router.swap(key, true, -0.1 ether, makeAddr("eth buyer"));
        assertGt(token.balanceOf(makeAddr("eth buyer")), 0);
        uint256 creatorShare = hook.pending(id).creator;
        assertGt(creatorShare, 0);
        vm.recordLogs();
        hook.dispatch(id);
        // The creator gets its share of the hook fee and tax, plus 70% of the locked positions' LP fees.
        uint256 paid = _creatorPaid();
        assertGt(paid, creatorShare);
        assertEq(IERC20(WETH).balanceOf(address(wethVault)), paid);
        assertEq(hook.pending(id).creator, 0);
        // Launch fees go to the operator's WETH vault.
        OstraVault operator = _vault(WETH, keccak256("OSTRA/EVM/TEST/operator-weth-vault"));
        launchpad.claimLaunchFees(address(operator));
        assertEq(IERC20(WETH).balanceOf(address(operator)), launchpad.LAUNCH_FEE());
    }

    function test_dividendsInAnotherTokenAreBoughtInItsOwnPool() public {
        // Dividends in AAPL (0xaF3D...93f9), bought with the USDG bucket in the hookless USDG/AAPL 0.30% pool.
        address aapl = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
        OstraVault v = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(v), -375_400, bytes32(uint256(12)));
        p.dividendToken = aapl;
        p.dividendKey = PoolKey({
            currency0: Currency.wrap(USDG),
            currency1: Currency.wrap(aapl),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        OstraToken token = OstraToken(t);
        PoolKey memory key = hook.poolKey(id);
        assertEq(token.DIVIDEND_TOKEN(), aapl);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 1_000e6);
        address holder = makeAddr("aapl holder");
        _buyExactIn(key, token, 200e6, holder);
        _buyExactIn(key, token, 200e6, address(router));
        hook.dispatch(id);
        uint256 owed = token.dividendOf(holder);
        assertGt(owed, 0);
        vm.prank(holder);
        token.claimTo(holder);
        assertEq(IERC20(aapl).balanceOf(holder), owed);
    }

    // ---------------------------------------------------------------------------------------------
    // Anti-farmer against the deployed Uniswap v2 and v3, and the Universal Router
    // ---------------------------------------------------------------------------------------------

    function test_antiFarmerKeepsTheTokenOutOfV2AndV3Pools() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(13)));
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 100e6);
        _buyExactIn(key, token, 50e6, address(this));
        deal(USDG, address(this), 100e6);
        bool tokenIs0 = uint160(address(token)) < uint160(USDG);
        (address token0, address token1) = tokenIs0 ? (address(token), USDG) : (USDG, address(token));

        // Anyone can create the pools; no liquidity can go in while the anti-farmer period lasts.
        address pair = IUniswapV2Factory(V2_FACTORY).createPair(address(token), USDG);
        vm.expectRevert(OstraToken.AntiFarmer.selector);
        token.transfer(pair, 1_000e18);

        address pool = IUniswapV3Factory(V3_FACTORY).createPool(address(token), USDG, 3000);
        IUniswapV3Pool(pool).initialize(TickMath.getSqrtPriceAtTick(tokenIs0 ? int24(-375_420) : int24(375_420)));
        vm.expectRevert(OstraToken.AntiFarmer.selector);
        token.transfer(pool, 1_000e18);
        token.approve(V3_POSITION_MANAGER, type(uint256).max);
        IERC20(USDG).approve(V3_POSITION_MANAGER, type(uint256).max);
        INonfungiblePositionManager.MintParams memory mint = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: 3000,
            tickLower: -887_220,
            tickUpper: 887_220,
            amount0Desired: tokenIs0 ? 100_000e18 : 5e6,
            amount1Desired: tokenIs0 ? 5e6 : 100_000e18,
            amount0Min: 0,
            amount1Min: 0,
            recipient: address(this),
            deadline: block.timestamp
        });
        // The position manager pays the pool in its mint callback: the token's AntiFarmer surfaces as STF.
        vm.expectRevert(bytes("STF"));
        INonfungiblePositionManager(V3_POSITION_MANAGER).mint(mint);

        // Contracts that are not pools of this token still receive it: an OstraVault holding the token.
        OstraVault bunker = _vault(address(token), BUYER_TOKEN);
        uint256 g = gasleft();
        token.transfer(address(bunker), 1_000e18);
        console.log("gas transfer into a vault during anti-farmer", g - gasleft());
        assertEq(token.balanceOf(address(bunker)), 1_000e18);

        // After the anti-farmer period both pools take liquidity.
        vm.warp(block.timestamp + 1 days);
        token.transfer(pair, 1_000e18);
        mint.deadline = block.timestamp;
        INonfungiblePositionManager(V3_POSITION_MANAGER).mint(mint);
        assertGt(IUniswapV3Pool(pool).liquidity(), 0);
    }

    /// @dev One V4_SWAP (0x10) command: SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f).
    function _routerSwap(PoolKey memory key, bool zeroForOne, uint128 amountIn) internal {
        (Currency input, Currency output) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: 1,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(input, uint256(amountIn));
        params[2] = abi.encode(output, uint256(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), params);
        IUniversalRouter(UNIVERSAL_ROUTER).execute(abi.encodePacked(uint8(0x10)), inputs, block.timestamp);
    }

    function test_theUniversalRouterBuysAndSellsDuringAntiFarmer() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(14)));
        PoolId id = key.toId();
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.warp(block.timestamp + 601);
        assertLt(block.timestamp, hook.poolConfig(id).antiFarmerEndAt);
        address trader = makeAddr("router trader");
        deal(USDG, trader, 100e6);
        vm.startPrank(trader);
        IERC20(USDG).approve(PERMIT2, type(uint256).max);
        token.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(USDG, UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 1 hours));
        IPermit2(PERMIT2).approve(address(token), UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 1 hours));

        uint256 claims0 = _claims(Currency.wrap(USDG));
        uint256 g = gasleft();
        _routerSwap(key, !tokenIs0, 20e6);
        console.log("gas Universal Router buy (Ostra pool)", g - gasleft());
        uint256 bought = token.balanceOf(trader);
        assertGt(bought, 0);
        assertEq(IERC20(USDG).balanceOf(trader), 80e6);
        assertEq(_claims(Currency.wrap(USDG)) - claims0, 0.8e6, "1% hook fee + 3% buy tax");

        // The router settles the token after the swap: the hook's credit lets exactly that amount in.
        g = gasleft();
        _routerSwap(key, tokenIs0, uint128(bought / 2));
        console.log("gas Universal Router sell (Ostra pool)", g - gasleft());
        assertEq(token.balanceOf(trader), bought - bought / 2);
        assertGt(IERC20(USDG).balanceOf(trader), 80e6);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Creator settings and vault dividends
    // ---------------------------------------------------------------------------------------------

    function _configure(OstraVault creatorVault, PoolId id, uint8 field, uint256 value) internal {
        _spend(creatorVault, CREATOR, 4, abi.encode(address(hook), PoolId.unwrap(id), field, value));
    }

    function _configureReverts(OstraVault creatorVault, PoolId id, uint8 field, uint256 value, bytes4 err) internal {
        uint64 n = creatorVault.nonce();
        bytes memory params = abi.encode(address(hook), PoolId.unwrap(id), field, value);
        bytes32 next = WotsSigner.keyRoot(_seed(CREATOR, n + 1));
        bytes memory signature = WotsSigner.sign(_seed(CREATOR, n), creatorVault.spendMessage(4, next, params));
        vm.expectRevert(err);
        creatorVault.spend(4, next, params, signature);
    }

    function test_theCreatorVaultChangesRulesOnlyInTheTradersFavour() public {
        (OstraToken token, PoolKey memory key, OstraVault creatorVault) = _launchUsdg(bytes32(uint256(15)));
        PoolId id = key.toId();
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);

        // Only the creator vault, and never against the traders.
        vm.expectRevert(OstraHook.OnlyCreatorVault.selector);
        hook.configure(id, 0, 0);
        _configureReverts(creatorVault, id, 0, 300, OstraHook.NotInTradersFavour.selector);
        _configureReverts(creatorVault, id, 1, 501, OstraHook.NotInTradersFavour.selector);
        _configureReverts(creatorVault, id, 6, 9_000_000e18, OstraHook.NotInTradersFavour.selector);
        _configureReverts(creatorVault, id, 8, 0, OstraHook.BadField.selector);

        // Lower taxes; a lowered tax pulls its post-graduation tax down with it, so graduating never raises it.
        {
            uint64 n = creatorVault.nonce();
            bytes memory params = abi.encode(address(hook), PoolId.unwrap(id), uint8(0), uint256(50));
            bytes32 next = WotsSigner.keyRoot(_seed(CREATOR, n + 1));
            bytes memory signature = WotsSigner.sign(_seed(CREATOR, n), creatorVault.spendMessage(4, next, params));
            uint256 g = gasleft();
            creatorVault.spend(4, next, params, signature);
            console.log("gas vault ConfigurePool", g - gasleft());
        }
        _configure(creatorVault, id, 1, 150);
        _configure(creatorVault, id, 5, 1_000);
        OstraHook.PoolConfig memory c = hook.poolConfig(id);
        assertEq(c.buyTaxBps, 50);
        assertEq(c.postBuyTaxBps, 50);
        assertEq(c.sellTaxBps, 150);
        assertEq(c.postSellTaxBps, 150);
        (uint256 buyTax, uint256 sellTax, uint256 snipe) = hook.rates(id);
        assertEq(buyTax, 50);
        assertEq(sellTax, 150);
        assertEq(snipe, 1_000);

        // A higher max buy, then the launch limits released now: max buy and max wallet are gone.
        _configure(creatorVault, id, 6, 15_000_000e18);
        assertEq(hook.poolConfig(id).maxBuy, 15_000_000e18);
        _configure(creatorVault, id, 7, 0);
        assertTrue(token.limitsReleased());
        _configureReverts(creatorVault, id, 7, 0, OstraHook.NotInTradersFavour.selector);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 10_000e6);
        router.swap(key, !tokenIs0, 25_000_000e18, address(router));
        assertEq(token.balanceOf(address(router)), 25_000_000e18);

        // The tax ends now.
        _configure(creatorVault, id, 4, block.timestamp);
        (buyTax, sellTax,) = hook.rates(id);
        assertEq(buyTax + sellTax, 0);
        // Liquidity stays closed: only graduation and the end of the anti-farmer period open it.
        vm.expectRevert();
        router.addLiquidity(key, -887_200, 887_200, 1e15);
    }

    function test_aTokenVaultClaimsDividendsToItsOwnersQuoteVault() public {
        OstraVault v = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(v), -375_400, bytes32(uint256(16)));
        p.dividendToken = USDG;
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        OstraToken token = OstraToken(t);
        PoolKey memory key = hook.poolKey(id);
        vm.warp(block.timestamp + 601);
        OstraVault buyer = _vault(USDG, BUYER);
        OstraVault bunker = _vault(address(token), BUYER_TOKEN);
        deal(USDG, address(buyer), 100e6);
        _spend(buyer, BUYER, 3, abi.encode(key, Currency.unwrap(key.currency0) != address(token), uint128(20e6), uint128(1), address(bunker)));
        assertGe(token.balanceOf(address(bunker)), token.MIN_DIVIDEND_BALANCE());

        // Nothing owed yet: the signed claim reverts and keeps its key, to be sent again later.
        bytes memory params = abi.encode(address(buyer));
        bytes32 next = WotsSigner.keyRoot(_seed(BUYER_TOKEN, 1));
        bytes memory signature = WotsSigner.sign(_seed(BUYER_TOKEN, 0), bunker.spendMessage(5, next, params));
        vm.expectRevert(OstraVault.ZeroAmount.selector);
        bunker.spend(5, next, params, signature);

        deal(USDG, address(router), 1_000e6);
        _buyExactIn(key, token, 200e6, address(router));
        hook.dispatch(id);
        uint256 owed = token.dividendOf(address(bunker));
        assertGt(owed, 0);
        // Only the holder claims its dividends.
        assertEq(token.claimTo(address(this)), 0);
        uint256 before = IERC20(USDG).balanceOf(address(buyer));
        uint256 g = gasleft();
        bunker.spend(5, next, params, signature);
        console.log("gas vault ClaimDividend", g - gasleft());
        assertEq(IERC20(USDG).balanceOf(address(buyer)) - before, owed);
        assertEq(IERC20(USDG).balanceOf(address(bunker)), 0);
        assertEq(token.dividendOf(address(bunker)), 0);
        assertEq(bunker.nonce(), 1);
    }
}
