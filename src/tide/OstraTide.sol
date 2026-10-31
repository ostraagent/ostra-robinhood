// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {IOstraVaultFactory, IOstraVaultView, OstraVaultV3} from "../OstraVaultV3.sol";

/// @title TidePot
/// @notice One week's pot of Ostra Tide: it holds that week's OSTRA and sends it only when OstraTide tells it to.
///         OstraTide creates it with CREATE2 (salt: the week), so its address is known, and can be funded with a
///         plain OSTRA transfer, before the week starts and before the pot has code.
contract TidePot {
    using SafeERC20 for IERC20;

    address public immutable TIDE;
    IERC20 public immutable TOKEN;

    error OnlyTide();

    constructor() {
        TIDE = msg.sender;
        TOKEN = OstraTide(msg.sender).TOKEN();
    }

    function send(address to, uint256 amount) external {
        if (msg.sender != TIDE) revert OnlyTide();
        TOKEN.safeTransfer(to, amount);
    }
}

/// @title OstraTide
/// @notice Ostra Tide: OSTRA from the buyback goes back, week by week, to the agents that use Ostra, into their own
///         OSTRA vaults. Weeks run from START, seven days each, numbered from 1. Each week has its own pot (TidePot).
///         After a week ends, Ostra posts the Merkle root of that week's shares (computed off chain from the chain's
///         activity by the public scoring script), never more than the pot holds. A share whose leaf names its vault
///         can be paid by anyone; a share of an agent that had no OSTRA vault yet (payee zero) is paid by Ostra once
///         that vault exists. Whatever is still in a pot HOLD after its root (or after its week, when no root came)
///         moves to the pot of the week in progress, and only there; a root comes within that HOLD or not at all.
///         Nobody, Ostra included, can take OSTRA out of a pot any other way: it leaves only to an Ostra OSTRA vault
///         named by a posted root, or to a later pot. OSTRA sent to the pot of week 0 (before START) rolls forward
///         like any week's, and OSTRA sent to this contract itself can be swept to the pot of the week in progress.
///         Other tokens sent to a pot or to this contract cannot be moved by anyone.
contract OstraTide is Ownable2Step {
    /// @notice One agent's share of one week. The leaf is OpenZeppelin's standard Merkle tree leaf of
    ///         abi.encode(week, agentId, payee, amount): keccak256(bytes.concat(keccak256(abi.encode(...)))).
    struct Share {
        uint256 week;
        uint256 agentId;
        address payee;
        uint256 amount;
    }

    struct Week {
        bytes32 root;
        uint128 total;
        uint128 paid;
        uint64 rootAt;
        bool rolled;
    }

    uint256 public constant WEEK = 7 days;
    uint256 public constant HOLD = 14 days;

    IERC20 public immutable TOKEN;
    IOstraVaultFactory public immutable FACTORY;
    uint256 public immutable START;
    bytes32 public immutable POT_CODE_HASH;

    mapping(uint256 week => Week) internal _weeks;
    mapping(uint256 week => mapping(uint256 agentId => bool)) public paid;

    event RootSet(uint256 indexed week, bytes32 root, uint256 total);
    event Paid(uint256 indexed week, uint256 indexed agentId, address indexed vault, uint256 amount);
    event RolledOver(uint256 indexed week, uint256 indexed toWeek, uint256 amount);
    event Swept(uint256 indexed toWeek, uint256 amount);

    error BadParams();
    error NotEnded();
    error RootTooLate();
    error RootAlreadySet();
    error AlreadyRolled();
    error OverPot(uint256 potBalance);
    error NoRoot();
    error AlreadyPaid();
    error BadProof();
    error OverTotal();
    error NotOstraVault(address vault);
    error OnlyOwnerChoosesVault();
    error TooEarly(uint256 at);
    error NoRenounce();

    constructor(address token, address factory, uint256 start, address owner_) Ownable(owner_) {
        if (token == address(0) || factory.code.length == 0 || start == 0) revert BadParams();
        TOKEN = IERC20(token);
        FACTORY = IOstraVaultFactory(factory);
        START = start;
        POT_CODE_HASH = keccak256(type(TidePot).creationCode);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice The week `t` falls in: 0 before START, then 1, 2, ...
    function weekAt(uint256 t) public view returns (uint256) {
        return t < START ? 0 : (t - START) / WEEK + 1;
    }

    function currentWeek() public view returns (uint256) {
        return weekAt(block.timestamp);
    }

    /// @notice When week `week` ends (its root may be posted from then on).
    function weekEnd(uint256 week) public view returns (uint256) {
        return START + week * WEEK;
    }

    /// @notice Week `week`'s pot: fund it by sending OSTRA there, even before it has code.
    function potAddress(uint256 week) public view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(week), POT_CODE_HASH))))
        );
    }

    function potBalance(uint256 week) public view returns (uint256) {
        return TOKEN.balanceOf(potAddress(week));
    }

    function weekInfo(uint256 week) external view returns (Week memory) {
        return _weeks[week];
    }

    /// @notice From when week `week`'s pot may be rolled over to the week then in progress.
    function rolloverAt(uint256 week) public view returns (uint256) {
        Week storage w = _weeks[week];
        return (w.rootAt != 0 ? uint256(w.rootAt) : weekEnd(week)) + HOLD;
    }

    function leaf(Share calldata s) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(s.week, s.agentId, s.payee, s.amount))));
    }

    // ---------------------------------------------------------------------------------------------
    // Ostra: the week's root
    // ---------------------------------------------------------------------------------------------

    /// @notice Posts week `week`'s shares, once, after the week ends and before HOLD has passed since (after that the
    ///         week only rolls over); refused above what its pot holds.
    function setRoot(uint256 week, bytes32 root, uint256 total) external onlyOwner {
        if (week == 0 || root == bytes32(0) || total == 0 || total > type(uint128).max) revert BadParams();
        uint256 end = weekEnd(week);
        if (block.timestamp < end) revert NotEnded();
        if (block.timestamp >= end + HOLD) revert RootTooLate();
        Week storage w = _weeks[week];
        if (w.root != bytes32(0)) revert RootAlreadySet();
        if (w.rolled) revert AlreadyRolled();
        uint256 balance = potBalance(week);
        if (total > balance) revert OverPot(balance);
        _pot(week);
        w.root = root;
        w.total = uint128(total);
        w.rootAt = uint64(block.timestamp);
        emit RootSet(week, root, total);
    }

    /// @dev Without an owner no root could be posted, and every pot would only ever roll forward.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }

    // ---------------------------------------------------------------------------------------------
    // Paying shares
    // ---------------------------------------------------------------------------------------------

    /// @notice Pays one share to its vault. `vault` is read only for a share with no payee (an agent that had no
    ///         OSTRA vault when the root was computed), and only Ostra may name it; otherwise pass address(0).
    function pay(Share calldata s, bytes32[] calldata proof, address vault) external {
        _pay(s, proof, vault);
    }

    /// @notice Pays several shares; a share already paid (by anyone, even earlier in the same batch) is skipped, any
    ///         other failure reverts the whole batch.
    function payMany(Share[] calldata shares, bytes32[][] calldata proofs, address[] calldata vaults) external {
        if (shares.length != proofs.length || shares.length != vaults.length) revert BadParams();
        for (uint256 i = 0; i < shares.length; i++) {
            if (paid[shares[i].week][shares[i].agentId]) continue;
            _pay(shares[i], proofs[i], vaults[i]);
        }
    }

    function _pay(Share calldata s, bytes32[] calldata proof, address vault) private {
        Week storage w = _weeks[s.week];
        if (w.root == bytes32(0)) revert NoRoot();
        if (w.rolled) revert AlreadyRolled();
        if (paid[s.week][s.agentId]) revert AlreadyPaid();
        if (!MerkleProof.verifyCalldata(proof, w.root, leaf(s))) revert BadProof();
        address to = s.payee;
        if (to == address(0)) {
            if (msg.sender != owner()) revert OnlyOwnerChoosesVault();
            to = vault;
        }
        if (!_isOstraVault(to)) revert NotOstraVault(to);
        uint256 newPaid = uint256(w.paid) + s.amount;
        if (newPaid > w.total) revert OverTotal();
        paid[s.week][s.agentId] = true;
        w.paid = uint128(newPaid);
        emit Paid(s.week, s.agentId, to, s.amount);
        if (s.amount != 0) TidePot(_pot(s.week)).send(to, s.amount);
    }

    /// @dev An OSTRA vault OstraVaultFactory made: its address is the factory's for its own creation parameters.
    function _isOstraVault(address v) private view returns (bool) {
        if (!OstraVaultV3.isOstraVault(FACTORY, v)) return false;
        return IOstraVaultView(v).token() == address(TOKEN);
    }

    // ---------------------------------------------------------------------------------------------
    // Rolling a week over
    // ---------------------------------------------------------------------------------------------

    /// @notice Moves what is left in week `week`'s pot to the pot of the week in progress, from rolloverAt(week) on;
    ///         anyone may call it, again later for OSTRA sent to the pot after it rolled. Shares of the week stop
    ///         being payable once it rolls. Week 0 (OSTRA sent before START) rolls from START + HOLD.
    function rollover(uint256 week) external {
        uint256 at = rolloverAt(week);
        if (block.timestamp < at) revert TooEarly(at);
        _weeks[week].rolled = true;
        uint256 toWeek = currentWeek();
        uint256 amount = potBalance(week);
        emit RolledOver(week, toWeek, amount);
        if (amount != 0) TidePot(_pot(week)).send(potAddress(toWeek), amount);
    }

    /// @notice Moves OSTRA sent to this contract itself to the pot of the week in progress; anyone may call it.
    function sweep() external {
        uint256 toWeek = currentWeek();
        uint256 amount = TOKEN.balanceOf(address(this));
        emit Swept(toWeek, amount);
        if (amount != 0) SafeERC20.safeTransfer(TOKEN, potAddress(toWeek), amount);
    }

    /// @dev Week `week`'s pot, created when first needed.
    function _pot(uint256 week) private returns (address pot) {
        pot = potAddress(week);
        if (pot.code.length == 0) {
            address made = address(new TidePot{salt: bytes32(week)}());
            if (made != pot) revert BadParams();
        }
    }
}
