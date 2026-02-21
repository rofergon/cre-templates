/**
 * run-tests.mjs
 *
 * Interactive CLI for the Equity CRE protocol.
 * Lets you choose which sync action to run, prompts for custom payload data,
 * and executes the full 3-tier flow: Lambda → CRE → Blockchain → CRE → Lambda.
 */

import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workflowDir = resolve(__dirname, "..");
const projectRoot = resolve(workflowDir, "..");

const configPath = resolve(workflowDir, "config.staging.json");
const envPath = resolve(projectRoot, ".env");

const config = JSON.parse(readFileSync(configPath, "utf-8"));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const parseEnvFile = (path) => {
    if (!existsSync(path)) return {};
    const text = readFileSync(path, "utf-8");
    const out = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx < 0) continue;
        out[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
    }
    return out;
};

const envFromFile = parseEnvFile(envPath);
const lambdaUrl = process.env.LAMBDA_URL || envFromFile.LAMBDA_URL;
const rpcUrl =
    process.env.BASE_SEPOLIA_RPC_URL ||
    "https://base-sepolia.gateway.tenderly.co/3qeYD3iE02OOzPOCANms01/";

const identityRegistryAddress = config.evms[0].identityRegistryAddress.toLowerCase();
const employeeVestingAddress = config.evms[0].employeeVestingAddress.toLowerCase();

