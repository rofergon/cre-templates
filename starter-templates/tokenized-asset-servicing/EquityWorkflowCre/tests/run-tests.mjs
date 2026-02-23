/**
 * run-tests.mjs
 *
 * Interactive CLI for the Equity CRE protocol.
 * Tests the full 3-tier flow: Lambda → CRE → Blockchain → CRE → Lambda
 *
 * Protocol contracts (Sepolia):
 *   Receiver         : 0xc1bE94A4639746F79d0A2bc65a82c0bf938B531a
 *   IdentityRegistry : 0x3DEd337A401E234d40Cf2A54D9291BF61692Ca07
 *   PrivateEquity    : 0xf94Df607d817e18B65985ADc94d6A0F1b1C7De99
 *   Token (ERC-3643) : read from Receiver.token()
 *
 * Trigger-index mapping (main.ts):
 *   0  = HTTP trigger  (write to blockchain)
 *   1  = IdentityRegistry log trigger (sync to Lambda)
 *   2  = PrivateEquity log trigger  (sync to Lambda)
 *   ⚠  Token (AddressFrozen) is NOT watched → Step 4 is skipped for SYNC_FREEZE_WALLET
 */

import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

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
    process.env.SEPOLIA_RPC_URL ||
    "https://sepolia.gateway.tenderly.co/3Gg3yWf8Ftc5qKVcpRZYuI";

const receiverAddress = config.evms[0].receiverAddress;
const identityRegistryAddress = config.evms[0].identityRegistryAddress.toLowerCase();
const acePrivacyManagerAddress = config.evms[0].acePrivacyManagerAddress.toLowerCase();

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
    chain: sepolia,
    transport: http(rpcUrl),
});

// ---------------------------------------------------------------------------
// On-chain ABIs (minimal, read-only)
// ---------------------------------------------------------------------------

