// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Wots} from "./Wots.sol";
import {LtHash} from "./LtHash.sol";

/// @notice The EIP-3009 call the pool uses to take a deposit that a relayer submits.
interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title OstraPool
/// @notice The shielded pool for one token, the Robinhood Chain port of the Ostra Solana program's pool
///         (program/src/instructions/init_pool.rs, deposit.rs, batch.rs, spend_leaf.rs). Every pool is a
///         beacon proxy; its initializer is the Solana InitPool.
///
/// Flow, as on Solana:
/// * deposit: a depositor puts `amount` in, committing (LtHash) to the leaves it wants and naming the WOTS
///   key that approves a batch for it. The commitment itself is in the DepositCreated event; the pool keeps
///   its keccak256, and SealBatch is given the commitment again. A deposit over the per-deposit limit, one
///   that takes the pool balance over the total limit, or one whose amount after the fee is not a whole
///   number of leaves is refused.
/// * createBatch / appendLeaves: any aggregator builds a batch of leaves (key root, one leaf of the token).
///   Here appendLeaves already refuses a leaf of any other amount (on Solana SealBatch did, since
///   AppendLeaves did not read the pool); a batch with such a leaf can never seal either way.
/// * approveBatch: each depositor approves the batch's exact state with its WOTS approval key, which
///   rotates. The approval never reads the batch, so it always lands.
/// * sealBatch: succeeds only if the batch's leaves are exactly the union of the consumed deposits' committed
///   leaves (LtHash commitments sum to the accumulator, amounts after fees sum to the leaf total) and every
///   consumed deposit approved the batch's current state. The fees go to the treasury.
/// * spendLeaf: a sealed leaf moves, whole, to the destination its WOTS key signed.
/// * cancelDeposit: after DEPOSIT_TIMEOUT (48 hours, the Solana 432,000 slots of 400 ms) a deposit no batch
///   consumed goes back to its refund owner in full, without fee.
/// * closeDeposit / closeBatch: mark consumed deposits and finished or abandoned batches closed. A deposit
///   key never becomes free again (cancelled and closed are final), so an old approval can never be
///   replayed onto a new deposit under the same key.
/// * The fee goes to the treasury when the batch seals; if the token refuses that transfer, the fee is
///   kept as owed and anyone may send it later (sendFees), so sealing never depends on the treasury.
/// * setLimits: only the init authority, and only upwards. The fee and the treasury never change.
contract OstraPool is Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 500;
    uint16 public constant MAX_LEAVES_PER_BATCH = 192;
    uint64 public constant LEAF_TOKENS = 10;
    uint64 public constant DEPOSIT_TIMEOUT = 48 hours;

    uint8 public constant DEPOSIT_NONE = 0;
    uint8 public constant DEPOSIT_PENDING = 1;
    uint8 public constant DEPOSIT_CONSUMED = 2;
    uint8 public constant DEPOSIT_CANCELLED = 3;
    uint8 public constant DEPOSIT_CLOSED = 4;

    uint8 public constant BATCH_NONE = 0;
    uint8 public constant BATCH_OPEN = 1;
    uint8 public constant BATCH_SEALED = 2;
    uint8 public constant BATCH_CLOSED = 3;

    bytes20 private constant APPROVE_DOMAIN = "OSTRA/APPROVE/EVM/v1";
    bytes17 private constant LEAF_DOMAIN = "OSTRA/LEAF/EVM/v1";
    bytes21 private constant DEPOSIT_NONCE_DOMAIN = "OSTRA/DEPOSIT/EVM/v1:";

    struct DepositRecord {
        uint8 status;
        uint64 createdAt;
        uint64 amount;
        address refundOwner;
        uint64 approvedBatch; // batch id + 1; 0 = none
        bytes32 approvalKeyRoot;
        bytes32 approvedState;
        bytes32 commitmentHash;
    }

    struct Batch {
        uint8 status;
        address aggregator;
        uint16 capacity;
        uint16 leafCount;
        uint16 unspent;
        uint64 totalAmount;
        uint256[64] acc; // LtHash lane form
    }

    IERC20 public token;
    uint16 public feeBps;
    address public treasury;
    address public initAuthority;
    uint64 public leafAmount;
    uint64 public maxDeposit;
    uint64 public maxTotal;
    uint64 public batchCount;
    /// @notice Fees the token refused to send to the treasury at sealing, sent later by sendFees.
    uint256 public feesOwed;

    mapping(bytes32 depositKey => DepositRecord) private _deposits;
    mapping(uint64 batchId => Batch) private _batches;
    mapping(uint64 batchId => mapping(uint256 index => bytes32 keyRoot)) private _leafRoots;
    mapping(uint64 batchId => mapping(uint256 word => uint256 bits)) private _spentBits;

    event DepositCreated(
        bytes32 indexed depositKey,
        address indexed depositor,
        bytes32 depositId,
        uint64 amount,
        address refundOwner,
        bytes32 approvalKeyRoot,
        bytes commitment
    );
    event BatchCreated(uint64 indexed batchId, address indexed aggregator, uint16 capacity);
    event LeavesAppended(uint64 indexed batchId, uint16 firstIndex, bytes32[] keyRoots);
    event BatchApproved(bytes32 indexed depositKey, uint64 indexed batchId, bytes32 state, bytes32 nextKeyRoot);
    event BatchSealed(uint64 indexed batchId, bytes32[] depositKeys, uint64 fees);
    event LeafSpent(uint64 indexed batchId, uint16 indexed leafIndex, address destination, uint64 amount);
    event DepositCancelled(bytes32 indexed depositKey, address refundOwner, uint64 amount);
    event DepositClosed(bytes32 indexed depositKey);
    event BatchClosed(uint64 indexed batchId);
    event LimitsSet(uint64 maxDeposit, uint64 maxTotal);
    event FeesSent(uint256 amount);
    event FeesOwed(uint256 amount);

    error InvalidFee();
    error InvalidTreasury();
    error InvalidLimits();
    error InvalidToken();
    error ZeroAmount();
    error DepositOverLimit();
    error PoolOverLimit();
    error NonStandardDeposit();
    error NonStandardLeaf();
    error DepositExists();
    error BadCommitment();
    error DepositNotPending();
    error DepositNotConsumed();
    error DepositNotApproved();
    error DepositTimeoutNotReached();
    error BadCapacity();
    error NoBatch();
    error BatchNotOpen();
    error BatchNotSealed();
    error BatchFull();
    error BatchNotEmpty();
    error BatchAmountMismatch();
    error BatchCommitmentMismatch();
    error LeafIndexOutOfRange();
    error LeafAlreadySpent();
    error WotsSignatureInvalid();
    error Unauthorized();
    error EmptyBatch();
    error InvalidRefundOwner();

    constructor() {
        _disableInitializers();
    }

    /// @notice InitPool: fee and treasury are fixed for good; the limits can only be raised later.
    function initialize(
        address token_,
        uint16 feeBps_,
        address treasury_,
        uint64 maxDeposit_,
        uint64 maxTotal_,
        address initAuthority_
    ) external initializer {
        if (token_ == address(0)) revert InvalidToken();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        if (initAuthority_ == address(0)) revert Unauthorized();
        _checkLimits(maxDeposit_, maxTotal_);
        uint8 decimals = IERC20Metadata(token_).decimals();
        // One leaf (10 tokens) must fit in a u64, as on Solana.
        if (decimals > 18) revert InvalidToken();
        token = IERC20(token_);
        feeBps = feeBps_;
        treasury = treasury_;
        initAuthority = initAuthority_;
        leafAmount = uint64(LEAF_TOKENS * 10 ** uint256(decimals));
        maxDeposit = maxDeposit_;
        maxTotal = maxTotal_;
        emit LimitsSet(maxDeposit_, maxTotal_);
    }

    /// @notice SetPoolLimits: only the init authority, and neither limit may go down.
    function setLimits(uint64 maxDeposit_, uint64 maxTotal_) external {
        if (msg.sender != initAuthority) revert Unauthorized();
        _checkLimits(maxDeposit_, maxTotal_);
        if (maxDeposit_ < maxDeposit || maxTotal_ < maxTotal) revert InvalidLimits();
        maxDeposit = maxDeposit_;
        maxTotal = maxTotal_;
        emit LimitsSet(maxDeposit_, maxTotal_);
    }

    function _checkLimits(uint64 maxDeposit_, uint64 maxTotal_) private pure {
        if (maxDeposit_ == 0 || maxDeposit_ > maxTotal_) revert InvalidLimits();
    }

    // ---------------------------------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------------------------------

    /// @notice The key of a deposit: like the Solana deposit PDA ["deposit", pool, depositor, deposit_id].
    function depositKey(address depositor, bytes32 depositId) public pure returns (bytes32) {
        return keccak256(abi.encode(depositor, depositId));
    }

    /// @notice The EIP-3009 nonce a depositor signs for depositWithAuthorization. It binds every deposit field,
    ///         so whoever submits the deposit cannot change any of them.
    function depositNonce(
        address depositor,
        bytes32 depositId,
        uint64 amount,
        address refundOwner,
        bytes32 approvalKeyRoot,
        bytes calldata commitment
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                DEPOSIT_NONCE_DOMAIN,
                block.chainid,
                address(this),
                depositor,
                depositId,
                amount,
                refundOwner,
                approvalKeyRoot,
                keccak256(commitment)
            )
        );
    }

    /// @notice Deposit from the caller, which approved the pool for `amount`.
    function deposit(
        bytes32 depositId,
        uint64 amount,
        address refundOwner,
        bytes32 approvalKeyRoot,
        bytes calldata commitment
    ) external nonReentrant {
        _recordDeposit(msg.sender, depositId, amount, refundOwner, approvalKeyRoot, commitment);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Deposit taken with the depositor's EIP-3009 ReceiveWithAuthorization, so anyone (a relayer)
    ///         may submit it and the depositor needs no ETH. The authorization nonce is depositNonce(...).
    function depositWithAuthorization(
        address depositor,
        bytes32 depositId,
        uint64 amount,
        address refundOwner,
        bytes32 approvalKeyRoot,
        bytes calldata commitment,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _recordDeposit(depositor, depositId, amount, refundOwner, approvalKeyRoot, commitment);
        bytes32 nonce = depositNonce(depositor, depositId, amount, refundOwner, approvalKeyRoot, commitment);
        uint256 before = token.balanceOf(address(this));
        IERC3009Receive(address(token)).receiveWithAuthorization(
            depositor, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );
        if (token.balanceOf(address(this)) != before + amount) revert InvalidToken();
    }

    function _recordDeposit(
        address depositor,
        bytes32 depositId,
        uint64 amount,
        address refundOwner,
        bytes32 approvalKeyRoot,
        bytes calldata commitment
    ) private {
        if (amount == 0) revert ZeroAmount();
        if (refundOwner == address(0) || refundOwner == address(this)) revert InvalidRefundOwner();
        if (commitment.length != LtHash.BYTES) revert BadCommitment();
        if (amount > maxDeposit) revert DepositOverLimit();
        // The balance counts every token the pool holds, including tokens sent to it directly.
        if (token.balanceOf(address(this)) + amount > maxTotal) revert PoolOverLimit();
        uint64 fee = uint64((uint256(amount) * feeBps) / 10_000);
        if ((amount - fee) % leafAmount != 0) revert NonStandardDeposit();
        bytes32 key = depositKey(depositor, depositId);
        DepositRecord storage d = _deposits[key];
        if (d.status != DEPOSIT_NONE) revert DepositExists();
        d.status = DEPOSIT_PENDING;
        d.createdAt = uint64(block.timestamp);
        d.amount = amount;
        d.refundOwner = refundOwner;
        d.approvalKeyRoot = approvalKeyRoot;
        d.commitmentHash = keccak256(commitment);
        emit DepositCreated(key, depositor, depositId, amount, refundOwner, approvalKeyRoot, commitment);
    }

    /// @notice CancelDeposit: anyone, after DEPOSIT_TIMEOUT; the whole amount goes back to the refund owner.
    function cancelDeposit(bytes32 key) external nonReentrant {
        DepositRecord storage d = _deposits[key];
        if (d.status != DEPOSIT_PENDING) revert DepositNotPending();
        if (block.timestamp < uint256(d.createdAt) + DEPOSIT_TIMEOUT) revert DepositTimeoutNotReached();
        address owner = d.refundOwner;
        uint64 amount = d.amount;
        d.status = DEPOSIT_CANCELLED;
        emit DepositCancelled(key, owner, amount);
        token.safeTransfer(owner, amount);
    }

    /// @notice CloseDeposit: anyone may mark a consumed deposit closed.
    function closeDeposit(bytes32 key) external {
        DepositRecord storage d = _deposits[key];
        if (d.status != DEPOSIT_CONSUMED) revert DepositNotConsumed();
        d.status = DEPOSIT_CLOSED;
        emit DepositClosed(key);
    }

    function getDeposit(bytes32 key) external view returns (DepositRecord memory) {
        return _deposits[key];
    }

    // ---------------------------------------------------------------------------------------------
    // Batches
    // ---------------------------------------------------------------------------------------------

    /// @notice CreateBatch: any aggregator; the batch id is the pool's batch counter.
    function createBatch(uint16 capacity) external returns (uint64 batchId) {
        if (capacity == 0 || capacity > MAX_LEAVES_PER_BATCH) revert BadCapacity();
        batchId = batchCount;
        batchCount = batchId + 1;
        Batch storage b = _batches[batchId];
        b.status = BATCH_OPEN;
        b.aggregator = msg.sender;
        b.capacity = capacity;
        emit BatchCreated(batchId, msg.sender, capacity);
    }

    /// @notice AppendLeaves: only the batch's aggregator, only while open; every leaf is one leaf of the token.
    function appendLeaves(uint64 batchId, bytes32[] calldata keyRoots) external {
        Batch storage b = _batches[batchId];
        if (b.status != BATCH_OPEN) revert BatchNotOpen();
        if (msg.sender != b.aggregator) revert Unauthorized();
        if (keyRoots.length == 0) revert EmptyBatch();
        uint16 count = b.leafCount;
        if (uint256(count) + keyRoots.length > b.capacity) revert BatchFull();
        uint64 oneLeaf = leafAmount;
        uint256[64] memory acc = b.acc;
        for (uint256 i = 0; i < keyRoots.length; ++i) {
            LtHash.addLeaf(acc, keyRoots[i], oneLeaf);
            _leafRoots[batchId][count + i] = keyRoots[i];
        }
        b.acc = acc;
        emit LeavesAppended(batchId, count, keyRoots);
        count += uint16(keyRoots.length);
        b.leafCount = count;
        b.unspent = count;
        b.totalAmount += oneLeaf * uint64(keyRoots.length);
    }

    /// @notice What a depositor approves: keccak256(acc (2,048) || leaf_count (u16 LE) || total (u64 LE)),
    ///         the same state hash as the Solana program and the SDK (batchStateHash).
    function batchState(uint64 batchId) public view returns (bytes32) {
        Batch storage b = _batches[batchId];
        return LtHash.stateHash(b.acc, b.leafCount, b.totalAmount);
    }

    /// @notice The message a deposit's approval key signs.
    function approvalMessage(bytes32 key, uint64 batchId, bytes32 state, bytes32 nextKeyRoot)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(APPROVE_DOMAIN, block.chainid, address(this), key, batchId, state, nextKeyRoot);
    }

    /// @notice ApproveBatch: anyone submits; the approval key's WOTS signature authorizes. Never reads the batch,
    ///         so a signed approval always lands and always rotates the key.
    function approveBatch(
        bytes32 key,
        uint64 batchId,
        bytes32 state,
        bytes32 nextKeyRoot,
        bytes calldata signature
    ) external {
        DepositRecord storage d = _deposits[key];
        if (d.status != DEPOSIT_PENDING) revert DepositNotPending();
        bytes memory message = approvalMessage(key, batchId, state, nextKeyRoot);
        if (Wots.recoverKeyRoot(signature, message) != d.approvalKeyRoot) revert WotsSignatureInvalid();
        d.approvalKeyRoot = nextKeyRoot;
        d.approvedBatch = batchId + 1;
        d.approvedState = state;
        emit BatchApproved(key, batchId, state, nextKeyRoot);
    }

    /// @notice SealBatch: only the batch's aggregator. `commitments[i]` is the commitment of `keys[i]`.
    function sealBatch(uint64 batchId, bytes32[] calldata keys, bytes[] calldata commitments)
        external
        nonReentrant
    {
        Batch storage b = _batches[batchId];
        if (b.status != BATCH_OPEN) revert BatchNotOpen();
        if (msg.sender != b.aggregator) revert Unauthorized();
        if (keys.length == 0 || keys.length != commitments.length) revert EmptyBatch();
        uint256[64] memory acc = b.acc;
        bytes32 current = LtHash.stateHash(acc, b.leafCount, b.totalAmount);
        uint256 fee = feeBps;
        uint256 sum;
        uint256 fees;
        for (uint256 i = 0; i < keys.length; ++i) {
            DepositRecord storage d = _deposits[keys[i]];
            if (d.status != DEPOSIT_PENDING) revert DepositNotPending();
            if (d.approvedBatch != batchId + 1 || d.approvedState != current) revert DepositNotApproved();
            if (keccak256(commitments[i]) != d.commitmentHash) revert BadCommitment();
            uint256 depositFee = (uint256(d.amount) * fee) / 10_000;
            sum += d.amount - depositFee;
            fees += depositFee;
            LtHash.sub(acc, LtHash.fromBytes(commitments[i]));
            d.status = DEPOSIT_CONSUMED;
        }
        if (sum != b.totalAmount) revert BatchAmountMismatch();
        if (!LtHash.isZero(acc)) revert BatchCommitmentMismatch();
        b.status = BATCH_SEALED;
        emit BatchSealed(batchId, keys, uint64(fees));
        if (fees > 0) {
            if (_tryTransfer(treasury, fees)) {
                emit FeesSent(fees);
            } else {
                feesOwed += fees;
                emit FeesOwed(fees);
            }
        }
    }

    /// @notice Sends the fees the token refused at sealing to the treasury. Anyone may call it.
    function sendFees() external nonReentrant {
        uint256 amount = feesOwed;
        if (amount == 0) return;
        feesOwed = 0;
        emit FeesSent(amount);
        token.safeTransfer(treasury, amount);
    }

    /// @dev A token transfer that reports failure instead of reverting.
    function _tryTransfer(address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    /// @notice CloseBatch: a sealed batch with every leaf spent closes for anyone; an unsealed (abandoned) batch
    ///         only for its aggregator, after which it can never be sealed.
    function closeBatch(uint64 batchId) external {
        Batch storage b = _batches[batchId];
        if (b.status == BATCH_SEALED) {
            if (b.unspent != 0) revert BatchNotEmpty();
        } else if (b.status == BATCH_OPEN) {
            if (msg.sender != b.aggregator) revert Unauthorized();
        } else {
            revert NoBatch();
        }
        b.status = BATCH_CLOSED;
        emit BatchClosed(batchId);
    }

    function getBatch(uint64 batchId)
        external
        view
        returns (uint8 status, address aggregator, uint16 capacity, uint16 leafCount, uint16 unspent, uint64 totalAmount)
    {
        Batch storage b = _batches[batchId];
        return (b.status, b.aggregator, b.capacity, b.leafCount, b.unspent, b.totalAmount);
    }

    /// @notice A batch's accumulator in the canonical 2,048-byte encoding.
    function batchAccumulator(uint64 batchId) external view returns (bytes memory) {
        return LtHash.toBytes(_batches[batchId].acc);
    }

    function leaf(uint64 batchId, uint16 index) external view returns (bytes32 keyRoot, bool spent) {
        return (_leafRoots[batchId][index], _isSpent(batchId, index));
    }

    // ---------------------------------------------------------------------------------------------
    // Leaves
    // ---------------------------------------------------------------------------------------------

    /// @notice The message a leaf key signs to move its leaf, whole, to `destination`.
    function leafMessage(uint64 batchId, uint16 leafIndex, address destination) public view returns (bytes memory) {
        return abi.encodePacked(LEAF_DOMAIN, block.chainid, address(this), batchId, leafIndex, destination, leafAmount);
    }

    /// @notice SpendLeaf: anyone submits; the leaf key's WOTS signature fixes the destination.
    function spendLeaf(uint64 batchId, uint16 leafIndex, address destination, bytes calldata signature)
        external
        nonReentrant
    {
        Batch storage b = _batches[batchId];
        if (b.status != BATCH_SEALED) revert BatchNotSealed();
        if (leafIndex >= b.leafCount) revert LeafIndexOutOfRange();
        if (_isSpent(batchId, leafIndex)) revert LeafAlreadySpent();
        bytes memory message = leafMessage(batchId, leafIndex, destination);
        if (Wots.recoverKeyRoot(signature, message) != _leafRoots[batchId][leafIndex]) revert WotsSignatureInvalid();
        _spentBits[batchId][leafIndex >> 8] |= uint256(1) << (leafIndex & 0xff);
        b.unspent -= 1;
        uint64 amount = leafAmount;
        emit LeafSpent(batchId, leafIndex, destination, amount);
        token.safeTransfer(destination, amount);
    }

    function _isSpent(uint64 batchId, uint256 index) private view returns (bool) {
        return (_spentBits[batchId][index >> 8] >> (index & 0xff)) & 1 == 1;
    }
}
