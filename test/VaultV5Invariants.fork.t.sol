// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OstraRegistry} from "../src/OstraRegistry.sol";
import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraVaultModuleV5} from "../src/OstraVaultModuleV5.sol";
import {OstraVaultV5} from "../src/OstraVaultV5.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";
import {VaultStack} from "./utils/VaultStack.sol";
import {SafeWallet} from "./utils/SafeWallet.sol";

/// @notice Drives one vault with an agent key, a policy, a PAY order and a withdrawal lock through random agent
///         transfers, order runs, owner spends and time, and logs every outflow the agent key and the order made.
contract V5Handler is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant OWNER = keccak256("OSTRA/EVM/TEST/v5-inv-owner");
    bytes32 internal constant AGENT = keccak256("OSTRA/EVM/TEST/v5-inv-agent");
    address internal constant PAYEE = address(0xBEEF01);
    address internal constant OTHER = address(0xBEEF02);

    OstraVault public immutable vault;
    uint128 public immutable perTx;
    uint128 public immutable daily;
    uint128 public immutable lockLimit;

    uint256[] public at;
    uint256[] public amounts;
    uint256 public refusedOverPolicy;

    constructor(OstraVault v, uint128 perTx_, uint128 daily_, uint128 lockLimit_) {
        vault = v;
        perTx = perTx_;
        daily = daily_;
        lockLimit = lockLimit_;
    }

    function count() external view returns (uint256) {
        return at.length;
    }

    function _seed(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keychain, index);
    }

    /// @dev An agent transfer to the allowed payee (or, one time in four, to a recipient not on the list).
    function agentTransfer(uint256 amount, uint8 who) external {
        amount = bound(amount, 1, uint256(daily) * 2);
        address to = who % 4 == 0 ? OTHER : PAYEE;
        bytes memory params = abi.encode(to, amount);
        (, uint64 n,,,) = vault.agentKey();
        bytes32 next = WotsSigner.keyRoot(_seed(AGENT, n + 1));
        bytes memory sig = WotsSigner.sign(_seed(AGENT, n), vault.agentSpendMessage(0, next, params));
        uint256 before = IERC20(USDG).balanceOf(to);
        try vault.spendAsAgent(0, next, params, sig) {
            assertEq(to, PAYEE, "only an allowed recipient is paid");
            assertEq(IERC20(USDG).balanceOf(to), before + amount);
            at.push(block.timestamp);
            amounts.push(amount);
        } catch {
            ++refusedOverPolicy;
        }
    }

    function runPay() external {
        uint256 before = IERC20(USDG).balanceOf(PAYEE);
        try vault.runOrder(1) {
            at.push(block.timestamp);
            amounts.push(IERC20(USDG).balanceOf(PAYEE) - before);
        } catch {}
    }

    /// @dev The owner's own transfer: it counts against the lock, never against the agent's budget.
    function ownerTransfer(uint256 amount) external {
        amount = bound(amount, 1, lockLimit);
        bytes memory params = abi.encode(OTHER, amount);
        uint64 n = vault.nonce();
        bytes32 next = WotsSigner.keyRoot(_seed(OWNER, n + 1));
        bytes memory sig = WotsSigner.sign(_seed(OWNER, n), vault.spendMessage(0, next, params));
        try vault.spend(0, next, params, sig) {} catch {}
    }

    function wait(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 12 hours));
    }
}

