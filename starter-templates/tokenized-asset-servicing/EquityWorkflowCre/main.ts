import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  getNetwork,
  type ConfidentialHTTPSendRequester,
  type EVMLog,
  type HTTPPayload,
  type HTTPSendRequester,
  hexToBase64,
  json as jsonBody,
  ok,
  Runner,
  text as textBody,
  type Runtime,
  TxStatus,
} from "@chainlink/cre-sdk";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { z } from "zod";

const privacyConfigSchema = z
  .object({
    enableConfidentialAce: z.boolean().optional(),
    encryptOutputAce: z.boolean().optional(),
    redactLogs: z.boolean().optional(),
    vaultDonSecrets: z
      .array(
        z.object({
          key: z.string().min(1),
          owner: z.string().optional(),
          namespace: z.string().optional(),
        }),
      )
      .optional(),
  })
  .optional();

const configSchema = z.object({
  url: z.string().optional(),
  evms: z
    .array(
      z.object({
        receiverAddress: z.string(),
        identityRegistryAddress: z.string(),
        acePrivacyManagerAddress: z.string(),
        complianceV2Address: z.string().optional(),
        privateRoundsMarketAddress: z.string().optional(),
        usdcAddress: z.string().optional(),
        treasuryAddress: z.string().optional(),
        aceVaultAddress: z.string(),
        aceChainId: z.coerce.number().int().positive().optional(),
        chainSelectorName: z.string(),
        gasLimit: z.string(),
      }),
    )
    .min(1),
  aceApiUrl: z.string().optional(),
  privacy: privacyConfigSchema,
});

type Config = z.infer<typeof configSchema>;

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const timestampSchema = z.coerce.number().int().positive();
const uint256Schema = z.coerce.bigint().min(0n);

const syncKycSchema = z.object({
  action: z.literal("SYNC_KYC"),
  employeeAddress: addressSchema,
  verified: z.boolean(),
  identityAddress: addressSchema.optional(),
  country: z.coerce.number().int().min(0).max(65535).optional(),
});

const syncFreezeWalletSchema = z.object({
  action: z.literal("SYNC_FREEZE_WALLET"),
  walletAddress: addressSchema,
  frozen: z.boolean(),
});

const syncEmploymentStatusSchema = z.object({
  action: z.literal("SYNC_EMPLOYMENT_STATUS"),
  employeeAddress: addressSchema,
  employed: z.boolean(),
});

const syncGoalSchema = z.object({
  action: z.literal("SYNC_GOAL"),
  goalId: bytes32Schema,
  achieved: z.boolean(),
  employeeAddress: addressSchema.optional(),
});

const syncSetClaimRequirementsSchema = z.object({
  action: z.literal("SYNC_SET_CLAIM_REQUIREMENTS"),
  employeeAddress: addressSchema,
  cliffEndTimestamp: z.coerce.number().int().min(0).max(2 ** 32 - 1),
  goalId: bytes32Schema.optional(),
  goalRequired: z.boolean().optional(),
});

const syncPrivateDepositSchema = z.object({
  action: z.literal("SYNC_PRIVATE_DEPOSIT"),
  amount: z.coerce.bigint().positive(),
});

const syncMintSchema = z.object({
  action: z.literal("SYNC_MINT"),
  to: addressSchema,
  amount: z.coerce.bigint().positive(),
});

const syncRedeemTicketSchema = z.object({
  action: z.literal("SYNC_REDEEM_TICKET"),
  amount: z.coerce.bigint().positive(),
  ticket: z.string(),
});

const syncSetInvestorAuthSchema = z.object({
  action: z.literal("SYNC_SET_INVESTOR_AUTH"),
  investorAddress: addressSchema,
  authorized: z.boolean(),
});

const syncSetInvestorLockupSchema = z.object({
  action: z.literal("SYNC_SET_INVESTOR_LOCKUP"),
  investorAddress: addressSchema,
  lockupUntil: z.coerce.number().int().min(0).max(2 ** 32 - 1),
});

const syncCreateRoundSchema = z.object({
  action: z.literal("SYNC_CREATE_ROUND"),
  roundId: uint256Schema,
  startTime: z.coerce.number().int().min(0).max(2 ** 32 - 1),
  endTime: z.coerce.number().int().min(0).max(2 ** 32 - 1),
  tokenPriceUsdc6: uint256Schema,
  maxUsdc: uint256Schema,
});

const syncSetRoundAllowlistSchema = z.object({
  action: z.literal("SYNC_SET_ROUND_ALLOWLIST"),
  roundId: uint256Schema,
  investorAddress: addressSchema,
  capUsdc: uint256Schema,
});

const syncOpenRoundSchema = z.object({
  action: z.literal("SYNC_OPEN_ROUND"),
  roundId: uint256Schema,
});

const syncCloseRoundSchema = z.object({
  action: z.literal("SYNC_CLOSE_ROUND"),
  roundId: uint256Schema,
});

const syncMarkPurchaseSettledSchema = z.object({
  action: z.literal("SYNC_MARK_PURCHASE_SETTLED"),
  purchaseId: uint256Schema,
  aceTransferRef: bytes32Schema,
});

