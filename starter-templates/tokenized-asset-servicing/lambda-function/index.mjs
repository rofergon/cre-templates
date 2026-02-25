import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import https from "https";
import { URL } from "url";

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_SERVER_ERROR = 500;

const TABLE_NAME = process.env.TABLE_NAME || "EquityEmployeeState";
const PARTITION_KEY = process.env.PARTITION_KEY || "RecordId";
const yourAwsRegion = ""; // Optional fallback (for console testing)
const AWS_REGION = process.env.AWS_REGION || yourAwsRegion;

const REQUIRED_FIELDS = {
  readEmployee: ["employeeAddress"],
  listEmployees: [],
  readInvestor: ["investorAddress"],
  readRound: ["roundId"],
  readPurchase: ["purchaseId"],
  CompanyEmployeeInput: ["employeeAddress"],
  CompanyEmployeeBatchInput: ["employees"],
  CompanyInvestorInput: ["investorAddress"],
  CompanyRoundInput: ["roundId"],
  CompanyRoundAllowlistInput: ["roundId", "investorAddress", "capUsdc"],
  CompanyRoundAllowlistBatchInput: ["roundId", "entries"],
  MarketPurchaseSettlementInput: ["purchaseId", "aceTransferRef"],
  MarketPurchaseRefundInput: ["purchaseId"],
  ManualSyncToCre: ["apiUrl", "payload"],
  IdentityRegistered: ["employeeAddress", "identityAddress", "country"],
  IdentityRemoved: ["employeeAddress"],
  CountryUpdated: ["employeeAddress", "country"],
  EmploymentStatusUpdated: ["employeeAddress", "employed"],
  PrivateDeposit: ["amount"],
  TicketRedeemed: ["employeeAddress", "amount"],
  GoalUpdated: ["goalId", "achieved"],
  InvestorAuthorizationUpdated: ["investorAddress", "authorized"],
  InvestorLockupUpdated: ["investorAddress", "lockupUntil"],
  RoundCreated: ["roundId", "startTime", "endTime", "tokenPriceUsdc6", "maxUsdc"],
  RoundOpened: ["roundId"],
  RoundClosed: ["roundId"],
  PurchaseRequested: ["purchaseId", "roundId", "buyer", "usdcAmount", "aceRecipientCommitment"],
  PurchaseSettled: ["purchaseId", "aceTransferRef", "usdcAmount", "treasury"],
  PurchaseRefunded: ["purchaseId", "buyer", "usdcAmount", "reason"],
};

const COMPANY_ALLOWED_FIELDS = [
  "employeeId",
  "identityAddress",
  "country",
  "kycVerified",
  "employed",
  "goalId",
  "goalAchieved",
  "cliffEndTimestamp",
  "goalRequired",
  "walletFrozen",
  "privateDepositAmount",
  "ticketRedeemAmount",
  "notes",
];

const buildResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const buildKey = (recordId) => ({
  [PARTITION_KEY]: recordId,
});

const normalizeAddress = (value) => String(value || "").toLowerCase();
const employeeRecordId = (employeeAddress) => `employee:${normalizeAddress(employeeAddress)}`;
const goalRecordId = (goalId) => `goal:${String(goalId || "").toLowerCase()}`;
const investorRecordId = (investorAddress) => `investor:${normalizeAddress(investorAddress)}`;
const roundRecordId = (roundId) => `round:${String(roundId)}`;
const purchaseRecordId = (purchaseId) => `purchase:${String(purchaseId)}`;
const aceSettlementRecordId = (purchaseId) => `aceSettlement:${String(purchaseId)}`;

const parseBigInt = (value) => {
  try {
    return BigInt(value ?? "0");
  } catch {
    throw new Error(`Invalid bigint value: ${value}`);
  }
};

const validateParams = (action, params) => {
  const required = REQUIRED_FIELDS[action];
  if (!required || !required.every((field) => params[field] != null)) {
    throw new Error(`Missing required parameters for action ${action}`);
  }
};

