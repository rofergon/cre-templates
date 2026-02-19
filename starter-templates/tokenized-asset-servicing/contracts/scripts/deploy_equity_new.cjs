const hre = require("hardhat");

async function main() {
    console.log("Starting deployment to", hre.network.name);

    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);

    // Configuration
    // ----------------------------------------------------------------
    // TODO: Double check this is the correct Forwarder address for Base Sepolia
    // Provided by user: 0x82300bd7c3958625581cc2f77bc6464dcecdf3e5
    const CHAINLINK_FORWARDER_ADDRESS = "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5";
    // ----------------------------------------------------------------

    // 1. Deploy IdentityRegistry
    console.log("\n1. Deploying IdentityRegistry...");
    const IdentityRegistry = await hre.ethers.getContractFactory("IdentityRegistry");
    const identityRegistry = await IdentityRegistry.deploy();
    await identityRegistry.waitForDeployment();
    const identityRegistryAddress = await identityRegistry.getAddress();
    console.log("   -> IdentityRegistry deployed to:", identityRegistryAddress);

    // 2. Deploy Compliance
    console.log("\n2. Deploying Compliance...");
    const Compliance = await hre.ethers.getContractFactory("Compliance");
    const compliance = await Compliance.deploy();
    await compliance.waitForDeployment();
    const complianceAddress = await compliance.getAddress();
    console.log("   -> Compliance deployed to:", complianceAddress);

    // 3. Deploy Token
    console.log("\n3. Deploying Token...");
    const Token = await hre.ethers.getContractFactory("Token");
    // Constructor args: name, symbol, identityRegistry, compliance
    const token = await Token.deploy("EquityToken", "EQT", identityRegistryAddress, complianceAddress);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    console.log("   -> Token deployed to:", tokenAddress);

    // 4. Deploy EmployeeVesting
    console.log("\n4. Deploying EmployeeVesting...");
    const EmployeeVesting = await hre.ethers.getContractFactory("EmployeeVesting");
    const employeeVesting = await EmployeeVesting.deploy(tokenAddress);
    await employeeVesting.waitForDeployment();
    const employeeVestingAddress = await employeeVesting.getAddress();
    console.log("   -> EmployeeVesting deployed to:", employeeVestingAddress);

    // 5. Deploy EquityWorkflowReceiver
    console.log("\n5. Deploying EquityWorkflowReceiver...");
    const EquityWorkflowReceiver = await hre.ethers.getContractFactory("EquityWorkflowReceiver");
    const equityWorkflowReceiver = await EquityWorkflowReceiver.deploy(
        CHAINLINK_FORWARDER_ADDRESS,
        identityRegistryAddress,
        employeeVestingAddress,
        tokenAddress
    );
    await equityWorkflowReceiver.waitForDeployment();
    const equityWorkflowReceiverAddress = await equityWorkflowReceiver.getAddress();
    console.log("   -> EquityWorkflowReceiver deployed to:", equityWorkflowReceiverAddress);

    // ----------------------------------------------------------------
    // Setup & Permissions
    // ----------------------------------------------------------------
    console.log("\nConfiguring permissions...");

    // Biding Token to Compliance
    console.log("   - Binding Token to Compliance...");
    try {
        const tx = await compliance.bindToken(tokenAddress);
        await tx.wait();
        console.log("     [OK] Token bound.");
    } catch (error) {
        console.error("     [ERROR] Failed to bind token:", error.message);
    }

    // EmployeeVesting: Set Receiver as Oracle
    console.log("   - Setting Receiver as Oracle in EmployeeVesting...");
    try {
        const tx = await employeeVesting.setOracle(equityWorkflowReceiverAddress, true);
        await tx.wait();
        console.log("     [OK] Receiver set as Oracle.");
    } catch (error) {
        console.error("     [ERROR] Failed to set oracle:", error.message);
    }

    // Token: Transfer Ownership to Receiver (Required for setAddressFrozen)
    console.log("   - Transferring Token ownership to Receiver...");
    try {
        const tx = await token.transferOwnership(equityWorkflowReceiverAddress);
        await tx.wait();
        console.log("     [OK] Token ownership transferred.");
    } catch (error) {
        console.error("     [ERROR] Failed to transfer Token ownership:", error.message);
    }

    // IdentityRegistry: Transfer Ownership to Receiver (Required for registerIdentity)
    console.log("   - Transferring IdentityRegistry ownership to Receiver...");
    try {
        const tx = await identityRegistry.transferOwnership(equityWorkflowReceiverAddress);
        await tx.wait();
        console.log("     [OK] IdentityRegistry ownership transferred.");
    } catch (error) {
        console.error("     [ERROR] Failed to transfer IdentityRegistry ownership:", error.message);
    }

    console.log("\n----------------------------------------------------");
    console.log("DEPLOYMENT COMPLETE");
    console.log("----------------------------------------------------");
    console.log("Network:              ", hre.network.name);
    console.log("Forwarder:            ", CHAINLINK_FORWARDER_ADDRESS);
    console.log("IdentityRegistry:     ", identityRegistryAddress);
    console.log("Compliance:           ", complianceAddress);
    console.log("Token:                ", tokenAddress);
    console.log("EmployeeVesting:      ", employeeVestingAddress);
    console.log("EquityWorkflowReceiver:", equityWorkflowReceiverAddress);
    console.log("----------------------------------------------------");
    console.log("WARNING: Token and IdentityRegistry ownership have been transferred to EquityWorkflowReceiver.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
