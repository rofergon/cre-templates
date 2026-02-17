// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ReceiverTemplate.sol";
import "./IIdentityRegistry.sol";
import "./IERC3643.sol";
import "./EmployeeVesting.sol";

/// @notice Receiver contract that maps CRE workflow reports into equity protocol actions.
/// @dev The contract must be granted ownership/oracle permissions on target contracts.
contract EquityWorkflowReceiver is ReceiverTemplate {
    enum ActionType {
        SYNC_KYC,
        SYNC_EMPLOYMENT_STATUS,
        SYNC_GOAL,
        SYNC_FREEZE_WALLET
    }

    IIdentityRegistry public identityRegistry;
    EmployeeVesting public employeeVesting;
    IERC3643 public token;

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
        ) {
            revert ZeroAddress();
        }

        identityRegistry = IIdentityRegistry(_identityRegistry);
        employeeVesting = EmployeeVesting(_employeeVesting);
        token = IERC3643(_token);

        emit TargetsUpdated(_identityRegistry, _employeeVesting, _token);
    }

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
        } else {
            revert UnsupportedAction(rawActionType);
        }

        emit SyncActionExecuted(actionType, payload);
    }

    function _processKycPayload(bytes memory payload) internal {
        (address employee, bool verified, address identity, uint16 country) = abi.decode(
            payload,
            (address, bool, address, uint16)
        );

        if (verified) {
            address currentIdentity = identityRegistry.identity(employee);

            if (currentIdentity == address(0)) {
                identityRegistry.registerIdentity(employee, identity, country);
            } else if (currentIdentity != identity) {
                identityRegistry.registerIdentity(employee, identity, country);
            } else {
                identityRegistry.setCountry(employee, country);
            }
        } else {
            address currentIdentity = identityRegistry.identity(employee);
            if (currentIdentity != address(0)) {
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
}
