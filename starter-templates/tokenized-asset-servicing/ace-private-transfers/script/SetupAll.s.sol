// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PolicyEngine} from "@chainlink/policy-management/core/PolicyEngine.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IVault {
    function register(address token, address policyEngine) external;
    function deposit(address token, uint256 amount) external;
}

/// @title SetupAll
/// @notice Performs the full ACE setup with an existing ERC20 token:
///         1. Deploy PolicyEngine (behind proxy)
///         2. Approve Vault
///         3. Register token + PolicyEngine on Vault
///         4. Deposit tokens into Vault
///
///         Requires TOKEN_ADDRESS to be set.
contract SetupAll is Script {
    address constant VAULT = 0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13;

    function run() external {
        uint256 deployerPK = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPK);
        address tokenAddr = vm.envAddress("TOKEN_ADDRESS");
        uint256 amount = vm.envOr("DEPOSIT_AMOUNT", uint256(10 ether));

        console.log("Deployer:", deployer);
        console.log("Token:", tokenAddr);
        console.log("Vault:", VAULT);

        vm.startBroadcast(deployerPK);

        // 1. Deploy PolicyEngine (behind proxy)
        PolicyEngine policyEngineImpl = new PolicyEngine();
        bytes memory initData = abi.encodeWithSelector(
            PolicyEngine.initialize.selector,
            true,    // defaultAllow = true
            deployer
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(policyEngineImpl), initData);
        console.log("1) PolicyEngine proxy deployed at:", address(proxy));

        // 2. Approve Vault
        IERC20(tokenAddr).approve(VAULT, type(uint256).max);
        console.log("2) Approved vault to spend tokens");

        // 3. Register token + PolicyEngine on Vault
        IVault(VAULT).register(tokenAddr, address(proxy));
        console.log("3) Registered token and PolicyEngine on vault");

        // 4. Deposit tokens into Vault
        IVault(VAULT).deposit(tokenAddr, amount);
        console.log("4) Deposited tokens into vault");

        vm.stopBroadcast();

        console.log("");
        console.log("============================================");
        console.log("  SETUP COMPLETE");
        console.log("============================================");
        console.log("PolicyEngine proxy: ", address(proxy));
        console.log("Vault:              ", VAULT);
        console.log("============================================");
    }
}
