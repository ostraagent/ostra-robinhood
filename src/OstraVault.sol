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
import {IX402BatchSettlement} from "./interfaces/IX402BatchSettlement.sol";

/// @notice What a ConfigurePool spend calls (OstraHook.configure; PoolId is a bytes32).
interface IOstraPoolSettings {
    function configure(bytes32 poolId, uint8 field, uint256 value) external;
}

/// @notice What a ClaimDividend spend calls (OstraToken.claimTo).
interface IOstraDividends {
    function claimTo(address recipient) external returns (uint256 amount);
}

/// @notice What a SupportRecovery spend calls (OstraVault.supportRecovery of the vault being recovered).
interface IOstraRecovery {
    function supportRecovery(bytes32 newKeyRoot) external;
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
/// Signed message: "OSTRA/VAULT/EVM/v1" || chainid (32) || vault (20) || nonce (8) || nextKeyRoot (32)
///                 || action (1) || params. The key rotates and the nonce advances before any external call,
///                 so a signature can never be used twice. There is no expiry: a spend that did not land is
///                 resubmitted with the same bytes, never signed again.
///
/// Recovery (when the owner has lost the seed): once `recoveryThreshold` guardians support the same new key root,
/// the recovery waits `recoveryDelay`; then anyone may finish it (finishRecovery), or the new seed's first spend, signed
/// by that root, finishes it itself; the vault's key becomes that root (the nonce runs on). Every spend, signed by the current key, cancels a recovery under way and every support gathered so far: an
/// owner who still holds the key always wins, and a stale support never counts again.
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

    /// @notice The implementation version: 2 adds the profile, token metadata and agent identity spends.
    uint8 public constant VERSION = 2;
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

    constructor(address batchSettlement, address poolManager, address registry, address identityRegistry)
        EIP712("Ostra Vault", "1")
    {
        if (registry == address(0) || identityRegistry == address(0)) revert BadParams();
        BATCH_SETTLEMENT = IX402BatchSettlement(batchSettlement);
        POOL_MANAGER = IPoolManager(poolManager);
        REGISTRY = IOstraRegistry(registry);
        IDENTITY_REGISTRY = IAgentIdentityRegistry(identityRegistry);
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
        // The owner holds the key: a recovery under way and every support gathered so far stop counting.
        unchecked {
            ++recoveryRound;
        }
        emit Spent(spent, action, nextKeyRoot);

        if (action == ACTION_TRANSFER) {
            (address to, uint256 amount) = abi.decode(params, (address, uint256));
            if (amount == 0) revert ZeroAmount();
            token.safeTransfer(to, amount);
        } else if (action == ACTION_OPEN_CHANNEL) {
            _openChannel(params);
        } else if (action == ACTION_SET_CRANK_KEY) {
            address newCrank = abi.decode(params, (address));
            crank = newCrank;
            emit CrankChanged(newCrank);
        } else if (action == ACTION_SWAP) {
            _swap(params);
        } else if (action == ACTION_CONFIGURE_POOL) {
            (address hook, bytes32 poolId, uint8 field, uint256 value) =
                abi.decode(params, (address, bytes32, uint8, uint256));
            if (hook == address(0)) revert BadParams();
            IOstraPoolSettings(hook).configure(poolId, field, value);
        } else if (action == ACTION_CLAIM_DIVIDEND) {
            address recipient = abi.decode(params, (address));
            if (recipient == address(0)) revert BadParams();
            if (IOstraDividends(address(token)).claimTo(recipient) == 0) revert ZeroAmount();
        } else if (action == ACTION_SET_GUARDIAN) {
            (address guardian, bool enabled) = abi.decode(params, (address, bool));
            _setGuardian(guardian, enabled);
        } else if (action == ACTION_SET_RECOVERY_POLICY) {
            (uint8 threshold, uint32 delay) = abi.decode(params, (uint8, uint32));
            _setRecoveryPolicy(threshold, delay);
        } else if (action == ACTION_DEV_BUY) {
            (address devBuy, bytes32 launchHash, uint256 amount) = abi.decode(params, (address, bytes32, uint256));
            if (msg.sender != devBuy || launchHash == bytes32(0)) revert Unauthorized();
            if (IOstraDevBuyLaunch(devBuy).pendingLaunch(address(this)) != launchHash) revert Unauthorized();
            if (amount != 0) token.safeTransfer(devBuy, amount);
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
            (address vault, bytes32 newKeyRoot) = abi.decode(params, (address, bytes32));
            if (vault == address(0) || vault == address(this) || newKeyRoot == bytes32(0)) revert BadParams();
            IOstraRecovery(vault).supportRecovery(newKeyRoot);
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
        }
    }

    /// @dev A spend not signed by the current key: valid only as the first spend of a recovery whose delay is over,
    ///      signed by its new key root, which finishes the recovery (the spend then rotates the key as usual).
    function _finishRecoveryBy(bytes32 signer) private {
        PendingRecovery memory p = pendingRecovery;
        if (p.executableAt == 0 || p.round != recoveryRound || block.timestamp < p.executableAt || signer != p.newKeyRoot) {
            revert WotsSignatureInvalid();
        }
        delete pendingRecovery;
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
