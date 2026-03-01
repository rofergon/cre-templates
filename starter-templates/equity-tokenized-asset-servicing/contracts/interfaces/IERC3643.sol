// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IIdentityRegistry.sol";
import "./ICompliance.sol";

/**
 * @title IERC3643
 * @dev Interface of the ERC3643 standard token (formerly T-REX).
 */
interface IERC3643 is IERC20 {
    /**
     * @dev Emitted when the identity registry is updated.
     */
    event IdentityRegistryAdded(address indexed _identityRegistry);

    /**
     * @dev Emitted when the compliance contract is updated.
     */
    event ComplianceAdded(address indexed _compliance);

    /**
     * @dev Emitted when valid recovery process is recovered.
     */
    event RecoverySuccess(address lostWallet, address newWallet, address investigator);

    /**
     * @dev Emitted when the address of the registry is set.
     */
    event AddressFrozen(address indexed _userAddress, bool _isFrozen, address indexed _owner);

    /**
     * @dev Sets the Identity Registry for the token.
     * @param _identityRegistry The address of the Identity Registry.
     */
    function setIdentityRegistry(address _identityRegistry) external;

    /**
     * @dev Returns the Identity Registry address.
     */
    function identityRegistry() external view returns (IIdentityRegistry);

    /**
     * @dev Sets the Compliance contract for the token.
     * @param _compliance The address of the Compliance contract.
     */
    function setCompliance(address _compliance) external;

    /**
     * @dev Returns the Compliance contract address.
     */
    function compliance() external view returns (ICompliance);

    /**
     * @dev Returns true if the token is paused.
     */
    function paused() external view returns (bool);

    /**
     * @dev Pauses the token transfers.
     */
    function pause() external;

    /**
     * @dev Unpauses the token transfers.
     */
    function unpause() external;

    /**
     * @dev Returns true if the address is frozen.
     * @param _userAddress The address to check.
     */
    function isFrozen(address _userAddress) external view returns (bool);

    /**
     * @dev Freezes partial tokens of a user.
     * @param _userAddress The address of the user.
     * @param _amount The amount of tokens to freeze.
     */
    function freezePartialTokens(address _userAddress, uint256 _amount) external;

    /**
     * @dev freezes tokens of the `userAddress`
     * @param _userAddress The address of the user to freeze properties
     * @param _freeze The boolean to freeze or unfreeze
     */
    function setAddressFrozen(address _userAddress, bool _freeze) external;

    /**
     * @dev Forces a transfer of tokens.
     * @param _from The address to transfer from.
     * @param _to The address to transfer to.
     * @param _amount The amount to transfer.
     */
    function forcedTransfer(address _from, address _to, uint256 _amount) external returns (bool);

    /**
     * @dev Mints tokens to an address.
     * @param _to The address to mint to.
     * @param _amount The amount to mint.
     */
    function mint(address _to, uint256 _amount) external;

    /**
     * @dev Burns tokens from an address.
     * @param _userAddress The address to burn from.
     * @param _amount The amount to burn.
     */
    function burn(address _userAddress, uint256 _amount) external;

    /**
     * @dev Returns the number of decimals.
     */
    function decimals() external view returns (uint8);
    
    /**
     * @dev Returns the version of the standard.
     */
    function version() external view returns (string memory);
}