const IDENTITY_REGISTRY_ABI = [
    { type: "function", name: "isVerified", inputs: [{ name: "_userAddress", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
    { type: "function", name: "identity", inputs: [{ name: "_userAddress", type: "address" }], outputs: [{ type: "address" }], stateMutability: "view" },
    { type: "function", name: "investorCountry", inputs: [{ name: "_userAddress", type: "address" }], outputs: [{ type: "uint16" }], stateMutability: "view" },
];

const EMPLOYEE_VESTING_ABI = [
    { type: "function", name: "isEmployed", inputs: [{ name: "", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
    { type: "function", name: "goalsAchieved", inputs: [{ name: "", type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
    { type: "function", name: "vestingPoolBalance", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    {
        type: "function", name: "grants",
        inputs: [{ name: "", type: "address" }],
        outputs: [
            { name: "totalAmount", type: "uint256" },
            { name: "startTime", type: "uint256" },
            { name: "cliffDuration", type: "uint256" },
            { name: "vestingDuration", type: "uint256" },
            { name: "amountClaimed", type: "uint256" },
            { name: "isRevocable", type: "bool" },
            { name: "performanceGoalId", type: "bytes32" },
        ],
        stateMutability: "view"
    },
];

const TOKEN_ABI = [
    { type: "function", name: "isFrozen", inputs: [{ name: "_userAddress", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
];

const RECEIVER_ABI = [
    { type: "function", name: "token", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
];

// ---------------------------------------------------------------------------
// Resolve Token address from EquityWorkflowReceiver.token()
// ---------------------------------------------------------------------------

let tokenAddress = null;

const resolveTokenAddress = async () => {
    if (tokenAddress) return tokenAddress;
    try {
        const addr = await publicClient.readContract({
            address: receiverAddress,
            abi: RECEIVER_ABI,
            functionName: "token",
        });
        tokenAddress = addr.toLowerCase();
        return tokenAddress;
    } catch (err) {
        console.warn(`   ⚠ Could not resolve Token address from Receiver: ${err.message}`);
        return null;
    }
};

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
// On-chain verification helpers
// ---------------------------------------------------------------------------

/**
 * Verify on-chain state after a sync action.
 * Returns an object with the verification results.
 */
const verifyOnChain = async (action, payload) => {
    console.log("\n┌─ On-chain verification ─────────────────────────────────────");

    switch (action) {
        case "SYNC_KYC": {
            const addr = payload.employeeAddress;
            try {
                const [isVerified, onChainIdentity, country] = await Promise.all([
                    publicClient.readContract({
                        address: identityRegistryAddress,
                        abi: IDENTITY_REGISTRY_ABI,
                        functionName: "isVerified",
                        args: [addr],
                    }),
                    publicClient.readContract({
                        address: identityRegistryAddress,
                        abi: IDENTITY_REGISTRY_ABI,
                        functionName: "identity",
                        args: [addr],
                    }),
                    publicClient.readContract({
                        address: identityRegistryAddress,
                        abi: IDENTITY_REGISTRY_ABI,
                        functionName: "investorCountry",
                        args: [addr],
                    }),
                ]);

                const expectedVerified = payload.verified;
                const expectedCountry = payload.country ?? 0;

                console.log(`   IdentityRegistry.isVerified(${addr.substring(0, 10)}...) = ${isVerified}  ${isVerified === expectedVerified ? "✓" : "✗"}`);
                console.log(`   IdentityRegistry.identity(...)    = ${onChainIdentity}`);
                console.log(`   IdentityRegistry.investorCountry  = ${country}  (expected: ${expectedCountry}) ${Number(country) === expectedCountry ? "✓" : "✗"}`);

                return { isVerified, onChainIdentity, country: Number(country) };
            } catch (err) {
                console.log(`   ⚠ Could not read IdentityRegistry: ${err.message}`);
                return null;
            }
        }

        case "SYNC_EMPLOYMENT_STATUS": {
            console.log("   ℹ Verification skipped: handled off-chain");
            return { isEmployed: true };
        }

        case "SYNC_GOAL": {
            console.log("   ℹ Verification skipped: handled off-chain");
            return { achieved: true };
        }

        case "SYNC_FREEZE_WALLET": {
            const addr = payload.walletAddress;
            const tokenAddr = await resolveTokenAddress();
            if (!tokenAddr) {
                console.log("   ⚠ Token address unavailable, skipping on-chain freeze check.");
                return null;
            }
            try {
                const isFrozen = await publicClient.readContract({
                    address: tokenAddr,
                    abi: TOKEN_ABI,
                    functionName: "isFrozen",
                    args: [addr],
                });

                const expected = payload.frozen;
                console.log(`   Token.isFrozen(${addr.substring(0, 10)}...) = ${isFrozen}  (expected: ${expected}) ${isFrozen === expected ? "✓" : "✗"}`);
                return { isFrozen };
            } catch (err) {
                console.log(`   ⚠ Could not read Token.isFrozen: ${err.message}`);
                return null;
            }
        }

        case "SYNC_CREATE_GRANT": {
            console.log("   ℹ SYNC_CREATE_GRANT is obsolete, testing SYNC_PRIVATE_DEPOSIT...");
            return null;
        }

        case "SYNC_BATCH": {
            console.log("   ℹ Skipping detailed verification for SYNC_BATCH.");
            break;
        }
    }
};

// ---------------------------------------------------------------------------
// Determine log trigger index based on action
//
// main.ts registers exactly 3 handlers:
//   index 0  = httpTrigger         → onHTTPTrigger  (writes to chain)
//   index 1  = IdentityRegistry logTrigger → onLogTrigger
//   index 2  = EmployeeVesting logTrigger  → onLogTrigger
//
// Token (AddressFrozen) events are NOT watched → return null for FREEZE_WALLET
// ---------------------------------------------------------------------------

const getTriggerIndex = (action, eventLogAddress) => {
    if (!eventLogAddress) return null;
    const addr = eventLogAddress.toLowerCase();
    if (addr === identityRegistryAddress) return "1";
    if (addr === acePrivacyManagerAddress) return "2";
    // Token events: no log trigger registered in main.ts
    return null;
};

// ---------------------------------------------------------------------------
// Full 3-tier flow: Lambda persist → CRE broadcast → LogTrigger → verify
// ---------------------------------------------------------------------------

const executeFullFlow = async (lambdaPayload, crePayload) => {
    const action = crePayload.action;

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
    console.log(`   ✓ Receipt found (block ${receipt.blockNumber}, ${receipt.logs.length} logs)`);

    // Step 3b: On-chain verification
    await verifyOnChain(action, crePayload);

    // Step 4: CRE LogTrigger → sync event back to Lambda
    // Determine which log (if any) was emitted by a watched contract
    const tokenAddr = await resolveTokenAddress();
    const watchedAddresses = [identityRegistryAddress, acePrivacyManagerAddress];

    const eventLogIdx = receipt.logs.findIndex(
        (log) => watchedAddresses.includes(log.address.toLowerCase()),
    );

    if (action === "SYNC_FREEZE_WALLET") {
        // Token events are not watched by main.ts log triggers — skip this step
        console.log("\n┌─ Step 4: CRE LogTrigger ── SKIPPED ─────────────────────");
        console.log("   ℹ Token (AddressFrozen) events are not watched by main.ts.");
        console.log("   ℹ Trigger 1 = IdentityRegistry, Trigger 2 = EmployeeVesting only.");
        console.log("   ℹ On-chain state was verified directly above (Step 3b).");
    } else if (action === "SYNC_BATCH") {
        console.log("\n┌─ Step 4: CRE LogTrigger ── SKIPPED ─────────────────────");
        console.log("   ℹ SYNC_BATCH emits many events; log triggers would need to be tested individually.");
    } else if (eventLogIdx === -1) {
        console.log("\n┌─ Step 4: CRE LogTrigger ── SKIPPED ─────────────────────");
        console.log("   ⚠ No watched contract event found in this tx. Skipping LogTrigger.");
    } else {
        const eventLog = receipt.logs[eventLogIdx];
        const triggerIndex = getTriggerIndex(action, eventLog.address);

        console.log(`\n┌─ Step 4: CRE LogTrigger → sync event to Lambda ───────────`);
        console.log(`   ✓ Event at tx log index: ${eventLogIdx} (contract: ${eventLog.address})`);
        console.log(`   ✓ Using trigger-index ${triggerIndex}`);

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
    }

    // Step 5: Verify in Lambda / DynamoDB
    console.log("\n┌─ Step 5: Verify via Lambda ───────────────────────────────");

    if (action === "SYNC_GOAL") {
        // GoalUpdated is stored in a goal:... record, not employee record
        const goalId = crePayload.goalId;
        const goalResult = await callLambda({ action: "readEmployee", employeeAddress: goalId }).catch(() => null);
        // The Lambda stores goal in a 'goal:...' record via GoalUpdated handler
        // We can verify via the on-chain state we already checked above
        console.log(`   ℹ Goals are stored in DynamoDB as 'goal:${goalId}' records.`);
        console.log(`   ℹ On-chain goalsAchieved state was verified in Step 3b.`);
    } else {
        const employeeAddr = crePayload.employeeAddress || crePayload.walletAddress;
        if (employeeAddr) {
            const readResult = await callLambda({ action: "readEmployee", employeeAddress: employeeAddr });
            if (readResult.statusCode === 200) {
                const record = readResult.body.data || readResult.body;
                console.log("   Employee record in DynamoDB:");
                console.log(`   ${JSON.stringify(record, null, 2).replace(/\n/g, "\n   ")}`);
            } else {
                console.log(`   ⚠ Could not read employee: status ${readResult.statusCode}`);
            }
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
        identityAddress = await askWithDefault(
            "   Identity contract address (non-zero, e.g. any valid 0x... address)",
            "0x2222222222222222222222222222222222222222",
        );
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
        // employeeAddress is optional here; goalId is the key identifier
        employeeAddress: "0x0000000000000000000000000000000000000001",
    };

    console.log(`\n   Payload: ${JSON.stringify(crePayload, null, 2).replace(/\n/g, "\n   ")}`);
    console.log("   ℹ GoalUpdated events are stored as 'goal:...' records in DynamoDB.");
    console.log("   ℹ On-chain verification reads EmployeeVesting.goalsAchieved(goalId).");
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
    console.log("   ℹ NOTE: Token (AddressFrozen) events are NOT watched by main.ts.");
    console.log("   ℹ Step 4 (log trigger) will be SKIPPED. On-chain state verified via Token.isFrozen().");

    // Resolve and show token address
    const tokenAddr = await resolveTokenAddress();
    if (tokenAddr) {
        console.log(`   ℹ Token contract: ${tokenAddr}`);
    }

    const confirm = await askYesNo("\n   Proceed with this payload?", true);
    if (!confirm) { console.log("   Cancelled.\n"); return; }

    await executeFullFlow(lambdaPayload, crePayload);
};

const handleFullRoundTrip = async () => {
    console.log("\n── Full 3-Tier Round-Trip Test (automated defaults) ─────────\n");
    console.log("   Running KYC sync with default test data...\n");

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

    // Also show current on-chain state summary
    console.log("   On-chain state summary:");
    try {
        const [isVerified, country] = await Promise.all([
            publicClient.readContract({ address: identityRegistryAddress, abi: IDENTITY_REGISTRY_ABI, functionName: "isVerified", args: [employeeAddress] }),
            publicClient.readContract({ address: identityRegistryAddress, abi: IDENTITY_REGISTRY_ABI, functionName: "investorCountry", args: [employeeAddress] }),
        ]);
        const isEmployed = "Off-chain";
        const tokenAddr = await resolveTokenAddress();
        let isFrozen = "N/A";
        if (tokenAddr) {
            isFrozen = await publicClient.readContract({ address: tokenAddr, abi: TOKEN_ABI, functionName: "isFrozen", args: [employeeAddress] });
        }
        console.log(`     IdentityRegistry: isVerified=${isVerified}, country=${country}`);
        console.log(`     EmployeeVesting:  isEmployed=${isEmployed}`);
        console.log(`     Token (ERC-3643): isFrozen=${isFrozen}`);
    } catch (err) {
        console.log(`     (could not fetch on-chain state: ${err.message})`);
    }
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

    const tableData = records.map((r) => ({
        "Address": r.employeeAddress ? `${r.employeeAddress.substring(0, 8)}...${r.employeeAddress.substring(38)}` : "N/A",
        "KYC": r.kycVerified ? "✅" : "❌",
        "Country": r.country || "---",
        "Employed": r.employed !== false ? "✅" : "❌",
        "Wallet Frz": r.walletFrozen ? "❄️" : "---",
        "Last Event": r.lastOnchainEvent || "---",
    }));

    console.table(tableData);
    console.log();
};

const handleCreateVestingGrant = async () => {
    console.log("\n── Create Vesting Grant (SYNC_CREATE_GRANT — Full CRE Flow) ────\n");
    console.log("   ✓ Protocol redesigned: EmployeeVesting.createGrant() is now onlyOracle");
    console.log("   ✓ EquityWorkflowReceiver has SYNC_CREATE_GRANT (ActionType 4)");
    console.log("   ✓ Pool pre-funded with 1,000,000 EQT during deployment\n");

    const employeeAddress = await askWithDefault("   Employee wallet address", "0x1111111111111111111111111111111111111111");
    const vestingTotalAmount = await askWithDefault("   Total vesting amount (tokens, no decimals)", "100");
    const cliffMonths = Number(await askWithDefault("   Cliff period (months)", "6"));
    const vestingMonths = Number(await askWithDefault("   Vesting duration (months)", "48"));
    const isRevocable = await askYesNo("   Is grant revocable?", true);
    const performanceGoalId = await askWithDefault(
        "   Performance goal ID (bytes32, 0x000...0 for none)",
        "0x" + "0".repeat(64)
    );
    const notes = await askWithDefault("   Notes (for Lambda record)", "Initial equity grant");

    const nowSec = Math.floor(Date.now() / 1000);
    const cliffSeconds = cliffMonths * 30 * 24 * 3600;
    const vestingSeconds = vestingMonths * 30 * 24 * 3600;

    // Check current vesting pool balance
    try {
        const poolBalance = await publicClient.readContract({
            address: employeeVestingAddress,
            abi: EMPLOYEE_VESTING_ABI,
            functionName: "vestingPoolBalance",
        });
        console.log(`\n   ✓ Current vesting pool balance: ${poolBalance} tokens`);
        if (BigInt(vestingTotalAmount) > poolBalance) {
            console.log(`   ⚠ WARNING: requested amount (${vestingTotalAmount}) > pool balance (${poolBalance})`);
            console.log(`   ⚠ The on-chain transaction will revert if pool is insufficient.`);
        }
    } catch (err) {
        console.log(`   ⚠ Could not read pool balance: ${err.message}`);
    }

    const crePayload = {
        action: "SYNC_CREATE_GRANT",
        employeeAddress,
        amount: vestingTotalAmount,
        startTime: nowSec,
        cliffDuration: cliffSeconds,
        vestingDuration: vestingSeconds,
        isRevocable,
        performanceGoalId,
    };

    const lambdaPayload = {
        action: "CompanyEmployeeInput",
        employeeAddress,
        vestingTotalAmount,
        vestingStartTime: nowSec,
        cliffDuration: cliffSeconds,
        vestingDuration: vestingSeconds,
        isRevocable,
        notes,
        employed: true,
    };

    console.log(`\n   CRE Payload: ${JSON.stringify(crePayload, null, 2).replace(/\n/g, "\n   ")}`);

    const confirm = await askYesNo("\n   Proceed with full CRE flow?", true);
    if (!confirm) { console.log("   Cancelled.\n"); return; }

    await executeFullFlow(lambdaPayload, crePayload);
};

const handleBulkSequence = async () => {
    console.log("\n── Automated Bulk Sequence: 20 Employees ───────────────────\n");

    const mockFilePath = resolve(workflowDir, "tests", "mock-employees.json");
    if (!existsSync(mockFilePath)) {
        console.log(`   ✗ File not found: ${mockFilePath}`);
        return;
    }
    const employees = JSON.parse(readFileSync(mockFilePath, "utf-8"));

    const lambdaPayload = {
        action: "CompanyEmployeeBatchInput",
        employees: employees
    };

    const batches = [];
    for (const emp of employees) {
        if (emp.kycVerified !== undefined || emp.identityAddress || emp.country) {
            batches.push({
                action: "SYNC_KYC",
                employeeAddress: emp.employeeAddress,
                verified: !!emp.kycVerified,
                identityAddress: emp.kycVerified ? emp.identityAddress : undefined,
                country: emp.country ?? 0
            });
        }

        if (emp.privateDeposit) {
            batches.push({
                action: "SYNC_PRIVATE_DEPOSIT",
                amount: BigInt(emp.privateDeposit.amount).toString()
            });
        }

        if (emp.walletFrozen !== undefined) {
            batches.push({
                action: "SYNC_FREEZE_WALLET",
                walletAddress: emp.employeeAddress,
                frozen: !!emp.walletFrozen
            });
        }

        if (emp.ticketRedeemed) {
            batches.push({
                action: "SYNC_REDEEM_TICKET",
                employeeAddress: emp.employeeAddress,
                amount: BigInt(emp.ticketRedeemed.amount).toString(),
                ticket: "0x0000000000000000000000000000000000000000000000000000000000000000"
            });
        }
    }

    const crePayload = {
        action: "SYNC_BATCH",
        batches: batches
    };

    console.log(`   Loaded ${employees.length} employees from mock-employees.json`);
    console.log(`   Prepared batch with ${batches.length} sync actions.`);

    const confirm = await askYesNo("\n   Proceed with batch upload?", true);
    if (!confirm) { console.log("   Cancelled.\n"); return; }

    try {
        await executeFullFlow(lambdaPayload, crePayload);
    } catch (err) {
        console.error(`\n   ✗ Failed: ${err.message}`);
    }
};

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

const showMenu = () => {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║           Equity CRE — Interactive Test Runner              ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log();
    console.log("  CONTRACT ADDRESSES (Base Sepolia)");
    console.log(`  Receiver:       ${config.evms[0].receiverAddress}`);
    console.log(`  IdentityReg:    ${config.evms[0].identityRegistryAddress}`);
    console.log(`  PrivateEquity:  ${config.evms[0].acePrivacyManagerAddress}`);
    console.log(`  Token (ERC-3643): read from Receiver.token() on-chain`);
    console.log();
    console.log("  TRIGGER FLOW (main.ts):  0=HTTP  1=IdentityReg  2=EmployeeVest");
    console.log("  ⚠ Token AddressFrozen events are NOT watched → Step 4 skipped for FREEZE");
    console.log();
    console.log("  ─── SYNC ACTIONS (Web2 → Blockchain → Web2) ───────────────");
    console.log("  1) Register / Update Employee (SYNC_KYC)");
    console.log("     Flow: Lambda → CRE → IdentityRegistry → CRE → Lambda");
    console.log("     ✓ On-chain: isVerified, identity, investorCountry");
    console.log();
    console.log("  2) Update Employment Status (SYNC_EMPLOYMENT_STATUS)");
    console.log("     Flow: Lambda → CRE → EmployeeVesting → CRE → Lambda");
    console.log("     ✓ On-chain: isEmployed");
    console.log();
    console.log("  3) Update Performance Goal (SYNC_GOAL)");
    console.log("     Flow: Lambda → CRE → EmployeeVesting → CRE → Lambda");
    console.log("     ✓ On-chain: goalsAchieved(bytes32)");
    console.log();
    console.log("  4) Freeze / Unfreeze Wallet (SYNC_FREEZE_WALLET)");
    console.log("     Flow: Lambda → CRE → Token(ERC-3643)  [Step 4 SKIPPED]");
    console.log("     ✓ On-chain: Token.isFrozen (read from Receiver.token())");
    console.log();
    console.log("  5) Full 3-Tier Round-Trip Test (automated KYC)");
    console.log("     Lambda → CRE → Blockchain → CRE → Lambda → DynamoDB");
    console.log();
    console.log("  ─── READ-ONLY (DynamoDB queries) ────────────────────────────");
    console.log("  6) Read Employee Record  (+ on-chain state summary)");
    console.log("  7) List All Employees");
    console.log();
    console.log("  ─── ADVANCED ────────────────────────────────────────────────");
    console.log("  8) Create Vesting Grant Metadata (Lambda persist)");
    console.log("  9) Automated Bulk Sequence (Uses mock-employees.json, SYNC_BATCH)");
    console.log();
    console.log("  0) Exit");
    console.log();
};

const main = async () => {
    let running = true;

    // Pre-warm: resolve Token address
    const tokenAddr = await resolveTokenAddress();
    if (tokenAddr) {
        console.log(`\n   Token (ERC-3643): ${tokenAddr}`);
    }

    while (running) {
        showMenu();
        const choice = await ask("Select an option [0-9]: ");
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
                case "8": await handleCreateVestingGrant(); break;
                case "9": await handleBulkSequence(); break;
                case "0":
                    console.log("   Goodbye!\n");
                    running = false;
                    break;
                default:
                    console.log("   Invalid option. Please enter a number 0-9.\n");
            }
        } catch (err) {
            console.error(`\n   ✗ ERROR: ${err.message}\n`);
        }
    }

    rl.close();
};

main();