const normalizePrivateKey = (value) => {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed}`;
    return null;
};

const normalizedPk = normalizePrivateKey(
    process.env.CRE_ETH_PRIVATE_KEY ?? envFromFile.CRE_ETH_PRIVATE_KEY,
);

const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
});

// ---------------------------------------------------------------------------
// Readline helper
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = (question) =>
    new Promise((res) => rl.question(question, (answer) => res(answer.trim())));

const askWithDefault = async (question, defaultValue) => {
    const answer = await ask(`${question} [${defaultValue}]: `);
    return answer === "" ? String(defaultValue) : answer;
};

const askYesNo = async (question, defaultYes = true) => {
    const hint = defaultYes ? "Y/n" : "y/N";
    const answer = await ask(`${question} (${hint}): `);
    if (answer === "") return defaultYes;
    return answer.toLowerCase().startsWith("y");
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const callLambda = async (payload) => {
    if (!lambdaUrl) throw new Error("LAMBDA_URL not found in environment or .env file");
    const resp = await fetch(lambdaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let body;
    try {
        body = JSON.parse(text);
        if (typeof body.body === "string") body = JSON.parse(body.body);
    } catch {
        body = { raw: text };
    }
    return { statusCode: resp.status, body };
};

const isTransientTxError = (text) => {
    const normalized = String(text || "").toLowerCase();
    return (
        normalized.includes("replacement transaction underpriced") ||
        normalized.includes("nonce too low") ||
        normalized.includes("already known")
    );
};

const runCre = async (args, cwd = projectRoot, retries = 4, delayMs = 15000) => {
    let lastOutput = "";
    for (let attempt = 1; attempt <= retries; attempt++) {
        const childEnv = { ...process.env };
        if (normalizedPk) childEnv.CRE_ETH_PRIVATE_KEY = normalizedPk;
        if (lambdaUrl) childEnv.LAMBDA_URL = lambdaUrl;
        childEnv.CRE_TARGET = "local-simulation";

        const out = spawnSync("cre", args, { cwd, encoding: "utf-8", env: childEnv });
        const stdout = out.stdout || "";
        const stderr = out.stderr || "";
        const merged = `${stdout}\n${stderr}`;
        lastOutput = merged;

        if (out.status === 0) {
            if (attempt > 1) console.log(`   CRE succeeded on retry ${attempt}/${retries}.`);
            return merged;
        }

        if (attempt < retries && isTransientTxError(merged)) {
            console.log(
                `   Transient tx error (attempt ${attempt}/${retries}). Waiting ${Math.floor(delayMs / 1000)}s...`,
            );
            await wait(delayMs);
            continue;
        }
        throw new Error(`CRE command failed (${args.join(" ")}):\n${merged}`);
    }
    throw new Error(`CRE command failed after retries:\n${lastOutput}`);
};

const extractTxHash = (text) => {
    const matches = text.match(/0x[a-fA-F0-9]{64}/g);
    if (!matches || matches.length === 0) {
        throw new Error(`No tx hash found in output:\n${text}`);
    }
    return matches[matches.length - 1];
};

// ---------------------------------------------------------------------------
// Full 3-tier flow: Lambda persist → CRE broadcast → LogTrigger → verify
// ---------------------------------------------------------------------------

const executeFullFlow = async (lambdaPayload, crePayload) => {
    // Step 1: Persist to Lambda
    console.log("\n┌─ Step 1: Persist to Lambda (DynamoDB) ──────────────────────");
    const lambdaResult = await callLambda(lambdaPayload);
    if (lambdaResult.statusCode !== 200) {
        throw new Error(
            `Lambda persist failed (${lambdaResult.statusCode}): ${JSON.stringify(lambdaResult.body)}`,
        );
    }
    console.log("   ✓ Data persisted in DynamoDB");

    // Step 2: CRE HTTP trigger → write report on-chain
    console.log("\n┌─ Step 2: CRE simulate → write report to blockchain ────────");
    console.log(`   Payload: ${JSON.stringify(crePayload)}`);

    const output = await runCre([
        "workflow", "simulate", "./EquityWorkflowCre",
        "--target", "local-simulation",
        "--non-interactive",
        "--trigger-index", "0",
        "--http-payload", JSON.stringify(crePayload),
        "--broadcast",
    ]);
    console.log(output);

    const txHash = extractTxHash(output);
    console.log(`   ✓ writeReport txHash: ${txHash}`);

    // Step 3: Fetch receipt
    console.log("\n┌─ Step 3: Fetch transaction receipt ────────────────────────");
    let receipt;
    for (let i = 0; i < 15; i++) {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash });
        if (receipt) break;
        await wait(2000);
    }
    if (!receipt) throw new Error("Transaction receipt not found");

    const eventLogIdx = receipt.logs.findIndex(
        (log) =>
            log.address.toLowerCase() === identityRegistryAddress ||
            log.address.toLowerCase() === employeeVestingAddress,
    );

    if (eventLogIdx === -1) {
        console.log("   ⚠ No target contract event found. Skipping LogTrigger.");
        return;
    }

    const eventLog = receipt.logs[eventLogIdx];
    const triggerIndex = eventLog.address.toLowerCase() === identityRegistryAddress ? "1" : "2";
    console.log(`   ✓ Event at tx log index: ${eventLogIdx} (global logIndex: ${eventLog.logIndex})`);

    // Step 4: CRE LogTrigger → sync event back to Lambda
    console.log("\n┌─ Step 4: CRE LogTrigger → sync event to Lambda ───────────");
    const logOutput = await runCre([
        "workflow", "simulate", "./EquityWorkflowCre",
        "--target", "local-simulation",
        "--non-interactive",
        "--trigger-index", triggerIndex,
        "--evm-tx-hash", txHash,
        "--evm-event-index", String(eventLogIdx),
        "--broadcast",
    ]);
    console.log(logOutput);
    console.log("   ✓ On-chain event forwarded to Lambda");

    // Step 5: Verify
    console.log("\n┌─ Step 5: Verify via Lambda readEmployee ──────────────────");
    const employeeAddr = crePayload.employeeAddress || crePayload.walletAddress;
    if (employeeAddr) {
        const readResult = await callLambda({ action: "readEmployee", employeeAddress: employeeAddr });
        if (readResult.statusCode === 200) {
            const record = readResult.body.data || readResult.body;
            console.log("   Employee record:");
            console.log(`   ${JSON.stringify(record, null, 2).replace(/\n/g, "\n   ")}`);
        } else {
            console.log(`   ⚠ Could not read employee: status ${readResult.statusCode}`);
        }
    }

    console.log("\n   ✓ Flow completed successfully!\n");
};

// ---------------------------------------------------------------------------
// Menu option handlers
// ---------------------------------------------------------------------------

const handleSyncKyc = async () => {
    console.log("\n── Register / Update Employee (SYNC_KYC) ────────────────────\n");

    const employeeAddress = await askWithDefault("   Employee wallet address", "0x1111111111111111111111111111111111111111");
    const verified = await askYesNo("   KYC verified?", true);
    let identityAddress = "0x0000000000000000000000000000000000000000";
    let country = 0;

    if (verified) {
        identityAddress = await askWithDefault("   Identity contract address", "0x2222222222222222222222222222222222222222");
        country = Number(await askWithDefault("   Country code (ISO 3166 numeric, e.g. 840=US)", "840"));
    }

    const crePayload = {
        action: "SYNC_KYC",
        employeeAddress,
        verified,
        ...(verified && { identityAddress }),
        country,
    };

    const lambdaPayload = {
        action: "CompanyEmployeeInput",
        employeeAddress,
        identityAddress,
        country,
        kycVerified: verified,
        employed: true,
    };

    console.log(`\n   Payload: ${JSON.stringify(crePayload, null, 2).replace(/\n/g, "\n   ")}`);
    const confirm = await askYesNo("\n   Proceed with this payload?", true);
    if (!confirm) { console.log("   Cancelled.\n"); return; }

    await executeFullFlow(lambdaPayload, crePayload);
};

const handleSyncEmployment = async () => {
    console.log("\n── Update Employment Status (SYNC_EMPLOYMENT_STATUS) ────────\n");

    const employeeAddress = await askWithDefault("   Employee wallet address", "0x1111111111111111111111111111111111111111");
    const employed = await askYesNo("   Currently employed?", true);

    const crePayload = {
        action: "SYNC_EMPLOYMENT_STATUS",
        employeeAddress,
        employed,
    };

    const lambdaPayload = {
        action: "CompanyEmployeeInput",
        employeeAddress,
        employed,
    };

    console.log(`\n   Payload: ${JSON.stringify(crePayload, null, 2).replace(/\n/g, "\n   ")}`);
    const confirm = await askYesNo("\n   Proceed with this payload?", true);
    if (!confirm) { console.log("   Cancelled.\n"); return; }

    await executeFullFlow(lambdaPayload, crePayload);
};

const handleSyncGoal = async () => {
    console.log("\n── Update Performance Goal (SYNC_GOAL) ─────────────────────\n");

    const goalId = await askWithDefault(
        "   Goal ID (bytes32 hex)",
        "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    const achieved = await askYesNo("   Goal achieved?", true);

    const crePayload = {
        action: "SYNC_GOAL",
        goalId,
        achieved,
    };

    const lambdaPayload = {
        action: "CompanyEmployeeInput",
        goalId,
        goalAchieved: achieved,
    };

    console.log(`\n   Payload: ${JSON.stringify(crePayload, null, 2).replace(/\n/g, "\n   ")}`);
    const confirm = await askYesNo("\n   Proceed with this payload?", true);
    if (!confirm) { console.log("   Cancelled.\n"); return; }

    await executeFullFlow(lambdaPayload, crePayload);
};

const handleFreezeWallet = async () => {
    console.log("\n── Freeze / Unfreeze Wallet (SYNC_FREEZE_WALLET) ───────────\n");

    const walletAddress = await askWithDefault("   Wallet address", "0x1111111111111111111111111111111111111111");
    const frozen = await askYesNo("   Freeze wallet?", false);

    const crePayload = {
        action: "SYNC_FREEZE_WALLET",
        walletAddress,
        frozen,
    };

    const lambdaPayload = {
        action: "CompanyEmployeeInput",
        employeeAddress: walletAddress,
        walletFrozen: frozen,
    };

    console.log(`\n   Payload: ${JSON.stringify(crePayload, null, 2).replace(/\n/g, "\n   ")}`);
    const confirm = await askYesNo("\n   Proceed with this payload?", true);
    if (!confirm) { console.log("   Cancelled.\n"); return; }

    await executeFullFlow(lambdaPayload, crePayload);
};

const handleFullRoundTrip = async () => {
    console.log("\n── Full 3-Tier Round-Trip Test (automated defaults) ─────────\n");
    console.log("   Running with default test data...\n");

    const employeeAddress = "0x1111111111111111111111111111111111111111";
    const identityAddress = "0x2222222222222222222222222222222222222222";
    const country = 840;

    const lambdaPayload = {
        action: "CompanyEmployeeInput",
        employeeAddress,
        identityAddress,
        country,
        kycVerified: true,
        employed: true,
    };

    const crePayload = {
        action: "SYNC_KYC",
        employeeAddress,
        verified: true,
        identityAddress,
        country,
    };

    await executeFullFlow(lambdaPayload, crePayload);
};

const handleReadEmployee = async () => {
    console.log("\n── Read Employee Record (Lambda query) ─────────────────────\n");

    const employeeAddress = await askWithDefault("   Employee wallet address", "0x1111111111111111111111111111111111111111");

    console.log("\n   Querying Lambda...");
    const result = await callLambda({ action: "readEmployee", employeeAddress });

    if (result.statusCode !== 200) {
        console.log(`   ✗ Lambda returned status ${result.statusCode}`);
        console.log(`   ${JSON.stringify(result.body, null, 2).replace(/\n/g, "\n   ")}`);
        return;
    }

    const record = result.body.data || result.body;
    console.log("   ✓ Employee record found:\n");
    console.log(`   ${JSON.stringify(record, null, 2).replace(/\n/g, "\n   ")}`);
    console.log();
};

const handleListEmployees = async () => {
    console.log("\n── List All Employees (Lambda scan) ────────────────────────\n");
    console.log("   Querying Lambda for all registered employees...");

    const result = await callLambda({ action: "listEmployees" });

    if (result.statusCode !== 200) {
        console.log(`   ✗ Lambda returned status ${result.statusCode}`);
        console.log(`   ${JSON.stringify(result.body, null, 2).replace(/\n/g, "\n   ")}`);
        return;
    }

    const records = result.body.data || [];

    if (records.length === 0) {
        console.log("   ℹ No employees found in the database.\n");
        return;
    }

    console.log(`   ✓ Found ${records.length} employee(s):\n`);

    // Prepare data for console.table
    const tableData = records.map(r => ({
        "Address": r.employeeAddress ? `${r.employeeAddress.substring(0, 8)}...${r.employeeAddress.substring(38)}` : "N/A",
        "KYC": r.kycVerified ? "✅" : "❌",
        "Country": r.country || "---",
        "Employed": r.employed !== false ? "✅" : "❌",
        "Wallet Frz": r.walletFrozen ? "❄️" : "---",
        "Last Event": r.lastOnchainEvent || "---"
    }));

    console.table(tableData);
    console.log();
};

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

const showMenu = () => {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║           Equity CRE — Interactive Test Runner              ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log();
    console.log("  1) Register / Update Employee (SYNC_KYC)");
    console.log("     Register a new employee on-chain: wallet, identity,");
    console.log("     country code, and KYC verification status.");
    console.log("     Flow: Lambda → CRE → IdentityRegistry → CRE → Lambda");
    console.log();
    console.log("  2) Update Employment Status (SYNC_EMPLOYMENT_STATUS)");
    console.log("     Change an employee's status to active or terminated.");
    console.log("     Flow: Lambda → CRE → EmployeeVesting → CRE → Lambda");
    console.log();
    console.log("  3) Update Performance Goal (SYNC_GOAL)");
    console.log("     Mark a performance goal as achieved or pending.");
    console.log("     Flow: Lambda → CRE → EmployeeVesting → CRE → Lambda");
    console.log();
    console.log("  4) Freeze / Unfreeze Wallet (SYNC_FREEZE_WALLET)");
    console.log("     Freeze or unfreeze an employee's token wallet.");
    console.log("     Flow: Lambda → CRE → Token (ERC-3643) → CRE → Lambda");
    console.log();
    console.log("  5) Full 3-Tier Round-Trip Test (automated)");
    console.log("     Runs the full simulation with default test data:");
    console.log("     Lambda → CRE → Blockchain → CRE → Lambda → DynamoDB");
    console.log();
    console.log("  6) Read Employee Record (Lambda query)");
    console.log("     Query an employee's current state from DynamoDB.");
    console.log("     No on-chain interaction, read-only.");
    console.log();
    console.log("  7) List All Employees (Lambda scan)");
    console.log("     Fetch and display a table of all registered employees.");
    console.log("     No on-chain interaction, read-only.");
    console.log();
    console.log("  0) Exit");
    console.log();
};

const main = async () => {
    let running = true;

    while (running) {
        showMenu();
        const choice = await ask("Select an option [0-7]: ");
        console.log();

        try {
            switch (choice) {
                case "1": await handleSyncKyc(); break;
                case "2": await handleSyncEmployment(); break;
                case "3": await handleSyncGoal(); break;
                case "4": await handleFreezeWallet(); break;
                case "5": await handleFullRoundTrip(); break;
                case "6": await handleReadEmployee(); break;
                case "7": await handleListEmployees(); break;
                case "0":
                    console.log("   Goodbye!\n");
                    running = false;
                    break;
                default:
                    console.log("   Invalid option. Please enter a number 0-7.\n");
            }
        } catch (err) {
            console.error(`\n   ✗ ERROR: ${err.message}\n`);
        }
    }

    rl.close();
};

main();
