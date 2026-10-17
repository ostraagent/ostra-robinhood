// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {Wots} from "./Wots.sol";
import {IX402BatchSettlement} from "./interfaces/IX402BatchSettlement.sol";

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
/// Signed message: "OSTRA/VAULT/EVM/v1" || chainid (32) || vault (20) || nonce (8) || nextKeyRoot (32)
///                 || action (1) || params. The key rotates and the nonce advances before any external call,
///                 so a signature can never be used twice. There is no expiry: a spend that did not land is
///                 resubmitted with the same bytes, never signed again.
///
/// Channels the vault pays (payer = vault):
/// * requestClose: starts the timed withdrawal of `amount`, signed by the channel's payerAuthorizer (the
///   voucher key) or by the vault's crank as EIP-712 CloseRequest(channelId, amount, nonce, deadline) in the
///   domain "Ostra Vault" version 1 of this vault. A signature works once and only until its deadline.
/// * finalizeWithdraw: anyone; the escrow can only come back to this vault.
/// Channels the vault is paid through (receiverAuthorizer = vault):
/// * claim and refund: only the crank. Claims apply payer-signed vouchers; a refund returns unclaimed escrow
///   to the payer. The crank can never send funds anywhere else.
contract OstraVault is Initializable, ReentrancyGuardTransient, EIP712 {
    using SafeERC20 for IERC20;

    uint8 public constant ACTION_TRANSFER = 0;
    uint8 public constant ACTION_OPEN_CHANNEL = 1;
    uint8 public constant ACTION_SET_CRANK_KEY = 2;

    bytes18 private constant SPEND_DOMAIN = "OSTRA/VAULT/EVM/v1";
    bytes32 public constant CLOSE_REQUEST_TYPEHASH =
        keccak256("CloseRequest(bytes32 channelId,uint128 amount,uint256 nonce,uint64 deadline)");

    /// @notice The x402BatchSettlement deployment this vault opens and closes channels on.
    IX402BatchSettlement public immutable BATCH_SETTLEMENT;

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
    /// @notice Close requests used per channel this vault pays, so a close signature works once.
    mapping(bytes32 channelId => uint256) public closeNonce;

    bytes32 private transient _expectedChannel;
    uint256 private transient _expectedAmount;

    event Spent(uint64 indexed nonce, uint8 indexed action, bytes32 nextKeyRoot);
    event CrankChanged(address indexed crank);
    event ChannelOpened(bytes32 indexed channelId, uint128 amount);
    event CloseRequested(bytes32 indexed channelId, uint128 amount, address authorizer);

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

    constructor(address batchSettlement) EIP712("Ostra Vault", "1") {
        BATCH_SETTLEMENT = IX402BatchSettlement(batchSettlement);
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
        if (Wots.recoverKeyRoot(signature, message) != keyRoot) revert WotsSignatureInvalid();

        // Rotate before any external call: the signature can never be used again.
        uint64 spent = nonce;
        keyRoot = nextKeyRoot;
        nonce = spent + 1;
        emit Spent(spent, action, nextKeyRoot);

        if (action == ACTION_TRANSFER) {
            (address to, uint256 amount) = abi.decode(params, (address, uint256));
            if (amount == 0) revert ZeroAmount();
            token.safeTransfer(to, amount);
        } else if (action == ACTION_OPEN_CHANNEL) {
            _openChannel(params);
        } else {
            address newCrank = abi.decode(params, (address));
            crank = newCrank;
            emit CrankChanged(newCrank);
        }
    }

    function _checkParamsShape(uint8 action, bytes calldata params) private pure {
        if (action == ACTION_TRANSFER) {
            if (params.length != 64) revert BadParams();
        } else if (action == ACTION_OPEN_CHANNEL) {
            if (params.length != 192) revert BadParams();
        } else if (action == ACTION_SET_CRANK_KEY) {
            if (params.length != 32) revert BadParams();
        } else {
            revert BadAction();
        }
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
