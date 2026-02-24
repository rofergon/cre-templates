const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ethers = hre.ethers;
const ERC1967_PROXY_ARTIFACT = require("@openzeppelin/contracts/build/contracts/ERC1967Proxy.json");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_ACE_VAULT = "0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13";
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "../../EquityWorkflowCre/config.staging.json");
const ROOT_ENV_PATH = path.resolve(__dirname, "../../.env");
const TARGET_ALREADY_ATTACHED_SELECTOR = "0xd209f8fe";
const NO_POLICY_ENGINE_REGISTERED_SELECTOR = "0x1cd30375";
const EIP1967_IMPLEMENTATION_SLOT =
    "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";

const VAULT_ABI = [
    "function register(address token, address policyEngine) external",
    "function checkDepositAllowed(address depositor, address token, uint256 amount) external view",
    "function checkWithdrawAllowed(address withdrawer, address token, uint256 amount) external view",
    "function checkPrivateTransferAllowed(address from, address to, address token, uint256 amount) external view",
    "function sPolicyEngines(address token) external view returns (address)",
    "function sRegistrars(address token) external view returns (address)"
];

const POLICY_ENGINE_INIT_IFACE = new ethers.Interface([
    "function initialize(bool defaultAllow, address initialOwner)",
]);

function normalizeAddress(value, name) {
    if (!value) throw new Error(`Missing ${name}`);
    return ethers.getAddress(value);
}

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseCheckAmount() {
    if (process.env.ACE_CHECK_AMOUNT_WEI) {
        return BigInt(process.env.ACE_CHECK_AMOUNT_WEI);
    }
    const tokensRaw = process.env.ACE_CHECK_AMOUNT || "1";
    return ethers.parseEther(tokensRaw);
}

function parseBoolEnv(value, fallback = false) {
    if (value == null) return fallback;
    return String(value).trim().toLowerCase() === "true";
}

function collectHexStrings(value, out) {
    if (!value) return;
    if (typeof value === "string") {
        if (/^0x[0-9a-fA-F]+$/.test(value)) out.push(value.toLowerCase());
        return;
    }
    if (typeof value !== "object") return;
    for (const nested of Object.values(value)) {
        collectHexStrings(nested, out);
    }
}

function extractRevertSelector(err) {
    const allHex = [];
    collectHexStrings(err, allHex);

    const exactSelector = allHex.find((h) => /^0x[0-9a-f]{8}$/.test(h));
    if (exactSelector) return exactSelector;

    const dataLike = allHex.find((h) => h.length >= 10);
    return dataLike ? dataLike.slice(0, 10) : null;
}

function updateEnvFile(filePath, updates) {
    if (!fs.existsSync(filePath)) return false;

    const original = fs.readFileSync(filePath, "utf8");
    const lines = original.split(/\r?\n/);
    const touched = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;

        const key = line.slice(0, eq).trim();
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
            lines[i] = `${key}=${updates[key]}`;
            touched.add(key);
        }
    }

    for (const [k, v] of Object.entries(updates)) {
        if (!touched.has(k)) lines.push(`${k}=${v}`);
    }

    fs.writeFileSync(filePath, `${lines.join("\n").replace(/\n+$/g, "\n")}`, "utf8");
    return true;
}

function slotToAddress(slotHex) {
    if (!slotHex) return ZERO_ADDRESS;
    const normalized = slotHex.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) return ZERO_ADDRESS;
    const tail = `0x${normalized.slice(-40)}`;
    return ethers.getAddress(tail);
}

async function resolvePolicyEngineImplementation(candidateAddress) {
    const override = process.env.ACE_POLICY_ENGINE_IMPLEMENTATION;
    if (override) {
        return normalizeAddress(override, "ACE_POLICY_ENGINE_IMPLEMENTATION");
    }

    const candidate = normalizeAddress(candidateAddress, "ACE_POLICY_ENGINE_ADDRESS");
    const slot = await ethers.provider.getStorage(candidate, EIP1967_IMPLEMENTATION_SLOT);
    const resolved = slotToAddress(slot);
    return resolved === ZERO_ADDRESS ? candidate : resolved;
}

