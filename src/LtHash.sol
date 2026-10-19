// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title LtHash
/// @notice Lattice homomorphic multiset hash, byte-compatible with the Ostra Solana program
///         (program/src/lthash.rs) and the Ostra TypeScript SDK (sdk/src/lthash.ts): 1,024
///         little-endian u16 lanes with wrapping addition, each leaf expanded by SHA-256 in
///         counter mode over "OSTRA/LTHASH/v1" (15) || counter (1) || leaf, where a leaf is
///         key_root (32) || amount (u64 little-endian).
/// @dev H(A + B) = H(A) + H(B) lane-wise, so a batch's accumulator grows leaf by leaf as leaves are
///      appended, and its state hash (with the leaf count and total) fixes exactly the leaves it holds.
///
///      In memory an accumulator is uint256[64] in lane form: every 32-byte word holds 16 lanes
///      as big-endian 16-bit fields (each little-endian lane byte-swapped), so a SWAR add or
///      subtract never carries across lanes. toBytes returns the canonical 2,048-byte layout.
library LtHash {
    uint256 internal constant WORDS = 64;
    uint256 internal constant BYTES = 2048;

    uint256 private constant HI = 0x8000800080008000800080008000800080008000800080008000800080008000;
    uint256 private constant HIGH_BYTES = 0xff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00;
    uint256 private constant LOW_BYTES = 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff;

    error Sha256Failed();

    /// @notice acc += expansion(key_root || amount), in place.
    function addLeaf(uint256[64] memory acc, bytes32 keyRoot, uint64 amount) internal view {
        bytes32 domain = bytes32(bytes15("OSTRA/LTHASH/v1"));
        bytes32 amountLe = bytes32(uint256(_reverse64(amount)) << 192);
        uint256 hi = HI;
        uint256 highBytes = HIGH_BYTES;
        uint256 lowBytes = LOW_BYTES;
        bool ok = true;
        assembly ("memory-safe") {
            // Scratch above the free memory pointer: input (56 bytes) at buf, SHA-256 output at buf + 64.
            let buf := mload(0x40)
            mstore(buf, domain)
            mstore(add(buf, 16), keyRoot)
            mstore(add(buf, 48), amountLe)
            let out := add(buf, 64)
            let notHi := not(hi)
            for { let ctr := 0 } lt(ctr, 64) { ctr := add(ctr, 1) } {
                mstore8(add(buf, 15), ctr)
                ok := and(ok, staticcall(gas(), 0x02, buf, 56, out, 32))
                let w := mload(out)
                let b := or(shr(8, and(w, highBytes)), shl(8, and(w, lowBytes)))
                let p := add(acc, mul(ctr, 32))
                let a := mload(p)
                mstore(p, xor(add(and(a, notHi), and(b, notHi)), and(xor(a, b), hi)))
            }
        }
        if (!ok) revert Sha256Failed();
    }

    /// @notice acc += other, lane-wise wrapping, in place.
    function add(uint256[64] memory acc, uint256[64] memory other) internal pure {
        uint256 notHi = ~HI;
        for (uint256 k = 0; k < WORDS; ++k) {
            uint256 a = acc[k];
            uint256 b = other[k];
            unchecked {
                acc[k] = ((a & notHi) + (b & notHi)) ^ ((a ^ b) & HI);
            }
        }
    }

    /// @notice acc -= other, lane-wise wrapping, in place.
    function sub(uint256[64] memory acc, uint256[64] memory other) internal pure {
        uint256 notHi = ~HI;
        for (uint256 k = 0; k < WORDS; ++k) {
            uint256 a = acc[k];
            uint256 b = other[k];
            unchecked {
                acc[k] = ((a | HI) - (b & notHi)) ^ ((a ^ ~b) & HI);
            }
        }
    }

    /// @notice True if every lane is zero.
    function isZero(uint256[64] memory acc) internal pure returns (bool) {
        uint256 x;
        for (uint256 k = 0; k < WORDS; ++k) {
            x |= acc[k];
        }
        return x == 0;
    }

    /// @notice The canonical 2,048-byte encoding (little-endian u16 lanes).
    function toBytes(uint256[64] memory acc) internal pure returns (bytes memory out) {
        out = new bytes(BYTES);
        for (uint256 k = 0; k < WORDS; ++k) {
            uint256 w = _swap16(acc[k]);
            assembly ("memory-safe") {
                mstore(add(add(out, 32), mul(k, 32)), w)
            }
        }
    }

    /// @notice Accumulator from its canonical 2,048-byte encoding.
    function fromBytes(bytes memory data) internal pure returns (uint256[64] memory acc) {
        require(data.length == BYTES, "LtHash: length");
        for (uint256 k = 0; k < WORDS; ++k) {
            uint256 w;
            assembly ("memory-safe") {
                w := mload(add(add(data, 32), mul(k, 32)))
            }
            acc[k] = _swap16(w);
        }
    }

    /// @notice Batch state a depositor approves:
    ///         keccak256(acc (2,048) || leaf_count (u16 LE) || total_amount (u64 LE)).
    function stateHash(uint256[64] memory acc, uint16 leafCount, uint64 totalAmount) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(toBytes(acc), bytes2(_reverse16(leafCount)), bytes8(_reverse64(totalAmount)))
        );
    }

    function _swap16(uint256 w) private pure returns (uint256) {
        return ((w & HIGH_BYTES) >> 8) | ((w & LOW_BYTES) << 8);
    }

    function _reverse16(uint16 v) private pure returns (uint16) {
        return (v >> 8) | (v << 8);
    }

    function _reverse64(uint64 v) private pure returns (uint64) {
        v = ((v & 0xff00ff00ff00ff00) >> 8) | ((v & 0x00ff00ff00ff00ff) << 8);
        v = ((v & 0xffff0000ffff0000) >> 16) | ((v & 0x0000ffff0000ffff) << 16);
        return (v >> 32) | (v << 32);
    }
}
