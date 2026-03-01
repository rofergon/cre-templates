// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ICompliance {
    /**
     * @dev Checks if a transfer can be executed.
     * @param _from The address of the sender.
     * @param _to The address of the receiver.
     * @param _amount The amount of tokens to transfer.
     */
    function canTransfer(address _from, address _to, uint256 _amount) external view returns (bool);

    /**
     * @dev Called by the token contract before a transfer to update compliance state.
     * @param _from The address of the sender.
     * @param _to The address of the receiver.
     * @param _amount The amount of tokens to transfer.
     */
    function transferred(address _from, address _to, uint256 _amount) external;

    /**
     * @dev Called by the token contract on minting.
     * @param _to The address of the receiver.
     * @param _amount The amount of tokens minted.
     */
    function created(address _to, uint256 _amount) external;

    /**
     * @dev Called by the token contract on burning.
     * @param _from The address of the burner.
     * @param _amount The amount of tokens burned.
     */
    function destroyed(address _from, uint256 _amount) external;

    /**
     * @dev Binds a token to the compliance contract.
     * @param _token The address of the token to bind.
     */
    function bindToken(address _token) external;

    /**
     * @dev Unbinds a token from the compliance contract.
     * @param _token The address of the token to unbind.
     */
    function unbindToken(address _token) external;

    /**
     * @dev Checks if a token is bound to the compliance contract.
     * @param _token The address of the token to check.
     */
    function isTokenBound(address _token) external view returns (bool);

    /**
     * @dev Adds a token agent to the compliance contract.
     * @param _agentAddress The address of the agent to add.
     */
    function addTokenAgent(address _agentAddress) external;

    /**
     * @dev Removes a token agent from the compliance contract.
     * @param _agentAddress The address of the agent to remove.
     */
    function removeTokenAgent(address _agentAddress) external;

    /**
     * @dev Checks if an address is a token agent.
     * @param _agentAddress The address to check.
     */
    function isTokenAgent(address _agentAddress) external view returns (bool);
}
