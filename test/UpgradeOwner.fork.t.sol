// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraPool} from "../src/OstraPool.sol";
import {OstraUpgradeOwner} from "../src/OstraUpgradeOwner.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";

/// @notice OstraUpgradeOwner taking over the live beacons on a fork of Robinhood Chain mainnet.
contract UpgradeOwnerForkTest is Test {
    /// @dev deployments/robinhood-mainnet.json
    address internal constant VAULT_BEACON = 0xE9F525B9EaeE48d13AEd28fE146F48f2832a18a0;
    address internal constant POOL_BEACON = 0x30669Ca534921038a531BBE27116d85bB7406fFF;
    address internal constant POOL = 0x6ea80F2462e5Fd783B0Ec3B2c7BaC96795980CD6;
    /// @dev The account the test hands the live beacons to, standing in for their ECDSA owner.
    address internal constant ECDSA_OWNER = 0x6569E27A95a6A3E92A311B4Cc6600fed56aA50A2;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/owner-master");
    bytes32 internal constant KEYCHAIN = keccak256("OSTRA/EVM/TEST/owner-keys");
    uint256 internal constant DELAY = 72 hours;

    OstraUpgradeOwner internal owner;
    UpgradeableBeacon internal vaultBeacon = UpgradeableBeacon(VAULT_BEACON);
    UpgradeableBeacon internal poolBeacon = UpgradeableBeacon(POOL_BEACON);

    function setUp() public {
        vm.createSelectFork("robinhood");
        owner = new OstraUpgradeOwner(_root(0), DELAY);
        // Whoever owns the live beacons now hands them to the ECDSA owner on the fork (a no-op while it owns them).
        vm.prank(vaultBeacon.owner());
        vaultBeacon.transferOwnership(ECDSA_OWNER);
        vm.prank(poolBeacon.owner());
        poolBeacon.transferOwnership(ECDSA_OWNER);
        vm.startPrank(ECDSA_OWNER);
        vaultBeacon.transferOwnership(address(owner));
        poolBeacon.transferOwnership(address(owner));
        vm.stopPrank();
        assertEq(vaultBeacon.owner(), address(owner));
        assertEq(poolBeacon.owner(), address(owner));
    }

    function _seed(uint64 i) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, KEYCHAIN, i);
    }

    function _root(uint64 i) internal pure returns (bytes32) {
        return WotsSigner.keyRoot(_seed(i));
    }

    /// @dev Schedules `target.call(data)` with key `i`, rotating to key `i + 1`.
    function _schedule(uint64 i, address target, bytes memory data) internal returns (uint64 id) {
        bytes memory m = owner.message(owner.SCHEDULE(), owner.schedulePayload(target, data), _root(i + 1));
        id = owner.schedule(target, data, _root(i + 1), WotsSigner.sign(_seed(i), m));
    }

    function test_constructorRules() public {
        vm.expectRevert(OstraUpgradeOwner.InvalidKeyRoot.selector);
        new OstraUpgradeOwner(bytes32(0), DELAY);
        vm.expectRevert(OstraUpgradeOwner.InvalidDelay.selector);
        new OstraUpgradeOwner(_root(0), 1 days - 1);
        vm.expectRevert(OstraUpgradeOwner.InvalidDelay.selector);
        new OstraUpgradeOwner(_root(0), 30 days + 1);
        assertEq(owner.DELAY(), DELAY);
        assertEq(owner.keyRoot(), _root(0));
        assertEq(owner.nonce(), 0);
    }

    /// @notice The ECDSA key that owned the beacons can no longer upgrade anything; an upgrade needs the WOTS key
    ///         and waits DELAY, in public, before anyone can execute it.
    function test_anUpgradeNeedsTheWotsKeyAndWaitsTheDelay() public {
        OstraPool next = new OstraPool();
        vm.prank(ECDSA_OWNER);
        vm.expectRevert();
        poolBeacon.upgradeTo(address(next));

        bytes memory data = abi.encodeCall(UpgradeableBeacon.upgradeTo, (address(next)));
        bytes memory m = owner.message(owner.SCHEDULE(), owner.schedulePayload(POOL_BEACON, data), _root(1));
        // A signature by another key, or one that names another next key, is refused.
        vm.expectRevert(OstraUpgradeOwner.WotsSignatureInvalid.selector);
        owner.schedule(POOL_BEACON, data, _root(1), WotsSigner.sign(_seed(1), m));
        bytes memory signature = WotsSigner.sign(_seed(0), m);
        vm.expectRevert(OstraUpgradeOwner.WotsSignatureInvalid.selector);
        owner.schedule(POOL_BEACON, data, _root(2), signature);
        vm.expectRevert(OstraUpgradeOwner.InvalidKeyRoot.selector);
        owner.schedule(POOL_BEACON, data, bytes32(0), signature);
        vm.expectRevert(OstraUpgradeOwner.NotAContract.selector);
        owner.schedule(makeAddr("no code"), data, _root(1), signature);

        uint64 id = owner.schedule(POOL_BEACON, data, _root(1), signature);
        assertEq(id, 0);
        assertEq(owner.nonce(), 1);
        assertEq(owner.keyRoot(), _root(1));
        OstraUpgradeOwner.ScheduledCall memory c = owner.getCall(id);
        assertEq(c.target, POOL_BEACON);
        assertEq(c.eta, block.timestamp + DELAY);
        // The same signature never works twice: the key rotated.
        vm.expectRevert(OstraUpgradeOwner.WotsSignatureInvalid.selector);
        owner.schedule(POOL_BEACON, data, _root(1), signature);

        vm.expectRevert(OstraUpgradeOwner.TooEarly.selector);
        owner.execute(id, data);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(OstraUpgradeOwner.WrongCalldata.selector);
        owner.execute(id, abi.encodeCall(UpgradeableBeacon.upgradeTo, (makeAddr("other"))));
        vm.prank(makeAddr("anyone"));
        owner.execute(id, data);
        assertEq(poolBeacon.implementation(), address(next));
        assertEq(OstraPool(POOL).VERSION(), 2);
        vm.expectRevert(OstraUpgradeOwner.UnknownCall.selector);
        owner.execute(id, data);
    }

    function test_aScheduledCallCanBeCancelledAndExpires() public {
        address current = vaultBeacon.implementation();
        bytes memory data = abi.encodeCall(UpgradeableBeacon.upgradeTo, (address(new OstraPool())));
        uint64 id = _schedule(0, VAULT_BEACON, data);

        bytes memory m = owner.message(owner.CANCEL(), bytes32(uint256(id)), _root(2));
        owner.cancel(id, _root(2), WotsSigner.sign(_seed(1), m));
        assertEq(owner.getCall(id).eta, 0);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(OstraUpgradeOwner.UnknownCall.selector);
        owner.execute(id, data);
        assertEq(vaultBeacon.implementation(), current);

        uint64 again = _schedule(2, VAULT_BEACON, data);
        assertEq(again, 2);
        vm.warp(block.timestamp + DELAY + owner.GRACE() + 1);
        vm.expectRevert(OstraUpgradeOwner.Expired.selector);
        owner.execute(again, data);
        assertEq(vaultBeacon.implementation(), current);
    }

    /// @notice Phase 4: the upgrade right is released for good by a scheduled renounceOwnership.
    function test_theUpgradeRightCanBeReleasedForGood() public {
        bytes memory data = abi.encodeWithSignature("renounceOwnership()");
        uint64 id = _schedule(0, VAULT_BEACON, data);
        vm.warp(block.timestamp + DELAY);
        owner.execute(id, data);
        assertEq(vaultBeacon.owner(), address(0));
        assertEq(poolBeacon.owner(), address(owner));
    }

    /// @notice A call that fails leaves the call scheduled (the revert undoes the deletion).
    function test_aFailedCallStaysScheduled() public {
        bytes memory data = abi.encodeCall(UpgradeableBeacon.upgradeTo, (makeAddr("not a contract")));
        uint64 id = _schedule(0, POOL_BEACON, data);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        owner.execute(id, data);
        assertEq(owner.getCall(id).target, POOL_BEACON);
    }

    /// @notice A cancel that lost the race to execute (or names a call that does not exist) still lands: it
    ///         rotates the key, so its now public signature can never be needed again.
    function test_aCancelThatLostTheRaceStillRotatesTheKey() public {
        bytes memory data = abi.encodeCall(UpgradeableBeacon.upgradeTo, (vaultBeacon.implementation()));
        uint64 id = _schedule(0, VAULT_BEACON, data);
        bytes memory late = WotsSigner.sign(_seed(1), owner.message(owner.CANCEL(), bytes32(uint256(id)), _root(2)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(makeAddr("anyone"));
        owner.execute(id, data);
        vm.expectEmit(address(owner));
        emit OstraUpgradeOwner.CallCancelled(id, false);
        owner.cancel(id, _root(2), late);
        assertEq(owner.nonce(), 2);
        assertEq(owner.keyRoot(), _root(2));
        bytes memory never = WotsSigner.sign(_seed(2), owner.message(owner.CANCEL(), bytes32(uint256(99)), _root(3)));
        owner.cancel(99, _root(3), never);
        assertEq(owner.nonce(), 3);
        vm.expectRevert(OstraUpgradeOwner.WotsSignatureInvalid.selector);
        owner.cancel(99, _root(3), never);
    }
}
