import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

// Must set AWS_REGION before importing handler
process.env.AWS_REGION = "us-east-2";

const ddbMock = mockClient(DynamoDBDocumentClient);

// Dynamic import so env vars are picked up
let handler;
before(async () => {
    const mod = await import("../index.mjs");
    handler = mod.handler;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const invoke = async (body) => {
    const response = await handler({ body: JSON.stringify(body) });
    return {
        statusCode: response.statusCode,
        body: JSON.parse(response.body),
    };
};

const EMPLOYEE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IDENTITY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
    ddbMock.reset();
    // Default: GetCommand returns empty (new employee)
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    // Default: PutCommand succeeds
    ddbMock.on(PutCommand).resolves({});
});

afterEach(() => {
    ddbMock.reset();
});

// ---------------------------------------------------------------------------
// Protocol event type tests
// ---------------------------------------------------------------------------

describe("IdentityRegistered – types match protocol (address, address, uint16)", () => {
    it("should persist employeeAddress as string, identityAddress as string, country as number", async () => {
        const { statusCode, body } = await invoke({
            action: "IdentityRegistered",
            employeeAddress: EMPLOYEE,
            identityAddress: IDENTITY,
            country: 840,
        });

        assert.equal(statusCode, 200);
        const data = body.data;
        assert.equal(typeof data.employeeAddress, "string");
        assert.equal(typeof data.identityAddress, "string");
        assert.equal(typeof data.country, "number");
        assert.equal(data.employeeAddress, EMPLOYEE);
        assert.equal(data.identityAddress, IDENTITY.toLowerCase());
        assert.equal(data.country, 840);
        assert.equal(data.kycVerified, true);
        assert.equal(data.lastOnchainEvent, "IdentityRegistered");
    });
});

describe("IdentityRemoved – types match protocol (address)", () => {
    it("should set kycVerified=false and identityAddress=null", async () => {
        const { statusCode, body } = await invoke({
            action: "IdentityRemoved",
            employeeAddress: EMPLOYEE,
        });

        assert.equal(statusCode, 200);
        const data = body.data;
        assert.equal(typeof data.employeeAddress, "string");
        assert.equal(data.kycVerified, false);
        assert.equal(data.identityAddress, null);
        assert.equal(data.lastOnchainEvent, "IdentityRemoved");
    });
});

describe("CountryUpdated – types match protocol (address, uint16)", () => {
    it("should persist country as number", async () => {
        const { statusCode, body } = await invoke({
            action: "CountryUpdated",
            employeeAddress: EMPLOYEE,
            country: 484,
        });

        assert.equal(statusCode, 200);
        const data = body.data;
        assert.equal(typeof data.country, "number");
        assert.equal(data.country, 484);
        assert.equal(data.lastOnchainEvent, "CountryUpdated");
    });
});

describe("EmploymentStatusUpdated – types match protocol (address, bool)", () => {
    it("should persist employed as boolean", async () => {
        const { statusCode, body } = await invoke({
            action: "EmploymentStatusUpdated",
            employeeAddress: EMPLOYEE,
            employed: true,
        });

        assert.equal(statusCode, 200);
        const data = body.data;
        assert.equal(typeof data.employed, "boolean");
        assert.equal(data.employed, true);
        assert.equal(data.lastOnchainEvent, "EmploymentStatusUpdated");
    });

    it("should handle employed=false", async () => {
        const { statusCode, body } = await invoke({
            action: "EmploymentStatusUpdated",
            employeeAddress: EMPLOYEE,
            employed: false,
        });

        assert.equal(statusCode, 200);
        assert.equal(body.data.employed, false);
    });
});

describe("GrantCreated – types match protocol (address, uint256)", () => {
    it("should persist amount as string (bigint-safe)", async () => {
        const { statusCode, body } = await invoke({
            action: "GrantCreated",
            employeeAddress: EMPLOYEE,
            amount: "1000000000000000000",
        });

        assert.equal(statusCode, 200);
        const data = body.data;
        assert.equal(typeof data.grantTotalAmount, "string");
        assert.equal(data.grantTotalAmount, "1000000000000000000");
        assert.equal(data.lastOnchainEvent, "GrantCreated");
    });
});