async function deployFreshPolicyEngineProxy(signer, seedAddress) {
    const signerAddress = await signer.getAddress();
    const implementation = await resolvePolicyEngineImplementation(seedAddress);
    const initData = POLICY_ENGINE_INIT_IFACE.encodeFunctionData("initialize", [true, signerAddress]);

    const proxyFactory = new ethers.ContractFactory(
        ERC1967_PROXY_ARTIFACT.abi,
        ERC1967_PROXY_ARTIFACT.bytecode,
        signer,
    );

    const proxy = await proxyFactory.deploy(implementation, initData);
    console.log("   proxy deploy tx:", proxy.deploymentTransaction().hash);
    await proxy.waitForDeployment();
    const proxyAddress = await proxy.getAddress();

    return { proxyAddress, implementation };
}

function formatError(err) {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    const base = (
        err.shortMessage ||
        err.reason ||
        err.message ||
        JSON.stringify(err)
    );
    const selector = extractRevertSelector(err);
    if (!selector) return base;
    if (base.includes(selector)) return base;
    return `${base} [selector=${selector}]`;
}

async function runCheck(label, fn) {
    try {
        await fn();
        console.log(`   ✓ ${label}`);
    } catch (err) {
        console.log(`   ✗ ${label}`);
        console.log(`     ${formatError(err)}`);
    }
}

