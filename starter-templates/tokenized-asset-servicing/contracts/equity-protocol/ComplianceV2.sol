// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IComplianceV2.sol";
import "../interfaces/IIdentityRegistry.sol";

/// @title ComplianceV2
/// @notice Global transfer policy module for ERC-3643 token transfers.
contract ComplianceV2 is IComplianceV2, Ownable {
    IIdentityRegistry public identityRegistry;

    mapping(address => bool) private _boundTokens;
    mapping(address => bool) private _tokenAgents;
    mapping(address => bool) private _authorizedInvestors;
    mapping(address => uint64) public override investorLockupUntil;
    mapping(address => bool) private _trustedCounterparties;

    event IdentityRegistryUpdated(address indexed previousRegistry, address indexed newRegistry);
    event AgentUpdated(address indexed agent, bool authorized);
    event InvestorAuthorizationUpdated(address indexed investor, bool authorized);
    event InvestorLockupUpdated(address indexed investor, uint64 lockupUntil);
    event TrustedCounterpartyUpdated(address indexed account, bool trusted);

    modifier onlyAgentOrOwner() {
        require(msg.sender == owner() || _tokenAgents[msg.sender], "Caller is not owner/agent");
        _;
    }

    modifier onlyBoundToken() {
        require(_boundTokens[msg.sender], "Caller is not a bound token");
        _;
    }

    constructor(address _identityRegistry) {
        require(_identityRegistry != address(0), "Invalid identity registry");
        identityRegistry = IIdentityRegistry(_identityRegistry);
    }

    function canTransfer(address _from, address _to, uint256) external view override returns (bool) {
        if (_from == address(0)) {
            // Mint: receiver must be verified; additionally enforce auth unless it is an operational counterparty.
            if (!_isVerified(_to)) return false;
            return _trustedCounterparties[_to] || _authorizedInvestors[_to];
        }

        if (_to == address(0)) {
            // Burn: allow operational unwind.
            return true;
        }

        if (!_isVerified(_from) || !_isVerified(_to)) {
            return false;
        }

        if (_trustedCounterparties[_to] || _trustedCounterparties[_from]) {
            return true;
        }

        if (!_authorizedInvestors[_to]) {
            return false;
        }

        if (_authorizedInvestors[_from] && block.timestamp < investorLockupUntil[_from]) {
            return false;
        }

        // If sender was revoked, allow transfer to authorized destination (regulatory unwind).
        return true;
    }

    function transferred(address, address, uint256) external override onlyBoundToken {
        // Hook for future accounting/risk logic.
    }

    function created(address, uint256) external override onlyBoundToken {
        // Hook for future accounting/risk logic.
    }

    function destroyed(address, uint256) external override onlyBoundToken {
        // Hook for future accounting/risk logic.
    }

    function bindToken(address _token) external override onlyOwner {
        _boundTokens[_token] = true;
    }

    function unbindToken(address _token) external override onlyOwner {
        _boundTokens[_token] = false;
    }

    function isTokenBound(address _token) external view override returns (bool) {
        return _boundTokens[_token];
    }

    function addTokenAgent(address _agentAddress) external override onlyOwner {
        _tokenAgents[_agentAddress] = true;
        emit AgentUpdated(_agentAddress, true);
    }

    function removeTokenAgent(address _agentAddress) external override onlyOwner {
        _tokenAgents[_agentAddress] = false;
        emit AgentUpdated(_agentAddress, false);
    }

    function isTokenAgent(address _agentAddress) external view override returns (bool) {
        return _tokenAgents[_agentAddress];
    }

    function setAgent(address agent, bool authorized) external override onlyOwner {
        _tokenAgents[agent] = authorized;
        emit AgentUpdated(agent, authorized);
    }

    function setIdentityRegistry(address _identityRegistry) external override onlyOwner {
        require(_identityRegistry != address(0), "Invalid identity registry");
        address previous = address(identityRegistry);
        identityRegistry = IIdentityRegistry(_identityRegistry);
        emit IdentityRegistryUpdated(previous, _identityRegistry);
    }

    function setInvestorAuthorization(address investor, bool authorized) external override onlyAgentOrOwner {
        _authorizedInvestors[investor] = authorized;
        emit InvestorAuthorizationUpdated(investor, authorized);
    }

    function setInvestorAuthorizationBatch(
        address[] calldata investors,
        bool[] calldata statuses
    ) external override onlyAgentOrOwner {
        require(investors.length == statuses.length, "Array length mismatch");
        for (uint256 i = 0; i < investors.length; i++) {
            _authorizedInvestors[investors[i]] = statuses[i];
            emit InvestorAuthorizationUpdated(investors[i], statuses[i]);
        }
    }

    function setInvestorLockup(address investor, uint64 lockupUntil) external override onlyAgentOrOwner {
        investorLockupUntil[investor] = lockupUntil;
        emit InvestorLockupUpdated(investor, lockupUntil);
    }

    function setTrustedCounterparty(address account, bool trusted) external override onlyOwner {
        _trustedCounterparties[account] = trusted;
        emit TrustedCounterpartyUpdated(account, trusted);
    }

    function setTrustedCounterpartyBatch(address[] calldata accounts, bool trusted) external override onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            _trustedCounterparties[accounts[i]] = trusted;
            emit TrustedCounterpartyUpdated(accounts[i], trusted);
        }
    }

    function isInvestorAuthorized(address investor) external view override returns (bool) {
        return _authorizedInvestors[investor];
    }

    function isTrustedCounterparty(address account) external view override returns (bool) {
        return _trustedCounterparties[account];
    }

    function _isVerified(address account) internal view returns (bool) {
        if (account == address(0)) return false;
        return identityRegistry.isVerified(account);
    }
}
