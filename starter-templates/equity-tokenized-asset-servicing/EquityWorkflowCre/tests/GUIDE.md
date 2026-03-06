# Equity CRE E2E Guide (Current)

Last updated: 2026-03-06

This guide replaces the old interactive runner docs (`tests/run-tests.mjs`).

Current E2E test runners:
- `tests/run-lambda-cre-ace-ticket-flow.mjs`
- `tests/run-private-rounds-market-flow.mjs`

Reference overview:
- `Docs/Main-E2E-Commands.md`

## 1. Prerequisites

| Requirement | Details |
|---|---|
| Node.js | v18 or later |
| CRE CLI | Installed and authenticated (`cre login`) |
| Sepolia ETH | Admin and employee wallets need gas |
| `.env` file | Repo root: `tokenized-asset-servicing/.env` |

## 2. Commands

Run from repository root:

```bash
npm --prefix EquityWorkflowCre run test:lambda-cre-ace-ticket
npm --prefix EquityWorkflowCre run test:private-rounds-market
```

Direct script execution:

```bash
node EquityWorkflowCre/tests/run-lambda-cre-ace-ticket-flow.mjs
node EquityWorkflowCre/tests/run-private-rounds-market-flow.mjs
```

Recommended order:
1. `test:lambda-cre-ace-ticket`
2. `test:private-rounds-market`

## 3. Required Environment Variables

Required for both E2E scripts:

```env
CRE_ETH_PRIVATE_KEY=0x<64_hex_chars>
CRE_EMPLOYEE_ETH_PRIVATE_KEY=0x<64_hex_chars>
```

Also required for Lambda + ACE flow:

```env
LAMBDA_URL=https://<your-lambda-function-url>
```

Notes:
- `LAMBDA_URL` can fallback to `config.staging.json` (`config.url`) but `.env` is recommended.
- `CRE_ETH_PRIVATE_KEY` and `CRE_EMPLOYEE_ETH_PRIVATE_KEY` must resolve to different addresses.

## 4. Optional Environment Variables

Common:
- `SEPOLIA_RPC_URL`
- `USE_DIRECT_RECEIVER_REPORTS`
- `LOG_CRE_OUTPUT`

Lambda + ACE flow (`run-lambda-cre-ace-ticket-flow.mjs`):
- `LOG_ACE_OUTPUT`
- `TOKEN_ADDRESS`
- `ACE_VAULT_ADDRESS`
- `ACE_API_URL`
- `ACE_CHAIN_ID`
- `COMPLIANCE_V2_ADDRESS` (or `COMPLIANCE_ADDRESS`)
- `CRE_EMPLOYEE_IDENTITY_ADDRESS`
- `CRE_ADMIN_IDENTITY_ADDRESS`
- `CRE_ACE_VAULT_IDENTITY_ADDRESS`
- `CRE_EMPLOYEE_COUNTRY`
- `ACE_E2E_AMOUNT_WEI`
- `ACE_EMPLOYEE_MIN_GAS_WEI`
- `STRICT_ONCHAIN_KYC`
- `ACE_SIMULATE_GOAL_CLIFF`
- `ACE_SIMULATED_CLIFF_LEAD_SECONDS`
- `ACE_VESTING_GOAL_ID`

Private rounds flow (`run-private-rounds-market-flow.mjs`):
- `TOKEN_ADDRESS`
- `COMPLIANCE_V2_ADDRESS` (or `COMPLIANCE_ADDRESS`)
- `PRIVATE_ROUNDS_MARKET_ADDRESS`
- `USDC_ADDRESS`
- `PRIVATE_ROUNDS_TREASURY_ADDRESS`

## 5. Flow A: Lambda -> CRE/Receiver -> ACE Ticket -> Redeem

Script:
- `tests/run-lambda-cre-ace-ticket-flow.mjs`

What it validates:
1. Persist employee state in Lambda (`CompanyEmployeeInput`).
2. Onchain sync via CRE/Receiver:
   - `SYNC_KYC`
   - `SYNC_FREEZE_WALLET`
   - compliance and investor authorization baseline
3. Onchain employee requirement checks.
4. Optional simulated vesting gate checks (`employment + goal + cliff`) when enabled.
5. Admin private balance readiness in ACE (mint/deposit if needed).
6. ACE private transfer admin -> employee.
7. Employee withdraw ticket request + onchain `withdrawWithTicket` redeem.

Success banner:
- `SUCCESS: Employee compliant + ACE ticket redeemed`

Execution mode:
- Default: `CRE simulate --broadcast`
- Optional bypass: direct `receiver.onReport()` with `USE_DIRECT_RECEIVER_REPORTS=true`

CRE output behavior:
- Output is streamed live to console, preserving ANSI colors.

## 6. Flow B: Private Rounds Market (USDC + ComplianceV2)

Script:
- `tests/run-private-rounds-market-flow.mjs`

What it validates:
1. Compliance + KYC + investor auth baseline.
2. Round create/open + allowlist setup.
3. Unauthorized buy revert.
4. Authorized buy + oracle settle path.
5. Investor cap enforcement.
6. Oracle refund path.
7. Global resale restrictions:
   - lockup active revert
   - unauthorized recipient revert

Success banner:
- `SUCCESS: Private rounds market + global compliance validated`

Execution mode:
- Default: direct `receiver.onReport()` (`USE_DIRECT_RECEIVER_REPORTS=true`)
- Optional CRE path: set `USE_DIRECT_RECEIVER_REPORTS=false`

## 7. Address Source of Truth

Both scripts load contract addresses from:
- `EquityWorkflowCre/config.staging.json`

Optional `.env` overrides apply for selected addresses.
If required addresses are missing, scripts fail fast.

## 8. Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `Missing CRE_ETH_PRIVATE_KEY` or `Missing CRE_EMPLOYEE_ETH_PRIVATE_KEY` | Missing env vars | Set keys in `.env` |
| `Admin and employee private keys resolve to the same address` | Same private key used twice | Use distinct wallets |
| `Missing LAMBDA_URL (.env or config)` | No Lambda URL configured | Set `LAMBDA_URL` in `.env` or `config.staging.json` |
| `CRE command failed` | CRE CLI missing/auth issue/network issue | Install/login CRE CLI, retry |
| `HTTP payload is not valid JSON` | Broken CLI payload quoting | Use current scripts (already fixed) and avoid manual shell-quoted JSON on Windows |
| `No tx hash found in output` | CRE output changed or broadcast not executed | Ensure `--broadcast` and inspect CLI logs |
| `Missing receiver/token/compliance/market/usdc address` | Incomplete config/env after deploy | Update `config.staging.json` and/or `.env` |
| `Expected revert` checks failing | Compliance/allowlist/lockup state not in expected setup | Re-run baseline steps, verify environment parity |

## 9. Legacy Note

The old guide for `tests/run-tests.mjs` is obsolete.
Use the two E2E scripts above as the canonical test paths.
