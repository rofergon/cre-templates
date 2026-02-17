// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./IERC3643.sol";
import "./IIdentityRegistry.sol";
import "./ICompliance.sol";

contract Token is ERC20, Ownable, IERC3643 {
    IIdentityRegistry public override identityRegistry;
    ICompliance public override compliance;

    mapping(address => bool) private _frozen;
    mapping(address => uint256) private _frozenTokens;
    bool private _paused;

    modifier whenNotPaused() {
        require(!_paused, "Token is paused");
        _;
    }

    constructor(
        string memory name,
        string memory symbol,
        address _identityRegistry,
        address _compliance
    ) ERC20(name, symbol) {
        require(_identityRegistry != address(0), "Invalid Registry");
        require(_compliance != address(0), "Invalid Compliance");
        identityRegistry = IIdentityRegistry(_identityRegistry);
        compliance = ICompliance(_compliance);
    }

    // IERC3643 Implementation

    function setIdentityRegistry(address _identityRegistry) external override onlyOwner {
        require(_identityRegistry != address(0), "Invalid address");
        identityRegistry = IIdentityRegistry(_identityRegistry);
        emit IdentityRegistryAdded(_identityRegistry);
    }

    function setCompliance(address _compliance) external override onlyOwner {
        require(_compliance != address(0), "Invalid address");
        compliance = ICompliance(_compliance);
        emit ComplianceAdded(_compliance);
    }

    function paused() external view override returns (bool) {
        return _paused;
    }

    function pause() external override onlyOwner {
        require(!_paused, "Already paused");
        _paused = true;
        // Emit Paused event if inherited from Pausable, but standard interface doesn't enforce standard Paused event, 
        // usually it's good practice. For now simpler.
    }

    function unpause() external override onlyOwner {
        require(_paused, "Not paused");
        _paused = false;
    }

    function isFrozen(address _userAddress) external view override returns (bool) {
        return _frozen[_userAddress];
    }

    function getFrozenTokens(address _userAddress) external view returns (uint256) {
        return _frozenTokens[_userAddress];
    }

    function setAddressFrozen(address _userAddress, bool _freeze) external override onlyOwner {
        _frozen[_userAddress] = _freeze;
        emit AddressFrozen(_userAddress, _freeze, msg.sender);
    }

    function freezePartialTokens(address _userAddress, uint256 _amount) external override onlyOwner {
        require(balanceOf(_userAddress) >= _amount, "Amount exceeds balance");
        _frozenTokens[_userAddress] = _amount;
        emit AddressFrozen(_userAddress, true, msg.sender); // Reusing event to signal freeze state change
    }

    function forcedTransfer(address _from, address _to, uint256 _amount) external override onlyOwner returns (bool) {
        require(identityRegistry.isVerified(_to), "Receiver not verified");
        require(compliance.canTransfer(_from, _to, _amount), "Compliance failed");
        
        _transfer(_from, _to, _amount);
        compliance.transferred(_from, _to, _amount);
        return true;
    }

    function mint(address _to, uint256 _amount) external override onlyOwner {
        require(identityRegistry.isVerified(_to), "Identity not verified");
        require(compliance.canTransfer(address(0), _to, _amount), "Compliance failed");
        _mint(_to, _amount);
        compliance.created(_to, _amount);
    }

    function burn(address _userAddress, uint256 _amount) external override onlyOwner {
        require(compliance.canTransfer(_userAddress, address(0), _amount), "Compliance failed");
        require(!_frozen[_userAddress], "Wallet is frozen");
        require(balanceOf(_userAddress) - _frozenTokens[_userAddress] >= _amount, "Amount frozen");
        
        _burn(_userAddress, _amount);
        compliance.destroyed(_userAddress, _amount);
    }

    function version() external pure override returns (string memory) {
        return "1.0.0";
    }

    function decimals() public view override(ERC20, IERC3643) returns (uint8) {
        return super.decimals();
    }

    // ERC20 Overrides

    function transfer(address to, uint256 amount) public override(ERC20, IERC20) whenNotPaused returns (bool) {
        require(!_frozen[msg.sender], "Sender address is frozen");
        require(!_frozen[to], "Receiver address is frozen");
        require(balanceOf(msg.sender) - _frozenTokens[msg.sender] >= amount, "Insufficient free balance");

        require(identityRegistry.isVerified(msg.sender), "Sender not verified");
        require(identityRegistry.isVerified(to), "Receiver not verified");
        require(compliance.canTransfer(msg.sender, to, amount), "Compliance failed");

        bool success = super.transfer(to, amount);
        if (success) {
            compliance.transferred(msg.sender, to, amount);
        }
        return success;
    }

    function transferFrom(address from, address to, uint256 amount) public override(ERC20, IERC20) whenNotPaused returns (bool) {
        require(!_frozen[from], "Sender address is frozen");
        require(!_frozen[to], "Receiver address is frozen");
        require(balanceOf(from) - _frozenTokens[from] >= amount, "Insufficient free balance");

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
