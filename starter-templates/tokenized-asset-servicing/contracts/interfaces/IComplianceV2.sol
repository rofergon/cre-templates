// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ICompliance.sol";

interface IComplianceV2 is ICompliance {
    function setAgent(address agent, bool authorized) external;
    function setIdentityRegistry(address identityRegistry) external;
    function setInvestorAuthorization(address investor, bool authorized) external;
    function setInvestorAuthorizationBatch(address[] calldata investors, bool[] calldata statuses) external;
    function setInvestorLockup(address investor, uint64 lockupUntil) external;
    function setTrustedCounterparty(address account, bool trusted) external;
    function setTrustedCounterpartyBatch(address[] calldata accounts, bool trusted) external;
    function isInvestorAuthorized(address investor) external view returns (bool);
    function investorLockupUntil(address investor) external view returns (uint64);
    function isTrustedCounterparty(address account) external view returns (bool);
}
