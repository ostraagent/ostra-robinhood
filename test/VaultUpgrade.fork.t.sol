// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {OstraVault} from "../src/OstraVault.sol";
import {OstraVaultFactory} from "../src/OstraVaultFactory.sol";
import {OstraVaultModuleV5} from "../src/OstraVaultModuleV5.sol";
import {OstraVaultV3} from "../src/OstraVaultV3.sol";
import {OstraVaultV5} from "../src/OstraVaultV5.sol";
import {LiveVaults} from "./utils/LiveVaults.sol";
import {VaultStack} from "./utils/VaultStack.sol";
import {WotsSigner} from "./utils/WotsSigner.sol";
import {SafeWallet} from "./utils/SafeWallet.sol";

/// @notice The upgrade of the live vault beacon from version 4 to version 5 on a fork of Robinhood Chain mainnet, as
///         OstraUpgradeOwner runs it once its 72-hour delay has passed: the version 5 implementation keeps the live
///         OstraVaultModule and OstraVaultModuleV4 (their deployed code, unchanged) and the live externals, and adds
///         OstraVaultModuleV5. Every vault the live factory made keeps its token, key, nonce, crank, guardians,
///         recovery, lock, link and balance, starts version 5 with no agent key, no policy and no order, and a vault the
///         factory makes after the upgrade spends under version 4's and version 5's rules.
contract VaultUpgradeForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev The live deployment (deployments/robinhood-mainnet.json).
    address internal constant VAULT_BEACON = 0xE9F525B9EaeE48d13AEd28fE146F48f2832a18a0;
    address internal constant VAULT_FACTORY = 0x043a15c514CFE2c797d33520bFF91a5DCdbf2979;
    address internal constant VAULT_V4 = 0x8D16fd326b7d4f3D69A3c8d5efbeCCb25d29769a;
    address internal constant VAULT_MODULE = 0x405A0e88e3929A7A9EE01a5169DCd1D02d95C5EC;
    address internal constant VAULT_MODULE_V4 = 0x8Bd6321Fe66cF9c62DEF909092dDC3bbadDd72a2;
    address internal constant UPGRADE_OWNER = 0x55533a51d9bd9b06F2D179d919BB31995EF96E5e;
    address internal constant SPARK = 0xde770c84FE66E063336b31737cFE9790f18c4087;

    bytes32 internal constant MASTER = keccak256("OSTRA/EVM/TEST/master");
    bytes32 internal constant KEYCHAIN = keccak256("OSTRA/EVM/TEST/upgrade-vault-v5");
    bytes32 internal constant AGENT = keccak256("OSTRA/EVM/TEST/upgrade-vault-v5-agent");
    address internal constant SUBMITTER = address(0x5EB);
    address internal constant PAYEE = address(0xBEEF);
    bytes32 internal constant LOCKED = keccak256("OSTRA/EVM/TEST/upgrade-vault-v5-locked");
    uint32 internal constant DELAY = 36 hours;

    struct Kept {
        address token;
        bytes32 initialKeyRoot;
        bytes32 keyRoot;
        uint64 nonce;
        address crank;
        uint32 recoveryRound;
        uint8 guardianCount;
        uint8 recoveryThreshold;
        uint32 recoveryDelay;
        bool lockActive;
        address linkedVault;
        uint256 outflowAvailable;
        uint256 balance;
    }

    function _seed(bytes32 keychain, uint64 index) internal pure returns (bytes32) {
        return WotsSigner.deriveSeed(MASTER, keychain, index);
    }

    function _spend(OstraVault vault, bytes32 keychain, uint8 action, bytes memory params) internal {
        uint64 n = vault.nonce();
        bytes32 next = WotsSigner.keyRoot(_seed(keychain, n + 1));
        bytes memory signature = WotsSigner.sign(_seed(keychain, n), vault.spendMessage(action, next, params));
        vm.prank(SUBMITTER, SUBMITTER);
        vault.spend(action, next, params, signature);
    }

    function _kept(OstraVault v) internal view returns (Kept memory k) {
        k.token = address(v.token());
        k.initialKeyRoot = v.initialKeyRoot();
        k.keyRoot = v.keyRoot();
        k.nonce = v.nonce();
        k.crank = v.crank();
        k.recoveryRound = v.recoveryRound();
        k.guardianCount = v.guardianCount();
        k.recoveryThreshold = v.recoveryThreshold();
        k.recoveryDelay = v.recoveryDelay();
        k.lockActive = v.lockActive();
        k.linkedVault = v.linkedVault();
        k.outflowAvailable = v.outflowAvailable();
        k.balance = IERC20(k.token).balanceOf(address(v));
    }

    /// @dev The upgrade, as the scheduled call executes it: the live modules and externals, and a new module V5 bound to
    ///      the live factory and the live module V4.
    function _upgrade() internal returns (OstraVaultModuleV5 m5) {
        UpgradeableBeacon beacon = UpgradeableBeacon(VAULT_BEACON);
        OstraVault live = OstraVault(VAULT_V4);
        m5 = VaultStack.moduleV5(VAULT_FACTORY, VAULT_MODULE_V4);
        OstraVault v5 = new OstraVault(
            OstraVault.Externals({
                batchSettlement: address(live.BATCH_SETTLEMENT()),
                poolManager: address(live.POOL_MANAGER()),
                registry: address(live.REGISTRY()),
                identityRegistry: address(live.IDENTITY_REGISTRY()),
                module: VAULT_MODULE,
                moduleV4: VAULT_MODULE_V4,
                moduleV5: address(m5)
            })
        );
        vm.prank(UPGRADE_OWNER);
        beacon.upgradeTo(address(v5));
        assertEq(beacon.implementation(), address(v5));
    }

    /// @dev A lock chosen under version 4 with a withdrawal address that has no code stays after the upgrade and can
    ///      still be tightened; a new withdrawal address with no code is refused, one with code is accepted (and, as a
    ///      change of withdrawal address, waits the delay).
    function test_aVersion4LockWithACodelessWithdrawalCanStillBeTightened() public {
        vm.createSelectFork("robinhood");
        assertEq(UpgradeableBeacon(VAULT_BEACON).implementation(), VAULT_V4);
        OstraVault v =
            OstraVault(OstraVaultFactory(VAULT_FACTORY).createVault(USDG, WotsSigner.keyRoot(_seed(LOCKED, 0)), address(0)));
        assertEq(v.VERSION(), 4);
        address plain = makeAddr("plain key");
        assertEq(plain.code.length, 0);
        _spend(v, LOCKED, 14, abi.encode(plain, DELAY, uint128(10e6)));
        assertTrue(v.lockActive());

        _upgrade();
        assertEq(v.VERSION(), 5);
        assertEq(v.withdrawalLock().withdrawal, plain);
        // Tightening (same withdrawal, a lower limit) is at once.
        _spend(v, LOCKED, 14, abi.encode(plain, DELAY, uint128(5e6)));
        assertEq(v.withdrawalLock().dailyLimit, 5e6);
        // Another address with no code is refused, and the key stays.
        uint64 n = v.nonce();
        bytes memory params = abi.encode(makeAddr("another plain key"), DELAY, uint128(5e6));
        bytes32 next = WotsSigner.keyRoot(_seed(LOCKED, n + 1));
        bytes memory signature = WotsSigner.sign(_seed(LOCKED, n), v.spendMessage(14, next, params));
        vm.expectRevert(OstraVault.WithdrawalHasNoCode.selector);
        vm.prank(SUBMITTER, SUBMITTER);
        v.spend(14, next, params, signature);
        assertEq(v.nonce(), n);
        // A Safe is accepted: a new withdrawal address waits the delay.
        address safe = SafeWallet.create(makeAddr("withdrawal owner"), 1);
        _spend(v, LOCKED, 14, abi.encode(safe, DELAY, uint128(5e6)));
        assertEq(v.withdrawalLock().withdrawal, plain);
        vm.warp(block.timestamp + DELAY);
        assertEq(v.withdrawalLock().withdrawal, safe);
    }

    function test_theLiveVaultBeaconUpgradesToVersion5AndKeepsEveryVault() public {
        vm.createSelectFork("robinhood");
        UpgradeableBeacon beacon = UpgradeableBeacon(VAULT_BEACON);
        assertEq(beacon.owner(), UPGRADE_OWNER);
        assertEq(beacon.implementation(), VAULT_V4);
        assertEq(OstraVaultFactory(VAULT_FACTORY).BEACON(), VAULT_BEACON);
        OstraVault live = OstraVault(VAULT_V4);
        assertEq(live.VERSION(), 4);
        assertEq(live.MODULE(), VAULT_MODULE);
        assertEq(live.MODULE_V4(), VAULT_MODULE_V4);

        address[] memory vaults = LiveVaults.all();
        Kept[] memory before = new Kept[](vaults.length);
        for (uint256 i = 0; i < vaults.length; ++i) {
            assertEq(OstraVaultFactory(VAULT_FACTORY).vaultAddress(
                address(OstraVault(vaults[i]).token()), OstraVault(vaults[i]).initialKeyRoot(), OstraVault(vaults[i]).initialCrank()
            ), vaults[i]);
            assertEq(OstraVault(vaults[i]).VERSION(), 4);
            before[i] = _kept(OstraVault(vaults[i]));
        }

        OstraVaultModuleV5 m5 = _upgrade();

        for (uint256 i = 0; i < vaults.length; ++i) {
            OstraVault v = OstraVault(vaults[i]);
            assertEq(v.VERSION(), 5);
            assertEq(v.MODULE(), VAULT_MODULE);
            assertEq(v.MODULE_V4(), VAULT_MODULE_V4);
            assertEq(v.MODULE_V5(), address(m5));
            assertEq(abi.encode(_kept(v)), abi.encode(before[i]));
            (bytes32 root, uint64 agentNonce,,, bool inForce) = v.agentKey();
            assertEq(root, bytes32(0));
            assertEq(agentNonce, 0);
            assertFalse(inForce);
            (OstraVaultV5.Policy memory p,, uint64 pendingAt) = v.policy();
            assertEq(abi.encode(p), abi.encode(OstraVaultV5.Policy(0, 0, 0, 0, 0, 0, 0, 0, 0, address(0), 0, 0, 0)));
            assertEq(pendingAt, 0);
            assertEq(v.orderCount(), 0);
            assertEq(v.budgetAvailable(), 0);
        }

        // A vault the live factory makes after the upgrade sits where it always would have, and spends under every
        // version's rules: a version 4 venue, then an agent key within a policy.
        address fresh = OstraVaultFactory(VAULT_FACTORY).createVault(USDG, WotsSigner.keyRoot(_seed(KEYCHAIN, 0)), address(0));
        assertEq(fresh, OstraVaultFactory(VAULT_FACTORY).vaultAddress(USDG, WotsSigner.keyRoot(_seed(KEYCHAIN, 0)), address(0)));
        OstraVault f = OstraVault(fresh);
        assertEq(f.VERSION(), 5);
        deal(USDG, fresh, 20e6);
        _spend(f, KEYCHAIN, 25, abi.encode(uint8(3), SPARK, true));
        _spend(f, KEYCHAIN, 26, abi.encode(uint8(3), SPARK, uint256(5e6), uint256(0)));
        assertEq(IERC20(USDG).balanceOf(fresh), 15e6);
        OstraVaultV5.Policy memory policy;
        policy.actions = uint64(1);
        policy.perTx = 1e6;
        policy.daily = 2e6;
        _spend(f, KEYCHAIN, 29, abi.encode(policy));
        _spend(f, KEYCHAIN, 30, abi.encode(uint8(1), bytes32(uint256(uint160(PAYEE))), true));
        _spend(f, KEYCHAIN, 31, abi.encode(WotsSigner.keyRoot(_seed(AGENT, 1)), uint64(block.timestamp + 7 days)));
        bytes memory params = abi.encode(PAYEE, uint256(1e6));
        bytes32 next = WotsSigner.keyRoot(_seed(AGENT, 2));
        bytes memory signature = WotsSigner.sign(_seed(AGENT, 1), f.agentSpendMessage(0, next, params));
        uint256 paid = IERC20(USDG).balanceOf(PAYEE);
        f.spendAsAgent(0, next, params, signature);
        assertEq(IERC20(USDG).balanceOf(PAYEE), paid + 1e6);
        OstraVaultV3.LockConfig memory l = f.withdrawalLock();
        assertEq(l.withdrawal, address(0));
    }
}