const getRecord = async (client, recordId) => {
  const command = new GetCommand({
    TableName: TABLE_NAME,
    Key: buildKey(recordId),
  });

  const { Item } = await client.send(command);
  return Item || null;
};

const putRecord = async (client, item) => {
  const command = new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  });
  await client.send(command);
};

const upsertRecord = async (client, recordId, patch) => {
  const current = (await getRecord(client, recordId)) || {};
  const updated = {
    ...current,
    ...patch,
    [PARTITION_KEY]: recordId,
    updatedAt: new Date().toISOString(),
  };
  await putRecord(client, updated);
  return updated;
};

const postJson = async (apiUrl, payload) => {
  const body = JSON.stringify(payload);
  const parsedUrl = new URL(apiUrl);

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const response = await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`POST request failed (${response.statusCode}): ${response.body}`);
  }

  return response;
};

const pickCompanyPatch = (params) => {
  const patch = {};
  for (const field of COMPANY_ALLOWED_FIELDS) {
    if (params[field] !== undefined) {
      patch[field] = params[field];
    }
  }
  return patch;
};

const buildSyncPayloadsFromCompanyInput = (params, employeeState) => {
  const payloads = [];
  const employeeAddress = employeeState.employeeAddress;

  const shouldSyncKyc =
    params.syncKyc === true ||
    params.kycVerified !== undefined ||
    params.identityAddress !== undefined ||
    params.country !== undefined;

  if (shouldSyncKyc) {
    const verified = Boolean(employeeState.kycVerified);
    const kycPayload = {
      action: "SYNC_KYC",
      employeeAddress,
      verified,
      country: Number(employeeState.country ?? 0),
    };

    if (verified) {
      if (!employeeState.identityAddress) {
        throw new Error("identityAddress is required to sync KYC when kycVerified=true");
      }
      kycPayload.identityAddress = employeeState.identityAddress;
    }

    payloads.push(kycPayload);
  }

  const shouldSyncEmployment =
    params.syncEmployment === true || params.employed !== undefined;
  if (shouldSyncEmployment) {
    payloads.push({
      action: "SYNC_EMPLOYMENT_STATUS",
      employeeAddress,
      employed: Boolean(employeeState.employed),
    });
  }

  const shouldSyncGoal =
    params.syncGoal === true ||
    params.goalId !== undefined ||
    params.goalAchieved !== undefined;
  if (shouldSyncGoal && employeeState.goalId && employeeState.goalAchieved !== undefined) {
    payloads.push({
      action: "SYNC_GOAL",
      goalId: employeeState.goalId,
      achieved: Boolean(employeeState.goalAchieved),
      employeeAddress,
    });
  }

  const shouldSyncClaimRequirements =
    params.syncClaimRequirements === true ||
    params.cliffEndTimestamp !== undefined ||
    params.goalId !== undefined ||
    params.goalRequired !== undefined;

  if (shouldSyncClaimRequirements) {
    payloads.push({
      action: "SYNC_SET_CLAIM_REQUIREMENTS",
      employeeAddress,
      cliffEndTimestamp: Number(employeeState.cliffEndTimestamp ?? 0),
      goalId: String(employeeState.goalId || "0x0000000000000000000000000000000000000000000000000000000000000000"),
      goalRequired: Boolean(employeeState.goalRequired),
    });
  }

  const shouldSyncFreeze =
    params.syncFreezeWallet === true || params.walletFrozen !== undefined;
  if (shouldSyncFreeze) {
    payloads.push({
      action: "SYNC_FREEZE_WALLET",
      walletAddress: employeeAddress,
      frozen: Boolean(employeeState.walletFrozen),
    });
  }

  const shouldSyncDeposit = params.syncPrivateDeposit === true || params.privateDepositAmount !== undefined;
  if (shouldSyncDeposit && employeeState.privateDepositAmount) {
    payloads.push({
      action: "SYNC_PRIVATE_DEPOSIT",
      amount: String(employeeState.privateDepositAmount)
    });
  }

  const shouldSyncTicket = params.syncRedeemTicket === true || params.ticketRedeemAmount !== undefined;
  if (shouldSyncTicket && employeeState.ticketRedeemAmount) {
    throw new Error(
      "SYNC_REDEEM_TICKET is disabled. Use ACE_WITHDRAW_TICKET from CRE and redeem with withdrawWithTicket() from the employee wallet.",
    );
  }

  if (Array.isArray(params.extraSyncPayloads)) {
    payloads.push(...params.extraSyncPayloads);
  }

  return payloads;
};

