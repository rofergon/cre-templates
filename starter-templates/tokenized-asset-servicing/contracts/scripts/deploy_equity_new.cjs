const hre = require("hardhat");
const ethers = hre.ethers;
const fs = require("fs");
const path = require("path");
const ERC1967_PROXY_ARTIFACT = require("@openzeppelin/contracts/build/contracts/ERC1967Proxy.json");

// ──────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────

// Chainlink CRE Forwarder address on Ethereum Sepolia
const CHAINLINK_FORWARDER_ADDRESS = "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5";

// ACE Vault Address on Sepolia
const ACE_VAULT_ADDRESS = "0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13";
// Optional: if set, script will register Token + PolicyEngine in ACE vault and run check*Allowed validations
const ACE_POLICY_ENGINE_ADDRESS = process.env.ACE_POLICY_ENGINE_ADDRESS || "";
const ACE_POLICY_CHECK_AMOUNT = process.env.ACE_POLICY_CHECK_AMOUNT_WEI
    ? BigInt(process.env.ACE_POLICY_CHECK_AMOUNT_WEI)
    : ethers.parseEther(process.env.ACE_POLICY_CHECK_AMOUNT || "1");

const VAULT_ABI = [
    "function register(address token, address policyEngine) external",
    "function checkDepositAllowed(address depositor, address token, uint256 amount) external view",
    "function checkWithdrawAllowed(address withdrawer, address token, uint256 amount) external view",
    "function checkPrivateTransferAllowed(address from, address to, address token, uint256 amount) external view",
    "function sPolicyEngines(address token) external view returns (address)",
    "function sRegistrars(address token) external view returns (address)",
];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TARGET_ALREADY_ATTACHED_SELECTOR = "0xd209f8fe";
const EIP1967_IMPLEMENTATION_SLOT =
    "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";
const ROOT_DIR = path.resolve(__dirname, "../..");
const STAGING_CONFIG_PATH = path.resolve(ROOT_DIR, "EquityWorkflowCre/config.staging.json");
const PRODUCTION_CONFIG_PATH = path.resolve(ROOT_DIR, "EquityWorkflowCre/config.production.json");
const ROOT_ENV_PATH = path.resolve(ROOT_DIR, ".env");
const DEPLOYMENTS_DIR = path.resolve(__dirname, "../deployments");
const DEPLOYMENTS_LATEST_PATH = path.resolve(
    DEPLOYMENTS_DIR,
    `equity-latest.${hre.network.name}.json`,
);

const POLICY_ENGINE_INIT_IFACE = new ethers.Interface([
    "function initialize(bool defaultAllow, address initialOwner)",
]);

const collectHexStrings = (value, out) => {
    if (!value) return;
    if (typeof value === "string") {
        if (/^0x[0-9a-fA-F]+$/.test(value)) out.push(value.toLowerCase());
        return;
    }
    if (typeof value !== "object") return;
    for (const nested of Object.values(value)) collectHexStrings(nested, out);
};

const extractRevertSelector = (err) => {
    const allHex = [];
    collectHexStrings(err, allHex);

    const exactSelector = allHex.find((h) => /^0x[0-9a-f]{8}$/.test(h));
    if (exactSelector) return exactSelector;

    const dataLike = allHex.find((h) => h.length >= 10);
    return dataLike ? dataLike.slice(0, 10) : null;
};

const formatError = (err) => {
    const base = err?.shortMessage || err?.reason || err?.message || String(err);
    const selector = extractRevertSelector(err);
    if (!selector || base.includes(selector)) return base;
    return `${base} [selector=${selector}]`;
};

const parseBoolEnv = (value, defaultValue = false) => {
    if (value == null) return defaultValue;
    return String(value).trim().toLowerCase() === "true";
};

const readJsonIfExists = (filePath) => {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
};

const writeJson = (filePath, value) => {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const updateWorkflowConfigFile = (filePath, addresses) => {
    const cfg = readJsonIfExists(filePath);
    if (!cfg) return false;
    if (!Array.isArray(cfg.evms) || cfg.evms.length === 0) return false;

    const evm0 = cfg.evms[0];
    evm0.receiverAddress = addresses.receiverAddress;
    evm0.identityRegistryAddress = addresses.identityRegistryAddress;
    evm0.acePrivacyManagerAddress = addresses.privateEquityAddress;
    evm0.tokenAddress = addresses.tokenAddress;

    writeJson(filePath, cfg);
    return true;
};

const updateEnvFile = (filePath, updates) => {
    if (!fs.existsSync(filePath)) return false;
    const original = fs.readFileSync(filePath, "utf8");
    const lines = original.split(/\r?\n/);
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
            lines[i] = `${key}=${updates[key]}`;
            seen.add(key);
        }
    }

    for (const [key, value] of Object.entries(updates)) {
        if (!seen.has(key)) {
            lines.push(`${key}=${value}`);
        }
    }

    fs.writeFileSync(filePath, `${lines.join("\n").replace(/\n+$/g, "\n")}`, "utf8");
    return true;
};

