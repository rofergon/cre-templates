const hre = require("hardhat");
const ethers = hre.ethers;

// ──────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────

// Chainlink CRE Forwarder address on Base Sepolia
const CHAINLINK_FORWARDER_ADDRESS = "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5";

// Vesting pool: tokens pre-funded into EmployeeVesting so CRE can create grants.
// 1,000,000 tokens with 18 decimals = 1_000_000 * 10^18
const VESTING_POOL_AMOUNT = ethers.parseEther("1000000");

// Deployer KYC identity address (placeholder — deployer is registered in registry before minting)
// Must be non-zero for Token.mint() to pass the isVerified() check
const DEPLOYER_IDENTITY_PLACEHOLDER = "0x0000000000000000000000000000000000000001";
// EmployeeVesting also needs to be "verified" so Token.transferFrom() accepts it as recipient
const VESTING_IDENTITY_PLACEHOLDER = "0x0000000000000000000000000000000000000002";

// ──────────────────────────────────────────────────────────

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║         Equity Protocol — Full CRE Deployment                ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log("Network:", hre.network.name);

    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

    // ───────────────────────────────────────────
    // 1. Deploy IdentityRegistry
    // ───────────────────────────────────────────
    console.log("1. Deploying IdentityRegistry...");
    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    const identityRegistry = await IdentityRegistry.deploy();
    await identityRegistry.waitForDeployment();
    const identityRegistryAddress = await identityRegistry.getAddress();
    console.log("   -> IdentityRegistry:", identityRegistryAddress);

    // ───────────────────────────────────────────
    // 2. Deploy Compliance
    // ───────────────────────────────────────────
    console.log("\n2. Deploying Compliance...");
    const Compliance = await ethers.getContractFactory("Compliance");
    const compliance = await Compliance.deploy();
    await compliance.waitForDeployment();
    const complianceAddress = await compliance.getAddress();
    console.log("   -> Compliance:", complianceAddress);

    // ───────────────────────────────────────────
    // 3. Deploy Token (ERC-3643)
    // ───────────────────────────────────────────
    console.log("\n3. Deploying Token (ERC-3643, EQT)...");
    const Token = await ethers.getContractFactory("Token");
    const token = await Token.deploy("EquityToken", "EQT", identityRegistryAddress, complianceAddress);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    console.log("   -> Token:", tokenAddress);

    // ───────────────────────────────────────────
    // 4. Deploy EmployeeVesting
    // ───────────────────────────────────────────
    console.log("\n4. Deploying EmployeeVesting...");
    const EmployeeVesting = await ethers.getContractFactory("EmployeeVesting");
    const employeeVesting = await EmployeeVesting.deploy(tokenAddress);
    await employeeVesting.waitForDeployment();
    const employeeVestingAddress = await employeeVesting.getAddress();
    console.log("   -> EmployeeVesting:", employeeVestingAddress);

    // ───────────────────────────────────────────
    // 5. Deploy EquityWorkflowReceiver
    // ───────────────────────────────────────────
    console.log("\n5. Deploying EquityWorkflowReceiver...");
    const EquityWorkflowReceiver = await ethers.getContractFactory("EquityWorkflowReceiver");
    const equityWorkflowReceiver = await EquityWorkflowReceiver.deploy(
        CHAINLINK_FORWARDER_ADDRESS,
        identityRegistryAddress,
        employeeVestingAddress,
        tokenAddress
    );
    await equityWorkflowReceiver.waitForDeployment();
    const equityWorkflowReceiverAddress = await equityWorkflowReceiver.getAddress();
    console.log("   -> EquityWorkflowReceiver:", equityWorkflowReceiverAddress);

    // ───────────────────────────────────────────
    // 6. Bind Token to Compliance
    // ───────────────────────────────────────────
    console.log("\n6. Configuring permissions...");

    console.log("   [6.1] Binding Token to Compliance...");
    try {
        const tx = await compliance.bindToken(tokenAddress);
        await tx.wait();
        console.log("         OK");
    } catch (e) { console.error("         FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 7. Register deployer in IdentityRegistry
    //    (Required so Token.mint() passes isVerified check)
    // ───────────────────────────────────────────
    console.log("   [7.1] Registering deployer in IdentityRegistry (for minting)...");
    try {
        const tx = await identityRegistry.registerIdentity(
            deployer.address,
            DEPLOYER_IDENTITY_PLACEHOLDER,
            840 // US
        );
        await tx.wait();
        console.log("         OK — deployer is verified (country: 840)");
    } catch (e) { console.error("         FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 8. Mint vesting pool tokens to deployer
    //    (deployer needs tokens before fundVesting can transfer them)
    // ───────────────────────────────────────────
    console.log(`   [8.1] Minting ${ethers.formatEther(VESTING_POOL_AMOUNT)} EQT to deployer...`);
    try {
        const tx = await token.mint(deployer.address, VESTING_POOL_AMOUNT);
        await tx.wait();
        console.log("         OK");
    } catch (e) { console.error("         FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 8b. Register EmployeeVesting in IdentityRegistry
    //     (ERC-3643 Token requires all transfer recipients to be isVerified)
    //     MUST happen BEFORE ownership transfer — deployer still owns IdentityRegistry here
    // ───────────────────────────────────────────
    console.log("   [8.2] Registering EmployeeVesting contract in IdentityRegistry...");
    try {
        const tx = await identityRegistry.registerIdentity(
            employeeVestingAddress,
            VESTING_IDENTITY_PLACEHOLDER,
            840 // US
        );
        await tx.wait();
        console.log("         OK — EmployeeVesting is now verified (can receive EQT tokens)");
    } catch (e) { console.error("         FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 9. Transfer ownership of IdentityRegistry → Receiver
    //    (must happen AFTER registering deployer, before further registry ops)
    // ───────────────────────────────────────────
    console.log("   [9.1] Transferring IdentityRegistry ownership to Receiver...");
    try {
        const tx = await identityRegistry.transferOwnership(equityWorkflowReceiverAddress);
        await tx.wait();
        console.log("         OK");
    } catch (e) { console.error("         FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 10. Transfer ownership of Token → Receiver
    //     (Required for setAddressFrozen via SYNC_FREEZE_WALLET)
    // ───────────────────────────────────────────
    console.log("   [10.1] Transferring Token ownership to Receiver...");
    try {
        const tx = await token.transferOwnership(equityWorkflowReceiverAddress);
        await tx.wait();
        console.log("          OK");
    } catch (e) { console.error("          FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 11. Set Receiver as oracle in EmployeeVesting
    //     (Required for updateEmploymentStatus, setGoalAchieved, createGrant)
    //     EmployeeVesting ownership stays with deployer.
    // ───────────────────────────────────────────
    console.log("   [11.1] Setting Receiver as oracle in EmployeeVesting...");
    try {
        const tx = await employeeVesting.setOracle(equityWorkflowReceiverAddress, true);
        await tx.wait();
        console.log("          OK");
    } catch (e) { console.error("          FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 12. Approve EmployeeVesting to pull tokens, then fundVesting()
    // ───────────────────────────────────────────
    console.log(`   [13.1] Approving EmployeeVesting to spend ${ethers.formatEther(VESTING_POOL_AMOUNT)} EQT...`);
    try {
        const tx = await token.connect(deployer).approve(employeeVestingAddress, VESTING_POOL_AMOUNT);
        await tx.wait();
        console.log("          OK");
    } catch (e) { console.error("          FAILED:", e.message); }

    console.log(`   [13.2] Funding EmployeeVesting pool with ${ethers.formatEther(VESTING_POOL_AMOUNT)} EQT...`);
    try {
        const tx = await employeeVesting.fundVesting(VESTING_POOL_AMOUNT);
        await tx.wait();
        const poolBalance = await employeeVesting.vestingPoolBalance();
        console.log(`          OK — pool balance: ${ethers.formatEther(poolBalance)} EQT`);
    } catch (e) { console.error("          FAILED:", e.message); }

    // ───────────────────────────────────────────
    // Summary
    // ───────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║                   DEPLOYMENT COMPLETE                        ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log("Network:                  ", hre.network.name);
    console.log("CRE Forwarder:            ", CHAINLINK_FORWARDER_ADDRESS);
    console.log("IdentityRegistry:         ", identityRegistryAddress);
    console.log("Compliance:               ", complianceAddress);
    console.log("Token (ERC-3643, EQT):    ", tokenAddress);
    console.log("EmployeeVesting:          ", employeeVestingAddress);
    console.log("EquityWorkflowReceiver:   ", equityWorkflowReceiverAddress);
    console.log("");
    console.log("Permissions:");
    console.log("  IdentityRegistry owner  = Receiver  (SYNC_KYC)");
    console.log("  Token owner             = Receiver  (SYNC_FREEZE_WALLET)");
    console.log("  EmployeeVesting owner   = Deployer  (admin, revoke, fundVesting)");
    console.log("  EmployeeVesting oracle  = Receiver  (SYNC_EMPLOYMENT_STATUS, SYNC_GOAL, SYNC_CREATE_GRANT)");
    console.log("");
    console.log("Vesting Pool:             ", ethers.formatEther(VESTING_POOL_AMOUNT), "EQT pre-funded");
    console.log("");
    console.log("⚠  UPDATE config.staging.json and config.production.json with new addresses!");
    console.log("   receiverAddress:         " + equityWorkflowReceiverAddress);
    console.log("   identityRegistryAddress: " + identityRegistryAddress);
    console.log("   employeeVestingAddress:  " + employeeVestingAddress);
    console.log("   tokenAddress:            " + tokenAddress);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
