// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IOstraTokenDividends {
    function claimTo(address recipient) external returns (uint256);
}

/// @title OstraVesting
/// @notice Holds a creator's dev buy (OstraDevBuy) and pays it to the creator's token vault on a fixed schedule:
///         nothing until the cliff ends, then linearly over the vesting duration (all of it at the cliff's end when
///         the duration is 0). One clone per launch, whose terms are immutable clone arguments: nothing can speed the
///         schedule up, change where the tokens go, or move them anywhere else. While it holds the tokens it is an
///         ordinary holder, so the pool's max wallet bounds the dev buy and the dividends it earns flow to the
///         creator's dividend recipient. Anyone may release what has vested or claim the dividends: both only ever
///         pay the creator's accounts.
contract OstraVesting {
    using SafeERC20 for IERC20;

    /// @notice What has been paid to the beneficiary so far.
    uint256 public released;

    event Released(uint256 amount);
    event DividendsClaimed(address recipient, uint256 amount);

    error NothingVested();
    error NoDividendRecipient();

    struct Terms {
        address token;
        /// @notice The creator's vault for the token: receives what vests.
        address beneficiary;
        /// @notice Receives the dividends the held tokens earn (the creator's vault for the dividend token).
        address dividendRecipient;
        uint40 start;
        uint32 cliff;
        uint32 duration;
    }

    function terms() public view returns (Terms memory) {
        return abi.decode(Clones.fetchCloneArgs(address(this)), (Terms));
    }

    /// @notice When the first tokens vest, and when the last do.
    function schedule() external view returns (uint256 cliffEnd, uint256 end) {
        Terms memory t = terms();
        cliffEnd = uint256(t.start) + t.cliff;
        end = cliffEnd + t.duration;
    }

    /// @notice How much of everything this vesting holds and has paid has vested by `timestamp`.
    function vestedAmount(uint256 timestamp) public view returns (uint256) {
        Terms memory t = terms();
        uint256 total = IERC20(t.token).balanceOf(address(this)) + released;
        uint256 cliffEnd = uint256(t.start) + t.cliff;
        if (timestamp < cliffEnd) return 0;
        if (timestamp >= cliffEnd + t.duration) return total;
        return (total * (timestamp - cliffEnd)) / t.duration;
    }

    /// @notice What can be released now.
    function releasable() public view returns (uint256) {
        return vestedAmount(block.timestamp) - released;
    }

    /// @notice Pays what has vested to the beneficiary. Anyone may call it.
    function release() external returns (uint256 amount) {
        amount = releasable();
        if (amount == 0) revert NothingVested();
        released += amount;
        Terms memory t = terms();
        emit Released(amount);
        IERC20(t.token).safeTransfer(t.beneficiary, amount);
    }

    /// @notice Claims the dividends the held tokens earned to the dividend recipient. Anyone may call it.
    function claimDividends() external returns (uint256 amount) {
        Terms memory t = terms();
        if (t.dividendRecipient == address(0)) revert NoDividendRecipient();
        amount = IOstraTokenDividends(t.token).claimTo(t.dividendRecipient);
        emit DividendsClaimed(t.dividendRecipient, amount);
    }
}
