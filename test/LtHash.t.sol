// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {LtHash} from "../src/LtHash.sol";

contract LtHashHarness {
    function accOf(bytes32[] calldata keyRoots, uint64 amount) external view returns (bytes memory) {
        uint256[64] memory acc;
        for (uint256 i = 0; i < keyRoots.length; ++i) {
            LtHash.addLeaf(acc, keyRoots[i], amount);
        }
        return LtHash.toBytes(acc);
    }

    function stateHashOf(bytes32[] calldata keyRoots, uint64 amount) external view returns (bytes32) {
        uint256[64] memory acc;
        for (uint256 i = 0; i < keyRoots.length; ++i) {
            LtHash.addLeaf(acc, keyRoots[i], amount);
        }
        return LtHash.stateHash(acc, uint16(keyRoots.length), amount * uint64(keyRoots.length));
    }

    /// @dev Removes the leaves one commitment at a time, as SealBatch removes each deposit.
    function cancels(bytes memory total, bytes32[] calldata keyRoots, uint64 amount) external view returns (bool) {
        uint256[64] memory acc = LtHash.fromBytes(total);
        for (uint256 i = 0; i < keyRoots.length; ++i) {
            uint256[64] memory one;
            LtHash.addLeaf(one, keyRoots[i], amount);
            LtHash.sub(acc, one);
        }
        return LtHash.isZero(acc);
    }

    function addThenSub(bytes memory a, bytes memory b) external pure returns (bytes memory) {
        uint256[64] memory acc = LtHash.fromBytes(a);
        uint256[64] memory other = LtHash.fromBytes(b);
        LtHash.add(acc, other);
        LtHash.sub(acc, other);
        return LtHash.toBytes(acc);
    }
}

/// @notice The Solidity LtHash must give the bytes the Ostra TypeScript SDK gives
///         (vectors/generate.ts) for the same leaves.
contract LtHashTest is Test {
    LtHashHarness internal harness;
    bytes32[] internal keyRoots;
    uint64 internal amount;
    bytes internal acc;
    bytes internal accFirst;
    bytes32 internal stateHash;

    function setUp() public {
        harness = new LtHashHarness();
        string memory json = vm.readFile("vectors/vectors.json");
        keyRoots = vm.parseJsonBytes32Array(json, ".lthash.keyRoots");
        uint256[] memory amounts = vm.parseJsonUintArray(json, ".lthash.amounts");
        amount = uint64(amounts[0]);
        for (uint256 i = 0; i < amounts.length; ++i) {
            assertEq(amounts[i], amount);
        }
        acc = vm.parseJsonBytes(json, ".lthash.acc");
        accFirst = vm.parseJsonBytes(json, ".lthash.accFirst");
        stateHash = vm.parseJsonBytes32(json, ".lthash.stateHash");
    }

    function _first(uint256 count) internal view returns (bytes32[] memory out) {
        out = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            out[i] = keyRoots[i];
        }
    }

    function test_oneLeafMatchesTheSdk() public view {
        assertEq(keccak256(harness.accOf(_first(1), amount)), keccak256(accFirst));
    }

    function test_ninetyLeavesMatchTheSdk() public view {
        assertEq(keyRoots.length, 90);
        assertEq(keccak256(harness.accOf(keyRoots, amount)), keccak256(acc));
    }

    function test_orderDoesNotMatter() public view {
        bytes32[] memory reversed = new bytes32[](keyRoots.length);
        for (uint256 i = 0; i < keyRoots.length; ++i) {
            reversed[i] = keyRoots[keyRoots.length - 1 - i];
        }
        assertEq(keccak256(harness.accOf(reversed, amount)), keccak256(acc));
    }

    function test_stateHashMatchesTheSdk() public view {
        assertEq(harness.stateHashOf(keyRoots, amount), stateHash);
    }

    function test_removingEveryLeafLeavesZero() public view {
        assertTrue(harness.cancels(acc, keyRoots, amount));
        assertFalse(harness.cancels(acc, _first(89), amount));
    }

    function test_addThenSubIsIdentity() public view {
        assertEq(keccak256(harness.addThenSub(acc, accFirst)), keccak256(acc));
    }

    function test_anotherLeafGivesAnotherHash() public view {
        bytes32[] memory changed = _first(90);
        changed[17] = keccak256("another leaf");
        assertTrue(keccak256(harness.accOf(changed, amount)) != keccak256(acc));
        assertTrue(keccak256(harness.accOf(keyRoots, amount + 1)) != keccak256(acc));
    }

    /// @notice Gas to fold leaves into an accumulator in memory (what AppendLeaves computes).
    function test_gasPerLeaf() public view {
        harness.accOf(_first(1), amount); // warm the harness account
        // Arguments are copied to memory first, so their storage reads are not counted.
        bytes32[] memory one = _first(1);
        bytes32[] memory all = _first(90);
        uint64 leafAmount = amount;
        uint256 before = gasleft();
        harness.accOf(one, leafAmount);
        uint256 gasOne = before - gasleft();
        before = gasleft();
        harness.accOf(all, leafAmount);
        uint256 gasNinety = before - gasleft();
        console.log("lthash gas for 1 leaf", gasOne);
        console.log("lthash gas for 90 leaves", gasNinety);
        console.log("lthash gas per added leaf", (gasNinety - gasOne) / 89);
        assertGt(gasNinety, gasOne);
    }
}
