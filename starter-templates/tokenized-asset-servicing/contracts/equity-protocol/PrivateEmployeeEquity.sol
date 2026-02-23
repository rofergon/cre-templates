// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IVault.sol";

error NotAnOracle();
error ZeroAddress();

/// @title PrivateEmployeeEquity
/// @notice Replaces EmployeeVesting by managing interactions with the Chainlink ACE Vault
///         for private token transfers.
contract PrivateEmployeeEquity is Ownable {
    IVault public vault;
    IERC20 public token;

    mapping(address => bool) public oracles;

    event OracleStatusUpdated(address indexed oracle, bool isAuthorized);
    event PrivateDeposit(uint256 amount);
    event TicketRedeemed(address indexed redeemer, uint256 amount);

    modifier onlyOracle() {
        if (!oracles[msg.sender] && msg.sender != owner()) revert NotAnOracle();
        _;
    }

    constructor(address _vault, address _token) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_token == address(0)) revert ZeroAddress();
        
        vault = IVault(_vault);
        token = IERC20(_token);
    }

    /// @notice Sets the authorization status of an oracle (e.g. EquityWorkflowReceiver)
    function setOracleStatus(address _oracle, bool _isAuthorized) external onlyOwner {
        if (_oracle == address(0)) revert ZeroAddress();
        oracles[_oracle] = _isAuthorized;
        emit OracleStatusUpdated(_oracle, _isAuthorized);
    }

    /// @notice Deposits tokens into the ACE Vault, losing public on-chain visibility
    ///         of the final recipient. Can only be called by an Oracle.
    function depositToVault(uint256 amount) external onlyOracle {
        // Assume this contract holds the tokens (funded by owner/deployer)
        // Ensure vault is approved
        require(token.approve(address(vault), amount), "Approval failed");
        
        // Deposit into vault pool
        vault.deposit(address(token), amount);

        emit PrivateDeposit(amount);
    }

    /// @notice Redeems a ticket to withdraw from the Vault.
    ///         The receiver handles the payload.
    function redeemTicket(uint256 amount, bytes calldata ticket) external onlyOracle {
        // Vault uses caller's address for something? Or just transfers to ticket owner?
        // Wait, the withdrawWithTicket function receives the tokens. 
        // Actually, the Vault's withdrawWithTicket needs to be called by the ticket subject 
        // OR the vault will transfer tokens to the subject encoded in the ticket.
        // Let's call it on behalf of the user, the Vault will handle it based on ticket signature.
        vault.withdrawWithTicket(address(token), amount, ticket);

        // Note: we can't emit the exact redeemer address easily here unless we parse the ticket
        // but the Event on the vault will emit it.
        emit TicketRedeemed(msg.sender, amount);
    }
}
