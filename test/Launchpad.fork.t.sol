// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraAirdrop} from "../src/launchpad/OstraAirdrop.sol";
import {OstraCreatorSplit} from "../src/launchpad/OstraCreatorSplit.sol";
import {OstraDevBuy} from "../src/launchpad/OstraDevBuy.sol";
import {OstraDispatcher} from "../src/launchpad/OstraDispatcher.sol";
import {OstraFees} from "../src/launchpad/OstraFees.sol";
import {OstraHook} from "../src/launchpad/OstraHook.sol";
import {OstraLaunchpad} from "../src/launchpad/OstraLaunchpad.sol";
import {OstraLocker} from "../src/launchpad/OstraLocker.sol";
import {OstraToken} from "../src/launchpad/OstraToken.sol";
import {OstraVesting} from "../src/launchpad/OstraVesting.sol";
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

/// @dev A Robinhood stock token (AAPL at 0xaF3D...93f9): a beacon proxy whose beacon is also its access registry.
///      Selectors read from the deployed implementation (0xb354...5aE2) and registry bytecode.
interface IRobinhoodStockToken {
    function pause() external;
    function unpause() external;
    function tokenPaused() external view returns (bool);
    function ACCESS_CONTROLLED_REGISTRY() external pure returns (address);
}

interface IRobinhoodStockRegistry {
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function blockAccounts(address[] calldata accounts) external;
    function unblockAccounts(address[] calldata accounts) external;
    function isBlocked(address account) external view returns (bool);
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

/// @notice One transaction: a router swap, then a dispatch of the pool (anyone may call it).
contract SwapThenDispatch {
    function run(TestSwapRouter router, OstraDispatcher dispatcher, PoolKey memory key, bool zeroForOne, int256 amount)
        external
    {
        router.swap(key, zeroForOne, amount, address(router));
        dispatcher.dispatch(key.toId());
    }
}

/// @notice The Ostra launchpad, locker, token and hook on a fork of Robinhood Chain mainnet, against the deployed
///         Uniswap v4 PoolManager, USDG and WETH. Swaps go through a plain PoolManager client and through an
///         OstraVault's Swap action.
contract LaunchpadForkTest is Test {
    using StateLibrary for IPoolManager;

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
    OstraFees internal fees;
    OstraCreatorSplit internal split;
    OstraDispatcher internal dispatcher;
    OstraLocker internal locker;
    OstraLaunchpad internal launchpad;
    OstraDevBuy internal devBuy;
    OstraAirdrop internal airdrop;
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
        fees = new OstraFees();
        bytes32 initHash = keccak256(abi.encodePacked(type(OstraHook).creationCode, abi.encode(POOL_MANAGER, WETH, address(fees), address(this))));
        bytes32 salt;
        for (uint256 i = 0; i < 500_000; ++i) {
            address a = vm.computeCreate2Address(bytes32(i), initHash, address(this));
            if (uint160(a) & 0x3FFF == HOOK_FLAGS) {
                salt = bytes32(i);
                break;
            }
        }
        hook = new OstraHook{salt: salt}(POOL_MANAGER, WETH, address(fees), address(this));
        assertEq(uint160(address(hook)) & 0x3FFF, HOOK_FLAGS);
        launchpad = new OstraLaunchpad(POOL_MANAGER, address(hook), WETH, address(this));
        split = new OstraCreatorSplit(address(hook));
        dispatcher = new OstraDispatcher(POOL_MANAGER, address(hook), WETH, address(split), address(this));
        locker = new OstraLocker(POOL_MANAGER, address(launchpad), address(dispatcher));
        devBuy = new OstraDevBuy(POOL_MANAGER, address(launchpad));
        airdrop = new OstraAirdrop(address(hook));
        hook.initialize(address(launchpad), address(locker), address(dispatcher), address(devBuy), address(airdrop));
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
        return IERC6909Balance(POOL_MANAGER).balanceOf(address(dispatcher), c.toId());
    }

