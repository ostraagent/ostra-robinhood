// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraVaultModule} from "../src/OstraVaultModule.sol";
import {OstraVaultModuleV4} from "../src/OstraVaultModuleV4.sol";
import {OstraVaultV3} from "../src/OstraVaultV3.sol";
import {VaultStack} from "./utils/VaultStack.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";

/// @notice The upgrade of the live vault beacon from version 3 to version 4 on a fork of Robinhood Chain mainnet, as
///         OstraUpgradeOwner runs it once its 72-hour delay has passed: the version 4 implementation runs version 3's
///         spends in a new OstraVaultModule (the live one's code, with the landing rule that also refuses a sender with
///         code) and adds OstraVaultModuleV4. A vault the live factory
///         made and locked and linked under version 3 keeps its token, key, nonce, guardians, lock, link and approvals,
///         and spends under version 4, the venue spends included.
contract VaultUpgradeForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev The live deployment (deployments/robinhood-mainnet.json).
    address internal constant VAULT_BEACON = 0xE9F525B9EaeE48d13AEd28fE146F48f2832a18a0;
    address internal constant VAULT_FACTORY = 0x043a15c514CFE2c797d33520bFF91a5DCdbf2979;
    address internal constant VAULT_V3 = 0xec0ca4A1393D91c42cA809F7F9dd82Bd597E8E58;
    address internal constant VAULT_MODULE = 0x55A89fF907f5F5756470e2ec5Dc5E4E1C54Da770;
    address internal constant REGISTRY = 0xcE6Cc1f93744f4090DA1444Bb8590d9206157506;
    address internal constant UPGRADE_OWNER = 0x55533a51d9bd9b06F2D179d919BB31995EF96E5e;
    /// @dev Spark Savings USDG (an ERC-1967 proxy).
    address internal constant SPARK = 0xde770c84FE66E063336b31737cFE9790f18c4087;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant KEYCHAIN = keccak256("OSTRA/EVM/TEST/upgrade-vault-v4");
    bytes32 internal constant LINKED = keccak256("OSTRA/EVM/TEST/upgrade-vault-v4-linked");
    address internal constant SUBMITTER = address(0x5EB);

    function _seed(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keychain, index);
    }

    function _spend(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        uint64 n = vault.nonce();
        bytes32 next = WotsSigner.keyRoot(_seed(keychain, n + 1));
        bytes memory signature = WotsSigner.sign(_seed(keychain, n), vault.spendMessage(action, next, params));
        vm.prank(SUBMITTER, SUBMITTER);
        vault.spend(action, next, params, signature);
    }

    function test_theLiveVaultBeaconUpgradesToVersion4AndKeepsEveryVault() public {
        vm.createSelectFork("robinhood");
        UpgradeableBeacon beacon = UpgradeableBeacon(VAULT_BEACON);
        assertEq(beacon.owner(), UPGRADE_OWNER);
        assertEq(beacon.implementation(), VAULT_V3);
        assertEq(OstraVaultFactory(VAULT_FACTORY).BEACON(), VAULT_BEACON);
        assertEq(OstraVault(VAULT_V3).MODULE(), VAULT_MODULE);
        assertEq(address(OstraVaultModule(VAULT_MODULE).FACTORY()), VAULT_FACTORY);

        // A vault made by the live factory and set up under version 3: a guardian, a link, a lock and an approval.
        OstraVault vault =
            OstraVault(OstraVaultFactory(VAULT_FACTORY).createVault(USDG, WotsSigner.keyRoot(_seed(KEYCHAIN, 0)), address(0)));
        assertEq(vault.VERSION(), 3);
        deal(USDG, address(vault), 5_000_000);
        address linked =
            OstraVaultFactory(VAULT_FACTORY).createVault(USDG, WotsSigner.keyRoot(_seed(LINKED, 0)), address(0));
        _spend(vault, KEYCHAIN, 6, abi.encode(address(0x6A2D), true));
        _spend(vault, KEYCHAIN, 16, abi.encode(linked));
        _spend(vault, KEYCHAIN, 14, abi.encode(address(0xC01D), uint32(36 hours), uint128(1_000_000)));
        // Under the lock an approval waits the lock's delay (one given before the lock would no longer count).
        _spend(vault, KEYCHAIN, 23, abi.encode(keccak256("approved"), true));
        _spend(vault, KEYCHAIN, 0, abi.encode(address(0xBEEF), uint256(400_000)));
        (bytes32 root, uint64 nonce) = (vault.keyRoot(), vault.nonce());
        uint256 available = vault.outflowAvailable();
        assertEq(available, 600_000);

        // The upgrade, as the scheduled call executes it: both modules bound to the live factory.
        OstraVaultModule m3 = VaultStack.module(VAULT_FACTORY);
        OstraVaultModuleV4 m4 = VaultStack.moduleV4(VAULT_FACTORY);
        OstraVault v4 = VaultStack.implementation(REGISTRY, address(m3), address(m4));
        vm.prank(UPGRADE_OWNER);
        beacon.upgradeTo(address(v4));
        assertEq(beacon.implementation(), address(v4));

        assertEq(vault.VERSION(), 4);
        assertEq(vault.MODULE(), address(m3));
        assertEq(address(m3.FACTORY()), VAULT_FACTORY);
        assertEq(vault.MODULE_V4(), address(m4));
        assertEq(address(m4.FACTORY()), VAULT_FACTORY);
        assertEq(address(vault.token()), USDG);
        assertEq(vault.keyRoot(), root);
        assertEq(vault.nonce(), nonce);
        assertTrue(vault.isGuardian(address(0x6A2D)));
        assertTrue(vault.lockActive());
        assertEq(vault.linkedVault(), linked);
        assertEq(vault.outflowAvailable(), available);
        assertGt(vault.hashValidFrom(keccak256("approved")), 0);
        assertEq(address(vault.REGISTRY()), REGISTRY);

        // Version 3 spends run as before; version 4's start empty and work: Spark enabled under the lock waits.
        _spend(vault, KEYCHAIN, 0, abi.encode(address(0xC01D), uint256(1_000_000)));
        assertEq(IERC20(USDG).balanceOf(address(0xC01D)), 1_000_000);
        (bool enabled,, bool inForce, uint64 from) = vault.venueOf(3, SPARK);
        assertFalse(enabled);
        assertFalse(inForce);
        _spend(vault, KEYCHAIN, 25, abi.encode(uint8(3), SPARK, true));
        (enabled,, inForce, from) = vault.venueOf(3, SPARK);
        assertTrue(enabled);
        assertFalse(inForce);
        assertEq(from, block.timestamp + 36 hours);
        vm.warp(block.timestamp + 36 hours);
        (,, inForce,) = vault.venueOf(3, SPARK);
        assertTrue(inForce);

        // A vault the live factory makes after the upgrade sits where it always would have.
        address fresh = OstraVaultFactory(VAULT_FACTORY).createVault(USDG, bytes32(uint256(1)), address(0));
        assertEq(fresh, OstraVaultFactory(VAULT_FACTORY).vaultAddress(USDG, bytes32(uint256(1)), address(0)));
        assertEq(OstraVault(fresh).VERSION(), 4);
        OstraVaultV3.LockConfig memory l = OstraVault(fresh).withdrawalLock();
        assertEq(l.withdrawal, address(0));
    }
}