const syncRefundPurchaseSchema = z.object({
  action: z.literal("SYNC_REFUND_PURCHASE"),
  purchaseId: uint256Schema,
  reason: bytes32Schema.optional(),
});

const syncSetTokenComplianceSchema = z.object({
  action: z.literal("SYNC_SET_TOKEN_COMPLIANCE"),
  complianceAddress: addressSchema,
});

const aceGenerateShieldedAddressSchema = z.object({
  action: z.literal("ACE_GENERATE_SHIELDED_ADDRESS"),
  account: addressSchema.optional(),
  timestamp: timestampSchema,
});

const acePrivateTransferSchema = z.object({
  action: z.literal("ACE_PRIVATE_TRANSFER"),
  account: addressSchema.optional(),
  recipient: addressSchema,
  token: addressSchema,
  amount: z.coerce.bigint().positive(),
  flags: z.array(z.string()).optional(),
  timestamp: timestampSchema,
});

const aceWithdrawTicketSchema = z.object({
  action: z.literal("ACE_WITHDRAW_TICKET"),
  account: addressSchema.optional(),
  token: addressSchema,
  amount: z.coerce.bigint().positive(),
  timestamp: timestampSchema,
});

const onchainBaseSyncInputSchema = z.discriminatedUnion("action", [
  syncKycSchema,
  syncEmploymentStatusSchema,
  syncGoalSchema,
  syncFreezeWalletSchema,
  syncSetClaimRequirementsSchema,
  syncPrivateDepositSchema,
  syncMintSchema,
  syncRedeemTicketSchema,
  syncSetInvestorAuthSchema,
  syncSetInvestorLockupSchema,
  syncCreateRoundSchema,
  syncSetRoundAllowlistSchema,
  syncOpenRoundSchema,
  syncCloseRoundSchema,
  syncMarkPurchaseSettledSchema,
  syncRefundPurchaseSchema,
  syncSetTokenComplianceSchema,
]);

const syncBatchSchema = z.object({
  action: z.literal("SYNC_BATCH"),
  batches: z.array(onchainBaseSyncInputSchema),
});

const onchainSyncInputSchema = z.discriminatedUnion("action", [
  syncKycSchema,
  syncEmploymentStatusSchema,
  syncGoalSchema,
  syncFreezeWalletSchema,
  syncSetClaimRequirementsSchema,
  syncPrivateDepositSchema,
  syncMintSchema,
  syncRedeemTicketSchema,
  syncSetInvestorAuthSchema,
  syncSetInvestorLockupSchema,
  syncCreateRoundSchema,
  syncSetRoundAllowlistSchema,
  syncOpenRoundSchema,
  syncCloseRoundSchema,
  syncMarkPurchaseSettledSchema,
  syncRefundPurchaseSchema,
  syncSetTokenComplianceSchema,
  syncBatchSchema,
]);

const aceSyncInputSchema = z.discriminatedUnion("action", [
  aceGenerateShieldedAddressSchema,
  acePrivateTransferSchema,
  aceWithdrawTicketSchema,
]);

const syncInputSchema = z.union([onchainSyncInputSchema, aceSyncInputSchema]);

type SyncInput = z.infer<typeof syncInputSchema>;
type OnchainSyncInput = z.infer<typeof onchainSyncInputSchema>;
type AceSyncInput = z.infer<typeof aceSyncInputSchema>;

type PostResponse = {
  statusCode: number;
};

type PostResponseWithBody = {
  statusCode: number;
  body: string;
};

type SensitivityCategory = "CREDENTIAL" | "IDENTIFIER" | "FINANCIAL" | "PUBLIC_ONCHAIN";
type ExternalPayloadTarget = "ACE_CONFIDENTIAL" | "ACE_HTTP" | "LAMBDA";

type ResolvedPrivacyConfig = {
  enableConfidentialAce: boolean;
  encryptOutputAce: boolean;
  redactLogs: boolean;
  vaultDonSecrets: Array<{
    key: string;
    owner?: string;
    namespace?: string;
  }>;
};

type ConfidentialPostOptions = {
  vaultDonSecrets: ResolvedPrivacyConfig["vaultDonSecrets"];
  encryptOutput: boolean;
};

const ACTION_TYPE = {
  SYNC_KYC: 0,
  SYNC_EMPLOYMENT_STATUS: 1,
  SYNC_GOAL: 2,
  SYNC_FREEZE_WALLET: 3,
  SYNC_PRIVATE_DEPOSIT: 4,
  SYNC_BATCH: 5,
  SYNC_REDEEM_TICKET: 6,
  SYNC_MINT: 7,
  SYNC_SET_CLAIM_REQUIREMENTS: 8,
  SYNC_SET_INVESTOR_AUTH: 9,
  SYNC_SET_INVESTOR_LOCKUP: 10,
  SYNC_CREATE_ROUND: 11,
  SYNC_SET_ROUND_ALLOWLIST: 12,
  SYNC_OPEN_ROUND: 13,
  SYNC_CLOSE_ROUND: 14,
  SYNC_MARK_PURCHASE_SETTLED: 15,
  SYNC_REFUND_PURCHASE: 16,
  SYNC_SET_TOKEN_COMPLIANCE: 17,
} as const;

