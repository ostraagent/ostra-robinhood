// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraVaultModule} from "../src/OstraVaultModule.sol";
import {OstraVaultV3} from "../src/OstraVaultV3.sol";
import {VaultStack} from "./utils/VaultStack.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";

/// @notice The version 2 vault code that runs on mainnet before the upgrade, as far as this test reads it.
interface IVaultV2 {
    function VERSION() external view returns (uint8);
    function token() external view returns (address);
    function keyRoot() external view returns (bytes32);
    function nonce() external view returns (uint64);
    function crank() external view returns (address);
    function guardianCount() external view returns (uint8);
    function recoveryThreshold() external view returns (uint8);
    function recoveryDelay() external view returns (uint32);
    function REGISTRY() external view returns (address);
    function spendMessage(uint8 action, bytes32 nextKeyRoot, bytes calldata params) external view returns (bytes memory);
    function spend(uint8 action, bytes32 nextKeyRoot, bytes calldata params, bytes calldata signature) external;
}

/// @notice The upgrade of the live vault beacon from version 2 to version 3 on a fork of Robinhood Chain mainnet, as
///         OstraUpgradeOwner runs it once its 72-hour delay has passed: a vault the live factory made and spent from
///         under version 2 keeps its token, key, nonce, crank, guardians and recovery policy, and spends under
///         version 3, the new spends included; the module names the live factory, and the live registry carries over.
contract VaultUpgradeForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev The live deployment (deployments/robinhood-mainnet.json).
    address internal constant VAULT_BEACON = 0xE9F525B9EaeE48d13AEd28fE146F48f2832a18a0;
    address internal constant VAULT_FACTORY = 0x043a15c514CFE2c797d33520bFF91a5DCdbf2979;
    address internal constant VAULT_V2 = 0xD20c6744Cfa46d9ec564b119cC923bAb2f9f9331;
    address internal constant REGISTRY = 0xcE6Cc1f93744f4090DA1444Bb8590d9206157506;
    address internal constant UPGRADE_OWNER = 0x55533a51d9bd9b06F2D179d919BB31995EF96E5e;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant KEYCHAIN = keccak256("OSTRA/EVM/TEST/upgrade-vault-v3");
    bytes32 internal constant LINKED = keccak256("OSTRA/EVM/TEST/upgrade-vault-v3-linked");

    function _seed(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keychain, index);
    }

    function _spend(IVaultV2 vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        uint64 n = vault.nonce();
        bytes32 next = WotsSigner.keyRoot(_seed(keychain, n + 1));
        vault.spend(action, next, params, WotsSigner.sign(_seed(keychain, n), vault.spendMessage(action, next, params)));
    }

    function test_theLiveVaultBeaconUpgradesToVersion3AndKeepsEveryVault() public {
        vm.createSelectFork("robinhood");
        UpgradeableBeacon beacon = UpgradeableBeacon(VAULT_BEACON);
        assertEq(beacon.owner(), UPGRADE_OWNER);
        assertEq(beacon.implementation(), VAULT_V2);
        assertEq(OstraVaultFactory(VAULT_FACTORY).BEACON(), VAULT_BEACON);

        // A vault made by the live factory and spent from under version 2: a transfer and a guardian.
        IVaultV2 vault =
            IVaultV2(OstraVaultFactory(VAULT_FACTORY).createVault(USDG, WotsSigner.keyRoot(_seed(KEYCHAIN, 0)), address(0)));
        assertEq(vault.VERSION(), 2);
        deal(USDG, address(vault), 5_000_000);
        _spend(vault, KEYCHAIN, 0, abi.encode(address(0xBEEF), uint256(1_000_000)));
        _spend(vault, KEYCHAIN, 6, abi.encode(address(0x6A2D), true));
        (address token, bytes32 root, uint64 nonce, address crank) = (vault.token(), vault.keyRoot(), vault.nonce(), vault.crank());
        assertEq(nonce, 2);
        assertEq(vault.guardianCount(), 1);

        // The upgrade, as the scheduled call executes it: the module names the live factory, the live registry stays.
        OstraVaultModule module = VaultStack.module(VAULT_FACTORY);
        OstraVault v3 = VaultStack.implementation(vault.REGISTRY(), address(module));
        assertEq(vault.REGISTRY(), REGISTRY);
        vm.prank(UPGRADE_OWNER);
        beacon.upgradeTo(address(v3));
        assertEq(beacon.implementation(), address(v3));

        OstraVault upgraded = OstraVault(address(vault));
        assertEq(upgraded.VERSION(), 3);
        assertEq(address(upgraded.token()), token);
        assertEq(upgraded.keyRoot(), root);
        assertEq(upgraded.nonce(), nonce);
        assertEq(upgraded.crank(), crank);
        assertEq(upgraded.guardianCount(), 1);
        assertTrue(upgraded.isGuardian(address(0x6A2D)));
        assertEq(address(upgraded.REGISTRY()), REGISTRY);
        assertEq(upgraded.MODULE(), address(module));
        assertEq(address(module.FACTORY()), VAULT_FACTORY);
        // Version 3's state starts empty: no lock, no link, nothing approved.
        assertFalse(upgraded.lockActive());
        assertEq(upgraded.linkedVault(), address(0));
        assertEq(upgraded.outflowAvailable(), type(uint256).max);

        // The same key chain spends on: an old action, then new ones (a link to another live vault, a lock).
        uint256 before = IERC20(USDG).balanceOf(address(0xBEEF));
        _spend(vault, KEYCHAIN, 0, abi.encode(address(0xBEEF), uint256(1_000_000)));
        assertEq(IERC20(USDG).balanceOf(address(0xBEEF)), before + 1_000_000);
        address linked = OstraVaultFactory(VAULT_FACTORY).createVault(USDG, WotsSigner.keyRoot(_seed(LINKED, 0)), address(0));
        _spend(vault, KEYCHAIN, 16, abi.encode(linked));
        assertEq(upgraded.linkedVault(), linked);
        _spend(vault, KEYCHAIN, 14, abi.encode(address(0xC01D), uint32(36 hours), uint128(1_000_000)));
        assertTrue(upgraded.lockActive());
        assertEq(upgraded.nonce(), 5);

        // A vault the live factory makes after the upgrade sits where it always would have.
        address fresh = OstraVaultFactory(VAULT_FACTORY).createVault(USDG, bytes32(uint256(1)), address(0));
        assertEq(fresh, OstraVaultFactory(VAULT_FACTORY).vaultAddress(USDG, bytes32(uint256(1)), address(0)));
        assertEq(OstraVault(fresh).VERSION(), 3);
        OstraVaultV3.LockConfig memory l = OstraVault(fresh).withdrawalLock();
        assertEq(l.withdrawal, address(0));
    }
}
