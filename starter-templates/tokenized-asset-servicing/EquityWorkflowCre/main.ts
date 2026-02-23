import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  getNetwork,
  type EVMLog,
  type HTTPPayload,
  type HTTPSendRequester,
  hexToBase64,
  ok,
  Runner,
  type Runtime,
  TxStatus,
} from "@chainlink/cre-sdk";
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

const baseSyncInputSchema = z.discriminatedUnion("action", [
  syncKycSchema,
  syncFreezeWalletSchema,
  syncPrivateDepositSchema,
  syncRedeemTicketSchema,
]);

const syncBatchSchema = z.object({
  action: z.literal("SYNC_BATCH"),
  batches: z.array(baseSyncInputSchema),
});

const syncInputSchema = z.discriminatedUnion("action", [
  syncKycSchema,
  syncFreezeWalletSchema,
  syncPrivateDepositSchema,
  syncRedeemTicketSchema,
  syncBatchSchema,
]);

type SyncInput = z.infer<typeof syncInputSchema>;

type PostResponse = {
  statusCode: number;
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

const postData = (
  sendRequester: HTTPSendRequester,
  lambdaUrl: string,
  lambdaPayload: Record<string, string | number | boolean>,
): PostResponse => {
  const bodyBytes = new TextEncoder().encode(JSON.stringify(lambdaPayload));
  const body = Buffer.from(bodyBytes).toString("base64");

  const req = {
    url: lambdaUrl,
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
  if (!ok(resp)) {
    throw new Error(`HTTP request to Lambda failed with status ${resp.statusCode}`);
  }

  return { statusCode: resp.statusCode };
};

const buildInstruction = (input: SyncInput): { actionType: number; payload: `0x${string}` } => {
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
      const payloads = input.batches.map((batch: unknown) => buildInstruction(batch as SyncInput).payload);
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

  const reportData = encodeAbiParameters(
    parseAbiParameters("uint8 actionType, bytes payload"),
    [instruction.actionType, instruction.payload],
  );

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

const onHTTPTrigger = (
  runtime: Runtime<Config>,
  evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
  payload: HTTPPayload,
): string => {
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
  const onHTTPTriggerWithClient = (runtime: Runtime<Config>, payload: HTTPPayload): string =>
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
