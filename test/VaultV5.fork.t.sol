// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraRegistry} from "../src/OstraRegistry.sol";
import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraVaultModuleV4, IERC4626Venue} from "../src/OstraVaultModuleV4.sol";
import {IOstraPadJobs, IPriorsPool, OstraVaultModuleV5} from "../src/OstraVaultModuleV5.sol";
import {OstraVaultV3} from "../src/OstraVaultV3.sol";
import {OstraVaultV5} from "../src/OstraVaultV5.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";
import {VaultStack} from "./utils/VaultStack.sol";
import {SafeWallet} from "./utils/SafeWallet.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice What the tests call on OstraPad to make a real job for a vault (OstraPad.create, accept, actionDigest).
interface IOstraPadTest {
    struct Terms {
        address client;
        address provider;
        address evaluator;
        uint256 budget;
        bytes32 description;
        bytes32 clientCommit;
        bytes32 salt;
    }

    function create(Terms calldata t) external returns (bytes32 id);
    function accept(bytes32 id, bytes32 providerCommit) external;
    function actionDigest(bytes32 action) external view returns (bytes32);
    function jobId(Terms calldata t) external pure returns (bytes32);
}

interface IERC721Like {
    function ownerOf(uint256 id) external view returns (address);
    function transferFrom(address from, address to, uint256 id) external;
}