async function main() {
    const configPath = process.env.ACE_CONFIG_PATH || DEFAULT_CONFIG_PATH;
    const config = readJsonIfExists(configPath);
    const evmConfig = config?.evms?.[0] || {};
    const autoDeployPolicyProxy = parseBoolEnv(process.env.ACE_AUTO_DEPLOY_POLICY_PROXY, true);
    const autoUpdateDotEnv = parseBoolEnv(process.env.ACE_AUTO_UPDATE_DOTENV, true);

    const tokenAddress = normalizeAddress(
        process.env.TOKEN_ADDRESS || evmConfig.tokenAddress,
        "TOKEN_ADDRESS (or config.evms[0].tokenAddress)",
    );
    const privateEquityAddress = normalizeAddress(
        process.env.PRIVATE_EQUITY_ADDRESS || evmConfig.acePrivacyManagerAddress,
        "PRIVATE_EQUITY_ADDRESS (or config.evms[0].acePrivacyManagerAddress)",
    );
    const vaultAddress = normalizeAddress(
        process.env.ACE_VAULT_ADDRESS || evmConfig.aceVaultAddress || DEFAULT_ACE_VAULT,
        "ACE_VAULT_ADDRESS",
    );
    const desiredPolicyEngineRaw = process.env.ACE_POLICY_ENGINE_ADDRESS || null;

    const transferTo = normalizeAddress(
        process.env.ACE_TRANSFER_TO || privateEquityAddress,
        "ACE_TRANSFER_TO",
    );
    const checkAmount = parseCheckAmount();

    const [signer] = await ethers.getSigners();
    const signerAddress = await signer.getAddress();

    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║           ACE Vault Policy Setup + Verification             ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log("Network:                ", hre.network.name);
    console.log("Signer:                 ", signerAddress);
    console.log("Vault:                  ", vaultAddress);
    console.log("Token:                  ", tokenAddress);
    console.log("PrivateEmployeeEquity:  ", privateEquityAddress);
    console.log("Check Amount (wei):     ", checkAmount.toString());
    console.log("Transfer Check Target:  ", transferTo);
    console.log("");

    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);

    const currentPolicyEngine = normalizeAddress(
        await vault.sPolicyEngines(tokenAddress),
        "sPolicyEngines(token)",
    );
    const currentRegistrar = normalizeAddress(
        await vault.sRegistrars(tokenAddress),
        "sRegistrars(token)",
    );
    let desiredPolicyEngine = desiredPolicyEngineRaw
        ? normalizeAddress(desiredPolicyEngineRaw, "ACE_POLICY_ENGINE_ADDRESS")
        : currentPolicyEngine;
    let autoDeployedProxyAddress = null;

    console.log("Current PolicyEngine:   ", currentPolicyEngine);
    console.log("Current Registrar:      ", currentRegistrar);
    console.log("Desired PolicyEngine:   ", desiredPolicyEngine);
    console.log("Auto deploy proxy:      ", autoDeployPolicyProxy ? "true" : "false");

    if (!desiredPolicyEngineRaw && currentPolicyEngine === ZERO_ADDRESS) {
        throw new Error(
            "Token is not registered and ACE_POLICY_ENGINE_ADDRESS is missing. Set it to register.",
        );
    }

    if (currentPolicyEngine === desiredPolicyEngine) {
        console.log("\nRegistration already up to date. Skipping register().");
    } else {
        const actionLabel =
            currentPolicyEngine === ZERO_ADDRESS
                ? "Registering token + policy engine on ACE vault..."
                : `Updating policy engine from ${currentPolicyEngine} to ${desiredPolicyEngine}...`;
        console.log(`\n${actionLabel}`);
        try {
            const tx = await vault.register(tokenAddress, desiredPolicyEngine);
            console.log("   tx:", tx.hash);
            await tx.wait();
            console.log("   ✓ registration confirmed");
        } catch (err) {
            const selector = extractRevertSelector(err);
            const shouldDeployProxy =
                autoDeployPolicyProxy &&
                selector === TARGET_ALREADY_ATTACHED_SELECTOR &&
                desiredPolicyEngineRaw;

            if (!shouldDeployProxy) {
                throw err;
            }

            console.log(
                `   register() reverted with ${TARGET_ALREADY_ATTACHED_SELECTOR} (policy already attached).`,
            );
            console.log("   Deploying fresh PolicyEngine proxy and retrying register...");

            const { proxyAddress, implementation } = await deployFreshPolicyEngineProxy(
                signer,
                desiredPolicyEngineRaw,
            );
            autoDeployedProxyAddress = proxyAddress;
            desiredPolicyEngine = proxyAddress;

            console.log("   new PolicyEngine proxy:", proxyAddress);
            console.log("   implementation used:   ", implementation);

            const retryTx = await vault.register(tokenAddress, desiredPolicyEngine);
            console.log("   retry tx:", retryTx.hash);
            await retryTx.wait();
            console.log("   ✓ registration confirmed on retry");
        }
    }

    const finalPolicyEngine = normalizeAddress(
        await vault.sPolicyEngines(tokenAddress),
        "final sPolicyEngines(token)",
    );
    const finalRegistrar = normalizeAddress(
        await vault.sRegistrars(tokenAddress),
        "final sRegistrars(token)",
    );

    console.log("\nFinal PolicyEngine:     ", finalPolicyEngine);
    console.log("Final Registrar:        ", finalRegistrar);
    if (autoDeployedProxyAddress && autoUpdateDotEnv) {
        const envUpdated = updateEnvFile(ROOT_ENV_PATH, {
            ACE_POLICY_ENGINE_ADDRESS: finalPolicyEngine,
        });
        console.log("Updated .env ACE_POLICY_ENGINE_ADDRESS:", envUpdated ? "OK" : "SKIPPED");
    }

    console.log("\nRunning ACE policy checks...");
    await runCheck("checkDepositAllowed(privateEquity, token, amount)", async () => {
        await vault.checkDepositAllowed(privateEquityAddress, tokenAddress, checkAmount);
    });
    await runCheck("checkWithdrawAllowed(signer, token, amount)", async () => {
        await vault.checkWithdrawAllowed(signerAddress, tokenAddress, checkAmount);
    });
    await runCheck("checkPrivateTransferAllowed(signer, to, token, amount)", async () => {
        await vault.checkPrivateTransferAllowed(signerAddress, transferTo, tokenAddress, checkAmount);
    });

    if (finalPolicyEngine === ZERO_ADDRESS) {
        console.log(`\nWarning: token still has no policy engine (${NO_POLICY_ENGINE_REGISTERED_SELECTOR}).`);
    }
}

main().catch((error) => {
    console.error("\nACE setup failed:");
    console.error(formatError(error));
    process.exitCode = 1;
});