const DEFAULT_ACE_API_URL = "https://convergence2026-token-api.cldev.cloud";
const DEFAULT_ACE_CHAIN_ID = 11155111;
const ACE_EIP712_DOMAIN_NAME = "CompliantPrivateTokenDemo";
const ACE_EIP712_DOMAIN_VERSION = "0.0.1";
const ACE_SIGNER_SECRET_IDS = [
  "ACE_API_SIGNER_PRIVATE_KEY",
  "ACE_API_PRIVATE_KEY",
  "PRIVATE_KEY",
] as const;
const DEFAULT_PRIVACY_CONFIG: ResolvedPrivacyConfig = {
  enableConfidentialAce: true,
  encryptOutputAce: true,
  redactLogs: true,
  vaultDonSecrets: [],
};

const SENSITIVITY_BY_FIELD: Record<string, SensitivityCategory> = {
  action: "PUBLIC_ONCHAIN",
  verified: "PUBLIC_ONCHAIN",
  employed: "PUBLIC_ONCHAIN",
  frozen: "PUBLIC_ONCHAIN",
  achieved: "PUBLIC_ONCHAIN",
  goalRequired: "PUBLIC_ONCHAIN",
  authorized: "PUBLIC_ONCHAIN",
  country: "PUBLIC_ONCHAIN",
  timestamp: "PUBLIC_ONCHAIN",
  startTime: "PUBLIC_ONCHAIN",
  endTime: "PUBLIC_ONCHAIN",
  roundId: "PUBLIC_ONCHAIN",
  purchaseId: "PUBLIC_ONCHAIN",
  goalId: "PUBLIC_ONCHAIN",
  reason: "PUBLIC_ONCHAIN",
  lockupUntil: "PUBLIC_ONCHAIN",
  cliffEndTimestamp: "PUBLIC_ONCHAIN",
  flags: "PUBLIC_ONCHAIN",
  aceTransferRef: "PUBLIC_ONCHAIN",
  account: "IDENTIFIER",
  employeeAddress: "IDENTIFIER",
  identityAddress: "IDENTIFIER",
  walletAddress: "IDENTIFIER",
  to: "IDENTIFIER",
  investorAddress: "IDENTIFIER",
  recipient: "IDENTIFIER",
  sender: "IDENTIFIER",
  buyer: "IDENTIFIER",
  treasury: "IDENTIFIER",
  token: "IDENTIFIER",
  complianceAddress: "IDENTIFIER",
  aceRecipientCommitment: "IDENTIFIER",
  amount: "FINANCIAL",
  usdcAmount: "FINANCIAL",
  capUsdc: "FINANCIAL",
  maxUsdc: "FINANCIAL",
  tokenPriceUsdc6: "FINANCIAL",
  auth: "CREDENTIAL",
  ticket: "CREDENTIAL",
};

const BLOCKED_PLAINTEXT_HTTP_KEYS = new Set([
  "auth",
  "ticket",
  "privateKey",
  "private_key",
  "secret",
  "apiKey",
  "api_key",
  "authorization",
]);

const EIP712_TYPES = {
  "Generate Shielded Address": [
    { name: "account", type: "address" },
    { name: "timestamp", type: "uint256" },
  ],
  "Private Token Transfer": [
    { name: "sender", type: "address" },
    { name: "recipient", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "flags", type: "string[]" },
    { name: "timestamp", type: "uint256" },
  ],
  "Withdraw Tokens": [
    { name: "account", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "timestamp", type: "uint256" },
  ],
} as const;

const safeJsonStringify = (obj: unknown): string =>
  JSON.stringify(
    obj,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );

const resolvePrivacyConfig = (runtime: Runtime<Config>): ResolvedPrivacyConfig => {
  const privacy = runtime.config.privacy;
  return {
    enableConfidentialAce: privacy?.enableConfidentialAce ?? DEFAULT_PRIVACY_CONFIG.enableConfidentialAce,
    encryptOutputAce: privacy?.encryptOutputAce ?? DEFAULT_PRIVACY_CONFIG.encryptOutputAce,
    redactLogs: privacy?.redactLogs ?? DEFAULT_PRIVACY_CONFIG.redactLogs,
    vaultDonSecrets: privacy?.vaultDonSecrets ?? DEFAULT_PRIVACY_CONFIG.vaultDonSecrets,
  };
};

const sensitivityForField = (field: string): SensitivityCategory =>
  SENSITIVITY_BY_FIELD[field] ?? "PUBLIC_ONCHAIN";

const isAddressLike = (value: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(value);

const redactAddress = (value: string): string => `${value.slice(0, 6)}...${value.slice(-4)}`;

const redactForLog = (value: unknown, fieldName?: string): unknown => {
  if (fieldName) {
    const category = sensitivityForField(fieldName);
    if (category !== "PUBLIC_ONCHAIN") {
      return `[REDACTED_${category}]`;
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactForLog(entry, fieldName));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactForLog(entry, key),
      ]),
    );
  }

  if (typeof value === "string" && isAddressLike(value)) {
    return redactAddress(value);
  }

  return value;
};

const formatForLog = (runtime: Runtime<Config>, value: unknown): string => {
  const privacy = resolvePrivacyConfig(runtime);
  return privacy.redactLogs ? safeJsonStringify(redactForLog(value)) : safeJsonStringify(value);
};

