// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

interface IVault {
    function deposit(address token, uint256 amount) external;
}

/// @title DepositToVault
/// @notice Deposits tokens into the Vault contract.
///         Set TOKEN_ADDRESS env var to the ERC20 token address.
///         Optionally set DEPOSIT_AMOUNT (defaults to 10 tokens).
contract DepositToVault is Script {
    address constant VAULT = 0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13;

    function run() external {
        uint256 deployerPK = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPK);

        address tokenAddr = vm.envAddress("TOKEN_ADDRESS");
        uint256 amount = vm.envOr("DEPOSIT_AMOUNT", uint256(10 ether)); // default 10 tokens

        console.log("Depositor:", deployer);
        console.log("Token:", tokenAddr);
        console.log("Vault:", VAULT);
        console.log("Amount:", amount);

        vm.startBroadcast(deployerPK);

        IVault(VAULT).deposit(tokenAddr, amount);

        vm.stopBroadcast();

        console.log("------------------------------------");
        console.log("Successfully deposited tokens into vault");
        console.log("------------------------------------");
    }
}
