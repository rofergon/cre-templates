// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title ApproveVault
/// @notice Approves the ACE Vault to spend tokens from the sender.
///         Set TOKEN_ADDRESS env var.
contract ApproveVault is Script {
    address constant VAULT = 0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13;

    function run() external {
        uint256 deployerPK = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPK);
        address tokenAddr = vm.envAddress("TOKEN_ADDRESS");

        console.log("Approver:", deployer);
        console.log("Token:", tokenAddr);
        console.log("Vault:", VAULT);

        vm.startBroadcast(deployerPK);
        IERC20(tokenAddr).approve(VAULT, type(uint256).max);
        vm.stopBroadcast();

        console.log("------------------------------------");
        console.log("Successfully approved vault to spend tokens");
        console.log("------------------------------------");
    }
}