const buildSyncPayloadsFromInvestorInput = (params, investorState) => {
  const payloads = [];
  const investorAddress = investorState.investorAddress;

  const shouldSyncKyc =
    params.syncKyc === true ||
    params.kycVerified !== undefined ||
    params.identityAddress !== undefined ||
    params.country !== undefined;
  if (shouldSyncKyc) {
    const verified = Boolean(investorState.kycVerified);
    const kycPayload = {
      action: "SYNC_KYC",
      employeeAddress: investorAddress,
      verified,
      country: Number(investorState.country ?? 0),
    };
    if (verified) {
      if (!investorState.identityAddress) {
        throw new Error("identityAddress is required to sync KYC when kycVerified=true");
      }
      kycPayload.identityAddress = investorState.identityAddress;
    }
    payloads.push(kycPayload);
  }

  const shouldSyncInvestorAuth =
    params.syncInvestorAuth === true || params.authorized !== undefined;
  if (shouldSyncInvestorAuth) {
    payloads.push({
      action: "SYNC_SET_INVESTOR_AUTH",
      investorAddress,
      authorized: Boolean(investorState.authorized),
    });
  }

  const shouldSyncInvestorLockup =
    params.syncInvestorLockup === true || params.lockupUntil !== undefined;
  if (shouldSyncInvestorLockup) {
    payloads.push({
      action: "SYNC_SET_INVESTOR_LOCKUP",
      investorAddress,
      lockupUntil: Number(investorState.lockupUntil ?? 0),
    });
  }

  return payloads;
};

const buildSyncPayloadsFromRoundInput = (params, roundState) => {
  const payloads = [];
  const createRequested =
    params.syncCreateRound === true ||
    params.startTime !== undefined ||
    params.endTime !== undefined ||
    params.tokenPriceUsdc6 !== undefined ||
    params.maxUsdc !== undefined;

  if (createRequested) {
    payloads.push({
      action: "SYNC_CREATE_ROUND",
      roundId: String(roundState.roundId),
      startTime: Number(roundState.startTime),
      endTime: Number(roundState.endTime),
      tokenPriceUsdc6: String(roundState.tokenPriceUsdc6),
      maxUsdc: String(roundState.maxUsdc),
    });
  }

  if (params.openRound === true) {
    payloads.push({
      action: "SYNC_OPEN_ROUND",
      roundId: String(roundState.roundId),
    });
  }

  if (params.closeRound === true) {
    payloads.push({
      action: "SYNC_CLOSE_ROUND",
      roundId: String(roundState.roundId),
    });
  }

  return payloads;
};

