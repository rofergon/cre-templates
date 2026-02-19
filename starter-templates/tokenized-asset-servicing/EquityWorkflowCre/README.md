# EquityWorkflowCre

CRE workflow adapted for `contracts/equity-protocol` in **local simulation mode**.

This workflow orchestrates bidirectional sync:

1. **DynamoDB/Lambda -> Onchain** using `HTTP Trigger` + `EVM writeReport`
2. **Onchain -> DynamoDB/Lambda** using `EVM Log Trigger` + `HTTP Client`

## Supported sync actions (HTTP Trigger)

Send one of these JSON payloads to the CRE HTTP trigger:

- `SYNC_KYC`
- `SYNC_EMPLOYMENT_STATUS`
- `SYNC_GOAL`
- `SYNC_FREEZE_WALLET`

Example payloads:

```json
{
  "action": "SYNC_KYC",
  "employeeAddress": "0x1111111111111111111111111111111111111111",
  "verified": true,
  "identityAddress": "0x2222222222222222222222222222222222222222",
  "country": 840
}
```

```json
{
  "action": "SYNC_EMPLOYMENT_STATUS",
  "employeeAddress": "0x1111111111111111111111111111111111111111",
  "employed": false
}
```

```json
{
  "action": "SYNC_GOAL",
  "goalId": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "achieved": true
}
```

## Onchain events forwarded to Lambda

The workflow listens to `IdentityRegistry` and `EmployeeVesting` events and POSTs them to `config.url`:

- `IdentityRegistered`
- `IdentityRemoved`
- `CountryUpdated`
- `GrantCreated`
- `TokensClaimed`
- `EmploymentStatusUpdated`
- `GoalUpdated`
- `GrantRevoked`

## Required contracts

`writeReport` requires a contract that implements `IReceiver`.

Use:

- `contracts/equity-protocol/EquityWorkflowReceiver.sol`

`EquityWorkflowReceiver` routes CRE actions to:

- `IdentityRegistry`
- `EmployeeVesting`
- `Token` (freeze wallet path)

Important permissions:

- Receiver must be owner of `IdentityRegistry` to call register/delete/country updates.
- Receiver must be owner or oracle-authorized on `EmployeeVesting`.
- Receiver must be owner of `Token` to freeze/unfreeze addresses.

## Configuration

Edit:

- `config.staging.json`
- `config.production.json`

Fields:

- `url`: Lambda Function URL
- `receiverAddress`: deployed `EquityWorkflowReceiver`
- `identityRegistryAddress`: deployed `IdentityRegistry`
- `employeeVestingAddress`: deployed `EmployeeVesting`
- `chainSelectorName`: e.g. `ethereum-testnet-sepolia`
- `gasLimit`: write report gas limit

## Simulate locally

From project root:

```bash
cre workflow simulate ./EquityWorkflowCre --target local-simulation
```

Notes:

- In simulation mode without `--broadcast`, writes are dry-run and tx hash is typically `0x`.
- Workflow code is compiled to WASM by CRE CLI in simulation.

## E2E sync-write test

This repository includes an automated integration test:

- `tests/run-sync-write-test.mjs`

What it validates:

1. Sends `SYNC_KYC` via CRE HTTP trigger (`trigger-index 0`) with `--broadcast`
2. Reads the tx receipt on Base Sepolia and finds the `IdentityRegistry` event index
3. Replays CRE EVM log trigger (`trigger-index 1`) for that tx/event
4. Calls Lambda `readEmployee` and verifies the record is synchronized in DynamoDB

Run from `EquityWorkflowCre`:

```bash
npm run test:sync-write
```

Optional RPC override:

```bash
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org/ npm run test:sync-write
```

If your account gets transient nonce replacement errors (`replacement transaction underpriced`), the test
automatically attempts a nonce-bump transaction (including forced nonce tick when providers do not expose pending txs). You can disable this behavior:

```bash
AUTO_BUMP_NONCE=false npm run test:sync-write
```
