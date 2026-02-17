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
}
