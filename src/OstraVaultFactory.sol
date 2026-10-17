// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

import {OstraVault} from "./OstraVault.sol";

/// @title OstraVaultFactory
/// @notice Creates vaults as beacon proxies at addresses fixed by (token, initial key root, initial crank),
///         like the Solana vault PDA ["vault", mint, initial_key_root, initial_crank_key]: anyone may create
///         a vault, a front-runner can only create the very vault its owner asked for, and creating an
///         existing vault returns it instead of failing.
contract OstraVaultFactory {
    address public immutable BEACON;

    event VaultCreated(address indexed vault, address indexed token, bytes32 initialKeyRoot, address initialCrank);

    constructor(address beacon) {
        BEACON = beacon;
    }

    /// @notice Creates the vault, or returns it if it exists already (its address fixes its parameters).
    function createVault(address token, bytes32 initialKeyRoot, address initialCrank)
        external
        returns (address vault)
    {
        vault = vaultAddress(token, initialKeyRoot, initialCrank);
        if (vault.code.length > 0) return vault;
        vault = address(
            new BeaconProxy{salt: _salt(token, initialKeyRoot, initialCrank)}(
                BEACON, abi.encodeCall(OstraVault.initialize, (token, initialKeyRoot, initialCrank))
            )
        );
        emit VaultCreated(vault, token, initialKeyRoot, initialCrank);
    }

    function vaultAddress(address token, bytes32 initialKeyRoot, address initialCrank)
        public
        view
        returns (address)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(BeaconProxy).creationCode,
                abi.encode(BEACON, abi.encodeCall(OstraVault.initialize, (token, initialKeyRoot, initialCrank)))
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), address(this), _salt(token, initialKeyRoot, initialCrank), initCodeHash
                        )
                    )
                )
            )
        );
    }

    function _salt(address token, bytes32 initialKeyRoot, address initialCrank) private pure returns (bytes32) {
        return keccak256(abi.encode(token, initialKeyRoot, initialCrank));
    }
}