const assertExternalPayloadPolicy = (
  target: ExternalPayloadTarget,
  payload: Record<string, unknown>,
): void => {
  const payloadKeys = Object.keys(payload);

  if (target === "ACE_CONFIDENTIAL") {
    return;
  }

  const blockedKeys = payloadKeys.filter((field) => BLOCKED_PLAINTEXT_HTTP_KEYS.has(field));
  if (blockedKeys.length > 0) {
    throw new Error(
      `${target} payload includes blocked sensitive fields for plaintext HTTP transport: ${blockedKeys.join(", ")}`,
    );
  }

  if (target === "ACE_HTTP") {
    const sensitiveKeys = payloadKeys.filter((field) => sensitivityForField(field) !== "PUBLIC_ONCHAIN");
    if (sensitiveKeys.length > 0) {
      throw new Error(
        `ACE payload includes sensitive fields that require confidential transport: ${sensitiveKeys.join(", ")}`,
      );
    }
  }
};

const logHttpResult = (
  runtime: Runtime<Config>,
  label: string,
  response: PostResponseWithBody,
): void => {
  const privacy = resolvePrivacyConfig(runtime);
  if (privacy.redactLogs) {
    runtime.log(`${label} status=${response.statusCode} body=<redacted>`);
    return;
  }
  runtime.log(`${label} response: ${response.body}`);
};

const eventAbi = parseAbi([
  "event IdentityRegistered(address indexed userAddress, address indexed identity, uint16 country)",
  "event IdentityRemoved(address indexed userAddress, address indexed identity)",
  "event CountryUpdated(address indexed userAddress, uint16 country)",
  "event EmploymentStatusUpdated(address indexed employee, bool employed)",
  "event GoalUpdated(bytes32 indexed goalId, bool achieved)",
  "event PrivateDeposit(uint256 amount)",
  "event TicketRedeemed(address indexed redeemer, uint256 amount)",
  "event InvestorAuthorizationUpdated(address indexed investor, bool authorized)",
  "event InvestorLockupUpdated(address indexed investor, uint64 lockupUntil)",
  "event RoundCreated(uint256 indexed roundId, uint64 startTime, uint64 endTime, uint256 tokenPriceUsdc6, uint256 maxUsdc)",
  "event RoundOpened(uint256 indexed roundId)",
  "event RoundClosed(uint256 indexed roundId)",
  "event PurchaseRequested(uint256 indexed purchaseId, uint256 indexed roundId, address indexed buyer, uint256 usdcAmount, bytes32 aceRecipientCommitment)",
  "event PurchaseSettled(uint256 indexed purchaseId, bytes32 indexed aceTransferRef, uint256 usdcAmount, address treasury)",
  "event PurchaseRefunded(uint256 indexed purchaseId, address indexed buyer, uint256 usdcAmount, bytes32 reason)",
]);

const normalizePrivateKey = (privateKey: string): `0x${string}` => {
  const trimmed = privateKey.trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed as `0x${string}`;
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return `0x${trimmed}` as `0x${string}`;
  throw new Error("ACE signer private key is not a valid 32-byte hex key");
};

const resolveAceApiBaseUrl = (runtime: Runtime<Config>): string => {
  const url = runtime.config.aceApiUrl ?? DEFAULT_ACE_API_URL;
  return url.endsWith("/") ? url.slice(0, -1) : url;
};

const resolveAceDomain = (runtime: Runtime<Config>) => {
  const evmConfig = runtime.config.evms[0];
  return {
    name: ACE_EIP712_DOMAIN_NAME,
    version: ACE_EIP712_DOMAIN_VERSION,
    chainId: evmConfig.aceChainId ?? DEFAULT_ACE_CHAIN_ID,
    verifyingContract: getAddress(evmConfig.aceVaultAddress),
  } as const;
};

const resolveAceSignerAccount = (
  runtime: Runtime<Config>,
  requestedAccount?: string,
) => {
  let normalizedPrivateKey: `0x${string}` | null = null;
  for (const secretId of ACE_SIGNER_SECRET_IDS) {
    try {
      const secret = runtime.getSecret({ id: secretId }).result().value;
      if (secret && secret.trim().length > 0) {
        normalizedPrivateKey = normalizePrivateKey(secret);
        break;
      }
    } catch {
      // Continue looking for the next secret ID
    }
  }

  if (!normalizedPrivateKey) {
    throw new Error(
      `ACE signer private key not found. Configure one of these secrets: ${ACE_SIGNER_SECRET_IDS.join(", ")}`,
    );
  }

  const signer = privateKeyToAccount(normalizedPrivateKey);
  if (requestedAccount) {
    const expectedAccount = getAddress(requestedAccount);
    const signerAccount = getAddress(signer.address);
    if (expectedAccount !== signerAccount) {
      throw new Error(
        `Requested ACE account ${expectedAccount} does not match signer account ${signerAccount}`,
      );
    }
  }
  return signer;
};