    /// @dev creatorPaid of the Dispatched event in the recorded logs.
    function _creatorPaid() internal returns (uint256 paid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = OstraDispatcher.Dispatched.selector;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(dispatcher) && logs[i].topics[0] == topic) {
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
        p.maxTxMoveTicks = 999;
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "maxTxMove"));
        launchpad.launch{value: fee}(p);
        p.maxTxMoveTicks = 6_933;
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "maxTxMove"));
        launchpad.launch{value: fee}(p);
        p.maxTxMoveTicks = 0;
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
        uint256 shares0 = _protocolShares(usdg);
        uint256 before = gasleft();
        BalanceDelta d = _buyExactIn(key, token, 100e6, address(router));
        console.log("gas buy exact input", before - gasleft());
        int128 paid = tokenIs0 ? d.amount1() : d.amount0();
        assertEq(paid, -100e6);
        assertEq(_claims(usdg) - claims0, 4e6);
        // Hook fee 1e6: 70% creator, 30% protocol, half of that kept for buyback (booked per currency at swap time).
        assertEq(_protocolShares(usdg) - shares0, (uint256(0.15e6) << 128) | 0.15e6);
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

    /// @dev The hook's booked protocol share in `c`: protocol << 128 | buyback.
    function _protocolShares(Currency c) internal view returns (uint256) {
        (uint128 protocol, uint128 buyback) = hook.protocolShare(c);
        return (uint256(protocol) << 128) | buyback;
    }

    /// @dev Whether the dispatcher emitted an event with `topic` in the recorded logs.
    function _dispatcherEmitted(bytes32 topic) internal returns (bool found) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(dispatcher) && logs[i].topics[0] == topic) found = true;
        }
    }

    function _claimProtocolAndBuyback() internal {
        OstraVault operator = _vault(USDG, keccak256("OSTRA/EVM/TEST/operator-vault"));
        (uint128 bookedProtocol, uint128 bookedBuyback) = hook.protocolShare(Currency.wrap(USDG));
        uint256 owedProtocol = dispatcher.protocolOwed(Currency.wrap(USDG));
        assertGt(owedProtocol, bookedProtocol, "the hook fee's share plus 15% of the locked positions' LP fees");
        dispatcher.claimProtocol(Currency.wrap(USDG), address(operator));
        assertEq(IERC20(USDG).balanceOf(address(operator)), owedProtocol);
        assertEq(dispatcher.protocolOwed(Currency.wrap(USDG)), 0);
        (bookedProtocol,) = hook.protocolShare(Currency.wrap(USDG));
        assertEq(bookedProtocol, 0);
        // The buyback part goes to the account that buys OSTRA and burns it.
        address buybacker = makeAddr("OSTRA buyback");
        uint256 owedBuyback = dispatcher.buybackOwed(Currency.wrap(USDG));
        assertGt(owedBuyback, bookedBuyback);
        dispatcher.claimBuyback(Currency.wrap(USDG), buybacker);
        assertEq(IERC20(USDG).balanceOf(buybacker), owedBuyback);
        vm.expectRevert(OstraDispatcher.NothingToClaim.selector);
        dispatcher.claimBuyback(Currency.wrap(USDG), buybacker);
        vm.prank(makeAddr("not the owner"));
        vm.expectRevert();
        dispatcher.claimProtocol(Currency.wrap(USDG), buybacker);
    }

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
        dispatcher.dispatch(id);
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
        // The protocol's share goes to the operator's vault, the buyback part to the OSTRA buyback.
        _claimProtocolAndBuyback();
        // A second dispatch right away has little left to do and still works.
        dispatcher.dispatch(id);
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
        bytes memory params = _swapParams(key, !tokenIs0, 20e6, 1, address(bunker));
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
        dispatcher.dispatch(id);
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
        dispatcher.dispatch(id);
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

    /// @dev OstraVault Swap params without a referrer, with 1M gas for the swap.
    function _swapParams(PoolKey memory key, bool zeroForOne, uint128 amountIn, uint128 minOut, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(key, zeroForOne, amountIn, minOut, recipient, address(0), uint32(1_000_000));
    }

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
        _configureReverts(creatorVault, id, 10, 0, OstraHook.BadField.selector);

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
        // Released already (as after a graduation or past the limits' end): a release signed before that still lands,
        // changing nothing, so the creator vault's key is never held by it.
        uint64 nonceBefore = creatorVault.nonce();
        uint40 endBefore = hook.poolConfig(id).limitsEndAt;
        _configure(creatorVault, id, 7, 0);
        assertEq(creatorVault.nonce(), nonceBefore + 1);
        assertEq(hook.poolConfig(id).limitsEndAt, endBefore);
        assertTrue(token.limitsReleased());
        _configureReverts(creatorVault, id, 7, 1, OstraHook.NotInTradersFavour.selector);
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
        _spend(buyer, BUYER, 3, _swapParams(key, Currency.unwrap(key.currency0) != address(token), 20e6, 1, address(bunker)));
        assertGe(token.balanceOf(address(bunker)), token.MIN_DIVIDEND_BALANCE());

        // Nothing owed yet: the signed claim reverts and keeps its key, to be sent again later.
        bytes memory params = abi.encode(address(buyer));
        bytes32 next = WotsSigner.keyRoot(_seed(BUYER_TOKEN, 1));
        bytes memory signature = WotsSigner.sign(_seed(BUYER_TOKEN, 0), bunker.spendMessage(5, next, params));
        vm.expectRevert(OstraVault.ZeroAmount.selector);
        bunker.spend(5, next, params, signature);

        deal(USDG, address(router), 1_000e6);
        _buyExactIn(key, token, 200e6, address(router));
        dispatcher.dispatch(id);
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

    // ---------------------------------------------------------------------------------------------
    // A stock token as the quote (AAPL)
    // ---------------------------------------------------------------------------------------------

    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address internal constant AAPL_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    /// @dev Holders of the issuer's roles (RoleGranted logs of the registry; each call checked on mainnet with
    ///      eth_call from the holder): pausing the token, pausing the registry, blocking accounts.
    address internal constant AAPL_TOKEN_PAUSER = 0xFCcF56B674113d9C4eb0F9B3370930ceD9E6Ab23;
    address internal constant AAPL_REGISTRY_PAUSER = 0xe7BCB188254Bc6eBBfF63014DfED4cD4A024F22A;
    address internal constant AAPL_BLOCKER = 0x913cA87347391218e5De2C17c5A0AEba8B0b28fD;
    bytes32 internal constant CREATOR_AAPL = keccak256("OSTRA/EVM/TEST/creator-aapl-vault");

    function _one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    function test_aStockTokenPoolTradesAndPaysTheCreatorInTheStock() public {
        assertEq(IRobinhoodStockToken(AAPL).ACCESS_CONTROLLED_REGISTRY(), AAPL_REGISTRY);
        OstraVault creatorVault = _vault(AAPL, CREATOR_AAPL);
        // TEST/AAPL starting at 2e-7 AAPL a token (both 18 decimals: tick -154,200), a 200 AAPL market cap,
        // graduation at 5 AAPL raised.
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(AAPL), address(creatorVault), -154_200, bytes32(uint256(14)));
        p.name = "Test";
        p.symbol = "TEST";
        p.graduationThreshold = 5e18;
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        OstraToken token = OstraToken(t);
        assertEq(token.symbol(), "TEST");
        PoolKey memory key = hook.poolKey(id);
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        assertEq(Currency.unwrap(tokenIs0 ? key.currency1 : key.currency0), AAPL);
        Currency aapl = Currency.wrap(AAPL);
        vm.warp(block.timestamp + 601);
        deal(AAPL, address(router), 20e18);

        // A buy of 1 AAPL pays 1% hook fee + 3% buy tax in AAPL.
        address holder = makeAddr("TEST holder");
        uint256 claims0 = _claims(aapl);
        BalanceDelta d = _buyExactIn(key, token, 1e18, holder);
        assertEq(tokenIs0 ? d.amount1() : d.amount0(), -1e18);
        assertEq(_claims(aapl) - claims0, 0.04e18);
        assertGt(token.balanceOf(holder), 0);
        _buyExactIn(key, token, 1e18, address(router));
        uint256 aaplBefore = IERC20(AAPL).balanceOf(address(router));
        router.swap(key, tokenIs0, -int256(token.balanceOf(address(router)) / 2), address(router));
        assertGt(IERC20(AAPL).balanceOf(address(router)), aaplBefore, "a sell pays out AAPL");

        // Dispatch pays the creator vault in AAPL; the vault spends it with its WOTS key.
        vm.recordLogs();
        dispatcher.dispatch(id);
        uint256 paid = _creatorPaid();
        assertGt(paid, 0);
        assertEq(IERC20(AAPL).balanceOf(address(creatorVault)), paid);
        _spend(creatorVault, CREATOR_AAPL, 0, abi.encode(makeAddr("creator out"), paid));
        assertEq(IERC20(AAPL).balanceOf(makeAddr("creator out")), paid);
        assertGt(token.dividendOf(holder), 0);

        // The issuer's controls reach the pool. A paused token stops every swap until it is unpaused.
        vm.prank(AAPL_TOKEN_PAUSER);
        IRobinhoodStockToken(AAPL).pause();
        assertTrue(IRobinhoodStockToken(AAPL).tokenPaused());
        vm.expectRevert();
        router.swap(key, !tokenIs0, -0.1e18, holder);
        vm.prank(AAPL_TOKEN_PAUSER);
        IRobinhoodStockToken(AAPL).unpause();
        _buyExactIn(key, token, 0.1e18, holder);

        // So does a paused registry.
        vm.prank(AAPL_REGISTRY_PAUSER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).pause();
        assertTrue(IRobinhoodStockRegistry(AAPL_REGISTRY).paused());
        vm.expectRevert();
        router.swap(key, !tokenIs0, -0.1e18, holder);
        vm.prank(AAPL_REGISTRY_PAUSER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).unpause();
        _buyExactIn(key, token, 0.1e18, holder);

        // A blocked trader can neither pay nor be paid AAPL; others still trade.
        vm.prank(AAPL_BLOCKER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).blockAccounts(_one(address(router)));
        assertTrue(IRobinhoodStockRegistry(AAPL_REGISTRY).isBlocked(address(router)));
        vm.expectRevert();
        router.swap(key, !tokenIs0, -0.1e18, holder);
        TestSwapRouter other = new TestSwapRouter(POOL_MANAGER);
        deal(AAPL, address(other), 1e18);
        other.swap(key, !tokenIs0, -0.1e18, holder);
        vm.prank(AAPL_BLOCKER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).unblockAccounts(_one(address(router)));
        _buyExactIn(key, token, 0.1e18, holder);

        // A blocked PoolManager freezes the pool for everyone until it is unblocked.
        vm.prank(AAPL_BLOCKER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).blockAccounts(_one(POOL_MANAGER));
        vm.expectRevert();
        other.swap(key, !tokenIs0, -0.1e18, holder);
        vm.prank(AAPL_BLOCKER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).unblockAccounts(_one(POOL_MANAGER));
        other.swap(key, !tokenIs0, -0.1e18, holder);
    }

    // ---------------------------------------------------------------------------------------------
    // The LP fee (OstraFees): the session fee, the volatility fee, the MEV surcharge
    // ---------------------------------------------------------------------------------------------

    bytes32 internal constant SWAP_EVENT = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    /// @dev The LP fee (pips) of the last PoolManager Swap event in the recorded logs: what the swap paid.
    function _swapFee() internal returns (uint24 fee) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == POOL_MANAGER && logs[i].topics[0] == SWAP_EVENT) {
                (,,,,, fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                found = true;
            }
        }
        assertTrue(found, "no Swap event");
    }

    /// @dev The first time from now, at `hourUtc` on a later day, at which the stock market is closed (or open).
    function _nextTime(bool closed, uint256 hourUtc) internal view returns (uint256 t) {
        t = (block.timestamp / 1 days + 1) * 1 days + hourUtc * 1 hours;
        while (fees.nyseClosed(t) != closed) t += 1 days;
    }

    function _routerBuy(PoolKey memory key, OstraToken token, uint256 quoteIn, address origin) internal returns (uint24) {
        vm.recordLogs();
        vm.prank(origin, origin);
        _buyExactIn(key, token, quoteIn, address(router));
        return _swapFee();
    }

    function _routerSell(PoolKey memory key, OstraToken token, uint256 tokensIn, address origin) internal returns (uint24) {
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.recordLogs();
        vm.prank(origin, origin);
        router.swap(key, tokenIs0, -int256(tokensIn), address(router));
        return _swapFee();
    }

    function test_aStockPoolPaysTheClosedSessionFeeOnlyWhileTheMarketIsClosed() public {
        OstraVault creatorVault = _vault(AAPL, CREATOR_AAPL);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(AAPL), address(creatorVault), -154_200, bytes32(uint256(20)));
        p.name = "Test";
        p.symbol = "TEST";
        p.graduationThreshold = 5e18;
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        OstraToken token = OstraToken(t);
        PoolKey memory key = hook.poolKey(id);
        assertTrue(hook.poolConfig(id).stockQuote, "AAPL is detected as a stock token");
        (OstraToken usdgToken, PoolKey memory usdgKey,) = _launchUsdg(bytes32(uint256(21)));
        assertFalse(hook.poolConfig(usdgKey.toId()).stockQuote);
        assertFalse(launchpad.isStockToken(USDG));
        assertFalse(launchpad.isStockToken(address(0)));
        assertTrue(launchpad.isStockToken(0x322F0929c4625eD5bAd873c95208D54E1c003b2d)); // TSLA
        deal(AAPL, address(router), 10e18);
        deal(USDG, address(router), 1_000e6);
        address trader = makeAddr("session trader");

        // A weekday, the market open (16:00 UTC is 11:00 or 12:00 ET): the base fee.
        vm.warp(_nextTime(false, 16));
        assertEq(fees.lpFeeOf(hook, id), 2_500);
        assertEq(_routerBuy(key, token, 0.1e18, trader), 2_500);

        // The market closed (a weekend day or a holiday): 0.50% in the stock pool, the base fee elsewhere.
        vm.warp(_nextTime(true, 16));
        assertEq(fees.lpFeeOf(hook, id), 5_000);
        vm.expectEmit(true, false, false, true, address(hook));
        emit OstraHook.LpFeeCharged(id, 5_000, 0);
        _routerBuy(key, token, 0.1e18, trader);
        assertEq(_routerBuy(key, token, 0.1e18, trader), 5_000);
        assertEq(fees.lpFeeOf(hook, usdgKey.toId()), 2_500);
        assertEq(_routerBuy(usdgKey, usdgToken, 10e6, trader), 2_500);

        // Open again.
        vm.warp(_nextTime(false, 16));
        assertEq(_routerBuy(key, token, 0.1e18, trader), 2_500);
    }

    function test_theVolatilityFeeFollowsThePriceAndTheCreatorCanOnlyTurnItOff() public {
        OstraVault creatorVault = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(creatorVault), -375_400, bytes32(uint256(22)));
        p.volatilityFee = true;
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        OstraToken token = OstraToken(t);
        PoolKey memory key = hook.poolKey(id);
        assertTrue(hook.poolConfig(id).volatilityFee);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 5_000e6);
        address trader = makeAddr("volatility trader");

        // The first swap starts the EMA at the pool's price: the base fee.
        assertEq(_routerBuy(key, token, 1e6, trader), 2_500);
        // A large buy in the same second moves the price; the next swap, priced against the unmoved EMA, pays up to 1%.
        _routerBuy(key, token, 400e6, trader);
        OstraFees.FeeState memory st = fees.unpack(hook.feeState(id));
        uint24 expected = fees.lpFeeOf(hook, id);
        assertGt(expected, 2_500);
        assertEq(_routerBuy(key, token, 1e6, trader), expected);
        assertEq(st.emaAt, block.timestamp);
        // The price holds: after an hour the EMA has caught up, the fee is the base again.
        vm.warp(block.timestamp + 64 * 60);
        assertEq(fees.lpFeeOf(hook, id), 2_500);
        assertEq(_routerBuy(key, token, 1e6, trader), 2_500);

        // The creator turns it off; it cannot be turned on, or off twice.
        _configure(creatorVault, id, hook.FIELD_VOLATILITY_FEE(), 0);
        assertFalse(hook.poolConfig(id).volatilityFee);
        _configureReverts(creatorVault, id, hook.FIELD_VOLATILITY_FEE(), 0, OstraHook.NotInTradersFavour.selector);
        _configureReverts(creatorVault, id, hook.FIELD_VOLATILITY_FEE(), 1, OstraHook.NotInTradersFavour.selector);
        vm.warp(block.timestamp + 1);
        _routerBuy(key, token, 400e6, trader);
        assertEq(_routerBuy(key, token, 1e6, trader), 2_500);
    }

    function test_onlyAnActorReversingItsOwnSwapWithinTheSecondPaysTheMevSurcharge() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(23)));
        PoolId id = key.toId();
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.warp(_nextTime(false, 16));
        deal(USDG, address(router), 5_000e6);
        address bot = makeAddr("sandwich bot");
        address user = makeAddr("user");
        // Tokens for the sells, bought in an earlier second.
        _routerBuy(key, token, 500e6, user);
        vm.warp(block.timestamp + 1);

        // The bot's front-run opens the second; a user's buy moves the price on.
        assertEq(_routerBuy(key, token, 200e6, bot), 2_500);
        assertEq(_routerBuy(key, token, 200e6, user), 2_500);
        // The user selling back pays the base fee: it is not the second's first actor.
        assertEq(_routerSell(key, token, 1_000_000e18, user), 2_500);
        // The bot's back-run pays the surcharge for the move since its own first swap.
        uint24 surcharge = fees.mevSurchargeOf(hook, id, bot, address(router), tokenIs0);
        assertGt(surcharge, 0);
        assertLe(surcharge, fees.MAX_MEV_SURCHARGE());
        vm.expectEmit(true, false, false, true, address(hook));
        emit OstraHook.LpFeeCharged(id, 2_500, surcharge);
        assertEq(_routerSell(key, token, 1_000_000e18, bot), 2_500 + surcharge);
        // The next second, nothing.
        vm.warp(block.timestamp + 1);
        assertEq(fees.mevSurchargeOf(hook, id, bot, address(router), tokenIs0), 0);

        // Two Ostra vaults relayed by the same sender are two actors: a buy and a sell in one second pay the base fee.
        address relayer = makeAddr("relayer account");
        OstraVault buyer = _vault(USDG, BUYER);
        OstraVault bunker = _vault(address(token), BUYER_TOKEN);
        deal(USDG, address(buyer), 100e6);
        vm.prank(relayer, relayer);
        _spend(buyer, BUYER, 3, _swapParams(key, !tokenIs0, 20e6, 1, address(bunker)));
        vm.warp(block.timestamp + 1);
        vm.recordLogs();
        vm.prank(relayer, relayer);
        _spend(buyer, BUYER, 3, _swapParams(key, !tokenIs0, 20e6, 1, address(bunker)));
        assertEq(_swapFee(), 2_500);
        uint128 sell = uint128(token.balanceOf(address(bunker)) / 4);
        vm.recordLogs();
        vm.prank(relayer, relayer);
        _spend(bunker, BUYER_TOKEN, 3, _swapParams(key, tokenIs0, sell, 1, address(buyer)));
        assertEq(_swapFee(), 2_500);
    }

    // ---------------------------------------------------------------------------------------------
    // Blocks: the creator split and the floor bid (OstraDispatcher, OstraCreatorSplit)
    // ---------------------------------------------------------------------------------------------

    function _shareValue(address recipient, uint256 bps) internal pure returns (uint256) {
        return uint256(uint160(recipient)) | (bps << 160);
    }

    function _setShare(OstraVault creatorVault, PoolId id, address recipient, uint256 bps) internal {
        _spend(creatorVault, CREATOR, 4, abi.encode(address(split), PoolId.unwrap(id), uint8(0), _shareValue(recipient, bps)));
    }

    function _setShareReverts(OstraVault creatorVault, PoolId id, uint8 field, uint256 value, bytes4 err) internal {
        uint64 n = creatorVault.nonce();
        bytes memory params = abi.encode(address(split), PoolId.unwrap(id), field, value);
        bytes32 next = WotsSigner.keyRoot(_seed(CREATOR, n + 1));
        bytes memory signature = WotsSigner.sign(_seed(CREATOR, n), creatorVault.spendMessage(4, next, params));
        vm.expectRevert(err);
        creatorVault.spend(4, next, params, signature);
    }

    function _recipient(uint256 i) internal pure returns (address) {
        return address(uint160(0x05917000 + i));
    }

    function _dispatchPaid(PoolId id) internal returns (uint256) {
        vm.recordLogs();
        dispatcher.dispatch(id);
        return _creatorPaid();
    }

    function test_onlyTheDispatcherTakesAndRestoresAPoolsBookedAmounts() public {
        (, PoolKey memory key,) = _launchUsdg(bytes32(uint256(29)));
        OstraHook.Pending memory none;
        vm.expectRevert(OstraHook.OnlyDispatcher.selector);
        hook.takePending(key.toId());
        vm.expectRevert(OstraHook.OnlyDispatcher.selector);
        hook.restorePending(key.toId(), none);
        vm.expectRevert(OstraCreatorSplit.OnlyDispatcher.selector);
        split.credit(key.toId(), USDG, address(this), 1);
    }

    function test_theCreatorSplitSharesPayoutsAmongAHundredRecipientsAndChangesAnytime() public {
        (OstraToken token, PoolKey memory key, OstraVault creatorVault) = _launchUsdg(bytes32(uint256(30)));
        PoolId id = key.toId();
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 5_000e6);

        // Only the creator vault, through a ConfigurePool spend at the split.
        vm.expectRevert(OstraCreatorSplit.OnlyCreatorVault.selector);
        split.configure(PoolId.unwrap(id), 0, _shareValue(_recipient(0), 50));
        // 100 recipients at 50 bps each: half of the payouts; the creator vault keeps the rest. A 101st is refused.
        for (uint256 i = 0; i < 100; ++i) {
            _setShare(creatorVault, id, _recipient(i), 50);
        }
        assertEq(split.recipientCount(id), 100);
        assertEq(split.shareOf(id, address(creatorVault)), 5_000);
        _setShareReverts(creatorVault, id, 0, _shareValue(_recipient(100), 50), OstraCreatorSplit.TooManyRecipients.selector);
        _setShareReverts(creatorVault, id, 0, _shareValue(address(0), 50), OstraCreatorSplit.BadShare.selector);
        _setShareReverts(creatorVault, id, 0, _shareValue(address(creatorVault), 50), OstraCreatorSplit.BadShare.selector);
        _setShareReverts(creatorVault, id, 0, _shareValue(_recipient(0), 50), OstraCreatorSplit.BadShare.selector);
        _setShareReverts(creatorVault, id, 0, _shareValue(_recipient(0), 5_051), OstraCreatorSplit.BadShare.selector);
        _setShareReverts(creatorVault, id, 1, _shareValue(_recipient(0), 60), OstraCreatorSplit.BadField.selector);

        // A payout goes through the split: 50 bps to each recipient, 50% to the creator vault.
        _buyExactIn(key, token, 200e6, makeAddr("split buyer"));
        uint256 paid = _dispatchPaid(id);
        assertGt(paid, 0);
        assertEq(IERC20(USDG).balanceOf(address(creatorVault)), 0);
        assertEq(IERC20(USDG).balanceOf(address(split)), paid);
        assertApproxEqAbs(split.owedOf(id, _recipient(7)), (paid * 50) / 10_000, 1);
        assertApproxEqAbs(split.owedOf(id, address(creatorVault)), paid / 2, 1);
        // Anyone releases, always to the account.
        uint256 owed7 = split.owedOf(id, _recipient(7));
        split.release(id, _recipient(7));
        assertEq(IERC20(USDG).balanceOf(_recipient(7)), owed7);
        assertEq(split.owedOf(id, _recipient(7)), 0);

        // The creator vault raises one share and removes another; what was paid before stays at the old shares.
        uint256 owed1 = split.owedOf(id, _recipient(1));
        uint256 owed2 = split.owedOf(id, _recipient(2));
        _setShare(creatorVault, id, _recipient(1), 500);
        _setShare(creatorVault, id, _recipient(2), 0);
        assertEq(split.recipientCount(id), 99);
        assertEq(split.shareOf(id, address(creatorVault)), 10_000 - 98 * 50 - 500);
        assertEq(split.owedOf(id, _recipient(1)), owed1);
        assertEq(split.owedOf(id, _recipient(2)), owed2);
        uint256 vaultOwed = split.owedOf(id, address(creatorVault));

        _buyExactIn(key, token, 200e6, makeAddr("split buyer 2"));
        uint256 paid2 = _dispatchPaid(id);
        assertApproxEqAbs(split.owedOf(id, _recipient(1)) - owed1, (paid2 * 500) / 10_000, 1);
        assertEq(split.owedOf(id, _recipient(2)), owed2, "a removed recipient earns nothing more");
        assertApproxEqAbs(split.owedOf(id, address(creatorVault)) - vaultOwed, (paid2 * 4_600) / 10_000, 1);
        // The removed recipient still releases what it earned; the creator vault releases its share.
        split.release(id, _recipient(2));
        assertEq(IERC20(USDG).balanceOf(_recipient(2)), owed2);
        uint256 vaultAll = split.owedOf(id, address(creatorVault));
        split.release(id, address(creatorVault));
        assertEq(IERC20(USDG).balanceOf(address(creatorVault)), vaultAll);
        // Everything owed is covered by what the split holds.
        uint256 left;
        for (uint256 i = 0; i < 100; ++i) {
            left += split.owedOf(id, _recipient(i));
        }
        assertLe(left, IERC20(USDG).balanceOf(address(split)));
        assertLe(IERC20(USDG).balanceOf(address(split)) - left, 200, "rounding dust only");
        (address[] memory list, uint16[] memory bps) = split.recipients(id);
        assertEq(list.length, 99);
        assertEq(bps.length, 99);
    }

    function test_withoutRecipientsTheCreatorVaultIsPaidDirectly() public {
        (OstraToken token, PoolKey memory key, OstraVault creatorVault) = _launchUsdg(bytes32(uint256(31)));
        PoolId id = key.toId();
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 5_000e6);
        _setShare(creatorVault, id, _recipient(0), 2_000);
        _buyExactIn(key, token, 200e6, makeAddr("buyer one"));
        uint256 paid = _dispatchPaid(id);
        _setShare(creatorVault, id, _recipient(0), 0);
        assertEq(split.recipientCount(id), 0);
        _buyExactIn(key, token, 200e6, makeAddr("buyer two"));
        uint256 paid2 = _dispatchPaid(id);
        assertEq(IERC20(USDG).balanceOf(address(creatorVault)), paid2, "paid straight to the vault");
        // What the split held from the first payout is still released at the shares of that time.
        split.release(id, _recipient(0));
        split.release(id, address(creatorVault));
        assertApproxEqAbs(IERC20(USDG).balanceOf(_recipient(0)), (paid * 2_000) / 10_000, 1);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(creatorVault)), paid2 + (paid * 8_000) / 10_000, 1);
    }

    function _tickOf(PoolId id) internal view returns (int24 tick) {
        (, tick,,) = pm.getSlot0(id);
    }

    function _floorPool(bytes32 salt) internal returns (OstraToken token, PoolKey memory key, PoolId id, bool tokenIs0) {
        OstraVault v = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(v), -375_400, salt);
        // Only the creator and floor buckets: no conversion buy of the dispatch moves the price before the bid's step.
        p.creatorBucketBps = 5_000;
        p.dividendBucketBps = 0;
        p.burnBucketBps = 0;
        p.lpBucketBps = 0;
        p.floorBucketBps = 5_000;
        p.dividendToken = address(0);
        p.graduationThreshold = 100_000e6; // the launch rules hold for the whole test
        p.maxWallet = 0; // the test router holds what it trades
        address t;
        (t, id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        token = OstraToken(t);
        key = hook.poolKey(id);
        tokenIs0 = Currency.unwrap(key.currency0) == address(token);
    }

    /// @dev The floor bid recorded by the dispatcher is its position at the range the current price calls for.
    function _assertFloorAtPrice(PoolId id, bool tokenIs0) internal view returns (int24 lower, int24 upper, uint128 liquidity) {
        (lower, upper, liquidity,) = dispatcher.floorBid(id);
        assertGt(liquidity, 0);
        (int24 wantLower, int24 wantUpper) = dispatcher.floorRange(id);
        assertEq(lower, wantLower);
        assertEq(upper, wantUpper);
        assertEq(upper - lower, 200);
        int24 tick = _tickOf(id);
        // On the quote side of the price, so the position holds only quote.
        if (tokenIs0) assertLe(upper, tick);
        else assertGt(lower, tick);
        (uint128 posLiquidity,,) = pm.getPositionInfo(id, address(dispatcher), lower, upper, dispatcher.FLOOR_SALT());
        assertEq(posLiquidity, liquidity);
    }

    function _floorBurned() internal returns (bool moved, uint256 burned) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(dispatcher) && logs[i].topics[0] == OstraDispatcher.FloorBidSet.selector) {
                (,,, burned) = abi.decode(logs[i].data, (int24, int24, uint128, uint256));
                moved = true;
            }
        }
    }

    function test_theFloorBidBuysBelowThePriceBurnsWhatItBoughtAndFollowsThePrice() public {
        (OstraToken token, PoolKey memory key, PoolId id, bool tokenIs0) = _floorPool(bytes32(uint256(32)));
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 5_000e6);
        for (uint256 i = 0; i < 4; ++i) {
            _buyExactIn(key, token, 200e6, address(router));
        }
        assertGt(hook.pending(id).floor, 0);

        // The first dispatch puts the whole bucket in the spacing next to the price, on the quote side.
        dispatcher.dispatch(id);
        (int24 lower, int24 upper, uint128 liquidity) = _assertFloorAtPrice(id, tokenIs0);
        assertLe(hook.pending(id).floor, 2, "the whole bucket is in the bid");

        // Sells walk the price down into the bid: while the price is inside it, dispatch leaves it alone.
        for (uint256 i = 0; i < 200; ++i) {
            int24 t = _tickOf(id);
            if (t >= lower && t < upper) break;
            router.swap(key, tokenIs0, -20_000e18, address(router));
        }
        {
            int24 t = _tickOf(id);
            assertTrue(t >= lower && t < upper, "the price is inside the bid");
        }
        dispatcher.dispatch(id);
        {
            (int24 l2, int24 u2, uint128 liq2,) = dispatcher.floorBid(id);
            assertEq(l2, lower);
            assertEq(u2, upper);
            assertEq(liq2, liquidity);
        }
        assertGt(hook.pending(id).floor, 0, "the sells' floor tax waits for the price to leave the bid");

        // The price falls through the bid (it buys tokens), then buys lift it above: dispatch burns what the bid
        // bought and sets a new bid at the new price.
        router.swap(key, tokenIs0, -1_000_000e18, address(router));
        _buyExactIn(key, token, 300e6, address(router));
        _buyExactIn(key, token, 300e6, address(router));
        uint256 supply = token.totalSupply();
        vm.recordLogs();
        dispatcher.dispatch(id);
        (bool moved, uint256 burned) = _floorBurned();
        assertTrue(moved);
        assertGt(burned, 0, "the bid bought tokens and they are burned");
        assertLe(token.totalSupply(), supply - burned);
        (int24 l3,, uint128 liq3,) = dispatcher.floorBid(id);
        assertGt(liq3, 0);
        assertTrue(l3 != lower, "moved with the price");
        (uint128 oldLiquidity,,) = pm.getPositionInfo(id, address(dispatcher), lower, upper, dispatcher.FLOOR_SALT());
        assertEq(oldLiquidity, 0, "the old bid is gone");
    }

    function test_theFloorBidFollowsARisingPriceOneSpacingAMinute() public {
        (OstraToken token, PoolKey memory key, PoolId id, bool tokenIs0) = _floorPool(bytes32(uint256(34)));
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 10_000e6);
        for (uint256 i = 0; i < 4; ++i) {
            _buyExactIn(key, token, 200e6, address(router));
        }
        dispatcher.dispatch(id);
        (int24 lower,,) = _assertFloorAtPrice(id, tokenIs0);
        // A pump of many spacings: each dispatch lifts the bid by one spacing, never to the pumped price at once.
        for (uint256 i = 0; i < 6; ++i) {
            _buyExactIn(key, token, 400e6, address(router));
        }
        (int24 target,) = dispatcher.floorRange(id);
        assertGt(tokenIs0 ? target - lower : lower - target, 600, "the pump moved the price several spacings");
        int24 step = tokenIs0 ? int24(200) : int24(-200);
        for (int24 n = 1; n <= 3; ++n) {
            vm.warp(block.timestamp + dispatcher.FLOOR_STEP_INTERVAL());
            dispatcher.dispatch(id);
            // Dispatching again at once does not lift it again.
            dispatcher.dispatch(id);
            dispatcher.dispatch(id);
            (int24 l, int24 u, uint128 liq,) = dispatcher.floorBid(id);
            assertEq(l, lower + n * step);
            assertEq(u, l + 200);
            assertGt(liq, 0);
            int24 t = _tickOf(id);
            assertTrue(t < l || t >= u, "the step stays outside the price");
        }
    }

    function test_aOneWeiLpBucketNeverStopsTheDispatch() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(35)));
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 1_000e6);
        // A buy of 150 wei pays a fee of 6 wei, 5 of it tax: the LP bucket gets 1 wei (half of it is 0).
        _buyExactIn(key, token, 150, address(router));
        assertEq(hook.pending(key.toId()).lp, 1);
        dispatcher.dispatch(key.toId());
        dispatcher.dispatch(key.toId());
    }

    function test_aDividendPoolWithAnotherHookIsRefused() public {
        OstraVault v = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(v), -375_400, bytes32(uint256(36)));
        p.dividendToken = AAPL;
        p.dividendKey = PoolKey({
            currency0: Currency.wrap(USDG),
            currency1: Currency.wrap(AAPL),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(makeAddr("another hook"))
        });
        uint256 fee = launchpad.LAUNCH_FEE();
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "dividendKey"));
        launchpad.launch{value: fee}(p);
        p.dividendKey.hooks = IHooks(address(0));
        launchpad.launch{value: fee}(p);
    }

    function test_aCreatorPayoutTheTokenRefusesWaitsAndTheRestIsPaid() public {
        OstraVault creatorVault = _vault(AAPL, CREATOR_AAPL);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(AAPL), address(creatorVault), -154_200, bytes32(uint256(37)));
        p.graduationThreshold = 5e18;
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        OstraToken token = OstraToken(t);
        PoolKey memory key = hook.poolKey(id);
        vm.warp(block.timestamp + 601);
        deal(AAPL, address(router), 20e18);
        _buyExactIn(key, token, 1e18, makeAddr("TEST holder"));
        uint256 creatorShare = hook.pending(id).creator;
        assertGt(creatorShare, 0);

        // The issuer blocks the creator vault: the payout waits, and the burn, the LP bucket and the dividends go on.
        vm.prank(AAPL_BLOCKER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).blockAccounts(_one(address(creatorVault)));
        uint256 supply = token.totalSupply();
        vm.recordLogs();
        dispatcher.dispatch(id);
        assertTrue(_dispatcherEmitted(OstraDispatcher.CreatorPayoutDeferred.selector));
        assertGe(hook.pending(id).creator, creatorShare, "the creator's share waits in the pool");
        assertEq(IERC20(AAPL).balanceOf(address(creatorVault)), 0);
        assertLt(token.totalSupply(), supply, "the burn bucket still burned");
        assertGt(token.dividendOf(makeAddr("TEST holder")), 0, "dividends still paid");

        // Unblocked, the next dispatch pays what waited.
        vm.prank(AAPL_BLOCKER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).unblockAccounts(_one(address(creatorVault)));
        uint256 paid = _dispatchPaid(id);
        assertGe(paid, creatorShare);
        assertEq(IERC20(AAPL).balanceOf(address(creatorVault)), paid);
        assertEq(hook.pending(id).creator, 0);
    }

    function _aaplDividendKey() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(USDG),
            currency1: Currency.wrap(AAPL),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }

    function test_dividendsTheDividendTokenRefusesWaitAndTheRestIsPaid() public {
        OstraVault v = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(v), -375_400, bytes32(uint256(38)));
        p.dividendToken = AAPL;
        p.dividendKey = _aaplDividendKey();
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        OstraToken token = OstraToken(t);
        PoolKey memory key = hook.poolKey(id);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 1_000e6);
        address holder = makeAddr("deferred dividend holder");
        _buyExactIn(key, token, 200e6, holder);
        uint256 bucket = hook.pending(id).dividend;
        assertGt(bucket, 0);

        // The issuer blocks the token contract: AAPL cannot reach it, the dividends wait, the creator is paid.
        vm.prank(AAPL_BLOCKER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).blockAccounts(_one(address(token)));
        uint256 vaultBefore = IERC20(USDG).balanceOf(address(v));
        vm.recordLogs();
        dispatcher.dispatch(id);
        assertTrue(_dispatcherEmitted(OstraDispatcher.DividendsDeferred.selector));
        assertGe(hook.pending(id).dividend, bucket, "the dividend bucket waits");
        assertEq(token.dividendOf(holder), 0);
        assertGt(IERC20(USDG).balanceOf(address(v)), vaultBefore, "the creator was paid");

        vm.prank(AAPL_BLOCKER);
        IRobinhoodStockRegistry(AAPL_REGISTRY).unblockAccounts(_one(address(token)));
        dispatcher.dispatch(id);
        assertGt(token.dividendOf(holder), 0);
        assertLt(hook.pending(id).dividend, bucket);
        // Only the dispatcher itself runs its dividend step.
        OstraHook.PoolConfig memory c = hook.poolConfig(id);
        vm.expectRevert(OstraDispatcher.OnlySelf.selector);
        dispatcher.dividendStep(id, key, c, 1);
    }

    function test_aDividendPoolThatDoesNotExistIsRefused() public {
        OstraVault v = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(v), -375_400, bytes32(uint256(39)));
        p.dividendToken = AAPL;
        p.dividendKey = _aaplDividendKey();
        p.dividendKey.fee = 3001; // a hookless USDG/AAPL pool nobody initialized
        uint256 fee = launchpad.LAUNCH_FEE();
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "dividendKey"));
        launchpad.launch{value: fee}(p);
        // An Ostra pool that was never launched.
        p.dividendKey.fee = LPFeeLibrary.DYNAMIC_FEE_FLAG;
        p.dividendKey.tickSpacing = 200;
        p.dividendKey.hooks = IHooks(address(hook));
        vm.expectRevert(abi.encodeWithSelector(OstraLaunchpad.BadParams.selector, "dividendKey"));
        launchpad.launch{value: fee}(p);
    }

    // ---------------------------------------------------------------------------------------------
    // Circuit breaker
    // ---------------------------------------------------------------------------------------------

    /// @dev A USDG pool with the circuit breaker at `cap` ticks, no max buy or max wallet (the test router holds what
    ///      it trades) and the launch rules for the whole test. The token is currency1 here: a buy lowers the tick.
    function _breakerPool(bytes32 salt, uint16 cap)
        internal
        returns (PoolKey memory key, PoolId id, bool tokenIs0, OstraVault creatorVault)
    {
        creatorVault = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(creatorVault), -375_400, salt);
        p.maxBuy = 0;
        p.maxWallet = 0;
        p.graduationThreshold = 100_000e6;
        p.maxTxMoveTicks = cap;
        address t;
        (t, id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        key = hook.poolKey(id);
        tokenIs0 = Currency.unwrap(key.currency0) == t;
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 1_000_000e6);
    }

    function _expectPriceMoveTooLarge() internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(OstraHook.PriceMoveTooLarge.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
    }

    function _repeat(bool zeroForOne, int256 amount, uint256 n)
        internal
        pure
        returns (bool[] memory directions, int256[] memory amounts)
    {
        directions = new bool[](n);
        amounts = new int256[](n);
        for (uint256 i = 0; i < n; ++i) {
            directions[i] = zeroForOne;
            amounts[i] = amount;
        }
    }

    /// forge-config: default.isolate = true
    function test_theCircuitBreakerStopsOneTransactionMovingThePriceTooFar() public {
        (PoolKey memory key, PoolId id, bool tokenIs0,) = _breakerPool(bytes32(uint256(40)), 2_231);
        int24 start = _tickOf(id);
        (int24 lower, int24 upper) = hook.txMoveBand(id);
        assertEq(lower, start - 2_231);
        assertEq(upper, start + 2_231);

        // 60M tokens bought in one swap move the price about 2,780 ticks: refused.
        _expectPriceMoveTooLarge();
        router.swap(key, !tokenIs0, 60_000_000e18, address(router));
        // The same buy split into six swaps of one transaction: refused, the move counts from its first swap.
        (bool[] memory directions, int256[] memory amounts) = _repeat(!tokenIs0, 10_000_000e18, 6);
        _expectPriceMoveTooLarge();
        router.swaps(key, directions, amounts, address(router));
        assertEq(_tickOf(id), start);

        // A transaction that ends back within the band may go anywhere in it: a buy, a sell and a buy again.
        directions = new bool[](3);
        amounts = new int256[](3);
        (directions[0], amounts[0]) = (!tokenIs0, int256(40_000_000e18));
        (directions[1], amounts[1]) = (tokenIs0, -int256(40_000_000e18));
        (directions[2], amounts[2]) = (!tokenIs0, int256(30_000_000e18));
        uint256 g = gasleft();
        router.swaps(key, directions, amounts, address(router));
        console.log("gas three swaps in one transaction with the circuit breaker", g - gasleft());
        int24 afterOne = _tickOf(id);
        assertLt(afterOne, start);
        assertLe(start - afterOne, 2_231);

        // Separate transactions are not limited: three more buys of 10M each, then the band follows the price.
        for (uint256 i = 0; i < 3; ++i) {
            router.swap(key, !tokenIs0, 10_000_000e18, address(router));
        }
        int24 now_ = _tickOf(id);
        assertGt(start - now_, 2_231, "past the band of the first transaction");
        (lower, upper) = hook.txMoveBand(id);
        assertEq(lower, now_ - 2_231);
        assertEq(upper, now_ + 2_231);

        // A dump of everything bought in one sell is refused; small sells pass, and so does selling it over
        // several transactions.
        uint256 held = IERC20(Currency.unwrap(tokenIs0 ? key.currency0 : key.currency1)).balanceOf(address(router));
        _expectPriceMoveTooLarge();
        router.swap(key, tokenIs0, -int256(held), address(router));
        router.swap(key, tokenIs0, -1_000_000e18, address(router));
        for (uint256 i = 0; i < 4; ++i) {
            router.swap(key, tokenIs0, -int256((held - 1_000_000e18) / 4), address(router));
        }
        assertGt(_tickOf(id), now_ + 2_231);
    }

    function test_theCreatorCanOnlyLoosenOrTurnOffTheCircuitBreaker() public {
        (, PoolId id,, OstraVault creatorVault) = _breakerPool(bytes32(uint256(41)), 2_231);
        assertEq(hook.poolConfig(id).maxTxMoveTicks, 2_231);
        _configureReverts(creatorVault, id, 9, 2_231, OstraHook.NotInTradersFavour.selector);
        _configureReverts(creatorVault, id, 9, 1_000, OstraHook.NotInTradersFavour.selector);
        _configureReverts(creatorVault, id, 9, 6_933, OstraHook.NotInTradersFavour.selector);
        _configure(creatorVault, id, 9, 6_932);
        assertEq(hook.poolConfig(id).maxTxMoveTicks, 6_932);
        _configure(creatorVault, id, 9, 0);
        assertEq(hook.poolConfig(id).maxTxMoveTicks, 0);
        (int24 lower, int24 upper) = hook.txMoveBand(id);
        assertEq(lower, TickMath.MIN_TICK);
        assertEq(upper, TickMath.MAX_TICK);
        // Off stays off.
        _configureReverts(creatorVault, id, 9, 3_000, OstraHook.NotInTradersFavour.selector);
        _configureReverts(creatorVault, id, 9, 0, OstraHook.NotInTradersFavour.selector);
    }

    // ---------------------------------------------------------------------------------------------
    // Referral
    // ---------------------------------------------------------------------------------------------

    /// @dev The hook fee of the last Charged event in the recorded logs.
    function _lastHookFee() internal returns (uint256 hookFee) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == OstraHook.Charged.selector) {
                (, , hookFee,,) = abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256));
            }
        }
    }

    /// @dev The protocol's 30% of `hookFee`, and the hook's books of it: what referrers, the protocol and the buyback
    ///      were owed in USDG, against `before`.
    function _protocolPart(uint256 hookFee) internal pure returns (uint256) {
        return hookFee - (hookFee * 7_000) / 10_000;
    }

    function _assertReferral(address referrer, uint256 referredBefore, uint256 sharesBefore, uint256 hookFee) internal view {
        Currency usdg = Currency.wrap(USDG);
        uint256 part = _protocolPart(hookFee);
        uint256 referral = part / 2;
        assertEq(hook.referralOwed(referrer, usdg) - referredBefore, referral, "half of the protocol's share");
        uint256 rest = part - referral;
        (uint128 protocol, uint128 buyback) = hook.protocolShare(usdg);
        uint256 bookedBefore = sharesBefore;
        assertEq(uint256(protocol) + buyback - ((bookedBefore >> 128) + uint128(bookedBefore)), rest);
        assertEq(uint256(buyback) - uint128(bookedBefore), rest / 2, "the rest is shared with the buyback as before");
    }

    function test_aReferredSwapPaysHalfTheProtocolShareToItsReferrer() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(42)));
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        Currency usdg = Currency.wrap(USDG);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 10_000e6);
        address referrer = makeAddr("referrer");
        bytes memory referral = abi.encode(referrer);

        // An exact-input buy of 100 USDG: the hook fee is 1 USDG, the protocol's 0.3 USDG, the referrer's 0.15 USDG.
        uint256 shares = _protocolShares(usdg);
        router.swapWithData(key, !tokenIs0, -100e6, address(router), referral);
        assertEq(hook.referralOwed(referrer, usdg), 0.15e6);
        (uint128 protocol, uint128 buyback) = hook.protocolShare(usdg);
        assertEq(uint256(protocol) - (shares >> 128), 0.075e6);
        assertEq(uint256(buyback) - uint128(shares), 0.075e6);

        // An exact-input sell: charged in afterSwap, the referrer is read there too.
        shares = _protocolShares(usdg);
        uint256 referred = hook.referralOwed(referrer, usdg);
        vm.recordLogs();
        router.swapWithData(key, tokenIs0, -1_000_000e18, address(router), referral);
        _assertReferral(referrer, referred, shares, _lastHookFee());

        // hookData of any other shape is no referrer: the whole protocol share stays with the protocol.
        referred = hook.referralOwed(referrer, usdg);
        shares = _protocolShares(usdg);
        router.swapWithData(key, !tokenIs0, -100e6, address(router), abi.encode(referrer, uint256(1)));
        router.swapWithData(key, !tokenIs0, -100e6, address(router), abi.encode(uint256(uint160(referrer)) | (1 << 160)));
        assertEq(hook.referralOwed(referrer, usdg), referred);
        (protocol, buyback) = hook.protocolShare(usdg);
        assertEq(uint256(protocol) + buyback - ((shares >> 128) + uint128(shares)), 2 * 0.3e6);

        // Anyone may claim for the referrer; it is paid, and only it.
        vm.prank(makeAddr("anyone"));
        dispatcher.claimReferral(referrer, usdg);
        assertEq(IERC20(USDG).balanceOf(referrer), referred);
        assertEq(hook.referralOwed(referrer, usdg), 0);
        vm.expectRevert(OstraDispatcher.NothingToClaim.selector);
        dispatcher.claimReferral(referrer, usdg);
        vm.expectRevert(OstraHook.OnlyDispatcher.selector);
        hook.takeReferral(referrer, usdg);
        // After a dispatch (the locked positions' LP fees), the protocol and the buyback are paid what they are owed.
        dispatcher.dispatch(key.toId());
        _claimProtocolAndBuyback();
    }

    function test_aVaultSwapCarriesItsReferrer() public {
        (OstraToken token, PoolKey memory key,) = _launchUsdg(bytes32(uint256(43)));
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.warp(block.timestamp + 601);
        OstraVault buyer = _vault(USDG, BUYER);
        deal(USDG, address(buyer), 100e6);
        address referrer = makeAddr("agent referrer");
        bytes32 next = WotsSigner.keyRoot(_seed(BUYER, 1));

        // A referrer word with dirty upper bytes, or an eighth word, is refused before anything moves.
        bytes memory params =
            abi.encode(key, !tokenIs0, uint128(20e6), uint128(1), address(buyer), uint256(uint160(referrer)) | (1 << 160), uint32(1_000_000));
        bytes memory signature = WotsSigner.sign(_seed(BUYER, 0), buyer.spendMessage(3, next, params));
        vm.expectRevert();
        buyer.spend(3, next, params, signature);
        params = abi.encodePacked(abi.encode(key, !tokenIs0, uint128(20e6), uint128(1), address(buyer), referrer, uint32(1_000_000)), bytes32(0));
        signature = WotsSigner.sign(_seed(BUYER, 0), buyer.spendMessage(3, next, params));
        vm.expectRevert(OstraVault.BadParams.selector);
        buyer.spend(3, next, params, signature);
        assertEq(buyer.nonce(), 0);

        params = abi.encode(key, !tokenIs0, uint128(20e6), uint128(1), address(buyer), referrer, uint32(1_000_000));
        assertEq(params.length, 352);
        signature = WotsSigner.sign(_seed(BUYER, 0), buyer.spendMessage(3, next, params));
        uint256 shares = _protocolShares(Currency.wrap(USDG));
        vm.recordLogs();
        uint256 g = gasleft();
        buyer.spend(3, next, params, signature);
        console.log("gas vault Swap with a referrer (Ostra pool)", g - gasleft());
        _assertReferral(referrer, 0, shares, _lastHookFee());
        assertEq(hook.referralOwed(referrer, Currency.wrap(USDG)), 0.03e6, "20 USDG in: a 0.2 USDG hook fee, 0.06 for the protocol");
        assertGt(token.balanceOf(address(buyer)), 0);
    }

    /// forge-config: default.isolate = true
    function test_thePriceCannotBeWalkedThroughEmptyTicksForFree() public {
        (PoolKey memory key, PoolId id, bool tokenIs0,) = _breakerPool(bytes32(uint256(44)), 1_000);
        int24 start = _tickOf(id);
        (int24 lower, int24 upper) = hook.txMoveBand(id);
        // A 1-wei sell stopped at the band's edge, on the side where the launch put no liquidity: it would move the
        // price 1,000 ticks for nothing, and ten of them would leave every later swap too large. Refused.
        uint160 edge = TickMath.getSqrtPriceAtTick(tokenIs0 ? lower + 1 : upper);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(OstraHook.NoLiquidityAtPrice.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        router.swapToLimit(key, tokenIs0, -1, edge, address(router));
        assertEq(_tickOf(id), start);
        // Buys go on as usual.
        router.swap(key, !tokenIs0, -1e6, address(router));
        assertGt(IERC20(Currency.unwrap(tokenIs0 ? key.currency0 : key.currency1)).balanceOf(address(router)), 0);
    }

    /// forge-config: default.isolate = true
    function test_aDispatchInTheSameTransactionStaysInTheBand() public {
        (PoolKey memory key, PoolId id, bool tokenIs0,) = _breakerPool(bytes32(uint256(45)), 1_000);
        // Buckets to convert, booked over separate transactions.
        for (uint256 i = 0; i < 12; ++i) {
            router.swap(key, !tokenIs0, 15_000_000e18, address(router));
            router.swap(key, tokenIs0, -15_000_000e18, address(router));
        }
        assertGt(hook.pending(id).burn, 0);
        int24 start = _tickOf(id);
        // A buy that takes the price close to the band's edge, then a dispatch whose conversion buys (burn, LP) would
        // take it past: the dispatch stops at the edge and books the rest back for later.
        SwapThenDispatch bundle = new SwapThenDispatch();
        bundle.run(router, dispatcher, key, !tokenIs0, 19_000_000e18);
        int256 moved = int256(_tickOf(id)) - int256(start);
        if (moved < 0) moved = -moved;
        assertGt(moved, 800);
        assertLe(moved, 1_000);
        assertGt(hook.pending(id).burn + hook.pending(id).lp, 0, "what did not fit waits for the next dispatch");
    }

    // ---------------------------------------------------------------------------------------------
    // Dev buy and vesting
    // ---------------------------------------------------------------------------------------------

    bytes32 internal constant CREATOR_TOKEN = keccak256("OSTRA/EVM/TEST/creator-token-vault");

    function _dev(uint256 quoteIn, address beneficiary, address dividendRecipient)
        internal
        pure
        returns (OstraDevBuy.DevBuy memory)
    {
        return OstraDevBuy.DevBuy({
            quoteIn: quoteIn,
            beneficiary: beneficiary,
            dividendRecipient: dividendRecipient,
            cliff: 7 days,
            duration: 30 days
        });
    }

    /// @dev The Charged event of the hook in the recorded logs: fee, tax and anti-snipe of the last one.
    function _lastCharge() internal returns (uint256 fee, uint256 tax, uint256 snipe) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == OstraHook.Charged.selector) {
                (, fee,, tax, snipe) = abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256));
            }
        }
    }

    function test_aDevBuyIsMadeAtLaunchWithoutAntiSnipeAndVestsToTheCreatorsTokenVault() public {
        (address token, PoolId id, address vesting, address tokenVault) = _launchWithDevBuy();
        // While it vests, the dev buy earns dividends (in the token here) like any holder; anyone claims them to
        // the creator's vault for the dividend token.
        _dividendsReachTheVesting(id, OstraToken(token), vesting, tokenVault);
        _vestsLinearlyAfterTheCliff(token, vesting, tokenVault);
        // The creator's token vault, created at its predicted address, spends them with its own key.
        assertEq(factory.createVault(token, WotsSigner.keyRoot(_seed(CREATOR_TOKEN, 0)), address(0)), tokenVault);
        _spend(OstraVault(tokenVault), CREATOR_TOKEN, 0, abi.encode(makeAddr("out"), uint256(1e18)));
        assertEq(IERC20(token).balanceOf(makeAddr("out")), 1e18);
    }

    function _launchWithDevBuy() internal returns (address token, PoolId id, address vesting, address tokenVault) {
        OstraVault creatorVault = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(creatorVault), -375_400, bytes32(uint256(50)));
        // The creator's token vault does not exist yet: its address follows from the token's, known before launch.
        token = devBuy.tokenAddress(address(this), p);
        tokenVault = factory.vaultAddress(token, WotsSigner.keyRoot(_seed(CREATOR_TOKEN, 0)), address(0));
        deal(USDG, address(this), 100e6);
        IERC20(USDG).approve(address(devBuy), 100e6);
        vm.recordLogs();
        uint256 g = gasleft();
        address t;
        (t, id, vesting) = devBuy.launch{value: launchpad.LAUNCH_FEE()}(p, _dev(100e6, tokenVault, tokenVault));
        console.log("gas launch with a dev buy", g - gasleft());
        assertEq(t, token);
        // 100 USDG at a 3% buy tax: a 1 USDG hook fee and 3 USDG of tax, but no anti-snipe, which is at 50% now.
        (uint256 fee, uint256 tax, uint256 snipe) = _lastCharge();
        assertEq(fee, 4e6);
        assertEq(tax, 3e6);
        assertEq(snipe, 0);
        (,, uint256 antiSnipeNow) = hook.rates(id);
        assertEq(antiSnipeNow, 5_000);
        assertGt(IERC20(token).balanceOf(vesting), 0);
        assertEq(IERC20(USDG).balanceOf(address(this)), 0);
        OstraVesting.Terms memory terms = OstraVesting(vesting).terms();
        assertEq(terms.token, token);
        assertEq(terms.beneficiary, tokenVault);
        assertEq(terms.start, block.timestamp);
        assertEq(terms.cliff, 7 days);
        assertEq(terms.duration, 30 days);
    }

    /// @dev Nothing before the cliff ends, then linearly over 30 days, to the creator's token vault only.
    function _vestsLinearlyAfterTheCliff(address token, address vesting, address tokenVault) internal {
        OstraVesting.Terms memory terms = OstraVesting(vesting).terms();
        uint256 bought = IERC20(token).balanceOf(vesting);
        // The vault already holds the dividends it was paid in the token.
        uint256 before = IERC20(token).balanceOf(tokenVault);
        vm.expectRevert(OstraVesting.NothingVested.selector);
        OstraVesting(vesting).release();
        vm.warp(uint256(terms.start) + 7 days);
        vm.expectRevert(OstraVesting.NothingVested.selector);
        OstraVesting(vesting).release();
        vm.warp(uint256(terms.start) + 7 days + 15 days);
        vm.prank(makeAddr("anyone"));
        OstraVesting(vesting).release();
        assertEq(IERC20(token).balanceOf(tokenVault) - before, bought / 2);
        vm.warp(uint256(terms.start) + 37 days);
        OstraVesting(vesting).release();
        assertEq(IERC20(token).balanceOf(tokenVault) - before, bought);
        assertEq(IERC20(token).balanceOf(vesting), 0);
    }

    function _dividendsReachTheVesting(PoolId id, OstraToken token, address vesting, address recipient) internal {
        PoolKey memory key = hook.poolKey(id);
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(token);
        vm.warp(block.timestamp + 601);
        deal(USDG, address(router), 1_000e6);
        router.swap(key, !tokenIs0, -200e6, address(router));
        router.swap(key, tokenIs0, -1_000_000e18, address(router));
        dispatcher.dispatch(id);
        uint256 owed = token.dividendOf(vesting);
        assertGt(owed, 0);
        uint256 before = token.balanceOf(recipient);
        vm.prank(makeAddr("anyone"));
        OstraVesting(vesting).claimDividends();
        assertEq(token.balanceOf(recipient) - before, owed);
    }

    function test_aDevBuyStaysInItsBounds() public {
        OstraVault creatorVault = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(creatorVault), -375_400, bytes32(uint256(51)));
        uint256 fee = launchpad.LAUNCH_FEE();
        address beneficiary = makeAddr("creator token vault");
        deal(USDG, address(this), 10_000e6);
        IERC20(USDG).approve(address(devBuy), type(uint256).max);
        OstraDevBuy.DevBuy memory d = _dev(100e6, beneficiary, address(creatorVault));

        d.cliff = 7 days - 1;
        vm.expectRevert(abi.encodeWithSelector(OstraDevBuy.BadDevBuy.selector, "cliff"));
        devBuy.launch{value: fee}(p, d);
        d.cliff = 365 days + 1;
        vm.expectRevert(abi.encodeWithSelector(OstraDevBuy.BadDevBuy.selector, "cliff"));
        devBuy.launch{value: fee}(p, d);
        d.cliff = 7 days;
        d.duration = 365 days + 1;
        vm.expectRevert(abi.encodeWithSelector(OstraDevBuy.BadDevBuy.selector, "duration"));
        devBuy.launch{value: fee}(p, d);
        d.duration = 0;
        d.dividendRecipient = address(0);
        vm.expectRevert(abi.encodeWithSelector(OstraDevBuy.BadDevBuy.selector, "dividendRecipient"));
        devBuy.launch{value: fee}(p, d);
        d.dividendRecipient = address(creatorVault);
        d.beneficiary = address(0);
        vm.expectRevert(abi.encodeWithSelector(OstraDevBuy.BadDevBuy.selector, "beneficiary"));
        devBuy.launch{value: fee}(p, d);
        d.beneficiary = beneficiary;
        vm.expectRevert(OstraDevBuy.WrongValue.selector);
        devBuy.launch{value: fee + 1}(p, d);
        // The pool's max buy (10M tokens) binds the dev buy: 1,000 USDG buys about 20M.
        d.quoteIn = 1_000e6;
        vm.expectRevert();
        devBuy.launch{value: fee}(p, d);
        // Without a max buy or max wallet, the dev buy is still at most 5% of the supply.
        p.maxBuy = 0;
        p.maxWallet = 0;
        d.quoteIn = 5_000e6;
        vm.expectRevert(OstraDevBuy.DevBuyTooLarge.selector);
        devBuy.launch{value: fee}(p, d);

        // The launch salt is bound to the launching account: the same parameters from anyone else make another token.
        assertTrue(devBuy.tokenAddress(address(this), p) != devBuy.tokenAddress(makeAddr("front-runner"), p));
        // A dev buy with no vesting after the cliff: all of it at the cliff's end.
        d.quoteIn = 100e6;
        (address token,, address vesting) = devBuy.launch{value: fee}(p, d);
        assertEq(token, devBuy.tokenAddress(address(this), p));
        uint256 bought = IERC20(token).balanceOf(vesting);
        vm.warp(block.timestamp + 7 days);
        OstraVesting(vesting).release();
        assertEq(IERC20(token).balanceOf(beneficiary), bought);
    }

    function test_anEthPoolsDevBuyIsPaidInEth() public {
        OstraVault wethVault = _vault(WETH, CREATOR_WETH);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(address(0)), address(wethVault), -168_200, bytes32(uint256(52)));
        p.dividendToken = WETH;
        p.graduationThreshold = 1 ether;
        uint256 fee = launchpad.LAUNCH_FEE();
        OstraDevBuy.DevBuy memory d = _dev(0.001 ether, makeAddr("creator token vault"), address(wethVault));
        vm.expectRevert(OstraDevBuy.WrongValue.selector);
        devBuy.launch{value: fee}(p, d);
        uint256 eth = address(this).balance;
        (address token,, address vesting) = devBuy.launch{value: fee + 0.001 ether}(p, d);
        assertEq(eth - address(this).balance, fee + 0.001 ether);
        assertGt(IERC20(token).balanceOf(vesting), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Vault-funded launch (OstraDevBuy.launchFromVault, OstraVault DevBuy spend)
    // ---------------------------------------------------------------------------------------------

    /// @dev The creator vault's signed DevBuy spend for the launch `p` with the dev buy `d`.
    function _devBuySpend(OstraVault vault, bytes32 keychain, OstraLaunchpad.LaunchParams memory p, OstraDevBuy.DevBuy memory d)
        internal
        view
        returns (bytes32 next, bytes memory signature)
    {
        uint64 n = vault.nonce();
        next = WotsSigner.keyRoot(_seed(keychain, n + 1));
        bytes memory params = abi.encode(address(devBuy), devBuy.launchHash(p, d), d.quoteIn);
        signature = WotsSigner.sign(_seed(keychain, n), vault.spendMessage(9, next, params));
    }

    struct VaultLaunch {
        OstraVault creatorVault;
        OstraLaunchpad.LaunchParams p;
        OstraDevBuy.DevBuy d;
        bytes32 next;
        bytes signature;
        address predicted;
    }

    function _vaultLaunch(bytes32 salt, uint256 quoteIn) internal returns (VaultLaunch memory v) {
        v.creatorVault = _vault(USDG, CREATOR);
        deal(USDG, address(v.creatorVault), 500e6);
        v.p = _params(Currency.wrap(USDG), address(v.creatorVault), -375_400, salt);
        v.predicted = devBuy.tokenAddressFromVault(v.p);
        address tokenVault = factory.vaultAddress(v.predicted, WotsSigner.keyRoot(_seed(CREATOR_TOKEN, 0)), address(0));
        v.d = _dev(quoteIn, tokenVault, tokenVault);
        (v.next, v.signature) = _devBuySpend(v.creatorVault, CREATOR, v.p, v.d);
    }

    /// forge-config: default.isolate = true
    function test_aCreatorVaultPaysItsDevBuyAndWhoeverSendsItPaysOnlyTheLaunchFee() public {
        VaultLaunch memory v = _vaultLaunch(bytes32(uint256(60)), 100e6);
        // Its salt is the creator vault's, apart from any account's own launches.
        assertTrue(v.predicted != devBuy.tokenAddress(address(this), v.p));
        assertTrue(v.predicted != devBuy.tokenAddress(address(v.creatorVault), v.p));
        address relayer = makeAddr("relayer");
        uint256 fee = launchpad.LAUNCH_FEE();
        vm.deal(relayer, fee);
        vm.recordLogs();
        vm.prank(relayer);
        uint256 g = gasleft();
        (address token,, address vesting) = devBuy.launchFromVault{value: fee}(v.p, v.d, v.next, v.signature);
        console.log("gas vault-funded launch with a dev buy", g - gasleft());
        assertEq(token, v.predicted);
        assertEq(relayer.balance, 0);
        // The launchpad and OstraDevBuy say which token and which vesting are theirs.
        assertEq(PoolId.unwrap(launchpad.poolOf(token)), PoolId.unwrap(hook.poolKey(launchpad.poolOf(token)).toId()));
        assertTrue(PoolId.unwrap(launchpad.poolOf(token)) != bytes32(0));
        assertEq(PoolId.unwrap(devBuy.vestingPool(vesting)), PoolId.unwrap(launchpad.poolOf(token)));
        assertEq(PoolId.unwrap(launchpad.poolOf(address(v.creatorVault))), bytes32(0));
        assertEq(PoolId.unwrap(devBuy.vestingPool(token)), bytes32(0));
        // The vault paid the dev buy with its own key, which rotated.
        assertEq(v.creatorVault.nonce(), 1);
        assertEq(v.creatorVault.keyRoot(), v.next);
        assertEq(IERC20(USDG).balanceOf(address(v.creatorVault)), 400e6);
        // The same charges as a dev buy paid by its account: no anti-snipe at launch.
        (uint256 hookFee, uint256 tax, uint256 snipe) = _lastCharge();
        assertEq(hookFee, 4e6);
        assertEq(tax, 3e6);
        assertEq(snipe, 0);
        assertEq(OstraVesting(vesting).terms().beneficiary, v.d.beneficiary);
        assertEq(OstraVesting(vesting).terms().cliff, 7 days);
        assertGt(IERC20(token).balanceOf(vesting), 0);
        // Nothing stays behind in OstraDevBuy, and no launch is pending once it is done.
        assertEq(IERC20(USDG).balanceOf(address(devBuy)), 0);
        assertEq(address(devBuy).balance, 0);
        assertEq(devBuy.pendingLaunch(address(v.creatorVault)), bytes32(0));
    }

    /// forge-config: default.isolate = true
    function test_aVaultsDevBuySignatureMakesOnlyTheLaunchItSigned() public {
        VaultLaunch memory v = _vaultLaunch(bytes32(uint256(61)), 100e6);
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        // Another beneficiary, another dev buy amount or another launch parameter: not the hash the vault signed.
        _refusedWith(v, _dev(100e6, attacker, attacker), v.p);
        _refusedWith(v, _dev(400e6, v.d.beneficiary, v.d.beneficiary), v.p);
        OstraLaunchpad.LaunchParams memory other = _params(Currency.wrap(USDG), address(v.creatorVault), -375_400, v.p.salt);
        other.buyTaxBps = 0;
        _refusedWith(v, v.d, other);
        // The spend itself, sent by anyone but OstraDevBuy during that very launch, is refused.
        bytes memory params = abi.encode(address(devBuy), devBuy.launchHash(v.p, v.d), v.d.quoteIn);
        vm.expectRevert(OstraVault.Unauthorized.selector);
        v.creatorVault.spend(9, v.next, params, v.signature);
        // The launch fee is exact.
        uint256 fee = launchpad.LAUNCH_FEE();
        vm.expectRevert(OstraDevBuy.WrongValue.selector);
        devBuy.launchFromVault{value: fee - 1}(v.p, v.d, v.next, v.signature);
        vm.expectRevert(OstraDevBuy.WrongValue.selector);
        devBuy.launchFromVault{value: fee + 1}(v.p, v.d, v.next, v.signature);
        // ETH comes into OstraDevBuy only from WETH.
        (bool ok,) = address(devBuy).call{value: 1}("");
        assertFalse(ok);
        assertEq(v.creatorVault.nonce(), 0);
        assertEq(IERC20(USDG).balanceOf(address(v.creatorVault)), 500e6);

        // Submitted by anyone, the signed launch does exactly what the vault signed: the tokens vest to its beneficiary.
        (address token,, address vesting) = devBuy.launchFromVault{value: fee}(v.p, v.d, v.next, v.signature);
        vm.stopPrank();
        assertEq(token, v.predicted);
        assertEq(OstraVesting(vesting).terms().beneficiary, v.d.beneficiary);
        assertEq(IERC20(token).balanceOf(attacker), 0);
        assertEq(v.creatorVault.nonce(), 1);
        // Used once: the same signature never works again.
        vm.prank(attacker);
        vm.expectRevert();
        devBuy.launchFromVault{value: fee}(v.p, v.d, v.next, v.signature);
    }

    function _refusedWith(VaultLaunch memory v, OstraDevBuy.DevBuy memory d, OstraLaunchpad.LaunchParams memory p) internal {
        uint256 fee = launchpad.LAUNCH_FEE();
        vm.expectRevert();
        devBuy.launchFromVault{value: fee}(p, d, v.next, v.signature);
    }

    /// forge-config: default.isolate = true
    function test_aVaultLaunchesWithoutADevBuyAndPaysNothing() public {
        OstraVault creatorVault = _vault(USDG, CREATOR);
        deal(USDG, address(creatorVault), 5e6);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(creatorVault), -375_400, bytes32(uint256(62)));
        OstraDevBuy.DevBuy memory none;
        uint256 fee = launchpad.LAUNCH_FEE();
        // Without a dev buy, every other dev buy field is 0.
        OstraDevBuy.DevBuy memory half;
        half.cliff = 7 days;
        (bytes32 hn, bytes memory hs) = _devBuySpend(creatorVault, CREATOR, p, half);
        vm.expectRevert(abi.encodeWithSelector(OstraDevBuy.BadDevBuy.selector, "noDevBuy"));
        devBuy.launchFromVault{value: fee}(p, half, hn, hs);
        (bytes32 next, bytes memory signature) = _devBuySpend(creatorVault, CREATOR, p, none);
        vm.recordLogs();
        (address token, PoolId id, address vesting) = devBuy.launchFromVault{value: fee}(p, none, next, signature);
        assertEq(token, devBuy.tokenAddressFromVault(p));
        assertEq(vesting, address(0));
        assertEq(creatorVault.nonce(), 1);
        assertEq(IERC20(USDG).balanceOf(address(creatorVault)), 5e6);
        assertEq(IERC20(token).balanceOf(address(locker)) + IERC20(token).balanceOf(POOL_MANAGER) > 0, true);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != OstraDevBuy.DevBought.selector);
        }
        assertEq(Currency.unwrap(hook.poolKey(id).currency0) == token || Currency.unwrap(hook.poolKey(id).currency1) == token, true);
    }

    /// forge-config: default.isolate = true
    function test_anEthPoolsVaultFundedDevBuyIsPaidFromTheCreatorsWeth() public {
        OstraVault wethVault = _vault(WETH, CREATOR_WETH);
        deal(WETH, address(wethVault), 0.01 ether);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(address(0)), address(wethVault), -168_200, bytes32(uint256(63)));
        p.dividendToken = WETH;
        p.graduationThreshold = 1 ether;
        address tokenVault = makeAddr("creator token vault");
        OstraDevBuy.DevBuy memory d = _dev(0.001 ether, tokenVault, address(wethVault));
        (bytes32 next, bytes memory signature) = _devBuySpend(wethVault, CREATOR_WETH, p, d);
        uint256 fee = launchpad.LAUNCH_FEE();
        (address token,, address vesting) = devBuy.launchFromVault{value: fee}(p, d, next, signature);
        assertEq(IERC20(WETH).balanceOf(address(wethVault)), 0.009 ether);
        assertGt(IERC20(token).balanceOf(vesting), 0);
        assertEq(IERC20(WETH).balanceOf(address(devBuy)), 0);
        assertEq(address(devBuy).balance, 0);
        assertEq(wethVault.nonce(), 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Airdrop
    // ---------------------------------------------------------------------------------------------

    /// @dev OpenZeppelin's commutative pair hash (MerkleProof).
    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev A four-leaf round: the root and each leaf's proof.
    function _tree(PoolId id, uint256 number, address[4] memory accounts, uint256[4] memory amounts)
        internal
        view
        returns (bytes32 root, bytes32[][] memory proofs)
    {
        bytes32[4] memory l;
        for (uint256 i = 0; i < 4; ++i) {
            l[i] = airdrop.leaf(id, number, accounts[i], amounts[i]);
        }
        bytes32 left = _pair(l[0], l[1]);
        bytes32 right = _pair(l[2], l[3]);
        root = _pair(left, right);
        proofs = new bytes32[][](4);
        for (uint256 i = 0; i < 4; ++i) {
            proofs[i] = new bytes32[](2);
            proofs[i][0] = l[i ^ 1];
            proofs[i][1] = i < 2 ? right : left;
        }
    }

    /// @dev The creator vault's two spends: the round's amount, then its root.
    function _startRound(OstraVault creatorVault, PoolId id, uint256 amount, bytes32 root) internal {
        _spend(creatorVault, CREATOR, 4, abi.encode(address(airdrop), PoolId.unwrap(id), uint8(1), amount));
        _spend(creatorVault, CREATOR, 4, abi.encode(address(airdrop), PoolId.unwrap(id), uint8(0), uint256(root)));
    }

    struct Drop {
        OstraToken token;
        PoolKey key;
        PoolId id;
        bool tokenIs0;
        OstraVault creatorVault;
        uint256 held;
        uint256 total;
        address[4] accounts;
        uint256[4] amounts;
        bytes32 root;
        bytes32[][] proofs;
    }

    function test_anAirdropRoundIsBoughtByTheCreatorClaimedForSevenDaysAndTheRestBurned() public {
        Drop memory a = _fundAirdrop();
        _startFirstRound(a);
        _claimFirstRound(a);
        _closeFirstRound(a);
        // What the first round did not take waits for the next one, whose leaves are round 2's: round 1's proofs do
        // not carry over.
        assertEq(airdrop.available(a.id), a.held - a.total);
        _startRound(a.creatorVault, a.id, a.held - a.total, a.root);
        assertEq(airdrop.round(a.id).number, 2);
        vm.expectRevert(OstraAirdrop.BadProof.selector);
        airdrop.claim(a.id, a.accounts[2], a.amounts[2], a.proofs[2]);
    }

    function _fundAirdrop() internal returns (Drop memory a) {
        (a.token, a.key, a.creatorVault) = _launchUsdg(bytes32(uint256(53)));
        a.id = a.key.toId();
        a.tokenIs0 = Currency.unwrap(a.key.currency0) == address(a.token);
        vm.warp(block.timestamp + 601);
        // No round without its amount, nor with more than is held.
        _configureAirdropReverts(a, 0, 1, OstraAirdrop.NoRoundAmount.selector);
        _spend(a.creatorVault, CREATOR, 4, abi.encode(address(airdrop), PoolId.unwrap(a.id), uint8(1), uint256(1e18)));
        assertEq(airdrop.nextRoundAmount(a.id), 1e18);
        _configureAirdropReverts(a, 0, 1, OstraAirdrop.NotEnoughTokens.selector);
        // The creator vault buys the round with its own USDG, straight into the airdrop contract.
        deal(USDG, address(a.creatorVault), 100e6);
        _spend(a.creatorVault, CREATOR, 3, _swapParams(a.key, !a.tokenIs0, 100e6, 1, address(airdrop)));
        a.held = a.token.balanceOf(address(airdrop));
        assertGt(a.held, 0);
        assertEq(airdrop.available(a.id), a.held);
        assertEq(a.token.dividendSharesOf(address(airdrop)), 0, "a system account: no dividend shares");
        a.accounts = [makeAddr("a"), makeAddr("b"), makeAddr("c"), makeAddr("d")];
        a.amounts = [a.held / 4, a.held / 4, a.held / 4, a.held / 8];
        a.total = a.amounts[0] + a.amounts[1] + a.amounts[2] + a.amounts[3];
        (a.root, a.proofs) = _tree(a.id, 1, a.accounts, a.amounts);
    }

    function _configureAirdropReverts(Drop memory a, uint8 field, uint256 value, bytes4 err) internal {
        uint64 n = a.creatorVault.nonce();
        bytes memory params = abi.encode(address(airdrop), PoolId.unwrap(a.id), field, value);
        bytes32 next = WotsSigner.keyRoot(_seed(CREATOR, n + 1));
        bytes memory signature = WotsSigner.sign(_seed(CREATOR, n), a.creatorVault.spendMessage(4, next, params));
        vm.expectRevert(err);
        a.creatorVault.spend(4, next, params, signature);
    }

    function _startFirstRound(Drop memory a) internal {
        // Only the pool's creator vault sets a round, with known fields, an amount within 10% and a root.
        vm.expectRevert(OstraAirdrop.OnlyCreatorVault.selector);
        airdrop.configure(PoolId.unwrap(a.id), 0, uint256(a.root));
        _configureAirdropReverts(a, 2, 1, OstraAirdrop.BadField.selector);
        _configureAirdropReverts(a, 1, 0, OstraAirdrop.BadAmount.selector);
        _configureAirdropReverts(a, 1, airdrop.maxRoundAmount(a.id) + 1, OstraAirdrop.BadAmount.selector);
        _spend(a.creatorVault, CREATOR, 4, abi.encode(address(airdrop), PoolId.unwrap(a.id), uint8(1), a.total));
        _configureAirdropReverts(a, 0, 0, OstraAirdrop.BadRoot.selector);
        _spend(a.creatorVault, CREATOR, 4, abi.encode(address(airdrop), PoolId.unwrap(a.id), uint8(0), uint256(a.root)));
        OstraAirdrop.Round memory r = airdrop.round(a.id);
        assertEq(r.number, 1);
        assertEq(r.amount, a.total, "exactly what the tree shares out");
        assertEq(r.endsAt, block.timestamp + 7 days);
        assertTrue(r.open);
        assertEq(airdrop.reserved(address(a.token)), a.total);
        assertEq(airdrop.available(a.id), a.held - a.total);
        assertEq(airdrop.nextRoundAmount(a.id), 0);
    }

    function _claimFirstRound(Drop memory a) internal {
        // Anyone claims for an account, to that account, once; a wrong amount or proof is refused.
        vm.prank(makeAddr("anyone"));
        airdrop.claim(a.id, a.accounts[0], a.amounts[0], a.proofs[0]);
        assertEq(a.token.balanceOf(a.accounts[0]), a.amounts[0]);
        vm.expectRevert(OstraAirdrop.AlreadyClaimed.selector);
        airdrop.claim(a.id, a.accounts[0], a.amounts[0], a.proofs[0]);
        vm.expectRevert(OstraAirdrop.BadProof.selector);
        airdrop.claim(a.id, a.accounts[1], a.amounts[1] + 1, a.proofs[1]);
        vm.expectRevert(OstraAirdrop.BadProof.selector);
        airdrop.claim(a.id, a.accounts[1], a.amounts[1], a.proofs[2]);
        airdrop.claim(a.id, a.accounts[1], a.amounts[1], a.proofs[1]);
        airdrop.claim(a.id, a.accounts[3], a.amounts[3], a.proofs[3]);
        // One round at a time.
        _configureAirdropReverts(a, 1, 1, OstraAirdrop.RoundOpen.selector);
    }

    function _closeFirstRound(Drop memory a) internal {
        // It closes only after 7 days, and then nobody can claim; what was not claimed is burned.
        vm.expectRevert(OstraAirdrop.ClaimPeriodNotOver.selector);
        airdrop.close(a.id);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(OstraAirdrop.ClaimPeriodOver.selector);
        airdrop.claim(a.id, a.accounts[2], a.amounts[2], a.proofs[2]);
        uint256 supply = a.token.totalSupply();
        vm.prank(makeAddr("anyone"));
        airdrop.close(a.id);
        assertEq(supply - a.token.totalSupply(), a.amounts[2], "what was not claimed is burned");
        assertEq(a.token.balanceOf(address(airdrop)), a.held - a.total);
        assertEq(airdrop.reserved(address(a.token)), 0);
        vm.expectRevert(OstraAirdrop.RoundNotOpen.selector);
        airdrop.close(a.id);
    }

    function test_anAirdropRoundHoldsAtMostTenPercentOfTheSupply() public {
        OstraVault v = _vault(USDG, CREATOR);
        OstraLaunchpad.LaunchParams memory p = _params(Currency.wrap(USDG), address(v), -375_400, bytes32(uint256(54)));
        p.maxBuy = 0;
        p.maxWallet = 0;
        p.graduationThreshold = 1_000_000e6;
        (address t, PoolId id) = launchpad.launch{value: launchpad.LAUNCH_FEE()}(p);
        PoolKey memory key = hook.poolKey(id);
        bool tokenIs0 = Currency.unwrap(key.currency0) == t;
        vm.warp(block.timestamp + 601);
        // 150M tokens bought into the airdrop contract: a round holds at most 100M (10%), the rest waits for the next.
        deal(USDG, address(router), 1_000_000e6);
        router.swap(key, !tokenIs0, 150_000_000e18, address(airdrop));
        assertEq(IERC20(t).balanceOf(address(airdrop)), 150_000_000e18);
        assertEq(airdrop.maxRoundAmount(id), 100_000_000e18);
        uint64 n = v.nonce();
        bytes memory params = abi.encode(address(airdrop), PoolId.unwrap(id), uint8(1), uint256(100_000_000e18 + 1));
        bytes32 next = WotsSigner.keyRoot(_seed(CREATOR, n + 1));
        bytes memory signature = WotsSigner.sign(_seed(CREATOR, n), v.spendMessage(4, next, params));
        vm.expectRevert(OstraAirdrop.BadAmount.selector);
        v.spend(4, next, params, signature);
        _startRound(v, id, 100_000_000e18, bytes32(uint256(7)));
        assertEq(airdrop.round(id).amount, 100_000_000e18);
        vm.warp(block.timestamp + 7 days);
        airdrop.close(id);
        assertEq(IERC20(t).balanceOf(address(airdrop)), 50_000_000e18);
        assertEq(airdrop.available(id), 50_000_000e18);
    }
}
