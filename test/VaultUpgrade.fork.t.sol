// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraRegistry} from "../src/OstraRegistry.sol";
import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";

/// @notice The version 1 vault code that runs on mainnet before the upgrade, as far as this test reads it.
interface IVaultV1 {
    function token() external view returns (address);
    function keyRoot() external view returns (bytes32);
    function nonce() external view returns (uint64);
    function crank() external view returns (address);
    function spendMessage(uint8 action, bytes32 nextKeyRoot, bytes calldata params) external view returns (bytes memory);
    function spend(uint8 action, bytes32 nextKeyRoot, bytes calldata params, bytes calldata signature) external;
}

/// @notice The upgrade of the live vault beacon to version 2 on a fork of Robinhood Chain mainnet, as
///         OstraUpgradeOwner runs it once its 72-hour delay has passed: a vault the live factory made and spent
///         from under version 1 keeps its token, key, nonce and crank, and spends under version 2, the new
///         spends included.
contract VaultUpgradeForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant BATCH = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    /// @dev The live deployment (deployments/robinhood-mainnet.json).
    address internal constant VAULT_BEACON = 0xE9F525B9EaeE48d13AEd28fE146F48f2832a18a0;
    address internal constant VAULT_FACTORY = 0x043a15c514CFE2c797d33520bFF91a5DCdbf2979;
    address internal constant VAULT_V1 = 0xa455cbf5Aa10cE858f3b250dc791FCD900e950BC;
    address internal constant UPGRADE_OWNER = 0x55533a51d9bd9b06F2D179d919BB31995EF96E5e;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant KEYCHAIN = keccak256("OSTRA/EVM/TEST/upgrade-vault");

    function _seed(uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, KEYCHAIN, index);
    }

    function _spend(IVaultV1 vault, uint8 action, bytes memory params) internal {
        uint64 n = vault.nonce();
        bytes32 next = WotsSigner.keyRoot(_seed(n + 1));
        vault.spend(action, next, params, WotsSigner.sign(_seed(n), vault.spendMessage(action, next, params)));
    }

    function test_theLiveVaultBeaconUpgradesToVersion2AndKeepsEveryVault() public {
        vm.createSelectFork("robinhood");
        UpgradeableBeacon beacon = UpgradeableBeacon(VAULT_BEACON);
        assertEq(beacon.owner(), UPGRADE_OWNER);
        assertEq(beacon.implementation(), VAULT_V1);

        // A vault made by the live factory and spent from under version 1.
        IVaultV1 vault = IVaultV1(OstraVaultFactory(VAULT_FACTORY).createVault(USDG, WotsSigner.keyRoot(_seed(0)), address(0)));
        deal(USDG, address(vault), 5_000_000);
        _spend(vault, 0, abi.encode(address(0xBEEF), uint256(1_000_000)));
        (address token, bytes32 root, uint64 nonce, address crank) = (vault.token(), vault.keyRoot(), vault.nonce(), vault.crank());
        assertEq(nonce, 1);

        // The upgrade, as the scheduled call executes it.
        OstraRegistry registry = new OstraRegistry();
        OstraVault v2 = new OstraVault(BATCH, POOL_MANAGER, address(registry), IDENTITY_REGISTRY);
        vm.prank(UPGRADE_OWNER);
        beacon.upgradeTo(address(v2));
        assertEq(beacon.implementation(), address(v2));

        OstraVault upgraded = OstraVault(address(vault));
        assertEq(upgraded.VERSION(), 2);
        assertEq(address(upgraded.token()), token);
        assertEq(upgraded.keyRoot(), root);
        assertEq(upgraded.nonce(), nonce);
        assertEq(upgraded.crank(), crank);
        assertEq(address(upgraded.REGISTRY()), address(registry));

        // The same key chain spends on: an old action, then a new one.
        uint256 before = IERC20(USDG).balanceOf(address(0xBEEF));
        _spend(vault, 0, abi.encode(address(0xBEEF), uint256(1_000_000)));
        assertEq(IERC20(USDG).balanceOf(address(0xBEEF)), before + 1_000_000);
        _spend(vault, upgraded.ACTION_SET_PROFILE(), abi.encode("ipfs://after-the-upgrade"));
        assertEq(registry.profileOf(address(vault)), "ipfs://after-the-upgrade");
        assertEq(upgraded.nonce(), 3);
    }
}