const handlers = {
  readEmployee: async (client, { employeeAddress }) => {
    const recordId = employeeRecordId(employeeAddress);
    const item = await getRecord(client, recordId);
    if (!item) {
      throw new Error("Employee not found");
    }
    return { data: item };
  },

  listEmployees: async (client) => {
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "entityType = :type",
      ExpressionAttributeValues: {
        ":type": "employee"
      }
    });

    const { Items } = await client.send(command);
    return { data: Items || [] };
  },

  readInvestor: async (client, { investorAddress }) => {
    const recordId = investorRecordId(investorAddress);
    const item = await getRecord(client, recordId);
    if (!item) throw new Error("Investor not found");
    return { data: item };
  },

  readRound: async (client, { roundId }) => {
    const recordId = roundRecordId(roundId);
    const item = await getRecord(client, recordId);
    if (!item) throw new Error("Round not found");
    return { data: item };
  },

  readPurchase: async (client, { purchaseId }) => {
    const recordId = purchaseRecordId(purchaseId);
    const item = await getRecord(client, recordId);
    if (!item) throw new Error("Purchase not found");
    return { data: item };
  },

  CompanyEmployeeInput: async (client, params) => {
    const normalizedEmployeeAddress = normalizeAddress(params.employeeAddress);
    const recordId = employeeRecordId(normalizedEmployeeAddress);
    const patch = pickCompanyPatch(params);
    const now = new Date().toISOString();

    const employeeState = await upsertRecord(client, recordId, {
      ...patch,
      employeeAddress: normalizedEmployeeAddress,
      entityType: "employee",
      lastCompanyUpdateAt: now,
      source: "company",
    });

    let syncResponses = [];
    if (params.apiUrl) {
      const payloads = buildSyncPayloadsFromCompanyInput(params, employeeState);
      syncResponses = await Promise.all(
        payloads.map(async (payload) => {
          const response = await postJson(params.apiUrl, payload);
          return {
            action: payload.action,
            statusCode: response.statusCode,
            responseBody: response.body,
          };
        }),
      );
    }

    return {
      message: "Company input persisted",
      recordId,
      syncTriggered: syncResponses.length,
      syncResponses,
      data: employeeState,
    };
  },

  CompanyEmployeeBatchInput: async (client, { employees, apiUrl }) => {
    const now = new Date().toISOString();
    const allSyncPayloads = [];
    const results = [];

    for (const params of employees) {
      const normalizedEmployeeAddress = normalizeAddress(params.employeeAddress);
      const recordId = employeeRecordId(normalizedEmployeeAddress);
      const patch = pickCompanyPatch(params);

      const employeeState = await upsertRecord(client, recordId, {
        ...patch,
        employeeAddress: normalizedEmployeeAddress,
        entityType: "employee",
        lastCompanyUpdateAt: now,
        source: "company",
      });

      if (apiUrl) {
        const payloads = buildSyncPayloadsFromCompanyInput(params, employeeState);
        allSyncPayloads.push(...payloads);
      }

      results.push({ recordId, data: employeeState });
    }

    let syncResponse = null;
    if (apiUrl && allSyncPayloads.length > 0) {
      const batchPayload = {
        action: "SYNC_BATCH",
        batches: allSyncPayloads,
      };
      const response = await postJson(apiUrl, batchPayload);
      syncResponse = {
        action: "SYNC_BATCH",
        statusCode: response.statusCode,
        responseBody: response.body,
      };
    }

    return {
      message: "Batch company input persisted",
      processedCount: results.length,
      syncTriggered: allSyncPayloads.length > 0 ? 1 : 0,
      syncResponse,
      data: results,
    };
  },

  CompanyInvestorInput: async (client, params) => {
    const normalizedInvestorAddress = normalizeAddress(params.investorAddress);
    const recordId = investorRecordId(normalizedInvestorAddress);
    const now = new Date().toISOString();

    const investorState = await upsertRecord(client, recordId, {
      entityType: "investor",
      investorAddress: normalizedInvestorAddress,
      identityAddress: params.identityAddress !== undefined ? normalizeAddress(params.identityAddress) : undefined,
      country: params.country !== undefined ? Number(params.country) : undefined,
      kycVerified: params.kycVerified !== undefined ? Boolean(params.kycVerified) : undefined,
      authorized: params.authorized !== undefined ? Boolean(params.authorized) : undefined,
      lockupUntil: params.lockupUntil !== undefined ? Number(params.lockupUntil) : undefined,
      notes: params.notes,
      source: "company",
      lastCompanyUpdateAt: now,
    });

    let syncResponses = [];
    if (params.apiUrl) {
      const payloads = buildSyncPayloadsFromInvestorInput(params, investorState);
      syncResponses = await Promise.all(
        payloads.map(async (payload) => {
          const response = await postJson(params.apiUrl, payload);
          return {
            action: payload.action,
            statusCode: response.statusCode,
            responseBody: response.body,
          };
        }),
      );
    }

    return {
      message: "Investor input persisted",
      recordId,
      syncTriggered: syncResponses.length,
      syncResponses,
      data: investorState,
    };
  },

  CompanyRoundInput: async (client, params) => {
    const recordId = roundRecordId(params.roundId);
    const now = new Date().toISOString();
    const roundState = await upsertRecord(client, recordId, {
      entityType: "round",
      roundId: String(params.roundId),
      startTime: params.startTime !== undefined ? Number(params.startTime) : undefined,
      endTime: params.endTime !== undefined ? Number(params.endTime) : undefined,
      tokenPriceUsdc6: params.tokenPriceUsdc6 !== undefined ? String(params.tokenPriceUsdc6) : undefined,
      maxUsdc: params.maxUsdc !== undefined ? String(params.maxUsdc) : undefined,
      status: params.status,
      notes: params.notes,
      source: "company",
      lastCompanyUpdateAt: now,
    });

    let syncResponses = [];
    if (params.apiUrl) {
      const payloads = buildSyncPayloadsFromRoundInput(params, roundState);
      syncResponses = await Promise.all(
        payloads.map(async (payload) => {
          const response = await postJson(params.apiUrl, payload);
          return {
            action: payload.action,
            statusCode: response.statusCode,
            responseBody: response.body,
          };
        }),
      );
    }

    return {
      message: "Round input persisted",
      recordId,
      syncTriggered: syncResponses.length,
      syncResponses,
      data: roundState,
    };
  },

  CompanyRoundAllowlistInput: async (client, params) => {
    const recordId = `${roundRecordId(params.roundId)}:allowlist:${normalizeAddress(params.investorAddress)}`;
    const entry = await upsertRecord(client, recordId, {
      entityType: "roundAllowlist",
      roundId: String(params.roundId),
      investorAddress: normalizeAddress(params.investorAddress),
      capUsdc: String(params.capUsdc),
      source: "company",
    });

    let syncResponse = null;
    if (params.apiUrl) {
      const payload = {
        action: "SYNC_SET_ROUND_ALLOWLIST",
        roundId: String(params.roundId),
        investorAddress: normalizeAddress(params.investorAddress),
        capUsdc: String(params.capUsdc),
      };
      const response = await postJson(params.apiUrl, payload);
      syncResponse = {
        action: payload.action,
        statusCode: response.statusCode,
        responseBody: response.body,
      };
    }

    return {
      message: "Round allowlist input persisted",
      syncTriggered: syncResponse ? 1 : 0,
      syncResponse,
      data: entry,
    };
  },

  CompanyRoundAllowlistBatchInput: async (client, { roundId, entries, apiUrl }) => {
    const results = [];
    for (const entry of entries) {
      const recordId = `${roundRecordId(roundId)}:allowlist:${normalizeAddress(entry.investorAddress)}`;
      const saved = await upsertRecord(client, recordId, {
        entityType: "roundAllowlist",
        roundId: String(roundId),
        investorAddress: normalizeAddress(entry.investorAddress),
        capUsdc: String(entry.capUsdc),
        source: "company",
      });
      results.push(saved);
    }

    let syncResponse = null;
    if (apiUrl && entries.length > 0) {
      const batchPayload = {
        action: "SYNC_BATCH",
        batches: entries.map((entry) => ({
          action: "SYNC_SET_ROUND_ALLOWLIST",
          roundId: String(roundId),
          investorAddress: normalizeAddress(entry.investorAddress),
          capUsdc: String(entry.capUsdc),
        })),
      };
      const response = await postJson(apiUrl, batchPayload);
      syncResponse = {
        action: "SYNC_BATCH",
        statusCode: response.statusCode,
        responseBody: response.body,
      };
    }

    return {
      message: "Round allowlist batch persisted",
      processedCount: results.length,
      syncTriggered: syncResponse ? 1 : 0,
      syncResponse,
      data: results,
    };
  },

  MarketPurchaseSettlementInput: async (client, { purchaseId, aceTransferRef, apiUrl }) => {
    const recordId = aceSettlementRecordId(purchaseId);
    const updated = await upsertRecord(client, recordId, {
      entityType: "aceSettlement",
      purchaseId: String(purchaseId),
      aceTransferRef: String(aceTransferRef),
      status: "pending-settlement-sync",
      source: "company",
    });

    let syncResponse = null;
    if (apiUrl) {
      const payload = {
        action: "SYNC_MARK_PURCHASE_SETTLED",
        purchaseId: String(purchaseId),
        aceTransferRef: String(aceTransferRef),
      };
      const response = await postJson(apiUrl, payload);
      syncResponse = {
        action: payload.action,
        statusCode: response.statusCode,
        responseBody: response.body,
      };
    }

    return {
      message: "Purchase settlement request persisted",
      syncTriggered: syncResponse ? 1 : 0,
      syncResponse,
      data: updated,
    };
  },

  MarketPurchaseRefundInput: async (client, { purchaseId, reason, apiUrl }) => {
    const normalizedReason =
      typeof reason === "string" && /^0x[0-9a-fA-F]{64}$/.test(reason)
        ? reason
        : "0x4d414e55414c5f524546554e4400000000000000000000000000000000000000";

    const recordId = aceSettlementRecordId(purchaseId);
    const updated = await upsertRecord(client, recordId, {
      entityType: "aceSettlement",
      purchaseId: String(purchaseId),
      refundReason: String(normalizedReason),
      status: "pending-refund-sync",
      source: "company",
    });

    let syncResponse = null;
    if (apiUrl) {
      const payload = {
        action: "SYNC_REFUND_PURCHASE",
        purchaseId: String(purchaseId),
        reason: String(normalizedReason),
      };
      const response = await postJson(apiUrl, payload);
      syncResponse = {
        action: payload.action,
        statusCode: response.statusCode,
        responseBody: response.body,
      };
    }

    return {
      message: "Purchase refund request persisted",
      syncTriggered: syncResponse ? 1 : 0,
      syncResponse,
      data: updated,
    };
  },

  ManualSyncToCre: async (_client, { apiUrl, payload }) => {
    const response = await postJson(apiUrl, payload);
    return {
      message: "Manual payload synced to CRE",
      statusCode: response.statusCode,
      responseBody: response.body,
    };
  },

  IdentityRegistered: async (client, { employeeAddress, identityAddress, country }) => {
    const recordId = employeeRecordId(employeeAddress);
    const updated = await upsertRecord(client, recordId, {
      entityType: "employee",
      employeeAddress: normalizeAddress(employeeAddress),
      identityAddress: normalizeAddress(identityAddress),
      country: Number(country),
      kycVerified: true,
      lastOnchainEvent: "IdentityRegistered",
    });
    return { message: "IdentityRegistered synced from onchain", data: updated };
  },

  IdentityRemoved: async (client, { employeeAddress }) => {
    const recordId = employeeRecordId(employeeAddress);
    const updated = await upsertRecord(client, recordId, {
      entityType: "employee",
      employeeAddress: normalizeAddress(employeeAddress),
      identityAddress: null,
      kycVerified: false,
      lastOnchainEvent: "IdentityRemoved",
    });
    return { message: "IdentityRemoved synced from onchain", data: updated };
  },

  CountryUpdated: async (client, { employeeAddress, country }) => {
    const recordId = employeeRecordId(employeeAddress);
    const updated = await upsertRecord(client, recordId, {
      entityType: "employee",
      employeeAddress: normalizeAddress(employeeAddress),
      country: Number(country),
      lastOnchainEvent: "CountryUpdated",
    });
    return { message: "CountryUpdated synced from onchain", data: updated };
  },

  EmploymentStatusUpdated: async (client, { employeeAddress, employed }) => {
    const recordId = employeeRecordId(employeeAddress);
    const updated = await upsertRecord(client, recordId, {
      entityType: "employee",
      employeeAddress: normalizeAddress(employeeAddress),
      employed: Boolean(employed),
      lastOnchainEvent: "EmploymentStatusUpdated",
    });
    return { message: "Employment status synced from onchain", data: updated };
  },

  PrivateDeposit: async (client, { amount }) => {
    const recordId = "vault:main";
    const current = (await getRecord(client, recordId)) || {};
    const totalDeposited = parseBigInt(current.totalDeposited || "0") + parseBigInt(amount);

    const updated = await upsertRecord(client, recordId, {
      ...current,
      entityType: "vault",
      totalDeposited: totalDeposited.toString(),
      lastDepositAmount: String(amount),
      lastOnchainEvent: "PrivateDeposit",
    });
    return { message: "PrivateDeposit synced from onchain", data: updated };
  },

  TicketRedeemed: async (client, { employeeAddress, amount }) => {
    const recordId = employeeRecordId(employeeAddress);
    const current = (await getRecord(client, recordId)) || {};
    const claimedBefore = parseBigInt(current.claimedAmount || "0");
    const claimedAfter = claimedBefore + parseBigInt(amount);

    const updated = await upsertRecord(client, recordId, {
      ...current,
      entityType: "employee",
      employeeAddress: normalizeAddress(employeeAddress),
      claimedAmount: claimedAfter.toString(),
      lastClaimedAmount: String(amount),
      lastOnchainEvent: "TicketRedeemed",
    });

    return { message: "TicketRedeemed synced from onchain", data: updated };
  },

  GoalUpdated: async (client, { goalId, achieved }) => {
    const recordId = goalRecordId(goalId);
    const updated = await upsertRecord(client, recordId, {
      entityType: "goal",
      goalId: String(goalId),
      achieved: Boolean(achieved),
      lastOnchainEvent: "GoalUpdated",
    });
    return { message: "GoalUpdated synced from onchain", data: updated };
  },

  InvestorAuthorizationUpdated: async (client, { investorAddress, authorized }) => {
    const recordId = investorRecordId(investorAddress);
    const updated = await upsertRecord(client, recordId, {
      entityType: "investor",
      investorAddress: normalizeAddress(investorAddress),
      authorized: Boolean(authorized),
      lastOnchainEvent: "InvestorAuthorizationUpdated",
    });
    return { message: "Investor authorization synced from onchain", data: updated };
  },

  InvestorLockupUpdated: async (client, { investorAddress, lockupUntil }) => {
    const recordId = investorRecordId(investorAddress);
    const updated = await upsertRecord(client, recordId, {
      entityType: "investor",
      investorAddress: normalizeAddress(investorAddress),
      lockupUntil: Number(lockupUntil),
      lastOnchainEvent: "InvestorLockupUpdated",
    });
    return { message: "Investor lockup synced from onchain", data: updated };
  },

  RoundCreated: async (client, { roundId, startTime, endTime, tokenPriceUsdc6, maxUsdc }) => {
    const recordId = roundRecordId(roundId);
    const updated = await upsertRecord(client, recordId, {
      entityType: "round",
      roundId: String(roundId),
      startTime: Number(startTime),
      endTime: Number(endTime),
      tokenPriceUsdc6: String(tokenPriceUsdc6),
      maxUsdc: String(maxUsdc),
      status: "draft",
      lastOnchainEvent: "RoundCreated",
    });
    return { message: "RoundCreated synced from onchain", data: updated };
  },

  RoundOpened: async (client, { roundId }) => {
    const recordId = roundRecordId(roundId);
    const updated = await upsertRecord(client, recordId, {
      entityType: "round",
      roundId: String(roundId),
      status: "open",
      lastOnchainEvent: "RoundOpened",
    });
    return { message: "RoundOpened synced from onchain", data: updated };
  },

  RoundClosed: async (client, { roundId }) => {
    const recordId = roundRecordId(roundId);
    const updated = await upsertRecord(client, recordId, {
      entityType: "round",
      roundId: String(roundId),
      status: "closed",
      lastOnchainEvent: "RoundClosed",
    });
    return { message: "RoundClosed synced from onchain", data: updated };
  },

  PurchaseRequested: async (client, { purchaseId, roundId, buyer, usdcAmount, aceRecipientCommitment }) => {
    const recordId = purchaseRecordId(purchaseId);
    const updated = await upsertRecord(client, recordId, {
      entityType: "purchase",
      purchaseId: String(purchaseId),
      roundId: String(roundId),
      buyer: normalizeAddress(buyer),
      usdcAmount: String(usdcAmount),
      aceRecipientCommitment: String(aceRecipientCommitment),
      status: "pending",
      lastOnchainEvent: "PurchaseRequested",
    });
    return { message: "PurchaseRequested synced from onchain", data: updated };
  },

  PurchaseSettled: async (client, { purchaseId, aceTransferRef, usdcAmount, treasury }) => {
    const recordId = purchaseRecordId(purchaseId);
    const updated = await upsertRecord(client, recordId, {
      entityType: "purchase",
      purchaseId: String(purchaseId),
      aceTransferRef: String(aceTransferRef),
      usdcAmount: String(usdcAmount),
      treasury: normalizeAddress(treasury),
      status: "settled",
      lastOnchainEvent: "PurchaseSettled",
    });
    await upsertRecord(client, aceSettlementRecordId(purchaseId), {
      entityType: "aceSettlement",
      purchaseId: String(purchaseId),
      aceTransferRef: String(aceTransferRef),
      status: "settled",
      lastOnchainEvent: "PurchaseSettled",
    });
    return { message: "PurchaseSettled synced from onchain", data: updated };
  },

  PurchaseRefunded: async (client, { purchaseId, buyer, usdcAmount, reason }) => {
    const recordId = purchaseRecordId(purchaseId);
    const updated = await upsertRecord(client, recordId, {
      entityType: "purchase",
      purchaseId: String(purchaseId),
      buyer: normalizeAddress(buyer),
      usdcAmount: String(usdcAmount),
      refundReason: String(reason),
      status: "refunded",
      lastOnchainEvent: "PurchaseRefunded",
    });
    await upsertRecord(client, aceSettlementRecordId(purchaseId), {
      entityType: "aceSettlement",
      purchaseId: String(purchaseId),
      refundReason: String(reason),
      status: "refunded",
      lastOnchainEvent: "PurchaseRefunded",
    });
    return { message: "PurchaseRefunded synced from onchain", data: updated };
  },
};

