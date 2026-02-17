// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IIdentityRegistry {
    /**
     * @dev Register an identity contract corresponding to a user address.
     * @param _userAddress The address of the user
     * @param _identity The address of the identity contract
     * @param _country The country of the user
     */
    function registerIdentity(address _userAddress, address _identity, uint16 _country) external;

    /**
     * @dev Removes an identity from the registry
     * @param _userAddress The address of the user
     */
    function deleteIdentity(address _userAddress) external;

    /**
     * @dev Sets the country for a user
     * @param _userAddress The address of the user
     * @param _country The country code
     */
    function setCountry(address _userAddress, uint16 _country) external;

    /**
     * @dev Returns the identity contract address for a user
     * @param _userAddress The address of the user
     */
    function identity(address _userAddress) external view returns (address);

    /**
     * @dev Returns the country code and identity status for a user
     * @param _userAddress The address of the user
     */
    function investorCountry(address _userAddress) external view returns (uint16);

    /**
     * @dev Returns true if the user is registered
     * @param _userAddress The address of the user
     */
    function isVerified(address _userAddress) external view returns (bool);
}
