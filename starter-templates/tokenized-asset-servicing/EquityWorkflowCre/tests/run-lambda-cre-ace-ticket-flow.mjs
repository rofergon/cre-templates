/**
 * run-lambda-cre-ace-ticket-flow.mjs
 *
 * Full E2E test:
 *   Lambda (company input) -> onchain sync actions -> ACE private transfer ->
 *   employee withdraw ticket + onchain redeem (official ACE vault)
 *
 * Required env:
 *   CRE_ETH_PRIVATE_KEY
 *   CRE_EMPLOYEE_ETH_PRIVATE_KEY
 *   LAMBDA_URL (or config.staging.json url)
 *
 * Optional env:
 *   USE_DIRECT_RECEIVER_REPORTS=true   (default true; recommended with receiver test mode)
 *   SEPOLIA_RPC_URL
 *   CRE_EMPLOYEE_IDENTITY_ADDRESS
 *   CRE_ADMIN_IDENTITY_ADDRESS
 *   CRE_EMPLOYEE_COUNTRY
 *   ACE_E2E_AMOUNT_WEI
 *   ACE_EMPLOYEE_MIN_GAS_WEI
 *   STRICT_ONCHAIN_KYC=false
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  http,
  parseAbiParameters,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workflowDir = resolve(__dirname, "..");
const projectRoot = resolve(workflowDir, "..");

const configPath = resolve(workflowDir, "config.staging.json");
const envPath = resolve(projectRoot, ".env");

const config = JSON.parse(readFileSync(configPath, "utf-8"));

const DEFAULT_RPC_URL =
  "https://sepolia.gateway.tenderly.co/3Gg3yWf8Ftc5qKVcpRZYuI";
const DEFAULT_ACE_API_URL = "https://convergence2026-token-api.cldev.cloud";
const DEFAULT_ACE_VAULT = "0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13";
const DEFAULT_ACE_CHAIN_ID = 11155111;
const DEFAULT_COUNTRY = 840;
const DEFAULT_EMPLOYEE_IDENTITY = "0x00000000000000000000000000000000000000E5";
const DEFAULT_ADMIN_IDENTITY = "0x00000000000000000000000000000000000000A1";
const DEFAULT_VAULT_IDENTITY = "0x00000000000000000000000000000000000000A2";
const DEFAULT_GOAL_ID = "0x00000000000000000000000000000000000000000000000000000000000000e5";
const DEFAULT_AMOUNT_WEI = 1_000_000_000_000_000_000n;
const DEFAULT_EMPLOYEE_MIN_GAS_WEI = parseEther("0.003");

const ACTION_TYPE = {
  SYNC_KYC: 0,
  SYNC_EMPLOYMENT_STATUS: 1,
  SYNC_GOAL: 2,
  SYNC_FREEZE_WALLET: 3,
  SYNC_MINT: 7,
  SYNC_SET_CLAIM_REQUIREMENTS: 8,
};

const IDENTITY_REGISTRY_ABI = [
  {
    type: "function",
    name: "isVerified",
    inputs: [{ name: "_userAddress", type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "identity",
    inputs: [{ name: "_userAddress", type: "address" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "investorCountry",
    inputs: [{ name: "_userAddress", type: "address" }],
    outputs: [{ type: "uint16" }],
    stateMutability: "view",
  },
];

const TOKEN_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isFrozen",
    inputs: [{ name: "_userAddress", type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
];

const RECEIVER_ABI = [
  {
    type: "function",
    name: "onReport",
    inputs: [
      { name: "metadata", type: "bytes" },
      { name: "report", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

const VAULT_ABI = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdrawWithTicket",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "ticket", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "checkDepositAllowed",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "checkWithdrawAllowed",
    inputs: [
      { name: "withdrawer", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "view",
  },
];

const PRIVATE_EQUITY_ABI = [
  {
    type: "function",
    name: "isEmployeeEligible",
    inputs: [{ name: "employee", type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
];

const ACE_TYPES = {
  balances: {
    primaryType: "Retrieve Balances",
    types: {
      "Retrieve Balances": [
        { name: "account", type: "address" },
        { name: "timestamp", type: "uint256" },
      ],
    },
  },
  privateTransfer: {
    primaryType: "Private Token Transfer",
    types: {
      "Private Token Transfer": [
        { name: "sender", type: "address" },
        { name: "recipient", type: "address" },
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "flags", type: "string[]" },
        { name: "timestamp", type: "uint256" },
      ],
    },
  },
  withdraw: {
    primaryType: "Withdraw Tokens",
    types: {
      "Withdraw Tokens": [
        { name: "account", type: "address" },
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "timestamp", type: "uint256" },
      ],
    },
  },
};

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

const normalizePrivateKey = (value, label) => {
  if (!value) throw new Error(`Missing ${label}`);
  const trimmed = String(value).trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed}`;
  throw new Error(`${label} is not a valid 32-byte hex private key`);
};

const asJson = async (resp) => {
  const text = await resp.text();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.body === "string") {
      try {
        return JSON.parse(parsed.body);
      } catch {
        return parsed;
      }
    }
    return parsed;
  } catch {
    return { raw: text };
  }
};

const pretty = (value) =>
  JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const isTransientTxError = (text) => {
  const normalized = String(text || "").toLowerCase();
  return (
    normalized.includes("replacement transaction underpriced") ||
    normalized.includes("nonce too low") ||
    normalized.includes("already known")
  );
};

const extractTxHash = (text) => {
  const matches = text.match(/0x[a-fA-F0-9]{64}/g);
  if (!matches || matches.length === 0) {
    throw new Error(`No tx hash found in output:\n${text}`);
  }
  return matches[matches.length - 1];
};

const getTimestampFactory = () => {
  let last = 0;
  return () => {
    const now = Math.floor(Date.now() / 1000);
    last = Math.max(now, last + 1);
    return last;
  };
};

const toBigInt = (value, fallback) => {
  if (value == null || value === "") return fallback;
  return BigInt(String(value));
};

const run = async () => {
  const envFromFile = parseEnvFile(envPath);
  const evmConfig = config.evms?.[0] || {};

  const adminPk = normalizePrivateKey(
    process.env.CRE_ETH_PRIVATE_KEY ?? envFromFile.CRE_ETH_PRIVATE_KEY,
    "CRE_ETH_PRIVATE_KEY",
  );
  const employeePk = normalizePrivateKey(
    process.env.CRE_EMPLOYEE_ETH_PRIVATE_KEY ?? envFromFile.CRE_EMPLOYEE_ETH_PRIVATE_KEY,
    "CRE_EMPLOYEE_ETH_PRIVATE_KEY",
  );

  const admin = privateKeyToAccount(adminPk);
  const employee = privateKeyToAccount(employeePk);
  if (admin.address.toLowerCase() === employee.address.toLowerCase()) {
    throw new Error("Admin and employee private keys resolve to the same address");
  }

  const lambdaUrl = process.env.LAMBDA_URL || envFromFile.LAMBDA_URL || config.url;
  if (!lambdaUrl) throw new Error("Missing LAMBDA_URL (.env or config)");

  const rpcUrl = process.env.SEPOLIA_RPC_URL || envFromFile.SEPOLIA_RPC_URL || DEFAULT_RPC_URL;
  const tokenAddress = process.env.TOKEN_ADDRESS || envFromFile.TOKEN_ADDRESS || evmConfig.tokenAddress;
  const vaultAddress =
    process.env.ACE_VAULT_ADDRESS ||
    envFromFile.ACE_VAULT_ADDRESS ||
    evmConfig.aceVaultAddress ||
    DEFAULT_ACE_VAULT;
  const aceApiBase =
    process.env.ACE_API_URL ||
    envFromFile.ACE_API_URL ||
    config.aceApiUrl ||
    DEFAULT_ACE_API_URL;
  const aceChainId = Number(
    process.env.ACE_CHAIN_ID ||
      envFromFile.ACE_CHAIN_ID ||
      evmConfig.aceChainId ||
      DEFAULT_ACE_CHAIN_ID,
  );

  const identityRegistryAddress = evmConfig.identityRegistryAddress;
  const privateEquityAddress = evmConfig.acePrivacyManagerAddress;
  const receiverAddress = evmConfig.receiverAddress;
  if (!tokenAddress) throw new Error("Missing tokenAddress (config or TOKEN_ADDRESS)");
  if (!identityRegistryAddress) throw new Error("Missing identityRegistryAddress in config");
  if (!privateEquityAddress) throw new Error("Missing acePrivacyManagerAddress in config");
  if (!receiverAddress) throw new Error("Missing receiverAddress in config");

  const employeeIdentityAddress =
    process.env.CRE_EMPLOYEE_IDENTITY_ADDRESS ||
    envFromFile.CRE_EMPLOYEE_IDENTITY_ADDRESS ||
    DEFAULT_EMPLOYEE_IDENTITY;
  const adminIdentityAddress =
    process.env.CRE_ADMIN_IDENTITY_ADDRESS ||
    envFromFile.CRE_ADMIN_IDENTITY_ADDRESS ||
    DEFAULT_ADMIN_IDENTITY;
  const vaultIdentityAddress =
    process.env.CRE_ACE_VAULT_IDENTITY_ADDRESS ||
    envFromFile.CRE_ACE_VAULT_IDENTITY_ADDRESS ||
    DEFAULT_VAULT_IDENTITY;
  const country = Number(
    process.env.CRE_EMPLOYEE_COUNTRY || envFromFile.CRE_EMPLOYEE_COUNTRY || DEFAULT_COUNTRY,
  );
  const simulateGoalCliff =
    String(process.env.ACE_SIMULATE_GOAL_CLIFF ?? envFromFile.ACE_SIMULATE_GOAL_CLIFF ?? "true").toLowerCase() ===
    "true";
  const cliffLeadSeconds = Number(
    process.env.ACE_SIMULATED_CLIFF_LEAD_SECONDS ??
      envFromFile.ACE_SIMULATED_CLIFF_LEAD_SECONDS ??
      "600",
  );
  const vestingGoalId = (
    process.env.ACE_VESTING_GOAL_ID ??
    envFromFile.ACE_VESTING_GOAL_ID ??
    DEFAULT_GOAL_ID
  ).toLowerCase();
  const amountWei = toBigInt(
    process.env.ACE_E2E_AMOUNT_WEI ?? envFromFile.ACE_E2E_AMOUNT_WEI,
    DEFAULT_AMOUNT_WEI,
  );
  const minEmployeeGasWei = toBigInt(
    process.env.ACE_EMPLOYEE_MIN_GAS_WEI ?? envFromFile.ACE_EMPLOYEE_MIN_GAS_WEI,
    DEFAULT_EMPLOYEE_MIN_GAS_WEI,
  );
  const strictOnchainKyc =
    String(process.env.STRICT_ONCHAIN_KYC ?? envFromFile.STRICT_ONCHAIN_KYC ?? "false").toLowerCase() ===
    "true";
  const useDirectReceiverReports =
    String(
      process.env.USE_DIRECT_RECEIVER_REPORTS ??
        envFromFile.USE_DIRECT_RECEIVER_REPORTS ??
        "true",
    ).toLowerCase() === "true";

  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const adminWalletClient = createWalletClient({ account: admin, chain: sepolia, transport: http(rpcUrl) });
  const employeeWalletClient = createWalletClient({
    account: employee,
    chain: sepolia,
    transport: http(rpcUrl),
  });

  const waitReceipt = async (hash) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt || receipt.status !== "success") {
      throw new Error(`Transaction failed: ${hash}`);
    }
    return receipt;
  };

  const childEnv = { ...process.env };
  childEnv.CRE_ETH_PRIVATE_KEY = adminPk;
  childEnv.LAMBDA_URL = lambdaUrl;
  childEnv.CRE_TARGET = "local-simulation";

  const runCre = async (payload) => {
    const args = [
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
    ];

    let lastOutput = "";
    for (let attempt = 1; attempt <= 4; attempt++) {
      const out = spawnSync("cre", args, { cwd: projectRoot, encoding: "utf-8", env: childEnv });
      const merged = `${out.stdout || ""}\n${out.stderr || ""}`;
      lastOutput = merged;
      if (out.status === 0) return extractTxHash(merged);
      if (attempt < 4 && isTransientTxError(merged)) {
        await wait(15000);
        continue;
      }
      throw new Error(`CRE command failed:\n${merged}`);
    }
    throw new Error(`CRE command failed after retries:\n${lastOutput}`);
  };

  const encodeInstruction = (payload) => {
    if (payload.action === "SYNC_KYC") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("address employee, bool verified, address identity, uint16 country"),
        [payload.employeeAddress, payload.verified, payload.identityAddress, payload.country],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_KYC,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_FREEZE_WALLET") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("address walletAddress, bool frozen"),
        [payload.walletAddress, payload.frozen],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_FREEZE_WALLET,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_EMPLOYMENT_STATUS") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("address employee, bool employed"),
        [payload.employeeAddress, payload.employed],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_EMPLOYMENT_STATUS,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_GOAL") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("bytes32 goalId, bool achieved, address employeeHint"),
        [payload.goalId, payload.achieved, payload.employeeAddress ?? "0x0000000000000000000000000000000000000000"],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_GOAL,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_SET_CLAIM_REQUIREMENTS") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("address employee, uint64 cliffEndTimestamp, bytes32 goalId, bool goalRequired"),
        [payload.employeeAddress, BigInt(payload.cliffEndTimestamp), payload.goalId, payload.goalRequired],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_SET_CLAIM_REQUIREMENTS,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_MINT") {
      const encodedPayload = encodeAbiParameters(parseAbiParameters("address to, uint256 amount"), [
        payload.to,
        BigInt(payload.amount),
      ]);
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_MINT,
        encodedPayload,
      ]);
    }

    throw new Error(`Unsupported action for onchain report: ${payload.action}`);
  };

  const sendOnchainAction = async (payload) => {
    if (!useDirectReceiverReports) {
      return runCre(payload);
    }

    const report = encodeInstruction(payload);
    const txHash = await adminWalletClient.writeContract({
      address: receiverAddress,
      abi: RECEIVER_ABI,
      functionName: "onReport",
      args: ["0x", report],
    });
    await waitReceipt(txHash);
    return txHash;
  };

  const postLambda = async (body) => {
    const resp = await fetch(lambdaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await asJson(resp);
    if (!resp.ok) throw new Error(`Lambda failed (${resp.status}): ${pretty(data)}`);
    return data;
  };

  const aceDomain = {
    name: "CompliantPrivateTokenDemo",
    version: "0.0.1",
    chainId: aceChainId,
    verifyingContract: vaultAddress,
  };
  const nextTs = getTimestampFactory();

  const signAce = async (account, primaryType, types, message) =>
    account.signTypedData({ domain: aceDomain, primaryType, types, message });

  const postAce = async (endpoint, body) => {
    const url = `${aceApiBase.replace(/\/$/, "")}${endpoint}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await asJson(resp);
    if (!resp.ok) {
      throw new Error(`ACE ${endpoint} failed (${resp.status}): ${pretty(data)}`);
    }
    return data;
  };

  const getAceBalanceForToken = async (account, token) => {
    const timestamp = nextTs();
    const message = { account: account.address, timestamp: BigInt(timestamp) };
    const auth = await signAce(
      account,
      ACE_TYPES.balances.primaryType,
      ACE_TYPES.balances.types,
      message,
    );
    const res = await postAce("/balances", { account: account.address, timestamp, auth });
    const balances = Array.isArray(res.balances) ? res.balances : [];
    const hit = balances.find((b) => String(b.token || "").toLowerCase() === token.toLowerCase());
    return hit ? BigInt(String(hit.amount)) : 0n;
  };

  const waitForAceBalanceDelta = async ({ account, token, expectedMin, label }) => {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      const bal = await getAceBalanceForToken(account, token);
      if (bal >= expectedMin) return bal;
      await wait(5000);
    }
    throw new Error(`${label}: timeout waiting ACE balance >= ${expectedMin.toString()}`);
  };

  const ensureIdentity = async ({ label, address, identityAddress }) => {
    const [verified, onchainIdentity, onchainCountry] = await Promise.all([
      publicClient.readContract({
        address: identityRegistryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "isVerified",
        args: [address],
      }),
      publicClient.readContract({
        address: identityRegistryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "identity",
        args: [address],
      }),
      publicClient.readContract({
        address: identityRegistryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "investorCountry",
        args: [address],
      }),
    ]);

    const isOk =
      verified &&
      String(onchainIdentity).toLowerCase() === identityAddress.toLowerCase() &&
      Number(onchainCountry) === country;
    if (isOk) {
      console.log(`   ${label} identity already OK.`);
      return;
    }

    const tx = await sendOnchainAction({
      action: "SYNC_KYC",
      employeeAddress: address,
      verified: true,
      identityAddress,
      country,
    });
    console.log(`   ${label} KYC tx: ${tx}`);
  };

  console.log("╔═════════════════════════════════════════════════════════════════════╗");
  console.log("║  E2E: Lambda -> CRE/Receiver -> ACE ticket -> Employee redeem      ║");
  console.log("╚═════════════════════════════════════════════════════════════════════╝");
  console.log(`Admin:       ${admin.address}`);
  console.log(`Employee:    ${employee.address}`);
  console.log(`Token:       ${tokenAddress}`);
  console.log(`Vault:       ${vaultAddress}`);
  console.log(`PrivateEq:   ${privateEquityAddress}`);
  console.log(`Receiver:    ${receiverAddress}`);
  console.log(`Report path: ${useDirectReceiverReports ? "direct onReport" : "CRE simulate"}`);
  console.log(`Amount:      ${amountWei.toString()} wei`);

  console.log("\n1) Persist employee state in Lambda...");
  const companyRes = await postLambda({
    action: "CompanyEmployeeInput",
    employeeAddress: employee.address,
    identityAddress: employeeIdentityAddress,
    country,
    kycVerified: true,
    employed: true,
    walletFrozen: false,
  });
  console.log("   Lambda OK:", pretty(companyRes.message || companyRes));

  console.log("\n2) Write SYNC_KYC + SYNC_FREEZE_WALLET onchain...");
  const kycTxHash = await sendOnchainAction({
    action: "SYNC_KYC",
    employeeAddress: employee.address,
    verified: true,
    identityAddress: employeeIdentityAddress,
    country,
  });
  console.log(`   SYNC_KYC: ${kycTxHash}`);

  const freezeTxHash = await sendOnchainAction({
    action: "SYNC_FREEZE_WALLET",
    walletAddress: employee.address,
    frozen: false,
  });
  console.log(`   SYNC_FREEZE_WALLET: ${freezeTxHash}`);

  console.log("\n3) Verify employee onchain requirements...");
  const [isVerified, onchainIdentity, onchainCountry, isFrozen] = await Promise.all([
    publicClient.readContract({
      address: identityRegistryAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "isVerified",
      args: [employee.address],
    }),
    publicClient.readContract({
      address: identityRegistryAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "identity",
      args: [employee.address],
    }),
    publicClient.readContract({
      address: identityRegistryAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "investorCountry",
      args: [employee.address],
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName: "isFrozen",
      args: [employee.address],
    }),
  ]);

  const onchainKycOk =
    isVerified &&
    String(onchainIdentity).toLowerCase() === employeeIdentityAddress.toLowerCase() &&
    Number(onchainCountry) === country &&
    !isFrozen;

  if (!onchainKycOk) {
    const details = {
      isVerified,
      onchainIdentity: String(onchainIdentity),
      expectedIdentity: employeeIdentityAddress,
      onchainCountry: Number(onchainCountry),
      expectedCountry: country,
      isFrozen,
      strictOnchainKyc,
    };
    if (strictOnchainKyc) {
      throw new Error(`Onchain KYC requirements not met: ${pretty(details)}`);
    }
    console.log("   Warning: onchain KYC requirements not fully met.");
    console.log(`   Details: ${pretty(details)}`);
  } else {
    console.log("   Onchain requirements OK.");
  }

  if (simulateGoalCliff) {
    console.log("\n3b) Simulate vesting compliance (employment + goal + cliff)...");
    const nowSec = Math.floor(Date.now() / 1000);
    const cliffInFuture = nowSec + Math.max(1, cliffLeadSeconds);

    const reqFutureTx = await sendOnchainAction({
      action: "SYNC_SET_CLAIM_REQUIREMENTS",
      employeeAddress: employee.address,
      cliffEndTimestamp: cliffInFuture,
      goalId: vestingGoalId,
      goalRequired: true,
    });
    console.log(`   Requirements (future cliff) tx: ${reqFutureTx}`);

    const employmentTx = await sendOnchainAction({
      action: "SYNC_EMPLOYMENT_STATUS",
      employeeAddress: employee.address,
      employed: true,
    });
    console.log(`   Employment tx: ${employmentTx}`);

    const goalFalseTx = await sendOnchainAction({
      action: "SYNC_GOAL",
      goalId: vestingGoalId,
      achieved: false,
      employeeAddress: employee.address,
    });
    console.log(`   Goal=false tx: ${goalFalseTx}`);

    const eligibleBefore = await publicClient.readContract({
      address: privateEquityAddress,
      abi: PRIVATE_EQUITY_ABI,
      functionName: "isEmployeeEligible",
      args: [employee.address],
    });
    if (eligibleBefore) {
      throw new Error("Expected employee to be ineligible before goal+cliff completion");
    }
    console.log("   Eligibility before unlock: false (expected)");

    const goalTrueTx = await sendOnchainAction({
      action: "SYNC_GOAL",
      goalId: vestingGoalId,
      achieved: true,
      employeeAddress: employee.address,
    });
    console.log(`   Goal=true tx: ${goalTrueTx}`);

    const reqPastTx = await sendOnchainAction({
      action: "SYNC_SET_CLAIM_REQUIREMENTS",
      employeeAddress: employee.address,
      cliffEndTimestamp: Math.max(0, nowSec - 1),
      goalId: vestingGoalId,
      goalRequired: true,
    });
    console.log(`   Requirements (past cliff) tx: ${reqPastTx}`);

    const eligibleAfter = await publicClient.readContract({
      address: privateEquityAddress,
      abi: PRIVATE_EQUITY_ABI,
      functionName: "isEmployeeEligible",
      args: [employee.address],
    });
    if (!eligibleAfter) {
      throw new Error("Employee still ineligible after goal achievement and cliff unlock");
    }
    console.log("   Eligibility after unlock: true (expected)");
  }

  console.log("\n4) Ensure employee gas for redeem...");
  const employeeEth = await publicClient.getBalance({ address: employee.address });
  if (employeeEth < minEmployeeGasWei) {
    const topUp = minEmployeeGasWei - employeeEth;
    const topUpHash = await adminWalletClient.sendTransaction({
      account: admin,
      to: employee.address,
      value: topUp,
    });
    await waitReceipt(topUpHash);
    console.log(`   Employee topped up with ${formatEther(topUp)} ETH (${topUpHash}).`);
  } else {
    console.log(`   Employee gas OK (${formatEther(employeeEth)} ETH).`);
  }

  console.log("\n5) Ensure admin private ACE balance...");
  const adminPrivateBefore = await getAceBalanceForToken(admin, tokenAddress);
  console.log(`   Admin private balance before: ${adminPrivateBefore.toString()} wei`);

  if (adminPrivateBefore < amountWei) {
    const missingAmount = amountWei - adminPrivateBefore;
    let adminTokenBal = await publicClient.readContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      args: [admin.address],
    });

    if (adminTokenBal < missingAmount) {
      const mintAmount = missingAmount - adminTokenBal;
      console.log(`   Minting missing admin tokens via SYNC_MINT: ${mintAmount.toString()} wei...`);

      await ensureIdentity({
        label: "Admin",
        address: admin.address,
        identityAddress: adminIdentityAddress,
      });

      const mintTx = await sendOnchainAction({
        action: "SYNC_MINT",
        to: admin.address,
        amount: mintAmount.toString(),
      });
      console.log(`   SYNC_MINT tx: ${mintTx}`);

      adminTokenBal = await publicClient.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: "balanceOf",
        args: [admin.address],
      });
      if (adminTokenBal < missingAmount) {
        throw new Error(
          `Admin token balance still too low after mint. needed=${missingAmount.toString()} current=${adminTokenBal.toString()}`,
        );
      }
    }

    await ensureIdentity({
      label: "Admin",
      address: admin.address,
      identityAddress: adminIdentityAddress,
    });
    await ensureIdentity({
      label: "Vault",
      address: vaultAddress,
      identityAddress: vaultIdentityAddress,
    });

    await publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "checkDepositAllowed",
      args: [admin.address, tokenAddress, missingAmount],
    });

    const approveHash = await adminWalletClient.writeContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName: "approve",
      args: [vaultAddress, missingAmount],
    });
    await waitReceipt(approveHash);
    console.log(`   approve(): ${approveHash}`);

    const depositHash = await adminWalletClient.writeContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "deposit",
      args: [tokenAddress, missingAmount],
    });
    await waitReceipt(depositHash);
    console.log(`   deposit(): ${depositHash}`);

    const adminPrivateAfter = await waitForAceBalanceDelta({
      account: admin,
      token: tokenAddress,
      expectedMin: amountWei,
      label: "admin private balance top-up",
    });
    console.log(`   Admin private balance after: ${adminPrivateAfter.toString()} wei`);
  } else {
    console.log("   Existing private balance is sufficient.");
  }

  console.log("\n6) ACE private transfer admin -> employee...");
  const employeePrivateBefore = await getAceBalanceForToken(employee, tokenAddress);
  const transferTs = nextTs();
  const transferMsg = {
    sender: admin.address,
    recipient: employee.address,
    token: tokenAddress,
    amount: amountWei,
    flags: [],
    timestamp: BigInt(transferTs),
  };
  const transferAuth = await signAce(
    admin,
    ACE_TYPES.privateTransfer.primaryType,
    ACE_TYPES.privateTransfer.types,
    transferMsg,
  );
  const transferRes = await postAce("/private-transfer", {
    account: admin.address,
    recipient: employee.address,
    token: tokenAddress,
    amount: amountWei.toString(),
    flags: [],
    timestamp: transferTs,
    auth: transferAuth,
  });
  console.log(`   private-transfer id: ${transferRes.transaction_id || "n/a"}`);

  const employeePrivateAfter = await waitForAceBalanceDelta({
    account: employee,
    token: tokenAddress,
    expectedMin: employeePrivateBefore + amountWei,
    label: "employee private credit",
  });
  console.log(`   Employee private balance after: ${employeePrivateAfter.toString()} wei`);

  console.log("\n7) Employee withdraw ticket + redeem onchain...");
  await publicClient.readContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "checkWithdrawAllowed",
    args: [employee.address, tokenAddress, amountWei],
  });

  const withdrawTs = nextTs();
  const withdrawMsg = {
    account: employee.address,
    token: tokenAddress,
    amount: amountWei,
    timestamp: BigInt(withdrawTs),
  };
  const withdrawAuth = await signAce(
    employee,
    ACE_TYPES.withdraw.primaryType,
    ACE_TYPES.withdraw.types,
    withdrawMsg,
  );
  const withdrawRes = await postAce("/withdraw", {
    account: employee.address,
    token: tokenAddress,
    amount: amountWei.toString(),
    timestamp: withdrawTs,
    auth: withdrawAuth,
  });
  if (!withdrawRes.ticket) {
    throw new Error(`Missing ticket in /withdraw response: ${pretty(withdrawRes)}`);
  }
  console.log(`   Ticket deadline: ${withdrawRes.deadline}`);

  const employeeTokenBefore = await publicClient.readContract({
    address: tokenAddress,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [employee.address],
  });

  const redeemHash = await employeeWalletClient.writeContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "withdrawWithTicket",
    args: [tokenAddress, amountWei, withdrawRes.ticket],
  });
  await waitReceipt(redeemHash);
  console.log(`   withdrawWithTicket(): ${redeemHash}`);

  const employeeTokenAfter = await publicClient.readContract({
    address: tokenAddress,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [employee.address],
  });
  if (employeeTokenAfter < employeeTokenBefore + amountWei) {
    throw new Error(
      `Redeem balance check failed. before=${employeeTokenBefore.toString()} after=${employeeTokenAfter.toString()}`,
    );
  }

  console.log("\n╔═════════════════════════════════════════════════════════════════════╗");
  console.log("║  SUCCESS: Employee compliant + ACE ticket redeemed                 ║");
  console.log("╚═════════════════════════════════════════════════════════════════════╝");
};

run().catch((err) => {
  console.error(`\nE2E flow failed: ${err.message}`);
  process.exit(1);
});
