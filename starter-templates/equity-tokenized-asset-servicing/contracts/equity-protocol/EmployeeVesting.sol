// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title EmployeeVesting
/// @notice Manages equity token vesting grants for employees.
///         createGrant is callable by authorized oracles (e.g. EquityWorkflowReceiver via CRE)
///         after the owner pre-funds the contract using fundVesting().
contract EmployeeVesting is Ownable {
    struct Grant {
        uint256 totalAmount;
        uint256 startTime;
        uint256 cliffDuration;
        uint256 vestingDuration;
        uint256 amountClaimed;
        bool isRevocable;
        bytes32 performanceGoalId; // 0 if no performance condition
    }

    IERC20 public token;

    // Employee Address -> Grant
    mapping(address => Grant) public grants;

    // Employee Address -> Employment Status
    mapping(address => bool) public isEmployed;

    // Goal ID -> Achieved
    mapping(bytes32 => bool) public goalsAchieved;

    // Authorized Oracles (e.g. EquityWorkflowReceiver)
    mapping(address => bool) public oracles;

    event GrantCreated(address indexed employee, uint256 amount);
    event TokensClaimed(address indexed employee, uint256 amount);
    event EmploymentStatusUpdated(address indexed employee, bool status);
    event GoalUpdated(bytes32 indexed goalId, bool achieved);
    event GrantRevoked(address indexed employee, uint256 amountForfeited);
    event FundingAdded(address indexed from, uint256 amount);

    error NotOracle();
    error GrantAlreadyExists();
    error InsufficientVestingPool(uint256 requested, uint256 available);
    error NoGrant();
    error NotRevocable();
    error NotEmployed();
    error NothingToClaim();
    error TransferFailed();

    /// @notice Only authorized oracles OR the contract owner can call
    modifier onlyOracle() {
        if (!oracles[msg.sender] && msg.sender != owner()) revert NotOracle();
        _;
    }

    constructor(address _token) {
        token = IERC20(_token);
    }

    // ──────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────

    /// @notice Authorize or deauthorize an oracle address
    function setOracle(address _oracle, bool _status) external onlyOwner {
        oracles[_oracle] = _status;
    }

    /// @notice Pre-fund the vesting pool with tokens.
    ///         Owner must approve this contract before calling.
    ///         This is required before any grants can be created via CRE.
    /// @param amount Amount of EQT tokens to deposit as the vesting pool
    function fundVesting(uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be > 0");
        bool success = token.transferFrom(msg.sender, address(this), amount);
        if (!success) revert TransferFailed();
        emit FundingAdded(msg.sender, amount);
    }

    /// @notice Returns the current unfunded token balance available for grants
    function vestingPoolBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ──────────────────────────────────────────────────────
    // Oracle functions (callable via CRE EquityWorkflowReceiver)
    // ──────────────────────────────────────────────────────

    /// @notice Create a vesting grant for an employee.
    ///         Tokens are drawn from the pre-funded pool (see fundVesting).
    ///         Callable by oracle (CRE Receiver) or owner.
    /// @param _employee    Employee wallet address
    /// @param _amount      Total token amount to vest
    /// @param _startTime   Unix timestamp when vesting starts
    /// @param _cliffDuration Seconds before any tokens vest
    /// @param _vestingDuration Total seconds of the vesting schedule
    /// @param _isRevocable Whether the grant can be revoked if employment ends
    /// @param _performanceGoalId bytes32 goal ID (0 = no performance condition)
    function createGrant(
        address _employee,
        uint256 _amount,
        uint256 _startTime,
        uint256 _cliffDuration,
        uint256 _vestingDuration,
        bool _isRevocable,
        bytes32 _performanceGoalId
    ) external onlyOracle {
        if (grants[_employee].totalAmount != 0) revert GrantAlreadyExists();

        uint256 poolBalance = token.balanceOf(address(this));
        if (poolBalance < _amount) revert InsufficientVestingPool(_amount, poolBalance);

        grants[_employee] = Grant({
            totalAmount: _amount,
            startTime: _startTime,
            cliffDuration: _cliffDuration,
            vestingDuration: _vestingDuration,
            amountClaimed: 0,
            isRevocable: _isRevocable,
            performanceGoalId: _performanceGoalId
        });

        isEmployed[_employee] = true;
        emit GrantCreated(_employee, _amount);
    }

    /// @notice Update an employee's employment status.
    ///         Callable by oracle (CRE Receiver) or owner.
    function updateEmploymentStatus(address _employee, bool _status) external onlyOracle {
        isEmployed[_employee] = _status;
        emit EmploymentStatusUpdated(_employee, _status);
    }

    /// @notice Mark a performance goal as achieved or not.
    ///         Callable by oracle (CRE Receiver) or owner.
    function setGoalAchieved(bytes32 _goalId, bool _status) external onlyOracle {
        goalsAchieved[_goalId] = _status;
        emit GoalUpdated(_goalId, _status);
    }

    // ──────────────────────────────────────────────────────
    // Employee functions
    // ──────────────────────────────────────────────────────

    /// @notice Calculate how many tokens have vested for an employee
    function calculateVestedAmount(address _employee) public view returns (uint256) {
        Grant memory grant = grants[_employee];

        if (grant.totalAmount == 0) return 0;

        if (block.timestamp < grant.startTime + grant.cliffDuration) {
            return 0;
        }

        if (block.timestamp >= grant.startTime + grant.vestingDuration) {
            if (grant.performanceGoalId != bytes32(0) && !goalsAchieved[grant.performanceGoalId]) {
                return 0;
            }
            return grant.totalAmount;
        }

        // Linear vesting
        uint256 timeVested = block.timestamp - grant.startTime;
        uint256 vested = (grant.totalAmount * timeVested) / grant.vestingDuration;

        if (grant.performanceGoalId != bytes32(0) && !goalsAchieved[grant.performanceGoalId]) {
            return 0;
        }

        return vested;
    }

    /// @notice Claim vested tokens. Must be employed and past cliff.
    function claim() external {
        address employee = msg.sender;
        Grant storage grant = grants[employee];

        if (!isEmployed[employee]) revert NotEmployed();
        if (grant.totalAmount == 0) revert NoGrant();

        uint256 vested = calculateVestedAmount(employee);
        uint256 claimable = vested - grant.amountClaimed;
        if (claimable == 0) revert NothingToClaim();

        grant.amountClaimed += claimable;
        bool success = token.transfer(employee, claimable);
        if (!success) revert TransferFailed();

        emit TokensClaimed(employee, claimable);
    }

    // ──────────────────────────────────────────────────────
    // Owner-only admin
    // ──────────────────────────────────────────────────────

    /// @notice Revoke a revocable grant and reclaim unvested tokens to owner.
    function revoke(address _employee) external onlyOwner {
        Grant storage grant = grants[_employee];
        if (!grant.isRevocable) revert NotRevocable();

        uint256 remaining = grant.totalAmount - grant.amountClaimed;
        delete grants[_employee];
        isEmployed[_employee] = false;

        // Return unvested tokens to owner
        if (remaining > 0) {
            bool success = token.transfer(owner(), remaining);
            if (!success) revert TransferFailed();
        }

        emit GrantRevoked(_employee, remaining);
    }
}
