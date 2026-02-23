const hre = require("hardhat");
const ethers = hre.ethers;

// ──────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────

// Chainlink CRE Forwarder address on Ethereum Sepolia
const CHAINLINK_FORWARDER_ADDRESS = "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5";

// ACE Vault Address on Sepolia
const ACE_VAULT_ADDRESS = "0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13";

// Vesting pool: tokens pre-funded into PrivateEmployeeEquity so it can deposit to ACE
// 1,000,000 tokens with 18 decimals = 1_000_000 * 10^18
const VESTING_POOL_AMOUNT = ethers.parseEther("1000000");

// Deployer KYC identity address (placeholder — deployer is registered in registry before minting)
// Must be non-zero for Token.mint() to pass the isVerified() check
const DEPLOYER_IDENTITY_PLACEHOLDER = "0x0000000000000000000000000000000000000001";
// PrivateEmployeeEquity also needs to be "verified" so Token.mint/transfer accepts it as recipient
const PRIVATE_EQUITY_IDENTITY_PLACEHOLDER = "0x0000000000000000000000000000000000000002";

// ──────────────────────────────────────────────────────────

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║         Equity Protocol + ACE — Full Deployment              ║");
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
    // 4. Deploy PrivateEmployeeEquity
    // ───────────────────────────────────────────
    console.log("\n4. Deploying PrivateEmployeeEquity (ACE Integration)...");
    const PrivateEmployeeEquity = await ethers.getContractFactory("PrivateEmployeeEquity");
    const privateEquity = await PrivateEmployeeEquity.deploy(ACE_VAULT_ADDRESS, tokenAddress);
    await privateEquity.waitForDeployment();
    const privateEquityAddress = await privateEquity.getAddress();
    console.log("   -> PrivateEmployeeEquity:", privateEquityAddress);

    // ───────────────────────────────────────────
    // 5. Deploy EquityWorkflowReceiver
    // ───────────────────────────────────────────
    console.log("\n5. Deploying EquityWorkflowReceiver...");
    const EquityWorkflowReceiver = await ethers.getContractFactory("EquityWorkflowReceiver");
    const equityWorkflowReceiver = await EquityWorkflowReceiver.deploy(
        CHAINLINK_FORWARDER_ADDRESS,
        identityRegistryAddress,
        privateEquityAddress,
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
    console.log("   [7.1] Registering deployer in IdentityRegistry...");
    try {
        const tx = await identityRegistry.registerIdentity(
            deployer.address,
            DEPLOYER_IDENTITY_PLACEHOLDER,
            840 // US
        );
        await tx.wait();
        console.log("         OK");
    } catch (e) { console.error("         FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 8. Register PrivateEmployeeEquity and mint tokens
    //    (ERC-3643 Token requires all transfer recipients to be isVerified)
    // ───────────────────────────────────────────
    console.log("   [8.1] Registering PrivateEmployeeEquity contract in IdentityRegistry...");
    try {
        const tx = await identityRegistry.registerIdentity(
            privateEquityAddress,
            PRIVATE_EQUITY_IDENTITY_PLACEHOLDER,
            840 // US
        );
        await tx.wait();
        console.log("         OK");
    } catch (e) { console.error("         FAILED:", e.message); }

    console.log(`   [8.2] Minting ${ethers.formatEther(VESTING_POOL_AMOUNT)} EQT to PrivateEmployeeEquity pool...`);
    try {
        const tx = await token.mint(privateEquityAddress, VESTING_POOL_AMOUNT);
        await tx.wait();
        console.log("         OK");
    } catch (e) { console.error("         FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 9. Transfer ownership to Receiver
    // ───────────────────────────────────────────
    console.log("   [9.1] Transferring IdentityRegistry ownership to Receiver...");
    try {
        const tx = await identityRegistry.transferOwnership(equityWorkflowReceiverAddress);
        await tx.wait();
        console.log("         OK");
    } catch (e) { console.error("         FAILED:", e.message); }

    console.log("   [9.2] Transferring Token ownership to Receiver...");
    try {
        const tx = await token.transferOwnership(equityWorkflowReceiverAddress);
        await tx.wait();
        console.log("         OK");
    } catch (e) { console.error("         FAILED:", e.message); }

    // ───────────────────────────────────────────
    // 10. Set Receiver as oracle in PrivateEmployeeEquity
    // ───────────────────────────────────────────
    console.log("   [10.1] Setting Receiver as oracle in PrivateEmployeeEquity...");
    try {
        const tx = await privateEquity.setOracleStatus(equityWorkflowReceiverAddress, true);
        await tx.wait();
        console.log("          OK");
    } catch (e) { console.error("          FAILED:", e.message); }

    // ───────────────────────────────────────────
    // Summary
    // ───────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║                   DEPLOYMENT COMPLETE                        ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log("Network:                  ", hre.network.name);
    console.log("CRE Forwarder:            ", CHAINLINK_FORWARDER_ADDRESS);
    console.log("ACE Vault:                ", ACE_VAULT_ADDRESS);
    console.log("IdentityRegistry:         ", identityRegistryAddress);
    console.log("Compliance:               ", complianceAddress);
    console.log("Token (ERC-3643, EQT):    ", tokenAddress);
    console.log("PrivateEmployeeEquity:    ", privateEquityAddress);
    console.log("EquityWorkflowReceiver:   ", equityWorkflowReceiverAddress);
    console.log("");
    console.log("Vesting Pool:             ", ethers.formatEther(VESTING_POOL_AMOUNT), "EQT pre-funded");
    console.log("");
    console.log("⚠  UPDATE config.staging.json and config.production.json with new addresses!");
    console.log("   receiverAddress:          " + equityWorkflowReceiverAddress);
    console.log("   identityRegistryAddress:  " + identityRegistryAddress);
    console.log("   acePrivacyManagerAddress: " + privateEquityAddress);
    console.log("   tokenAddress:             " + tokenAddress);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
