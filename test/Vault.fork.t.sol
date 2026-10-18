// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraSplit, OstraSplitFactory} from "../src/OstraSplit.sol";
import {Wots} from "../src/Wots.sol";
import {IX402BatchSettlement} from "../src/interfaces/IX402BatchSettlement.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";

/// @notice Vaults on a fork of Robinhood Chain mainnet, against the deployed USDG, x402BatchSettlement and
///         Uniswap v4 PoolManager.
contract VaultForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant BATCH = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;
    /// @dev Uniswap v4 PoolManager on Robinhood Chain (Uniswap's v4 deployments page; v4-core v4.0.0).
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint40 internal constant GRACE = 900;

    IX402BatchSettlement internal batch = IX402BatchSettlement(BATCH);
    IERC20 internal usdg = IERC20(USDG);
    OstraVaultFactory internal factory;
    OstraSplitFactory internal splitFactory;

    // Keychains: one per vault, all from one test master secret.
    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant BUYER = keccak256("OSTRA/EVM/TEST/buyer-vault");
    bytes32 internal constant SELLER = keccak256("OSTRA/EVM/TEST/seller-vault");
    bytes32 internal constant OPERATOR = keccak256("OSTRA/EVM/TEST/operator-vault");

    uint256 internal voucherPk = uint256(keccak256("OSTRA/EVM/TEST/voucher-key"));
    uint256 internal keeperPk = uint256(keccak256("OSTRA/EVM/TEST/keeper-crank"));
    uint256 internal sellerCrankPk = uint256(keccak256("OSTRA/EVM/TEST/seller-own-crank"));
    uint256 internal buyerCrankPk = uint256(keccak256("OSTRA/EVM/TEST/buyer-crank"));

    function setUp() public {
        vm.createSelectFork("robinhood");
        assertEq(block.chainid, ROBINHOOD_CHAIN_ID);
        assertGt(BATCH.code.length, 0);
        assertGt(USDG.code.length, 0);
        assertGt(POOL_MANAGER.code.length, 0);
        assertEq(batch.MIN_WITHDRAW_DELAY(), GRACE);
        OstraVault implementation = new OstraVault(BATCH, POOL_MANAGER);
        assertEq(address(implementation.POOL_MANAGER()), POOL_MANAGER);
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(implementation), address(this));
        factory = new OstraVaultFactory(address(beacon));
        splitFactory = new OstraSplitFactory();
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _seed(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keychain, index);
    }

    function _root(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.keyRoot(_seed(keychain, index));
    }

    function _vault(bytes32 keychain, address crank) internal returns (OstraVault) {
        return OstraVault(factory.createVault(USDG, _root(keychain, 0), crank));
    }

    /// @dev Signs and submits a spend with the vault's current key, as a relayer would.
    function _spend(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        (bytes32 next, bytes memory signature) = _sign(vault, keychain, action, params);
        vault.spend(action, next, params, signature);
    }

    function _sign(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params)
        internal
        view
        returns (bytes32 next, bytes memory signature)
    {
        uint64 n = vault.nonce();
        next = _root(keychain, n + 1);
        bytes memory message = vault.spendMessage(action, next, params);
        signature = WotsSigner.sign(_seed(keychain, n), message);
    }

    function _fund(address to, uint256 amount) internal {
        deal(USDG, to, amount);
        assertEq(usdg.balanceOf(to), amount);
    }

    function _ecdsa(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _config(OstraVault buyer, address receiver, address receiverAuthorizer, bytes32 salt)
        internal
        view
        returns (IX402BatchSettlement.ChannelConfig memory)
    {
        return IX402BatchSettlement.ChannelConfig({
            payer: address(buyer),
            payerAuthorizer: vm.addr(voucherPk),
            receiver: receiver,
            receiverAuthorizer: receiverAuthorizer,
            token: USDG,
            withdrawDelay: GRACE,
            salt: salt
        });
    }

    function _openParams(IX402BatchSettlement.ChannelConfig memory c, uint128 amount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(c.payerAuthorizer, c.receiver, c.receiverAuthorizer, c.withdrawDelay, c.salt, amount);
    }

    function _claims(IX402BatchSettlement.ChannelConfig memory c, uint128 total)
        internal
        view
        returns (IX402BatchSettlement.VoucherClaim[] memory claims)
    {
        bytes32 id = batch.getChannelId(c);
        claims = new IX402BatchSettlement.VoucherClaim[](1);
        claims[0] = IX402BatchSettlement.VoucherClaim({
            voucher: IX402BatchSettlement.Voucher({channel: c, maxClaimableAmount: total}),
            signature: _ecdsa(voucherPk, batch.getVoucherDigest(id, total)),
            totalClaimed: total
        });
    }

    /// @dev Seller vault with the keeper's crank, operator vault, and the seller's split (30 bps to the operator).
    function _seller() internal returns (OstraVault seller, OstraVault operator, OstraSplit split) {
        seller = _vault(SELLER, vm.addr(keeperPk));
        operator = _vault(OPERATOR, address(0));
        address[] memory recipients = new address[](1);
        recipients[0] = address(operator);
        uint16[] memory bps = new uint16[](1);
        bps[0] = 30;
        address predicted = splitFactory.splitAddress(USDG, address(seller), recipients, bps);
        split = OstraSplit(splitFactory.createSplit(USDG, address(seller), recipients, bps));
        assertEq(address(split), predicted);
        assertEq(splitFactory.createSplit(USDG, address(seller), recipients, bps), predicted);
    }

    // ---------------------------------------------------------------------------------------------
    // Vault and WOTS spends
    // ---------------------------------------------------------------------------------------------

    function test_vaultIsCreatedAtItsPredictedAddressOnce() public {
        bytes32 root = _root(BUYER, 0);
        address predicted = factory.vaultAddress(USDG, root, address(0));
        uint256 before = gasleft();
        OstraVault vault = OstraVault(factory.createVault(USDG, root, address(0)));
        console.log("gas createVault", before - gasleft());
        assertEq(address(vault), predicted);
        assertEq(address(vault.token()), USDG);
        assertEq(vault.keyRoot(), root);
        assertEq(vault.nonce(), 0);
        assertEq(vault.crank(), address(0));
        // Creating it again returns the same vault, unchanged.
        assertEq(factory.createVault(USDG, root, address(0)), address(vault));
        assertEq(vault.keyRoot(), root);
        vm.expectRevert();
        vault.initialize(USDG, bytes32(uint256(1)), address(0));
    }

    function test_transferRotatesTheKeyAndCannotBeReplayedOrRedirected() public {
        OstraVault vault = _vault(BUYER, address(0));
        _fund(address(vault), 50e6);
        address to = makeAddr("destination");
        bytes memory params = abi.encode(to, uint256(12e6));
        (bytes32 next, bytes memory signature) = _sign(vault, BUYER, 0, params);

        // A relayer cannot change the destination or the amount.
        vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
        vault.spend(0, next, abi.encode(makeAddr("thief"), uint256(12e6)), signature);
        vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
        vault.spend(0, next, abi.encode(to, uint256(13e6)), signature);
        // Nor the next key root.
        vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
        vault.spend(0, bytes32(uint256(7)), params, signature);

        uint256 before = gasleft();
        vault.spend(0, next, params, signature);
        console.log("gas spend Transfer", before - gasleft());
        assertEq(usdg.balanceOf(to), 12e6);
        assertEq(usdg.balanceOf(address(vault)), 38e6);
        assertEq(vault.nonce(), 1);
        assertEq(vault.keyRoot(), next);

        // The same signature never works again: the key has rotated.
        vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
        vault.spend(0, next, params, signature);

        // The next key works.
        _spend(vault, BUYER, 0, abi.encode(to, uint256(8e6)));
        assertEq(usdg.balanceOf(to), 20e6);
        assertEq(vault.nonce(), 2);
    }

    function test_spendShapesAreChecked() public {
        OstraVault vault = _vault(BUYER, address(0));
        bytes memory signature = new bytes(Wots.SIGNATURE_LEN);
        vm.expectRevert(OstraVault.BadAction.selector);
        vault.spend(4, bytes32(0), "", signature);
        vm.expectRevert(OstraVault.BadParams.selector);
        vault.spend(3, bytes32(0), new bytes(256), signature);
        vm.expectRevert(OstraVault.BadParams.selector);
        vault.spend(0, bytes32(0), abi.encode(address(1)), signature);
        vm.expectRevert(OstraVault.BadParams.selector);
        vault.spend(2, bytes32(0), abi.encode(address(1), uint256(1)), signature);
        vm.expectRevert(Wots.BadSignatureLength.selector);
        vault.spend(0, bytes32(0), abi.encode(address(1), uint256(1)), new bytes(10));
    }

    function test_setCrankKey() public {
        OstraVault vault = _vault(SELLER, vm.addr(keeperPk));
        assertEq(vault.crank(), vm.addr(keeperPk));
        _spend(vault, SELLER, 2, abi.encode(vm.addr(sellerCrankPk)));
        assertEq(vault.crank(), vm.addr(sellerCrankPk));
        _spend(vault, SELLER, 2, abi.encode(address(0)));
        assertEq(vault.crank(), address(0));
        assertEq(vault.nonce(), 2);
    }

    function test_collectWorksOnlyInsideTheVaultsOwnOpen() public {
        OstraVault vault = _vault(BUYER, address(0));
        _fund(address(vault), 10e6);
        vm.expectRevert(OstraVault.UnexpectedCollect.selector);
        vault.collect(address(vault), USDG, 1e6, bytes32(uint256(1)), "");
        vm.prank(BATCH);
        vm.expectRevert(OstraVault.UnexpectedCollect.selector);
        vault.collect(address(vault), USDG, 1e6, bytes32(uint256(1)), "");
        assertEq(usdg.balanceOf(address(vault)), 10e6);
    }

    // ---------------------------------------------------------------------------------------------
    // Channels on the deployed x402BatchSettlement
    // ---------------------------------------------------------------------------------------------

    function test_vaultToVaultChannelLifecycle() public {
        OstraVault buyer = _vault(BUYER, address(0));
        (OstraVault seller, OstraVault operator, OstraSplit split) = _seller();
        _fund(address(buyer), 100e6);

        IX402BatchSettlement.ChannelConfig memory c =
            _config(buyer, address(split), address(seller), keccak256("channel-1"));
        bytes32 id = batch.getChannelId(c);
        uint256 batchBefore = usdg.balanceOf(BATCH);

        _spend(buyer, BUYER, 1, _openParams(c, 2e6));
        (uint128 balance, uint128 claimed) = batch.channels(id);
        assertEq(balance, 2e6);
        assertEq(claimed, 0);
        assertEq(usdg.balanceOf(address(buyer)), 98e6);
        assertEq(usdg.balanceOf(BATCH), batchBefore + 2e6);

        // Only the seller vault's crank can claim through the seller vault.
        IX402BatchSettlement.VoucherClaim[] memory claims = _claims(c, 1.2e6);
        vm.expectRevert(OstraVault.Unauthorized.selector);
        seller.claim(claims);
        vm.prank(vm.addr(keeperPk));
        seller.claim(claims);
        (, claimed) = batch.channels(id);
        assertEq(claimed, 1.2e6);

        // Settle to the split, then distribute: 30 bps to the operator vault, the rest to the seller vault.
        batch.settle(address(split), USDG);
        split.distribute();
        assertEq(split.owed(address(operator)), 3600);
        assertEq(split.owed(address(seller)), 1.2e6 - 3600);
        assertEq(usdg.balanceOf(address(operator)), 0);
        split.release(address(operator));
        split.release(address(seller));
        assertEq(split.totalOwed(), 0);
        assertEq(usdg.balanceOf(address(operator)), 3600);
        assertEq(usdg.balanceOf(address(seller)), 1.2e6 - 3600);

        // The buyer's voucher key asks to close; the signature works once and not after its deadline.
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory closeSig = _ecdsa(voucherPk, buyer.closeDigest(id, 0.8e6, deadline));
        vm.warp(block.timestamp + 601);
        vm.expectRevert(OstraVault.Expired.selector);
        buyer.requestClose(c, 0.8e6, deadline, closeSig);
        vm.warp(block.timestamp - 601);
        buyer.requestClose(c, 0.8e6, deadline, closeSig);
        vm.expectRevert(OstraVault.Unauthorized.selector);
        buyer.requestClose(c, 0.8e6, deadline, closeSig);

        // Within the grace period the keeper still claims the last voucher.
        claims = _claims(c, 1.5e6);
        vm.prank(vm.addr(keeperPk));
        seller.claim(claims);

        // Too early to finalize; after the grace period anyone can, and the escrow goes back to the buyer.
        vm.expectRevert();
        buyer.finalizeWithdraw(c);
        vm.warp(block.timestamp + GRACE);
        vm.prank(makeAddr("anyone"));
        buyer.finalizeWithdraw(c);
        assertEq(usdg.balanceOf(address(buyer)), 98e6 + 0.5e6);

        batch.settle(address(split), USDG);
        split.distribute();
        split.distribute(); // nothing new arrived: owes nothing more
        assertEq(split.owed(address(operator)), 900);
        split.release(address(operator));
        split.release(address(seller));
        assertEq(usdg.balanceOf(address(split)), 0);
        assertEq(usdg.balanceOf(address(operator)), 3600 + 900);
        assertEq(usdg.balanceOf(address(seller)), 1.5e6 - 4500);
        assertEq(_sum(address(buyer), address(seller), address(operator)), 100e6);
        (balance, claimed) = batch.channels(id);
        assertEq(balance, claimed);
    }

    function _sum(address a, address b, address c) internal view returns (uint256) {
        return usdg.balanceOf(a) + usdg.balanceOf(b) + usdg.balanceOf(c);
    }

    function test_sellerTakesTheCrankBackAndSettlesItself() public {
        OstraVault buyer = _vault(BUYER, address(0));
        (OstraVault seller,, OstraSplit split) = _seller();
        _fund(address(buyer), 10e6);
        IX402BatchSettlement.ChannelConfig memory c =
            _config(buyer, address(split), address(seller), keccak256("channel-2"));
        _spend(buyer, BUYER, 1, _openParams(c, 1e6));

        // settle_self: the seller sets its own crank with a WOTS spend; the keeper's crank stops working.
        _spend(seller, SELLER, 2, abi.encode(vm.addr(sellerCrankPk)));
        IX402BatchSettlement.VoucherClaim[] memory claims = _claims(c, 0.6e6);
        vm.prank(vm.addr(keeperPk));
        vm.expectRevert(OstraVault.Unauthorized.selector);
        seller.claim(claims);
        vm.prank(vm.addr(sellerCrankPk));
        seller.claim(claims);
        (, uint128 claimed) = batch.channels(batch.getChannelId(c));
        assertEq(claimed, 0.6e6);
    }

    function test_crankRefundsUnclaimedEscrowToTheBuyerVault() public {
        OstraVault buyer = _vault(BUYER, address(0));
        (OstraVault seller,, OstraSplit split) = _seller();
        _fund(address(buyer), 10e6);
        IX402BatchSettlement.ChannelConfig memory c =
            _config(buyer, address(split), address(seller), keccak256("channel-3"));
        _spend(buyer, BUYER, 1, _openParams(c, 3e6));
        IX402BatchSettlement.VoucherClaim[] memory claims = _claims(c, 1e6);
        vm.prank(vm.addr(keeperPk));
        seller.claim(claims);

        vm.expectRevert(OstraVault.Unauthorized.selector);
        seller.refund(c, 2e6);
        vm.prank(vm.addr(keeperPk));
        seller.refund(c, 2e6);
        assertEq(usdg.balanceOf(address(buyer)), 7e6 + 2e6);
        (uint128 balance, uint128 claimed) = batch.channels(batch.getChannelId(c));
        assertEq(balance, 1e6);
        assertEq(claimed, 1e6);
    }

    function test_buyerVaultCrankCanRequestClose() public {
        OstraVault buyer = _vault(BUYER, vm.addr(buyerCrankPk));
        (OstraVault seller,, OstraSplit split) = _seller();
        _fund(address(buyer), 10e6);
        IX402BatchSettlement.ChannelConfig memory c =
            _config(buyer, address(split), address(seller), keccak256("channel-4"));
        bytes32 id = batch.getChannelId(c);
        _spend(buyer, BUYER, 1, _openParams(c, 1e6));

        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory wrong = _ecdsa(keeperPk, buyer.closeDigest(id, 1e6, deadline));
        vm.expectRevert(OstraVault.Unauthorized.selector);
        buyer.requestClose(c, 1e6, deadline, wrong);
        buyer.requestClose(c, 1e6, deadline, _ecdsa(buyerCrankPk, buyer.closeDigest(id, 1e6, deadline)));
        (uint128 pending, uint40 initiatedAt) = batch.pendingWithdrawals(id);
        assertEq(pending, 1e6);
        assertEq(initiatedAt, block.timestamp);
    }

    function test_openSignatureBindsTheWholeChannel() public {
        OstraVault buyer = _vault(BUYER, address(0));
        (OstraVault seller,, OstraSplit split) = _seller();
        _fund(address(buyer), 10e6);
        IX402BatchSettlement.ChannelConfig memory c =
            _config(buyer, address(split), address(seller), keccak256("channel-5"));
        bytes memory params = _openParams(c, 1e6);
        (bytes32 next, bytes memory signature) = _sign(buyer, BUYER, 1, params);
        IX402BatchSettlement.ChannelConfig memory other =
            _config(buyer, makeAddr("other receiver"), address(seller), keccak256("channel-5"));
        vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
        buyer.spend(1, next, _openParams(other, 1e6), signature);
        vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
        buyer.spend(1, next, _openParams(c, 2e6), signature);
        uint256 before = gasleft();
        buyer.spend(1, next, params, signature);
        console.log("gas spend OpenChannel", before - gasleft());
        (uint128 balance,) = batch.channels(batch.getChannelId(c));
        assertEq(balance, 1e6);

        // A channel without a voucher key is refused.
        IX402BatchSettlement.ChannelConfig memory noKey =
            _config(buyer, address(split), address(seller), keccak256("channel-6"));
        noKey.payerAuthorizer = address(0);
        bytes memory noKeyParams = _openParams(noKey, 1e6);
        (next, signature) = _sign(buyer, BUYER, 1, noKeyParams);
        vm.expectRevert(OstraVault.BadParams.selector);
        buyer.spend(1, next, noKeyParams, signature);
        assertEq(buyer.nonce(), 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Swaps on the deployed Uniswap v4 PoolManager
    // ---------------------------------------------------------------------------------------------

    /// @dev The hookless native ETH/USDG pool at 0.05% (currency0 = ETH, currency1 = USDG).
    function _ethUsdg() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(USDG),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(0))
        });
    }

    function _swapParams(PoolKey memory key, bool zeroForOne, uint128 amountIn, uint128 minOut, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(key, zeroForOne, amountIn, minOut, recipient);
    }

    /// @dev What a swap of `amountIn` USDG for ETH pays out right now, learned by doing it and rolling back.
    function _ethOut(OstraVault vault, uint128 amountIn) internal returns (uint256 out) {
        uint256 snapshot = vm.snapshotState();
        address probe = makeAddr("probe");
        _spend(vault, BUYER, 3, _swapParams(_ethUsdg(), false, amountIn, 1, probe));
        out = probe.balance;
        vm.revertToState(snapshot);
    }

    function test_swapUsdgForEthOnTheDeployedPool() public {
        OstraVault vault = _vault(BUYER, address(0));
        _fund(address(vault), 100e6);
        address to = makeAddr("eth recipient");
        uint256 expected = _ethOut(vault, 10e6);
        assertGt(expected, 0);

        // Below the signed minimum the whole spend reverts: the key does not rotate and nothing moves.
        bytes memory params = _swapParams(_ethUsdg(), false, 10e6, uint128(expected + 1), to);
        (bytes32 next, bytes memory signature) = _sign(vault, BUYER, 3, params);
        vm.expectRevert(OstraVault.InsufficientOutput.selector);
        vault.spend(3, next, params, signature);
        assertEq(vault.nonce(), 0);
        assertEq(usdg.balanceOf(address(vault)), 100e6);

        params = _swapParams(_ethUsdg(), false, 10e6, uint128(expected), to);
        (next, signature) = _sign(vault, BUYER, 3, params);
        vm.expectEmit(address(vault));
        emit OstraVault.Swapped(keccak256(abi.encode(_ethUsdg())), false, 10e6, expected, to);
        uint256 before = gasleft();
        vault.spend(3, next, params, signature);
        console.log("gas spend Swap (USDG to ETH, v4 pool without hook)", before - gasleft());
        assertEq(to.balance, expected);
        assertEq(usdg.balanceOf(address(vault)), 90e6);
        assertEq(vault.nonce(), 1);
        assertEq(vault.keyRoot(), next);
        // The PoolManager keeps no open delta: a second swap in the same block works the same way.
        _spend(vault, BUYER, 3, _swapParams(_ethUsdg(), false, 10e6, 1, to));
        assertEq(usdg.balanceOf(address(vault)), 80e6);
        assertGt(to.balance, expected);
    }

    /// @dev The token at 0xaF3D...93f9 (symbol AAPL, 18 decimals), a stock token on Robinhood Chain.
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    bytes32 internal constant BUYER_AAPL = keccak256("OSTRA/EVM/TEST/buyer-aapl-vault");

    /// @dev The hookless USDG/AAPL pool at 0.30% (currency0 = USDG, currency1 = AAPL).
    function _usdgAapl() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(USDG),
            currency1: Currency.wrap(AAPL),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }

    function _buyAapl(OstraVault buyer, address recipient) internal {
        bytes memory params = _swapParams(_usdgAapl(), true, 10e6, 1, recipient);
        (bytes32 next, bytes memory signature) = _sign(buyer, BUYER, 3, params);
        uint256 before = gasleft();
        buyer.spend(3, next, params, signature);
        console.log("gas spend Swap (USDG to a stock token vault, v4 pool without hook)", before - gasleft());
    }

    function test_swapIntoAnotherVaultAndBack() public {
        assertLt(uint160(USDG), uint160(AAPL));
        OstraVault buyer = _vault(BUYER, address(0));
        OstraVault stock = OstraVault(factory.createVault(AAPL, _root(BUYER_AAPL, 0), address(0)));
        _fund(address(buyer), 100e6);
        IERC20 aapl = IERC20(AAPL);

        // The purchase lands straight in the buyer's own WOTS vault for that token.
        _buyAapl(buyer, address(stock));
        uint256 bought = aapl.balanceOf(address(stock));
        assertGt(bought, 0);
        assertEq(usdg.balanceOf(address(buyer)), 90e6);

        // That vault spends it only with its own key: half goes back to USDG in the first vault.
        uint128 half = uint128(bought / 2);
        _spend(stock, BUYER_AAPL, 3, _swapParams(_usdgAapl(), false, half, 1, address(buyer)));
        assertEq(aapl.balanceOf(address(stock)), bought - half);
        assertGt(usdg.balanceOf(address(buyer)), 90e6);
        assertLt(usdg.balanceOf(address(buyer)), 95e6);
        // And a Transfer works on the stock vault as on any vault.
        address out = makeAddr("aapl destination");
        _spend(stock, BUYER_AAPL, 0, abi.encode(out, bought - half));
        assertEq(aapl.balanceOf(out), bought - half);
        assertEq(aapl.balanceOf(address(stock)), 0);
    }

    function test_swapSignatureBindsPoolDirectionAmountsAndRecipient() public {
        OstraVault vault = _vault(BUYER, address(0));
        _fund(address(vault), 100e6);
        address to = makeAddr("eth recipient");
        bytes memory params = _swapParams(_ethUsdg(), false, 10e6, 1, to);
        (bytes32 next, bytes memory signature) = _sign(vault, BUYER, 3, params);

        PoolKey memory otherPool = _ethUsdg();
        otherPool.fee = 3000;
        otherPool.tickSpacing = 60;
        bytes[] memory forged = new bytes[](6);
        forged[0] = _swapParams(otherPool, false, 10e6, 1, to);
        forged[1] = _swapParams(_ethUsdg(), true, 10e6, 1, to);
        forged[2] = _swapParams(_ethUsdg(), false, 11e6, 1, to);
        forged[3] = _swapParams(_ethUsdg(), false, 10e6, 0, to);
        forged[4] = _swapParams(_ethUsdg(), false, 10e6, 1, makeAddr("thief"));
        PoolKey memory hooked = _ethUsdg();
        hooked.hooks = IHooks(makeAddr("hook"));
        forged[5] = _swapParams(hooked, false, 10e6, 1, to);
        for (uint256 i = 0; i < forged.length; ++i) {
            vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
            vault.spend(3, next, forged[i], signature);
        }
        // Nor can the action be changed: the same bytes as another action are refused by shape or signature.
        vm.expectRevert(OstraVault.BadParams.selector);
        vault.spend(0, next, params, signature);
        vault.spend(3, next, params, signature);
        assertEq(usdg.balanceOf(address(vault)), 90e6);
    }

    function test_swapNeedsTheVaultsTokenOnTheInputSide() public {
        OstraVault vault = _vault(BUYER, address(0));
        _fund(address(vault), 100e6);
        address to = makeAddr("recipient");
        // zeroForOne on ETH/USDG would spend ETH, which this USDG vault does not hold.
        bytes memory params = _swapParams(_ethUsdg(), true, 1e15, 1, to);
        (bytes32 next, bytes memory signature) = _sign(vault, BUYER, 3, params);
        vm.expectRevert(OstraVault.WrongToken.selector);
        vault.spend(3, next, params, signature);
        params = _swapParams(_ethUsdg(), false, 0, 0, to);
        (next, signature) = _sign(vault, BUYER, 3, params);
        vm.expectRevert(OstraVault.ZeroAmount.selector);
        vault.spend(3, next, params, signature);
        params = _swapParams(_ethUsdg(), false, 10e6, 1, address(0));
        (next, signature) = _sign(vault, BUYER, 3, params);
        vm.expectRevert(OstraVault.BadParams.selector);
        vault.spend(3, next, params, signature);
        // More than the vault holds: the transfer into the PoolManager fails and nothing moves.
        params = _swapParams(_ethUsdg(), false, 101e6, 1, to);
        (next, signature) = _sign(vault, BUYER, 3, params);
        vm.expectRevert();
        vault.spend(3, next, params, signature);
        assertEq(vault.nonce(), 0);
        assertEq(usdg.balanceOf(address(vault)), 100e6);
    }

    function test_unlockCallbackWorksOnlyInsideTheVaultsOwnSwap() public {
        OstraVault vault = _vault(BUYER, address(0));
        _fund(address(vault), 100e6);
        bytes memory params = _swapParams(_ethUsdg(), false, 10e6, 1, makeAddr("thief"));
        vm.expectRevert(OstraVault.UnexpectedCallback.selector);
        vault.unlockCallback(params);
        vm.prank(POOL_MANAGER);
        vm.expectRevert(OstraVault.UnexpectedCallback.selector);
        vault.unlockCallback(params);
        assertEq(usdg.balanceOf(address(vault)), 100e6);
    }

    function test_ethOutputToARecipientThatRefusesEthReverts() public {
        OstraVault vault = _vault(BUYER, address(0));
        OstraVault other = _vault(SELLER, address(0));
        _fund(address(vault), 100e6);
        // A vault has no receive function, so native ETH cannot be paid to it; the whole spend reverts.
        bytes memory params = _swapParams(_ethUsdg(), false, 10e6, 1, address(other));
        (bytes32 next, bytes memory signature) = _sign(vault, BUYER, 3, params);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(other),
                bytes4(0),
                "",
                abi.encodePacked(CurrencyLibrary.NativeTransferFailed.selector)
            )
        );
        vault.spend(3, next, params, signature);
        assertEq(vault.nonce(), 0);
        assertEq(usdg.balanceOf(address(vault)), 100e6);
    }
}
