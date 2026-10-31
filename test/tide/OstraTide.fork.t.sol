// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

import {OstraTide, TidePot} from "../../src/tide/OstraTide.sol";

interface IFactory {
    function createVault(address token, bytes32 initialKeyRoot, address initialCrank) external returns (address);
}

/// @notice OstraTide on a Robinhood Chain mainnet fork, with the real OSTRA token, the real OstraVaultFactory and
///         vaults it made (an OSTRA vault that exists on chain, a USDG vault that exists on chain, and new OSTRA
///         vaults the tests create through the factory). OSTRA for the pots comes from the Uniswap v4 PoolManager,
///         which holds OSTRA on chain.
contract OstraTideForkTest is Test {
    address internal constant OSTRA = 0x68Ff81dFFF6eccefb74706fE1e0a86320CB2Eb96;
    address internal constant FACTORY = 0x043a15c514CFE2c797d33520bFF91a5DCdbf2979;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev OSTRA and USDG vaults OstraVaultFactory made on chain (its VaultCreated events).
    address internal constant LIVE_OSTRA_VAULT = 0xFB4C7c307AC23e1518e56e7F5292ff926619CB36;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev 28 Oct 2026 00:00 UTC: Season 1's first week. The public RPC keeps no historical state, so the fork is
    ///      the chain's head: before SEASON_START the tests use it, later a start one day after the head, so that the
    ///      suite keeps working (every test warps from START).
    uint256 internal constant SEASON_START = 1793145600;
    uint256 internal START;

    OstraTide internal tide;
    address internal owner = makeAddr("ostra");
    address internal stranger = makeAddr("stranger");
    address internal usdgVault;
    address internal vaultA;
    address internal vaultB;

    function setUp() public {
        vm.createSelectFork("robinhood");
        assertEq(block.chainid, 4663);
        START = block.timestamp < SEASON_START ? SEASON_START : block.timestamp + 1 days;
        tide = new OstraTide(OSTRA, FACTORY, START, owner);
        assertEq(IVault(LIVE_OSTRA_VAULT).token(), OSTRA);
        usdgVault = IFactory(FACTORY).createVault(USDG, keccak256("tide-test-usdg"), address(0));
        vaultA = IFactory(FACTORY).createVault(OSTRA, keccak256("tide-test-a"), address(0));
        vaultB = IFactory(FACTORY).createVault(OSTRA, keccak256("tide-test-b"), address(0));
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _fund(uint256 week, uint256 amount) internal {
        address pot = tide.potAddress(week);
        uint256 before = IERC20(OSTRA).balanceOf(pot);
        vm.prank(POOL_MANAGER);
        IERC20(OSTRA).transfer(pot, amount);
        assertEq(IERC20(OSTRA).balanceOf(pot), before + amount, "OSTRA moves exactly, with no fee on transfer");
    }

    function _share(uint256 week, uint256 agentId, address payee, uint256 amount)
        internal
        pure
        returns (OstraTide.Share memory)
    {
        return OstraTide.Share(week, agentId, payee, amount);
    }

    function _leaf(OstraTide.Share memory s) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(s.week, s.agentId, s.payee, s.amount))));
    }

    /// @dev A tree of four leaves with OpenZeppelin's commutative pair hash; the proof of leaf i.
    function _tree4(OstraTide.Share[4] memory s) internal pure returns (bytes32 root, bytes32[][] memory proofs) {
        bytes32[4] memory l;
        for (uint256 i = 0; i < 4; i++) l[i] = _leaf(s[i]);
        bytes32 n01 = Hashes.commutativeKeccak256(l[0], l[1]);
        bytes32 n23 = Hashes.commutativeKeccak256(l[2], l[3]);
        root = Hashes.commutativeKeccak256(n01, n23);
        proofs = new bytes32[][](4);
        for (uint256 i = 0; i < 4; i++) {
            proofs[i] = new bytes32[](2);
            proofs[i][0] = l[i ^ 1];
            proofs[i][1] = i < 2 ? n23 : n01;
        }
    }

    function _week1() internal returns (OstraTide.Share[4] memory s, bytes32 root, bytes32[][] memory proofs) {
        s[0] = _share(1, 11, LIVE_OSTRA_VAULT, 4_000_000e18);
        s[1] = _share(1, 12, vaultA, 3_000_000e18);
        s[2] = _share(1, 13, address(0), 2_000_000e18); // no OSTRA vault yet when the root was computed
        s[3] = _share(1, 14, vaultB, 1_000_000e18);
        (root, proofs) = _tree4(s);
        _fund(1, 10_000_000e18);
        vm.warp(tide.weekEnd(1));
        vm.prank(owner);
        tide.setRoot(1, root, 10_000_000e18);
    }

    // ---------------------------------------------------------------------------------------------
    // Weeks and pots
    // ---------------------------------------------------------------------------------------------

    function test_weeks() public view {
        assertEq(tide.weekAt(START - 1), 0);
        assertEq(tide.weekAt(START), 1);
        assertEq(tide.weekAt(START + 7 days - 1), 1);
        assertEq(tide.weekAt(START + 7 days), 2);
        assertEq(tide.weekEnd(1), START + 7 days);
        assertEq(tide.weekEnd(4), START + 28 days);
        assertEq(tide.currentWeek(), 0);
    }

    function test_potAddressIsFixedAndFundableBeforeCode() public {
        address pot = tide.potAddress(1);
        assertEq(pot.code.length, 0);
        assertTrue(pot != tide.potAddress(2));
        _fund(1, 1e18);
        assertEq(tide.potBalance(1), 1e18);
        vm.warp(tide.weekEnd(1));
        vm.prank(owner);
        tide.setRoot(1, bytes32(uint256(1)), 1e18);
        assertGt(pot.code.length, 0, "the pot is created at its fixed address");
        assertEq(TidePot(pot).TIDE(), address(tide));
        assertEq(address(TidePot(pot).TOKEN()), OSTRA);
    }

    function test_potSendsOnlyForTide() public {
        _fund(1, 1e18);
        vm.warp(tide.weekEnd(1));
        vm.prank(owner);
        tide.setRoot(1, bytes32(uint256(1)), 1e18);
        TidePot pot = TidePot(tide.potAddress(1));
        vm.expectRevert(TidePot.OnlyTide.selector);
        vm.prank(owner);
        pot.send(owner, 1e18);
    }

    // ---------------------------------------------------------------------------------------------
    // Roots
    // ---------------------------------------------------------------------------------------------

    function test_setRootRules() public {
        _fund(1, 5e18);
        bytes32 root = bytes32(uint256(7));
        vm.prank(owner);
        vm.expectRevert(OstraTide.NotEnded.selector);
        tide.setRoot(1, root, 5e18);

        vm.warp(tide.weekEnd(1) - 1);
        vm.prank(owner);
        vm.expectRevert(OstraTide.NotEnded.selector);
        tide.setRoot(1, root, 5e18);

        vm.warp(tide.weekEnd(1));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        tide.setRoot(1, root, 5e18);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(OstraTide.OverPot.selector, 5e18));
        tide.setRoot(1, root, 5e18 + 1);
        vm.expectRevert(OstraTide.BadParams.selector);
        tide.setRoot(0, root, 1);
        vm.expectRevert(OstraTide.BadParams.selector);
        tide.setRoot(1, bytes32(0), 1);
        vm.expectRevert(OstraTide.BadParams.selector);
        tide.setRoot(1, root, 0);

        tide.setRoot(1, root, 5e18);
        vm.expectRevert(OstraTide.RootAlreadySet.selector);
        tide.setRoot(1, bytes32(uint256(8)), 1e18);
        vm.stopPrank();

        OstraTide.Week memory w = tide.weekInfo(1);
        assertEq(w.root, root);
        assertEq(w.total, 5e18);
        assertEq(w.rootAt, tide.weekEnd(1));
        assertEq(tide.rolloverAt(1), tide.weekEnd(1) + 14 days);
    }

    function test_noRenounceAndTwoStepOwnership() public {
        vm.prank(owner);
        vm.expectRevert(OstraTide.NoRenounce.selector);
        tide.renounceOwnership();
        address next = makeAddr("next");
        vm.prank(owner);
        tide.transferOwnership(next);
        assertEq(tide.owner(), owner, "ownership moves only when accepted");
        vm.prank(next);
        tide.acceptOwnership();
        assertEq(tide.owner(), next);
    }

    // ---------------------------------------------------------------------------------------------
    // Paying
    // ---------------------------------------------------------------------------------------------

    function test_payNamedVaultsByAnyone() public {
        (OstraTide.Share[4] memory s,, bytes32[][] memory proofs) = _week1();
        uint256 liveBefore = IERC20(OSTRA).balanceOf(LIVE_OSTRA_VAULT);
        vm.prank(stranger);
        tide.pay(s[0], proofs[0], address(0));
        assertEq(IERC20(OSTRA).balanceOf(LIVE_OSTRA_VAULT), liveBefore + 4_000_000e18);
        assertTrue(tide.paid(1, 11));

        vm.prank(stranger);
        vm.expectRevert(OstraTide.AlreadyPaid.selector);
        tide.pay(s[0], proofs[0], address(0));

        // The `vault` argument is ignored for a share that names its payee.
        vm.prank(stranger);
        tide.pay(s[1], proofs[1], stranger);
        assertEq(IERC20(OSTRA).balanceOf(vaultA), 3_000_000e18);
        assertEq(tide.weekInfo(1).paid, 7_000_000e18);
        assertEq(tide.potBalance(1), 3_000_000e18);
    }

    function test_payRefusesWrongProofsAndAmounts() public {
        (OstraTide.Share[4] memory s,, bytes32[][] memory proofs) = _week1();
        OstraTide.Share memory more = s[0];
        more.amount += 1;
        vm.expectRevert(OstraTide.BadProof.selector);
        tide.pay(more, proofs[0], address(0));
        OstraTide.Share memory other = s[0];
        other.payee = vaultB;
        vm.expectRevert(OstraTide.BadProof.selector);
        tide.pay(other, proofs[0], address(0));
        vm.expectRevert(OstraTide.BadProof.selector);
        tide.pay(s[0], proofs[1], address(0));
        OstraTide.Share memory week2 = s[0];
        week2.week = 2;
        vm.expectRevert(OstraTide.NoRoot.selector);
        tide.pay(week2, proofs[0], address(0));
    }

    function test_payOnlyToOstraOstraVaults() public {
        OstraTide.Share[4] memory s;
        s[0] = _share(1, 21, usdgVault, 1e18); // an Ostra vault, but of USDG
        s[1] = _share(1, 22, stranger, 1e18); // not a contract
        s[2] = _share(1, 23, OSTRA, 1e18); // a contract, not a vault
        s[3] = _share(1, 24, vaultA, 1e18);
        (bytes32 root, bytes32[][] memory proofs) = _tree4(s);
        _fund(1, 4e18);
        vm.warp(tide.weekEnd(1));
        vm.prank(owner);
        tide.setRoot(1, root, 4e18);
        vm.expectRevert(abi.encodeWithSelector(OstraTide.NotOstraVault.selector, usdgVault));
        tide.pay(s[0], proofs[0], address(0));
        vm.expectRevert(abi.encodeWithSelector(OstraTide.NotOstraVault.selector, stranger));
        tide.pay(s[1], proofs[1], address(0));
        vm.expectRevert(abi.encodeWithSelector(OstraTide.NotOstraVault.selector, OSTRA));
        tide.pay(s[2], proofs[2], address(0));
        tide.pay(s[3], proofs[3], address(0));
        assertEq(IERC20(OSTRA).balanceOf(vaultA), 1e18);
    }

    function test_payeeLaterVaultOnlyByOwner() public {
        (OstraTide.Share[4] memory s,, bytes32[][] memory proofs) = _week1();
        vm.prank(stranger);
        vm.expectRevert(OstraTide.OnlyOwnerChoosesVault.selector);
        tide.pay(s[2], proofs[2], vaultA);

        // The agent opens its OSTRA vault after the root.
        address late = IFactory(FACTORY).createVault(OSTRA, keccak256("tide-test-late"), address(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(OstraTide.NotOstraVault.selector, usdgVault));
        tide.pay(s[2], proofs[2], usdgVault);
        vm.prank(owner);
        tide.pay(s[2], proofs[2], late);
        assertEq(IERC20(OSTRA).balanceOf(late), 2_000_000e18);
        assertTrue(tide.paid(1, 13));
    }

    function test_payNeverAboveTotal() public {
        OstraTide.Share[4] memory s;
        s[0] = _share(1, 31, vaultA, 6e18);
        s[1] = _share(1, 32, vaultB, 6e18);
        s[2] = _share(1, 33, LIVE_OSTRA_VAULT, 0);
        s[3] = _share(1, 34, LIVE_OSTRA_VAULT, 0);
        (bytes32 root, bytes32[][] memory proofs) = _tree4(s);
        _fund(1, 20e18);
        vm.warp(tide.weekEnd(1));
        vm.prank(owner);
        tide.setRoot(1, root, 10e18); // shares add up to more than the total posted
        tide.pay(s[0], proofs[0], address(0));
        vm.expectRevert(OstraTide.OverTotal.selector);
        tide.pay(s[1], proofs[1], address(0));
        assertEq(tide.potBalance(1), 14e18);
    }

    function test_payMany() public {
        (OstraTide.Share[4] memory s,, bytes32[][] memory proofs) = _week1();
        OstraTide.Share[] memory list = new OstraTide.Share[](3);
        bytes32[][] memory p = new bytes32[][](3);
        address[] memory v = new address[](3);
        (list[0], list[1], list[2]) = (s[0], s[1], s[3]);
        (p[0], p[1], p[2]) = (proofs[0], proofs[1], proofs[3]);
        tide.payMany(list, p, v);
        assertEq(tide.weekInfo(1).paid, 8_000_000e18);
        assertEq(tide.potBalance(1), 2_000_000e18, "the share with no vault yet stays in the pot");
        vm.expectRevert(OstraTide.BadParams.selector);
        tide.payMany(list, p, new address[](2));
    }

    // ---------------------------------------------------------------------------------------------
    // Rolling over
    // ---------------------------------------------------------------------------------------------

    function test_rolloverAfterHold() public {
        (OstraTide.Share[4] memory s,, bytes32[][] memory proofs) = _week1();
        tide.pay(s[0], proofs[0], address(0));
        uint256 at = tide.weekEnd(1) + 14 days;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(OstraTide.TooEarly.selector, at));
        tide.rollover(1);

        vm.warp(at);
        uint256 toWeek = tide.currentWeek();
        assertEq(toWeek, 4);
        vm.prank(stranger);
        tide.rollover(1);
        assertEq(tide.potBalance(1), 0);
        assertEq(tide.potBalance(4), 6_000_000e18);
        assertTrue(tide.weekInfo(1).rolled);

        vm.expectRevert(OstraTide.AlreadyRolled.selector);
        tide.pay(s[1], proofs[1], address(0));

        // OSTRA sent to a rolled pot is swept forward too.
        _fund(1, 5e18);
        vm.warp(at + 7 days);
        tide.rollover(1);
        assertEq(tide.potBalance(1), 0);
        assertEq(tide.potBalance(5), 5e18);
    }

    function test_rolloverWithoutRoot() public {
        _fund(2, 3e18);
        uint256 at = tide.weekEnd(2) + 14 days;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(OstraTide.TooEarly.selector, at));
        tide.rollover(2);
        vm.warp(at);
        tide.rollover(2);
        assertEq(tide.potBalance(tide.currentWeek()), 3e18);
        vm.prank(owner);
        vm.expectRevert(OstraTide.RootTooLate.selector); // a rolled week never gets a root
        tide.setRoot(2, bytes32(uint256(1)), 1);
    }

    function test_rolledOSTRACanBePaidNextWeek() public {
        _fund(1, 9e18);
        vm.warp(tide.weekEnd(1) + 14 days); // week 3 ended, week 4 in progress
        tide.rollover(1);
        assertEq(tide.potBalance(4), 9e18);
        OstraTide.Share[4] memory s;
        s[0] = _share(4, 41, vaultA, 9e18);
        s[1] = _share(4, 42, vaultB, 0);
        s[2] = _share(4, 43, vaultB, 0);
        s[3] = _share(4, 44, vaultB, 0);
        (bytes32 root, bytes32[][] memory proofs) = _tree4(s);
        vm.warp(tide.weekEnd(4));
        vm.prank(owner);
        tide.setRoot(4, root, 9e18);
        tide.pay(s[0], proofs[0], address(0));
        assertEq(IERC20(OSTRA).balanceOf(vaultA), 9e18);
    }

    // ---------------------------------------------------------------------------------------------
    // Review fixes: late roots, week 0, sweeping, batches, empty pots
    // ---------------------------------------------------------------------------------------------

    function test_rootOnlyWithinHold() public {
        _fund(1, 2e18);
        vm.warp(tide.weekEnd(1) + 14 days);
        vm.prank(owner);
        vm.expectRevert(OstraTide.RootTooLate.selector);
        tide.setRoot(1, bytes32(uint256(1)), 1e18);
        vm.warp(tide.weekEnd(1) + 14 days - 1);
        vm.prank(owner);
        tide.setRoot(1, bytes32(uint256(1)), 1e18);
        assertEq(tide.rolloverAt(1), tide.weekEnd(1) + 28 days - 1, "held 14 days after the root");
    }

    function test_week0PotRollsForward() public {
        assertEq(tide.currentWeek(), 0);
        _fund(0, 7e18); // sent to potAddress(currentWeek()) before START
        vm.warp(START + 14 days - 1);
        vm.expectRevert(abi.encodeWithSelector(OstraTide.TooEarly.selector, START + 14 days));
        tide.rollover(0);
        vm.warp(START + 14 days);
        tide.rollover(0);
        assertEq(tide.potBalance(0), 0);
        assertEq(tide.potBalance(3), 7e18);
        vm.prank(owner);
        vm.expectRevert(OstraTide.BadParams.selector);
        tide.setRoot(0, bytes32(uint256(1)), 1);
    }

    function test_sweepOSTRASentToTide() public {
        vm.prank(POOL_MANAGER);
        IERC20(OSTRA).transfer(address(tide), 3e18);
        vm.warp(START + 8 days);
        vm.prank(stranger);
        tide.sweep();
        assertEq(IERC20(OSTRA).balanceOf(address(tide)), 0);
        assertEq(tide.potBalance(2), 3e18);
        tide.sweep(); // nothing left: no effect
        assertEq(tide.potBalance(2), 3e18);
    }

    function test_payManySkipsPaidShares() public {
        (OstraTide.Share[4] memory s,, bytes32[][] memory proofs) = _week1();
        uint256 liveBefore = IERC20(OSTRA).balanceOf(LIVE_OSTRA_VAULT);
        vm.prank(stranger);
        tide.pay(s[1], proofs[1], address(0)); // paid by someone else first
        OstraTide.Share[] memory list = new OstraTide.Share[](3);
        bytes32[][] memory p = new bytes32[][](3);
        (list[0], list[1], list[2]) = (s[0], s[1], s[0]); // already paid, and twice in the batch
        (p[0], p[1], p[2]) = (proofs[0], proofs[1], proofs[0]);
        tide.payMany(list, p, new address[](3));
        assertEq(tide.weekInfo(1).paid, 7_000_000e18);
        assertEq(IERC20(OSTRA).balanceOf(LIVE_OSTRA_VAULT), liveBefore + 4_000_000e18, "paid once");
        // Any other failure still reverts the batch.
        OstraTide.Share[] memory bad = new OstraTide.Share[](1);
        bytes32[][] memory bp = new bytes32[][](1);
        bad[0] = s[2]; // no payee: only Ostra names the vault
        bp[0] = proofs[2];
        vm.prank(stranger);
        vm.expectRevert(OstraTide.OnlyOwnerChoosesVault.selector);
        tide.payMany(bad, bp, new address[](1));
    }

    function test_emptyPotRollsWithoutCode() public {
        vm.warp(tide.weekEnd(1) + 14 days);
        tide.rollover(1);
        assertTrue(tide.weekInfo(1).rolled);
        assertEq(tide.potAddress(1).code.length, 0, "no pot is created for nothing");
    }

    /// @dev The tree and proofs from OpenZeppelin's StandardMerkleTree (@openzeppelin/merkle-tree 1.0.8), as the
    ///      scoring script will build them: StandardMerkleTree.of(values, ["uint256", "uint256", "address",
    ///      "uint256"]) over [week, agentId, payee, amount], five leaves, one with no payee.
    function test_standardMerkleTreeVector() public {
        assertEq(vaultA, 0xfD6204F338191E3B1429b2e33a90EA3d44D7b493);
        assertEq(vaultB, 0x5B1a32E69aC3bf3789B1d4a4d622F6Fb2b8693D4);
        OstraTide.Share[5] memory s = [
            _share(1, 11, LIVE_OSTRA_VAULT, 4_000_000e18),
            _share(1, 12, vaultA, 3_000_000e18),
            _share(1, 13, address(0), 2_000_000e18),
            _share(1, 14, vaultB, 600_000e18),
            _share(1, 15, vaultB, 400_000e18)
        ];
        bytes32[][] memory proofs = new bytes32[][](5);
        proofs[0] = _p2(0x8706b3e4fae43708ddd0c747dbac661d01cf1e0b43bacbedf4e8e322e6d7fac9, 0x669fc02abb5cdd8fe6ed8fc00c8fc0e2e549504cdebcc9ed522ac0b5759501ad);
        proofs[1] = _p3(0x282b7334a214c4788f66effee8339f2145f7b3aae91c79daf40bf3b50cc3745c, 0xdfd7afb7a7ade1636f59540ce7c0d83356a4f974259618483630a047fd34570d, 0xa0906dad92d09fe5d0df3edb0bc0fc9e7027dff5e9220a768db99400d3b70453);
        proofs[2] = _p2(0x630441101f3997cb7e7448645d6923c22b931e80cd2b6e693384fcfb7c663824, 0xa0906dad92d09fe5d0df3edb0bc0fc9e7027dff5e9220a768db99400d3b70453);
        proofs[3] = _p3(0x081e32820232991cd8b929d98504e4c8376aafe5a9f6dbea569e4c1610374381, 0xdfd7afb7a7ade1636f59540ce7c0d83356a4f974259618483630a047fd34570d, 0xa0906dad92d09fe5d0df3edb0bc0fc9e7027dff5e9220a768db99400d3b70453);
        proofs[4] = _p2(0x97df77d4fe56d6f880e17e80e6c8b05ed2baa17430ee5e30519e378f6762b96d, 0x669fc02abb5cdd8fe6ed8fc00c8fc0e2e549504cdebcc9ed522ac0b5759501ad);
        assertEq(_leaf(s[0]), 0x97df77d4fe56d6f880e17e80e6c8b05ed2baa17430ee5e30519e378f6762b96d);
        assertEq(_leaf(s[2]), 0xdfd7afb7a7ade1636f59540ce7c0d83356a4f974259618483630a047fd34570d);
        _fund(1, 10_000_000e18);
        vm.warp(tide.weekEnd(1));
        vm.prank(owner);
        tide.setRoot(1, 0x21fd8be3b7f03579d1b787b7f0040e2b13e7263bb59b1a05e873395d0f9fa28e, 10_000_000e18);
        address late = IFactory(FACTORY).createVault(OSTRA, keccak256("tide-test-late"), address(0));
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(owner);
            tide.pay(s[i], proofs[i], i == 2 ? late : address(0));
        }
        assertEq(tide.weekInfo(1).paid, 10_000_000e18);
        assertEq(tide.potBalance(1), 0);
        assertEq(IERC20(OSTRA).balanceOf(vaultB), 1_000_000e18);
        assertEq(IERC20(OSTRA).balanceOf(late), 2_000_000e18);
    }

    function _p2(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        (p[0], p[1]) = (a, b);
    }

    function _p3(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](3);
        (p[0], p[1], p[2]) = (a, b, c);
    }

    /// @dev Whatever the shares and the total posted: OSTRA paid never exceeds the total, and the pot always holds
    ///      what was funded less what was paid.
    function testFuzz_paidWithinTotal(uint96 a0, uint96 a1, uint96 a2, uint96 a3, uint256 total) public {
        // Well within what the PoolManager holds on chain (about 190 million OSTRA), which funds the pot.
        total = bound(total, 1, 10_000_000e18);
        a0 = uint96(bound(a0, 0, 6_000_000e18));
        a1 = uint96(bound(a1, 0, 6_000_000e18));
        a2 = uint96(bound(a2, 0, 6_000_000e18));
        a3 = uint96(bound(a3, 0, 6_000_000e18));
        OstraTide.Share[4] memory s;
        s[0] = _share(1, 51, vaultA, a0);
        s[1] = _share(1, 52, vaultB, a1);
        s[2] = _share(1, 53, LIVE_OSTRA_VAULT, a2);
        s[3] = _share(1, 54, vaultA, a3);
        (bytes32 root, bytes32[][] memory proofs) = _tree4(s);
        uint256 funded = uint256(total) + 1e18;
        _fund(1, funded);
        vm.warp(tide.weekEnd(1));
        vm.prank(owner);
        tide.setRoot(1, root, total);
        uint256 sum;
        for (uint256 i = 0; i < 4; i++) {
            if (sum + s[i].amount > total) {
                vm.expectRevert(OstraTide.OverTotal.selector);
                tide.pay(s[i], proofs[i], address(0));
            } else {
                tide.pay(s[i], proofs[i], address(0));
                sum += s[i].amount;
            }
            assertLe(tide.weekInfo(1).paid, total);
            assertEq(tide.potBalance(1), funded - sum);
        }
    }
}

interface IVault {
    function token() external view returns (address);
}