/// @notice Whatever the order of agent spends, order runs, owner spends and time: no agent spend or order run moves more
///         than the policy's per-spend bound, no 24 hours see more than twice its daily bound (the budget drains at
///         that rate, as the lock's limit does), never more than the lock allows, only to allowed recipients; and a
///         guardian can always end the agent key and the order.
contract VaultV5InvariantsForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant OWNER = keccak256("OSTRA/EVM/TEST/v5-inv-owner");
    bytes32 internal constant AGENT = keccak256("OSTRA/EVM/TEST/v5-inv-agent");
    address internal constant PAYEE = address(0xBEEF01);
    address internal constant GUARDIAN = address(0x6A2D);
    /// @dev The withdrawal address: a real Safe (version 5 refuses one with no code), made in setUp.
    address internal WITHDRAWAL;
    uint128 internal constant PER_TX = 3e6;
    uint128 internal constant DAILY = 7e6;
    uint128 internal constant LOCK_LIMIT = 9e6;

    OstraVault internal vault;
    V5Handler internal handler;
    uint256 internal lockStart;

    function _seed(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keychain, index);
    }

    function _spend(bytes32 keychain, uint8 action, bytes memory params) internal {
        uint64 n = vault.nonce();
        bytes32 next = WotsSigner.keyRoot(_seed(keychain, n + 1));
        vault.spend(action, next, params, WotsSigner.sign(_seed(keychain, n), vault.spendMessage(action, next, params)));
    }

    function setUp() public {
        vm.createSelectFork("robinhood");
        WITHDRAWAL = SafeWallet.create(makeAddr("withdrawal owner"), 1);
        (OstraVaultFactory factory,) = VaultStack.deploy(address(new OstraRegistry()));
        vault = OstraVault(factory.createVault(USDG, WotsSigner.keyRoot(_seed(OWNER, 0)), address(0)));
        deal(USDG, address(vault), 1_000e6);
        OstraVaultV5.Policy memory p;
        p.actions = 1;
        p.perTx = PER_TX;
        p.daily = DAILY;
        _spend(OWNER, 29, abi.encode(p));
        _spend(OWNER, 30, abi.encode(uint8(1), bytes32(uint256(uint160(PAYEE))), true));
        _spend(OWNER, 31, abi.encode(WotsSigner.keyRoot(_seed(AGENT, 1)), uint64(block.timestamp + 90 days)));
        OstraVaultModuleV5.OrderParams memory o;
        o.kind = 3;
        o.target = PAYEE;
        o.amount = 2e6;
        o.interval = 1 hours;
        o.runs = type(uint32).max;
        _spend(OWNER, 33, abi.encode(o));
        _spend(OWNER, 6, abi.encode(GUARDIAN, true));
        _spend(OWNER, 14, abi.encode(WITHDRAWAL, uint32(36 hours), LOCK_LIMIT));
        lockStart = block.timestamp;
        handler = new V5Handler(vault, PER_TX, DAILY, LOCK_LIMIT);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 40
    function invariant_agentAndOrderOutflowStaysWithinThePolicy() public view {
        uint256 n = handler.count();
        for (uint256 i = 0; i < n; ++i) {
            assertLe(handler.amounts(i), PER_TX, "per spend");
            uint256 sum;
            for (uint256 k = 0; k <= i; ++k) {
                if (handler.at(k) + 1 days > handler.at(i)) sum += handler.amounts(k);
            }
            assertLe(sum, 2 * uint256(DAILY), "24 hours");
            assertLe(sum, 2 * uint256(LOCK_LIMIT), "lock");
        }
        assertLe(vault.budgetAvailable(), DAILY);
        assertLe(vault.outflowAvailable(), LOCK_LIMIT);
    }

    /// @dev The runs did move money through the agent key and the order, and saw refusals: the bounds were reached.
    function afterInvariant() public view {
        assertGt(handler.count(), 0, "some outflow happened");
        assertGt(handler.refusedOverPolicy(), 0, "some agent spend was refused");
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 40
    function invariant_aGuardianCanAlwaysEndTheAgentAndTheOrder() public {
        uint256 snap = vm.snapshotState();
        vm.prank(GUARDIAN);
        vault.guard(7, "");
        (,,,, bool inForce) = vault.agentKey();
        assertFalse(inForce);
        (, bool live) = vault.order(1);
        assertFalse(live);
        // And send the whole balance to the withdrawal address.
        uint256 all = IERC20(USDG).balanceOf(address(vault));
        uint256 had = IERC20(USDG).balanceOf(WITHDRAWAL);
        vm.prank(GUARDIAN);
        vault.guard(2, abi.encode(WITHDRAWAL));
        assertEq(IERC20(USDG).balanceOf(WITHDRAWAL), had + all);
        vm.revertToState(snap);
    }
}