const slotToAddress = (slotHex) => {
    if (!slotHex) return ZERO_ADDRESS;
    const normalized = slotHex.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) return ZERO_ADDRESS;
    return ethers.getAddress(`0x${normalized.slice(-40)}`);
};

const resolvePolicyEngineImplementation = async (candidateAddress) => {
    const override = process.env.ACE_POLICY_ENGINE_IMPLEMENTATION;
    if (override) return ethers.getAddress(override);

    const candidate = ethers.getAddress(candidateAddress);
    const slot = await ethers.provider.getStorage(candidate, EIP1967_IMPLEMENTATION_SLOT);
    const fromSlot = slotToAddress(slot);
    return fromSlot === ZERO_ADDRESS ? candidate : fromSlot;
};

const deployFreshPolicyEngineProxy = async (deployerSigner, seedPolicyEngineAddress) => {
    const deployerAddress = await deployerSigner.getAddress();
    const implementation = await resolvePolicyEngineImplementation(seedPolicyEngineAddress);
    const initData = POLICY_ENGINE_INIT_IFACE.encodeFunctionData("initialize", [true, deployerAddress]);

    const proxyFactory = new ethers.ContractFactory(
        ERC1967_PROXY_ARTIFACT.abi,
        ERC1967_PROXY_ARTIFACT.bytecode,
        deployerSigner,
    );

    const proxy = await proxyFactory.deploy(implementation, initData);
    await proxy.waitForDeployment();
    return {
        proxyAddress: await proxy.getAddress(),
        implementation,
        txHash: proxy.deploymentTransaction().hash,
    };
};

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

    const enableTestMode = parseBoolEnv(process.env.TEST_MODE_FORWARDER_BYPASS, false);
    const autoUpdateCreConfigs = parseBoolEnv(process.env.AUTO_UPDATE_CRE_CONFIGS, true);
    const autoUpdateDotEnv = parseBoolEnv(process.env.AUTO_UPDATE_DOTENV, true);
    const autoDeployPolicyProxy = parseBoolEnv(process.env.ACE_AUTO_DEPLOY_POLICY_PROXY, true);
    let effectiveAcePolicyEngineAddress = ACE_POLICY_ENGINE_ADDRESS
        ? ethers.getAddress(ACE_POLICY_ENGINE_ADDRESS)
        : "";

    if (enableTestMode) {
        console.log("⚠ TEST_MODE_FORWARDER_BYPASS=true -> receiver forwarder will be set to address(0)");
        console.log("  This is INSECURE and only for local/manual testing.\n");
    }

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
    // 8.3 Optional: ACE PolicyEngine registration and compliance checks
    // IMPORTANT: run before token ownership transfer (some vaults may require token owner/registrar permissions)
    // ───────────────────────────────────────────
    if (ACE_POLICY_ENGINE_ADDRESS) {
        console.log("   [8.3] Configuring ACE PolicyEngine registration on vault...");
        try {
            const vault = new ethers.Contract(ACE_VAULT_ADDRESS, VAULT_ABI, deployer);
            let desiredPolicyEngine = ethers.getAddress(ACE_POLICY_ENGINE_ADDRESS);
            const currentPolicyEngine = ethers.getAddress(await vault.sPolicyEngines(tokenAddress));

            if (currentPolicyEngine === ZERO_ADDRESS) {
                try {
                    const tx = await vault.register(tokenAddress, desiredPolicyEngine);
                    await tx.wait();
                    console.log("         OK (registered)");
                } catch (err) {
                    const selector = extractRevertSelector(err);
                    const canRecover =
                        autoDeployPolicyProxy &&
                        selector === TARGET_ALREADY_ATTACHED_SELECTOR &&
                        !!ACE_POLICY_ENGINE_ADDRESS;

                    if (!canRecover) throw err;

                    console.log(
                        `         register() reverted with ${TARGET_ALREADY_ATTACHED_SELECTOR} (policy already attached).`,
                    );
                    console.log("         Deploying fresh PolicyEngine proxy and retrying...");

                    const deployed = await deployFreshPolicyEngineProxy(deployer, ACE_POLICY_ENGINE_ADDRESS);
                    desiredPolicyEngine = deployed.proxyAddress;
                    effectiveAcePolicyEngineAddress = deployed.proxyAddress;

                    console.log("         proxy deploy tx: ", deployed.txHash);
                    console.log("         new proxy:       ", deployed.proxyAddress);
                    console.log("         implementation:  ", deployed.implementation);

                    const retryTx = await vault.register(tokenAddress, desiredPolicyEngine);
                    await retryTx.wait();
                    console.log("         OK (registered on retry)");
                }
            } else if (currentPolicyEngine === desiredPolicyEngine) {
                console.log("         OK (already registered)");
            } else {
                throw new Error(
                    `Token already registered with another policy engine (${currentPolicyEngine})`,
                );
            }

            const registrar = ethers.getAddress(await vault.sRegistrars(tokenAddress));
            console.log("         Current registrar:", registrar);
            effectiveAcePolicyEngineAddress = ethers.getAddress(
                await vault.sPolicyEngines(tokenAddress),
            );
        } catch (e) {
            console.error("         FAILED:", formatError(e));
        }

        console.log("   [8.4] Running ACE check*Allowed validations...");
        try {
            const vault = new ethers.Contract(ACE_VAULT_ADDRESS, VAULT_ABI, deployer);

            await vault.checkDepositAllowed(privateEquityAddress, tokenAddress, ACE_POLICY_CHECK_AMOUNT);
            console.log("         checkDepositAllowed         OK");

            await vault.checkWithdrawAllowed(deployer.address, tokenAddress, ACE_POLICY_CHECK_AMOUNT);
            console.log("         checkWithdrawAllowed        OK");

            await vault.checkPrivateTransferAllowed(
                deployer.address,
                privateEquityAddress,
                tokenAddress,
                ACE_POLICY_CHECK_AMOUNT,
            );
            console.log("         checkPrivateTransferAllowed OK");
        } catch (e) {
            console.error("         FAILED:", formatError(e));
        }
    } else {
        console.log("   [8.x] ACE policy registration skipped (ACE_POLICY_ENGINE_ADDRESS not set).");
    }

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
    if (enableTestMode) {
        console.log("   [12.1] Enabling test mode (setForwarderAddress(0))...");
        try {
            const tx = await equityWorkflowReceiver.setForwarderAddress(ZERO_ADDRESS);
            await tx.wait();
            console.log("          OK (receiver is now insecure test mode)");
        } catch (e) {
            console.error("          FAILED:", e.message);
        }
    }

    const deployedAt = new Date().toISOString();
    const deploymentSummary = {
        deployedAt,
        network: hre.network.name,
        deployer: deployer.address,
        testModeForwarderBypass: enableTestMode,
        creForwarderAddress: CHAINLINK_FORWARDER_ADDRESS,
        aceVaultAddress: ACE_VAULT_ADDRESS,
        contracts: {
            receiverAddress: equityWorkflowReceiverAddress,
            identityRegistryAddress: identityRegistryAddress,
            complianceAddress: complianceAddress,
            tokenAddress: tokenAddress,
            privateEquityAddress: privateEquityAddress,
            acePolicyEngineAddress: effectiveAcePolicyEngineAddress || null,
        },
    };

    try {
        fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
        writeJson(DEPLOYMENTS_LATEST_PATH, deploymentSummary);
        console.log(`   [12.2] Deployment summary written: ${DEPLOYMENTS_LATEST_PATH}`);
    } catch (e) {
        console.error("   [12.2] FAILED writing deployment summary:", e.message);
    }

    if (autoUpdateCreConfigs) {
        const updatedStaging = updateWorkflowConfigFile(STAGING_CONFIG_PATH, deploymentSummary.contracts);
        const updatedProduction = updateWorkflowConfigFile(PRODUCTION_CONFIG_PATH, deploymentSummary.contracts);
        console.log(`   [12.3] config.staging.json update:    ${updatedStaging ? "OK" : "SKIPPED"}`);
        console.log(`   [12.4] config.production.json update: ${updatedProduction ? "OK" : "SKIPPED"}`);
    } else {
        console.log("   [12.3] CRE config auto-update skipped (AUTO_UPDATE_CRE_CONFIGS=false)");
    }

    if (autoUpdateDotEnv) {
        const updatedEnv = updateEnvFile(ROOT_ENV_PATH, {
            RECEIVER_ADDRESS: equityWorkflowReceiverAddress,
            IDENTITY_REGISTRY_ADDRESS: identityRegistryAddress,
            COMPLIANCE_ADDRESS: complianceAddress,
            TOKEN_ADDRESS: tokenAddress,
            PRIVATE_EQUITY_ADDRESS: privateEquityAddress,
            ACE_VAULT_ADDRESS: ACE_VAULT_ADDRESS,
            ...(effectiveAcePolicyEngineAddress
                ? { ACE_POLICY_ENGINE_ADDRESS: effectiveAcePolicyEngineAddress }
                : {}),
        });
        console.log(`   [12.5] .env update: ${updatedEnv ? "OK" : "SKIPPED"}`);
    } else {
        console.log("   [12.5] .env auto-update skipped (AUTO_UPDATE_DOTENV=false)");
    }

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
    if (effectiveAcePolicyEngineAddress) {
        console.log("ACE PolicyEngine:         ", effectiveAcePolicyEngineAddress);
    }
    console.log("");
    console.log("Vesting Pool:             ", ethers.formatEther(VESTING_POOL_AMOUNT), "EQT pre-funded");
    console.log("");
    console.log("⚠  UPDATE config.staging.json and config.production.json with new addresses!");
    console.log("   receiverAddress:          " + equityWorkflowReceiverAddress);
    console.log("   identityRegistryAddress:  " + identityRegistryAddress);
    console.log("   acePrivacyManagerAddress: " + privateEquityAddress);
    console.log("   tokenAddress:             " + tokenAddress);
    console.log("");
    console.log("Deployment summary file:");
    console.log("   " + DEPLOYMENTS_LATEST_PATH);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