/// @notice OstraVault version 5 on a fork of Robinhood Chain mainnet: the agent key, its policy and allowlists, standing
///         orders, and Priors credit against the deployed CreditPoolV2, OstraPad, Spark Savings USDG and the ERC-8004
///         Identity Registry, each running its own deployed code.
contract VaultV5ForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant SPARK = 0xde770c84FE66E063336b31737cFE9790f18c4087;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant POOL = 0x281210097f0de7A8FB6F87310AF0f089c9C8DE21;
    address internal constant PAD = 0x1BE28c4F08a548598fE0AA9b16DFD564C82E8055;

    uint8 internal constant K_ERC4626 = 3;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant OWNER = keccak256("OSTRA/EVM/TEST/v5-owner");
    bytes32 internal constant AGENT = keccak256("OSTRA/EVM/TEST/v5-agent");
    bytes32 internal constant ROOT_OWNER = keccak256("OSTRA/EVM/TEST/v5-root-owner");
    bytes32 internal constant GUARD_VAULT = keccak256("OSTRA/EVM/TEST/v5-guard-vault");
    /// @dev The withdrawal address: a real Safe (version 5 refuses one with no code), made in setUp.
    address internal WITHDRAWAL;
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant SUBMITTER = address(0x5EB);
    address internal constant PAYEE = address(0xBEEF);
    address internal constant STRANGER = address(0x5757);
    uint32 internal constant DELAY = 36 hours;

    OstraVaultFactory internal factory;
    OstraVaultModuleV5 internal m5;

    function setUp() public {
        vm.createSelectFork("robinhood");
        WITHDRAWAL = SafeWallet.create(makeAddr("withdrawal owner"), 1);
        assertEq(block.chainid, 4663);
        OstraRegistry registry = new OstraRegistry();
        (factory,) = VaultStack.deploy(address(registry));
        OstraVault implementation = OstraVault(UpgradeableBeacon(factory.BEACON()).implementation());
        assertEq(implementation.VERSION(), 5);
        m5 = OstraVaultModuleV5(implementation.MODULE_V5());
        assertEq(address(m5.FACTORY()), address(factory));
        assertEq(m5.MODULE_V4(), implementation.MODULE_V4());
        assertEq(address(m5.POOL()), POOL);
        assertEq(m5.POOL_CODEHASH(), POOL.codehash);
        assertEq(address(m5.PAD()), PAD);
        assertEq(IERC4626Venue(SPARK).asset(), USDG);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _seed(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keychain, index);
    }

    function _vault(bytes32 keychain) internal returns (OstraVault) {
        return OstraVault(factory.createVault(USDG, WotsSigner.keyRoot(_seed(keychain, 0)), address(0)));
    }

    function _signed(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params)
        internal
        view
        returns (bytes32 next, bytes memory signature)
    {
        uint64 n = vault.nonce();
        next = WotsSigner.keyRoot(_seed(keychain, n + 1));
        signature = WotsSigner.sign(_seed(keychain, n), vault.spendMessage(action, next, params));
    }

    function _spend(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        (bytes32 next, bytes memory signature) = _signed(vault, keychain, action, params);
        vm.prank(SUBMITTER, SUBMITTER);
        vault.spend(action, next, params, signature);
    }

    function _refused(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params, bytes memory err)
        internal
    {
        (bytes32 next, bytes memory signature) = _signed(vault, keychain, action, params);
        uint64 n = vault.nonce();
        vm.expectRevert(err);
        vm.prank(SUBMITTER, SUBMITTER);
        vault.spend(action, next, params, signature);
        assertEq(vault.nonce(), n, "a refused spend keeps its key");
    }

    /// @dev An owner Priors spend (35 to 46) that fails: it lands (the key moves on), moves nothing and says why
    ///      (PriorsFailed), so that no other party can hold the owner's key by making it fail.
    function _failed(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params, bytes memory err) internal {
        uint64 n = vault.nonce();
        vm.expectEmit(address(vault));
        emit OstraVaultModuleV5.PriorsFailed(action, bytes4(err));
        _spend(vault, keychain, action, params);
        assertEq(vault.nonce(), n + 1, "a failed Priors spend lands");
    }

    function _agentNonce(OstraVault vault) internal view returns (uint64 n) {
        (, n,,,) = vault.agentKey();
    }

    /// @dev The agent key for agent nonce `n` is AGENT's seed `n`: SetAgentKey moves the nonce on by one, so the key it
    ///      installs is the seed of the nonce after it.
    function _setAgent(OstraVault vault, bytes32 keychain, uint64 life) internal {
        bytes32 root = WotsSigner.keyRoot(_seed(AGENT, _agentNonce(vault) + 1));
        _spend(vault, keychain, 31, abi.encode(root, uint64(block.timestamp) + life));
    }

    function _agentSigned(OstraVault vault, uint8 action, bytes memory params)
        internal
        view
        returns (bytes32 next, bytes memory signature)
    {
        uint64 n = _agentNonce(vault);
        next = WotsSigner.keyRoot(_seed(AGENT, n + 1));
        signature = WotsSigner.sign(_seed(AGENT, n), vault.agentSpendMessage(action, next, params));
    }

    function _agent(OstraVault vault, uint8 action, bytes memory params) internal {
        (bytes32 next, bytes memory signature) = _agentSigned(vault, action, params);
        vm.prank(SUBMITTER, SUBMITTER);
        vault.spendAsAgent(action, next, params, signature);
    }

    function _agentRefused(OstraVault vault, uint8 action, bytes memory params, bytes memory err) internal {
        (bytes32 next, bytes memory signature) = _agentSigned(vault, action, params);
        uint64 n = _agentNonce(vault);
        uint64 owner = vault.nonce();
        vm.expectRevert(err);
        vm.prank(SUBMITTER, SUBMITTER);
        vault.spendAsAgent(action, next, params, signature);
        assertEq(_agentNonce(vault), n, "a refused agent spend keeps its key");
        assertEq(vault.nonce(), owner);
    }

    function _bits(uint8[] memory actions) internal pure returns (uint64 m) {
        for (uint256 i = 0; i < actions.length; ++i) {
            m |= uint64(1) << actions[i];
        }
    }

    function _one(uint8 a) internal pure returns (uint8[] memory r) {
        r = new uint8[](1);
        r[0] = a;
    }

    function _two(uint8 a, uint8 b) internal pure returns (uint8[] memory r) {
        r = new uint8[](2);
        (r[0], r[1]) = (a, b);
    }

    function _policy(uint64 actions, uint128 perTx, uint128 daily) internal pure returns (OstraVaultV5.Policy memory p) {
        p.actions = actions;
        p.perTx = perTx;
        p.daily = daily;
    }

    function _setPolicy(OstraVault vault, bytes32 keychain, OstraVaultV5.Policy memory p) internal {
        _spend(vault, keychain, 29, abi.encode(p));
    }

    function _allow(OstraVault vault, bytes32 keychain, uint8 kind, bytes32 value) internal {
        _spend(vault, keychain, 30, abi.encode(kind, value, true));
    }

    function _addr(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _inForce(OstraVault vault, uint8 kind, bytes32 value) internal view returns (bool on) {
        (on,) = vault.allowEntry(kind, value);
    }

    function _agentInForce(OstraVault vault) internal view returns (bool on) {
        (,,,, on) = vault.agentKey();
    }

    function _lock(OstraVault vault, bytes32 keychain, uint128 limit) internal {
        _spend(vault, keychain, 6, abi.encode(GUARDIAN, true));
        _spend(vault, keychain, 14, abi.encode(WITHDRAWAL, DELAY, limit));
    }

    function _register(OstraVault vault, bytes32 keychain) internal returns (uint256 agentId) {
        vm.recordLogs();
        _spend(vault, keychain, 12, abi.encode("ipfs://ostra-v5-test"));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == OstraVault.AgentRegistered.selector) {
                return uint256(logs[i].topics[1]);
            }
        }
        revert("no AgentRegistered");
    }

    // ---------------------------------------------------------------------------------------------
    // Layout, modules and params
    // ---------------------------------------------------------------------------------------------

    function test_v5StorageSitsAtItsErc7201Slot() public pure {
        bytes32 expected = keccak256(abi.encode(uint256(keccak256("ostra.vault.v5")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(OstraVaultV5.SLOT, expected);
    }

    function test_theAgentActionSetIsTheDocumentedOne() public view {
        uint8[27] memory allowed =
            [0, 1, 3, 5, 10, 11, 17, 18, 19, 20, 21, 22, 26, 27, 28, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 46];
        uint64 m;
        for (uint256 i = 0; i < allowed.length; ++i) {
            m |= uint64(1) << allowed[i];
        }
        assertEq(m5.AGENT_ACTIONS(), m);
        // Never: the guardians, recovery, the lock, the link, the crank, pool rules, a dev buy, the identity, a hash
        // approval, Guard, the venues, the policy, the allowlist, the agent key, a root's stake.
        uint8[20] memory never = [2, 4, 6, 7, 8, 9, 12, 13, 14, 15, 16, 23, 24, 25, 29, 30, 31, 39, 40, 45];
        for (uint256 i = 0; i < never.length; ++i) {
            assertEq(m5.AGENT_ACTIONS() >> never[i] & 1, 0);
        }
    }

    function test_theModuleRefusesADirectCall() public {
        vm.expectRevert(OstraVaultModuleV5.OnlyDelegated.selector);
        m5.run(29, abi.encode(_policy(0, 0, 0)), IERC20(USDG), false, false);
        vm.expectRevert(OstraVaultModuleV5.OnlyDelegated.selector);
        m5.agentExit(abi.encode(K_ERC4626, SPARK, uint256(1), uint256(0)), IERC20(USDG));
        vm.expectRevert(OstraVaultModuleV5.OnlyDelegated.selector);
        m5.agent(0, bytes32(0), "", "", false);
        vm.expectRevert(OstraVaultModuleV5.OnlyDelegated.selector);
        m5.runOrder(1, IERC20(USDG), false);
        vm.expectRevert(OstraVaultModuleV5.OnlyDelegated.selector);
        m5.repayDue(1, IERC20(USDG));
        vm.expectRevert(OstraVaultModuleV5.OnlyDelegated.selector);
        m5.cancel(address(0));
        vm.expectRevert(OstraVaultModuleV5.OnlyDelegated.selector);
        m5.stop(address(0), "");
        vm.expectRevert(OstraVaultModuleV5.OnlyDelegated.selector);
        m5.onRecovery();
        vm.expectRevert(OstraVaultModuleV5.OnlyDelegated.selector);
        m5.guardSpend("");
    }

    function test_v5ParamsOfTheWrongLengthAreRefusedBeforeTheKeyMoves() public {
        OstraVault v = _vault(OWNER);
        uint16[18] memory lengths = [416, 96, 64, 0, 256, 32, 384, 64, 128, 32, 64, 64, 352, 96, 96, 64, 64, 32];
        for (uint8 i = 0; i < 18; ++i) {
            bytes memory wrong = new bytes(uint256(lengths[i]) + 32);
            _refused(v, OWNER, 29 + i, wrong, abi.encodeWithSelector(OstraVault.BadParams.selector));
        }
        _refused(v, OWNER, 47, "", abi.encodeWithSelector(OstraVault.BadAction.selector));
    }

    // ---------------------------------------------------------------------------------------------
    // The agent key
    // ---------------------------------------------------------------------------------------------

    function test_withNoPolicyTheAgentKeyCanDoNothing() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 10e6);
        // No key at all.
        (bytes32 next, bytes memory sig) = _agentSigned(v, 0, abi.encode(PAYEE, uint256(1)));
        vm.expectRevert(OstraVaultModuleV5.NoAgentKey.selector);
        v.spendAsAgent(0, next, abi.encode(PAYEE, uint256(1)), sig);
        // A key, but no policy: nothing is allowed.
        _setAgent(v, OWNER, 30 days);
        assertTrue(_agentInForce(v));
        _agentRefused(
            v, 0, abi.encode(PAYEE, uint256(1)), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 0)
        );
        _agentRefused(v, 26, abi.encode(K_ERC4626, SPARK, uint256(1), uint256(0)), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 26));
        assertEq(IERC20(USDG).balanceOf(address(v)), 10e6);
    }

    function test_theAgentKeyTransfersOnlyWithinThePolicyAndItsAllowlist() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _setAgent(v, OWNER, 30 days);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 4e6, 10e6));
        // Not on the allowlist.
        _agentRefused(
            v,
            0,
            abi.encode(PAYEE, uint256(1e6)),
            abi.encodeWithSelector(OstraVaultModuleV5.NotAllowlisted.selector, OstraVaultV5.ALLOW_RECIPIENT)
        );
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        // Over the per-spend bound.
        _agentRefused(
            v, 0, abi.encode(PAYEE, uint256(4e6 + 1)), abi.encodeWithSelector(OstraVaultV5.OverPerTx.selector, 4e6)
        );
        _agent(v, 0, abi.encode(PAYEE, uint256(4e6)));
        _agent(v, 0, abi.encode(PAYEE, uint256(4e6)));
        assertEq(v.budgetAvailable(), 2e6);
        // Over the daily bound.
        _agentRefused(
            v, 0, abi.encode(PAYEE, uint256(3e6)), abi.encodeWithSelector(OstraVaultV5.OverBudget.selector, 2e6)
        );
        _agent(v, 0, abi.encode(PAYEE, uint256(2e6)));
        assertEq(IERC20(USDG).balanceOf(PAYEE), 10e6);
        // It drains at the daily bound per day.
        vm.warp(block.timestamp + 12 hours);
        assertEq(v.budgetAvailable(), 5e6);
        _agent(v, 0, abi.encode(PAYEE, uint256(4e6)));
        assertEq(IERC20(USDG).balanceOf(PAYEE), 14e6);
        // The owner's own spends never count against the agent's budget.
        _spend(v, OWNER, 0, abi.encode(STRANGER, uint256(50e6)));
        assertEq(IERC20(USDG).balanceOf(STRANGER), 50e6);
    }

    function test_agentAndOwnerSignaturesNeverStandInForEachOther() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 10e6);
        _setAgent(v, OWNER, 30 days);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 10e6, 10e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        bytes memory params = abi.encode(PAYEE, uint256(1e6));
        // An owner signature sent as the agent's.
        (bytes32 next, bytes memory sig) = _signed(v, OWNER, 0, params);
        vm.expectRevert(OstraVaultModuleV5.WotsSignatureInvalid.selector);
        v.spendAsAgent(0, next, params, sig);
        // An agent signature sent as the owner's.
        (next, sig) = _agentSigned(v, 0, params);
        vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
        v.spend(0, next, params, sig);
        // The agent key signing the owner's message for the owner's nonce: still not the owner's key.
        uint64 n = _agentNonce(v);
        bytes memory forged = WotsSigner.sign(_seed(AGENT, n), v.spendMessage(0, next, params));
        vm.expectRevert(OstraVault.WotsSignatureInvalid.selector);
        v.spend(0, next, params, forged);
        // The real one works once; sent again it no longer matches the rotated key.
        (next, sig) = _agentSigned(v, 0, params);
        v.spendAsAgent(0, next, params, sig);
        vm.expectRevert(OstraVaultModuleV5.WotsSignatureInvalid.selector);
        v.spendAsAgent(0, next, params, sig);
        assertEq(IERC20(USDG).balanceOf(PAYEE), 1e6);
    }

    function test_theAgentKeyNeverReachesGovernanceWhateverThePolicy() public {
        OstraVault v = _vault(OWNER);
        _setAgent(v, OWNER, 30 days);
        // A policy naming an action outside the agent set is refused.
        _refused(
            v, OWNER, 29, abi.encode(_policy(uint64(1) << 6, 0, 0)), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        _refused(
            v, OWNER, 29, abi.encode(_policy(uint64(1) << 23, 0, 0)), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        _setPolicy(v, OWNER, _policy(m5.AGENT_ACTIONS(), 1e6, 1e6));
        _agentRefused(v, 6, abi.encode(STRANGER, true), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 6));
        _agentRefused(
            v, 14, abi.encode(address(0), uint32(0), uint128(0)), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 14)
        );
        _agentRefused(
            v, 23, abi.encode(keccak256("x"), true), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 23)
        );
        _agentRefused(
            v, 29, abi.encode(_policy(m5.AGENT_ACTIONS(), 1e9, 1e9)), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 29)
        );
        _agentRefused(
            v,
            30,
            abi.encode(OstraVaultV5.ALLOW_RECIPIENT, _addr(STRANGER), true),
            abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 30)
        );
        _agentRefused(
            v, 31, abi.encode(bytes32(uint256(7)), uint64(block.timestamp + 1 days)), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 31)
        );
        _agentRefused(v, 2, abi.encode(STRANGER), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 2));
        _agentRefused(v, 25, abi.encode(K_ERC4626, SPARK, true), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 25));
        _agentRefused(v, 12, abi.encode("ipfs://x"), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 12));
    }

    function test_revokeExpiryAndKeyRulesEndTheAgentKey() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 10e6);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 10e6, 10e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        // The vault's own key root, a zero root, and a life over 90 days are refused.
        (bytes32 ownerNext,) = _signed(v, OWNER, 31, abi.encode(bytes32(0), uint64(0)));
        _refused(
            v, OWNER, 31, abi.encode(ownerNext, uint64(block.timestamp + 1 days)), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        _refused(
            v, OWNER, 31, abi.encode(bytes32(0), uint64(block.timestamp + 1 days)), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        _refused(
            v,
            OWNER,
            31,
            abi.encode(bytes32(uint256(9)), uint64(block.timestamp + 90 days + 1)),
            abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        _setAgent(v, OWNER, 1 days);
        // A message signed now, then the key revoked: nothing it signed counts again, even under the same root.
        bytes memory params = abi.encode(PAYEE, uint256(1e6));
        (bytes32 next, bytes memory sig) = _agentSigned(v, 0, params);
        (bytes32 root,,,,) = v.agentKey();
        _spend(v, OWNER, 32, "");
        assertFalse(_agentInForce(v));
        vm.expectRevert(OstraVaultModuleV5.NoAgentKey.selector);
        v.spendAsAgent(0, next, params, sig);
        _spend(v, OWNER, 31, abi.encode(root, uint64(block.timestamp + 1 days)));
        vm.expectRevert(OstraVaultModuleV5.WotsSignatureInvalid.selector);
        v.spendAsAgent(0, next, params, sig);
        // Expiry.
        _setAgent(v, OWNER, 1 days);
        _agent(v, 0, params);
        vm.warp(block.timestamp + 1 days);
        _agentRefused(v, 0, params, abi.encodeWithSelector(OstraVaultModuleV5.NoAgentKey.selector));
        // The agent key may end itself.
        _setPolicy(v, OWNER, _policy(_bits(_two(0, 32)), 10e6, 10e6));
        _setAgent(v, OWNER, 1 days);
        _agent(v, 32, "");
        assertFalse(_agentInForce(v));
    }

    function test_theAgentKeysNextRootIsNeitherItselfNorTheOwners() public {
        OstraVault v = _vault(OWNER);
        _setPolicy(v, OWNER, _policy(_bits(_one(10)), 0, 0));
        _setAgent(v, OWNER, 1 days);
        bytes memory params = abi.encode("ipfs://profile");
        uint64 n = _agentNonce(v);
        bytes32 same = WotsSigner.keyRoot(_seed(AGENT, n));
        bytes memory sig = WotsSigner.sign(_seed(AGENT, n), v.agentSpendMessage(10, same, params));
        vm.expectRevert(OstraVaultModuleV5.BadParams.selector);
        v.spendAsAgent(10, same, params, sig);
        bytes32 owners = v.keyRoot();
        sig = WotsSigner.sign(_seed(AGENT, n), v.agentSpendMessage(10, owners, params));
        vm.expectRevert(OstraVaultModuleV5.BadParams.selector);
        v.spendAsAgent(10, owners, params, sig);
        _agent(v, 10, params);
    }

    // ---------------------------------------------------------------------------------------------
    // Under the withdrawal lock
    // ---------------------------------------------------------------------------------------------

    function test_underTheLockLooseningWaitsAndGuardiansCanDropIt() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _lock(v, OWNER, 20e6);
        // An agent key, a looser policy and a new allowlist entry all wait the lock's delay.
        _setAgent(v, OWNER, 30 days);
        assertFalse(_agentInForce(v));
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 5e6, 10e6));
        (OstraVaultV5.Policy memory now_, OstraVaultV5.Policy memory pending, uint64 at) = v.policy();
        assertEq(now_.actions, 0);
        assertEq(pending.daily, 10e6);
        assertEq(at, block.timestamp + DELAY);
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        assertFalse(_inForce(v, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE)));
        // A guardian drops them all (and nothing of version 3 or 4 waits, so only version 5's runs).
        vm.prank(GUARDIAN);
        v.guard(0, "");
        (bytes32 root,,,,) = v.agentKey();
        assertEq(root, bytes32(0));
        (,, at) = v.policy();
        assertEq(at, 0);
        vm.warp(block.timestamp + DELAY);
        assertFalse(_inForce(v, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE)));
        (now_,,) = v.policy();
        assertEq(now_.actions, 0);
        // Nothing waits now: guard op 0 says so.
        vm.expectRevert(OstraVaultModuleV4.BadParams.selector);
        vm.prank(GUARDIAN);
        v.guard(0, "");

        // Again, and this time it takes effect; CancelPendingChanges by the owner drops a later one.
        _setAgent(v, OWNER, 30 days);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 5e6, 10e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        vm.warp(block.timestamp + DELAY);
        assertTrue(_agentInForce(v));
        assertTrue(_inForce(v, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE)));
        _agent(v, 0, abi.encode(PAYEE, uint256(5e6)));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(STRANGER));
        _spend(v, OWNER, 15, "");
        vm.warp(block.timestamp + DELAY);
        assertFalse(_inForce(v, OstraVaultV5.ALLOW_RECIPIENT, _addr(STRANGER)));
        assertTrue(_inForce(v, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE)));

        // Tightening is at once and drops a loosening still waiting.
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 50e6, 50e6));
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 1e6, 10e6));
        (now_,, at) = v.policy();
        assertEq(now_.perTx, 1e6);
        assertEq(at, 0);
        // Removing an entry is at once.
        _spend(v, OWNER, 30, abi.encode(OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE), false));
        _agentRefused(
            v,
            0,
            abi.encode(PAYEE, uint256(1e6)),
            abi.encodeWithSelector(OstraVaultModuleV5.NotAllowlisted.selector, OstraVaultV5.ALLOW_RECIPIENT)
        );
    }

    function test_underTheLockTheAgentIsHeldByBothThePolicyAndTheLock() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _setAgent(v, OWNER, 30 days);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 50e6, 50e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _lock(v, OWNER, 3e6);
        // Turning the lock on ended the agent key set before it (the policy and the allowlist stay).
        assertFalse(_agentInForce(v));
        _agentRefused(v, 0, abi.encode(PAYEE, uint256(1)), abi.encodeWithSelector(OstraVaultModuleV5.NoAgentKey.selector));
        _setAgent(v, OWNER, 30 days);
        vm.warp(block.timestamp + DELAY);
        _agent(v, 0, abi.encode(PAYEE, uint256(3e6)));
        _agentRefused(
            v, 0, abi.encode(PAYEE, uint256(1)), abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 0)
        );
    }

    function test_guardOp7EndsTheAgentKeyAndEveryOrder() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _setAgent(v, OWNER, 30 days);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 5e6, 50e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _spend(v, OWNER, 33, abi.encode(_pay(PAYEE, 1e6, 10)));
        // Only under the lock, and only a guardian or the withdrawal address.
        vm.expectRevert(OstraVault.Locked.selector);
        vm.prank(GUARDIAN);
        v.guard(7, "");
        _lock(v, OWNER, 50e6);
        vm.expectRevert(OstraVault.NotGuardian.selector);
        vm.prank(STRANGER);
        v.guard(7, "");
        vm.expectRevert(OstraVaultModuleV5.BadParams.selector);
        vm.prank(GUARDIAN);
        v.guard(7, hex"00");
        vm.prank(WITHDRAWAL);
        v.guard(7, "");
        assertFalse(_agentInForce(v));
        (, bool live) = v.order(1);
        assertFalse(live);
        vm.expectRevert(OstraVaultModuleV5.NoOrder.selector);
        v.runOrder(1);
    }

    function test_aGuardianVaultEndsTheAgentKeyWithAGuardSpend() public {
        OstraVault v = _vault(OWNER);
        OstraVault g = _vault(GUARD_VAULT);
        _setAgent(v, OWNER, 30 days);
        _spend(v, OWNER, 6, abi.encode(address(g), true));
        _spend(v, OWNER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        // Turning the lock on ended the agent key set before it; one set under the lock waits the delay.
        assertFalse(_agentInForce(v));
        _setAgent(v, OWNER, 30 days);
        assertFalse(_agentInForce(v));
        vm.warp(block.timestamp + DELAY);
        // Malformed op 7 words are refused and keep the key.
        _refused(
            g, GUARD_VAULT, 24, abi.encode(address(v), uint8(7), bytes32(uint256(1)), uint256(0)), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        _refused(
            g, GUARD_VAULT, 24, abi.encode(STRANGER, uint8(7), bytes32(0), uint256(0)), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        assertTrue(_agentInForce(v));
        vm.expectEmit(address(g));
        emit OstraVaultModuleV5Events.Guarded(address(v), 7, true, bytes4(0));
        _spend(g, GUARD_VAULT, 24, abi.encode(address(v), uint8(7), bytes32(0), uint256(0)));
        assertFalse(_agentInForce(v));
    }

    function test_aRecoveryEndsTheAgentKeyTheOrdersAndWhatWaits() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _setAgent(v, OWNER, 30 days);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 5e6, 50e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _spend(v, OWNER, 33, abi.encode(_pay(PAYEE, 1e6, 10)));
        _spend(v, OWNER, 6, abi.encode(GUARDIAN, true));
        _spend(v, OWNER, 7, abi.encode(uint8(1), uint32(36 hours)));
        _spend(v, OWNER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(50e6)));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(STRANGER));
        vm.prank(GUARDIAN);
        v.supportRecovery(keccak256("new seed"));
        assertFalse(_agentInForce(v));
        (, bool live) = v.order(1);
        assertFalse(live);
        vm.warp(block.timestamp + DELAY);
        assertFalse(_inForce(v, OstraVaultV5.ALLOW_RECIPIENT, _addr(STRANGER)));
        // While the recovery waits: no agent key, no order, no loosening; tightening still works.
        _refused(
            v, OWNER, 31, abi.encode(bytes32(uint256(5)), uint64(block.timestamp + 1 days)), abi.encodeWithSelector(OstraVaultModuleV5.Locked.selector)
        );
        _refused(v, OWNER, 33, abi.encode(_pay(PAYEE, 1e6, 10)), abi.encodeWithSelector(OstraVaultModuleV5.Locked.selector));
        _refused(
            v, OWNER, 29, abi.encode(_policy(_bits(_one(0)), 50e6, 50e6)), abi.encodeWithSelector(OstraVaultModuleV5.Locked.selector)
        );
        _refused(
            v,
            OWNER,
            30,
            abi.encode(OstraVaultV5.ALLOW_RECIPIENT, _addr(address(0xF00)), true),
            abi.encodeWithSelector(OstraVaultModuleV5.Locked.selector)
        );
        _spend(v, OWNER, 29, abi.encode(_policy(0, 0, 0)));
    }

    // ---------------------------------------------------------------------------------------------
    // Standing orders
    // ---------------------------------------------------------------------------------------------

    function _pay(address to, uint128 amount, uint32 runs) internal pure returns (OstraVaultModuleV5.OrderParams memory o) {
        o.kind = OstraVaultV5.ORDER_PAY;
        o.target = to;
        o.amount = amount;
        o.interval = 1 hours;
        o.runs = runs;
    }

    function test_aPayOrderRunsForAnyoneWithinThePolicy() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _spend(v, OWNER, 33, abi.encode(_pay(PAYEE, 2e6, 3)));
        // No policy: the order cannot run.
        vm.expectRevert(abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 0));
        v.runOrder(1);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 2e6, 5e6));
        vm.expectRevert(abi.encodeWithSelector(OstraVaultModuleV5.NotAllowlisted.selector, OstraVaultV5.ALLOW_RECIPIENT));
        v.runOrder(1);
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        vm.prank(STRANGER);
        v.runOrder(1);
        assertEq(IERC20(USDG).balanceOf(PAYEE), 2e6);
        vm.expectRevert(abi.encodeWithSelector(OstraVaultModuleV5.TooEarly.selector, block.timestamp + 1 hours));
        v.runOrder(1);
        vm.warp(block.timestamp + 1 hours);
        v.runOrder(1);
        vm.warp(block.timestamp + 1 hours);
        // The budget: 5e6 a day, 4e6 counted, about 0.2e6 drained.
        vm.expectPartialRevert(OstraVaultV5.OverBudget.selector);
        v.runOrder(1);
        vm.warp(block.timestamp + 12 hours);
        v.runOrder(1);
        assertEq(IERC20(USDG).balanceOf(PAYEE), 6e6);
        // Three runs, then the order is gone.
        (, bool live) = v.order(1);
        assertFalse(live);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(OstraVaultModuleV5.NoOrder.selector);
        v.runOrder(1);
    }

    function test_aPayOrderStopsWhenThePolicyOrTheListTightens() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 2e6, 50e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _spend(v, OWNER, 33, abi.encode(_pay(PAYEE, 2e6, 0 + 10)));
        v.runOrder(1);
        vm.warp(block.timestamp + 1 hours);
        _spend(v, OWNER, 30, abi.encode(OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE), false));
        vm.expectRevert(abi.encodeWithSelector(OstraVaultModuleV5.NotAllowlisted.selector, OstraVaultV5.ALLOW_RECIPIENT));
        v.runOrder(1);
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 1e6, 50e6));
        vm.expectRevert(abi.encodeWithSelector(OstraVaultV5.OverPerTx.selector, 1e6));
        v.runOrder(1);
        // CancelOrder ends it; cancelling again lands and does nothing.
        _spend(v, OWNER, 34, abi.encode(uint256(1)));
        _spend(v, OWNER, 34, abi.encode(uint256(1)));
        vm.expectRevert(OstraVaultModuleV5.NoOrder.selector);
        v.runOrder(1);
    }

    function test_aPayOrderCountsAgainstTheLock() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 5e6, 50e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _lock(v, OWNER, 3e6);
        _spend(v, OWNER, 33, abi.encode(_pay(PAYEE, 4e6, 10)));
        vm.expectRevert(abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 3e6));
        v.runOrder(1);
    }

    function test_orderParamsAreChecked() public {
        OstraVault v = _vault(OWNER);
        OstraVaultModuleV5.OrderParams memory o = _pay(PAYEE, 1e6, 1);
        o.interval = 1 hours - 1;
        _refused(v, OWNER, 33, abi.encode(o), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector));
        o = _pay(PAYEE, 1e6, 0);
        _refused(v, OWNER, 33, abi.encode(o), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector));
        o = _pay(address(v), 1e6, 1);
        _refused(v, OWNER, 33, abi.encode(o), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector));
        o = _pay(PAYEE, 0, 1);
        _refused(v, OWNER, 33, abi.encode(o), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector));
        // REFILL never from a stock venue; SWEEP takes no runs.
        o = _refill(SPARK, 1e6, 1e6);
        o.venueKind = 2;
        _refused(v, OWNER, 33, abi.encode(o), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector));
        o = _sweep(SPARK, 1e6, 1e6);
        o.runs = 1;
        _refused(v, OWNER, 33, abi.encode(o), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector));
        o.kind = 4;
        o.runs = 0;
        _refused(v, OWNER, 33, abi.encode(o), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector));
    }

    function _sweep(address venue, uint128 keep, uint128 most)
        internal
        pure
        returns (OstraVaultModuleV5.OrderParams memory o)
    {
        o.kind = OstraVaultV5.ORDER_SWEEP;
        o.venueKind = K_ERC4626;
        o.target = venue;
        o.amount = most;
        o.threshold = keep;
        o.interval = 1 hours;
    }

    function _refill(address venue, uint128 upTo, uint128 most)
        internal
        pure
        returns (OstraVaultModuleV5.OrderParams memory o)
    {
        o.kind = OstraVaultV5.ORDER_REFILL;
        o.venueKind = K_ERC4626;
        o.target = venue;
        o.amount = most;
        o.threshold = upTo;
        o.interval = 1 hours;
    }

    function test_sweepAndRefillOrdersMoveIdleCashThroughSpark() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _spend(v, OWNER, 25, abi.encode(K_ERC4626, SPARK, true));
        _spend(v, OWNER, 33, abi.encode(_sweep(SPARK, 20e6, 60e6)));
        _spend(v, OWNER, 33, abi.encode(_refill(SPARK, 15e6, 30e6)));
        // No Enter or Exit in the policy: neither runs.
        vm.expectRevert(abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 26));
        v.runOrder(1);
        _setPolicy(v, OWNER, _policy(_bits(_two(26, 27)), 0, 0));
        vm.prank(STRANGER);
        v.runOrder(1);
        assertEq(IERC20(USDG).balanceOf(address(v)), 40e6);
        uint256 position = IERC4626Venue(SPARK).convertToAssets(IERC4626Venue(SPARK).balanceOf(address(v)));
        assertApproxEqAbs(position, 60e6, 2);
        vm.warp(block.timestamp + 1 hours);
        v.runOrder(1);
        assertEq(IERC20(USDG).balanceOf(address(v)), 20e6);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(OstraVaultModuleV5.NothingToDo.selector);
        v.runOrder(1);
        // The balance falls below 15e6: the refill brings it back from Spark.
        _spend(v, OWNER, 0, abi.encode(PAYEE, uint256(15e6)));
        vm.expectRevert(OstraVaultModuleV5.NothingToDo.selector);
        v.runOrder(1);
        vm.prank(STRANGER);
        v.runOrder(2);
        assertGe(IERC20(USDG).balanceOf(address(v)), 15e6);
        assertLe(IERC20(USDG).balanceOf(address(v)), 15e6 + 2);
        // Never while a recovery waits.
        _spend(v, OWNER, 6, abi.encode(GUARDIAN, true));
        _spend(v, OWNER, 7, abi.encode(uint8(1), uint32(36 hours)));
        vm.prank(GUARDIAN);
        v.supportRecovery(keccak256("new seed"));
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(OstraVaultModuleV5.Locked.selector);
        v.runOrder(2);
    }

    // ---------------------------------------------------------------------------------------------
    // Priors
    // ---------------------------------------------------------------------------------------------

    struct Credit {
        OstraVault root;
        uint256 rootId;
        OstraVault borrower;
        uint256 agentId;
    }

    function _loanPolicy(uint128 maxDebt) internal pure returns (OstraVaultV5.Policy memory p) {
        p.maxDebt = maxDebt;
        p.maxTerm = 30 days;
        p.maxFeeBps = 100;
    }

    /// @dev What a default on a line of `amount` to `agentId` can burn from its backer, by the live pool's parameters.
    function _lineCost(uint256 amount, uint256 agentId) internal view returns (uint256) {
        IPriorsPool.Params memory pp = IPriorsPool(POOL).getParams();
        uint256 bps = pp.feeBps + IPriorsPool(POOL).getAgent(agentId).premiumBps;
        return amount + amount * bps * pp.maxTerm / (10_000 * 30 days);
    }

    /// @dev The largest line to `agentId` whose cost is at most `room`, or a unit under it.
    function _lineFit(uint256 room, uint256 agentId) internal view returns (uint256 fit) {
        IPriorsPool.Params memory pp = IPriorsPool(POOL).getParams();
        uint256 bps = pp.feeBps + IPriorsPool(POOL).getAgent(agentId).premiumBps;
        fit = room * (10_000 * 30 days) / (10_000 * 30 days + bps * pp.maxTerm);
    }

    function _rootPolicy() internal pure returns (OstraVaultV5.Policy memory p) {
        p.vouchPerAgent = 25e6;
        p.vouchTotal = 100e6;
    }

    /// @dev An Ostra root (an Ostra vault enrolled in the live pool with 20 USDG) sponsoring an Ostra borrower vault's
    ///      agent with a 10 USDG line, on the borrower's EIP-1271 consent.
    function _credit() internal returns (Credit memory c) {
        c.root = _vault(ROOT_OWNER);
        deal(USDG, address(c.root), 50e6);
        c.rootId = _register(c.root, ROOT_OWNER);
        _setPolicy(c.root, ROOT_OWNER, _rootPolicy());
        // The fees of the loans a root backs are held out of its free backing: stake beyond the lines.
        _spend(c.root, ROOT_OWNER, 39, abi.encode(c.rootId, uint256(20e6)));
        assertTrue(IPriorsPool(POOL).getAgent(c.rootId).isRoot);

        c.borrower = _vault(OWNER);
        deal(USDG, address(c.borrower), 1e6);
        c.agentId = _register(c.borrower, OWNER);
        _allow(c.borrower, OWNER, OstraVaultV5.ALLOW_SPONSOR, bytes32(c.rootId));
        _setPolicy(c.borrower, OWNER, _loanPolicy(10e6));
        uint256 deadline = block.timestamp + 1 days;
        _spend(c.borrower, OWNER, 37, abi.encode(c.agentId, c.rootId, uint256(0), deadline));
        _sponsor(c, 10e6, deadline);
    }

    function _sponsor(Credit memory c, uint256 amount, uint256 deadline) internal {
        OstraVaultModuleV5.SponsorParams memory s;
        s.rootId = c.rootId;
        s.agentId = c.agentId;
        s.amount = amount;
        s.nonce = IPriorsPool(POOL).nonces(c.agentId);
        s.deadline = deadline;
        s.owner = address(c.borrower);
        _spend(c.root, ROOT_OWNER, 41, abi.encode(s));
    }

    function _borrow(OstraVault v, bytes32 keychain, uint256 agentId, uint256 amount, uint64 term)
        internal
        returns (uint256 loanId)
    {
        loanId = IPriorsPoolCount(POOL).loanCount() + 1;
        bytes32[8] memory jobs;
        _spend(v, keychain, 35, abi.encode(agentId, amount, term, uint256(1e6), jobs));
    }

    function test_anOstraVaultBorrowsOnItsOwnConsentAndAnyoneRepaysItWhenDue() public {
        Credit memory c = _credit();
        IPriorsPool.Agent memory a = IPriorsPool(POOL).getAgent(c.agentId);
        assertEq(a.sponsor, c.rootId);
        assertEq(a.delegatedIn, 10e6);
        uint256 loanId = _borrow(c.borrower, OWNER, c.agentId, 5e6, 7 days);
        assertTrue(c.borrower.ownLoan(loanId));
        assertEq(IERC20(USDG).balanceOf(address(c.borrower)), 6e6);
        IPriorsPool.Loan memory ln = IPriorsPool(POOL).getLoan(loanId);
        assertEq(ln.agentId, c.agentId);
        assertEq(ln.owner, address(c.borrower));
        // 1% per 30 days, for 7 days.
        assertEq(ln.fee, uint256(5e6) * 100 * 7 days / (10_000 * 30 days));
        // Not before a day before it is due.
        vm.expectRevert(abi.encodeWithSelector(OstraVaultModuleV5.TooEarly.selector, ln.dueAt - 1 days));
        c.borrower.repayDue(loanId);
        vm.warp(ln.dueAt - 1 days);
        vm.prank(STRANGER);
        c.borrower.repayDue(loanId);
        assertEq(IPriorsPool(POOL).getLoan(loanId).status, 2);
        assertEq(IERC20(USDG).balanceOf(address(c.borrower)), 6e6 - 5e6 - ln.fee);
        assertEq(IERC20(USDG).allowance(address(c.borrower), POOL), 0);
        assertFalse(c.borrower.ownLoan(loanId));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).loansRepaid, 1);
        vm.expectRevert(abi.encodeWithSelector(OstraVaultModuleV5.NotOwnLoan.selector, loanId));
        c.borrower.repayDue(loanId);
        // An owner PriorsRepay of the same loan, signed meanwhile, still lands and does nothing.
        uint256 balance = IERC20(USDG).balanceOf(address(c.borrower));
        _spend(c.borrower, OWNER, 36, abi.encode(loanId, uint256(10e6)));
        assertEq(IERC20(USDG).balanceOf(address(c.borrower)), balance);
    }

    function test_aBorrowStaysWithinTheLoanPolicy() public {
        Credit memory c = _credit();
        bytes32[8] memory jobs;
        // Over the debt bound, over the term, and with no loan policy at all.
        _failed(
            c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(11e6), uint64(7 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.OutOfPolicy.selector)
        );
        _failed(
            c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(5e6), uint64(31 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.OutOfPolicy.selector)
        );
        // A fee rate under the pool's is refused by the pool through the capped maxFee.
        OstraVaultV5.Policy memory p = _loanPolicy(10e6);
        p.maxFeeBps = 99;
        _setPolicy(c.borrower, OWNER, p);
        (bytes32 next, bytes memory sig) =
            _signed(c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs));
        vm.expectPartialRevert(bytes4(keccak256("FeeTooHigh(uint256,uint256)")));
        c.borrower.spend(35, next, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs), sig);
        _setPolicy(c.borrower, OWNER, _policy(0, 0, 0));
        _failed(
            c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.OutOfPolicy.selector)
        );
        // A sponsor the borrower no longer allows.
        _setPolicy(c.borrower, OWNER, _loanPolicy(10e6));
        _spend(c.borrower, OWNER, 30, abi.encode(OstraVaultV5.ALLOW_SPONSOR, bytes32(c.rootId), false));
        _failed(
            c.borrower,
            OWNER,
            35,
            abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs),
            abi.encodeWithSelector(OstraVaultModuleV5.NotAllowlisted.selector, OstraVaultV5.ALLOW_SPONSOR)
        );
    }

    function test_aLoanOfAnIdentitySentToTheVaultIsNeverRepaidFromIt() public {
        Credit memory c = _credit();
        // A stranger's own agent, sponsored by the same root on an ECDSA consent, borrows to the stranger, then sends
        // its identity to the borrower vault.
        uint256 key = uint256(keccak256("stranger-key"));
        address strangerKey = vm.addr(key);
        vm.prank(strangerKey);
        uint256 strangerId = IIdentityRegister(IDENTITY_REGISTRY).register("ipfs://stranger");
        bytes32 digest = IPriorsPool(POOL).consentDigest(
            IPriorsPool.Consent(strangerId, c.rootId, strangerKey, 0, 0, block.timestamp + 1 days)
        );
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(key, digest);
        OstraVaultModuleV5.SponsorParams memory s;
        s.rootId = c.rootId;
        s.agentId = strangerId;
        s.amount = 5e6;
        s.deadline = block.timestamp + 1 days;
        s.owner = strangerKey;
        (s.v, s.r, s.s) = (sv, sr, ss);
        _spend(c.root, ROOT_OWNER, 41, abi.encode(s));
        uint256 loanId = IPriorsPoolCount(POOL).loanCount() + 1;
        vm.prank(strangerKey);
        IPriorsPool(POOL).borrow(strangerId, 5e6, 7 days, strangerKey, 1e6);
        vm.prank(strangerKey);
        IERC721Like(IDENTITY_REGISTRY).transferFrom(strangerKey, address(c.borrower), strangerId);
        assertEq(IERC721Like(IDENTITY_REGISTRY).ownerOf(strangerId), address(c.borrower));
        vm.warp(IPriorsPool(POOL).getLoan(loanId).dueAt - 1 hours);
        vm.expectRevert(abi.encodeWithSelector(OstraVaultModuleV5.NotOwnLoan.selector, loanId));
        c.borrower.repayDue(loanId);
        // The owner's PriorsRepay of it lands and pays nothing (a loan this vault did not borrow is never its to repay).
        uint64 n = c.borrower.nonce();
        _spend(c.borrower, OWNER, 36, abi.encode(loanId, uint256(10e6)));
        assertEq(c.borrower.nonce(), n + 1);
        assertEq(IERC20(USDG).balanceOf(address(c.borrower)), 1e6);
        assertEq(IPriorsPool(POOL).getLoan(loanId).status, 1);
    }

    function test_aShortRepayIsToppedUpFromTheRepayVenue() public {
        Credit memory c = _credit();
        uint256 loanId = _borrow(c.borrower, OWNER, c.agentId, 5e6, 7 days);
        _spend(c.borrower, OWNER, 25, abi.encode(K_ERC4626, SPARK, true));
        OstraVaultV5.Policy memory p = _loanPolicy(10e6);
        p.actions = _bits(_one(26));
        p.repayKind = K_ERC4626;
        p.repayVenue = SPARK;
        _setPolicy(c.borrower, OWNER, p);
        _spend(c.borrower, OWNER, 26, abi.encode(K_ERC4626, SPARK, uint256(5.5e6), uint256(0)));
        assertEq(IERC20(USDG).balanceOf(address(c.borrower)), 0.5e6);
        IPriorsPool.Loan memory ln = IPriorsPool(POOL).getLoan(loanId);
        vm.warp(ln.dueAt - 2 hours);
        vm.prank(STRANGER);
        c.borrower.repayDue(loanId);
        assertEq(IPriorsPool(POOL).getLoan(loanId).status, 2);
        assertLe(IERC20(USDG).balanceOf(address(c.borrower)), 0.5e6);
    }

    function test_aConsentWaitsUnderTheLockAndAGuardianCanWithdrawIt() public {
        Credit memory c = _credit();
        OstraVault b = _vault(GUARD_VAULT);
        uint256 agentId = _register(b, GUARD_VAULT);
        _allow(b, GUARD_VAULT, OstraVaultV5.ALLOW_SPONSOR, bytes32(c.rootId));
        _setPolicy(b, GUARD_VAULT, _loanPolicy(10e6));
        _spend(b, GUARD_VAULT, 6, abi.encode(GUARDIAN, true));
        _spend(b, GUARD_VAULT, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        // A deadline that ends before the consent would take effect is refused; a premium over the policy too.
        _failed(
            b, GUARD_VAULT, 37, abi.encode(agentId, c.rootId, uint256(0), block.timestamp + DELAY), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        _failed(
            b, GUARD_VAULT, 37, abi.encode(agentId, c.rootId, uint256(101), block.timestamp + 3 days), abi.encodeWithSelector(OstraVaultModuleV5.OutOfPolicy.selector)
        );
        _failed(
            b, GUARD_VAULT, 37, abi.encode(agentId, uint256(6228), uint256(0), block.timestamp + 3 days), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowlisted.selector, OstraVaultV5.ALLOW_SPONSOR)
        );
        uint256 deadline = block.timestamp + 3 days;
        _spend(b, GUARD_VAULT, 37, abi.encode(agentId, c.rootId, uint256(0), deadline));
        bytes32 digest = IPriorsPool(POOL).consentDigest(
            IPriorsPool.Consent(agentId, c.rootId, address(b), 0, IPriorsPool(POOL).nonces(agentId), deadline)
        );
        assertEq(b.hashValidFrom(digest), block.timestamp + DELAY);
        assertEq(b.isValidSignature(digest, ""), bytes4(0xffffffff));
        Credit memory c2 = Credit(c.root, c.rootId, b, agentId);
        // Before then the pool refuses the consent (its EIP-1271 check reads the vault).
        bytes memory params = abi.encode(_sponsorParams(c2, 5e6, deadline));
        (bytes32 next, bytes memory sig) = _signed(c.root, ROOT_OWNER, 41, params);
        vm.expectRevert(bytes4(keccak256("BadConsent()")));
        c.root.spend(41, next, params, sig);
        // And once it takes effect, the same consent opens the line.
        vm.warp(block.timestamp + DELAY);
        (next, sig) = _signed(c.root, ROOT_OWNER, 41, params);
        vm.prank(SUBMITTER, SUBMITTER);
        c.root.spend(41, next, params, sig);
        assertEq(IPriorsPool(POOL).getAgent(agentId).delegatedIn, 5e6);
        // A second consent, and a guardian withdraws it (version 3's guard op 1).
        deadline = block.timestamp + 3 days;
        _spend(b, GUARD_VAULT, 37, abi.encode(agentId, c.rootId, uint256(0), deadline));
        digest = IPriorsPool(POOL).consentDigest(
            IPriorsPool.Consent(agentId, c.rootId, address(b), 0, IPriorsPool(POOL).nonces(agentId), deadline)
        );
        vm.warp(block.timestamp + DELAY);
        assertEq(b.isValidSignature(digest, ""), bytes4(0x1626ba7e));
        vm.prank(GUARDIAN);
        b.guard(1, abi.encode(digest));
        assertEq(b.isValidSignature(digest, ""), bytes4(0xffffffff));
    }

    function _sponsorParams(Credit memory c, uint256 amount, uint256 deadline)
        internal
        view
        returns (OstraVaultModuleV5.SponsorParams memory s)
    {
        s.rootId = c.rootId;
        s.agentId = c.agentId;
        s.amount = amount;
        s.nonce = IPriorsPool(POOL).nonces(c.agentId);
        s.deadline = deadline;
        s.owner = address(c.borrower);
    }

    function test_theRootVouchesWithinItsPolicyAndCountsItAsOutflow() public {
        Credit memory c = _credit();
        _spend(c.root, ROOT_OWNER, 40, abi.encode(c.rootId, uint256(10e6)));
        // 10 of 25 per agent: 16 more is over.
        _failed(
            c.root, ROOT_OWNER, 42, abi.encode(c.rootId, c.agentId, uint256(16e6)), abi.encodeWithSelector(OstraVaultModuleV5.OutOfPolicy.selector)
        );
        _spend(c.root, ROOT_OWNER, 42, abi.encode(c.rootId, c.agentId, uint256(15e6)));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).delegatedIn, 25e6);
        // Under the lock a vouch counts against the daily limit, an unvouch does not.
        _lock(c.root, ROOT_OWNER, 1e6);
        _spend(c.root, ROOT_OWNER, 43, abi.encode(c.rootId, c.agentId, uint256(10e6)));
        // A vouch counts what a default can burn: the line plus the fee for the pool's longest term, so a vouch of the
        // whole daily limit is over it.
        assertGt(_lineCost(1e6, c.agentId), 1e6);
        _failed(
            c.root, ROOT_OWNER, 42, abi.encode(c.rootId, c.agentId, uint256(1e6)), abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 1e6)
        );
        uint256 fit = _lineFit(1e6, c.agentId);
        assertLe(_lineCost(fit, c.agentId), 1e6);
        _spend(c.root, ROOT_OWNER, 42, abi.encode(c.rootId, c.agentId, fit));
        assertEq(c.root.outflowAvailable(), 1e6 - _lineCost(fit, c.agentId));
        // A premium over the root's policy.
        OstraVaultModuleV5.SponsorParams memory s = _sponsorParams(c, 0, block.timestamp + 1 days);
        s.premiumBps = 1;
        _failed(c.root, ROOT_OWNER, 41, abi.encode(s), abi.encodeWithSelector(OstraVaultModuleV5.OutOfPolicy.selector));
        // Freeze releases the undrawn line; the stake comes back to the vault itself only.
        _spend(c.root, ROOT_OWNER, 44, abi.encode(c.agentId, true));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).delegatedIn, 0);
        uint256 before = IERC20(USDG).balanceOf(address(c.root));
        uint256 shares = IPoolShares(POOL).rootShares(c.rootId);
        uint256 assets = IPoolShares(POOL).convertToAssets(shares);
        // Two deposits each round their shares down by under one share (worth up to the share price in units), and the
        // conversion back rounds down by under a unit.
        uint256 perShare = IPoolShares(POOL).convertToAssets(1e6) / 1e6 + 1;
        assertApproxEqAbs(assets, 30e6, 2 * perShare + 1);
        _spend(c.root, ROOT_OWNER, 45, abi.encode(c.rootId, shares));
        assertEq(IERC20(USDG).balanceOf(address(c.root)), before + assets);
        assertEq(IPoolShares(POOL).rootShares(c.rootId), 0);
    }

    function test_theAgentKeyBorrowsAndRepaysWithinThePolicy() public {
        Credit memory c = _credit();
        OstraVaultV5.Policy memory p = _loanPolicy(5e6);
        p.actions = _bits(_two(35, 36));
        // The fee counts against the agent's budget: 5 USDG for 7 days at 1% a month is 11,666.
        p.perTx = 20_000;
        p.daily = 20_000;
        _setPolicy(c.borrower, OWNER, p);
        _setAgent(c.borrower, OWNER, 30 days);
        bytes32[8] memory jobs;
        _agentRefused(
            c.borrower, 35, abi.encode(c.agentId, uint256(6e6), uint64(7 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.OutOfPolicy.selector)
        );
        uint256 loanId = IPriorsPoolCount(POOL).loanCount() + 1;
        _agent(c.borrower, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs));
        assertTrue(c.borrower.ownLoan(loanId));
        _agent(c.borrower, 36, abi.encode(loanId, uint256(6e6)));
        assertEq(IPriorsPool(POOL).getLoan(loanId).status, 2);
        // A consent is not in this agent's policy.
        _agentRefused(
            c.borrower, 37, abi.encode(c.agentId, c.rootId, uint256(0), block.timestamp + 1 days), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 37)
        );
    }

    function test_coverHoldsDebtToEscrowedOstraPadWork() public {
        Credit memory c = _credit();
        OstraVaultV5.Policy memory p = _loanPolicy(10e6);
        p.coverBps = 10_000;
        _setPolicy(c.borrower, OWNER, p);
        bytes32[8] memory jobs;
        _failed(
            c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.NotCovered.selector, 0)
        );
        // A real OstraPad job, direct evaluator, 5 USDG, with the borrower vault as provider; accepted through the
        // vault's EIP-1271 approval, as an Ostra provider accepts.
        address client = address(0xC11E);
        deal(USDG, client, 5e6);
        IOstraPadTest.Terms memory t =
            IOstraPadTest.Terms(client, address(c.borrower), address(0xE7A1), 5e6, keccak256("job"), bytes32(0), bytes32(0));
        vm.startPrank(client);
        IERC20(USDG).approve(PAD, 5e6);
        bytes32 id = IOstraPadTest(PAD).create(t);
        vm.stopPrank();
        // Open, not accepted: not escrowed work yet.
        jobs[0] = id;
        _failed(
            c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.NotCovered.selector, 0)
        );
        bytes32 accept = IOstraPadTest(PAD).actionDigest(keccak256(abi.encode("accept", id, bytes32(0))));
        _spend(c.borrower, OWNER, 23, abi.encode(accept, true));
        IOstraPadTest(PAD).accept(id, bytes32(0));
        IOstraPadJobs.Job memory j = IOstraPadJobs(PAD).job(id);
        assertEq(j.provider, address(c.borrower));
        assertEq(j.budget, 5e6);
        assertEq(j.status, 2);
        // A duplicate id is refused; with the job, 5 of 5 is covered.
        jobs[1] = id;
        _failed(
            c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        jobs[1] = bytes32(0);
        _failed(
            c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(6e6), uint64(7 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.NotCovered.selector, 5e6)
        );
        _spend(c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).principalOut, 5e6);
        // Past the job's expiry it no longer covers more.
        vm.warp(j.expiresAt);
        p.maxDebt = 20e6;
        _setPolicy(c.borrower, OWNER, p);
        _failed(
            c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.NotCovered.selector, 0)
        );
    }

    function test_priorsSpendsRefuseOtherPoolCode() public {
        Credit memory c = _credit();
        bytes32[8] memory jobs;
        bytes memory code = POOL.code;
        code[code.length - 1] = code[code.length - 1] ^ 0x01;
        vm.etch(POOL, code);
        _failed(
            c.borrower, OWNER, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs), abi.encodeWithSelector(OstraVaultModuleV5.PoolChanged.selector)
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Review 1 fixes
    // ---------------------------------------------------------------------------------------------

    /// @dev H-1: a borrow and an early repay move the fee out every time; the fee counts against the lock's limit and the
    ///      agent's budget, and no borrow starts while a recovery waits under the lock.
    function test_aBorrowRepayLoopIsHeldByTheLockAndTheBudget() public {
        Credit memory c = _credit();
        OstraVaultV5.Policy memory p = _loanPolicy(10e6);
        p.actions = _bits(_two(35, 36));
        p.perTx = 30_000;
        p.daily = 30_000;
        _setPolicy(c.borrower, OWNER, p);
        _setAgent(c.borrower, OWNER, 30 days);
        bytes32[8] memory jobs;
        // 5 USDG for 7 days: 11,666 a loop. The agent's 30,000 a day allows two.
        for (uint256 i = 0; i < 2; ++i) {
            uint256 loanId = IPriorsPoolCount(POOL).loanCount() + 1;
            _agent(c.borrower, 35, abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs));
            _agent(c.borrower, 36, abi.encode(loanId, uint256(6e6)));
        }
        // The third loop's fee bound, 11,666, is over what is left (6,668).
        _agentRefused(
            c.borrower,
            35,
            abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs),
            abi.encodeWithSelector(OstraVaultV5.OverBudget.selector, 30_000 - 2 * 11_666)
        );
        // Under the lock the owner's loops are held by the daily limit too: 25,000 a day is two fees.
        _spend(c.borrower, OWNER, 6, abi.encode(GUARDIAN, true));
        _spend(c.borrower, OWNER, 7, abi.encode(uint8(1), uint32(36 hours)));
        _spend(c.borrower, OWNER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(25_000)));
        for (uint256 i = 0; i < 2; ++i) {
            uint256 loanId = IPriorsPoolCount(POOL).loanCount() + 1;
            _borrow(c.borrower, OWNER, c.agentId, 5e6, 7 days);
            _spend(c.borrower, OWNER, 36, abi.encode(loanId, uint256(6e6)));
        }
        _failed(
            c.borrower,
            OWNER,
            35,
            abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs),
            abi.encodeWithSelector(OstraVaultV3.OverDailyLimit.selector, 25_000 - 2 * 11_666)
        );
        // While a recovery waits under the lock, no borrow at all.
        vm.prank(GUARDIAN);
        c.borrower.supportRecovery(keccak256("new seed"));
        vm.warp(block.timestamp + 2 days);
        _failed(
            c.borrower,
            OWNER,
            35,
            abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs),
            abi.encodeWithSelector(OstraVaultModuleV5.Locked.selector)
        );
    }

    /// @dev M-1: the agent key repays Morpho debt only for this vault's own linked vault.
    function test_theAgentRepaysMorphoDebtOnlyForItsOwnLinkedVault() public {
        OstraVault v = _vault(OWNER);
        _setPolicy(v, OWNER, _policy(_bits(_one(22)), 10e6, 10e6));
        _setAgent(v, OWNER, 30 days);
        MarketParamsLite memory m;
        _agentRefused(
            v,
            22,
            abi.encode(m, uint256(1e6), uint256(0), STRANGER, uint256(1e6)),
            abi.encodeWithSelector(OstraVaultModuleV5.NotLinked.selector)
        );
    }

    /// @dev M-2: the agent key gives a line from the root only to agents on the BORROWER allowlist; the owner's own
    ///      vouches need no list.
    function test_theAgentKeyVouchesOnlyForAllowlistedAgents() public {
        Credit memory c = _credit();
        _spend(c.root, ROOT_OWNER, 40, abi.encode(c.rootId, uint256(10e6)));
        OstraVaultV5.Policy memory p = _rootPolicy();
        p.actions = _bits(_one(42));
        p.perTx = 5e6;
        p.daily = 5e6;
        _setPolicy(c.root, ROOT_OWNER, p);
        _setAgent(c.root, ROOT_OWNER, 30 days);
        _agentRefused(
            c.root,
            42,
            abi.encode(c.rootId, c.agentId, uint256(1e6)),
            abi.encodeWithSelector(OstraVaultModuleV5.NotAllowlisted.selector, OstraVaultV5.ALLOW_BORROWER)
        );
        _allow(c.root, ROOT_OWNER, OstraVaultV5.ALLOW_BORROWER, bytes32(c.agentId));
        uint256 cost = _lineCost(1e6, c.agentId);
        _agent(c.root, 42, abi.encode(c.rootId, c.agentId, uint256(1e6)));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).delegatedIn, 11e6);
        // And within its budget, counted as the line plus the fee for the pool's longest term.
        _agentRefused(
            c.root,
            42,
            abi.encode(c.rootId, c.agentId, uint256(5e6)),
            abi.encodeWithSelector(OstraVaultV5.OverPerTx.selector, 5e6)
        );
        _agentRefused(
            c.root,
            42,
            abi.encode(c.rootId, c.agentId, uint256(4e6)),
            abi.encodeWithSelector(OstraVaultV5.OverBudget.selector, 5e6 - cost)
        );
    }

    /// @dev L-1: a waiting consent is dropped by CancelPendingChanges and by guard op 0, as every loosening is.
    function test_aWaitingConsentIsDroppedByTheCancels() public {
        Credit memory c = _credit();
        OstraVault b = _vault(GUARD_VAULT);
        uint256 agentId = _register(b, GUARD_VAULT);
        _allow(b, GUARD_VAULT, OstraVaultV5.ALLOW_SPONSOR, bytes32(c.rootId));
        _setPolicy(b, GUARD_VAULT, _loanPolicy(10e6));
        _spend(b, GUARD_VAULT, 6, abi.encode(GUARDIAN, true));
        _spend(b, GUARD_VAULT, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        uint256 deadline = block.timestamp + 3 days;
        bytes32 digest = IPriorsPool(POOL).consentDigest(
            IPriorsPool.Consent(agentId, c.rootId, address(b), 0, IPriorsPool(POOL).nonces(agentId), deadline)
        );
        _spend(b, GUARD_VAULT, 37, abi.encode(agentId, c.rootId, uint256(0), deadline));
        assertGt(b.hashValidFrom(digest), 0);
        // Nothing else waits: guard op 0 drops it alone.
        vm.prank(GUARDIAN);
        b.guard(0, "");
        assertEq(b.hashValidFrom(digest), 0);
        vm.warp(block.timestamp + DELAY);
        assertEq(b.isValidSignature(digest, ""), bytes4(0xffffffff));
        // Again, and the owner's CancelPendingChanges drops it.
        deadline = block.timestamp + 3 days;
        digest = IPriorsPool(POOL).consentDigest(
            IPriorsPool.Consent(agentId, c.rootId, address(b), 0, IPriorsPool(POOL).nonces(agentId), deadline)
        );
        _spend(b, GUARD_VAULT, 37, abi.encode(agentId, c.rootId, uint256(0), deadline));
        _spend(b, GUARD_VAULT, 15, "");
        vm.warp(block.timestamp + DELAY);
        assertEq(b.isValidSignature(digest, ""), bytes4(0xffffffff));
    }

    /// @dev L-2: the orders an agent key set stop when that key ends or is replaced; the owner's keep running; CancelOrder
    ///      0 stops every order.
    function test_agentOrdersEndWithTheirKeyAndCancelOrderZeroStopsAll() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _setPolicy(v, OWNER, _policy(_bits(_two(0, 33)), 5e6, 50e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _setAgent(v, OWNER, 30 days);
        _agent(v, 33, abi.encode(_pay(PAYEE, 1e6, 10)));
        _spend(v, OWNER, 33, abi.encode(_pay(PAYEE, 1e6, 10)));
        v.runOrder(1);
        v.runOrder(2);
        vm.warp(block.timestamp + 1 hours);
        _spend(v, OWNER, 32, "");
        (, bool live) = v.order(1);
        assertFalse(live);
        vm.expectRevert(OstraVaultModuleV5.NoOrder.selector);
        v.runOrder(1);
        v.runOrder(2);
        // A new agent key does not bring the old one's orders back.
        _setAgent(v, OWNER, 30 days);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(OstraVaultModuleV5.NoOrder.selector);
        v.runOrder(1);
        _spend(v, OWNER, 34, abi.encode(uint256(0)));
        vm.expectRevert(OstraVaultModuleV5.NoOrder.selector);
        v.runOrder(2);
    }

    /// @dev L-4: an exit anyone can make (REFILL, repayDue) is refused while an ERC4626 venue's price is below the mark.
    function test_anExitForAnyoneIsRefusedBelowTheVenuesPriceMark() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _spend(v, OWNER, 25, abi.encode(K_ERC4626, SPARK, true));
        _spend(v, OWNER, 26, abi.encode(K_ERC4626, SPARK, uint256(90e6), uint256(0)));
        _spend(v, OWNER, 33, abi.encode(_refill(SPARK, 20e6, 30e6)));
        _setPolicy(v, OWNER, _policy(_bits(_one(27)), 0, 0));
        // The vault's own mark (OstraVaultV4.Venue.priceMark, the struct's fourth slot) set above any price.
        bytes32 base = keccak256(abi.encode(keccak256(abi.encode(K_ERC4626, SPARK)), uint256(0x041142257ce3186a412fed729b7a3ab63ef6a55d4358e7ac1bc4b2f6a8b54400)));
        bytes32 markSlot = bytes32(uint256(base) + 3);
        uint256 mark = uint256(vm.load(address(v), markSlot));
        assertGt(mark, 0);
        vm.store(address(v), markSlot, bytes32(type(uint256).max));
        vm.expectRevert(OstraVaultModuleV5.InLoss.selector);
        v.runOrder(1);
        vm.store(address(v), markSlot, bytes32(mark));
        v.runOrder(1);
        assertGe(IERC20(USDG).balanceOf(address(v)), 20e6);
    }

    /// @dev The agent key's Exit is strict, never in a loss, and at least its minOut, even with the lock off.
    function test_theAgentExitIsAlwaysStrict() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _spend(v, OWNER, 25, abi.encode(K_ERC4626, SPARK, true));
        _spend(v, OWNER, 26, abi.encode(K_ERC4626, SPARK, uint256(50e6), uint256(0)));
        _setPolicy(v, OWNER, _policy(_bits(_one(27)), 0, 0));
        _setAgent(v, OWNER, 30 days);
        uint256 shares = IERC4626Venue(SPARK).balanceOf(address(v));
        _agentRefused(
            v, 27, abi.encode(K_ERC4626, SPARK, uint256(0), uint256(0)), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        _agentRefused(
            v,
            27,
            abi.encode(K_ERC4626, SPARK, shares, uint256(51e6)),
            abi.encodeWithSelector(OstraVaultModuleV5.InsufficientOutput.selector)
        );
        _agent(v, 27, abi.encode(K_ERC4626, SPARK, shares, uint256(49e6)));
        assertGe(IERC20(USDG).balanceOf(address(v)), 99e6);
        assertEq(IERC4626Venue(SPARK).balanceOf(address(v)), 0);
    }

    /// @dev The agent key redeems only from a Morpho vault on its LEND allowlist.
    function test_theAgentRedeemsOnlyFromAnAllowedVault() public {
        OstraVault v = _vault(OWNER);
        _setPolicy(v, OWNER, _policy(_bits(_one(18)), 0, 0));
        _setAgent(v, OWNER, 30 days);
        _agentRefused(
            v,
            18,
            abi.encode(STRANGER, uint256(1), uint256(0)),
            abi.encodeWithSelector(OstraVaultModuleV5.NotAllowlisted.selector, OstraVaultV5.ALLOW_LEND)
        );
    }

    /// @dev An implementation is refused when its module V5 names another module V4.
    // ---------------------------------------------------------------------------------------------
    // Review fixes (round 2 and the review of the live code)
    // ---------------------------------------------------------------------------------------------

    /// @dev A spend naming a zero next key is refused after its signature is checked (it would end the vault's key for
    ///      good). One naming the agent key's root lands and ends the agent key: the agent key may have copied the next
    ///      root of an owner spend seen in flight, and must not be able to hold that spend.
    function test_theOwnersNextRootIsNotZeroAndEndsAnAgentKeyOfTheSameRoot() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 10e6);
        _setPolicy(v, OWNER, _policy(_bits(_one(0)), 5e6, 5e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _setAgent(v, OWNER, 30 days);
        bytes memory params = abi.encode("ipfs://profile");
        uint64 n = v.nonce();
        bytes32 owners = v.keyRoot();
        bytes memory sig = WotsSigner.sign(_seed(OWNER, n), v.spendMessage(10, bytes32(0), params));
        vm.expectRevert(OstraVault.BadParams.selector);
        vm.prank(SUBMITTER, SUBMITTER);
        v.spend(10, bytes32(0), params, sig);
        assertEq(v.nonce(), n);
        assertEq(v.keyRoot(), owners);

        // The owner signs a spend naming its next root N; the agent key, having seen it, rotates its own key to N.
        (bytes32 next, bytes memory ownerSig) = _signed(v, OWNER, 10, params);
        uint64 a = _agentNonce(v);
        bytes memory pay = abi.encode(PAYEE, uint256(1e6));
        bytes memory agentSig = WotsSigner.sign(_seed(AGENT, a), v.agentSpendMessage(0, next, pay));
        vm.prank(SUBMITTER, SUBMITTER);
        v.spendAsAgent(0, next, pay, agentSig);
        (bytes32 agentRoot,,,,) = v.agentKey();
        assertEq(agentRoot, next);
        // The owner's spend still lands, and ends the agent key.
        vm.expectEmit(address(v));
        emit OstraVaultV5.AgentKeyRevoked(address(v));
        vm.prank(SUBMITTER, SUBMITTER);
        v.spend(10, next, params, ownerSig);
        assertEq(v.keyRoot(), next);
        assertFalse(_agentInForce(v));
        (agentRoot,,,,) = v.agentKey();
        assertEq(agentRoot, bytes32(0));
        _spend(v, OWNER, 10, params);
        assertEq(v.nonce(), n + 2);
    }

    /// @dev Under the lock the crank can only be removed: by the owner's SetCrankKey(0), by a guardian or the
    ///      withdrawal address (guard op 8), or by a guardian vault's Guard spend.
    function test_underTheLockTheCrankCanOnlyBeRemoved() public {
        OstraVault g = _vault(GUARD_VAULT);
        address crank1 = makeAddr("crank 1");

        (OstraVault v, bytes32 k) = _lockedWithCrank(1, address(g), crank1);
        _refused(v, k, 2, abi.encode(makeAddr("crank 2")), abi.encodeWithSelector(OstraVault.Locked.selector));
        _spend(v, k, 2, abi.encode(address(0)));
        assertEq(v.crank(), address(0));

        (v,) = _lockedWithCrank(2, address(g), crank1);
        vm.expectRevert(OstraVault.NotGuardian.selector);
        vm.prank(STRANGER);
        v.guard(8, "");
        vm.expectRevert(OstraVault.BadParams.selector);
        vm.prank(GUARDIAN);
        v.guard(8, hex"00");
        vm.expectEmit(address(v));
        emit OstraVault.CrankChanged(address(0));
        vm.prank(GUARDIAN);
        v.guard(8, "");
        assertEq(v.crank(), address(0));

        (v,) = _lockedWithCrank(3, address(g), crank1);
        vm.prank(WITHDRAWAL);
        v.guard(8, "");
        assertEq(v.crank(), address(0));

        (v,) = _lockedWithCrank(4, address(g), crank1);
        _refused(
            g, GUARD_VAULT, 24, abi.encode(address(v), uint8(8), bytes32(0), uint256(1)), abi.encodeWithSelector(OstraVaultModuleV5.BadParams.selector)
        );
        vm.expectEmit(address(g));
        emit OstraVaultModuleV5Events.Guarded(address(v), 8, true, bytes4(0));
        _spend(g, GUARD_VAULT, 24, abi.encode(address(v), uint8(8), bytes32(0), uint256(0)));
        assertEq(v.crank(), address(0));
    }

    /// @dev A fresh vault with crank `c`, guardians GUARDIAN and `guardVault`, then the lock turned on.
    function _lockedWithCrank(uint256 i, address guardVault, address c) internal returns (OstraVault v, bytes32 k) {
        k = keccak256(abi.encode("OSTRA/EVM/TEST/v5-crank", i));
        v = _vault(k);
        _spend(v, k, 2, abi.encode(c));
        assertEq(v.crank(), c);
        // Not under the lock: guard op 8 is refused as every guard op.
        vm.expectRevert(OstraVault.Locked.selector);
        vm.prank(GUARDIAN);
        v.guard(8, "");
        _spend(v, k, 6, abi.encode(guardVault, true));
        _lock(v, k, 1e6);
        assertEq(v.crank(), c);
    }

    /// @dev Turning the lock on ends the agent key and the orders it set; the owner's orders stay.
    function test_turningTheLockOnEndsTheAgentKeyAndItsOrders() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        _setPolicy(v, OWNER, _policy(_bits(_two(0, 33)), 5e6, 50e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _setAgent(v, OWNER, 30 days);
        _agent(v, 33, abi.encode(_pay(PAYEE, 1e6, 10)));
        _spend(v, OWNER, 33, abi.encode(_pay(PAYEE, 1e6, 10)));
        _lock(v, OWNER, 50e6);
        assertFalse(_agentInForce(v));
        (, bool live) = v.order(1);
        assertFalse(live);
        vm.expectRevert(OstraVaultModuleV5.NoOrder.selector);
        v.runOrder(1);
        v.runOrder(2);
        assertEq(IERC20(USDG).balanceOf(PAYEE), 1e6);
        // A later lock change (it waits under the lock) does not end a key set under the lock.
        _setAgent(v, OWNER, 30 days);
        vm.warp(block.timestamp + DELAY);
        assertTrue(_agentInForce(v));
        _spend(v, OWNER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(40e6)));
        assertTrue(_agentInForce(v));
    }

    /// @dev The agent key claims dividends only to this vault or its linked vault.
    function test_theAgentClaimsDividendsOnlyToTheVaultOrItsLink() public {
        OstraVault v = _vault(OWNER);
        _setPolicy(v, OWNER, _policy(_bits(_one(5)), 0, 0));
        _setAgent(v, OWNER, 30 days);
        _agentRefused(v, 5, abi.encode(STRANGER), abi.encodeWithSelector(OstraVaultModuleV5.NotLinked.selector));
        _agentRefused(v, 5, abi.encode(PAYEE), abi.encodeWithSelector(OstraVaultModuleV5.NotLinked.selector));
        // The allowlist of recipients does not open it.
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _agentRefused(v, 5, abi.encode(PAYEE), abi.encodeWithSelector(OstraVaultModuleV5.NotLinked.selector));
    }

    /// @dev The agent key cancels only orders an agent key set, one at a time.
    function test_theAgentCancelsOnlyItsOwnOrders() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        uint8[] memory acts = new uint8[](3);
        (acts[0], acts[1], acts[2]) = (0, 33, 34);
        _setPolicy(v, OWNER, _policy(_bits(acts), 5e6, 50e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(PAYEE));
        _setAgent(v, OWNER, 30 days);
        _spend(v, OWNER, 33, abi.encode(_pay(PAYEE, 1e6, 10)));
        _agent(v, 33, abi.encode(_pay(PAYEE, 1e6, 10)));
        bytes memory notAllowed = abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 34);
        _agentRefused(v, 34, abi.encode(uint256(1)), notAllowed);
        _agentRefused(v, 34, abi.encode(uint256(0)), notAllowed);
        _agent(v, 34, abi.encode(uint256(2)));
        (, bool live) = v.order(2);
        assertFalse(live);
        (, live) = v.order(1);
        assertTrue(live);
        // An order already gone (cancelled, run out, never set) is nothing to do: the agent's spend lands, so its key
        // never waits on a cancel that cannot land.
        _agent(v, 34, abi.encode(uint256(2)));
        _agent(v, 34, abi.encode(uint256(99)));
        _agent(v, 33, abi.encode(_pay(PAYEE, 1e6, 1)));
        v.runOrder(3);
        (, live) = v.order(3);
        assertFalse(live);
        _agent(v, 34, abi.encode(uint256(3)));
        // Once the owner cancels its own order, the agent may name it too.
        _spend(v, OWNER, 34, abi.encode(uint256(1)));
        _agent(v, 34, abi.encode(uint256(1)));
    }

    /// @dev A failed swap signed by the agent key never lands: it reverts and keeps the agent's key and budget.
    function test_aFailedAgentSwapRevertsAndKeepsTheKeyAndBudget() public {
        OstraVault v = _vault(OWNER);
        deal(USDG, address(v), 100e6);
        address to = makeAddr("agent eth payee");
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(USDG),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(0))
        });
        _setPolicy(v, OWNER, _policy(_bits(_one(3)), 10e6, 20e6));
        _allow(v, OWNER, OstraVaultV5.ALLOW_POOL, PoolId.unwrap(PoolIdLibrary.toId(key)));
        _allow(v, OWNER, OstraVaultV5.ALLOW_RECIPIENT, _addr(to));
        _setAgent(v, OWNER, 30 days);
        uint256 budget = v.budgetAvailable();
        _agentRefused(
            v,
            3,
            abi.encode(key, false, uint128(5e6), type(uint128).max, to, address(0), uint32(1_000_000)),
            abi.encodeWithSelector(OstraVault.InsufficientOutput.selector)
        );
        assertEq(v.budgetAvailable(), budget);
        assertEq(IERC20(USDG).balanceOf(address(v)), 100e6);
        _agent(v, 3, abi.encode(key, false, uint128(5e6), uint128(1), to, address(0), uint32(1_000_000)));
        assertGt(to.balance, 0);
        assertEq(v.budgetAvailable(), budget - 5e6);
        assertEq(IERC20(USDG).balanceOf(address(v)), 95e6);
    }

    /// @dev The agent key may freeze a line it backs, never reopen one; while a recovery waits under the lock, the
    ///      root opens no new line and adds to none.
    function test_theAgentFreezesOnlyAndARecoveryStopsNewLines() public {
        Credit memory c = _credit();
        OstraVaultV5.Policy memory p = _rootPolicy();
        p.actions = _bits(_one(44));
        _setPolicy(c.root, ROOT_OWNER, p);
        _setAgent(c.root, ROOT_OWNER, 30 days);
        _agentRefused(
            c.root, 44, abi.encode(c.agentId, false), abi.encodeWithSelector(OstraVaultModuleV5.NotAllowed.selector, 44)
        );
        // With no loan open, a freeze ends the sponsorship (the pool's own rule).
        _agent(c.root, 44, abi.encode(c.agentId, true));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).delegatedIn, 0);
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).sponsor, 0);
        // The borrower consents again and the root sponsors it again.
        uint256 deadline = block.timestamp + 1 days;
        _spend(c.borrower, OWNER, 37, abi.encode(c.agentId, c.rootId, uint256(0), deadline));
        _sponsor(c, 10e6, deadline);
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).delegatedIn, 10e6);

        _spend(c.root, ROOT_OWNER, 6, abi.encode(GUARDIAN, true));
        _spend(c.root, ROOT_OWNER, 7, abi.encode(uint8(1), uint32(36 hours)));
        _spend(c.root, ROOT_OWNER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(50e6)));
        vm.prank(GUARDIAN);
        c.root.supportRecovery(keccak256("new seed"));
        _failed(
            c.root, ROOT_OWNER, 42, abi.encode(c.rootId, c.agentId, uint256(1e6)), abi.encodeWithSelector(OstraVaultModuleV5.Locked.selector)
        );
        OstraVaultModuleV5.SponsorParams memory s = _sponsorParams(c, 1e6, block.timestamp + 1 days);
        _failed(c.root, ROOT_OWNER, 41, abi.encode(s), abi.encodeWithSelector(OstraVaultModuleV5.Locked.selector));
        _failed(
            c.root, ROOT_OWNER, 44, abi.encode(c.agentId, false), abi.encodeWithSelector(OstraVaultModuleV5.Locked.selector)
        );
        // Closing a line still works.
        _spend(c.root, ROOT_OWNER, 44, abi.encode(c.agentId, true));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).delegatedIn, 0);
    }

    /// @dev The withdrawal address must have code when it is chosen: a plain key, or an Ostra vault not created yet
    ///      (which anyone could create, unlocked, after a stolen seed sent everything there), is refused.
    function test_aWithdrawalAddressWithNoCodeIsRefused() public {
        OstraVault v = _vault(OWNER);
        bytes memory noCode = abi.encodeWithSelector(OstraVault.WithdrawalHasNoCode.selector);
        _refused(v, OWNER, 14, abi.encode(makeAddr("plain key"), DELAY, uint128(1e6)), noCode);
        address later = factory.vaultAddress(USDG, WotsSigner.keyRoot(_seed(GUARD_VAULT, 0)), address(0));
        assertEq(later.code.length, 0);
        _refused(v, OWNER, 14, abi.encode(later, DELAY, uint128(1e6)), noCode);
        // A Safe, or an Ostra vault that exists, is accepted.
        _spend(v, OWNER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        assertTrue(v.lockActive());
        // Under the lock, a change to an address with no code is refused before it can wait.
        _refused(v, OWNER, 14, abi.encode(later, DELAY, uint128(1e6)), noCode);
        OstraVault w = _vault(GUARD_VAULT);
        assertEq(address(w), later);
        _spend(v, OWNER, 14, abi.encode(address(w), DELAY, uint128(1e6)));
        // Turning the lock off (all zero) is still a change that waits, not refused.
        _spend(v, OWNER, 14, abi.encode(address(0), uint32(0), uint128(0)));
    }

    /// @dev A RootSponsor that raises the premium on a line the root already backs counts the higher premium on the
    ///      whole line (every later loan on it pays it), against the lock and the agent budget.
    function test_aPremiumRaiseOnAnExistingLineCounts() public {
        Credit memory c = _credit();
        OstraVaultV5.Policy memory p = _rootPolicy();
        p.maxPremiumBps = 100;
        _setPolicy(c.root, ROOT_OWNER, p);
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).delegatedIn, 10e6);
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).premiumBps, 0);
        _spend(c.root, ROOT_OWNER, 6, abi.encode(GUARDIAN, true));
        _spend(c.root, ROOT_OWNER, 14, abi.encode(WITHDRAWAL, DELAY, uint128(1e6)));
        uint256 available = c.root.outflowAvailable();

        // The borrower's policy allows a consent to a premium of up to 1.5% per 30 days.
        OstraVaultV5.Policy memory bp = _loanPolicy(10e6);
        bp.maxFeeBps = 150;
        _setPolicy(c.borrower, OWNER, bp);
        uint256 deadline = block.timestamp + 1 days;
        _spend(c.borrower, OWNER, 37, abi.encode(c.agentId, c.rootId, uint256(100), deadline));
        OstraVaultModuleV5.SponsorParams memory s = _sponsorParams(c, 0, deadline);
        s.premiumBps = 100;
        s.maxPremiumBps = 100;
        IPriorsPool.Params memory pp = IPriorsPool(POOL).getParams();
        uint256 raise = 10e6 * 100 * pp.maxTerm / (10_000 * 30 days);
        assertGt(raise, 0);
        _spend(c.root, ROOT_OWNER, 41, abi.encode(s));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).premiumBps, 100);
        assertEq(available - c.root.outflowAvailable(), raise);

        // The same through the agent key: the raise counts against its budget.
        p.actions = _bits(_one(41));
        p.perTx = 1e6;
        p.daily = 1e6;
        _setPolicy(c.root, ROOT_OWNER, p);
        _allow(c.root, ROOT_OWNER, OstraVaultV5.ALLOW_BORROWER, bytes32(c.agentId));
        _setAgent(c.root, ROOT_OWNER, 30 days);
        vm.warp(block.timestamp + DELAY);
        assertTrue(_agentInForce(c.root));
        (p,,) = c.root.policy();
        assertEq(p.actions, _bits(_one(41)));
        uint256 budget = c.root.budgetAvailable();
        deadline = block.timestamp + 1 days;
        _spend(c.borrower, OWNER, 37, abi.encode(c.agentId, c.rootId, uint256(150), deadline));
        s = _sponsorParams(c, 0, deadline);
        s.premiumBps = 100;
        s.maxPremiumBps = 150;
        // Same premium: nothing more at risk, nothing counted.
        _agent(c.root, 41, abi.encode(s));
        assertEq(c.root.budgetAvailable(), budget);
    }

    /// @dev Once the borrower leaves, the root's signed RootUnvouch and RootFreeze land and do nothing, and so does a
    ///      second PriorsLeave: no other party can hold a signed key on a sponsorship that is gone.
    function test_spendsOnASponsorshipAlreadyGoneLandAndDoNothing() public {
        Credit memory c = _credit();
        (bytes32 nextU, bytes memory sigU) = _signed(c.root, ROOT_OWNER, 43, abi.encode(c.rootId, c.agentId, uint256(1e6)));
        _spend(c.borrower, OWNER, 38, abi.encode(c.agentId));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).sponsor, 0);
        uint64 n = c.root.nonce();
        vm.prank(SUBMITTER, SUBMITTER);
        c.root.spend(43, nextU, abi.encode(c.rootId, c.agentId, uint256(1e6)), sigU);
        assertEq(c.root.nonce(), n + 1);
        _spend(c.root, ROOT_OWNER, 44, abi.encode(c.agentId, true));
        assertEq(c.root.nonce(), n + 2);
        _spend(c.borrower, OWNER, 38, abi.encode(c.agentId));
        // A RootSponsor whose consent was used meanwhile lands and does nothing.
        uint256 deadline = block.timestamp + 1 days;
        _spend(c.borrower, OWNER, 37, abi.encode(c.agentId, c.rootId, uint256(0), deadline));
        OstraVaultModuleV5.SponsorParams memory s = _sponsorParams(c, 10e6, deadline);
        (bytes32 nextS, bytes memory sigS) = _signed(c.root, ROOT_OWNER, 41, abi.encode(s));
        _spend(c.root, ROOT_OWNER, 41, abi.encode(s));
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).delegatedIn, 10e6);
        // The same bytes again are not valid (the key moved on); a new spend naming the used consent lands as nothing.
        vm.expectRevert();
        vm.prank(SUBMITTER, SUBMITTER);
        c.root.spend(41, nextS, abi.encode(s), sigS);
        uint256 out = IPriorsPool(POOL).getAgent(c.rootId).delegatedOut;
        _spend(c.root, ROOT_OWNER, 41, abi.encode(s));
        assertEq(IPriorsPool(POOL).getAgent(c.rootId).delegatedOut, out);
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).delegatedIn, 10e6);
    }

    /// @dev A failed owner Priors spend lands only when sent on its own (a transaction's own call from an account with
    ///      no code); from a contract it reverts and keeps the key, and the same bytes can then be sent on their own.
    ///      A sponsor freezing the line after the borrower signed cannot hold the borrower's key.
    function test_aFailedPriorsSpendLandsOnlyWhenSentOnItsOwn() public {
        Credit memory c = _credit();
        bytes32[8] memory jobs;
        bytes memory params = abi.encode(c.agentId, uint256(5e6), uint64(7 days), uint256(1e6), jobs);
        (bytes32 next, bytes memory sig) = _signed(c.borrower, OWNER, 35, params);
        // The sponsor freezes the line (nothing drawn: the sponsorship ends) after the borrower signed.
        _spend(c.root, ROOT_OWNER, 44, abi.encode(c.agentId, true));
        uint64 n = c.borrower.nonce();
        vm.expectRevert(abi.encodeWithSelector(OstraVaultModuleV5.NotAllowlisted.selector, OstraVaultV5.ALLOW_SPONSOR));
        c.borrower.spend(35, next, params, sig);
        assertEq(c.borrower.nonce(), n);
        vm.expectEmit(address(c.borrower));
        emit OstraVaultModuleV5.PriorsFailed(35, OstraVaultModuleV5.NotAllowlisted.selector);
        vm.prank(SUBMITTER, SUBMITTER);
        c.borrower.spend(35, next, params, sig);
        assertEq(c.borrower.nonce(), n + 1);
        assertEq(IERC20(USDG).balanceOf(address(c.borrower)), 1e6);
        assertEq(IPriorsPool(POOL).getAgent(c.agentId).principalOut, 0);
    }

    /// @dev A loan repaid on the pool by someone else is no longer the vault's own: repayDue clears it (LoanCleared) and
    ///      pays nothing, and so does the owner's PriorsRepay of a second such loan.
    function test_aLoanRepaidElsewhereIsClearedAndNeverPaidAgain() public {
        Credit memory c = _credit();
        deal(USDG, address(c.borrower), 6e6);
        uint256 loanId = _borrow(c.borrower, OWNER, c.agentId, 5e6, 7 days);
        assertTrue(c.borrower.ownLoan(loanId));
        IPriorsPool.Loan memory ln = IPriorsPool(POOL).getLoan(loanId);
        uint256 due = ln.principal + ln.fee;
        deal(USDG, STRANGER, due);
        vm.startPrank(STRANGER);
        IERC20(USDG).approve(POOL, due);
        IPoolRepay(POOL).repay(loanId, c.agentId, due);
        vm.stopPrank();
        uint256 balance = IERC20(USDG).balanceOf(address(c.borrower));
        vm.warp(ln.dueAt - 1 hours);
        vm.expectEmit(address(c.borrower));
        emit OstraVaultModuleV5.LoanCleared(loanId, IPriorsPool(POOL).getLoan(loanId).status);
        c.borrower.repayDue(loanId);
        assertFalse(c.borrower.ownLoan(loanId));
        assertEq(IERC20(USDG).balanceOf(address(c.borrower)), balance);

        uint256 second = _borrow(c.borrower, OWNER, c.agentId, 5e6, 7 days);
        ln = IPriorsPool(POOL).getLoan(second);
        due = ln.principal + ln.fee;
        deal(USDG, STRANGER, due);
        vm.startPrank(STRANGER);
        IERC20(USDG).approve(POOL, due);
        IPoolRepay(POOL).repay(second, c.agentId, due);
        vm.stopPrank();
        balance = IERC20(USDG).balanceOf(address(c.borrower));
        vm.expectEmit(address(c.borrower));
        emit OstraVaultModuleV5.LoanCleared(second, IPriorsPool(POOL).getLoan(second).status);
        _spend(c.borrower, OWNER, 36, abi.encode(second, uint256(10e6)));
        assertFalse(c.borrower.ownLoan(second));
        assertEq(IERC20(USDG).balanceOf(address(c.borrower)), balance);
    }

    /// @dev Robinhood Chain's own contract code size limit, read on chain on 3 Nov 2026 (eth_estimateGas of a creation:
    ///      98,304 bytes of runtime code accepted, 98,305 refused), not EIP-170's 24,576: OstraVault and
    ///      OstraVaultModuleV5 are above the latter. Their creation code stays within twice that (EIP-3860's ratio).
    ///      Checked here rather than with foundry.toml's code_size_limit, which Foundry also applies to the test contracts.
    function test_theVersion5ContractsFitRobinhoodChainsCodeSizeLimit() public view {
        OstraVault implementation = OstraVault(UpgradeableBeacon(factory.BEACON()).implementation());
        assertLe(address(implementation).code.length, 98_304);
        assertLe(address(m5).code.length, 98_304);
        assertLe(vm.getCode("OstraVault.sol:OstraVault").length, 2 * 98_304);
        assertLe(vm.getCode("OstraVaultModuleV5.sol:OstraVaultModuleV5").length, 2 * 98_304);
        assertGt(address(implementation).code.length, 24_576);
    }

    function test_theImplementationRefusesAModuleV5OfAnotherModuleV4() public {
        OstraVault live = OstraVault(UpgradeableBeacon(factory.BEACON()).implementation());
        OstraVaultModuleV5 other = VaultStack.moduleV5(address(factory), live.MODULE());
        (address registry, address m3, address m4) = (address(live.REGISTRY()), live.MODULE(), live.MODULE_V4());
        vm.expectRevert(OstraVault.BadParams.selector);
        VaultStack.implementation(registry, m3, m4, address(other));
    }
}

struct MarketParamsLite {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @notice The pool views the tests read that the module's interface does not name.
interface IPriorsPoolCount {
    function loanCount() external view returns (uint256);
}

interface IPoolRepay {
    function repay(uint256 loanId, uint256 expectedAgentId, uint256 maxDue) external;
}

interface IPoolShares {
    function rootShares(uint256 rootId) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

interface IIdentityRegister {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

/// @notice OstraVaultModule's Guarded event, for expectEmit.
library OstraVaultModuleV5Events {
    event Guarded(address indexed vault, uint8 op, bool ok, bytes4 reason);
}
