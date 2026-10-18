// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {OstraHook} from "./OstraHook.sol";
import {OstraToken} from "./OstraToken.sol";

/// @title OstraAirdrop
/// @notice Airdrop rounds of a launched token, paid for by its creator (design v0.4, "Blok modular", decided 18 Oct
///         2026): no supply is set aside at launch. The pool's creator vault buys the token in its pool with a Swap
///         whose recipient is this contract (with its own funds, the creator payouts among them; for an ETH pool,
///         whose creator vault holds WETH, the tokens are bought elsewhere and sent here), then sets the round's
///         amount and starts it with two ConfigurePool spends whose `hook` is this contract: FIELD_ROUND_AMOUNT
///         (value = the amount, at most MAX_ROUND_BPS of the launch supply: what the merkle tree shares out) and
///         FIELD_START_ROUND (value = the tree's root), which reserves exactly that amount of what this contract
///         holds of the token beyond the open rounds (available). Each leaf is abi.encode(poolId, round, account,
///         amount), hashed twice as in OpenZeppelin's StandardMerkleTree; pairs hash sorted (MerkleProof). For
///         CLAIM_PERIOD anyone may claim an account's amount with its proof, always to that account; then anyone may
///         close the round, which burns what was not claimed. A new round can only start once the last one is
///         closed; what is held beyond a round waits for the next one. This contract is a system account of every
///         Ostra token: no max wallet and no dividend shares.
contract OstraAirdrop {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @notice A round holds at most 10% of the launch supply.
    uint256 public constant MAX_ROUND_BPS = 1_000;
    uint256 public constant CLAIM_PERIOD = 7 days;
    /// @notice configure fields: value = the round's merkle root; value = the next round's amount.
    uint8 public constant FIELD_START_ROUND = 0;
    uint8 public constant FIELD_ROUND_AMOUNT = 1;

    OstraHook public immutable HOOK;

    struct Round {
        bytes32 root;
        uint128 amount;
        uint128 claimed;
        uint40 endsAt;
        /// @notice Rounds are numbered from 1; 0 is none yet.
        uint32 number;
        /// @notice Started and not closed yet.
        bool open;
    }

    mapping(PoolId => Round) private _rounds;
    mapping(PoolId => mapping(uint256 number => mapping(address account => bool))) public claimed;
    /// @notice What open rounds still hold per token (their amount minus their claims).
    mapping(address token => uint256) public reserved;
    /// @notice The amount the pool's next round will hold, set by its creator vault (FIELD_ROUND_AMOUNT).
    mapping(PoolId => uint256) public nextRoundAmount;

    event RoundAmountSet(PoolId indexed poolId, uint256 amount);
    event RoundStarted(PoolId indexed poolId, uint32 indexed round, bytes32 root, uint256 amount, uint256 endsAt);
    event Claimed(PoolId indexed poolId, uint32 indexed round, address indexed account, uint256 amount);
    event RoundClosed(PoolId indexed poolId, uint32 indexed round, uint256 burned);

    error NotRegistered();
    error OnlyCreatorVault();
    error BadField();
    error BadRoot();
    error RoundOpen();
    error BadAmount();
    error NoRoundAmount();
    error NotEnoughTokens();
    error RoundNotOpen();
    error ClaimPeriodOver();
    error ClaimPeriodNotOver();
    error AlreadyClaimed();
    error BadProof();
    error RoundExhausted();

    constructor(address hook) {
        HOOK = OstraHook(hook);
    }

    // ---------------------------------------------------------------------------------------------
    // Creator vault
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets the next round's amount (FIELD_ROUND_AMOUNT, at most maxRoundAmount) or starts it with its merkle
    ///         root (FIELD_START_ROUND): that amount for CLAIM_PERIOD, out of what is available. Only the pool's
    ///         creator vault, and only when no round is open.
    function configure(bytes32 poolId, uint8 field, uint256 value) external {
        PoolId id = PoolId.wrap(poolId);
        (address token, address creatorVault) = _pool(id);
        if (msg.sender != creatorVault) revert OnlyCreatorVault();
        Round storage r = _rounds[id];
        if (r.open) revert RoundOpen();
        if (field == FIELD_ROUND_AMOUNT) {
            if (value == 0 || value > maxRoundAmount(id)) revert BadAmount();
            nextRoundAmount[id] = value;
            emit RoundAmountSet(id, value);
            return;
        }
        if (field != FIELD_START_ROUND) revert BadField();
        if (value == 0) revert BadRoot();
        uint256 amount = nextRoundAmount[id];
        if (amount == 0) revert NoRoundAmount();
        if (available(id) < amount) revert NotEnoughTokens();
        delete nextRoundAmount[id];
        uint32 number = r.number + 1;
        uint40 endsAt = uint40(block.timestamp + CLAIM_PERIOD);
        _rounds[id] =
            Round({root: bytes32(value), amount: uint128(amount), claimed: 0, endsAt: endsAt, number: number, open: true});
        reserved[token] += amount;
        emit RoundStarted(id, number, bytes32(value), amount, endsAt);
    }

    // ---------------------------------------------------------------------------------------------
    // Claims and closing
    // ---------------------------------------------------------------------------------------------

    /// @notice Pays `account` its `amount` of the open round, proved by `proof`. Anyone may call it; the tokens only
    ///         ever go to `account`.
    function claim(PoolId id, address account, uint256 amount, bytes32[] calldata proof) external {
        Round storage r = _rounds[id];
        if (!r.open) revert RoundNotOpen();
        if (block.timestamp >= r.endsAt) revert ClaimPeriodOver();
        uint32 number = r.number;
        if (claimed[id][number][account]) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, r.root, leaf(id, number, account, amount))) revert BadProof();
        uint256 total = uint256(r.claimed) + amount;
        if (total > r.amount) revert RoundExhausted();
        claimed[id][number][account] = true;
        r.claimed = uint128(total);
        (address token,) = _pool(id);
        reserved[token] -= amount;
        emit Claimed(id, number, account, amount);
        IERC20(token).safeTransfer(account, amount);
    }

    /// @notice Closes the round once its claim period is over and burns what was not claimed. Anyone may call it.
    function close(PoolId id) external {
        Round storage r = _rounds[id];
        if (!r.open) revert RoundNotOpen();
        if (block.timestamp < r.endsAt) revert ClaimPeriodNotOver();
        r.open = false;
        uint256 left = uint256(r.amount) - r.claimed;
        (address token,) = _pool(id);
        reserved[token] -= left;
        emit RoundClosed(id, r.number, left);
        if (left != 0) OstraToken(token).burn(left);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice The leaf of `account`'s `amount` in round `number` of the pool (StandardMerkleTree's double hash of
    ///         abi.encode(bytes32 poolId, uint256 number, address account, uint256 amount)).
    function leaf(PoolId id, uint256 number, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(PoolId.unwrap(id), number, account, amount))));
    }

    function round(PoolId id) external view returns (Round memory) {
        return _rounds[id];
    }

    /// @notice What this contract holds of the pool's token beyond what open rounds hold: what a round can take.
    function available(PoolId id) public view returns (uint256) {
        (address token,) = _pool(id);
        return IERC20(token).balanceOf(address(this)) - reserved[token];
    }

    /// @notice The most a round of the pool may hold: MAX_ROUND_BPS of the launch supply.
    function maxRoundAmount(PoolId id) public view returns (uint256) {
        return (HOOK.poolState(id).supply * MAX_ROUND_BPS) / BPS;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _pool(PoolId id) private view returns (address token, address creatorVault) {
        OstraHook.PoolConfig memory c = HOOK.poolConfig(id);
        if (c.token == address(0)) revert NotRegistered();
        return (c.token, c.creatorVault);
    }
}
