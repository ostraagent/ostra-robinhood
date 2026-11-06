// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraVault} from "../../src/OstraVault.sol";
import {OstraVaultFactory} from "../../src/OstraVaultFactory.sol";
import {OstraVaultModule} from "../../src/OstraVaultModule.sol";
import {OstraVaultModuleV4} from "../../src/OstraVaultModuleV4.sol";
import {OstraVaultModuleV5} from "../../src/OstraVaultModuleV5.sol";

/// @notice A fresh vault stack on a fork of Robinhood Chain mainnet, for tests: OstraVaultModule, OstraVaultModuleV4 and
///         OstraVaultModuleV5 (naming the factory about to be made, and the live Morpho, Borro, ERC-8004, Priors and
///         OstraPad contracts), the OstraVault
///         implementation, its beacon (owned by the caller) and OstraVaultFactory, all created by the calling test
///         contract.
library VaultStack {
    address internal constant BATCH = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant VAULT_V2_FACTORY = 0x0FBad98595b0186dA120E41f77C102beb49f803c;
    address internal constant BORRO_BUILDERS = 0x082Ae609bdC7ccEec0C58B2361a21c49dc2aE291;
    address internal constant BORRO_ROUTER = 0x85ccddcb0588A434BD57F86A59381E40154650Ca;
    bytes32 internal constant BORRO_CODE = bytes32("ostraagent");
    address internal constant PRIORS_POOL = 0x281210097f0de7A8FB6F87310AF0f089c9C8DE21;
    /// @dev The live pool's runtime code hash (read on chain on 6 Nov 2026).
    bytes32 internal constant PRIORS_POOL_CODEHASH = 0x0a051b47f363ad2d65820cce3c1a543a60db53df4c9c728477ff101f57f6b95f;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant OSTRA_PAD = 0x1BE28c4F08a548598fE0AA9b16DFD564C82E8055;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function module(address factory) internal returns (OstraVaultModule) {
        return new OstraVaultModule(factory, MORPHO, VAULT_V2_FACTORY, BORRO_BUILDERS, BORRO_ROUTER, BORRO_CODE);
    }

    function moduleV4(address factory) internal returns (OstraVaultModuleV4) {
        return new OstraVaultModuleV4(factory, VAULT_V2_FACTORY, IDENTITY_REGISTRY);
    }

    function moduleV5(address factory, address moduleV4_) internal returns (OstraVaultModuleV5) {
        return new OstraVaultModuleV5(
            factory, moduleV4_, PRIORS_POOL, PRIORS_POOL_CODEHASH, USDG, IDENTITY_REGISTRY, OSTRA_PAD
        );
    }

    function implementation(address registry, address module_, address moduleV4_, address moduleV5_)
        internal
        returns (OstraVault)
    {
        return new OstraVault(
            OstraVault.Externals({
                batchSettlement: BATCH,
                poolManager: POOL_MANAGER,
                registry: registry,
                identityRegistry: IDENTITY_REGISTRY,
                module: module_,
                moduleV4: moduleV4_,
                moduleV5: moduleV5_
            })
        );
    }

    /// @dev Address the modules are created from, so that the caller makes the same three creations as before version
    ///      3 (implementation, beacon, factory) and every later address in its test stays where it was.
    address internal constant MODULE_DEPLOYER = address(uint160(uint256(keccak256("OSTRA/EVM/TEST/module-deployer"))));

    function deploy(address registry) internal returns (OstraVaultFactory factory, OstraVaultModule m) {
        address predicted = VM.computeCreateAddress(address(this), VM.getNonce(address(this)) + 2);
        VM.prank(MODULE_DEPLOYER);
        m = module(predicted);
        VM.prank(MODULE_DEPLOYER);
        OstraVaultModuleV4 m4 = moduleV4(predicted);
        VM.prank(MODULE_DEPLOYER);
        OstraVaultModuleV5 m5 = moduleV5(predicted, address(m4));
        OstraVault impl = implementation(registry, address(m), address(m4), address(m5));
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(impl), address(this));
        factory = new OstraVaultFactory(address(beacon));
        require(address(factory) == predicted, "factory address");
    }
}
