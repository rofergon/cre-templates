import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  getNetwork,
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

const configSchema = z.object({
  url: z.string().optional(),
  evms: z
    .array(
      z.object({
        receiverAddress: z.string(),
        identityRegistryAddress: z.string(),
        acePrivacyManagerAddress: z.string(),
        aceVaultAddress: z.string(),
        aceChainId: z.coerce.number().int().positive().optional(),
        chainSelectorName: z.string(),
        gasLimit: z.string(),
      }),
    )
    .min(1),
  aceApiUrl: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const timestampSchema = z.coerce.number().int().positive();

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

const syncPrivateDepositSchema = z.object({
  action: z.literal("SYNC_PRIVATE_DEPOSIT"),
  amount: z.coerce.bigint().positive(),
});

const syncRedeemTicketSchema = z.object({
  action: z.literal("SYNC_REDEEM_TICKET"),
  amount: z.coerce.bigint().positive(),
  ticket: z.string(),
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
  syncFreezeWalletSchema,
  syncPrivateDepositSchema,
  syncRedeemTicketSchema,
]);

const syncBatchSchema = z.object({
  action: z.literal("SYNC_BATCH"),
  batches: z.array(onchainBaseSyncInputSchema),
});

const onchainSyncInputSchema = z.discriminatedUnion("action", [
  syncKycSchema,
  syncFreezeWalletSchema,
  syncPrivateDepositSchema,
  syncRedeemTicketSchema,
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

const ACTION_TYPE = {
  SYNC_KYC: 0,
  SYNC_EMPLOYMENT_STATUS: 1, // no-op
  SYNC_GOAL: 2,              // no-op
  SYNC_FREEZE_WALLET: 3,
  SYNC_PRIVATE_DEPOSIT: 4,
  SYNC_BATCH: 5,
  SYNC_REDEEM_TICKET: 6,
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

const eventAbi = parseAbi([
  "event IdentityRegistered(address indexed userAddress, address indexed identity, uint16 country)",
  "event IdentityRemoved(address indexed userAddress, address indexed identity)",
  "event CountryUpdated(address indexed userAddress, uint16 country)",
  "event PrivateDeposit(uint256 amount)",
  "event TicketRedeemed(address indexed redeemer, uint256 amount)",
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
    cacheSettings: {
      store: true,
      maxAge: "30s",
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
  const httpClient = new cre.capabilities.HTTPClient();
  const baseUrl = resolveAceApiBaseUrl(runtime);
  const domain = resolveAceDomain(runtime);
  const signer = resolveAceSignerAccount(runtime, input.account);

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
    const response = httpClient
      .sendRequest(runtime, postDataWithBody, consensusIdenticalAggregation<PostResponseWithBody>())(
        `${baseUrl}/shielded-address`,
        { account, timestamp: input.timestamp, auth },
      )
      .result();

    runtime.log(`ACE /shielded-address response: ${response.body}`);
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
    const response = httpClient
      .sendRequest(runtime, postDataWithBody, consensusIdenticalAggregation<PostResponseWithBody>())(
        `${baseUrl}/private-transfer`,
        {
          account: sender,
          recipient: message.recipient,
          token: message.token,
          amount: input.amount.toString(),
          flags,
          timestamp: input.timestamp,
          auth,
        },
      )
      .result();

    runtime.log(`ACE /private-transfer response: ${response.body}`);
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
  const response = httpClient
    .sendRequest(runtime, postDataWithBody, consensusIdenticalAggregation<PostResponseWithBody>())(
      `${baseUrl}/withdraw`,
      {
        account,
        token: message.token,
        amount: input.amount.toString(),
        timestamp: input.timestamp,
        auth,
      },
    )
    .result();

  runtime.log(`ACE /withdraw response: ${response.body}`);
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
  runtime.log(`HTTP payload received: ${rawPayload}`);

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(rawPayload);
  } catch {
    throw new Error("HTTP payload is not valid JSON");
  }

  const syncInput = syncInputSchema.parse(parsedPayload);
  runtime.log(`Parsed sync action: ${safeJsonStringify(syncInput)}`);

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

  return [
    cre.handler(httpTrigger.trigger({}), onHTTPTriggerWithClient),
    cre.handler(
      evmClient.logTrigger({
        addresses: [hexToBase64(evmConfig.identityRegistryAddress)],
      }),
      onLogTrigger,
    ),
    cre.handler(
      evmClient.logTrigger({
        addresses: [hexToBase64(evmConfig.acePrivacyManagerAddress)],
      }),
      onLogTrigger,
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configSchema,
  });
  await runner.run(initWorkflow);
}
