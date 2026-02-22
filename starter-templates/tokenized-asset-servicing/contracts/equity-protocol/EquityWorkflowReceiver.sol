// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ReceiverTemplate.sol";
import "./IIdentityRegistry.sol";
import "./IERC3643.sol";
import "./EmployeeVesting.sol";

/// @title EquityWorkflowReceiver
/// @notice Receives CRE workflow reports and dispatches them to the Equity Protocol.
///
///  Action Types:
///    0 = SYNC_KYC              → IdentityRegistry
///    1 = SYNC_EMPLOYMENT_STATUS → EmployeeVesting.updateEmploymentStatus()
///    2 = SYNC_GOAL             → EmployeeVesting.setGoalAchieved()
///    3 = SYNC_FREEZE_WALLET    → Token.setAddressFrozen()
///    4 = SYNC_CREATE_GRANT     → EmployeeVesting.createGrant() [oracle]
///
/// @dev This contract must hold:
///   - Ownership of IdentityRegistry  (for registerIdentity / deleteIdentity / setCountry)
///   - Ownership of Token             (for setAddressFrozen)
///   - Oracle rights on EmployeeVesting (for updateEmploymentStatus, setGoalAchieved, createGrant)
contract EquityWorkflowReceiver is ReceiverTemplate {
    enum ActionType {
        SYNC_KYC,               // 0
        SYNC_EMPLOYMENT_STATUS,  // 1
        SYNC_GOAL,               // 2
        SYNC_FREEZE_WALLET,      // 3
        SYNC_CREATE_GRANT        // 4
    }

    IIdentityRegistry public identityRegistry;
    EmployeeVesting   public employeeVesting;
    IERC3643          public token;

    event SyncActionExecuted(ActionType indexed actionType, bytes payload);
    event TargetsUpdated(
        address indexed identityRegistry,
        address indexed employeeVesting,
        address indexed token
    );

    error ZeroAddress();
    error UnsupportedAction(uint8 actionType);

    constructor(
        address _forwarderAddress,
        address _identityRegistry,
        address _employeeVesting,
        address _token
    ) ReceiverTemplate(_forwarderAddress) {
        _setTargets(_identityRegistry, _employeeVesting, _token);
    }

    // ──────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────

    function setTargets(
        address _identityRegistry,
        address _employeeVesting,
        address _token
    ) external onlyOwner {
        _setTargets(_identityRegistry, _employeeVesting, _token);
    }

    function _setTargets(
        address _identityRegistry,
        address _employeeVesting,
        address _token
    ) internal {
        if (
            _identityRegistry == address(0) ||
            _employeeVesting == address(0) ||
            _token == address(0)
        ) revert ZeroAddress();

        identityRegistry = IIdentityRegistry(_identityRegistry);
        employeeVesting  = EmployeeVesting(_employeeVesting);
        token            = IERC3643(_token);

        emit TargetsUpdated(_identityRegistry, _employeeVesting, _token);
    }

    // ──────────────────────────────────────────────────────
    // CRE report dispatcher
    // ──────────────────────────────────────────────────────

    function _processReport(bytes calldata report) internal override {
        (uint8 rawActionType, bytes memory payload) = abi.decode(report, (uint8, bytes));
        ActionType actionType = ActionType(rawActionType);

        if (actionType == ActionType.SYNC_KYC) {
            _processKycPayload(payload);
        } else if (actionType == ActionType.SYNC_EMPLOYMENT_STATUS) {
            _processEmploymentPayload(payload);
        } else if (actionType == ActionType.SYNC_GOAL) {
            _processGoalPayload(payload);
        } else if (actionType == ActionType.SYNC_FREEZE_WALLET) {
            _processFreezeWalletPayload(payload);
        } else if (actionType == ActionType.SYNC_CREATE_GRANT) {
            _processCreateGrantPayload(payload);
        } else {
            revert UnsupportedAction(rawActionType);
        }

        emit SyncActionExecuted(actionType, payload);
    }

    // ──────────────────────────────────────────────────────
    // Action processors
    // ──────────────────────────────────────────────────────

    function _processKycPayload(bytes memory payload) internal {
        (address employee, bool verified, address identity, uint16 country) =
            abi.decode(payload, (address, bool, address, uint16));

        if (verified) {
            address currentIdentity = identityRegistry.identity(employee);
            if (currentIdentity == address(0) || currentIdentity != identity) {
                identityRegistry.registerIdentity(employee, identity, country);
            } else {
                identityRegistry.setCountry(employee, country);
            }
        } else {
            if (identityRegistry.identity(employee) != address(0)) {
                identityRegistry.deleteIdentity(employee);
            }
        }
    }

    function _processEmploymentPayload(bytes memory payload) internal {
        (address employee, bool employed) = abi.decode(payload, (address, bool));
        employeeVesting.updateEmploymentStatus(employee, employed);
    }

    function _processGoalPayload(bytes memory payload) internal {
        (bytes32 goalId, bool achieved) = abi.decode(payload, (bytes32, bool));
        employeeVesting.setGoalAchieved(goalId, achieved);
    }

    function _processFreezeWalletPayload(bytes memory payload) internal {
        (address wallet, bool frozen) = abi.decode(payload, (address, bool));
        token.setAddressFrozen(wallet, frozen);
    }

    /// @notice Creates a vesting grant via CRE.
    ///         Requires EmployeeVesting to be pre-funded with sufficient tokens
    ///         (owner calls EmployeeVesting.fundVesting() before this is used).
    function _processCreateGrantPayload(bytes memory payload) internal {
        (
            address employee,
            uint256 amount,
            uint256 startTime,
            uint256 cliffDuration,
            uint256 vestingDuration,
            bool    isRevocable,
            bytes32 performanceGoalId
        ) = abi.decode(payload, (address, uint256, uint256, uint256, uint256, bool, bytes32));

        employeeVesting.createGrant(
            employee,
            amount,
            startTime,
            cliffDuration,
            vestingDuration,
            isRevocable,
            performanceGoalId
        );
    }
}
