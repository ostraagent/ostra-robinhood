// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Test-only WOTS key derivation and signing, written to match the Ostra TypeScript SDK
///         (sdk/src/wots.ts: deriveWotsSeed, WotsKey.fromSeed, signing). WotsSigner.t.sol checks it against
///         the SDK's own key roots and signatures, byte for byte.
library WotsSigner {
    uint256 internal constant CHAINS = 67;

    function deriveSeed(bytes32 master, bytes32 keychainId, uint64 index) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("OSTRA/WOTS/DERIVE/v1", master, keychainId, _u64Le(index)));
    }

    function keyRoot(bytes32 seed) internal pure returns (bytes32) {
        bytes16 salt = _salt(seed);
        bytes memory ends = new bytes(CHAINS * 28);
        for (uint256 i = 0; i < CHAINS; ++i) {
            bytes28 end = _walk(salt, i, 0, 15, _secret(seed, i));
            _put(ends, i, end);
        }
        return keccak256(abi.encodePacked("OSTRA/WOTS/PK/v1", salt, ends));
    }

    function sign(bytes32 seed, bytes memory message) internal pure returns (bytes memory signature) {
        bytes16 salt = _salt(seed);
        uint8[67] memory d = digits(salt, message);
        signature = new bytes(16 + CHAINS * 28);
        for (uint256 k = 0; k < 16; ++k) {
            signature[k] = salt[k];
        }
        for (uint256 i = 0; i < CHAINS; ++i) {
            bytes28 x = _walk(salt, i, 0, d[i], _secret(seed, i));
            for (uint256 k = 0; k < 28; ++k) {
                signature[16 + i * 28 + k] = x[k];
            }
        }
    }

    function digits(bytes16 salt, bytes memory message) internal pure returns (uint8[67] memory out) {
        bytes32 h = keccak256(abi.encodePacked("OSTRA/WOTS/MSG/v1", salt, message));
        uint256 checksum;
        for (uint256 i = 0; i < 32; ++i) {
            uint8 b = uint8(h[i]);
            out[2 * i] = b >> 4;
            out[2 * i + 1] = b & 0x0f;
            checksum += (15 - (b >> 4)) + (15 - (b & 0x0f));
        }
        out[64] = uint8((checksum >> 8) & 0x0f);
        out[65] = uint8((checksum >> 4) & 0x0f);
        out[66] = uint8(checksum & 0x0f);
    }

    function _salt(bytes32 seed) private pure returns (bytes16) {
        return bytes16(keccak256(abi.encodePacked("OSTRA/WOTS/SALT/v1", seed)));
    }

    function _secret(bytes32 seed, uint256 chain) private pure returns (bytes28) {
        return bytes28(keccak256(abi.encodePacked("OSTRA/WOTS/SK/v1", seed, uint8(chain))));
    }

    function _walk(bytes16 salt, uint256 chain, uint256 from, uint256 to, bytes28 start)
        private
        pure
        returns (bytes28 x)
    {
        x = start;
        for (uint256 pos = from; pos < to; ++pos) {
            x = bytes28(keccak256(abi.encodePacked(salt, uint8(chain), uint8(pos), x)));
        }
    }

    function _put(bytes memory buf, uint256 i, bytes28 value) private pure {
        for (uint256 k = 0; k < 28; ++k) {
            buf[i * 28 + k] = value[k];
        }
    }

    function _u64Le(uint64 v) private pure returns (bytes8) {
        v = ((v & 0xff00ff00ff00ff00) >> 8) | ((v & 0x00ff00ff00ff00ff) << 8);
        v = ((v & 0xffff0000ffff0000) >> 16) | ((v & 0x0000ffff0000ffff) << 16);
        return bytes8((v >> 32) | (v << 32));
    }
}
