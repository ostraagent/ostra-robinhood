// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraSplit, OstraSplitFactory} from "../src/OstraSplit.sol";
import {Wots} from "../src/Wots.sol";
import {IX402BatchSettlement} from "../src/interfaces/IX402BatchSettlement.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";

/// @notice Vaults on a fork of Robinhood Chain mainnet, against the deployed USDG and x402BatchSettlement.
contract VaultForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant BATCH = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;
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
        assertEq(batch.MIN_WITHDRAW_DELAY(), GRACE);
        OstraVault implementation = new OstraVault(BATCH);
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
        vault.spend(3, bytes32(0), "", signature);
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
}
