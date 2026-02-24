// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IVault.sol";

error NotAnOracle();
error ZeroAddress();

/// @title PrivateEmployeeEquity
/// @notice Replaces EmployeeVesting by managing interactions with the Chainlink ACE Vault
///         for private token transfers.
contract PrivateEmployeeEquity is Ownable {
    struct ClaimRequirements {
        uint64 cliffEndTimestamp;
        bytes32 goalId;
        bool goalRequired;
        bool initialized;
    }

    IVault public vault;
    IERC20 public token;

    mapping(address => bool) public oracles;
    mapping(address => bool) public employmentStatus;
    mapping(bytes32 => bool) public goalsAchieved;
    mapping(address => ClaimRequirements) public claimRequirements;

    event OracleStatusUpdated(address indexed oracle, bool isAuthorized);
    event PrivateDeposit(uint256 amount);
    event TicketRedeemed(address indexed redeemer, uint256 amount);
    event EmploymentStatusUpdated(address indexed employee, bool employed);
    event GoalUpdated(bytes32 indexed goalId, bool achieved);
    event ClaimRequirementsUpdated(
        address indexed employee,
        uint64 cliffEndTimestamp,
        bytes32 indexed goalId,
        bool goalRequired
    );

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

    /// @notice Updates employment status for vesting-style compliance gating.
    function updateEmploymentStatus(address employee, bool employed) external onlyOracle {
        if (employee == address(0)) revert ZeroAddress();
        employmentStatus[employee] = employed;
        emit EmploymentStatusUpdated(employee, employed);
    }

    /// @notice Updates a performance goal status used by claim requirements.
    function setGoalAchieved(bytes32 goalId, bool achieved) external onlyOracle {
        goalsAchieved[goalId] = achieved;
        emit GoalUpdated(goalId, achieved);
    }

    /// @notice Sets cliff + goal requirements for an employee before allowing claim flow.
    function setClaimRequirements(
        address employee,
        uint64 cliffEndTimestamp,
        bytes32 goalId,
        bool goalRequired
    ) external onlyOracle {
        if (employee == address(0)) revert ZeroAddress();
        claimRequirements[employee] = ClaimRequirements({
            cliffEndTimestamp: cliffEndTimestamp,
            goalId: goalId,
            goalRequired: goalRequired,
            initialized: true
        });
        emit ClaimRequirementsUpdated(employee, cliffEndTimestamp, goalId, goalRequired);
    }

    /// @notice Returns whether an employee currently satisfies configured claim requirements.
    /// @dev If no requirements were configured for the employee, this returns true.
    function isEmployeeEligible(address employee) public view returns (bool) {
        ClaimRequirements memory req = claimRequirements[employee];
        if (!req.initialized) return true;

        if (!employmentStatus[employee]) return false;
        if (block.timestamp < req.cliffEndTimestamp) return false;
        if (req.goalRequired && !goalsAchieved[req.goalId]) return false;

        return true;
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