const postDataWithBody = (
  sendRequester: HTTPSendRequester,
  url: string,
  payload: Record<string, unknown>,
): PostResponseWithBody => {
  const bodyBytes = new TextEncoder().encode(JSON.stringify(payload));
  const body = Buffer.from(bodyBytes).toString("base64");
  const req = {
    url,
    method: "POST" as const,
    body,
    headers: {
      "Content-Type": "application/json",
    },
  };

  const resp = sendRequester.sendRequest(req).result();
  const responseBody = (() => {
    try {
      return safeJsonStringify(jsonBody(resp));
    } catch {
      return textBody(resp);
    }
  })();

  if (!ok(resp)) {
    throw new Error(`HTTP request to ${url} failed with status ${resp.statusCode}: ${responseBody}`);
  }

  return { statusCode: resp.statusCode, body: responseBody };
};

const postConfidentialDataWithBody = (
  sendRequester: ConfidentialHTTPSendRequester,
  url: string,
  payload: Record<string, unknown>,
  options: ConfidentialPostOptions,
): PostResponseWithBody => {
  const req = {
    vaultDonSecrets: options.vaultDonSecrets,
    encryptOutput: options.encryptOutput,
    request: {
      url,
      method: "POST",
      bodyString: JSON.stringify(payload),
      multiHeaders: {
        "Content-Type": {
          values: ["application/json"],
        },
      },
    },
  };

  const resp = sendRequester.sendRequest(req).result();
  const responseBody = (() => {
    try {
      return safeJsonStringify(jsonBody(resp));
    } catch {
      return textBody(resp);
    }
  })();

  if (!ok(resp)) {
    throw new Error(
      `Confidential HTTP request to ${url} failed with status ${resp.statusCode}: ${responseBody}`,
    );
  }

  return { statusCode: resp.statusCode, body: responseBody };
};

const postData = (
  sendRequester: HTTPSendRequester,
  lambdaUrl: string,
  lambdaPayload: Record<string, string | number | boolean>,
): PostResponse => {
  const resp = postDataWithBody(sendRequester, lambdaUrl, lambdaPayload);
  return { statusCode: resp.statusCode };
};

const isAceSyncInput = (input: SyncInput): input is AceSyncInput =>
  input.action.startsWith("ACE_");

const encodeActionReport = (instruction: { actionType: number; payload: `0x${string}` }): `0x${string}` =>
  encodeAbiParameters(
    parseAbiParameters("uint8 actionType, bytes payload"),
    [instruction.actionType, instruction.payload],
  );

