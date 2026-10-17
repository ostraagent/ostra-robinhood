// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {Wots} from "../src/Wots.sol";

/// @dev Calls the library the way a vault will: the signature stays in calldata.
contract WotsHarness {
    function recover(bytes calldata signature, bytes calldata message) external pure returns (bytes32) {
        return Wots.recoverKeyRoot(signature, message);
    }
}

/// @notice Signatures made by the Ostra TypeScript SDK (vectors/generate.ts) must recover the
///         key roots the SDK computed, and anything else must not.
contract WotsTest is Test {
    WotsHarness internal harness;
    bytes[] internal signatures;
    bytes[] internal messages;
    bytes32[] internal keyRoots;
    uint256[] internal steps;

    function setUp() public {
        harness = new WotsHarness();
        string memory json = vm.readFile("vectors/vectors.json");
        signatures = vm.parseJsonBytesArray(json, ".wots.signatures");
        messages = vm.parseJsonBytesArray(json, ".wots.messages");
        keyRoots = vm.parseJsonBytes32Array(json, ".wots.keyRoots");
        steps = vm.parseJsonUintArray(json, ".wots.steps");
    }

    function test_sdkSignaturesRecoverTheirKeyRoots() public view {
        assertEq(signatures.length, 64);
        assertEq(messages.length, 64);
        assertEq(keyRoots.length, 64);
        for (uint256 i = 0; i < signatures.length; ++i) {
            assertEq(signatures[i].length, Wots.SIGNATURE_LEN);
            assertEq(harness.recover(signatures[i], messages[i]), keyRoots[i]);
        }
    }

    function test_anotherMessageRecoversAnotherRoot() public view {
        for (uint256 i = 0; i < 8; ++i) {
            bytes memory message = messages[i];
            message[message.length - 1] ^= 0x01;
            assertTrue(harness.recover(signatures[i], message) != keyRoots[i]);
            assertTrue(harness.recover(signatures[i], messages[(i + 1) % 64]) != keyRoots[i]);
        }
    }

    function test_changedSignatureRecoversAnotherRoot() public view {
        bytes memory signature = signatures[0];
        // A byte of the salt, of the first chain, and of the last checksum chain.
        uint256[3] memory at = [uint256(3), 16 + 5, Wots.SIGNATURE_LEN - 1];
        for (uint256 k = 0; k < 3; ++k) {
            bytes memory changed = bytes.concat(signature);
            changed[at[k]] ^= 0x80;
            assertTrue(harness.recover(changed, messages[0]) != keyRoots[0]);
        }
    }

    function test_wrongLengthIsRefused() public {
        bytes memory short = new bytes(Wots.SIGNATURE_LEN - 1);
        vm.expectRevert(Wots.BadSignatureLength.selector);
        harness.recover(short, messages[0]);
        bytes memory long = bytes.concat(signatures[0], hex"00");
        vm.expectRevert(Wots.BadSignatureLength.selector);
        harness.recover(long, messages[0]);
    }

    /// @notice Gas of one verification against its number of hash steps, fitted as a line by
    ///         least squares and extended to the worst case of 990 steps.
    function test_gasPerHashStep() public view {
        harness.recover(signatures[0], messages[0]); // warm the harness account
        int256 n = int256(signatures.length);
        int256 sx;
        int256 sy;
        int256 sxx;
        int256 sxy;
        uint256 minSteps = type(uint256).max;
        uint256 maxSteps;
        uint256 minGas = type(uint256).max;
        uint256 maxGas;
        for (uint256 i = 0; i < signatures.length; ++i) {
            // Arguments are copied to memory first, so their storage reads are not counted.
            bytes memory signature = signatures[i];
            bytes memory message = messages[i];
            uint256 before = gasleft();
            harness.recover(signature, message);
            uint256 used = before - gasleft();
            int256 x = int256(steps[i]);
            int256 y = int256(used);
            sx += x;
            sy += y;
            sxx += x * x;
            sxy += x * y;
            if (steps[i] < minSteps) minSteps = steps[i];
            if (steps[i] > maxSteps) maxSteps = steps[i];
            if (used < minGas) minGas = used;
            if (used > maxGas) maxGas = used;
        }
        // slope and intercept scaled by 1000 to keep three decimals
        int256 slope1000 = (1000 * (n * sxy - sx * sy)) / (n * sxx - sx * sx);
        int256 intercept1000 = (1000 * sy - slope1000 * sx) / n;
        int256 worst = (intercept1000 + slope1000 * int256(Wots.MAX_VERIFIER_STEPS)) / 1000;
        console.log("wots vectors", signatures.length);
        console.log("steps min", minSteps, "max", maxSteps);
        console.log("gas min", minGas, "max", maxGas);
        console.log("gas per step x1000", uint256(slope1000));
        console.log("fixed gas", uint256(intercept1000 / 1000));
        console.log("worst case gas at 990 steps", uint256(worst));
        assertGt(worst, 0);
    }
}
