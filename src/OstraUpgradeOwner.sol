// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Wots} from "./Wots.sol";

/// @title OstraUpgradeOwner
/// @notice The owner of Ostra's beacons (the vault beacon and the pool beacon). An upgrade changes the
///         code of every vault, or of the pool, at once, so the key that can upgrade must be as strong as
///         the vaults' own keys. Here every call is authorized by a rotating WOTS one-time key (the same
///         scheme as the vaults, src/Wots.sol), never by an ECDSA key, and waits DELAY after it is
///         scheduled before anyone may execute it: every upgrade is public on-chain DELAY in advance, so
///         every vault owner can withdraw before a change it does not accept.
///
/// * schedule: the WOTS key signs a call (target, calldata); it may be executed from DELAY after it was
///   scheduled until GRACE after that, once.
/// * cancel: the WOTS key signs the cancellation of a call id. A valid cancel never reverts: when the call
///   is no longer scheduled (executed meanwhile, cancelled, or never scheduled) it only rotates the key.
/// * execute: anyone, within the window; the call's calldata must be exactly the scheduled one.
///
/// Every accepted signature rotates the key to the next key root it signed, as a vault spend does, so no
/// key ever signs twice. A signature the contract refuses does not rotate the key, and once broadcast it
/// is public: so nothing a third party can do makes a valid schedule or cancel revert (schedule refuses
/// only a target without code, which the signer checks first, and code cannot disappear), and the
/// signer only ever sends that same message again for that key (scripts/upgrade-owner.ts).
/// Releasing the upgrade right for good (Phase 4) is a scheduled call too: renounceOwnership on a beacon.
///
/// The keys come from one seed. Without the seed (and its passphrase) no call can be scheduled again:
/// the beacons then stay as they are for good, as if renounced; the vaults keep working.
contract OstraUpgradeOwner {
    bytes18 private constant DOMAIN = "OSTRA/OWNER/EVM/v1";

    uint8 public constant SCHEDULE = 1;
    uint8 public constant CANCEL = 2;
    uint256 public constant MIN_DELAY = 1 days;
    uint256 public constant MAX_DELAY = 30 days;
    /// @notice How long a scheduled call stays executable after its time comes.
    uint256 public constant GRACE = 14 days;

    struct ScheduledCall {
        address target;
        uint64 eta; // 0: none (never scheduled, executed or cancelled)
        bytes32 dataHash;
    }

    /// @notice Seconds between scheduling a call and the earliest time it may be executed.
    uint256 public immutable DELAY;
    /// @notice Root of the WOTS key the next signature must come from.
    bytes32 public keyRoot;
    /// @notice Signatures accepted so far: the key index of the next one, and the id of the next scheduled call.
    uint64 public nonce;

    mapping(uint64 id => ScheduledCall) private _calls;

    event KeyRotated(uint64 indexed nonce, bytes32 keyRoot);
    event CallScheduled(uint64 indexed id, address indexed target, bytes data, uint64 eta);
    /// @param wasScheduled false when the call was no longer scheduled: the cancel only rotated the key.
    event CallCancelled(uint64 indexed id, bool wasScheduled);
    event CallExecuted(uint64 indexed id, address indexed target, bytes data);

    error InvalidKeyRoot();
    error InvalidDelay();
    error NotAContract();
    error WotsSignatureInvalid();
    error UnknownCall();
    error TooEarly();
    error Expired();
    error WrongCalldata();
    error CallFailed(bytes returnData);

    constructor(bytes32 keyRoot_, uint256 delay_) {
        if (keyRoot_ == bytes32(0)) revert InvalidKeyRoot();
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert InvalidDelay();
        keyRoot = keyRoot_;
        DELAY = delay_;
        emit KeyRotated(0, keyRoot_);
    }

    /// @notice The message the current key signs: "OSTRA/OWNER/EVM/v1" || chainid || this contract || nonce (u64)
    ///         || action (u8) || payload || next key root. The payload of SCHEDULE is
    ///         keccak256(abi.encode(target, keccak256(data))); the payload of CANCEL is the call id (u64,
    ///         as a 32-byte word).
    function message(uint8 action, bytes32 payload, bytes32 nextKeyRoot) public view returns (bytes memory) {
        return abi.encodePacked(DOMAIN, block.chainid, address(this), nonce, action, payload, nextKeyRoot);
    }

    /// @notice The SCHEDULE payload of a call.
    function schedulePayload(address target, bytes calldata data) public pure returns (bytes32) {
        return keccak256(abi.encode(target, keccak256(data)));
    }

    /// @notice Schedules `target.call(data)`; its id is the nonce the signature was made at.
    function schedule(address target, bytes calldata data, bytes32 nextKeyRoot, bytes calldata signature)
        external
        returns (uint64 id)
    {
        if (target.code.length == 0) revert NotAContract();
        id = _authorize(SCHEDULE, schedulePayload(target, data), nextKeyRoot, signature);
        uint64 eta = uint64(block.timestamp + DELAY);
        _calls[id] = ScheduledCall({target: target, eta: eta, dataHash: keccak256(data)});
        emit CallScheduled(id, target, data, eta);
    }

    /// @notice Cancels the scheduled call `id`; when it is not scheduled any more, only rotates the key.
    function cancel(uint64 id, bytes32 nextKeyRoot, bytes calldata signature) external {
        _authorize(CANCEL, bytes32(uint256(id)), nextKeyRoot, signature);
        bool wasScheduled = _calls[id].eta != 0;
        delete _calls[id];
        emit CallCancelled(id, wasScheduled);
    }

    /// @notice Executes the scheduled call `id` with its exact calldata: anyone, from its time until GRACE after.
    function execute(uint64 id, bytes calldata data) external returns (bytes memory result) {
        ScheduledCall memory c = _calls[id];
        if (c.eta == 0) revert UnknownCall();
        if (block.timestamp < c.eta) revert TooEarly();
        if (block.timestamp > uint256(c.eta) + GRACE) revert Expired();
        if (keccak256(data) != c.dataHash) revert WrongCalldata();
        delete _calls[id];
        bool ok;
        (ok, result) = c.target.call(data);
        if (!ok) revert CallFailed(result);
        emit CallExecuted(id, c.target, data);
    }

    function getCall(uint64 id) external view returns (ScheduledCall memory) {
        return _calls[id];
    }

    /// @dev Checks the current key's signature over the message and rotates to `nextKeyRoot`.
    function _authorize(uint8 action, bytes32 payload, bytes32 nextKeyRoot, bytes calldata signature)
        private
        returns (uint64 n)
    {
        if (nextKeyRoot == bytes32(0)) revert InvalidKeyRoot();
        if (Wots.recoverKeyRoot(signature, message(action, payload, nextKeyRoot)) != keyRoot) {
            revert WotsSignatureInvalid();
        }
        n = nonce;
        keyRoot = nextKeyRoot;
        nonce = n + 1;
        emit KeyRotated(n + 1, nextKeyRoot);
    }
}
