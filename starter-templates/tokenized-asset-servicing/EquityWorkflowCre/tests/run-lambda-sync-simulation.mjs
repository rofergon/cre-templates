/**
 * run-lambda-sync-simulation.mjs
 *
 * 3-Tier Architecture Simulation:
 *   AWS (Lambda + DynamoDB)  ⟷  CRE Workflow  ⟷  Blockchain (Base Sepolia)
 *
 * Flow:
 *   1. Web Service → Lambda CompanyEmployeeInput (persist to DynamoDB)
 *   2. Build sync payloads from employee state
 *   3. For each payload → CRE simulate --broadcast (write report to chain)
 *   4. Get tx receipt → find event log index
 *   5. CRE simulate log trigger (replay event → Lambda POST)
 *   6. Verify round-trip via Lambda readEmployee
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Paths
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

if (!lambdaUrl) {
    throw new Error("LAMBDA_URL not found in environment or .env file");
}

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
// Helpers
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const callLambda = async (payload) => {
    const resp = await fetch(lambdaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    const text = await resp.text();
    let body;
    try {
        body = JSON.parse(text);
        if (typeof body.body === "string") {
            body = JSON.parse(body.body);
        }
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
// Sync payload builder (mirrors Lambda buildSyncPayloadsFromCompanyInput)
// ---------------------------------------------------------------------------

const buildSyncPayloads = (employeeState, opts = {}) => {
    const payloads = [];
    const employeeAddress = employeeState.employeeAddress;

    if (opts.syncKyc) {
        const kycPayload = {
            action: "SYNC_KYC",
            employeeAddress,
            verified: Boolean(employeeState.kycVerified),
            country: Number(employeeState.country ?? 0),
        };
        if (kycPayload.verified) {
            if (!employeeState.identityAddress) {
                throw new Error("identityAddress required when kycVerified=true");
            }
            kycPayload.identityAddress = employeeState.identityAddress;
        }
        payloads.push(kycPayload);
    }

    if (opts.syncEmployment) {
        payloads.push({
            action: "SYNC_EMPLOYMENT_STATUS",
            employeeAddress,
            employed: Boolean(employeeState.employed),
        });
    }

    if (opts.syncGoal && employeeState.goalId) {
        payloads.push({
            action: "SYNC_GOAL",
            goalId: employeeState.goalId,
            achieved: Boolean(employeeState.goalAchieved),
        });
    }

    if (opts.syncFreezeWallet) {
        payloads.push({
            action: "SYNC_FREEZE_WALLET",
            walletAddress: employeeAddress,
            frozen: Boolean(employeeState.walletFrozen),
        });
    }

    return payloads;
};

// ---------------------------------------------------------------------------
// Main simulation
// ---------------------------------------------------------------------------

const run = async () => {
    const employeeAddress = "0x1111111111111111111111111111111111111111";
    const identityAddress = "0x2222222222222222222222222222222222222222";
    const country = 840;

    // ── Step 1: AWS tier — persist employee data via Lambda ──────────────
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║    3-Tier Architecture Simulation: Lambda → CRE → Chain    ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log();
    console.log("┌─ Step 1: AWS tier ─ Persist employee data via Lambda ───────");

    const companyResult = await callLambda({
        action: "CompanyEmployeeInput",
        employeeAddress,
        identityAddress,
        country,
        kycVerified: true,
        employed: true,
    });

    if (companyResult.statusCode !== 200) {
        throw new Error(
            `CompanyEmployeeInput failed (${companyResult.statusCode}): ${JSON.stringify(companyResult.body)}`,
        );
    }

    const employeeState = companyResult.body.data || companyResult.body;
    console.log("   ✓ Employee persisted in DynamoDB");
    console.log(`     employeeAddress: ${employeeState.employeeAddress}`);
    console.log(`     kycVerified: ${employeeState.kycVerified}, country: ${employeeState.country}`);

    // ── Step 2: Build sync payloads ─────────────────────────────────────
    console.log();
    console.log("┌─ Step 2: Build sync payloads from employee state ───────────");

    const syncPayloads = buildSyncPayloads(employeeState, { syncKyc: true });
    console.log(`   ✓ Generated ${syncPayloads.length} sync payload(s):`);
    for (const p of syncPayloads) {
        console.log(`     → ${p.action}`);
    }

    // ── Step 3: CRE tier — parse → encode ABI → write report to chain ──
    console.log();
    console.log("┌─ Step 3: CRE tier ─ Write report to blockchain ────────────");

    const txHashes = [];

    for (const payload of syncPayloads) {
        console.log(`   Submitting ${payload.action} via CRE simulate --broadcast...`);

        const output = await runCre([
            "workflow",
            "simulate",
            "./EquityWorkflowCre",
            "--target",
            "local-simulation",
            "--non-interactive",
            "--trigger-index",
            "0",
            "--http-payload",
            JSON.stringify(payload),
            "--broadcast",
        ]);

        const txHash = extractTxHash(output);
        txHashes.push({ action: payload.action, txHash });
        console.log(`   ✓ writeReport txHash: ${txHash}`);
    }

    // ── Step 4: Blockchain tier — get receipt, find event log ───────────
    console.log();
    console.log("┌─ Step 4: Blockchain tier ─ Get transaction receipt ─────────");

    for (const { action, txHash } of txHashes) {
        let receipt;
        for (let i = 0; i < 15; i++) {
            receipt = await publicClient.getTransactionReceipt({ hash: txHash });
            if (receipt) break;
            await wait(2000);
        }

        if (!receipt) {
            throw new Error(`Receipt not found for ${action} tx: ${txHash}`);
        }

        const eventLogIdx = receipt.logs.findIndex(
            (log) =>
                log.address.toLowerCase() === identityRegistryAddress ||
                log.address.toLowerCase() === employeeVestingAddress,
        );

        if (eventLogIdx === -1) {
            console.log(`   ⚠ No target contract event found for ${action}. Skipping log trigger.`);
            continue;
        }

        const eventLog = receipt.logs[eventLogIdx];
        // CRE expects index within tx logs array, NOT the global logIndex
        const eventIndex = eventLogIdx;
        console.log(`   ✓ ${action} event at tx log index: ${eventIndex} (global logIndex: ${eventLog.logIndex})`);

        // ── Step 5: CRE LogTrigger → Lambda sync back ───────────────────
        console.log();
        console.log(`┌─ Step 5: CRE LogTrigger ─ Sync on-chain event → Lambda ───`);

        // Determine trigger-index (1 = IdentityRegistry, 2 = EmployeeVesting)
        const triggerIndex = eventLog.address.toLowerCase() === identityRegistryAddress ? "1" : "2";

        await runCre([
            "workflow",
            "simulate",
            "./EquityWorkflowCre",
            "--target",
            "local-simulation",
            "--non-interactive",
            "--trigger-index",
            triggerIndex,
            "--evm-tx-hash",
            txHash,
            "--evm-event-index",
            String(eventIndex),
            "--broadcast",
        ]);

        console.log(`   ✓ CRE log trigger forwarded ${action} event to Lambda`);
    }

    // ── Step 6: Verify round-trip ──────────────────────────────────────
    console.log();
    console.log("┌─ Step 6: Verify round-trip via Lambda readEmployee ─────────");

    const readResult = await callLambda({
        action: "readEmployee",
        employeeAddress,
    });

    if (readResult.statusCode !== 200) {
        throw new Error(
            `readEmployee failed (${readResult.statusCode}): ${JSON.stringify(readResult.body)}`,
        );
    }

    const record = readResult.body.data || readResult.body;

    const checks = {
        employeeMatch:
            String(record.employeeAddress).toLowerCase() === employeeAddress.toLowerCase(),
        kycVerified: record.kycVerified === true,
        countryMatch: Number(record.country) === country,
        identityMatch:
            String(record.identityAddress).toLowerCase() === identityAddress.toLowerCase(),
        hasOnchainEvent: typeof record.lastOnchainEvent === "string",
    };

    console.log("   Verification checks:");
    for (const [key, passed] of Object.entries(checks)) {
        console.log(`     ${passed ? "✓" : "✗"} ${key}: ${passed}`);
    }

    const allPassed = Object.values(checks).every(Boolean);
    if (!allPassed) {
        throw new Error(
            `Verification FAILED. Record:\n${JSON.stringify(record, null, 2)}`,
        );
    }

    console.log();
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  ✓ SUCCESS: Full 3-tier round-trip verified                 ║");
    console.log("║    Lambda → CRE → Blockchain → CRE → Lambda → DynamoDB     ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
};

run().catch((err) => {
    console.error(`\n✗ SIMULATION FAILED: ${err.message}`);
    process.exit(1);
});
