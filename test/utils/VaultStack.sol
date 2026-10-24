// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraVault} from "../../src/OstraVault.sol";
import {OstraVaultFactory} from "../../src/OstraVaultFactory.sol";
import {OstraVaultModule} from "../../src/OstraVaultModule.sol";

/// @notice A fresh vault stack on a fork of Robinhood Chain mainnet, for tests: OstraVaultModule (naming the
///         factory about to be made, and the live Morpho and Borro contracts), the OstraVault implementation, its
///         beacon (owned by the caller) and OstraVaultFactory, all created by the calling test contract.
library VaultStack {
    address internal constant BATCH = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant VAULT_V2_FACTORY = 0x0FBad98595b0186dA120E41f77C102beb49f803c;
    address internal constant BORRO_BUILDERS = 0x082Ae609bdC7ccEec0C58B2361a21c49dc2aE291;
    address internal constant BORRO_ROUTER = 0x85ccddcb0588A434BD57F86A59381E40154650Ca;
    bytes32 internal constant BORRO_CODE = bytes32("ostraagent");

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function module(address factory) internal returns (OstraVaultModule) {
        return new OstraVaultModule(factory, MORPHO, VAULT_V2_FACTORY, BORRO_BUILDERS, BORRO_ROUTER, BORRO_CODE);
    }

    function implementation(address registry, address module_) internal returns (OstraVault) {
        return new OstraVault(
            OstraVault.Externals({
                batchSettlement: BATCH,
                poolManager: POOL_MANAGER,
                registry: registry,
                identityRegistry: IDENTITY_REGISTRY,
                module: module_
            })
        );
    }

    /// @dev Address the module is created from, so that the caller makes the same three creations as before version
    ///      3 (implementation, beacon, factory) and every later address in its test stays where it was.
    address internal constant MODULE_DEPLOYER = address(uint160(uint256(keccak256("OSTRA/EVM/TEST/module-deployer"))));

    function deploy(address registry) internal returns (OstraVaultFactory factory, OstraVaultModule m) {
        address predicted = VM.computeCreateAddress(address(this), VM.getNonce(address(this)) + 2);
        VM.prank(MODULE_DEPLOYER);
        m = module(predicted);
        OstraVault impl = implementation(registry, address(m));
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(impl), address(this));
        factory = new OstraVaultFactory(address(beacon));
        require(address(factory) == predicted, "factory address");
    }
}
