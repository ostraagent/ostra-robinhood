// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The deployed Safe 1.4.1 proxy factory on Robinhood Chain.
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @notice A real Safe (1.4.1, SafeL2, one owner, threshold 1, the compatibility fallback handler) made with the Safe
///         contracts deployed on Robinhood Chain: what the tests use as a withdrawal address, which must have code
///         (OstraVault version 5).
library SafeWallet {
    address internal constant FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    /// @dev Safe.setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler,
    ///      address paymentToken, uint256 payment, address paymentReceiver).
    bytes4 internal constant SETUP = 0xb63e800d;

    function create(address owner, uint256 salt) internal returns (address safe) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory init = abi.encodeWithSelector(
            SETUP, owners, uint256(1), address(0), bytes(""), FALLBACK_HANDLER, address(0), uint256(0), address(0)
        );
        safe = ISafeProxyFactory(FACTORY).createProxyWithNonce(SAFE_L2, init, salt);
        require(safe.code.length != 0, "no Safe");
    }
}