const buildInstruction = (input: OnchainSyncInput): { actionType: number; payload: `0x${string}` } => {
  switch (input.action) {
    case "SYNC_KYC": {
      if (input.verified && !input.identityAddress) {
        throw new Error("SYNC_KYC requires identityAddress when verified=true");
      }

      const employee = getAddress(input.employeeAddress);
      const identity = getAddress(input.identityAddress ?? input.employeeAddress);
      const country = input.country ?? 0;

      const payload = encodeAbiParameters(
        parseAbiParameters("address employee, bool verified, address identity, uint16 country"),
        [employee, input.verified, identity, country],
      );

      return { actionType: ACTION_TYPE.SYNC_KYC, payload };
    }
    case "SYNC_FREEZE_WALLET": {
      const payload = encodeAbiParameters(
        parseAbiParameters("address walletAddress, bool frozen"),
        [getAddress(input.walletAddress), input.frozen]
      );
      return { actionType: ACTION_TYPE.SYNC_FREEZE_WALLET, payload };
    }
    case "SYNC_EMPLOYMENT_STATUS": {
      const payload = encodeAbiParameters(
        parseAbiParameters("address employee, bool employed"),
        [getAddress(input.employeeAddress), input.employed]
      );
      return { actionType: ACTION_TYPE.SYNC_EMPLOYMENT_STATUS, payload };
    }
    case "SYNC_GOAL": {
      const payload = encodeAbiParameters(
        parseAbiParameters("bytes32 goalId, bool achieved, address employeeHint"),
        [
          input.goalId as `0x${string}`,
          input.achieved,
          getAddress(input.employeeAddress ?? "0x0000000000000000000000000000000000000000"),
        ],
      );
      return { actionType: ACTION_TYPE.SYNC_GOAL, payload };
    }
    case "SYNC_SET_CLAIM_REQUIREMENTS": {
      const payload = encodeAbiParameters(
        parseAbiParameters("address employee, uint64 cliffEndTimestamp, bytes32 goalId, bool goalRequired"),
        [
          getAddress(input.employeeAddress),
          BigInt(input.cliffEndTimestamp),
          (input.goalId ?? "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`,
          input.goalRequired ?? false,
        ],
      );

      return {
        actionType: ACTION_TYPE.SYNC_SET_CLAIM_REQUIREMENTS,
        payload,
      };
    }
    case "SYNC_SET_INVESTOR_AUTH": {
      const payload = encodeAbiParameters(
        parseAbiParameters("address investor, bool authorized"),
        [getAddress(input.investorAddress), input.authorized],
      );
      return {
        actionType: ACTION_TYPE.SYNC_SET_INVESTOR_AUTH,
        payload,
      };
    }
    case "SYNC_SET_INVESTOR_LOCKUP": {
      const payload = encodeAbiParameters(
        parseAbiParameters("address investor, uint64 lockupUntil"),
        [getAddress(input.investorAddress), BigInt(input.lockupUntil)],
      );
      return {
        actionType: ACTION_TYPE.SYNC_SET_INVESTOR_LOCKUP,
        payload,
      };
    }
    case "SYNC_CREATE_ROUND": {
      const payload = encodeAbiParameters(
        parseAbiParameters("uint256 roundId, uint64 startTime, uint64 endTime, uint256 tokenPriceUsdc6, uint256 maxUsdc"),
        [input.roundId, BigInt(input.startTime), BigInt(input.endTime), input.tokenPriceUsdc6, input.maxUsdc],
      );
      return {
        actionType: ACTION_TYPE.SYNC_CREATE_ROUND,
        payload,
      };
    }
    case "SYNC_SET_ROUND_ALLOWLIST": {
      const payload = encodeAbiParameters(
        parseAbiParameters("uint256 roundId, address investor, uint256 capUsdc"),
        [input.roundId, getAddress(input.investorAddress), input.capUsdc],
      );
      return {
        actionType: ACTION_TYPE.SYNC_SET_ROUND_ALLOWLIST,
        payload,
      };
    }
    case "SYNC_OPEN_ROUND": {
      const payload = encodeAbiParameters(parseAbiParameters("uint256 roundId"), [input.roundId]);
      return {
        actionType: ACTION_TYPE.SYNC_OPEN_ROUND,
        payload,
      };
    }
    case "SYNC_CLOSE_ROUND": {
      const payload = encodeAbiParameters(parseAbiParameters("uint256 roundId"), [input.roundId]);
      return {
        actionType: ACTION_TYPE.SYNC_CLOSE_ROUND,
        payload,
      };
    }
    case "SYNC_MARK_PURCHASE_SETTLED": {
      const payload = encodeAbiParameters(
        parseAbiParameters("uint256 purchaseId, bytes32 aceTransferRef"),
        [input.purchaseId, input.aceTransferRef as `0x${string}`],
      );
      return {
        actionType: ACTION_TYPE.SYNC_MARK_PURCHASE_SETTLED,
        payload,
      };
    }
    case "SYNC_REFUND_PURCHASE": {
      const payload = encodeAbiParameters(
        parseAbiParameters("uint256 purchaseId, bytes32 reason"),
        [input.purchaseId, (input.reason ?? "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`],
      );
      return {
        actionType: ACTION_TYPE.SYNC_REFUND_PURCHASE,
        payload,
      };
    }
    case "SYNC_SET_TOKEN_COMPLIANCE": {
      const payload = encodeAbiParameters(
        parseAbiParameters("address complianceAddress"),
        [getAddress(input.complianceAddress)],
      );
      return {
        actionType: ACTION_TYPE.SYNC_SET_TOKEN_COMPLIANCE,
        payload,
      };
    }
    case "SYNC_PRIVATE_DEPOSIT": {
      const payload = encodeAbiParameters(
        parseAbiParameters("uint256 amount"),
        [input.amount]
      );

      return {
        actionType: ACTION_TYPE.SYNC_PRIVATE_DEPOSIT,
        payload,
      };
    }
    case "SYNC_MINT": {
      const payload = encodeAbiParameters(
        parseAbiParameters("address to, uint256 amount"),
        [getAddress(input.to), input.amount],
      );

      return {
        actionType: ACTION_TYPE.SYNC_MINT,
        payload,
      };
    }
    case "SYNC_REDEEM_TICKET": {
      const payload = encodeAbiParameters(
        parseAbiParameters("uint256 amount, bytes ticket"),
        [input.amount, input.ticket as `0x${string}`]
      );

      return {
        actionType: ACTION_TYPE.SYNC_REDEEM_TICKET,
        payload,
      };
    }
    case "SYNC_BATCH": {
      const payloads = input.batches.map((batch) => encodeActionReport(buildInstruction(batch)));
      const payload = encodeAbiParameters(
        parseAbiParameters("bytes[] batches"),
        [payloads],
      );

      return {
        actionType: ACTION_TYPE.SYNC_BATCH,
        payload,
      };
    }
    default:
      throw new Error("Unsupported sync action");
  }
};

const submitInstruction = (
  runtime: Runtime<Config>,
  evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
  instruction: { actionType: number; payload: `0x${string}` },
): string => {
  const evmConfig = runtime.config.evms[0];
  const reportData = encodeActionReport(instruction);

  runtime.log(`Submitting instruction actionType=${instruction.actionType}`);

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const resp = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.receiverAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: evmConfig.gasLimit,
      },
    })
    .result();

  if (resp.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport failed: ${resp.errorMessage || resp.txStatus}`);
  }

  const txHashHex = bytesToHex(resp.txHash || new Uint8Array(32));
  runtime.log(`writeReport succeeded: ${txHashHex}`);
  return txHashHex;
};

const executeAceAction = async (
  runtime: Runtime<Config>,
  input: AceSyncInput,
): Promise<string> => {
  const privacy = resolvePrivacyConfig(runtime);
  const httpClient = new cre.capabilities.HTTPClient();
  const confidentialHttpClient = new cre.capabilities.ConfidentialHTTPClient();
  const baseUrl = resolveAceApiBaseUrl(runtime);
  const domain = resolveAceDomain(runtime);
  const signer = resolveAceSignerAccount(runtime, input.account);

  const sendAceRequest = (
    path: "/shielded-address" | "/private-transfer" | "/withdraw",
    payload: Record<string, unknown>,
  ): PostResponseWithBody => {
    const url = `${baseUrl}${path}`;

    if (privacy.enableConfidentialAce) {
      assertExternalPayloadPolicy("ACE_CONFIDENTIAL", payload);
      return confidentialHttpClient
        .sendRequest(runtime, postConfidentialDataWithBody, consensusIdenticalAggregation<PostResponseWithBody>())(
          url,
          payload,
          {
            encryptOutput: privacy.encryptOutputAce,
            vaultDonSecrets: privacy.vaultDonSecrets,
          },
        )
        .result();
    }

    assertExternalPayloadPolicy("ACE_HTTP", payload);
    return httpClient
      .sendRequest(runtime, postDataWithBody, consensusIdenticalAggregation<PostResponseWithBody>())(
        url,
        payload,
      )
      .result();
  };

  if (input.action === "ACE_GENERATE_SHIELDED_ADDRESS") {
    const account = getAddress(input.account ?? signer.address);
    const typedTimestamp = BigInt(input.timestamp);
    const message = {
      account,
      timestamp: typedTimestamp,
    };
    const auth = await signer.signTypedData({
      domain,
      primaryType: "Generate Shielded Address",
      types: {
        "Generate Shielded Address": EIP712_TYPES["Generate Shielded Address"],
      },
      message,
    });
    const response = sendAceRequest("/shielded-address", {
      account,
      timestamp: input.timestamp,
      auth,
    });
    logHttpResult(runtime, "ACE /shielded-address", response);
    return `${input.action}:${response.statusCode}`;
  }

  if (input.action === "ACE_PRIVATE_TRANSFER") {
    const sender = getAddress(input.account ?? signer.address);
    const flags = input.flags ?? [];
    const typedTimestamp = BigInt(input.timestamp);
    const message = {
      sender,
      recipient: getAddress(input.recipient),
      token: getAddress(input.token),
      amount: input.amount,
      flags,
      timestamp: typedTimestamp,
    };
    const auth = await signer.signTypedData({
      domain,
      primaryType: "Private Token Transfer",
      types: {
        "Private Token Transfer": EIP712_TYPES["Private Token Transfer"],
      },
      message,
    });
    const response = sendAceRequest("/private-transfer", {
      account: sender,
      recipient: message.recipient,
      token: message.token,
      amount: input.amount.toString(),
      flags,
      timestamp: input.timestamp,
      auth,
    });
    logHttpResult(runtime, "ACE /private-transfer", response);
    return `${input.action}:${response.statusCode}`;
  }

  const account = getAddress(input.account ?? signer.address);
  const typedTimestamp = BigInt(input.timestamp);
  const message = {
    account,
    token: getAddress(input.token),
    amount: input.amount,
    timestamp: typedTimestamp,
  };
  const auth = await signer.signTypedData({
    domain,
    primaryType: "Withdraw Tokens",
    types: {
      "Withdraw Tokens": EIP712_TYPES["Withdraw Tokens"],
    },
    message,
  });
  const response = sendAceRequest("/withdraw", {
    account,
    token: message.token,
    amount: input.amount.toString(),
    timestamp: input.timestamp,
    auth,
  });
  logHttpResult(runtime, "ACE /withdraw", response);
  return `${input.action}:${response.statusCode}`;
};

const buildLambdaPayloadFromLog = (
  runtime: Runtime<Config>,
  log: EVMLog,
): Record<string, string | number | boolean> | null => {
  const topics = log.topics.map((topic) => bytesToHex(topic)) as [
    `0x${string}`,
    ...`0x${string}`[],
  ];
  const data = bytesToHex(log.data);

  let decoded: any;
  try {
    decoded = decodeEventLog({
      abi: eventAbi,
      topics,
      data,
    });
  } catch {
    runtime.log("Ignoring log because it does not match supported events");
    return null;
  }

  runtime.log(`Detected event: ${decoded.eventName}`);
  const args = decoded.args as Record<string, unknown>;

  switch (decoded.eventName) {
    case "IdentityRegistered":
      return {
        action: "IdentityRegistered",
        employeeAddress: String(args.userAddress),
        identityAddress: String(args.identity),
        country: Number(args.country),
      };
    case "IdentityRemoved":
      return {
        action: "IdentityRemoved",
        employeeAddress: String(args.userAddress),
        identityAddress: String(args.identity),
      };
    case "CountryUpdated":
      return {
        action: "CountryUpdated",
        employeeAddress: String(args.userAddress),
        country: Number(args.country),
      };
    case "EmploymentStatusUpdated":
      return {
        action: "EmploymentStatusUpdated",
        employeeAddress: String(args.employee),
        employed: Boolean(args.employed),
      };
    case "GoalUpdated":
      return {
        action: "GoalUpdated",
        goalId: String(args.goalId),
        achieved: Boolean(args.achieved),
      };
    case "PrivateDeposit":
      return {
        action: "PrivateDeposit",
        amount: String(args.amount),
      };
    case "TicketRedeemed":
      return {
        action: "TicketRedeemed",
        employeeAddress: String(args.redeemer),
        amount: String(args.amount),
      };
    case "InvestorAuthorizationUpdated":
      return {
        action: "InvestorAuthorizationUpdated",
        investorAddress: String(args.investor),
        authorized: Boolean(args.authorized),
      };
    case "InvestorLockupUpdated":
      return {
        action: "InvestorLockupUpdated",
        investorAddress: String(args.investor),
        lockupUntil: Number(args.lockupUntil),
      };
    case "RoundCreated":
      return {
        action: "RoundCreated",
        roundId: String(args.roundId),
        startTime: Number(args.startTime),
        endTime: Number(args.endTime),
        tokenPriceUsdc6: String(args.tokenPriceUsdc6),
        maxUsdc: String(args.maxUsdc),
      };
    case "RoundOpened":
      return {
        action: "RoundOpened",
        roundId: String(args.roundId),
      };
    case "RoundClosed":
      return {
        action: "RoundClosed",
        roundId: String(args.roundId),
      };
    case "PurchaseRequested":
      return {
        action: "PurchaseRequested",
        purchaseId: String(args.purchaseId),
        roundId: String(args.roundId),
        buyer: String(args.buyer),
        usdcAmount: String(args.usdcAmount),
        aceRecipientCommitment: String(args.aceRecipientCommitment),
      };
    case "PurchaseSettled":
      return {
        action: "PurchaseSettled",
        purchaseId: String(args.purchaseId),
        aceTransferRef: String(args.aceTransferRef),
        usdcAmount: String(args.usdcAmount),
        treasury: String(args.treasury),
      };
    case "PurchaseRefunded":
      return {
        action: "PurchaseRefunded",
        purchaseId: String(args.purchaseId),
        buyer: String(args.buyer),
        usdcAmount: String(args.usdcAmount),
        reason: String(args.reason),
      };
    default:
      return null;
  }
};

const onHTTPTrigger = async (
  runtime: Runtime<Config>,
  evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
  payload: HTTPPayload,
): Promise<string> => {
  if (!payload.input || payload.input.length === 0) {
    throw new Error("HTTP trigger payload is empty");
  }

  const rawPayload = Buffer.from(payload.input).toString("utf-8");
  runtime.log(`HTTP payload received (bytes=${payload.input.length})`);

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(rawPayload);
  } catch {
    throw new Error("HTTP payload is not valid JSON");
  }

  const syncInput = syncInputSchema.parse(parsedPayload);
  runtime.log(`Parsed sync action: ${formatForLog(runtime, syncInput)}`);

  if (isAceSyncInput(syncInput)) {
    return executeAceAction(runtime, syncInput);
  }

  if (syncInput.action === "SYNC_REDEEM_TICKET") {
    throw new Error(
      "SYNC_REDEEM_TICKET is disabled. Request ticket with ACE_WITHDRAW_TICKET and redeem on-chain from the employee wallet via vault.withdrawWithTicket().",
    );
  }

  const instruction = buildInstruction(syncInput);
  return submitInstruction(runtime, evmClient, instruction);
};

const onLogTrigger = (runtime: Runtime<Config>, log: EVMLog): string => {
  const lambdaPayload = buildLambdaPayloadFromLog(runtime, log);
  if (!lambdaPayload) {
    return "Ignored event";
  }

  assertExternalPayloadPolicy("LAMBDA", lambdaPayload);
  runtime.log(`Forwarding event payload to Lambda: ${formatForLog(runtime, lambdaPayload)}`);

  // Try secrets vault first (production), fall back to config url (simulation)
  let lambdaUrl: string;
  try {
    lambdaUrl = runtime.getSecret({ id: "LAMBDA_URL" }).result().value;
  } catch {
    if (!runtime.config.url) {
      throw new Error("LAMBDA_URL secret not found and no url in config");
    }
    lambdaUrl = runtime.config.url;
  }

  const httpClient = new cre.capabilities.HTTPClient();
  const resp = httpClient
    .sendRequest(runtime, postData, consensusIdenticalAggregation<PostResponse>())(
      lambdaUrl,
      lambdaPayload,
    )
    .result();

  runtime.log(`Onchain event synced to Lambda. Status ${resp.statusCode}`);
  return lambdaPayload.action as string;
};

const initWorkflow = (config: Config) => {
  const evmConfig = config.evms[0];
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evmConfig.chainSelectorName,
    isTestnet: true,
  });

  if (!network) {
    throw new Error(`Network not found for chain selector name: ${evmConfig.chainSelectorName}`);
  }

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const httpTrigger = new cre.capabilities.HTTPCapability();
  const onHTTPTriggerWithClient = (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> =>
    onHTTPTrigger(runtime, evmClient, payload);

  const triggerAddresses = new Set<string>([
    evmConfig.identityRegistryAddress,
    evmConfig.acePrivacyManagerAddress,
  ]);
  if (evmConfig.complianceV2Address) triggerAddresses.add(evmConfig.complianceV2Address);
  if (evmConfig.privateRoundsMarketAddress) triggerAddresses.add(evmConfig.privateRoundsMarketAddress);

  const logHandlers = [...triggerAddresses].map((address) =>
    cre.handler(
      evmClient.logTrigger({
        addresses: [hexToBase64(address)],
      }),
      onLogTrigger,
    ),
  );

  return [cre.handler(httpTrigger.trigger({}), onHTTPTriggerWithClient), ...logHandlers];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configSchema,
  });
  await runner.run(initWorkflow);
}
