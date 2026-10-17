// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";

/// @notice The test signer must derive the SDK's keys and produce the SDK's signatures exactly
///         (vectors/generate.ts signs with the same master and keychain).
contract WotsSignerTest is Test {
    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST-VECTORS/master");
    bytes32 internal constant KEYCHAIN = keccak256("OSTRA/EVM/TEST-VECTORS/keychain");

    function test_derivesTheSdkKeysAndSignatures() public view {
        string memory json = vm.readFile("vectors/vectors.json");
        bytes[] memory signatures = vm.parseJsonBytesArray(json, ".wots.signatures");
        bytes[] memory messages = vm.parseJsonBytesArray(json, ".wots.messages");
        bytes32[] memory keyRoots = vm.parseJsonBytes32Array(json, ".wots.keyRoots");
        for (uint64 i = 0; i < 8; ++i) {
            bytes32 seed = WotsSigner.deriveSeed(MASTER, KEYCHAIN, i);
            assertEq(WotsSigner.keyRoot(seed), keyRoots[i]);
            assertEq(keccak256(WotsSigner.sign(seed, messages[i])), keccak256(signatures[i]));
        }
    }
}
