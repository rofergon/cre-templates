# EquityWorkflowCre

CRE workflow for this repo's current stack:
- `IdentityRegistry + Token + ComplianceV2 + PrivateEmployeeEquity + PrivateRoundsMarket`
- ACE private rail integration (private transfer + withdraw ticket)
- Lambda/DynamoDB bidirectional synchronization

Current mode in this repository: local simulation oriented (`local-simulation` target).

## Current Onchain Targets (Sepolia)

From `contracts/deployments/equity-latest.sepolia.json`:

- Receiver: `0x1C312E03A316Eab45e468bf3a0F8171873cd2188`
- IdentityRegistry: `0x032a3Be70148aE44C362345271485C917eb73355`
- ComplianceV2: `0xEEd878eeA3D23095d5c1939471b0b130f4d9c265`
- Token: `0x1Cd2325cB59A13ED00B7e703f8f052C69943170e`
- PrivateEmployeeEquity: `0x853b8cd153BBB7340489F530FA9968DE7Cb2AAb2`
- PrivateRoundsMarket: `0x39a7b9Bcd125B1396BFfb5aF828bDe229F87C544`
- MockUSDC: `0x58384dFD613F0B8408b4197A031ED1E36F55868c`
- ACE Vault: `0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13`

## Supported HTTP Actions

### Onchain sync actions (encoded to `receiver.onReport`)

| Action | Type ID | Purpose |
|---|---:|---|
| `SYNC_KYC` | 0 | Register/update/remove identity in `IdentityRegistry` |
| `SYNC_EMPLOYMENT_STATUS` | 1 | Update employment in `PrivateEmployeeEquity` |
| `SYNC_GOAL` | 2 | Update goal status in `PrivateEmployeeEquity` |
| `SYNC_FREEZE_WALLET` | 3 | Freeze/unfreeze address in `Token` |
| `SYNC_PRIVATE_DEPOSIT` | 4 | Deposit protocol tokens to ACE vault via `PrivateEmployeeEquity` |
| `SYNC_BATCH` | 5 | Execute multiple nested actions in one tx |
| `SYNC_REDEEM_TICKET` | 6 | Disabled by design |
| `SYNC_MINT` | 7 | Mint token via `Token.mint` |
| `SYNC_SET_CLAIM_REQUIREMENTS` | 8 | Set cliff/goal gating in `PrivateEmployeeEquity` |
| `SYNC_SET_INVESTOR_AUTH` | 9 | Update investor authorization in `ComplianceV2` |
| `SYNC_SET_INVESTOR_LOCKUP` | 10 | Update lockup in `ComplianceV2` |
| `SYNC_CREATE_ROUND` | 11 | Create market round |
| `SYNC_SET_ROUND_ALLOWLIST` | 12 | Set per-investor cap for round |
| `SYNC_OPEN_ROUND` | 13 | Open round |
| `SYNC_CLOSE_ROUND` | 14 | Close round |
| `SYNC_MARK_PURCHASE_SETTLED` | 15 | Mark purchase settled + release USDC to treasury |
| `SYNC_REFUND_PURCHASE` | 16 | Refund pending purchase |
| `SYNC_SET_TOKEN_COMPLIANCE` | 17 | Update token compliance contract |

### ACE API actions (offchain REST path)

- `ACE_GENERATE_SHIELDED_ADDRESS`
- `ACE_PRIVATE_TRANSFER`
- `ACE_WITHDRAW_TICKET`

Default ACE API base: `https://convergence2026-token-api.cldev.cloud`

## Forwarded Onchain Events -> Lambda

`main.ts` decodes and forwards these events:

- `IdentityRegistered`
- `IdentityRemoved`
- `CountryUpdated`
- `EmploymentStatusUpdated`
- `GoalUpdated`
- `PrivateDeposit`
- `TicketRedeemed`
- `InvestorAuthorizationUpdated`
- `InvestorLockupUpdated`
- `RoundCreated`
- `RoundOpened`
- `RoundClosed`
- `PurchaseRequested`
- `PurchaseSettled`
- `PurchaseRefunded`

Trigger addresses are built from config:
- `identityRegistryAddress`
- `acePrivacyManagerAddress`
- optional `complianceV2Address`
- optional `privateRoundsMarketAddress`

## Configuration

Files:
- `config.staging.json`
- `config.production.json`
- `workflow.yaml`

`config` fields used by schema:
- `url` (fallback Lambda URL in simulation)
- `aceApiUrl`
- `evms[0].receiverAddress`
- `evms[0].identityRegistryAddress`
- `evms[0].acePrivacyManagerAddress`
- `evms[0].complianceV2Address` (optional)
- `evms[0].privateRoundsMarketAddress` (optional)
- `evms[0].usdcAddress` (optional)
- `evms[0].treasuryAddress` (optional)
- `evms[0].aceVaultAddress`
- `evms[0].aceChainId` (optional)
- `evms[0].chainSelectorName`
- `evms[0].gasLimit`

## Secrets Behavior

- For Lambda sync URL:
  - tries secret `LAMBDA_URL` first,
  - falls back to `config.url`.
- For ACE signer private key:
  - tries secrets in order: `ACE_API_SIGNER_PRIVATE_KEY`, `ACE_API_PRIVATE_KEY`, `PRIVATE_KEY`.

In local simulation, `.env` + config are commonly used.

## Install

```bash
npm --prefix EquityWorkflowCre install
```

## Run Workflow Simulation

Basic simulation:

```bash
cre workflow simulate ./EquityWorkflowCre --target local-simulation --non-interactive --trigger-index 0
```

Broadcast a JSON payload safely from Node (recommended for Windows/PowerShell quoting issues):

```bash
node -e "const {spawnSync}=require('child_process'); const p=JSON.stringify({action:'SYNC_KYC',employeeAddress:'0xYourAddress',verified:true,identityAddress:'0x00000000000000000000000000000000000000E5',country:840}); const r=spawnSync('cre',['workflow','simulate','./EquityWorkflowCre','--target','local-simulation','--non-interactive','--trigger-index','0','--http-payload',p,'--broadcast'],{encoding:'utf8'}); console.log(r.stdout); console.error(r.stderr); process.exit(r.status||0);"
```

## Test Commands

From repo root:

```bash
npm --prefix EquityWorkflowCre run test:sync-write
npm --prefix EquityWorkflowCre run test:lambda-sync
npm --prefix EquityWorkflowCre run test:lambda-cre-ace-ticket
npm --prefix EquityWorkflowCre run test:private-rounds-market
```

Main E2E scripts:
- `tests/run-lambda-cre-ace-ticket-flow.mjs`
- `tests/run-private-rounds-market-flow.mjs`

## Required Environment Variables for E2E

Minimum:
- `CRE_ETH_PRIVATE_KEY`
- `CRE_EMPLOYEE_ETH_PRIVATE_KEY`
- `LAMBDA_URL` (or `config.url` fallback)

Common optional:
- `SEPOLIA_RPC_URL`
- `STRICT_ONCHAIN_KYC`
- `ACE_E2E_AMOUNT_WEI`
- `ACE_EMPLOYEE_MIN_GAS_WEI`
- `CRE_EMPLOYEE_IDENTITY_ADDRESS`
- `CRE_ADMIN_IDENTITY_ADDRESS`
- `CRE_ACE_VAULT_IDENTITY_ADDRESS`

## Important Notes

- `SYNC_REDEEM_TICKET` is intentionally disabled in receiver.
  Use `ACE_WITHDRAW_TICKET` and redeem directly from employee wallet with `vault.withdrawWithTicket(...)`.
- This workflow is currently operated for Sepolia/local-simulation validation and demos.
