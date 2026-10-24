// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {Wots} from "./Wots.sol";
import {OstraVaultV3} from "./OstraVaultV3.sol";
import {IX402BatchSettlement} from "./interfaces/IX402BatchSettlement.sol";

/// @notice What a ConfigurePool spend calls (OstraHook.configure; PoolId is a bytes32).
interface IOstraPoolSettings {
    function configure(bytes32 poolId, uint8 field, uint256 value) external;
}

/// @notice What a DevBuy spend asks of the OstraDevBuy contract that calls it (OstraDevBuy.pendingLaunch).
interface IOstraDevBuyLaunch {
    function pendingLaunch(address vault) external view returns (bytes32);
}

/// @notice What SetProfile and SetTokenMetadata spends call (OstraRegistry).
interface IOstraRegistry {
    function setProfile(string calldata uri) external;
    function setTokenMetadata(address token, bytes32 poolId, string calldata uri) external;
}

/// @notice What RegisterAgent and SetAgentUri spends call: the ERC-8004 Identity Registry.
interface IAgentIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata newURI) external;
}

/// @title OstraVault
/// @notice Holds one token for an agent and spends it only with a rotating WOTS one-time key, the
///         Robinhood Chain port of the Ostra Solana program's Vault (program/src/instructions/vault.rs
///         and channel_ops.rs). Every vault is a beacon proxy made by OstraVaultFactory.
///
/// Spends (anyone may submit; the WOTS signature binds everything that moves value):
/// * 0 Transfer:    params abi.encode(address to, uint256 amount).
/// * 1 OpenChannel: params abi.encode(address payerAuthorizer, address receiver, address receiverAuthorizer,
///                  uint40 withdrawDelay, bytes32 salt, uint128 amount). Deposits `amount` into the
///                  x402BatchSettlement channel {payer: this vault, token: this vault's token, ...}; the vault
///                  itself is the deposit collector, and only for that one deposit. payerAuthorizer (the
///                  channel's voucher key) must not be zero.
/// * 2 SetCrankKey: params abi.encode(address crank). address(0) removes the crank.
/// * 3 Swap:        params abi.encode(PoolKey key, bool zeroForOne, uint128 amountIn, uint128 minOut,
///                  address recipient, address referrer, uint32 swapGas). An exact-input swap of up to `amountIn`
///                  of this vault's token on the Uniswap v4 pool `key`, which must have this vault's token on its
///                  input side. The vault unlocks the PoolManager itself, so the swap's sender (what the pool's hook
///                  sees) is this vault. At least `minOut` of the other currency goes to `recipient` (another
///                  vault, for example); native ETH only to a recipient that accepts it. A non-zero `referrer`
///                  becomes the swap's hookData, abi.encode(referrer), which an OstraHook pool pays a referral on
///                  (OstraHook.referralOwed). The PoolManager call gets exactly `swapGas` (MIN_SWAP_GAS to
///                  MAX_SWAP_GAS, signed: a quote's gas with a margin), whatever gas the spend was sent with; with
///                  less available the spend reverts. A swap that fails inside the PoolManager (below `minOut`,
///                  refused by the pool's hook, such as an Ostra pool's circuit breaker, a token that refuses the
///                  transfer, or more than `swapGas` needed) moves nothing but still uses the spend: the vault emits
///                  SwapFailed with the failure's selector (WrappedError for a hook's or a token's refusal) and the
///                  next key signs again, so a swap whose market moved never holds the key. A spend sent from inside
///                  another PoolManager unlock, and malformed params, revert.
/// * 4 ConfigurePool: params abi.encode(address hook, bytes32 poolId, uint8 field, uint256 value). Calls
///                  hook.configure(poolId, field, value) as this vault: an OstraHook lets a pool's creator vault
///                  change the pool's rules, and only in the traders' favour (OstraHook.configure).
/// * 5 ClaimDividend: params abi.encode(address recipient). Claims the dividends this vault's token (an
///                  OstraToken) owes this vault, to `recipient` (the owner's vault for the dividend token: this vault
///                  only spends its own token). Reverts while nothing is owed, so the signed spend can be sent later.
/// * 6 SetGuardian: params abi.encode(address guardian, bool enabled). Adds or removes a guardian of this vault (any
///                  account; another OstraVault keeps the recovery post-quantum). Removing one may not leave fewer
///                  guardians than the threshold.
/// * 7 SetRecoveryPolicy: params abi.encode(uint8 threshold, uint32 delay). threshold 0 turns recovery off (delay
///                  0); otherwise 1..guardians and MIN_RECOVERY_DELAY <= delay <= MAX_RECOVERY_DELAY.
/// * 8 SupportRecovery: params abi.encode(address vault, bytes32 newKeyRoot). Calls vault.supportRecovery(newKeyRoot)
///                  as this vault, a guardian of `vault`.
/// * 9 DevBuy:      params abi.encode(address devBuy, bytes32 launchHash, uint256 amount). Pays `amount` of this
///                  vault's token (0: none) to `devBuy` for one launch: only `devBuy` itself may send the spend, and
///                  only while it is launching exactly the launch the owner signed (devBuy.pendingLaunch(this vault)
///                  == launchHash, the hash of every launch and dev buy parameter, OstraDevBuy.launchHash). So the
///                  signature, public once sent, can only ever make that launch, whoever submits it.
/// * 10 SetProfile: params abi.encode(string uri). Sets this vault's profile in OstraRegistry (REGISTRY).
/// * 11 SetTokenMetadata: params abi.encode(address token, bytes32 poolId, string uri). Sets a launched token's
///                  metadata in OstraRegistry, which accepts it only from the creator vault of the token's pool.
/// * 12 RegisterAgent: params abi.encode(string uri). Registers this vault as an agent in the ERC-8004 Identity
///                  Registry (IDENTITY_REGISTRY): the vault owns the agent's identity token and is its agentWallet.
/// * 13 SetAgentUri: params abi.encode(uint256 agentId, string uri). Points the identity this vault owns at a
///                  new registration file.
///                  The four call only those two contracts, with no value, and their URIs are 1 to
///                  MAX_URI_LENGTH bytes, ABI-encoded exactly (no trailing bytes). No spend can transfer an
///                  identity token, so an identity stays with the vault that registered it.
/// * 14 SetWithdrawalLock: params abi.encode(address withdrawal, uint32 delay, uint128 dailyLimit). Turns the
///                  withdrawal lock on (withdrawal not zero, MIN_RECOVERY_DELAY <= delay <= MAX_RECOVERY_DELAY) or off
///                  (all three zero). See "Withdrawal lock" below.
/// * 15 CancelPendingChanges: params empty. Drops a lock change and a link change that are still waiting.
/// * 16 SetLinkedVault: params abi.encode(address vault). The owner's other vault that Borrow pays and that
///                  repays this vault's debt (for a stock vault: its USDG vault), or address(0) for none. It must
///                  be a vault OstraVaultFactory made, not this one.
/// * 17 Lend:       params abi.encode(address vault, uint256 assets, uint256 minShares). Deposits `assets` of this
///                  vault's token into a Morpho Vault V2 whose asset it is, for at least `minShares` shares, which
///                  this vault keeps. A vault Borro lists in BorroBuilders goes through BorroBuilders with Borro
///                  code BORRO_CODE; any other vault must be one VaultV2Factory made (isVaultV2).
/// * 18 Redeem:     params abi.encode(address vault, uint256 shares, uint256 minAssets). Redeems `shares` of a Morpho
///                  Vault V2 whose asset is this vault's token, for at least `minAssets`, back to this vault.
/// * 19 PostCollateral: params abi.encode(MarketParams market, uint256 shares). Posts `shares` of the market's
///                  collateral token, which this vault holds, as this vault's collateral on Morpho Blue, only on a
///                  market Borro lists (BorroRouter.listed).
/// * 20 WithdrawCollateral: params abi.encode(MarketParams market, uint256 shares). Takes `shares` of this vault's
///                  collateral back to this vault, on any Morpho Blue market.
/// * 21 Borrow:     params abi.encode(MarketParams market, uint256 assets). Borrows `assets` of the loan token on a
///                  market Borro lists, in this vault's name, paid to the linked vault, whose token it must be.
/// * 22 Repay:      params abi.encode(MarketParams market, uint256 assets, uint256 shares, address onBehalf,
///                  uint256 maxAssets). Repays `assets` or `shares` (one of them zero; never more than the debt there
///                  is now) of the debt of `onBehalf`, a vault OstraVaultFactory made whose linked vault is this one,
///                  in this vault's token, paying at most `maxAssets`. It counts against the lock's daily limit unless
///                  this vault links back to `onBehalf` and, under the lock, `onBehalf` is a locked link (below).
///                  After Borrow and WithdrawCollateral the position's debt is at most half of what the market's
///                  LLTV allows (MAX_LTV_OF_LLTV_BPS), at the market's own oracle price. Every allowance these
///                  spends give is for the amount about to be used, and is set back to zero in the same spend. A
///                  spend 17 to 22 that fails moves nothing but lands (MorphoFailed), as a failed Swap does, when it
///                  is sent on its own (the transaction's own call); inside another contract's call it reverts and
///                  keeps its key, since that call could have set the failure up (a flash loan, a reentrancy lock).
/// * 23 ApproveHash: params abi.encode(bytes32 hash, bool approved). Approves `hash` for EIP-1271
///                  (isValidSignature), or withdraws the approval (nothing to do if it is gone already). A WOTS key
///                  signs once, so this vault never checks a WOTS signature in isValidSignature: each message is
///                  approved by a spend of its own.
/// * 24 Guard:      params abi.encode(address vault, uint8 op, bytes32 arg, uint256 amount). As a guardian or the
///                  withdrawal address of another Ostra vault, calls guard(op, ...) on it (see guard). A call the other
///                  vault refuses lands as Guarded(ok false), and so does a SupportRecovery it refuses (both only when
///                  sent on its own, as a failed Morpho spend).
///
/// Withdrawal lock (optional): a fixed withdrawal address, always reachable at once, and a daily limit on every
/// other outflow, so that a stolen seed cannot empty the vault at once, and its owner can move everything to the
/// withdrawal address. A withdrawal address that is an Ostra vault must hold this vault's token. While it is on:
/// * Transfer to the withdrawal address is free if it keeps what it gets: it is not an Ostra vault, or it is one
///   whose own lock was on when it was chosen and has stayed on (an unlocked vault may share the stolen seed).
///   Transfer elsewhere, every Swap (its input, whatever the recipient: a low minimum could be sandwiched),
///   OpenChannel, DevBuy, Lend into a vault Borro does not list, and a Repay that is not for a locked link count
///   against `dailyLimit`, in this vault's token: at most `dailyLimit` goes out at once, and what was used drains
///   at `dailyLimit` per LIMIT_WINDOW (one day).
/// * A linked vault counts as the owner's own (a locked link) only if its own lock was already on when the link
///   was decided (set at once, or scheduled) and has stayed on since: turning a lock on is at once, so a lock
///   turned on later may be a thief's. Borrow only pays a locked link; ClaimDividend only pays this vault, the
///   withdrawal address (if it keeps what it gets) or a locked link, and never a vault that cannot spend the
///   dividend token. Redeem, PostCollateral and WithdrawCollateral keep the value with the owner.
/// * A change that loosens the lock (another withdrawal address, a shorter delay, a higher limit, turning it off),
///   a new linked vault, and a hash approval take effect only `delay` after they are signed; meanwhile the owner
///   (CancelPendingChanges), any guardian or the withdrawal address (guard, or Guard from a guardian vault) can
///   drop them. A change that only tightens the lock takes effect at once and drops a loosening still waiting.
///   Turning the lock on is at once, and drops every hash approval given before.
/// * A key a thief has taken over (any spend picks the next key) must not end the owner's protection: SetGuardian,
///   SetRecoveryPolicy, SetCrankKey and ConfigurePool are refused, a spend no longer stops a recovery under way, and
///   any guardian or the withdrawal address can bring lent shares and collateral back into the vault and send the
///   whole balance of the token to the withdrawal address (guard). A recovery that reaches its threshold drops the
///   changes and hash approvals waiting, and while it waits nothing new may start waiting. So the guardians can
///   recover the vault to the owner's new seed, and meanwhile the thief gets at most the daily limit. The
///   guardians, whom the lock keeps as they are, have the last word: any one of them can keep dropping the owner's
///   loosening changes, and a threshold of them can recover the vault.
/// Signed message: "OSTRA/VAULT/EVM/v1" || chainid (32) || vault (20) || nonce (8) || nextKeyRoot (32)
///                 || action (1) || params. The key rotates and the nonce advances before any external call,
///                 so a signature can never be used twice. There is no expiry: a spend that did not land is
///                 resubmitted with the same bytes, never signed again.
///
/// Recovery (when the owner has lost the seed): once `recoveryThreshold` guardians support the same new key root,
/// the recovery waits `recoveryDelay`; then anyone may finish it (finishRecovery), or the new seed's first spend, signed
/// by that root, finishes it itself (not under the withdrawal lock: there finishRecovery comes first, and only then does
/// the new key sign, at the nonce in force); the vault's key becomes that root (the nonce runs on). Every spend, signed by the current key, cancels a recovery under way and every support gathered so far: an
/// owner who still holds the key always wins, and a stale support never counts again. Under the withdrawal lock a
/// spend cancels nothing: the guardians, whom the lock keeps as they are, have the last word.
///
/// Channels the vault pays (payer = vault):
/// * requestClose: starts the timed withdrawal of `amount`, signed by the channel's payerAuthorizer (the
///   voucher key) or by the vault's crank as EIP-712 CloseRequest(channelId, amount, nonce, deadline) in the
///   domain "Ostra Vault" version 1 of this vault. A signature works once and only until its deadline.
/// * finalizeWithdraw: anyone; the escrow can only come back to this vault.
/// Channels the vault is paid through (receiverAuthorizer = vault):
/// * claim and refund: only the crank. Claims apply payer-signed vouchers; a refund returns unclaimed escrow
///   to the payer. The crank can never send funds anywhere else.
contract OstraVault is Initializable, ReentrancyGuardTransient, EIP712, IUnlockCallback {
    using SafeERC20 for IERC20;

    uint8 public constant ACTION_TRANSFER = 0;
    uint8 public constant ACTION_OPEN_CHANNEL = 1;
    uint8 public constant ACTION_SET_CRANK_KEY = 2;
    uint8 public constant ACTION_SWAP = 3;
    uint8 public constant ACTION_CONFIGURE_POOL = 4;
    uint8 public constant ACTION_CLAIM_DIVIDEND = 5;
    uint8 public constant ACTION_SET_GUARDIAN = 6;
    uint8 public constant ACTION_SET_RECOVERY_POLICY = 7;
    uint8 public constant ACTION_SUPPORT_RECOVERY = 8;
    uint8 public constant ACTION_DEV_BUY = 9;
    uint8 public constant ACTION_SET_PROFILE = 10;
    uint8 public constant ACTION_SET_TOKEN_METADATA = 11;
    uint8 public constant ACTION_REGISTER_AGENT = 12;
    uint8 public constant ACTION_SET_AGENT_URI = 13;
    uint8 public constant ACTION_SET_WITHDRAWAL_LOCK = 14;
    uint8 public constant ACTION_CANCEL_PENDING_CHANGES = 15;
    uint8 public constant ACTION_SET_LINKED_VAULT = 16;
    uint8 public constant ACTION_LEND = 17;
    uint8 public constant ACTION_REDEEM = 18;
    uint8 public constant ACTION_POST_COLLATERAL = 19;
    uint8 public constant ACTION_WITHDRAW_COLLATERAL = 20;
    uint8 public constant ACTION_BORROW = 21;
    uint8 public constant ACTION_REPAY = 22;
    uint8 public constant ACTION_APPROVE_HASH = 23;
    uint8 public constant ACTION_GUARD = 24;

    /// @notice The implementation version: 2 adds the profile, token metadata and agent identity spends; 3 adds the
    ///         withdrawal lock, Morpho Vault V2 and Morpho Blue (Borro) spends and EIP-1271.
    uint8 public constant VERSION = 3;
    /// @notice Longest URI a SetProfile, SetTokenMetadata, RegisterAgent or SetAgentUri spend may carry.
    uint256 public constant MAX_URI_LENGTH = 256;

    /// @notice Bounds of a Swap's signed `swapGas`, the gas its PoolManager call gets exactly (so the sender's gas
    ///         limit never decides whether a swap fails).
    uint256 public constant MIN_SWAP_GAS = 100_000;
    uint256 public constant MAX_SWAP_GAS = 10_000_000;
    /// @dev Gas kept back beyond SWAP_GAS for the rest of the spend after the call (the failure path included).
    uint256 private constant SWAP_GAS_RESERVE = 30_000;
    /// @dev v4-core Lock.IS_UNLOCKED_SLOT: the PoolManager's transient unlocked flag.
    bytes32 private constant POOL_MANAGER_UNLOCKED_SLOT =
        0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;

    /// @notice Shortest recovery delay: Argent's 36-hour security period, the shortest in the deployed wallets surveyed.
    uint32 public constant MIN_RECOVERY_DELAY = 36 hours;
    /// @notice Longest recovery delay: the longest window in the deployed recovery designs surveyed (14 days).
    uint32 public constant MAX_RECOVERY_DELAY = 14 days;

    /// @notice The withdrawal lock's daily limit drains at `dailyLimit` per LIMIT_WINDOW.
    uint256 public constant LIMIT_WINDOW = OstraVaultV3.LIMIT_WINDOW;
    /// @dev EIP-1271's magic value: bytes4(keccak256("isValidSignature(bytes32,bytes)")).
    bytes4 private constant EIP1271_MAGIC = 0x1626ba7e;
    /// @dev OstraVaultModule.guard(uint8,bytes,address).
    bytes4 private constant MODULE_GUARD = bytes4(keccak256("guard(uint8,bytes,address)"));
    /// @dev OstraVaultModule.run(uint8,bytes,address,bool).
    bytes4 private constant MODULE_RUN = bytes4(keccak256("run(uint8,bytes,address,bool)"));

    bytes18 private constant SPEND_DOMAIN = "OSTRA/VAULT/EVM/v1";
    bytes32 public constant CLOSE_REQUEST_TYPEHASH =
        keccak256("CloseRequest(bytes32 channelId,uint128 amount,uint256 nonce,uint64 deadline)");

    /// @notice The x402BatchSettlement deployment this vault opens and closes channels on.
    IX402BatchSettlement public immutable BATCH_SETTLEMENT;
    /// @notice The Uniswap v4 PoolManager this vault swaps on.
    IPoolManager public immutable POOL_MANAGER;
    /// @notice The OstraRegistry this vault sets its profile and its launches' metadata in.
    IOstraRegistry public immutable REGISTRY;
    /// @notice The ERC-8004 Identity Registry this vault registers as an agent in.
    IAgentIdentityRegistry public immutable IDENTITY_REGISTRY;
    /// @notice OstraVaultModule, which this vault's version 3 spends (14 to 24) run in by delegatecall: apart only
    ///         for the code size limit.
    address public immutable MODULE;

    IERC20 public token;
    bytes32 public initialKeyRoot;
    address public initialCrank;
    /// @notice Root of the current one-time key.
    bytes32 public keyRoot;
    /// @notice Number of spends so far, which is also the index of the current key.
    uint64 public nonce;
    /// @notice Key that may claim and refund on channels paid to this vault and request closes on channels
    ///         this vault pays. address(0) = none.
    address public crank;
    /// @notice Advances with every spend and every finished recovery: supports and a pending recovery of an
    ///         earlier round never count. Shares the slot of nonce and crank, which every spend writes anyway.
    uint32 public recoveryRound;
    /// @notice Close requests used per channel this vault pays, so a close signature works once.
    mapping(bytes32 channelId => uint256) public closeNonce;

    mapping(address guardian => bool) public isGuardian;
    uint8 public guardianCount;
    /// @notice Supports needed to start a recovery; 0 = recovery off.
    uint8 public recoveryThreshold;
    uint32 public recoveryDelay;
    /// @notice Supports per (round, new key root), and who gave them.
    mapping(bytes32 proposal => uint256) public recoverySupport;
    mapping(bytes32 proposal => mapping(address guardian => bool)) public supportedBy;

    struct PendingRecovery {
        uint32 round;
        uint64 executableAt;
        bytes32 newKeyRoot;
    }

    /// @notice The recovery that reached its threshold; it counts only while its round is the current one.
    PendingRecovery public pendingRecovery;

    bytes32 private transient _expectedChannel;
    uint256 private transient _expectedAmount;
    bool private transient _swapPending;

    event Spent(uint64 indexed nonce, uint8 indexed action, bytes32 nextKeyRoot);
    event CrankChanged(address indexed crank);
    event ChannelOpened(bytes32 indexed channelId, uint128 amount);
    event CloseRequested(bytes32 indexed channelId, uint128 amount, address authorizer);
    event Swapped(bytes32 indexed poolId, bool zeroForOne, uint256 amountIn, uint256 amountOut, address recipient);
    /// @notice The signed swap failed inside the PoolManager and moved nothing; `reason` is the error's selector.
    event SwapFailed(bytes32 indexed poolId, bytes4 reason);
    event GuardianSet(address indexed guardian, bool enabled);
    event RecoveryPolicySet(uint8 threshold, uint32 delay);
    event RecoverySupported(uint32 indexed round, bytes32 indexed newKeyRoot, address indexed guardian, uint256 support);
    event RecoveryStarted(uint32 indexed round, bytes32 indexed newKeyRoot, uint64 executableAt);
    event Recovered(uint32 indexed round, bytes32 indexed newKeyRoot);
    event AgentRegistered(uint256 indexed agentId);

    error BadAction();
    error BadParams();
    error ZeroAmount();
    error WotsSignatureInvalid();
    error NotThisVault();
    error WrongToken();
    error Unauthorized();
    error UnexpectedCollect();
    error DepositNotCollected();
    error Expired();
    error UnexpectedCallback();
    error BadSwapDelta();
    error InsufficientOutput();
    error SwapOutOfGas();
    error PoolManagerUnlocked();
    error NotGuardian();
    error RecoveryOff();
    error AlreadySupported();
    error NoRecovery();
    error RecoveryNotReady();
    error Locked();

    /// @notice The contracts every vault uses, fixed in the implementation.
    struct Externals {
        address batchSettlement;
        address poolManager;
        address registry;
        address identityRegistry;
        address module;
    }

    constructor(Externals memory e) EIP712("Ostra Vault", "1") {
        if (
            e.registry == address(0) || e.identityRegistry == address(0) || e.module.code.length == 0
        ) revert BadParams();
        BATCH_SETTLEMENT = IX402BatchSettlement(e.batchSettlement);
        POOL_MANAGER = IPoolManager(e.poolManager);
        REGISTRY = IOstraRegistry(e.registry);
        IDENTITY_REGISTRY = IAgentIdentityRegistry(e.identityRegistry);
        MODULE = e.module;
        _disableInitializers();
    }

    function initialize(address token_, bytes32 initialKeyRoot_, address initialCrank_) external initializer {
        if (token_ == address(0)) revert WrongToken();
        token = IERC20(token_);
        initialKeyRoot = initialKeyRoot_;
        initialCrank = initialCrank_;
        keyRoot = initialKeyRoot_;
        crank = initialCrank_;
    }

    // ---------------------------------------------------------------------------------------------
    // WOTS spends
    // ---------------------------------------------------------------------------------------------

    /// @notice The exact message the current key must sign for a spend.
    function spendMessage(uint8 action, bytes32 nextKeyRoot, bytes calldata params)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(SPEND_DOMAIN, block.chainid, address(this), nonce, nextKeyRoot, action, params);
    }

    function spend(uint8 action, bytes32 nextKeyRoot, bytes calldata params, bytes calldata signature)
        external
        nonReentrant
    {
        _checkParamsShape(action, params);
        bytes memory message = spendMessage(action, nextKeyRoot, params);
        bytes32 signer = Wots.recoverKeyRoot(signature, message);
        if (signer != keyRoot) _finishRecoveryBy(signer);

        // Rotate before any external call: the signature can never be used again.
        uint64 spent = nonce;
        keyRoot = nextKeyRoot;
        nonce = spent + 1;
        // Lock and link changes whose wait is over apply before the spend is judged against them.
        OstraVaultV3.Layout storage v3 = OstraVaultV3.layout();
        OstraVaultV3.applyPendingChanges(v3);
        bool locked = v3.lock.withdrawal != address(0);
        // The key holder is the owner: a recovery under way and every support gathered so far stop counting. Under
        // the withdrawal lock the key may be a thief's, so a spend does not stop the guardians.
        if (!locked) {
            unchecked {
                ++recoveryRound;
            }
        }
        emit Spent(spent, action, nextKeyRoot);

        if (action == ACTION_TRANSFER) {
            (address to, uint256 amount) = abi.decode(params, (address, uint256));
            if (amount == 0) revert ZeroAmount();
            if (to != v3.lock.withdrawal || !OstraVaultV3.withdrawalKeeps(v3)) _outflow(amount);
            token.safeTransfer(to, amount);
        } else if (action == ACTION_OPEN_CHANNEL) {
            _openChannel(params);
        } else if (action == ACTION_SET_CRANK_KEY) {
            if (locked) revert Locked();
            address newCrank = abi.decode(params, (address));
            crank = newCrank;
            emit CrankChanged(newCrank);
        } else if (action == ACTION_SWAP) {
            _swap(params);
        } else if (action == ACTION_CONFIGURE_POOL) {
            if (locked) revert Locked();
            (address hook, bytes32 poolId, uint8 field, uint256 value) =
                abi.decode(params, (address, bytes32, uint8, uint256));
            if (hook == address(0)) revert BadParams();
            IOstraPoolSettings(hook).configure(poolId, field, value);
        } else if (action == ACTION_SET_GUARDIAN) {
            // Under the lock the guardians and the recovery policy stay as they are, so that a stolen key cannot
            // take away the guardians' recovery or their cancels; turning the lock off waits its delay.
            if (locked) revert Locked();
            (address guardian, bool enabled) = abi.decode(params, (address, bool));
            _setGuardian(guardian, enabled);
        } else if (action == ACTION_SET_RECOVERY_POLICY) {
            if (locked) revert Locked();
            (uint8 threshold, uint32 delay) = abi.decode(params, (uint8, uint32));
            _setRecoveryPolicy(threshold, delay);
        } else if (action == ACTION_DEV_BUY) {
            (address devBuy, bytes32 launchHash, uint256 amount) = abi.decode(params, (address, bytes32, uint256));
            if (msg.sender != devBuy || launchHash == bytes32(0)) revert Unauthorized();
            if (IOstraDevBuyLaunch(devBuy).pendingLaunch(address(this)) != launchHash) revert Unauthorized();
            if (amount != 0) {
                _outflow(amount);
                token.safeTransfer(devBuy, amount);
            }
        } else if (action == ACTION_SET_PROFILE) {
            REGISTRY.setProfile(abi.decode(params, (string)));
        } else if (action == ACTION_SET_TOKEN_METADATA) {
            (address launched, bytes32 poolId, string memory uri) = abi.decode(params, (address, bytes32, string));
            REGISTRY.setTokenMetadata(launched, poolId, uri);
        } else if (action == ACTION_REGISTER_AGENT) {
            emit AgentRegistered(IDENTITY_REGISTRY.register(abi.decode(params, (string))));
        } else if (action == ACTION_SET_AGENT_URI) {
            (uint256 agentId, string memory uri) = abi.decode(params, (uint256, string));
            IDENTITY_REGISTRY.setAgentURI(agentId, uri);
        } else {
            // ClaimDividend (5), SupportRecovery (8) and the version 3 spends (14 to 24).
            _moduleSpend(action, params);
        }
    }

    function _checkParamsShape(uint8 action, bytes calldata params) private pure {
        if (action == ACTION_TRANSFER) {
            if (params.length != 64) revert BadParams();
        } else if (action == ACTION_OPEN_CHANNEL) {
            if (params.length != 192) revert BadParams();
        } else if (action == ACTION_SET_CRANK_KEY) {
            if (params.length != 32) revert BadParams();
        } else if (action == ACTION_SWAP) {
            if (params.length != 352) revert BadParams();
        } else if (action == ACTION_CONFIGURE_POOL) {
            if (params.length != 128) revert BadParams();
        } else if (action == ACTION_CLAIM_DIVIDEND) {
            if (params.length != 32) revert BadParams();
        } else if (action == ACTION_SET_GUARDIAN || action == ACTION_SET_RECOVERY_POLICY) {
            if (params.length != 64) revert BadParams();
        } else if (action == ACTION_SUPPORT_RECOVERY) {
            if (params.length != 64) revert BadParams();
        } else if (action == ACTION_DEV_BUY) {
            if (params.length != 96) revert BadParams();
        } else if (action == ACTION_SET_PROFILE || action == ACTION_REGISTER_AGENT) {
            _checkUriParams(params, 1);
        } else if (action == ACTION_SET_TOKEN_METADATA) {
            _checkUriParams(params, 3);
        } else if (action == ACTION_SET_AGENT_URI) {
            _checkUriParams(params, 2);
        } else if (action == ACTION_CANCEL_PENDING_CHANGES) {
            if (params.length != 0) revert BadParams();
        } else if (action == ACTION_SET_LINKED_VAULT) {
            if (params.length != 32) revert BadParams();
        } else if (action == ACTION_SET_WITHDRAWAL_LOCK || action == ACTION_LEND || action == ACTION_REDEEM) {
            if (params.length != 96) revert BadParams();
        } else if (
            action == ACTION_POST_COLLATERAL || action == ACTION_WITHDRAW_COLLATERAL || action == ACTION_BORROW
        ) {
            if (params.length != 192) revert BadParams();
        } else if (action == ACTION_REPAY) {
            if (params.length != 288) revert BadParams();
        } else if (action == ACTION_GUARD) {
            if (params.length != 128) revert BadParams();
        } else if (action == ACTION_APPROVE_HASH) {
            if (params.length != 64) revert BadParams();
        } else {
            revert BadAction();
        }
    }

    /// @dev params is the ABI encoding of `heads` words whose last is a string: that word points just past the
    ///      heads, the string is 1 to MAX_URI_LENGTH bytes, and nothing follows its padding.
    function _checkUriParams(bytes calldata params, uint256 heads) private pure {
        uint256 headsEnd = 32 * heads;
        if (params.length < headsEnd + 32) revert BadParams();
        if (uint256(bytes32(params[headsEnd - 32:headsEnd])) != headsEnd) revert BadParams();
        uint256 length = uint256(bytes32(params[headsEnd:headsEnd + 32]));
        if (length == 0 || length > MAX_URI_LENGTH) revert BadParams();
        if (params.length != headsEnd + 32 + ((length + 31) / 32) * 32) revert BadParams();
    }

    /// @notice Accepts the identity token the ERC-8004 Identity Registry mints to this vault (RegisterAgent), and
    ///         nothing else.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(IDENTITY_REGISTRY)) revert Unauthorized();
        return this.onERC721Received.selector;
    }

    function _openChannel(bytes calldata params) private {
        (
            address payerAuthorizer,
            address receiver,
            address receiverAuthorizer,
            uint40 withdrawDelay,
            bytes32 salt,
            uint128 amount
        ) = abi.decode(params, (address, address, address, uint40, bytes32, uint128));
        if (amount == 0) revert ZeroAmount();
        // Without a voucher key nobody could sign vouchers or ask to close (the vault signs nothing but
        // WOTS spends), and with no crank the escrow could never come back.
        if (payerAuthorizer == address(0)) revert BadParams();
        _outflow(amount);
        IX402BatchSettlement.ChannelConfig memory config = IX402BatchSettlement.ChannelConfig({
            payer: address(this),
            payerAuthorizer: payerAuthorizer,
            receiver: receiver,
            receiverAuthorizer: receiverAuthorizer,
            token: address(token),
            withdrawDelay: withdrawDelay,
            salt: salt
        });
        bytes32 channelId = BATCH_SETTLEMENT.getChannelId(config);
        _expectedChannel = channelId;
        _expectedAmount = amount;
        BATCH_SETTLEMENT.deposit(config, amount, address(this), "");
        if (_expectedChannel != bytes32(0)) revert DepositNotCollected();
        emit ChannelOpened(channelId, amount);
    }

    /// @notice Deposit collector for x402BatchSettlement. Works only inside this vault's own OpenChannel
    ///         spend, for exactly the channel and amount that spend signed.
    function collect(address payer, address token_, uint256 amount, bytes32 channelId, bytes calldata)
        external
    {
        if (msg.sender != address(BATCH_SETTLEMENT)) revert UnexpectedCollect();
        if (payer != address(this) || token_ != address(token)) revert UnexpectedCollect();
        bytes32 expected = _expectedChannel;
        if (expected == bytes32(0) || channelId != expected || amount != _expectedAmount) {
            revert UnexpectedCollect();
        }
        _expectedChannel = bytes32(0);
        _expectedAmount = 0;
        token.safeTransfer(address(BATCH_SETTLEMENT), amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Swaps on Uniswap v4
    // ---------------------------------------------------------------------------------------------

    function _swap(bytes calldata params) private {
        (PoolKey memory key, bool zeroForOne, uint128 amountIn,, address recipient) =
            abi.decode(params, (PoolKey, bool, uint128, uint128, address));
        if (amountIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert BadParams();
        // The referrer (abi.decode refuses a dirty word) and the swap's gas.
        (, uint256 swapGas) = abi.decode(params[288:], (address, uint32));
        if (swapGas < MIN_SWAP_GAS || swapGas > MAX_SWAP_GAS) revert BadParams();
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        if (Currency.unwrap(input) != address(token)) revert WrongToken();
        // From inside someone else's unlock the PoolManager would refuse this one (AlreadyUnlocked): a failure the
        // swap did not cause, so the spend reverts instead of being used up.
        if (POOL_MANAGER.exttload(POOL_MANAGER_UNLOCKED_SLOT) != bytes32(0)) revert PoolManagerUnlocked();
        // The call gets exactly swapGas (EIP-150 passes at most 63/64 of what is left): with less, revert, so that
        // no gas limit makes the swap fail and a gas estimate only ever settles where the swap decides for itself.
        if (gasleft() < (swapGas * 64) / 63 + SWAP_GAS_RESERVE) revert SwapOutOfGas();
        _swapPending = true;
        try POOL_MANAGER.unlock{gas: swapGas}(params) returns (bytes memory result) {
            if (_swapPending) revert UnexpectedCallback();
            (uint256 paid, uint256 received) = abi.decode(result, (uint256, uint256));
            // What the swap took counts against the lock's daily limit, whatever the recipient.
            _outflow(paid);
            emit Swapped(PoolId.unwrap(key.toId()), zeroForOne, paid, received, recipient);
        } catch {
            // The swap failed on its own merits: nothing moved (the PoolManager undid it all) and the key has rotated.
            _swapPending = false;
            bytes4 reason;
            assembly ("memory-safe") {
                if gt(returndatasize(), 3) {
                    returndatacopy(0x00, 0x00, 0x04)
                    reason := and(mload(0x00), 0xffffffff00000000000000000000000000000000000000000000000000000000)
                }
            }
            emit SwapFailed(PoolId.unwrap(key.toId()), reason);
        }
    }

    /// @notice PoolManager callback. Works only inside this vault's own Swap spend, with the params that spend
    ///         signed (the PoolManager passes them back unchanged).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER) || !_swapPending) revert UnexpectedCallback();
        _swapPending = false;
        (PoolKey memory key, bool zeroForOne, uint128 amountIn, uint128 minOut, address recipient) =
            abi.decode(data, (PoolKey, bool, uint128, uint128, address));
        BalanceDelta delta = POOL_MANAGER.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(uint256(amountIn)),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            // The referrer word, already checked clean in _swap; none when zero.
            bytes32(data[288:320]) == bytes32(0) ? data[0:0] : data[288:320]
        );
        (int128 inDelta, int128 outDelta) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        // Exact input: the vault owes the input side and is owed the output side. A hook that returns deltas
        // may change both, never beyond what the signature allows.
        if (inDelta > 0 || outDelta < 0) revert BadSwapDelta();
        uint256 paid = uint256(-int256(inDelta));
        uint256 received = uint256(int256(outDelta));
        if (paid > amountIn) revert BadSwapDelta();
        if (received < minOut) revert InsufficientOutput();
        if (paid > 0) {
            POOL_MANAGER.sync(zeroForOne ? key.currency0 : key.currency1);
            token.safeTransfer(address(POOL_MANAGER), paid);
            // A token that delivers less than it was asked to move cannot settle the swap.
            if (POOL_MANAGER.settle() != paid) revert BadSwapDelta();
        }
        if (received > 0) POOL_MANAGER.take(zeroForOne ? key.currency1 : key.currency0, recipient, received);
        return abi.encode(paid, received);
    }

    // ---------------------------------------------------------------------------------------------
    // Withdrawal lock and linked vault
    // ---------------------------------------------------------------------------------------------

    /// @notice The withdrawal lock in force (a change whose wait is over counts as made). Off while `withdrawal`
    ///         is zero.
    function withdrawalLock() public view returns (OstraVaultV3.LockConfig memory) {
        OstraVaultV3.Layout storage l = OstraVaultV3.layout();
        uint64 at = l.pendingLockAt;
        return at != 0 && block.timestamp >= at ? l.pendingLock : l.lock;
    }

    function lockActive() public view returns (bool) {
        return withdrawalLock().withdrawal != address(0);
    }

    /// @notice When the lock in force was turned on; 0 while it is off.
    function lockedSince() external view returns (uint64) {
        return lockActive() ? OstraVaultV3.layout().lockedSince : 0;
    }

    /// @notice The linked vault in force (a change whose wait is over counts as made); address(0) = none.
    function linkedVault() public view returns (address) {
        OstraVaultV3.Layout storage l = OstraVaultV3.layout();
        uint64 at = l.pendingLinkedAt;
        return at != 0 && block.timestamp >= at ? l.pendingLinkedVault : l.linkedVault;
    }

    /// @notice The changes still waiting: a lock change (`lockAt` 0 = none) and a link change (`linkAt` 0 = none).
    function pendingChanges()
        external
        view
        returns (OstraVaultV3.LockConfig memory lock, uint64 lockAt, address link, uint64 linkAt)
    {
        OstraVaultV3.Layout storage l = OstraVaultV3.layout();
        if (l.pendingLockAt > block.timestamp) (lock, lockAt) = (l.pendingLock, l.pendingLockAt);
        if (l.pendingLinkedAt > block.timestamp) (link, linkAt) = (l.pendingLinkedVault, l.pendingLinkedAt);
    }

    /// @notice What may still go out against the daily limit now; type(uint256).max while the lock is off.
    function outflowAvailable() external view returns (uint256) {
        OstraVaultV3.LockConfig memory lock = withdrawalLock();
        if (lock.withdrawal == address(0)) return type(uint256).max;
        uint256 u = OstraVaultV3.used(OstraVaultV3.layout(), lock.dailyLimit);
        return u >= lock.dailyLimit ? 0 : lock.dailyLimit - u;
    }

    /// @notice From when an approved hash is valid for EIP-1271; 0 = not approved.
    function hashValidFrom(bytes32 hash) external view returns (uint64) {
        OstraVaultV3.Layout storage l = OstraVaultV3.layout();
        return l.hashValidFrom[OstraVaultV3.approvalKey(l, hash)];
    }

    /// @notice What a guardian or the withdrawal address may do while the lock is on (OstraVaultModule.guard): op 0
    ///         drop the waiting lock and link changes; 1 withdraw a hash approval, abi.encode(bytes32 hash); 2 send
    ///         the whole balance of the token to the withdrawal address, abi.encode(address expected), which must be
    ///         the one in force; 3 redeem Vault V2 shares back here, abi.encode(address vault, uint256 shares); 4 take
    ///         collateral back here, abi.encode(bytes32 marketId, uint256 shares), within the same LTV cap. So the
    ///         owner's way out survives a key a thief has taken over. Changes whose wait is over are made first.
    function guard(uint8 op, bytes calldata params) external nonReentrant {
        OstraVaultV3.Layout storage l = OstraVaultV3.layout();
        OstraVaultV3.applyPendingChanges(l);
        address withdrawal = l.lock.withdrawal;
        if (withdrawal == address(0)) revert Locked();
        if (!isGuardian[msg.sender] && msg.sender != withdrawal) revert NotGuardian();
        (bool ok, bytes memory ret) =
            MODULE.delegatecall(abi.encodeWithSelector(MODULE_GUARD, op, params, address(token)));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _outflow(uint256 amount) private {
        OstraVaultV3.outflow(OstraVaultV3.layout(), amount);
    }

    // ---------------------------------------------------------------------------------------------
    // EIP-1271
    // ---------------------------------------------------------------------------------------------

    /// @notice EIP-1271: a hash this vault approved with an ApproveHash spend, and did not withdraw, is signed by
    ///         this vault from the time its approval takes effect; `signature` is not read.
    ///         Approvals given before the lock was last turned on no longer count.
    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        OstraVaultV3.Layout storage l = OstraVaultV3.layout();
        uint64 from = l.hashValidFrom[OstraVaultV3.approvalKey(l, hash)];
        return from != 0 && block.timestamp >= from ? EIP1271_MAGIC : bytes4(0xffffffff);
    }

    // ---------------------------------------------------------------------------------------------
    // Version 3 spends
    // ---------------------------------------------------------------------------------------------

    /// @dev Runs a version 3 spend (14 to 24) in OstraVaultModule by delegatecall, and passes on its revert as it is;
    ///      the module also learns whether a recovery is under way.
    function _moduleSpend(uint8 action, bytes calldata params) private {
        PendingRecovery memory p = pendingRecovery;
        bool recovering = p.executableAt != 0 && p.round == recoveryRound;
        (bool ok, bytes memory ret) =
            MODULE.delegatecall(abi.encodeWithSelector(MODULE_RUN, action, params, address(token), recovering));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Recovery
    // ---------------------------------------------------------------------------------------------

    function _setGuardian(address guardian, bool enabled) private {
        if (guardian == address(0) || guardian == address(this) || isGuardian[guardian] == enabled) revert BadParams();
        isGuardian[guardian] = enabled;
        uint8 count = guardianCount;
        if (enabled) {
            if (count == type(uint8).max) revert BadParams();
            guardianCount = count + 1;
        } else {
            if (count - 1 < recoveryThreshold) revert BadParams();
            guardianCount = count - 1;
        }
        emit GuardianSet(guardian, enabled);
    }

    function _setRecoveryPolicy(uint8 threshold, uint32 delay) private {
        if (threshold == 0) {
            if (delay != 0) revert BadParams();
        } else if (threshold > guardianCount || delay < MIN_RECOVERY_DELAY || delay > MAX_RECOVERY_DELAY) {
            revert BadParams();
        }
        recoveryThreshold = threshold;
        recoveryDelay = delay;
        emit RecoveryPolicySet(threshold, delay);
    }

    /// @notice A guardian's support for moving this vault to `newKeyRoot` (the first key of a new seed). The
    ///         support that reaches the threshold starts the recovery delay.
    function supportRecovery(bytes32 newKeyRoot) external nonReentrant {
        if (!isGuardian[msg.sender]) revert NotGuardian();
        uint8 threshold = recoveryThreshold;
        if (threshold == 0) revert RecoveryOff();
        if (newKeyRoot == bytes32(0)) revert BadParams();
        uint32 round = recoveryRound;
        bytes32 proposal = keccak256(abi.encode(round, newKeyRoot));
        if (supportedBy[proposal][msg.sender]) revert AlreadySupported();
        supportedBy[proposal][msg.sender] = true;
        uint256 support = recoverySupport[proposal] + 1;
        recoverySupport[proposal] = support;
        emit RecoverySupported(round, newKeyRoot, msg.sender, support);
        if (support == threshold) {
            PendingRecovery memory p = pendingRecovery;
            // One recovery per round: the first proposal to reach the threshold is the one that waits.
            if (p.round == round && p.executableAt != 0) return;
            uint64 executableAt = uint64(block.timestamp) + recoveryDelay;
            pendingRecovery = PendingRecovery({round: round, executableAt: executableAt, newKeyRoot: newKeyRoot});
            emit RecoveryStarted(round, newKeyRoot, executableAt);
            // A recovery under way drops the changes waiting (the key may be a thief's); while it waits, the module
            // refuses new loosening changes (_moduleSpend passes it whether a recovery is under way).
            // So do the hash approvals given so far. Changes whose wait is over are made first.
            OstraVaultV3.Layout storage l = OstraVaultV3.layout();
            OstraVaultV3.applyPendingChanges(l);
            if (l.pendingLockAt != 0 || l.pendingLinkedAt != 0) OstraVaultV3.cancelPendingChanges(l, msg.sender);
            ++l.approvalsEpoch;
        }
    }

    /// @dev A spend not signed by the current key: valid only as the first spend of a recovery whose delay is over,
    ///      signed by its new key root, which finishes the recovery (the spend then rotates the key as usual).
    ///      Not under the lock: there a spend of the key holder can land first and move the nonce, which would leave
    ///      the new key's signature unusable (and it must not sign twice); finishRecovery comes first instead.
    function _finishRecoveryBy(bytes32 signer) private {
        PendingRecovery memory p = pendingRecovery;
        if (
            p.executableAt == 0 || p.round != recoveryRound || block.timestamp < p.executableAt || signer != p.newKeyRoot
                || lockActive()
        ) {
            revert WotsSignatureInvalid();
        }
        delete pendingRecovery;
        // Every support gathered so far stops counting, as finishRecovery does (a spend under the lock would not),
        // and so does every hash approval.
        unchecked {
            ++recoveryRound;
        }
        ++OstraVaultV3.layout().approvalsEpoch;
        emit Recovered(p.round, p.newKeyRoot);
    }

    /// @notice Finishes a recovery whose delay is over; anyone may call it. The vault's key becomes the new root.
    function finishRecovery() external nonReentrant {
        PendingRecovery memory p = pendingRecovery;
        uint32 round = recoveryRound;
        if (p.executableAt == 0 || p.round != round) revert NoRecovery();
        if (block.timestamp < p.executableAt) revert RecoveryNotReady();
        delete pendingRecovery;
        keyRoot = p.newKeyRoot;
        unchecked {
            recoveryRound = round + 1;
        }
        ++OstraVaultV3.layout().approvalsEpoch;
        emit Recovered(round, p.newKeyRoot);
    }

    // ---------------------------------------------------------------------------------------------
    // Channels this vault pays
    // ---------------------------------------------------------------------------------------------

    /// @notice The EIP-712 digest a close request signs (the voucher key's or the crank's), at the channel's
    ///         current close nonce.
    function closeDigest(bytes32 channelId, uint128 amount, uint64 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(CLOSE_REQUEST_TYPEHASH, channelId, amount, closeNonce[channelId], deadline))
        );
    }

    /// @notice Starts the timed withdrawal of `amount` from a channel this vault pays.
    function requestClose(
        IX402BatchSettlement.ChannelConfig calldata config,
        uint128 amount,
        uint64 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (config.payer != address(this)) revert NotThisVault();
        if (block.timestamp > deadline) revert Expired();
        bytes32 channelId = BATCH_SETTLEMENT.getChannelId(config);
        address signer = ECDSA.recover(closeDigest(channelId, amount, deadline), signature);
        address currentCrank = crank;
        bool bySession = config.payerAuthorizer != address(0) && signer == config.payerAuthorizer;
        bool byCrank = currentCrank != address(0) && signer == currentCrank;
        if (!bySession && !byCrank) revert Unauthorized();
        closeNonce[channelId] += 1;
        emit CloseRequested(channelId, amount, signer);
        BATCH_SETTLEMENT.initiateWithdraw(config, amount);
    }

    /// @notice Completes a timed withdrawal; the escrow can only come back to this vault.
    function finalizeWithdraw(IX402BatchSettlement.ChannelConfig calldata config) external nonReentrant {
        if (config.payer != address(this)) revert NotThisVault();
        BATCH_SETTLEMENT.finalizeWithdraw(config);
    }

    // ---------------------------------------------------------------------------------------------
    // Channels this vault is paid through
    // ---------------------------------------------------------------------------------------------

    /// @notice Applies payer-signed vouchers on channels whose receiverAuthorizer is this vault.
    function claim(IX402BatchSettlement.VoucherClaim[] calldata claims) external nonReentrant {
        _onlyCrank();
        for (uint256 i = 0; i < claims.length; ++i) {
            IX402BatchSettlement.ChannelConfig calldata c = claims[i].voucher.channel;
            if (c.receiverAuthorizer != address(this)) revert NotThisVault();
            if (c.token != address(token)) revert WrongToken();
        }
        BATCH_SETTLEMENT.claim(claims);
    }

    /// @notice Returns unclaimed escrow to the payer of a channel whose receiverAuthorizer is this vault.
    function refund(IX402BatchSettlement.ChannelConfig calldata config, uint128 amount) external nonReentrant {
        _onlyCrank();
        if (config.receiverAuthorizer != address(this)) revert NotThisVault();
        if (config.token != address(token)) revert WrongToken();
        BATCH_SETTLEMENT.refund(config, amount);
    }

    function _onlyCrank() private view {
        address currentCrank = crank;
        if (currentCrank == address(0) || msg.sender != currentCrank) revert Unauthorized();
    }
}
