// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

import {OstraPool} from "../src/OstraPool.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";

interface IUSDG {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function freeze(address account) external;
    function unfreeze(address account) external;
    function isFrozen(address account) external view returns (bool);
}

/// @notice The shielded pool on a fork of Robinhood Chain mainnet, with the real USDG (EIP-3009 included).
contract PoolForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint64 internal constant LEAF = 10e6;
    uint16 internal constant FEE_BPS = 30;
    uint64 internal constant MAX_DEPOSIT = 250e6;
    uint64 internal constant MAX_TOTAL = 2_500e6;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant APPROVALS = keccak256("OSTRA/EVM/TEST/approval-keys");
    bytes32 internal constant LEAVES = keccak256("OSTRA/EVM/TEST/leaf-keys");

    IERC20 internal usdg = IERC20(USDG);
    OstraPool internal pool;
    address internal authority = makeAddr("init authority");
    address internal treasury = makeAddr("treasury");
    address internal aggregator = makeAddr("aggregator");

    struct Dep {
        uint256 pk;
        address depositor;
        bytes32 id;
        bytes32 key;
        uint64 amount;
        uint256[] leafIdx;
        uint64 approvalIndex;
    }

    function setUp() public {
        vm.createSelectFork("robinhood");
        OstraPool implementation = new OstraPool();
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(implementation), address(this));
        pool = OstraPool(
            address(
                new BeaconProxy(
                    address(beacon),
                    abi.encodeCall(OstraPool.initialize, (USDG, FEE_BPS, treasury, MAX_DEPOSIT, MAX_TOTAL, authority))
                )
            )
        );
        assertEq(pool.leafAmount(), LEAF);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _leafRoot(uint256 i) internal pure returns (bytes32) {
        return WotsSigner.keyRoot(WotsSigner.deriveSeed(MASTER, LEAVES, uint64(i)));
    }

    function _approvalSeed(uint256 depositIndex, uint64 n) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keccak256(abi.encode(APPROVALS, depositIndex)), n);
    }

    /// @dev The gross amount whose net after the pool fee is exactly `net`.
    function _gross(uint64 net) internal pure returns (uint64 a) {
        a = uint64((uint256(net) * 10_000) / (10_000 - FEE_BPS));
        while (a - uint64((uint256(a) * FEE_BPS) / 10_000) < net) a++;
        while (a - uint64((uint256(a) * FEE_BPS) / 10_000) > net) a--;
        assertEq(a - uint64((uint256(a) * FEE_BPS) / 10_000), net);
    }

    function _newDep(uint256 index, uint256[] memory leafIdx) internal returns (Dep memory d) {
        d.pk = uint256(keccak256(abi.encode("OSTRA/EVM/TEST/depositor", index)));
        d.depositor = vm.addr(d.pk);
        d.id = keccak256(abi.encode("deposit-id", index));
        d.key = pool.depositKey(d.depositor, d.id);
        d.amount = _gross(LEAF * uint64(leafIdx.length));
        d.leafIdx = leafIdx;
        d.approvalIndex = uint64(index);
        deal(USDG, d.depositor, d.amount);
    }

    function _rootOfApproval(Dep memory d, uint64 n) internal pure returns (bytes32) {
        return WotsSigner.keyRoot(_approvalSeed(d.approvalIndex, n));
    }

    /// @dev Plain deposit: the depositor approves the pool and calls it.
    function _depositPlain(Dep memory d) internal {
        vm.startPrank(d.depositor);
        usdg.approve(address(pool), d.amount);
        pool.deposit(d.id, d.amount, d.depositor, _rootOfApproval(d, 0));
        vm.stopPrank();
    }

    /// @dev Relayed deposit: the depositor only signs an EIP-3009 ReceiveWithAuthorization.
    function _depositSigned(Dep memory d) internal {
        bytes32 root = _rootOfApproval(d, 0);
        bytes32 nonce = pool.depositNonce(d.depositor, d.id, d.amount, d.depositor, root);
        uint256 validBefore = block.timestamp + 3600;
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, d.depositor, address(pool), uint256(d.amount), 0, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IUSDG(USDG).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(d.pk, digest);
        vm.prank(makeAddr("relayer"));
        pool.depositWithAuthorization(d.depositor, d.id, d.amount, d.depositor, root, 0, validBefore, v, r, s);
    }

    function _approve(Dep memory d, uint64 batchId, uint64 n) internal {
        bytes32 state = pool.batchState(batchId);
        bytes32 next = _rootOfApproval(d, n + 1);
        bytes memory message = pool.approvalMessage(d.key, batchId, state, next);
        pool.approveBatch(d.key, batchId, state, next, WotsSigner.sign(_approvalSeed(d.approvalIndex, n), message));
    }

    function _idx(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _idx(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _idx(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    /// @dev Eight deposits (11 leaves) in one batch, leaves appended in a shuffled order over two calls.
    function _eightDepositsInABatch() internal returns (Dep[] memory deps, uint64 batchId) {
        deps = new Dep[](8);
        deps[0] = _newDep(0, _idx(0));
        deps[1] = _newDep(1, _idx(1));
        deps[2] = _newDep(2, _idx(2));
        deps[3] = _newDep(3, _idx(3));
        deps[4] = _newDep(4, _idx(4));
        deps[5] = _newDep(5, _idx(5));
        deps[6] = _newDep(6, _idx(6, 7));
        deps[7] = _newDep(7, _idx(8, 9, 10));
        for (uint256 i = 0; i < 8; ++i) {
            if (i % 2 == 0) _depositSigned(deps[i]);
            else _depositPlain(deps[i]);
        }
        vm.prank(aggregator);
        batchId = pool.createBatch(11);
        uint256[11] memory order = [uint256(7), 2, 10, 0, 5, 9, 1, 4, 8, 3, 6];
        bytes32[] memory first = new bytes32[](6);
        bytes32[] memory second = new bytes32[](5);
        for (uint256 i = 0; i < 6; ++i) first[i] = _leafRoot(order[i]);
        for (uint256 i = 0; i < 5; ++i) second[i] = _leafRoot(order[6 + i]);
        vm.startPrank(aggregator);
        pool.appendLeaves(batchId, first);
        pool.appendLeaves(batchId, second);
        vm.stopPrank();
    }

    function _keys(Dep[] memory deps) internal pure returns (bytes32[] memory keys) {
        keys = new bytes32[](deps.length);
        for (uint256 i = 0; i < deps.length; ++i) {
            keys[i] = deps[i].key;
        }
    }

    function _leafIndexOf(uint64 batchId, uint256 leafKey) internal view returns (uint16) {
        bytes32 root = _leafRoot(leafKey);
        for (uint16 i = 0; i < 11; ++i) {
            (bytes32 r,) = pool.leaf(batchId, i);
            if (r == root) return i;
        }
        revert("leaf not in batch");
    }

    // ---------------------------------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------------------------------

    function test_initRules() public {
        OstraPool implementation = new OstraPool();
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(implementation), address(this));
        vm.expectRevert(OstraPool.InvalidFee.selector);
        new BeaconProxy(address(beacon), abi.encodeCall(OstraPool.initialize, (USDG, 501, treasury, 1, 1, authority)));
        vm.expectRevert(OstraPool.InvalidLimits.selector);
        new BeaconProxy(address(beacon), abi.encodeCall(OstraPool.initialize, (USDG, 30, treasury, 2, 1, authority)));
        vm.expectRevert(OstraPool.InvalidTreasury.selector);
        new BeaconProxy(address(beacon), abi.encodeCall(OstraPool.initialize, (USDG, 30, address(0), 1, 1, authority)));
        vm.expectRevert();
        pool.initialize(USDG, 30, treasury, 1, 1, authority);
    }

    function test_limitsOnlyGoUpAndOnlyByTheAuthority() public {
        vm.expectRevert(OstraPool.Unauthorized.selector);
        pool.setLimits(300e6, 3_000e6);
        vm.startPrank(authority);
        vm.expectRevert(OstraPool.InvalidLimits.selector);
        pool.setLimits(200e6, 3_000e6);
        vm.expectRevert(OstraPool.InvalidLimits.selector);
        pool.setLimits(300e6, 2_000e6);
        pool.setLimits(300e6, 3_000e6);
        vm.stopPrank();
        assertEq(pool.maxDeposit(), 300e6);
        assertEq(pool.maxTotal(), 3_000e6);
    }

    function test_depositsOutsideTheRulesAreRefused() public {
        Dep memory d = _newDep(20, _idx(0));
        bytes32 root = _rootOfApproval(d, 0);
        vm.startPrank(d.depositor);
        usdg.approve(address(pool), type(uint256).max);
        // Not a whole number of leaves after the fee.
        deal(USDG, d.depositor, 1_000e6);
        vm.expectRevert(OstraPool.NonStandardDeposit.selector);
        pool.deposit(d.id, 10e6, d.depositor, root);
        // Over the per-deposit limit (26 leaves after the fee).
        vm.expectRevert(OstraPool.DepositOverLimit.selector);
        pool.deposit(d.id, _gross(260e6), d.depositor, root);
        vm.expectRevert(OstraPool.ZeroAmount.selector);
        pool.deposit(d.id, 0, d.depositor, root);
        vm.expectRevert(OstraPool.InvalidRefundOwner.selector);
        pool.deposit(d.id, d.amount, address(0), root);
        vm.expectRevert(OstraPool.InvalidRefundOwner.selector);
        pool.deposit(d.id, d.amount, address(pool), root);
        pool.deposit(d.id, d.amount, d.depositor, root);
        vm.expectRevert(OstraPool.DepositExists.selector);
        pool.deposit(d.id, d.amount, d.depositor, root);
        // A version 2 deposit records no leaf commitment.
        assertEq(pool.getDeposit(d.key).legacyCommitmentHash, bytes32(0));
        vm.stopPrank();

        // Over the pool total: tokens sent to the pool directly count too.
        deal(USDG, address(pool), MAX_TOTAL);
        Dep memory e = _newDep(21, _idx(1));
        vm.startPrank(e.depositor);
        usdg.approve(address(pool), e.amount);
        vm.expectRevert(OstraPool.PoolOverLimit.selector);
        pool.deposit(e.id, e.amount, e.depositor, _rootOfApproval(e, 0));
        vm.stopPrank();
    }

    function test_relayedDepositCannotBeAltered() public {
        Dep memory d = _newDep(30, _idx(0));
        bytes32 root = _rootOfApproval(d, 0);
        bytes32 nonce = pool.depositNonce(d.depositor, d.id, d.amount, d.depositor, root);
        uint256 validBefore = block.timestamp + 3600;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IUSDG(USDG).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(RECEIVE_TYPEHASH, d.depositor, address(pool), uint256(d.amount), 0, validBefore, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(d.pk, digest);
        // Another refund owner changes the nonce, so the token rejects the authorization.
        vm.expectRevert();
        pool.depositWithAuthorization(d.depositor, d.id, d.amount, makeAddr("thief"), root, 0, validBefore, v, r, s);
        uint256 before = gasleft();
        pool.depositWithAuthorization(d.depositor, d.id, d.amount, d.depositor, root, 0, validBefore, v, r, s);
        console.log("gas depositWithAuthorization", before - gasleft());
        assertEq(usdg.balanceOf(address(pool)), d.amount);
        assertEq(usdg.balanceOf(d.depositor), 0);
    }

    function test_eightDepositsSealAndLeavesSpend() public {
        (Dep[] memory deps, uint64 batchId) = _sealEight();
        _spendLeafFour(batchId);
        // A sealed batch closes only when every leaf is spent; consumed deposits can be cleared.
        vm.expectRevert(OstraPool.BatchNotEmpty.selector);
        pool.closeBatch(batchId);
        _spendTheRest(batchId);
        assertEq(usdg.balanceOf(address(pool)), 0);
        pool.closeBatch(batchId);
        pool.closeDeposit(deps[0].key);
        assertEq(pool.getDeposit(deps[0].key).status, pool.DEPOSIT_CLOSED());
        vm.expectRevert(OstraPool.DepositNotConsumed.selector);
        pool.closeDeposit(deps[0].key);
        assertEq(pool.feesOwed(), 0);
    }

    function _sealEight() internal returns (Dep[] memory deps, uint64 batchId) {
        (deps, batchId) = _eightDepositsInABatch();
        uint256 poolBalance = usdg.balanceOf(address(pool));
        for (uint256 i = 0; i < 8; ++i) {
            _approve(deps[i], batchId, 0);
        }
        bytes32[] memory keys = _keys(deps);
        vm.expectRevert(OstraPool.Unauthorized.selector);
        pool.sealBatch(batchId, keys);
        vm.prank(aggregator);
        uint256 g = gasleft();
        pool.sealBatch(batchId, keys);
        console.log("gas sealBatch 8 deposits 11 leaves", g - gasleft());

        uint256 fees;
        for (uint256 i = 0; i < 8; ++i) {
            fees += (uint256(deps[i].amount) * FEE_BPS) / 10_000;
            assertEq(pool.getDeposit(deps[i].key).status, pool.DEPOSIT_CONSUMED());
        }
        assertEq(usdg.balanceOf(treasury), fees);
        assertEq(usdg.balanceOf(address(pool)), poolBalance - fees);
        assertEq(usdg.balanceOf(address(pool)), 11 * uint256(LEAF));
        (uint8 status,,, uint16 count, uint16 unspent, uint64 total) = pool.getBatch(batchId);
        assertEq(status, pool.BATCH_SEALED());
        assertEq(count, 11);
        assertEq(unspent, 11);
        assertEq(total, 11 * LEAF);
    }

    /// @dev Spends leaf 4 to a fresh address; a submitter cannot redirect it, and it spends once.
    function _spendLeafFour(uint64 batchId) internal {
        uint16 at = _leafIndexOf(batchId, 4);
        address destination = makeAddr("fresh private vault");
        bytes memory signature =
            WotsSigner.sign(WotsSigner.deriveSeed(MASTER, LEAVES, 4), pool.leafMessage(batchId, at, destination));
        vm.expectRevert(OstraPool.WotsSignatureInvalid.selector);
        pool.spendLeaf(batchId, at, makeAddr("thief"), signature);
        uint256 g = gasleft();
        pool.spendLeaf(batchId, at, destination, signature);
        console.log("gas spendLeaf", g - gasleft());
        assertEq(usdg.balanceOf(destination), LEAF);
        vm.expectRevert(OstraPool.LeafAlreadySpent.selector);
        pool.spendLeaf(batchId, at, destination, signature);
    }

    function _spendTheRest(uint64 batchId) internal {
        for (uint256 k = 0; k < 11; ++k) {
            if (k == 4) continue;
            uint16 i = _leafIndexOf(batchId, k);
            address to = address(uint160(0x1000 + k));
            bytes memory message = pool.leafMessage(batchId, i, to);
            pool.spendLeaf(batchId, i, to, WotsSigner.sign(WotsSigner.deriveSeed(MASTER, LEAVES, uint64(k)), message));
            assertEq(usdg.balanceOf(to), LEAF);
        }
    }

    function test_sealRefusesAnyMismatch() public {
        (Dep[] memory deps, uint64 batchId) = _eightDepositsInABatch();
        for (uint256 i = 0; i < 7; ++i) {
            _approve(deps[i], batchId, 0);
        }
        bytes32[] memory keys = _keys(deps);
        // One deposit has not approved.
        vm.prank(aggregator);
        vm.expectRevert(OstraPool.DepositNotApproved.selector);
        pool.sealBatch(batchId, keys);
        _approve(deps[7], batchId, 0);

        // Leaving a deposit out: the amounts no longer add up.
        bytes32[] memory fewer = new bytes32[](7);
        for (uint256 i = 0; i < 7; ++i) fewer[i] = keys[i];
        vm.prank(aggregator);
        vm.expectRevert(OstraPool.BatchAmountMismatch.selector);
        pool.sealBatch(batchId, fewer);

        // Listing a deposit twice does not count it twice.
        bytes32[] memory twice = new bytes32[](9);
        for (uint256 i = 0; i < 8; ++i) twice[i] = keys[i];
        twice[8] = keys[0];
        vm.prank(aggregator);
        vm.expectRevert(OstraPool.DepositNotPending.selector);
        pool.sealBatch(batchId, twice);

        // The batch is full: nothing more can be appended.
        vm.prank(aggregator);
        vm.expectRevert(OstraPool.BatchFull.selector);
        pool.appendLeaves(batchId, new bytes32[](1));
    }

    function test_appendVoidsApprovalsAndNonStandardLeavesNeverEnter() public {
        Dep memory a = _newDep(40, _idx(0));
        Dep memory b = _newDep(41, _idx(1));
        _depositPlain(a);
        _depositPlain(b);
        vm.prank(aggregator);
        uint64 batchId = pool.createBatch(3);
        bytes32[] memory one = new bytes32[](1);
        one[0] = _leafRoot(0);
        vm.prank(aggregator);
        pool.appendLeaves(batchId, one);
        vm.expectRevert(OstraPool.Unauthorized.selector);
        pool.appendLeaves(batchId, one);
        _approve(a, batchId, 0);
        one[0] = _leafRoot(1);
        vm.prank(aggregator);
        pool.appendLeaves(batchId, one);
        _approve(b, batchId, 0);
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = a.key;
        keys[1] = b.key;
        // a approved an older state.
        vm.prank(aggregator);
        vm.expectRevert(OstraPool.DepositNotApproved.selector);
        pool.sealBatch(batchId, keys);
        // a approves again with its next key; then the batch seals.
        _approve(a, batchId, 1);
        vm.prank(aggregator);
        pool.sealBatch(batchId, keys);
        (uint8 status,,,,,) = pool.getBatch(batchId);
        assertEq(status, pool.BATCH_SEALED());

        // An approval with the wrong key is refused.
        Dep memory c = _newDep(42, _idx(2));
        _depositPlain(c);
        bytes32 state = pool.batchState(batchId);
        bytes memory message = pool.approvalMessage(c.key, batchId, state, bytes32(0));
        vm.expectRevert(OstraPool.WotsSignatureInvalid.selector);
        pool.approveBatch(c.key, batchId, state, bytes32(0), WotsSigner.sign(_approvalSeed(c.approvalIndex, 1), message));
    }

    function test_abandonedBatchNeverSeals() public {
        Dep memory a = _newDep(50, _idx(0));
        _depositPlain(a);
        vm.prank(aggregator);
        uint64 batchId = pool.createBatch(1);
        bytes32[] memory one = new bytes32[](1);
        one[0] = _leafRoot(0);
        vm.prank(aggregator);
        pool.appendLeaves(batchId, one);
        _approve(a, batchId, 0);
        vm.expectRevert(OstraPool.Unauthorized.selector);
        pool.closeBatch(batchId);
        vm.prank(aggregator);
        pool.closeBatch(batchId);
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = a.key;
        vm.prank(aggregator);
        vm.expectRevert(OstraPool.BatchNotOpen.selector);
        pool.sealBatch(batchId, keys);
        vm.expectRevert(OstraPool.BatchNotSealed.selector);
        pool.spendLeaf(batchId, 0, address(1), new bytes(1892));
    }

    function test_unconsumedDepositRefundsInFullAfter48Hours() public {
        Dep memory a = _newDep(60, _idx(0, 1));
        _depositSigned(a);
        vm.expectRevert(OstraPool.DepositTimeoutNotReached.selector);
        pool.cancelDeposit(a.key);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert(OstraPool.DepositTimeoutNotReached.selector);
        pool.cancelDeposit(a.key);
        vm.warp(block.timestamp + 1);
        vm.prank(makeAddr("anyone"));
        pool.cancelDeposit(a.key);
        assertEq(usdg.balanceOf(a.depositor), a.amount);
        assertEq(usdg.balanceOf(treasury), 0);
        vm.expectRevert(OstraPool.DepositNotPending.selector);
        pool.cancelDeposit(a.key);
        assertEq(pool.getDeposit(a.key).status, pool.DEPOSIT_CANCELLED());
        // The key is never free again, so old approvals can never apply to a new deposit under it.
        vm.startPrank(a.depositor);
        usdg.approve(address(pool), a.amount);
        vm.expectRevert(OstraPool.DepositExists.selector);
        pool.deposit(a.id, a.amount, a.depositor, _rootOfApproval(a, 0));
        vm.stopPrank();
    }

    /// @notice USDG can freeze addresses. If the treasury is frozen, sealing still works and the fee waits as
    ///         owed until the treasury can receive it. The freeze uses USDG's real asset protection role holder.
    function test_sealingDoesNotDependOnTheTreasury() public {
        address assetProtection = 0x3Af3e85f4f97De7AD0f000B724Fb77fE5ffc024B;
        assertTrue(IUSDG(USDG).hasRole(keccak256("ASSET_PROTECTION_ROLE"), assetProtection));
        vm.prank(assetProtection);
        IUSDG(USDG).freeze(treasury);
        assertTrue(IUSDG(USDG).isFrozen(treasury));

        (Dep[] memory deps, uint64 batchId) = _eightDepositsInABatch();
        for (uint256 i = 0; i < 8; ++i) {
            _approve(deps[i], batchId, 0);
        }
        bytes32[] memory keys = _keys(deps);
        vm.prank(aggregator);
        pool.sealBatch(batchId, keys);
        uint256 fees;
        for (uint256 i = 0; i < 8; ++i) {
            fees += (uint256(deps[i].amount) * FEE_BPS) / 10_000;
        }
        assertEq(pool.feesOwed(), fees);
        assertEq(usdg.balanceOf(treasury), 0);
        vm.expectRevert();
        pool.sendFees();

        vm.prank(assetProtection);
        IUSDG(USDG).unfreeze(treasury);
        pool.sendFees();
        assertEq(pool.feesOwed(), 0);
        assertEq(usdg.balanceOf(treasury), fees);
        assertEq(usdg.balanceOf(address(pool)), 11 * uint256(LEAF));
    }

    /// @notice Leaves no deposit paid for never seal, even when every deposit approved: a depositor checks only
    ///         that its own leaves are there, and the amounts must still add up to the batch's leaves.
    function test_leavesNoDepositPaidForNeverSeal() public {
        Dep memory a = _newDep(70, _idx(0));
        Dep memory b = _newDep(71, _idx(1));
        _depositPlain(a);
        _depositPlain(b);
        vm.prank(aggregator);
        uint64 batchId = pool.createBatch(3);
        bytes32[] memory roots = new bytes32[](3);
        roots[0] = _leafRoot(0);
        roots[1] = keccak256("a leaf of the aggregator's own");
        roots[2] = _leafRoot(1);
        vm.prank(aggregator);
        pool.appendLeaves(batchId, roots);
        _approve(a, batchId, 0);
        _approve(b, batchId, 0);
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = a.key;
        keys[1] = b.key;
        vm.prank(aggregator);
        vm.expectRevert(OstraPool.BatchAmountMismatch.selector);
        pool.sealBatch(batchId, keys);
    }

    /// @notice Nothing a deposit puts on-chain names its leaves: no leaf key root is in a deposit's calldata or
    ///         in any event it emits, so the chain cannot match a deposit to the leaves it gets.
    function test_depositsRevealNoLeaf() public {
        Dep memory a = _newDep(80, _idx(0, 1));
        Dep memory b = _newDep(81, _idx(2));
        vm.recordLogs();
        _depositPlain(a);
        _depositSigned(b);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(logs.length, 0);
        bytes32 created = keccak256("DepositCreated(bytes32,address,bytes32,uint64,address,bytes32)");
        uint256 seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            for (uint256 k = 0; k < 3; ++k) {
                bytes32 root = _leafRoot(k);
                for (uint256 t = 0; t < logs[i].topics.length; ++t) {
                    assertTrue(logs[i].topics[t] != root, "a leaf root in an event topic");
                }
                bytes memory data = logs[i].data;
                for (uint256 w = 0; w + 32 <= data.length; ++w) {
                    bytes32 word;
                    assembly ("memory-safe") {
                        word := mload(add(add(data, 32), w))
                    }
                    assertTrue(word != root, "a leaf root in event data");
                }
            }
            if (logs[i].emitter == address(pool) && logs[i].topics[0] == created) {
                // depositId, amount, refundOwner, approvalKeyRoot: four words, nothing else.
                assertEq(logs[i].data.length, 4 * 32);
                ++seen;
            }
        }
        assertEq(seen, 2);
    }

    function test_gasAppendNinetyLeaves() public {
        vm.prank(aggregator);
        uint64 batchId = pool.createBatch(192);
        bytes32[] memory roots = new bytes32[](90);
        for (uint256 i = 0; i < 90; ++i) roots[i] = keccak256(abi.encode("leaf", i));
        vm.prank(aggregator);
        uint256 before = gasleft();
        pool.appendLeaves(batchId, roots);
        console.log("gas appendLeaves 90 leaves", before - gasleft());
        (,,, uint16 count,,) = pool.getBatch(batchId);
        assertEq(count, 90);
    }

    // ---------------------------------------------------------------------------------------------
    // The upgrade of the live pool (OstraPool version 1 to 2 through its beacon)
    // ---------------------------------------------------------------------------------------------

    /// @dev deployments/robinhood-mainnet.json
    address internal constant LIVE_POOL = 0x6ea80F2462e5Fd783B0Ec3B2c7BaC96795980CD6;
    address internal constant LIVE_POOL_BEACON = 0x30669Ca534921038a531BBE27116d85bB7406fFF;
    address internal constant LIVE_POOL_IMPLEMENTATION = 0x5b588aFc9436d15CD58758b77C9D8E5CA26984cb;

    struct PoolSnapshot {
        address token;
        uint16 feeBps;
        address treasury;
        address initAuthority;
        uint64 leafAmount;
        uint64 maxDeposit;
        uint64 maxTotal;
        uint64 batchCount;
        uint256 feesOwed;
        uint256 balance;
    }

    function _snapshot(OstraPool p) internal view returns (PoolSnapshot memory s) {
        s.token = address(p.token());
        s.feeBps = p.feeBps();
        s.treasury = p.treasury();
        s.initAuthority = p.initAuthority();
        s.leafAmount = p.leafAmount();
        s.maxDeposit = p.maxDeposit();
        s.maxTotal = p.maxTotal();
        s.batchCount = p.batchCount();
        s.feesOwed = p.feesOwed();
        s.balance = usdg.balanceOf(address(p));
    }

    function _upgradeLivePool() internal returns (PoolSnapshot memory before) {
        UpgradeableBeacon beacon = UpgradeableBeacon(LIVE_POOL_BEACON);
        assertEq(beacon.implementation(), LIVE_POOL_IMPLEMENTATION);
        OstraPool live = OstraPool(LIVE_POOL);
        before = _snapshot(live);
        bytes32[] memory states = new bytes32[](before.batchCount);
        for (uint64 i = 0; i < before.batchCount; ++i) states[i] = live.batchState(i);
        OstraPool next = new OstraPool();
        vm.expectRevert();
        beacon.upgradeTo(address(next));
        vm.prank(beacon.owner());
        beacon.upgradeTo(address(next));
        assertEq(beacon.implementation(), address(next));
        assertEq(live.VERSION(), 2);
        PoolSnapshot memory afterwards = _snapshot(live);
        assertEq(keccak256(abi.encode(afterwards)), keccak256(abi.encode(before)), "pool state changed by the upgrade");
        for (uint64 i = 0; i < before.batchCount; ++i) assertEq(live.batchState(i), states[i]);
        vm.expectRevert();
        live.initialize(USDG, FEE_BPS, treasury, MAX_DEPOSIT, MAX_TOTAL, authority);
        console.log("live batches before the upgrade", before.batchCount);
        console.log("live pool balance before the upgrade", before.balance);
    }

    /// @notice The live pool upgraded on the fork keeps every setting and batch, then takes version 2 deposits,
    ///         seals them and pays a leaf out.
    function test_liveUpgradeKeepsStateAndRunsVersionTwo() public {
        PoolSnapshot memory before = _upgradeLivePool();
        pool = OstraPool(LIVE_POOL);
        treasury = before.treasury;
        assertEq(before.feeBps, FEE_BPS);
        assertEq(before.leafAmount, LEAF);
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        (Dep[] memory deps, uint64 batchId) = _eightDepositsInABatch();
        assertEq(batchId, before.batchCount);
        for (uint256 i = 0; i < 8; ++i) {
            _approve(deps[i], batchId, 0);
        }
        vm.prank(aggregator);
        pool.sealBatch(batchId, _keys(deps));
        uint256 fees;
        for (uint256 i = 0; i < 8; ++i) {
            fees += (uint256(deps[i].amount) * FEE_BPS) / 10_000;
            assertEq(pool.getDeposit(deps[i].key).status, pool.DEPOSIT_CONSUMED());
        }
        assertEq(usdg.balanceOf(treasury) - treasuryBefore + (pool.feesOwed() - before.feesOwed), fees);
        assertEq(usdg.balanceOf(address(pool)), before.balance + 11 * uint256(LEAF) + (pool.feesOwed() - before.feesOwed));
        _spendLeafFour(batchId);
    }
}
