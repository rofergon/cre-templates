// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title IVault
/// @notice Interface for the Chainlink ACE Vault contract
interface IVault {
    /// @notice Registers a token and its PolicyEngine on the Vault
    function register(address token, address policyEngine) external;

    /// @notice Deposits tokens into the Vault. Note: requires approval first.
    function deposit(address token, uint256 amount) external;

    /// @notice Redeems a withdrawal ticket on-chain to withdraw tokens from the Vault
    function withdrawWithTicket(address token, uint256 amount, bytes calldata ticket) external;
}
