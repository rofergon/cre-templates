/**
 * run-private-rounds-market-flow.mjs
 *
 * E2E private rounds flow:
 *   - KYC + investor authorization
 *   - create/open round
 *   - buy with mock USDC
 *   - settle and refund paths
 *   - lockup + global resale restriction checks
 *
 * Required env:
 *   CRE_ETH_PRIVATE_KEY
 *   CRE_EMPLOYEE_ETH_PRIVATE_KEY
 *
 * Optional env:
 *   SEPOLIA_RPC_URL
 *   TOKEN_ADDRESS
 *   COMPLIANCE_V2_ADDRESS
 *   PRIVATE_ROUNDS_MARKET_ADDRESS
 *   USDC_ADDRESS
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workflowDir = resolve(__dirname, "..");
const projectRoot = resolve(workflowDir, "..");
const configPath = resolve(workflowDir, "config.staging.json");
const envPath = resolve(projectRoot, ".env");

const DEFAULT_RPC_URL = "https://sepolia.gateway.tenderly.co/3Gg3yWf8Ftc5qKVcpRZYuI";
const DEFAULT_COUNTRY = 840;
const DEFAULT_ADMIN_IDENTITY = "0x00000000000000000000000000000000000000a1";
const DEFAULT_BUYER_IDENTITY = "0x00000000000000000000000000000000000000e5";
const DEFAULT_UNAUTHORIZED_IDENTITY = "0x00000000000000000000000000000000000000b1";
const DEFAULT_ACE_REF = "0x0000000000000000000000000000000000000000000000000000000000000ace";
const DEFAULT_REFUND_REASON = "0x524546554e445f42595f4f5241434c4500000000000000000000000000000000";

const ACTION_TYPE = {
  SYNC_KYC: 0,
  SYNC_MINT: 7,
  SYNC_SET_INVESTOR_AUTH: 9,
  SYNC_SET_INVESTOR_LOCKUP: 10,
  SYNC_CREATE_ROUND: 11,
  SYNC_SET_ROUND_ALLOWLIST: 12,
  SYNC_OPEN_ROUND: 13,
  SYNC_MARK_PURCHASE_SETTLED: 15,
  SYNC_REFUND_PURCHASE: 16,
  SYNC_SET_TOKEN_COMPLIANCE: 17,
};

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

const TOKEN_ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
];

const USDC_ABI = [
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
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
];

const MARKET_ABI = [
  {
    type: "function",
    name: "buyRound",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "usdcAmount", type: "uint256" },
      { name: "aceRecipientCommitment", type: "bytes32" },
    ],
    outputs: [{ name: "purchaseId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "nextPurchaseId",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "purchases",
    inputs: [{ name: "purchaseId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "roundId", type: "uint256" },
          { name: "buyer", type: "address" },
          { name: "usdcAmount", type: "uint256" },
          { name: "aceRecipientCommitment", type: "bytes32" },
          { name: "createdAt", type: "uint64" },
          { name: "status", type: "uint8" },
          { name: "aceTransferRef", type: "bytes32" },
        ],
      },
    ],
    stateMutability: "view",
  },
];

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

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

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

const indentText = (text, indent = "      ") =>
  String(text || "")
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`)
    .join("\n");

const normalizePrivateKey = (value, label) => {
  if (!value) throw new Error(`Missing ${label}`);
  const trimmed = String(value).trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed}`;
  throw new Error(`${label} is not a valid 32-byte hex private key`);
};

const expectRevert = async (fn, label) => {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`Expected revert: ${label}`);
};

const run = async () => {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const envFromFile = parseEnvFile(envPath);
  const evmConfig = config.evms?.[0] || {};

  const adminPk = normalizePrivateKey(
    process.env.CRE_ETH_PRIVATE_KEY ?? envFromFile.CRE_ETH_PRIVATE_KEY,
    "CRE_ETH_PRIVATE_KEY",
  );
  const buyerPk = normalizePrivateKey(
    process.env.CRE_EMPLOYEE_ETH_PRIVATE_KEY ?? envFromFile.CRE_EMPLOYEE_ETH_PRIVATE_KEY,
    "CRE_EMPLOYEE_ETH_PRIVATE_KEY",
  );

  const admin = privateKeyToAccount(adminPk);
  const buyer = privateKeyToAccount(buyerPk);
  const unauthorizedRecipient = "0x00000000000000000000000000000000000000b2";

  const rpcUrl = process.env.SEPOLIA_RPC_URL || envFromFile.SEPOLIA_RPC_URL || DEFAULT_RPC_URL;
  const receiverAddress = evmConfig.receiverAddress;
  const tokenAddress = process.env.TOKEN_ADDRESS || envFromFile.TOKEN_ADDRESS || evmConfig.tokenAddress;
  const complianceAddress =
    process.env.COMPLIANCE_V2_ADDRESS ||
    envFromFile.COMPLIANCE_V2_ADDRESS ||
    process.env.COMPLIANCE_ADDRESS ||
    envFromFile.COMPLIANCE_ADDRESS ||
    evmConfig.complianceV2Address;
  const marketAddress =
    process.env.PRIVATE_ROUNDS_MARKET_ADDRESS ||
    envFromFile.PRIVATE_ROUNDS_MARKET_ADDRESS ||
    evmConfig.privateRoundsMarketAddress;
  const usdcAddress =
    process.env.USDC_ADDRESS ||
    envFromFile.USDC_ADDRESS ||
    evmConfig.usdcAddress;
  const treasuryAddress =
    process.env.PRIVATE_ROUNDS_TREASURY_ADDRESS ||
    envFromFile.PRIVATE_ROUNDS_TREASURY_ADDRESS ||
    evmConfig.treasuryAddress ||
    admin.address;
  const useDirectReceiverReports =
    String(
      process.env.USE_DIRECT_RECEIVER_REPORTS ??
        envFromFile.USE_DIRECT_RECEIVER_REPORTS ??
        "true",
    ).toLowerCase() === "true";
  const logCreOutput =
    String(process.env.LOG_CRE_OUTPUT ?? envFromFile.LOG_CRE_OUTPUT ?? "true").toLowerCase() === "true";

  if (!receiverAddress || !tokenAddress || !complianceAddress || !marketAddress || !usdcAddress) {
    throw new Error(
      "Missing receiver/token/compliance/market/usdc address. Run redeploy and update config/.env first.",
    );
  }

  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const adminWalletClient = createWalletClient({ account: admin, chain: sepolia, transport: http(rpcUrl) });
  const buyerWalletClient = createWalletClient({ account: buyer, chain: sepolia, transport: http(rpcUrl) });
  const childEnv = { ...process.env };
  childEnv.CRE_ETH_PRIVATE_KEY = adminPk;
  childEnv.CRE_TARGET = "local-simulation";

  const waitReceipt = async (hash) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
    return receipt;
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

    if (payload.action === "SYNC_SET_INVESTOR_AUTH") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("address investor, bool authorized"),
        [payload.investorAddress, payload.authorized],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_SET_INVESTOR_AUTH,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_SET_INVESTOR_LOCKUP") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("address investor, uint64 lockupUntil"),
        [payload.investorAddress, BigInt(payload.lockupUntil)],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_SET_INVESTOR_LOCKUP,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_CREATE_ROUND") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("uint256 roundId, uint64 startTime, uint64 endTime, uint256 tokenPriceUsdc6, uint256 maxUsdc"),
        [BigInt(payload.roundId), BigInt(payload.startTime), BigInt(payload.endTime), BigInt(payload.tokenPriceUsdc6), BigInt(payload.maxUsdc)],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_CREATE_ROUND,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_SET_ROUND_ALLOWLIST") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("uint256 roundId, address investor, uint256 capUsdc"),
        [BigInt(payload.roundId), payload.investorAddress, BigInt(payload.capUsdc)],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_SET_ROUND_ALLOWLIST,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_OPEN_ROUND") {
      const encodedPayload = encodeAbiParameters(parseAbiParameters("uint256 roundId"), [BigInt(payload.roundId)]);
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_OPEN_ROUND,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_MARK_PURCHASE_SETTLED") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("uint256 purchaseId, bytes32 aceTransferRef"),
        [BigInt(payload.purchaseId), payload.aceTransferRef],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_MARK_PURCHASE_SETTLED,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_REFUND_PURCHASE") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("uint256 purchaseId, bytes32 reason"),
        [BigInt(payload.purchaseId), payload.reason],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_REFUND_PURCHASE,
        encodedPayload,
      ]);
    }

    if (payload.action === "SYNC_SET_TOKEN_COMPLIANCE") {
      const encodedPayload = encodeAbiParameters(
        parseAbiParameters("address complianceAddress"),
        [payload.complianceAddress],
      );
      return encodeAbiParameters(parseAbiParameters("uint8 actionType, bytes payload"), [
        ACTION_TYPE.SYNC_SET_TOKEN_COMPLIANCE,
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

    throw new Error(`Unsupported action: ${payload.action}`);
  };

  const runCre = async (payload) => {
    const payloadJson = JSON.stringify(payload, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
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
      payloadJson,
      "--broadcast",
    ];

    let lastOutput = "";
    for (let attempt = 1; attempt <= 4; attempt++) {
      const out = spawnSync("cre", args, { cwd: projectRoot, encoding: "utf-8", env: childEnv });
      const merged = `${out.stdout || ""}\n${out.stderr || ""}`;
      lastOutput = merged;
      if (logCreOutput) {
        console.log(`   [CRE CLI attempt ${attempt}] payload: ${payload.action}`);
        console.log(indentText(merged.trim() || "(no output)"));
      }
      if (out.status === 0) return extractTxHash(merged);
      if (attempt < 4 && isTransientTxError(merged)) {
        await wait(15000);
        continue;
      }
      throw new Error(`CRE command failed:\n${merged}`);
    }
    throw new Error(`CRE command failed after retries:\n${lastOutput}`);
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

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  E2E: Private Rounds Market (USDC + ComplianceV2 + Receiver)      ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`Admin:       ${admin.address}`);
  console.log(`Buyer:       ${buyer.address}`);
  console.log(`Token:       ${tokenAddress}`);
  console.log(`Compliance:  ${complianceAddress}`);
  console.log(`Market:      ${marketAddress}`);
  console.log(`USDC:        ${usdcAddress}`);
  console.log(`Treasury:    ${treasuryAddress}`);
  console.log(`Report path: ${useDirectReceiverReports ? "direct onReport" : "CRE simulate"}`);

  console.log("\n1) Ensure compliance + KYC baseline...");
  await sendOnchainAction({
    action: "SYNC_SET_TOKEN_COMPLIANCE",
    complianceAddress,
  });
  await sendOnchainAction({
    action: "SYNC_KYC",
    employeeAddress: admin.address,
    verified: true,
    identityAddress: DEFAULT_ADMIN_IDENTITY,
    country: DEFAULT_COUNTRY,
  });
  await sendOnchainAction({
    action: "SYNC_KYC",
    employeeAddress: buyer.address,
    verified: true,
    identityAddress: DEFAULT_BUYER_IDENTITY,
    country: DEFAULT_COUNTRY,
  });
  await sendOnchainAction({
    action: "SYNC_KYC",
    employeeAddress: unauthorizedRecipient,
    verified: true,
    identityAddress: DEFAULT_UNAUTHORIZED_IDENTITY,
    country: DEFAULT_COUNTRY,
  });
  await sendOnchainAction({
    action: "SYNC_SET_INVESTOR_AUTH",
    investorAddress: admin.address,
    authorized: true,
  });
  await sendOnchainAction({
    action: "SYNC_SET_INVESTOR_AUTH",
    investorAddress: buyer.address,
    authorized: false,
  });
  await sendOnchainAction({
    action: "SYNC_SET_INVESTOR_AUTH",
    investorAddress: unauthorizedRecipient,
    authorized: false,
  });
  console.log("   Baseline synced.");

  console.log("\n2) Create/open round and configure allowlist...");
  const now = Math.floor(Date.now() / 1000);
  const roundId = BigInt(now);
  await sendOnchainAction({
    action: "SYNC_CREATE_ROUND",
    roundId,
    startTime: now - 60,
    endTime: now + 3600,
    tokenPriceUsdc6: 1_000_000n,
    maxUsdc: 5_000_000n,
  });
  await sendOnchainAction({
    action: "SYNC_SET_ROUND_ALLOWLIST",
    roundId,
    investorAddress: buyer.address,
    capUsdc: 2_000_000n,
  });
  await sendOnchainAction({
    action: "SYNC_OPEN_ROUND",
    roundId,
  });
  console.log(`   Round ${roundId.toString()} opened.`);

  console.log("\n3) Unauthorized buy should fail...");
  const buyAmount = 1_000_000n; // 1 USDC (6d)
  const unauthorizedBuyBefore = await publicClient.readContract({
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "nextPurchaseId",
  });
  await adminWalletClient.writeContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: "mint",
    args: [buyer.address, 10_000_000n],
  }).then(waitReceipt);
  await buyerWalletClient.writeContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: "approve",
    args: [marketAddress, 10_000_000n],
  }).then(waitReceipt);
  await expectRevert(
    () =>
      buyerWalletClient
        .writeContract({
          address: marketAddress,
          abi: MARKET_ABI,
          functionName: "buyRound",
          args: [roundId, buyAmount, DEFAULT_ACE_REF],
        })
        .then(waitReceipt),
    "buy without investor authorization",
  );
  const unauthorizedBuyAfter = await publicClient.readContract({
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "nextPurchaseId",
  });
  if (unauthorizedBuyAfter !== unauthorizedBuyBefore) {
    throw new Error("Unauthorized buy unexpectedly changed purchase counter");
  }
  console.log("   Unauthorized buy correctly reverted.");

  console.log("\n4) Authorize buyer and execute successful buy + settlement...");
  await sendOnchainAction({
    action: "SYNC_SET_INVESTOR_AUTH",
    investorAddress: buyer.address,
    authorized: true,
  });
  const treasuryBefore = await publicClient.readContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [treasuryAddress],
  });
  const purchaseId = await publicClient.readContract({
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "nextPurchaseId",
  });
  const buyTx = await buyerWalletClient.writeContract({
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "buyRound",
    args: [roundId, buyAmount, DEFAULT_ACE_REF],
  });
  await waitReceipt(buyTx);
  console.log(`   buyRound tx: ${buyTx}`);

  await sendOnchainAction({
    action: "SYNC_MARK_PURCHASE_SETTLED",
    purchaseId,
    aceTransferRef: DEFAULT_ACE_REF,
  });
  const purchaseAfterSettle = await publicClient.readContract({
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "purchases",
    args: [purchaseId],
  });
  if (Number(purchaseAfterSettle.status) !== 2) {
    throw new Error(`Expected SETTLED status=2, got ${purchaseAfterSettle.status}`);
  }
  const treasuryAfter = await publicClient.readContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [treasuryAddress],
  });
  if (treasuryAfter - treasuryBefore !== buyAmount) {
    throw new Error(`Treasury settlement mismatch. expected=${buyAmount} got=${treasuryAfter - treasuryBefore}`);
  }
  console.log(`   Purchase ${purchaseId.toString()} settled.`);

  console.log("\n5) Cap exceeded should fail...");
  await expectRevert(
    () =>
      buyerWalletClient
        .writeContract({
          address: marketAddress,
          abi: MARKET_ABI,
          functionName: "buyRound",
          args: [roundId, 1_500_001n, DEFAULT_ACE_REF],
        })
        .then(waitReceipt),
    "investor cap exceeded",
  );
  console.log("   Cap enforcement works.");

  console.log("\n6) Refund path via oracle...");
  const roundId2 = roundId + 1n;
  await sendOnchainAction({
    action: "SYNC_CREATE_ROUND",
    roundId: roundId2,
    startTime: now - 60,
    endTime: now + 3600,
    tokenPriceUsdc6: 1_000_000n,
    maxUsdc: 5_000_000n,
  });
  await sendOnchainAction({
    action: "SYNC_SET_ROUND_ALLOWLIST",
    roundId: roundId2,
    investorAddress: buyer.address,
    capUsdc: 2_000_000n,
  });
  await sendOnchainAction({
    action: "SYNC_OPEN_ROUND",
    roundId: roundId2,
  });
  const refundPurchaseId = await publicClient.readContract({
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "nextPurchaseId",
  });
  await buyerWalletClient.writeContract({
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "buyRound",
    args: [roundId2, 1_000_000n, DEFAULT_ACE_REF],
  }).then(waitReceipt);
  await sendOnchainAction({
    action: "SYNC_REFUND_PURCHASE",
    purchaseId: refundPurchaseId,
    reason: DEFAULT_REFUND_REASON,
  });
  const purchaseAfterRefund = await publicClient.readContract({
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "purchases",
    args: [refundPurchaseId],
  });
  if (Number(purchaseAfterRefund.status) !== 3) {
    throw new Error(`Expected REFUNDED status=3, got ${purchaseAfterRefund.status}`);
  }
  console.log(`   Purchase ${refundPurchaseId.toString()} refunded.`);

  console.log("\n7) Global resale restrictions (lockup + unauthorized recipient)...");
  await sendOnchainAction({
    action: "SYNC_MINT",
    to: buyer.address,
    amount: 1_000_000_000_000_000_000n,
  });
  await sendOnchainAction({
    action: "SYNC_SET_INVESTOR_LOCKUP",
    investorAddress: buyer.address,
    lockupUntil: now + 3600,
  });
  await expectRevert(
    () =>
      buyerWalletClient
        .writeContract({
          address: tokenAddress,
          abi: TOKEN_ABI,
          functionName: "transfer",
          args: [admin.address, 1n],
        })
        .then(waitReceipt),
    "transfer with active lockup",
  );

  await sendOnchainAction({
    action: "SYNC_SET_INVESTOR_LOCKUP",
    investorAddress: buyer.address,
    lockupUntil: 0,
  });
  await buyerWalletClient.writeContract({
    address: tokenAddress,
    abi: TOKEN_ABI,
    functionName: "transfer",
    args: [admin.address, 1n],
  }).then(waitReceipt);

  await expectRevert(
    () =>
      adminWalletClient
        .writeContract({
          address: tokenAddress,
          abi: TOKEN_ABI,
          functionName: "transfer",
          args: [unauthorizedRecipient, 1n],
        })
        .then(waitReceipt),
    "transfer to unauthorized investor",
  );
  console.log("   Global resale restrictions enforced.");

  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  SUCCESS: Private rounds market + global compliance validated      ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
};

run().catch((err) => {
  console.error("\nPrivate rounds flow failed:", err?.message || err);
  process.exitCode = 1;
});
