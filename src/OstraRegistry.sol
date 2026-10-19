// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {OstraHook} from "./launchpad/OstraHook.sol";

/// @notice What OstraRegistry reads from a launched token: the hook it was launched with (OstraToken.HOOK).
interface IOstraLaunchedToken {
    function HOOK() external view returns (address);
}

/// @title OstraRegistry
/// @notice Where an agent's profile and a launched token's metadata live, as URIs (an ipfs:// JSON file: name,
///         description, image, links). No owner, no admin, no proxy: nothing but the writers below can change an
///         entry, and nothing can change these rules.
///
/// * setProfile: any account sets its own profile. An Ostra agent sets it from its vault, with a WOTS-signed
///   spend (OstraVault action SetProfile), so the profile of a vault is as post-quantum as the vault itself.
/// * setTokenMetadata: only the creator vault of the token's pool, as the token's own hook records it
///   (OstraHook.poolConfig(poolId).creatorVault, with poolConfig(poolId).token the token). The hook is the one
///   the token names (OstraToken.HOOK, immutable), so for a token the Ostra launchpad launched only its creator
///   vault can ever write; a contract posing as a token can only write under its own address, which no list of
///   Ostra launches (OstraLaunchpad's Launched events) contains.
contract OstraRegistry {
    /// @notice Longest URI an entry may hold (an ipfs:// CID is about 60 bytes).
    uint256 public constant MAX_URI_LENGTH = 256;

    /// @notice An account's profile URI ("" when none).
    mapping(address account => string) public profileOf;
    /// @notice A token's metadata URI ("" when none).
    mapping(address token => string) public tokenMetadataOf;

    event ProfileSet(address indexed account, string uri);
    event TokenMetadataSet(address indexed token, bytes32 indexed poolId, address indexed creatorVault, string uri);

    error BadUri();
    error NotCreatorVault();

    function setProfile(string calldata uri) external {
        _checkUri(uri);
        profileOf[msg.sender] = uri;
        emit ProfileSet(msg.sender, uri);
    }

    function setTokenMetadata(address token, bytes32 poolId, string calldata uri) external {
        _checkUri(uri);
        OstraHook.PoolConfig memory c = OstraHook(IOstraLaunchedToken(token).HOOK()).poolConfig(PoolId.wrap(poolId));
        if (c.token != token || c.creatorVault != msg.sender) revert NotCreatorVault();
        tokenMetadataOf[token] = uri;
        emit TokenMetadataSet(token, poolId, msg.sender, uri);
    }

    function _checkUri(string calldata uri) private pure {
        if (bytes(uri).length == 0 || bytes(uri).length > MAX_URI_LENGTH) revert BadUri();
    }
}
