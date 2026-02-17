// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./IIdentityRegistry.sol";
import "./ICompliance.sol";

contract Token is ERC20, Ownable {
    IIdentityRegistry public identityRegistry;
    ICompliance public compliance;

    event IdentityRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ComplianceUpdated(address indexed oldCompliance, address indexed newCompliance);

    constructor(
        string memory name,
        string memory symbol,
        address _identityRegistry,
        address _compliance
    ) ERC20(name, symbol) Ownable(msg.sender) {
        require(_identityRegistry != address(0), "Invalid Registry");
        require(_compliance != address(0), "Invalid Compliance");
        identityRegistry = IIdentityRegistry(_identityRegistry);
        compliance = ICompliance(_compliance);
    }

    function setIdentityRegistry(address _identityRegistry) external onlyOwner {
        require(_identityRegistry != address(0), "Invalid address");
        emit IdentityRegistryUpdated(address(identityRegistry), _identityRegistry);
        identityRegistry = IIdentityRegistry(_identityRegistry);
    }

    function setCompliance(address _compliance) external onlyOwner {
        require(_compliance != address(0), "Invalid address");
        emit ComplianceUpdated(address(compliance), _compliance);
        compliance = ICompliance(_compliance);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        require(identityRegistry.isVerified(to), "Identity not verified");
        require(compliance.canTransfer(address(0), to, amount), "Compliance failed");
        _mint(to, amount);
        compliance.created(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        require(compliance.canTransfer(from, address(0), amount), "Compliance failed");
        _burn(from, amount);
        compliance.destroyed(from, amount);
    }

    // Override transfer to include compliance checks
    function transfer(address to, uint256 amount) public override returns (bool) {
        require(identityRegistry.isVerified(msg.sender), "Sender not verified");
        require(identityRegistry.isVerified(to), "Receiver not verified");
        require(compliance.canTransfer(msg.sender, to, amount), "Compliance failed");
        
        bool success = super.transfer(to, amount);
        if (success) {
            compliance.transferred(msg.sender, to, amount);
        }
        return success;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(identityRegistry.isVerified(from), "Sender not verified");
        require(identityRegistry.isVerified(to), "Receiver not verified");
        require(compliance.canTransfer(from, to, amount), "Compliance failed");

        bool success = super.transferFrom(from, to, amount);
        if (success) {
            compliance.transferred(from, to, amount);
        }
        return success;
    }
}
