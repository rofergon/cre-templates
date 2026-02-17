// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IIdentityRegistry.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract IdentityRegistry is IIdentityRegistry, Ownable {
    mapping(address => address) private _identities;
    mapping(address => uint16) private _countries;

    event IdentityRegistered(address indexed userAddress, address indexed identity, uint16 country);
    event IdentityRemoved(address indexed userAddress, address indexed identity);
    event CountryUpdated(address indexed userAddress, uint16 country);

    constructor() {}

    function registerIdentity(address _userAddress, address _identity, uint16 _country) external override onlyOwner {
        require(_userAddress != address(0), "Invalid address");
        require(_identity != address(0), "Invalid identity");
        _identities[_userAddress] = _identity;
        _countries[_userAddress] = _country;
        emit IdentityRegistered(_userAddress, _identity, _country);
    }

    function deleteIdentity(address _userAddress) external override onlyOwner {
        address identityAddr = _identities[_userAddress];
        require(identityAddr != address(0), "Not registered");
        delete _identities[_userAddress];
        delete _countries[_userAddress];
        emit IdentityRemoved(_userAddress, identityAddr);
    }

    function setCountry(address _userAddress, uint16 _country) external override onlyOwner {
        require(_identities[_userAddress] != address(0), "Not registered");
        _countries[_userAddress] = _country;
        emit CountryUpdated(_userAddress, _country);
    }

    function identity(address _userAddress) external view override returns (address) {
        return _identities[_userAddress];
    }

    function investorCountry(address _userAddress) external view override returns (uint16) {
        return _countries[_userAddress];
    }

    function isVerified(address _userAddress) external view override returns (bool) {
        return _identities[_userAddress] != address(0);
    }
}
