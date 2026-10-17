// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Wots
/// @notice Winternitz one-time signatures, byte-compatible with the Ostra Solana program
///         (program/src/wots.rs) and the Ostra TypeScript SDK (sdk/src/wots.ts).
/// @dev Parameters: w = 16, Keccak-256 truncated to N = 28 bytes, 64 message chains (one per
///      4-bit digit of the 32-byte digest) and 3 checksum chains, 15 hash steps per chain.
///      Every chain step is keccak256(salt || chain || pos || x)[0:28], so a preimage search
///      cannot be shared across keys, chains or positions.
///
///      Signature layout: salt (16) || chain_0 (28) || ... || chain_66 (28) = 1,892 bytes.
///      A key is known only by its key root:
///      keccak256("OSTRA/WOTS/PK/v1" || salt || end_0 || ... || end_66).
///      The message digest is keccak256("OSTRA/WOTS/MSG/v1" || salt || message).
///
///      A key must sign only one message: two signatures from one key let anyone forge a third.
///      The caller rotates the key root after every accepted signature.
library Wots {
    uint256 internal constant N = 28;
    uint256 internal constant SALT_LEN = 16;
    uint256 internal constant MSG_CHAINS = 64;
    uint256 internal constant CHAINS = 67;
    uint256 internal constant CHAIN_END = 15;
    uint256 internal constant SIGNATURE_LEN = 1892;
    /// @dev Worst case over all messages (program/src/wots.rs max_verifier_steps).
    uint256 internal constant MAX_VERIFIER_STEPS = 990;

    error BadSignatureLength();

    /// @notice The key root that `signature` commits to over `message`. The signature is valid
    ///         for a key exactly when the result equals that key's root.
    function recoverKeyRoot(bytes calldata signature, bytes memory message) internal pure returns (bytes32 root) {
        if (signature.length != SIGNATURE_LEN) revert BadSignatureLength();
        bytes32 digest = keccak256(abi.encodePacked("OSTRA/WOTS/MSG/v1", signature[0:16], message));
        bytes32 pkDomain = bytes32(bytes16("OSTRA/WOTS/PK/v1"));
        assembly ("memory-safe") {
            // Scratch memory above the free memory pointer (not allocated, not used afterwards):
            //   buf: salt (16) || chain (1) || pos (1) || x (28), 46 bytes hashed per step.
            //   pk:  "OSTRA/WOTS/PK/v1" (16) || salt (16) || 67 chain ends (28 each), 1,908 bytes.
            // Each 32-byte mstore of a 28-byte value spills 4 bytes into the next field, which the
            // next write overwrites; the spill after the last chain end lies outside the hashed range.
            let buf := mload(0x40)
            let pk := add(buf, 0x40)
            calldatacopy(buf, signature.offset, 16)
            mstore(pk, pkDomain)
            calldatacopy(add(pk, 16), signature.offset, 16)
            let ends := add(pk, 32)

            // Checksum: sum over the 64 digest digits of (15 - digit).
            let checksum := 0
            for { let j := 0 } lt(j, 32) { j := add(j, 1) } {
                let b := byte(j, digest)
                checksum := add(checksum, sub(30, add(shr(4, b), and(b, 15))))
            }

            let chains := add(signature.offset, 16)
            for { let i := 0 } lt(i, 67) { i := add(i, 1) } {
                let digit
                switch lt(i, 64)
                case 1 {
                    // Even chain: high nibble of digest byte i / 2; odd chain: low nibble.
                    digit := and(shr(mul(4, iszero(and(i, 1))), byte(shr(1, i), digest)), 15)
                }
                default {
                    // Checksum digits, big-endian base 16: chain 64 = bits 8..11, 65 = 4..7, 66 = 0..3.
                    digit := and(shr(mul(4, sub(66, i)), checksum), 15)
                }
                mstore8(add(buf, 16), i)
                calldatacopy(add(buf, 18), add(chains, mul(i, 28)), 28)
                for { let pos := digit } lt(pos, 15) { pos := add(pos, 1) } {
                    mstore8(add(buf, 17), pos)
                    mstore(add(buf, 18), keccak256(buf, 46))
                }
                mstore(add(ends, mul(i, 28)), mload(add(buf, 18)))
            }
            root := keccak256(pk, 1908)
        }
    }
}
