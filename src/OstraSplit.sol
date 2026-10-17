// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title OstraSplit
/// @notice The receiver of a seller's x402 batch-settlement channels. x402BatchSettlement settles claimed
///         funds to it, and anyone may distribute them: each recipient is owed floor(amount * bps / 10,000)
///         of every newly arrived amount and the primary recipient (the seller's vault) the rest. Anyone may
///         then release what an account is owed to that account, so one account the token refuses to pay
///         never holds up the others. This replaces the bps distribution of Solana Payment Channels; the
///         seller's offer names the split, so a buyer who opens a channel to it commits to the same shares,
///         and nobody can change them afterwards.
contract OstraSplit {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_RECIPIENTS = 32;
    uint256 public constant BPS = 10_000;

    IERC20 public immutable TOKEN;
    address public immutable PRIMARY;
    address[] private _recipients;
    uint16[] private _bps;
    /// @notice Distributed and not yet released, per account.
    mapping(address account => uint256) public owed;
    /// @notice Sum of `owed`: the part of the balance that is already distributed.
    uint256 public totalOwed;

    event Distributed(uint256 amount);
    event Released(address indexed account, uint256 amount);

    error BadSplit();

    constructor(address token, address primary, address[] memory recipients, uint16[] memory bps) {
        if (token == address(0) || primary == address(0)) revert BadSplit();
        if (recipients.length != bps.length || recipients.length > MAX_RECIPIENTS) revert BadSplit();
        uint256 total;
        for (uint256 i = 0; i < recipients.length; ++i) {
            if (recipients[i] == address(0) || bps[i] == 0) revert BadSplit();
            for (uint256 j = 0; j < i; ++j) {
                if (recipients[j] == recipients[i]) revert BadSplit();
            }
            total += bps[i];
        }
        if (total > BPS) revert BadSplit();
        TOKEN = IERC20(token);
        PRIMARY = primary;
        _recipients = recipients;
        _bps = bps;
    }

    function shares() external view returns (address[] memory recipients, uint16[] memory bps) {
        return (_recipients, _bps);
    }

    /// @notice Divides everything that arrived since the last distribution by the fixed shares.
    function distribute() external {
        uint256 amount = TOKEN.balanceOf(address(this)) - totalOwed;
        if (amount == 0) return;
        uint256 shared;
        uint256 n = _recipients.length;
        for (uint256 i = 0; i < n; ++i) {
            uint256 share = (amount * _bps[i]) / BPS;
            owed[_recipients[i]] += share;
            shared += share;
        }
        owed[PRIMARY] += amount - shared;
        totalOwed += amount;
        emit Distributed(amount);
    }

    /// @notice Pays `account` everything it is owed. Anyone may call it; the funds only go to `account`.
    function release(address account) external {
        uint256 amount = owed[account];
        if (amount == 0) return;
        owed[account] = 0;
        totalOwed -= amount;
        TOKEN.safeTransfer(account, amount);
        emit Released(account, amount);
    }
}

/// @title OstraSplitFactory
/// @notice Creates splits at addresses fixed by their shares, so a split can be checked from its address.
///         Creating an existing split returns it.
contract OstraSplitFactory {
    event SplitCreated(address indexed split, address indexed token, address indexed primary);

    function createSplit(address token, address primary, address[] calldata recipients, uint16[] calldata bps)
        external
        returns (address split)
    {
        split = splitAddress(token, primary, recipients, bps);
        if (split.code.length > 0) return split;
        split = address(new OstraSplit{salt: _salt(token, primary, recipients, bps)}(token, primary, recipients, bps));
        emit SplitCreated(split, token, primary);
    }

    function splitAddress(address token, address primary, address[] calldata recipients, uint16[] calldata bps)
        public
        view
        returns (address)
    {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(OstraSplit).creationCode, abi.encode(token, primary, recipients, bps)));
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), _salt(token, primary, recipients, bps), initCodeHash)
                    )
                )
            )
        );
    }

    function _salt(address token, address primary, address[] calldata recipients, uint16[] calldata bps)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(token, primary, recipients, bps));
    }
}