describe("TokensClaimed – types match protocol (address, uint256)", () => {
    it("should accumulate claimedAmount as string (bigint-safe)", async () => {
        // Simulate existing record with previous claims
        ddbMock.on(GetCommand).resolves({
            Item: {
                RecordId: `employee:${EMPLOYEE}`,
                employeeAddress: EMPLOYEE,
                claimedAmount: "500",
            },
        });

        const { statusCode, body } = await invoke({
            action: "TokensClaimed",
            employeeAddress: EMPLOYEE,
            amount: "300",
        });

        assert.equal(statusCode, 200);
        const data = body.data;
        assert.equal(typeof data.claimedAmount, "string");
        assert.equal(data.claimedAmount, "800"); // 500 + 300
        assert.equal(typeof data.lastClaimedAmount, "string");
        assert.equal(data.lastClaimedAmount, "300");
        assert.equal(data.lastOnchainEvent, "TokensClaimed");
    });

    it("should start from zero if no previous claims", async () => {
        const { statusCode, body } = await invoke({
            action: "TokensClaimed",
            employeeAddress: EMPLOYEE,
            amount: "100",
        });

        assert.equal(statusCode, 200);
        assert.equal(body.data.claimedAmount, "100");
    });
});

describe("GrantRevoked – types match protocol (address, uint256)", () => {
    it("should persist amountForfeited as string and set employed=false", async () => {
        const { statusCode, body } = await invoke({
            action: "GrantRevoked",
            employeeAddress: EMPLOYEE,
            amountForfeited: "750000",
        });

        assert.equal(statusCode, 200);
        const data = body.data;
        assert.equal(typeof data.lastRevokedAmount, "string");
        assert.equal(data.lastRevokedAmount, "750000");
        assert.equal(data.employed, false);
        assert.equal(data.lastOnchainEvent, "GrantRevoked");
    });
});

describe("GoalUpdated – types match protocol (bytes32, bool)", () => {
    it("should persist goalId as string and achieved as boolean", async () => {
        const goalId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const { statusCode, body } = await invoke({
            action: "GoalUpdated",
            goalId,
            achieved: true,
        });

        assert.equal(statusCode, 200);
        const data = body.data;
        assert.equal(typeof data.goalId, "string");
        assert.equal(typeof data.achieved, "boolean");
        assert.equal(data.goalId, goalId);
        assert.equal(data.achieved, true);
        assert.equal(data.lastOnchainEvent, "GoalUpdated");
    });

    it("should handle achieved=false", async () => {
        const { statusCode, body } = await invoke({
            action: "GoalUpdated",
            goalId: "perf-2024-q1",
            achieved: false,
        });

        assert.equal(statusCode, 200);
        assert.equal(body.data.achieved, false);
    });
});

// ---------------------------------------------------------------------------
// CompanyEmployeeInput (off-chain / web service entry point)
// ---------------------------------------------------------------------------

describe("CompanyEmployeeInput – company data persistence", () => {
    it("should persist allowed fields and return employee state", async () => {
        const { statusCode, body } = await invoke({
            action: "CompanyEmployeeInput",
            employeeAddress: EMPLOYEE,
            employeeId: "EMP-001",
            identityAddress: IDENTITY,
            country: 840,
            kycVerified: true,
            employed: true,
        });

        assert.equal(statusCode, 200);
        const data = body.data;
        assert.equal(data.employeeId, "EMP-001");
        assert.equal(data.identityAddress, IDENTITY);
        assert.equal(data.country, 840);
        assert.equal(data.kycVerified, true);
        assert.equal(data.employed, true);
        assert.equal(data.source, "company");
    });
});

// ---------------------------------------------------------------------------
// readEmployee
// ---------------------------------------------------------------------------

describe("readEmployee", () => {
    it("should return 404 for unknown employee", async () => {
        const { statusCode, body } = await invoke({
            action: "readEmployee",
            employeeAddress: "0x0000000000000000000000000000000000000000",
        });

        assert.equal(statusCode, 404);
        assert.equal(body.error, "Employee not found");
    });

    it("should return employee data when found", async () => {
        ddbMock.on(GetCommand).resolves({
            Item: {
                RecordId: `employee:${EMPLOYEE}`,
                employeeAddress: EMPLOYEE,
                kycVerified: true,
            },
        });

        const { statusCode, body } = await invoke({
            action: "readEmployee",
            employeeAddress: EMPLOYEE,
        });

        assert.equal(statusCode, 200);
        assert.equal(body.data.employeeAddress, EMPLOYEE);
    });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("Validation", () => {
    it("should reject unknown action", async () => {
        const { statusCode, body } = await invoke({ action: "UNKNOWN" });

        assert.equal(statusCode, 400);
        assert.equal(body.error, "Invalid action");
        assert.ok(Array.isArray(body.supportedActions));
    });

    it("should reject missing required fields", async () => {
        const { statusCode, body } = await invoke({
            action: "IdentityRegistered",
            // missing employeeAddress, identityAddress, country
        });

        assert.equal(statusCode, 400);
        assert.match(body.error, /Missing required parameters/);
    });

    it("should reject empty body", async () => {
        const response = await handler({ body: "" });
        const body = JSON.parse(response.body);
        assert.equal(response.statusCode, 400);
    });
});
