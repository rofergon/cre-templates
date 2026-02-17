// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

    // Authorized Oracles
    mapping(address => bool) public oracles;

    event GrantCreated(address indexed employee, uint256 amount);
    event TokensClaimed(address indexed employee, uint256 amount);
    event EmploymentStatusUpdated(address indexed employee, bool status);
    event GoalUpdated(bytes32 indexed goalId, bool achieved);
    event GrantRevoked(address indexed employee, uint256 amountForfeited);

    modifier onlyOracle() {
        require(oracles[msg.sender] || msg.sender == owner(), "Not authorized oracle");
        _;
    }

    constructor(address _token) Ownable(msg.sender) {
        token = IERC20(_token);
    }

    function setOracle(address _oracle, bool _status) external onlyOwner {
        oracles[_oracle] = _status;
    }

    function createGrant(
        address _employee,
        uint256 _amount,
        uint256 _startTime,
        uint256 _cliffDuration,
        uint256 _vestingDuration,
        bool _isRevocable,
        bytes32 _performanceGoalId
    ) external onlyOwner {
        require(grants[_employee].totalAmount == 0, "Grant already exists");
        require(token.transferFrom(msg.sender, address(this), _amount), "Funding failed");
        
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

    // Oracle function to update employment status
    function updateEmploymentStatus(address _employee, bool _status) external onlyOracle {
        isEmployed[_employee] = _status;
        emit EmploymentStatusUpdated(_employee, _status);
        
        // If terminated and revocable, logic to revoke unvested could be triggered here or manually
    }

    // Oracle function to update performance goals
    function setGoalAchieved(bytes32 _goalId, bool _status) external onlyOracle {
        goalsAchieved[_goalId] = _status;
        emit GoalUpdated(_goalId, _status);
    }

    function calculateVestedAmount(address _employee) public view returns (uint256) {
        Grant memory grant = grants[_employee];
        
        if (grant.totalAmount == 0) return 0;
        
        // If terminated, vesting stops (simple logic: assume vesting stops at current time if employed, but here we check status)
        // For strictness: we'd track terminationDate. For now, if not employed, we assume 0 vesting or frozen.
        // Simplified: if !isEmployed, return 0 or last snapshot? 
        // Better: this function calculates based on TIME. The claim function checks status.
        
        if (block.timestamp < grant.startTime + grant.cliffDuration) {
            return 0;
        }

        if (block.timestamp >= grant.startTime + grant.vestingDuration) {
             // Performance check for 100%
             if (grant.performanceGoalId != bytes32(0) && !goalsAchieved[grant.performanceGoalId]) {
                 return 0; // Or partial? Let's say goal is binary for the whole grant in this model
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

    function claim() external {
        address employee = msg.sender;
        Grant storage grant = grants[employee];
        
        require(isEmployed[employee], "Terminated");
        require(grant.totalAmount > 0, "No grant");

        uint256 vested = calculateVestedAmount(employee);
        uint256 claimable = vested - grant.amountClaimed;
        
        require(claimable > 0, "Nothing to claim");

        grant.amountClaimed += claimable;
        require(token.transfer(employee, claimable), "Transfer failed"); // Token must be in contract
        
        emit TokensClaimed(employee, claimable);
    }

    // Admin revocation
    function revoke(address _employee) external onlyOwner {
        Grant storage grant = grants[_employee];
        require(grant.isRevocable, "Not revocable");
        
        // recover unvested tokens
        uint256 vested = calculateVestedAmount(_employee);
        // If terminated, maybe strictly 0 or whatever was vested before termination. 
        // This is a simplified implementation.
        
        uint256 remaining = grant.totalAmount - grant.amountClaimed;
        // In a real scenario, we'd burn or return to pool.
        // Here we just delete the grant to stop further claims
        delete grants[_employee];
        isEmployed[_employee] = false;
        
        emit GrantRevoked(_employee, remaining);
    }
}