const parseEventParams = (event) => {
  if (event && typeof event === "object" && event.action && !event.body) {
    return event;
  }

  if (!event?.body) {
    return {};
  }

  if (typeof event.body === "string") {
    return JSON.parse(event.body || "{}");
  }

  if (typeof event.body === "object") {
    return event.body;
  }

  return {};
};

export const handler = async (event) => {
  if (!AWS_REGION) {
    return buildResponse(STATUS_BAD_REQUEST, {
      error: "AWS region is missing. Set AWS_REGION env var or yourAwsRegion constant.",
    });
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));

  let params;
  try {
    params = parseEventParams(event);
  } catch {
    return buildResponse(STATUS_BAD_REQUEST, { error: "Invalid JSON in request body" });
  }

  const { action } = params;
  if (!action || !handlers[action]) {
    return buildResponse(STATUS_BAD_REQUEST, {
      error: "Invalid action",
      supportedActions: Object.keys(handlers),
    });
  }

  try {
    validateParams(action, params);
    const result = await handlers[action](client, params);
    return buildResponse(STATUS_OK, result);
  } catch (error) {
    console.error("Error:", error);
    const message = error?.message || "Internal server error";

    if (
      message === "Employee not found" ||
      message === "Investor not found" ||
      message === "Round not found" ||
      message === "Purchase not found"
    ) {
      return buildResponse(STATUS_NOT_FOUND, { error: message });
    }

    if (message.startsWith("Missing required parameters")) {
      return buildResponse(STATUS_BAD_REQUEST, { error: message });
    }

    if (message.startsWith("POST request failed")) {
      return buildResponse(STATUS_BAD_REQUEST, { error: message });
    }

    return buildResponse(STATUS_SERVER_ERROR, {
      error: "Internal server error",
      details: message,
    });
  }
};
