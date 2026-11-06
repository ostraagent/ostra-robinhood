// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OstraRegistry} from "../../src/OstraRegistry.sol";
import {OstraVault} from "../../src/OstraVault.sol";
import {OstraVaultFactory} from "../../src/OstraVaultFactory.sol";
import {IPriorsPool, OstraVaultModuleV5} from "../../src/OstraVaultModuleV5.sol";
import {OstraVaultV3} from "../../src/OstraVaultV3.sol";
import {OstraVaultV5} from "../../src/OstraVaultV5.sol";
import {WotsSigner} from "../utils/WotsSigner.sol";
import {VaultStack} from "../utils/VaultStack.sol";
import {SafeWallet} from "../utils/SafeWallet.sol";

/// @notice The C model of version 5 (formal/v5/model) against the real contracts on a fork: each run drives a fresh
///         vault through a random sequence of owner spends, agent spends, order runs, guardian calls, a recovery and
///         time, records what each step did and what the vault's views show after it, and has the model replay the
///         same sequence (formal/v5/diff/replay.c, through ffi), which must agree at every step.
///         Run with FOUNDRY_FFI=true and OSTRA_MODEL_REPLAY set to the built replay program.
interface IIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

contract V5ModelDiffForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant OWNER = keccak256("OSTRA/EVM/TEST/v5-model-owner");
    bytes32 internal constant AGENT = keccak256("OSTRA/EVM/TEST/v5-model-agent");
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant STRANGER = address(0x5A11);
    uint64 internal constant AGENT_ACTIONS = 0x5e7f1c7e0c2b;
    uint256 internal constant BALANCE = 1e15;
    uint256 internal constant STEPS = 32;
    /// @dev The model's ids (formal/v5/model/ostra_v5_model.h): 6 a value wider than an address, 7 the vault.
    uint256 internal constant VALUE_WIDE = 6;
    uint256 internal constant ADDR_SELF = 7;
    uint64 internal constant OUTCOME_OTHER = 9999;
    /// @dev Spark Savings USDG, an ERC-4626 venue the vault enables, so that SWEEP and REFILL orders really run.
    address internal constant SPARK = 0xde770c84FE66E063336b31737cFE9790f18c4087;
    address internal constant PRIORS_POOL = 0x281210097f0de7A8FB6F87310AF0f089c9C8DE21;
    /// @dev OstraVaultV5.SLOT: the version 5 storage, read for what the views do not show.
    uint256 internal constant SLOT = 0x08a2d09332cd6f2fc6deb9ea94fe2d0f53207701b1a66b5a4c0e51e4ea1c3c00;
    /// @dev A Uniswap v4 pool key (USDG and another currency) whose PoolId is the allowlist value of id 5 for the pool kind.
    address internal constant OTHER_CURRENCY = address(0xC0FFEE);

    OstraVault internal vault;
    address internal withdrawal;
    /// @dev An ERC-8004 agent this vault registered, and one someone else did.
    uint256 internal ownAgentId;
    uint256 internal foreignAgentId;
    address[8] internal addrs;

    /// @dev The trace, a word at a time (a storage array: appending to bytes in memory grows memory quadratically).
    uint64[] internal words;
    uint256 internal rng;
    uint64 internal seedCount;
    mapping(bytes32 root => bytes32) internal seedOf;
    mapping(bytes32 root => uint64) internal rootId;
    uint64 internal rootIds;

    function setUp() public {
        vm.createSelectFork("robinhood");
        withdrawal = SafeWallet.create(makeAddr("model withdrawal owner"), 7);
        (OstraVaultFactory factory,) = VaultStack.deploy(address(new OstraRegistry()));
        bytes32 first = _newSeed(OWNER);
        vault = OstraVault(factory.createVault(USDG, _root(first), address(0)));
        deal(USDG, address(vault), BALANCE);
        for (uint256 i = 1; i <= 3; ++i) {
            addrs[i] = address(uint160(0xA0000 + i));
        }
        // Id 4: another Ostra vault, this one's linked vault (the agent key's ClaimDividend and Repay may name it).
        addrs[4] = factory.createVault(USDG, _root(_newSeed(AGENT)), address(0));
        addrs[5] = SPARK;
        addrs[ADDR_SELF] = address(vault);
        // Set up before version 5 is used (the lock is off): a guardian, a recovery that one support starts, and Spark
        // as a venue.
        require(_ownerSpend(6, abi.encode(GUARDIAN, true), _root(_newSeed(OWNER))) == 0, "guardian");
        require(_ownerSpend(7, abi.encode(uint8(1), uint32(36 hours)), _root(_newSeed(OWNER))) == 0, "recovery policy");
        require(_ownerSpend(25, abi.encode(uint8(3), SPARK, true), _root(_newSeed(OWNER))) == 0, "venue");
        require(_ownerSpend(16, abi.encode(addrs[4]), _root(_newSeed(OWNER))) == 0, "link");
        require(vault.linkedVault() == addrs[4], "linked");
        vm.recordLogs();
        require(_ownerSpend(12, abi.encode("https://ostraagent.xyz/model-test"), _root(_newSeed(OWNER))) == 0, "agent");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == OstraVault.AgentRegistered.selector) {
                ownAgentId = uint256(logs[i].topics[1]);
            }
        }
        require(ownAgentId != 0, "agent id");
        vm.prank(STRANGER);
        foreignAgentId = IIdentityRegistry(VaultStack.IDENTITY_REGISTRY).register("https://ostraagent.xyz/model-test-other");
    }

    /// @dev The number of runs is the fuzz runs setting (FOUNDRY_FUZZ_RUNS).
    function testFuzz_modelAgreesWithTheContracts(uint256 seed) public {
        rng = seed;
        _word(5);
        _word(uint64(vm.getBlockTimestamp()));
        _word(_id(vault.keyRoot()));
        _word(vault.nonce());
        _word(uint64(IERC20(USDG).balanceOf(address(vault))));
        _word(_addrId(vault.linkedVault()));
        // Most runs start from a working agent key and a PAY order, so that most of what follows is judged on its
        // merits rather than refused for want of a key.
        uint256 start = 0;
        if (_rand(5) != 0) {
            _stepPolicy(true);
            _stepAllow(1, 1, true);
            _stepAgentKey(true);
            _stepWorkingOrder(3);
            _stepWorkingOrder(1);
            _stepWorkingOrder(2);
            _stepAllow(5, 2, true);
            start = 7;
        }
        for (uint256 i = start; i < STEPS; ++i) {
            _step();
        }
        string[] memory cmd = _replayCommand();
        bytes memory out = vm.ffi(cmd);
        assertEq(_prefix(out, 3), "OK ", string(out));
    }

    // ---------------------------------------------------------------------------------------------
    // Steps
    // ---------------------------------------------------------------------------------------------

    function _step() internal {
        // Under the lock, consents (which then wait) more often.
        if (_locked() && _rand(10) == 0) return _stepConsent();
        uint256 r = _rand(115);
        if (r < 12) _stepWarp();
        else if (r < 22) _stepPolicy(false);
        else if (r < 34) _stepAllow(_rand(7), _rand(8), _rand(5) != 0);
        else if (r < 42) _stepAgentKey(false);
        else if (r < 44) _stepOwnerV5(32, "", _ownerNext());
        else if (r < 52) _stepOwnerOrder();
        else if (r < 55) _stepOwnerV5(34, abi.encode(_rand(vault.orderCount() + 2)), _ownerNext());
        else if (r < 58) _stepLockOn();
        else if (r < 61) _stepCancelPending();
        else if (r < 75) _stepAgentTransfer();
        else if (r < 79) _stepAgentOrder();
        else if (r < 82) _stepAgentCancel();
        else if (r < 83) _stepAgent(32, "", new uint64[](0));
        else if (r < 85) _stepAgentForbidden();
        else if (r < 95) _stepRunOrder();
        else if (r < 97) _stepGuard(7);
        else if (r < 99) _stepGuard(0);
        else if (r < 101) _stepRecovery();
        else if (r < 103) _stepFinishRecovery();
        else if (r < 104) _stepDeposit();
        else if (r < 106) _stepOwnerOther();
        else if (r < 108) _stepVenueEdge();
        else if (r < 109) _stepEndEdge();
        else if (r < 111) _stepConsent();
        else _stepAgentOther();
    }

    function _stepWarp() internal {
        uint64[9] memory dts = [uint64(0), 1, 59 minutes, 1 hours, 6 hours, 1 days, 36 hours, 3 days, 15 days];
        uint64 dt = dts[_rand(9)];
        vm.warp(vm.getBlockTimestamp() + dt);
        _record(1, _args1(dt), 0);
    }

    function _stepPolicy(bool working) internal {
        OstraVaultV5.Policy memory p = working ? _workingPolicy() : _randomPolicy();
        uint64[] memory a = new uint64[](13);
        a[0] = p.actions;
        a[1] = uint64(p.perTx);
        a[2] = uint64(p.daily);
        a[3] = uint64(p.maxDebt);
        a[4] = p.maxTerm;
        a[5] = p.maxFeeBps;
        a[6] = p.coverBps;
        a[7] = p.repayLead;
        a[8] = p.repayKind;
        a[9] = _addrId(p.repayVenue);
        a[10] = uint64(p.vouchPerAgent);
        a[11] = uint64(p.vouchTotal);
        a[12] = p.maxPremiumBps;
        _stepOwnerV5Args(29, abi.encode(p), working ? _root(_newSeed(OWNER)) : _ownerNext(), a);
    }

    function _stepAllow(uint256 kind, uint256 vid, bool on) internal {
        uint64[] memory a = new uint64[](3);
        a[0] = uint64(kind);
        a[1] = uint64(vid);
        a[2] = on ? 1 : 0;
        _stepOwnerV5Args(30, abi.encode(uint8(kind), _valueOf(kind, vid), on), _ownerNext(), a);
    }

    function _stepAgentKey(bool working) internal {
        bytes32 next = working ? _root(_newSeed(OWNER)) : _ownerNext();
        uint256 r = _rand(20);
        bytes32 root = r == 0 ? bytes32(0) : r == 1 ? next : _root(_newSeed(AGENT));
        uint64[8] memory lives = [uint64(0), 1 hours, 3 days, 30 days, 89 days, 90 days, 90 days + 1, 100 days];
        uint64 expiry = uint64(vm.getBlockTimestamp()) + (working ? 30 days : lives[_rand(8)]);
        if (!working && _locked() && _rand(2) == 0) expiry += vault.withdrawalLock().delay;
        uint64[] memory a = new uint64[](2);
        a[0] = _id(root);
        a[1] = expiry;
        _stepOwnerV5Args(31, abi.encode(root, expiry), next, a);
    }

    /// @dev A working order: PAY to the allowed recipient, SWEEP into Spark, or REFILL from Spark.
    function _stepWorkingOrder(uint8 kind) internal {
        OstraVaultModuleV5.OrderParams memory o;
        o.kind = kind;
        o.interval = 1 hours;
        uint256 vid = 5;
        if (kind == 3) {
            vid = 1;
            o.amount = 2e9;
            o.runs = 5;
        } else {
            o.venueKind = 3;
            o.amount = kind == 1 ? 1e9 : 4e8;
            o.threshold = kind == 1 ? 0 : uint128(2 * BALANCE);
        }
        o.target = addrs[vid];
        uint64[] memory a = new uint64[](8);
        a[0] = kind;
        a[1] = o.venueKind;
        a[2] = uint64(vid);
        a[3] = uint64(o.amount);
        a[4] = uint64(o.threshold);
        a[5] = 1 hours;
        a[6] = o.runs;
        _stepOwnerV5Args(33, abi.encode(o), _root(_newSeed(OWNER)), a);
    }

    /// @dev A SWEEP or REFILL order whose threshold puts the run at the edge of its amount (one below, at, one above),
    ///      run at once.
    function _stepVenueEdge() internal {
        uint256 balance = IERC20(USDG).balanceOf(address(vault));
        OstraVaultModuleV5.OrderParams memory o;
        o.kind = _rand(2) == 0 ? 1 : 2;
        o.venueKind = 3;
        o.target = SPARK;
        o.amount = uint128(1e6 + _rand(1e9));
        o.interval = 1 hours;
        uint256 d = _rand(4);
        if (o.kind == 1) {
            if (d == 3) d = 1;
            if (balance + 1 < o.amount + d) return _stepDeposit();
            o.threshold = uint128(balance + 1 - o.amount - d);
        } else {
            // Also exactly the balance: nothing to refill.
            o.threshold = uint128(d == 3 ? balance : balance + o.amount + d - 1);
        }
        if (o.threshold == 0) o.threshold = 1;
        uint64[] memory a = new uint64[](8);
        a[0] = o.kind;
        a[1] = 3;
        a[2] = 5;
        a[3] = uint64(o.amount);
        a[4] = uint64(o.threshold);
        a[5] = 1 hours;
        _stepOwnerV5Args(33, abi.encode(o), _root(_newSeed(OWNER)), a);
        _runOrder(vault.orderCount());
    }

    /// @dev A PAY order that ends in an hour, run exactly then (the end is exclusive).
    function _stepEndEdge() internal {
        OstraVaultModuleV5.OrderParams memory o;
        o.kind = 3;
        o.target = addrs[1];
        o.amount = 1e6;
        o.interval = 1 hours;
        o.runs = 2;
        o.endAt = uint64(vm.getBlockTimestamp() + 1 hours);
        uint64[] memory a = new uint64[](8);
        a[0] = 3;
        a[2] = 1;
        a[3] = 1e6;
        a[5] = 1 hours;
        a[6] = 2;
        a[7] = o.endAt;
        _stepOwnerV5Args(33, abi.encode(o), _root(_newSeed(OWNER)), a);
        uint64 dt = _rand(2) == 0 ? 1 hours : 1 hours - 1;
        vm.warp(vm.getBlockTimestamp() + dt);
        _record(1, _args1(dt), 0);
        _runOrder(vault.orderCount());
    }

    /// @dev The owner's PriorsConsent: for the agent this vault registered or another's, a sponsor of the allowlist or
    ///      not, a premium within the policy or not, a deadline in or out of bounds.
    function _stepConsent() internal {
        bool owns = _rand(5) != 0;
        uint256 agentId = owns ? ownAgentId : foreignAgentId;
        uint256 vid = _rand(2) == 0 ? 2 : _rand(6);
        uint256 sponsorId = vid == 0 ? 999_999 : uint256(uint160(addrs[vid]));
        // Mostly a sponsor of the allowlist.
        if (vid != 0 && _rand(3) != 0) {
            (bool inForce,) = vault.allowEntry(5, _valueOf(5, vid));
            if (!inForce) _stepAllow(5, vid, true);
        }
        uint256 maxPremiumBps = _rand(250);
        uint256 from = vm.getBlockTimestamp() + (_locked() ? vault.withdrawalLock().delay : 0);
        uint256[5] memory after_ = [uint256(0), 1, 1 days, 20 days, 31 days];
        uint256 deadline = from + after_[_rand(5)];
        bytes32 next = _ownerNext();
        uint64[] memory a = new uint64[](5);
        a[0] = _id(next);
        a[1] = owns ? 1 : 0;
        a[2] = uint64(vid);
        a[3] = uint64(maxPremiumBps);
        a[4] = uint64(deadline);
        _record(13, a, _ownerSpend(37, abi.encode(agentId, sponsorId, maxPremiumBps, deadline), next));
        // Under the lock the consent waits: often cancel it right away (the owner's cancel, or a guardian's).
        if (_locked() && _rand(2) == 0) {
            if (_rand(2) == 0) _stepCancelPending();
            else _stepGuard(0);
        }
    }

    function _stepOwnerOrder() internal {
        (OstraVaultModuleV5.OrderParams memory o, uint64[] memory a) = _randomOrder();
        _stepOwnerV5Args(33, abi.encode(o), _ownerNext(), a);
    }

    function _stepOwnerV5(uint8 action, bytes memory params, bytes32 next) internal {
        uint64[] memory a;
        if (action == 34) a = _args1(uint64(abi.decode(params, (uint256))));
        else a = new uint64[](0);
        _stepOwnerV5Args(action, params, next, a);
    }

    function _stepOwnerV5Args(uint8 action, bytes memory params, bytes32 next, uint64[] memory a) internal {
        uint64[] memory args = new uint64[](a.length + 2);
        args[0] = _id(next);
        args[1] = action;
        for (uint256 i = 0; i < a.length; ++i) {
            args[i + 2] = a[i];
        }
        _record(2, args, _ownerSpend(action, params, next));
    }

    function _stepLockOn() internal {
        if (_locked()) return _stepWarp();
        uint32[5] memory delays = [uint32(36 hours), 3 days, 14 days, 14 days + 1, 1 hours];
        uint32 delay = delays[_rand(5)];
        bytes32 next = _ownerNext();
        uint64[] memory a = new uint64[](2);
        a[0] = _id(next);
        a[1] = delay;
        _record(3, a, _ownerSpend(14, abi.encode(withdrawal, delay, type(uint128).max), next));
    }

    function _stepCancelPending() internal {
        bytes32 next = _ownerNext();
        _record(4, _args1(_id(next)), _ownerSpend(15, "", next));
    }

    function _stepAgentTransfer() internal {
        // Mostly the recipient a working start allows.
        uint256 vid = _rand(12);
        if (vid > 5) vid = vid == 11 ? ADDR_SELF : vid == 10 ? 0 : 1;
        (OstraVaultV5.Policy memory p,,) = vault.policy();
        uint256 amount;
        uint256 r = _rand(6);
        if (r == 0) amount = 0;
        else if (r == 1) amount = uint256(p.perTx) + 1;
        else if (r == 2) amount = p.perTx;
        else amount = 1 + _rand(p.perTx == 0 ? 1e9 : p.perTx);
        if (amount >= 2 ** 63) amount = 2 ** 63;
        uint64[] memory a = new uint64[](2);
        a[0] = uint64(vid);
        a[1] = uint64(amount);
        _stepAgent(0, abi.encode(addrs[vid], amount), a);
    }

    function _stepAgentOrder() internal {
        (OstraVaultModuleV5.OrderParams memory o, uint64[] memory a) = _randomOrder();
        _stepAgent(33, abi.encode(o), a);
    }

    function _stepAgentCancel() internal {
        uint256 id = _rand(vault.orderCount() + 2);
        _stepAgent(34, abi.encode(id), _args1(uint64(id)));
    }

    function _stepAgentForbidden() internal {
        uint256 r = _rand(6);
        if (r == 0) _stepAgent(29, abi.encode(_workingPolicy()), new uint64[](0));
        else if (r == 1) _stepAgent(30, abi.encode(uint8(1), _value(3), true), new uint64[](0));
        else if (r == 2) _stepAgent(31, abi.encode(_root(_newSeed(AGENT)), uint64(vm.getBlockTimestamp() + 1 days)), new uint64[](0));
        else if (r == 3) _stepAgent(6, abi.encode(STRANGER, true), new uint64[](0));
        else if (r == 4) _stepAgent(14, abi.encode(address(0), uint32(0), uint128(0)), new uint64[](0));
        else _stepAgent(15, "", new uint64[](0));
    }

    /// @dev An agent spend: signed by the agent key in force (mostly), a stale key or the owner's.
    function _stepAgent(uint8 action, bytes memory params, uint64[] memory a) internal {
        (bytes32 current,,,,) = vault.agentKey();
        bytes32 signerSeed;
        uint256 r = _rand(10);
        if (r < 8 && current != bytes32(0)) signerSeed = seedOf[current];
        else if (r < 9) signerSeed = seedOf[vault.keyRoot()];
        else signerSeed = WotsSigner.deriveSeed(MASTER, AGENT, uint64(_rand(seedCount + 1)));
        bytes32 signer = _root(signerSeed);
        r = _rand(20);
        bytes32 next = r == 0 ? signer : r == 1 ? vault.keyRoot() : r == 2 ? bytes32(0) : _root(_newSeed(AGENT));
        bytes memory sig = WotsSigner.sign(signerSeed, vault.agentSpendMessage(action, next, params));
        uint64[] memory args = new uint64[](a.length + 3);
        args[0] = _id(signer);
        args[1] = _id(next);
        args[2] = action;
        for (uint256 i = 0; i < a.length; ++i) {
            args[i + 3] = a[i];
        }
        (bool ok, bytes memory ret) =
            address(vault).call(abi.encodeCall(OstraVault.spendAsAgent, (action, next, params, sig)));
        _record(5, args, ok ? 0 : _outcome(ret));
    }

    function _stepRunOrder() internal {
        uint256 count = vault.orderCount();
        uint256 id = _rand(count + 2);
        // Mostly an order that can run, any of them alike.
        if (_rand(4) != 0) {
            uint256[] memory live = new uint256[](count);
            uint256 n;
            for (uint256 k = 1; k <= count; ++k) {
                (, bool isLive) = vault.order(k);
                if (isLive) live[n++] = k;
            }
            if (n != 0) id = live[_rand(n)];
        }
        _runOrder(id);
    }

    /// @dev Runs order `id` and records what it moved (OrderRan's amount); for a run that fails, 1 when the vault holds
    ///      nothing in the order's venue (a REFILL's exit then refuses with NothingToDo, apart from version 5's checks).
    function _runOrder(uint256 id) internal {
        (OstraVaultV5.Order memory o,) = vault.order(id);
        bool empty = o.target == SPARK && IERC20(SPARK).balanceOf(address(vault)) == 0;
        vm.recordLogs();
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(OstraVault.runOrder, (id)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint64 moved;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == OstraVaultModuleV5.OrderRan.selector) {
                moved = _u64(abi.decode(logs[i].data, (uint256)));
            }
        }
        _recordMoved(6, _args1(uint64(id)), ok ? 0 : _outcome(ret), ok ? moved : (empty ? 1 : 0));
    }

    function _stepGuard(uint8 op) internal {
        bool authorized = _rand(4) != 0;
        vm.prank(authorized ? (_rand(2) == 0 ? GUARDIAN : withdrawal) : STRANGER);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(OstraVault.guard, (op, bytes(""))));
        _record(op == 7 ? 7 : 8, _args1(authorized ? 1 : 0), ok ? 0 : _outcome(ret));
    }

    function _stepRecovery() internal {
        bytes32 root = _root(_newSeed(OWNER));
        uint64[] memory a = new uint64[](2);
        a[0] = _id(root);
        a[1] = 36 hours;
        vm.prank(GUARDIAN);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(OstraVault.supportRecovery, (root)));
        _record(9, a, ok ? 0 : _outcome(ret));
    }

    function _stepFinishRecovery() internal {
        // Mostly once the delay is over, when a recovery is under way; without one, mostly something else.
        (uint32 round, uint64 executableAt,) = vault.pendingRecovery();
        if ((executableAt == 0 || round != vault.recoveryRound()) && _rand(4) != 0) return _stepRecovery();
        if (executableAt != 0 && round == vault.recoveryRound() && vm.getBlockTimestamp() < executableAt && _rand(4) != 0) {
            // Or one second short of it.
            uint64 at = _rand(3) == 0 ? executableAt - 1 : executableAt;
            uint64 dt = at - uint64(vm.getBlockTimestamp());
            vm.warp(at);
            _record(1, _args1(dt), 0);
        }
        vm.prank(STRANGER);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(OstraVault.finishRecovery, ()));
        _record(10, new uint64[](0), ok ? 0 : _outcome(ret));
    }

    /// @dev Tokens arrive (or the balance is set) from outside version 5.
    function _stepDeposit() internal {
        uint256 b = _rand(3) == 0 ? _rand(1e9) : 1e14 + _rand(2e15);
        deal(USDG, address(vault), b);
        _record(11, _args1(uint64(b)), 0);
    }

    /// @dev An owner spend outside version 5: a Transfer of the owner's own, which the agent's budget never counts.
    function _stepOwnerOther() internal {
        uint256 balance = IERC20(USDG).balanceOf(address(vault));
        if (balance == 0) return _stepDeposit();
        uint256 amount = 1 + _rand(balance < 1e9 ? balance : 1e9);
        bytes32 next = _ownerNext();
        uint64 outcome = _ownerSpend(0, abi.encode(STRANGER, amount), next);
        uint64[] memory a = new uint64[](2);
        a[0] = _id(next);
        a[1] = _u64(IERC20(USDG).balanceOf(address(vault)));
        _record(12, a, outcome);
    }

    /// @dev The agent key's other actions, with what _agentAmount reads of them; their own code runs against live
    ///      contracts (or refuses).
    function _stepAgentOther() internal {
        (OstraVaultV5.Policy memory p,,) = vault.policy();
        uint256 vid = 1 + _rand(5);
        uint256 amount = 1 + _rand(p.perTx == 0 ? 1e9 : p.perTx);
        if (amount >= 2 ** 63) amount = 2 ** 63;
        uint64[] memory a = new uint64[](5);
        a[1] = uint64(vid);
        a[2] = uint64(amount);
        uint256 r = _rand(9);
        if (r == 0) {
            _stepAgent(1, abi.encode(STRANGER, addrs[vid], address(0), uint40(1 days), bytes32(0), uint128(amount)), a);
        } else if (r == 1) {
            uint256 to = _rand(3) == 0 ? ADDR_SELF : 1 + _rand(5);
            a[0] = uint64(to);
            a[1] = vid == 5 ? 5 : 0;
            (address c0, address c1) = vid == 5 ? (USDG, OTHER_CURRENCY) : (USDG, address(0xBAD));
            _stepAgent(
                3,
                abi.encode(c0, c1, uint24(3000), int24(60), address(0), true, uint128(amount), uint128(0), addrs[to], address(0), uint32(300_000)),
                a
            );
        } else if (r == 2) {
            // Not the zero address, which the dividend claim's own code refuses (BadParams) after version 5's checks.
            uint256 to = _rand(3) == 0 ? ADDR_SELF : _rand(2) == 0 ? 4 : 1 + _rand(5);
            a[0] = uint64(to);
            _stepAgent(5, abi.encode(addrs[to]), a);
        } else if (r == 3) {
            _stepAgent(_rand(2) == 0 ? 17 : 18, abi.encode(addrs[vid], uint256(amount), uint256(0)), a);
        } else if (r == 4) {
            uint256 to = _rand(3) == 0 ? 0 : _rand(2) == 0 ? 4 : 1 + _rand(5);
            a[0] = uint64(to);
            _stepAgent(
                22,
                abi.encode(address(0), address(0), address(0), address(0), uint256(0), uint256(0), uint256(0), addrs[to], uint256(amount)),
                a
            );
        } else if (r == 5) {
            uint256 term = _rand(400 days);
            uint256 maxFee = _rand(1e9);
            uint256 cap = amount * p.maxFeeBps * term / (10_000 * 30 days);
            a[3] = uint64(maxFee < cap ? maxFee : cap);
            bytes32[8] memory jobs;
            _stepAgent(35, abi.encode(uint256(1), amount, uint64(term), maxFee, jobs), a);
        } else if (r == 6) {
            // A line from a root to an agent of the allowlist (the model's id) or to an agent it does not name (id 0).
            if (amount > 2 ** 60) amount = 2 ** 60;
            a[2] = uint64(amount);
            uint256 agentId = _rand(3) == 0 ? 999_999 : uint256(uint160(addrs[vid]));
            if (agentId == 999_999) a[1] = 0;
            try IPriorsPool(PRIORS_POOL).getAgent(agentId) returns (IPriorsPool.Agent memory g) {
                IPriorsPool.Params memory pp = IPriorsPool(PRIORS_POOL).getParams();
                uint256 cost = amount + amount * (pp.feeBps + g.premiumBps) * pp.maxTerm / (10_000 * 30 days);
                a[3] = _u64(cost);
                _stepAgent(42, abi.encode(uint256(1), agentId, amount), a);
            } catch {
                _stepWarp();
            }
        } else if (r == 7) {
            bool frozen_ = _rand(2) == 0;
            a[4] = frozen_ ? 1 : 0;
            _stepAgent(44, abi.encode(uint256(uint160(addrs[vid])), frozen_), a);
        } else {
            // An action above the last: BadAction before anything else.
            _stepAgent(uint8(47 + _rand(10)), "", new uint64[](0));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Random parameters
    // ---------------------------------------------------------------------------------------------

    /// @dev Every action the agent key may have, so that a working start reaches each action's own checks.
    function _workingPolicy() internal pure returns (OstraVaultV5.Policy memory p) {
        p.actions = AGENT_ACTIONS;
        p.perTx = 5e9;
        p.daily = 12e9;
        p.maxFeeBps = 500;
    }

    function _randomPolicy() internal returns (OstraVaultV5.Policy memory p) {
        (OstraVaultV5.Policy memory c,,) = vault.policy();
        if (_rand(3) == 0) {
            // One field of the policy in force moved up or down: tighter or looser under the lock.
            p = c;
            uint256 f = _rand(6);
            bool up = _rand(2) == 0;
            if (f == 0) p.actions = up ? c.actions | (uint64(1) << 3) : c.actions & ~uint64(1);
            else if (f == 1) p.perTx = up ? c.perTx + 1e6 : c.perTx / 2;
            else if (f == 2) p.daily = up ? c.daily + 1e6 : c.daily / 2;
            else if (f == 3) p.coverBps = up ? 0 : 5000;
            else if (f == 4) p.repayLead = up ? 2 days : 0;
            else p.maxPremiumBps = up ? 150 : 0;
            return p;
        }
        uint256 r = _rand(4);
        p.actions = r == 0 ? AGENT_ACTIONS : r == 1 ? uint64(_rand(2 ** 47)) & AGENT_ACTIONS : r == 2
            ? uint64(1) | (uint64(1) << 26) | (uint64(1) << 27) | (uint64(1) << 32) | (uint64(1) << 33) | (uint64(1) << 34)
            : uint64(_rand(2 ** 47));
        p.perTx = uint128(_amount());
        p.daily = uint128(_amount());
        p.maxDebt = uint128(_amount());
        p.maxTerm = uint32(_rand(400 days));
        p.maxFeeBps = uint16(_rand(11_000));
        p.coverBps = uint16(_rand(4) == 0 ? _rand(11_000) : 0);
        p.repayLead = uint32(_rand(8 days));
        r = _rand(8);
        p.repayKind = r < 5 ? 0 : r == 5 ? 1 : r == 6 ? 3 : 2;
        p.repayVenue = _rand(6) == 0 ? (p.repayKind == 0 ? addrs[1] : address(0)) : p.repayKind == 0
            ? address(0)
            : addrs[1 + _rand(5)];
        p.vouchPerAgent = uint128(_amount());
        p.vouchTotal = uint128(_amount());
        p.maxPremiumBps = uint16(_rand(250));
    }

    function _randomOrder() internal returns (OstraVaultModuleV5.OrderParams memory o, uint64[] memory a) {
        uint256 r = _rand(10);
        o.kind = r < 5 ? 3 : r < 7 ? 1 : r < 9 ? 2 : uint8(_rand(2) == 0 ? 0 : 4);
        if (o.kind == 1) o.venueKind = uint8(_rand(10) == 0 ? 4 : _rand(4) == 0 ? 1 + _rand(2) : 3);
        else if (o.kind == 2) o.venueKind = uint8(_rand(10) == 0 ? 2 : _rand(2) == 0 ? 1 : 3);
        else o.venueKind = uint8(_rand(10) == 0 ? 1 : 0);
        uint256 vid = _rand(8);
        if (vid == VALUE_WIDE) vid = 1;
        // SWEEP and REFILL mostly into Spark, so that they run.
        if ((o.kind == 1 || o.kind == 2) && _rand(4) != 0) vid = 5;
        o.target = addrs[vid];
        uint256 amounts = _rand(8);
        o.amount = uint128(amounts == 0 ? 0 : amounts < 6 ? 1 + _rand(4e9) : _amount());
        uint256[4] memory thresholds = [uint256(0), 1e14, 2e15, BALANCE];
        o.threshold = uint128(o.kind == 3 ? (_rand(10) == 0 ? 1 : 0) : thresholds[_rand(4)]);
        // SWEEP and REFILL mostly of amounts a venue takes and gives back, and a REFILL mostly with something to refill.
        if ((o.kind == 1 || o.kind == 2) && _rand(4) != 0) o.amount = uint128(1e6 + _rand(4e9));
        if (o.kind == 2 && _rand(4) != 0) o.threshold = uint128(2 * BALANCE);
        uint32[5] memory intervals = [uint32(30 minutes), 1 hours, 2 hours, 1 days, 400 days];
        o.interval = intervals[_rand(5)];
        uint32[4] memory runs = [uint32(0), 1, 2, 5];
        o.runs = o.kind == 3 ? runs[_rand(10) == 0 ? 0 : 1 + _rand(3)] : runs[_rand(10) == 0 ? 1 : 0];
        uint256 e = _rand(5);
        o.endAt = e < 3 ? 0 : e == 3 ? uint64(vm.getBlockTimestamp()) : uint64(vm.getBlockTimestamp() + 1 + _rand(10 days));
        a = new uint64[](8);
        a[0] = o.kind;
        a[1] = o.venueKind;
        a[2] = uint64(vid);
        a[3] = uint64(o.amount);
        a[4] = uint64(o.threshold);
        a[5] = o.interval;
        a[6] = o.runs;
        a[7] = o.endAt;
    }

    /// @dev Below 2^63: zero, small, around a few USDG, or very large.
    function _amount() internal returns (uint256) {
        uint256 r = _rand(5);
        if (r == 0) return 0;
        if (r == 1) return 1 + _rand(1e6);
        if (r == 2) return 1 + _rand(1e10);
        if (r == 3) return 1 + _rand(1e13);
        return 2 ** 62 + _rand(2 ** 62);
    }

    // ---------------------------------------------------------------------------------------------
    // Keys, ids, outcomes
    // ---------------------------------------------------------------------------------------------

    function _newSeed(bytes32 keychain) internal returns (bytes32 seed) {
        seed = WotsSigner.deriveSeed(MASTER, keychain, ++seedCount);
        bytes32 root = WotsSigner.keyRoot(seed);
        seedOf[root] = seed;
    }

    function _root(bytes32 seed) internal view returns (bytes32 root) {
        root = WotsSigner.keyRoot(seed);
        require(seedOf[root] == seed || seedOf[root] == bytes32(0), "seed");
    }

    /// @dev The owner's next key: a new one (mostly), zero, or the agent key's root.
    function _ownerNext() internal returns (bytes32) {
        uint256 r = _rand(40);
        if (r == 0) return bytes32(0);
        (bytes32 agentRoot,,,,) = vault.agentKey();
        if (r == 1 && agentRoot != bytes32(0)) return agentRoot;
        return _root(_newSeed(OWNER));
    }

    /// @dev An owner spend signed with the key in force.
    function _ownerSpend(uint8 action, bytes memory params, bytes32 next) internal returns (uint64) {
        bytes32 seed = seedOf[vault.keyRoot()];
        bytes memory sig = WotsSigner.sign(seed, vault.spendMessage(action, next, params));
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(OstraVault.spend, (action, next, params, sig)));
        return ok ? 0 : _outcome(ret);
    }

    function _id(bytes32 root) internal returns (uint64) {
        if (root == bytes32(0)) return 0;
        uint64 id = rootId[root];
        if (id == 0) {
            id = ++rootIds;
            rootId[root] = id;
        }
        return id;
    }

    function _value(uint256 vid) internal view returns (bytes32) {
        if (vid == VALUE_WIDE) return bytes32(type(uint256).max);
        return bytes32(uint256(uint160(addrs[vid])));
    }

    function _addrId(address a) internal view returns (uint64) {
        if (a == address(0)) return 0;
        for (uint256 i = 1; i < 8; ++i) {
            if (addrs[i] == a) return uint64(i);
        }
        revert("unknown address");
    }

    function _locked() internal view returns (bool) {
        return vault.withdrawalLock().withdrawal != address(0);
    }

    /// @dev The model's outcome code for a revert (formal/v5/model/ostra_v5_model.h).
    function _outcome(bytes memory ret) internal pure returns (uint64) {
        if (ret.length < 4) return OUTCOME_OTHER;
        bytes4 s = bytes4(ret);
        if (s == OstraVault.BadParams.selector) return 2;
        if (s == OstraVault.Locked.selector) return 3;
        if (s == OstraVaultModuleV5.NoAgentKey.selector) return 4;
        if (s == OstraVault.WotsSignatureInvalid.selector) return 5;
        if (s == OstraVaultModuleV5.NoOrder.selector) return 6;
        if (s == OstraVaultModuleV5.TooEarly.selector) return 7;
        if (s == OstraVaultModuleV5.NothingToDo.selector) return 8;
        if (s == OstraVaultV5.OverPerTx.selector) return 9;
        if (s == OstraVaultV5.OverBudget.selector) return 10;
        if (s == OstraVault.ZeroAmount.selector) return 11;
        if (s == OstraVault.NotGuardian.selector) return 12;
        if (s == OstraVaultModuleV5.NotLinked.selector) return 13;
        if (s == OstraVault.BadAction.selector) return 17;
        if (s == OstraVault.NoRecovery.selector) return 18;
        if (s == OstraVault.RecoveryNotReady.selector) return 19;
        if (s == OstraVaultModuleV5.NotOwnAgent.selector) return 20;
        if (s == OstraVaultModuleV5.OutOfPolicy.selector) return 21;
        if (s == bytes4(keccak256("Panic(uint256)")) && ret.length == 36 && uint256(bytes32(_tail(ret))) == 0x11) {
            return 15;
        }
        if (s == OstraVaultModuleV5.NotAllowed.selector && ret.length == 36) return 100 + uint64(uint256(bytes32(_tail(ret))));
        if (s == OstraVaultModuleV5.NotAllowlisted.selector && ret.length == 36) {
            return 400 + uint64(uint256(bytes32(_tail(ret))));
        }
        return OUTCOME_OTHER;
    }

    function _tail(bytes memory ret) internal pure returns (bytes memory t) {
        t = new bytes(32);
        for (uint256 i = 0; i < 32; ++i) {
            t[i] = ret[4 + i];
        }
    }

    // ---------------------------------------------------------------------------------------------
    // The trace
    // ---------------------------------------------------------------------------------------------

    function _record(uint64 op, uint64[] memory args, uint64 outcome) internal {
        _recordMoved(op, args, outcome, 0);
    }

    function _recordMoved(uint64 op, uint64[] memory args, uint64 outcome, uint64 moved) internal {
        _word(op);
        _word(uint64(args.length));
        for (uint256 i = 0; i < args.length; ++i) {
            _word(args[i]);
        }
        _word(outcome);
        _word(moved);
        uint64[] memory snap = _snapshot();
        _word(uint64(snap.length));
        for (uint256 i = 0; i < snap.length; ++i) {
            _word(snap[i]);
        }
    }

    function _snapshot() internal returns (uint64[] memory out) {
        uint256 orders = vault.orderCount();
        out = new uint64[](175 + 12 * orders);
        uint256 n;
        out[n++] = uint64(vm.getBlockTimestamp());
        out[n++] = _u64(IERC20(USDG).balanceOf(address(vault)));
        out[n++] = vault.nonce();
        out[n++] = _id(vault.keyRoot());
        {
            (bytes32 root, uint64 agentNonce, uint64 from, uint64 expiry, bool inForce) = vault.agentKey();
            out[n++] = _id(root);
            out[n++] = agentNonce;
            out[n++] = from;
            out[n++] = expiry;
            out[n++] = inForce ? 1 : 0;
        }
        {
            (OstraVaultV5.Policy memory inForce, OstraVaultV5.Policy memory pending, uint64 pendingAt) = vault.policy();
            n = _putPolicy(out, n, inForce);
            n = _putPolicy(out, n, pending);
            out[n++] = pendingAt;
        }
        out[n++] = _u64(vault.budgetAvailable());
        out[n++] = uint64(orders);
        for (uint256 id = 1; id <= orders; ++id) {
            n = _putOrder(out, n, id);
        }
        for (uint256 kind = 1; kind <= 6; ++kind) {
            for (uint256 vid = 1; vid < 8; ++vid) {
                (bool inForce, uint64 from) = vault.allowEntry(uint8(kind), _valueOf(kind, vid));
                out[n++] = inForce ? 1 : 0;
                out[n++] = from;
                // The layout read below must agree with the view.
                require(uint64(_allowSlot(kind, vid)) == from, "allow slot layout");
            }
        }
        out[n++] = _locked() ? 1 : 0;
        n = _putStorage(out, n, orders);
        {
            (uint32 round, uint64 executableAt,) = vault.pendingRecovery();
            out[n++] = executableAt != 0 && round == vault.recoveryRound() ? 1 : 0;
        }
        out[n++] = _locked() ? vault.withdrawalLock().delay : 0;
        out[n++] = _addrId(vault.linkedVault());
        require(n == out.length, "snapshot length");
    }

    /// @dev OstraVaultV5.Layout from its slot: S+14 pendingPolicyAt, budgetAt, budgetUsed; S+15 allows; S+16 epoch,
    ///      waitingUntil; S+19 orderCount, orderEpoch; S+21 agentGen; S+23 pendingConsentAt.
    function _putStorage(uint64[] memory out, uint256 n, uint256 orders) internal view returns (uint256) {
        uint256 w14 = uint256(vm.load(address(vault), bytes32(SLOT + 14)));
        out[n++] = _u64(w14 >> 128);
        out[n++] = uint64(w14 >> 64);
        uint256 w19 = uint256(vm.load(address(vault), bytes32(SLOT + 19)));
        require(uint64(w19) == orders, "order slot layout");
        out[n++] = uint64(w19 >> 64);
        out[n++] = uint32(uint256(vm.load(address(vault), bytes32(SLOT + 21))));
        uint256 w16 = uint256(vm.load(address(vault), bytes32(SLOT + 16)));
        out[n++] = uint64(w16);
        out[n++] = uint64(w16 >> 64);
        out[n++] = uint64(uint256(vm.load(address(vault), bytes32(SLOT + 23))));
        for (uint256 kind = 1; kind <= 6; ++kind) {
            for (uint256 vid = 1; vid < 8; ++vid) {
                out[n++] = uint64(_allowSlot(kind, vid) >> 64);
            }
        }
        return n;
    }

    function _allowSlot(uint256 kind, uint256 vid) internal view returns (uint256) {
        bytes32 key = keccak256(abi.encode(uint8(kind), _valueOf(kind, vid)));
        return uint256(vm.load(address(vault), keccak256(abi.encode(key, SLOT + 15))));
    }

    /// @dev The allowlist value of an id: the pool kind's id 5 is the PoolId of the test's pool key.
    function _valueOf(uint256 kind, uint256 vid) internal view returns (bytes32) {
        if (kind == 3 && vid == 5) {
            return keccak256(abi.encode(USDG, OTHER_CURRENCY, uint24(3000), int24(60), address(0)));
        }
        return _value(vid);
    }

    function _putPolicy(uint64[] memory out, uint256 n, OstraVaultV5.Policy memory p) internal view returns (uint256) {
        out[n++] = p.actions;
        out[n++] = _u64(p.perTx);
        out[n++] = _u64(p.daily);
        out[n++] = _u64(p.maxDebt);
        out[n++] = p.maxTerm;
        out[n++] = p.maxFeeBps;
        out[n++] = p.coverBps;
        out[n++] = p.repayLead;
        out[n++] = p.repayKind;
        out[n++] = _addrId(p.repayVenue);
        out[n++] = _u64(p.vouchPerAgent);
        out[n++] = _u64(p.vouchTotal);
        out[n++] = p.maxPremiumBps;
        return n;
    }

    function _putOrder(uint64[] memory out, uint256 n, uint256 id) internal view returns (uint256) {
        (OstraVaultV5.Order memory o, bool live) = vault.order(id);
        out[n++] = o.kind;
        out[n++] = o.venueKind;
        out[n++] = o.interval;
        out[n++] = o.runsLeft;
        out[n++] = o.lastRun;
        out[n++] = o.endAt;
        out[n++] = o.epoch;
        out[n++] = _addrId(o.target);
        out[n++] = o.agentGen;
        out[n++] = _u64(o.amount);
        out[n++] = _u64(o.threshold);
        out[n++] = live ? 1 : 0;
        return n;
    }

    function _u64(uint256 x) internal pure returns (uint64) {
        require(x <= type(uint64).max, "beyond the model's 64 bits");
        return uint64(x);
    }

    function _args1(uint64 x) internal pure returns (uint64[] memory a) {
        a = new uint64[](1);
        a[0] = x;
    }

    function _word(uint64 w) internal {
        words.push(w);
    }

    function _rand(uint256 n) internal returns (uint256) {
        rng = uint256(keccak256(abi.encode(rng)));
        return n == 0 ? 0 : rng % n;
    }

    /// @dev The replay program and the trace in hex, cut into arguments below the kernel's limit for one.
    function _replayCommand() internal view returns (string[] memory cmd) {
        uint256 chunk = 6000;
        uint256 total = words.length;
        uint256 parts = (total + chunk - 1) / chunk;
        cmd = new string[](parts + 1);
        cmd[0] = vm.envString("OSTRA_MODEL_REPLAY");
        for (uint256 i = 0; i < parts; ++i) {
            uint256 end = (i + 1) * chunk > total ? total : (i + 1) * chunk;
            bytes memory part = new bytes((end - i * chunk) * 8);
            for (uint256 k = i * chunk; k < end; ++k) {
                uint256 at = (k - i * chunk) * 8;
                uint64 w = words[k];
                for (uint256 b = 0; b < 8; ++b) {
                    part[at + b] = bytes1(uint8(w >> (56 - 8 * b)));
                }
            }
            cmd[i + 1] = vm.toString(part);
        }
    }

    function _prefix(bytes memory b, uint256 n) internal pure returns (string memory) {
        if (b.length < n) return string(b);
        bytes memory p = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            p[i] = b[i];
        }
        return string(p);
    }
}
