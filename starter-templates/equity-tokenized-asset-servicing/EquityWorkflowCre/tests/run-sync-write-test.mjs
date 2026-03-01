import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workflowDir = resolve(__dirname, "..");
const projectRoot = resolve(workflowDir, "..");

const configPath = resolve(workflowDir, "config.staging.json");
const payloadPath = resolve(__dirname, "payload_sync_kyc.json");
const envPath = resolve(projectRoot, ".env");

const config = JSON.parse(readFileSync(configPath, "utf-8"));
const payload = JSON.parse(readFileSync(payloadPath, "utf-8"));

const parseEnvFile = (path) => {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    out[key] = value;
  }
  return out;
};

const normalizePrivateKey = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed}`;
  return null;
};

const envFromFile = parseEnvFile(envPath);

const rpcUrl =
  process.env.SEPOLIA_RPC_URL ||
  "https://sepolia.gateway.tenderly.co/3Gg3yWf8Ftc5qKVcpRZYuI";
const lambdaUrl = process.env.LAMBDA_URL || envFromFile.LAMBDA_URL || config.url;
const identityRegistryAddress = config.evms[0].identityRegistryAddress.toLowerCase();
const autoBumpNonce = process.env.AUTO_BUMP_NONCE !== "false";

const normalizedPk = normalizePrivateKey(
  process.env.CRE_ETH_PRIVATE_KEY ?? envFromFile.CRE_ETH_PRIVATE_KEY,
);
const signerAccount = normalizedPk ? privateKeyToAccount(normalizedPk) : null;

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(rpcUrl),
});

const walletClient = signerAccount
  ? createWalletClient({
    account: signerAccount,
    chain: sepolia,
    transport: http(rpcUrl),
  })
  : null;

const isTransientTxError = (text) => {
  const normalized = String(text || "").toLowerCase();
  return (
    normalized.includes("replacement transaction underpriced") ||
    normalized.includes("nonce too low") ||
    normalized.includes("already known")
  );
};

const isAlreadyKnownLike = (text) => {
  const normalized = String(text || "").toLowerCase();
  return normalized.includes("already known") || normalized.includes("nonce provided");
};

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const getNonceInfo = async () => {
  if (!signerAccount) return null;
  const [latestNonce, pendingNonce, balance] = await Promise.all([
    publicClient.getTransactionCount({
      address: signerAccount.address,
      blockTag: "latest",
    }),
    publicClient.getTransactionCount({
      address: signerAccount.address,
      blockTag: "pending",
    }),
    publicClient.getBalance({ address: signerAccount.address }),
  ]);

  return {
    address: signerAccount.address,
    latestNonce,
    pendingNonce,
    pendingGap: Number(pendingNonce - latestNonce),
    balanceWei: balance,
  };
};

const tryNonceBump = async ({ force = false } = {}) => {
  if (!walletClient || !signerAccount) {
    console.log("   Nonce bump skipped: signer account not available in env.");
    return;
  }

  const info = await getNonceInfo();
  if (!info) return;

  console.log(
    `   Nonce status: latest=${info.latestNonce} pending=${info.pendingNonce} gap=${info.pendingGap}`,
  );

  if (!force && info.pendingNonce <= info.latestNonce) {
    console.log("   Nonce bump skipped: no pending nonce gap detected.");
    return;
  }

  if (force && info.pendingNonce <= info.latestNonce) {
    console.log(
      "   Forcing nonce tick despite gap=0 (provider may not expose pending tx in mempool).",
    );
  }

  // Use explicit minimum fees to avoid low-fee replacement rejections on testnet RPCs.
  const fee = await publicClient.estimateFeesPerGas();
  const baseMaxFee = fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n;
  const basePriority = fee.maxPriorityFeePerGas ?? 500_000_000n;
  const minMaxFee = 2_000_000_000n; // 2 gwei
  const minPriority = 1_000_000_000n; // 1 gwei
  const maxFeePerGas = (baseMaxFee * 2n > minMaxFee ? baseMaxFee * 2n : minMaxFee);
  const maxPriorityFeePerGas =
    basePriority * 2n > minPriority ? basePriority * 2n : minPriority;

  let sendNonce = info.pendingNonce;
  for (let i = 0; i < 2; i++) {
    console.log(
      `   Attempting nonce bump tx at nonce=${sendNonce} maxFeePerGas=${maxFeePerGas} maxPriorityFeePerGas=${maxPriorityFeePerGas}`,
    );

    try {
      const txHash = await walletClient.sendTransaction({
        to: signerAccount.address,
        value: 0n,
        nonce: sendNonce,
        gas: 21_000n,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      console.log(`   Nonce bump tx sent: ${txHash}`);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      console.log("   Nonce bump tx confirmed.");
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      if (isAlreadyKnownLike(msg) && i === 0) {
        await wait(2500);
        const refreshed = await getNonceInfo();
        if (refreshed) {
          sendNonce = refreshed.pendingNonce;
          console.log(
            `   Nonce bump retry after race/already-known. New latest=${refreshed.latestNonce}, pending=${refreshed.pendingNonce}.`,
          );
          continue;
        }
      }
      throw err;
    }
  }
};

const runCre = async (args, cwd = projectRoot, retries = 6, delayMs = 20000) => {
  let lastOutput = "";

  for (let attempt = 1; attempt <= retries; attempt++) {
    const childEnv = { ...process.env };
    if (normalizedPk) {
      childEnv.CRE_ETH_PRIVATE_KEY = normalizedPk;
    }
    childEnv.CRE_TARGET = "local-simulation";

    const out = spawnSync("cre", args, {
      cwd,
      encoding: "utf-8",
      env: childEnv,
    });

    const stdout = out.stdout || "";
    const stderr = out.stderr || "";
    const merged = `${stdout}\n${stderr}`;
    lastOutput = merged;

    if (out.status === 0) {
      if (attempt > 1) {
        console.log(`   CRE command succeeded on retry ${attempt}/${retries}.`);
      }
      return merged;
    }

    if (attempt < retries && isTransientTxError(merged)) {
      if (autoBumpNonce) {
        try {
          await tryNonceBump({ force: true });
        } catch (bumpErr) {
          console.log(`   Nonce bump attempt failed: ${bumpErr.message}`);
        }
      }

      console.log(
        `   Transient tx error detected (attempt ${attempt}/${retries}). Waiting ${Math.floor(
          delayMs / 1000,
        )}s before retry...`,
      );
      await wait(delayMs);
      continue;
    }

    throw new Error(`CRE command failed (${args.join(" ")}):\n${merged}`);
  }

  throw new Error(`CRE command failed after retries (${args.join(" ")}):\n${lastOutput}`);
};

const extractTxHash = (text) => {
  const matches = text.match(/0x[a-fA-F0-9]{64}/g);
  if (!matches || matches.length === 0) {
    throw new Error(`No tx hash found in output:\n${text}`);
  }
  return matches[matches.length - 1];
};

const run = async () => {
  console.log("1) Running CRE HTTP trigger with SYNC_KYC payload...");
  const httpOutput = await runCre([
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

  const txHash = extractTxHash(httpOutput);
  console.log(`   writeReport txHash: ${txHash}`);

  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });

  console.log("2) Fetching transaction receipt to locate IdentityRegistry log index...");
  let receipt;
  for (let i = 0; i < 12; i++) {
    receipt = await client.getTransactionReceipt({ hash: txHash });
    if (receipt) break;
    await wait(2000);
  }

  if (!receipt) {
    throw new Error("Transaction receipt not found");
  }

  const eventIndex = receipt.logs.findIndex(
    (log) => log.address.toLowerCase() === identityRegistryAddress,
  );

  if (eventIndex < 0) {
    throw new Error("No IdentityRegistry log found in receipt");
  }

  const identityLog = receipt.logs[eventIndex];
  console.log(
    `   IdentityRegistry event tx index: ${eventIndex} (global logIndex: ${identityLog.logIndex})`,
  );

  console.log("3) Running CRE EVM Log trigger to sync onchain event -> Lambda...");
  await runCre([
    "workflow",
    "simulate",
    "./EquityWorkflowCre",
    "--target",
    "local-simulation",
    "--non-interactive",
    "--trigger-index",
    "1",
    "--evm-tx-hash",
    txHash,
    "--evm-event-index",
    String(eventIndex),
    "--broadcast",
  ]);

  console.log("4) Verifying employee record via Lambda readEmployee...");
  const resp = await fetch(lambdaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "readEmployee",
      employeeAddress: payload.employeeAddress,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Lambda readEmployee failed with status ${resp.status}`);
  }

  const body = await resp.json();
  const parsedBody = typeof body.body === "string" ? JSON.parse(body.body) : body;
  const data = parsedBody?.data;

  if (!data) {
    throw new Error(`Lambda response does not contain data: ${JSON.stringify(parsedBody)}`);
  }

  const checks = {
    employeeMatch: String(data.employeeAddress).toLowerCase() === payload.employeeAddress.toLowerCase(),
    kycVerified: data.kycVerified === true,
    countryMatch: Number(data.country) === Number(payload.country),
    identityMatch: String(data.identityAddress).toLowerCase() === payload.identityAddress.toLowerCase(),
  };

  console.log("   Verification checks:", checks);

  if (!checks.employeeMatch || !checks.kycVerified || !checks.countryMatch || !checks.identityMatch) {
    throw new Error(`Verification failed. Record: ${JSON.stringify(data, null, 2)}`);
  }

  console.log("SUCCESS: CRE write + blockchain event sync + Lambda/Dynamo verification completed.");
};

run().catch((err) => {
  console.error(`TEST FAILED: ${err.message}`);
  process.exit(1);
});
