// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The parts of x402BatchSettlement (x402-foundation/x402, contracts/evm/src/x402BatchSettlement.sol)
///         that Ostra calls. On Robinhood Chain mainnet it is deployed at
///         0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003.
interface IX402BatchSettlement {
    struct ChannelConfig {
        address payer;
        address payerAuthorizer;
        address receiver;
        address receiverAuthorizer;
        address token;
        uint40 withdrawDelay;
        bytes32 salt;
    }

    struct Voucher {
        ChannelConfig channel;
        uint128 maxClaimableAmount;
    }

    struct VoucherClaim {
        Voucher voucher;
        bytes signature;
        uint128 totalClaimed;
    }

    function deposit(ChannelConfig calldata config, uint128 amount, address collector, bytes calldata collectorData)
        external;

    function claim(VoucherClaim[] calldata voucherClaims) external;

    function settle(address receiver, address token) external;

    function initiateWithdraw(ChannelConfig calldata config, uint128 amount) external;

    function finalizeWithdraw(ChannelConfig calldata config) external;

    function refund(ChannelConfig calldata config, uint128 amount) external;

    function getChannelId(ChannelConfig calldata config) external view returns (bytes32);

    function getVoucherDigest(bytes32 channelId, uint128 maxClaimableAmount) external view returns (bytes32);

    function channels(bytes32 channelId) external view returns (uint128 balance, uint128 totalClaimed);

    function pendingWithdrawals(bytes32 channelId) external view returns (uint128 amount, uint40 initiatedAt);

    function receivers(address receiver, address token)
        external
        view
        returns (uint128 totalClaimed, uint128 totalSettled);

    function MIN_WITHDRAW_DELAY() external view returns (uint40);

    function MAX_WITHDRAW_DELAY() external view returns (uint40);
}
