// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ReceiverTemplate.sol";
import "../interfaces/IIdentityRegistry.sol";
import "../interfaces/IERC3643.sol";
import "./PrivateEmployeeEquity.sol";

/// @title EquityWorkflowReceiver
/// @notice Receives CRE workflow reports and dispatches them to the Equity Protocol.
///
///  Action Types:
///    0 = SYNC_KYC              → IdentityRegistry
///    1 = SYNC_EMPLOYMENT_STATUS → PrivateEmployeeEquity.updateEmploymentStatus() + freeze sync
///    2 = SYNC_GOAL              → PrivateEmployeeEquity.setGoalAchieved() + optional freeze sync
///    3 = SYNC_FREEZE_WALLET    → Token.setAddressFrozen()
///    4 = SYNC_PRIVATE_DEPOSIT  → PrivateEmployeeEquity.depositToVault()
///    5 = SYNC_BATCH            → process multiple
///    6 = SYNC_REDEEM_TICKET    → disabled (must redeem onchain from end-user wallet)
///    7 = SYNC_MINT             → Token.mint(to, amount)
///    8 = SYNC_SET_CLAIM_REQUIREMENTS → PrivateEmployeeEquity.setClaimRequirements() + freeze sync
///
/// @dev This contract must hold:
///   - Ownership of IdentityRegistry  (for registerIdentity / deleteIdentity / setCountry)
///   - Ownership of Token             (for setAddressFrozen)
///   - Oracle rights on PrivateEmployeeEquity (for private ACE transfers)
contract EquityWorkflowReceiver is ReceiverTemplate {
    enum ActionType {
        SYNC_KYC,               // 0
        SYNC_EMPLOYMENT_STATUS, // 1
        SYNC_GOAL,              // 2
        SYNC_FREEZE_WALLET,     // 3
        SYNC_PRIVATE_DEPOSIT,   // 4
        SYNC_BATCH,             // 5
        SYNC_REDEEM_TICKET,     // 6
        SYNC_MINT,              // 7
        SYNC_SET_CLAIM_REQUIREMENTS // 8
    }

    IIdentityRegistry public identityRegistry;
    PrivateEmployeeEquity public privateEquity;
    IERC3643          public token;

    event SyncActionExecuted(ActionType indexed actionType, bytes payload);
    event TargetsUpdated(
        address indexed identityRegistry,
        address indexed privateEquity,
        address indexed token
    );

    error UnsupportedAction(uint8 actionType);
    error RedeemTicketDisabled();

    constructor(
        address _forwarderAddress,
        address _identityRegistry,
        address _privateEquity,
        address _token
    ) ReceiverTemplate(_forwarderAddress) {
        _setTargets(_identityRegistry, _privateEquity, _token);
    }

    // ──────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────

    function setTargets(
        address _identityRegistry,
        address _privateEquity,
        address _token
    ) external onlyOwner {
        _setTargets(_identityRegistry, _privateEquity, _token);
    }

    function _setTargets(
        address _identityRegistry,
        address _privateEquity,
        address _token
    ) internal {
        if (
            _identityRegistry == address(0) ||
            _privateEquity == address(0) ||
            _token == address(0)
        ) revert ZeroAddress();

        identityRegistry = IIdentityRegistry(_identityRegistry);
        privateEquity    = PrivateEmployeeEquity(_privateEquity);
        token            = IERC3643(_token);

        emit TargetsUpdated(_identityRegistry, _privateEquity, _token);
    }

    // ──────────────────────────────────────────────────────
    // CRE report dispatcher
    // ──────────────────────────────────────────────────────

    function _processReport(bytes calldata report) internal override {
        _processSingleReport(report);
    }

    function _processSingleReport(bytes memory report) internal {
        (uint8 rawActionType, bytes memory payload) = abi.decode(report, (uint8, bytes));
        ActionType actionType = ActionType(rawActionType);

        if (actionType == ActionType.SYNC_KYC) {
            _processKycPayload(payload);
        } else if (actionType == ActionType.SYNC_EMPLOYMENT_STATUS) {
            _processEmploymentStatusPayload(payload);
        } else if (actionType == ActionType.SYNC_GOAL) {
            _processGoalPayload(payload);
        } else if (actionType == ActionType.SYNC_FREEZE_WALLET) {
            _processFreezeWalletPayload(payload);
        } else if (actionType == ActionType.SYNC_PRIVATE_DEPOSIT) {
            _processPrivateDepositPayload(payload);
        } else if (actionType == ActionType.SYNC_BATCH) {
            bytes[] memory batches = abi.decode(payload, (bytes[]));
            for (uint256 i = 0; i < batches.length; i++) {
                _processSingleReport(batches[i]);
            }
        } else if (actionType == ActionType.SYNC_REDEEM_TICKET) {
            revert RedeemTicketDisabled();
        } else if (actionType == ActionType.SYNC_MINT) {
            _processMintPayload(payload);
        } else if (actionType == ActionType.SYNC_SET_CLAIM_REQUIREMENTS) {
            _processClaimRequirementsPayload(payload);
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

    function _processFreezeWalletPayload(bytes memory payload) internal {
        (address wallet, bool frozen) = abi.decode(payload, (address, bool));
        token.setAddressFrozen(wallet, frozen);
    }

    function _processEmploymentStatusPayload(bytes memory payload) internal {
        (address employee, bool employed) = abi.decode(payload, (address, bool));
        privateEquity.updateEmploymentStatus(employee, employed);
        _syncWalletFreezeFromEligibility(employee);
    }

    function _processGoalPayload(bytes memory payload) internal {
        (bytes32 goalId, bool achieved, address employeeHint) = abi.decode(payload, (bytes32, bool, address));
        privateEquity.setGoalAchieved(goalId, achieved);
        if (employeeHint != address(0)) {
            _syncWalletFreezeFromEligibility(employeeHint);
        }
    }

    function _processPrivateDepositPayload(bytes memory payload) internal {
        uint256 amount = abi.decode(payload, (uint256));
        privateEquity.depositToVault(amount);
    }

    function _processMintPayload(bytes memory payload) internal {
        (address to, uint256 amount) = abi.decode(payload, (address, uint256));
        token.mint(to, amount);
    }

    function _processClaimRequirementsPayload(bytes memory payload) internal {
        (address employee, uint64 cliffEndTimestamp, bytes32 goalId, bool goalRequired) =
            abi.decode(payload, (address, uint64, bytes32, bool));
        privateEquity.setClaimRequirements(employee, cliffEndTimestamp, goalId, goalRequired);
        _syncWalletFreezeFromEligibility(employee);
    }

    function _syncWalletFreezeFromEligibility(address employee) internal {
        bool eligible = privateEquity.isEmployeeEligible(employee);
        token.setAddressFrozen(employee, !eligible);
    }
}
