# Equity Tokenized Asset Servicing (CRE + ERC-3643 + ACE)

End-to-end reference implementation for a tokenized equity protocol with:
- ERC-3643 style compliance and identity controls.
- Chainlink CRE workflow for Web2 <-> Onchain synchronization.
- Chainlink ACE private rail (private balances, private transfers, withdraw ticket redemption).
- Issuer-custodied private rounds market with USDC escrow and settlement/refund lifecycle.

This repository is currently operated in local simulation mode for workflow execution and testing.

## Current Network and Deployment

Network: Ethereum Sepolia (chainId 11155111)
Deployment snapshot file: [`contracts/deployments/equity-latest.sepolia.json`](./contracts/deployments/equity-latest.sepolia.json)
Deployed at: `2026-02-25T00:05:26.113Z`

### Core Addresses (latest snapshot)

| Component | Address |
|---|---|
| CRE Forwarder (Sepolia) | [`0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`](https://sepolia.etherscan.io/address/0x82300bd7c3958625581cc2f77bc6464dcecdf3e5) |
| ACE Vault (official demo) | [`0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13`](https://sepolia.etherscan.io/address/0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13) |
| EquityWorkflowReceiver | [`0x1C312E03A316Eab45e468bf3a0F8171873cd2188`](https://sepolia.etherscan.io/address/0x1C312E03A316Eab45e468bf3a0F8171873cd2188) |
| IdentityRegistry | [`0x032a3Be70148aE44C362345271485C917eb73355`](https://sepolia.etherscan.io/address/0x032a3Be70148aE44C362345271485C917eb73355) |
| ComplianceV2 | [`0xEEd878eeA3D23095d5c1939471b0b130f4d9c265`](https://sepolia.etherscan.io/address/0xEEd878eeA3D23095d5c1939471b0b130f4d9c265) |
| Token (ERC-3643 rail) | [`0x1Cd2325cB59A13ED00B7e703f8f052C69943170e`](https://sepolia.etherscan.io/address/0x1Cd2325cB59A13ED00B7e703f8f052C69943170e) |
| PrivateEmployeeEquity | [`0x853b8cd153BBB7340489F530FA9968DE7Cb2AAb2`](https://sepolia.etherscan.io/address/0x853b8cd153BBB7340489F530FA9968DE7Cb2AAb2) |
| PrivateRoundsMarket | [`0x39a7b9Bcd125B1396BFfb5aF828bDe229F87C544`](https://sepolia.etherscan.io/address/0x39a7b9Bcd125B1396BFfb5aF828bDe229F87C544) |
| MockUSDC (6d) | [`0x58384dFD613F0B8408b4197A031ED1E36F55868c`](https://sepolia.etherscan.io/address/0x58384dFD613F0B8408b4197A031ED1E36F55868c) |
| Treasury | [`0xaB6E247B25463F76E81aBAbBb6b0b86B40d45D38`](https://sepolia.etherscan.io/address/0xaB6E247B25463F76E81aBAbBb6b0b86B40d45D38) |
| ACE Policy Engine | [`0x49e337bc25b3e957bF9Ca8165666f2147b61669f`](https://sepolia.etherscan.io/address/0x49e337bc25b3e957bF9Ca8165666f2147b61669f) |

## GitHub Directory

Main modules:
- [`/EquityWorkflowCre`](./EquityWorkflowCre) - CRE workflow (`main.ts`), configs and E2E tests.
- [`/contracts`](./contracts) - Hardhat project, deployment scripts and interfaces.
- [`/contracts/equity-protocol`](./contracts/equity-protocol) - core onchain protocol contracts.
- [`/lambda-function`](./lambda-function) - Lambda sync backend for DynamoDB and CRE orchestration.
- [`/ace-private-transfers`](./ace-private-transfers) - ACE Foundry scripts and API scripts.

Key docs and artifacts:
- [`/README.md`](./README.md) - project overview and operations.
- [`/protocol_coherence_report.md`](./protocol_coherence_report.md) - coherence review and findings.
- [`/contracts/deployments/equity-latest.sepolia.json`](./contracts/deployments/equity-latest.sepolia.json) - latest deployed addresses.
- [`/equity_cre_architecture.svg`](./equity_cre_architecture.svg) - high-level architecture diagram.
- [`/equity_solidity_architecture.svg`](./equity_solidity_architecture.svg) - solidity architecture diagram.

## Architecture

### 1) CRE workflow (`EquityWorkflowCre/main.ts`)

The workflow supports both HTTP-triggered writes and log-triggered sync back to Lambda.

Onchain actions (actionType 0..17):
- `SYNC_KYC` (0)
- `SYNC_EMPLOYMENT_STATUS` (1)
- `SYNC_GOAL` (2)
- `SYNC_FREEZE_WALLET` (3)
- `SYNC_PRIVATE_DEPOSIT` (4)
- `SYNC_BATCH` (5)
- `SYNC_REDEEM_TICKET` (6, disabled by design)
- `SYNC_MINT` (7)
- `SYNC_SET_CLAIM_REQUIREMENTS` (8)
- `SYNC_SET_INVESTOR_AUTH` (9)
- `SYNC_SET_INVESTOR_LOCKUP` (10)
- `SYNC_CREATE_ROUND` (11)
- `SYNC_SET_ROUND_ALLOWLIST` (12)
- `SYNC_OPEN_ROUND` (13)
- `SYNC_CLOSE_ROUND` (14)
- `SYNC_MARK_PURCHASE_SETTLED` (15)
- `SYNC_REFUND_PURCHASE` (16)
- `SYNC_SET_TOKEN_COMPLIANCE` (17)

ACE API actions from CRE:
- `ACE_GENERATE_SHIELDED_ADDRESS`
- `ACE_PRIVATE_TRANSFER`
- `ACE_WITHDRAW_TICKET`

ACE API base used by default:
- `https://convergence2026-token-api.cldev.cloud`

### 2) Onchain protocol (`contracts/equity-protocol`)

Main contracts:
- `IdentityRegistry.sol`: KYC identity and country state.
- `Token.sol`: ERC-3643-like token with freeze, mint, burn, forced transfer.
- `ComplianceV2.sol`: global transfer policy:
  - verified identities required,
  - authorized-investor gating,
  - lockup enforcement,
  - trusted counterparties,
  - mint restricted to authorized/trusted verified receivers.
- `PrivateEmployeeEquity.sol`: employment/goal/cliff gating + ACE vault deposit rail.
- `PrivateRoundsMarket.sol`: private rounds with allowlist caps, USDC escrow, purchase states (`PENDING`, `SETTLED`, `REFUNDED`), settlement/refund paths.
- `EquityWorkflowReceiver.sol`: single CRE entry point that dispatches all action types.

### 3) Lambda backend (`lambda-function/index.mjs`)

Persists state in DynamoDB and can trigger CRE sync payloads for:
- employee state,
- investor authorization/lockup,
- rounds and allowlists,
- purchase settlement/refund idempotency.

## End-to-end Flows

### A) Employee compliance + ACE ticket redemption

1. Company updates employee state in Lambda.
2. CRE executes onchain sync (KYC, freeze, requirements, etc.).
3. Admin deposits token liquidity into ACE vault via private rail.
4. Private transfer in ACE from admin to employee.
5. Employee requests withdraw ticket from ACE API.
6. Employee redeems onchain with `vault.withdrawWithTicket(token, amount, ticket)`.

Script:
- `npm --prefix EquityWorkflowCre run test:lambda-cre-ace-ticket`

### B) Private rounds market (issuer custody)

1. KYC and investor authorization synced onchain.
2. Round is created/opened and allowlist caps are configured.
3. Investor buys with USDC (`buyRound`) -> purchase `PENDING`.
4. Oracle marks settlement (`SYNC_MARK_PURCHASE_SETTLED`) after ACE private delivery.
5. If settlement fails/expires, refund path is executed (`SYNC_REFUND_PURCHASE` / buyer timeout).
6. Global resale restrictions enforced by `ComplianceV2`.

Script:
- `npm --prefix EquityWorkflowCre run test:private-rounds-market`

## Prerequisites

- Node.js 18+
- npm
- CRE CLI installed and authenticated
- Sepolia ETH for signer wallets
- AWS account + Lambda URL + DynamoDB table (for backend integration)

Optional:
- Foundry (for ACE policy engine flows under `ace-private-transfers`)

## Environment Setup

Create `.env` from `.env.example` at repo root.

Minimum variables for main E2E:
- `CRE_ETH_PRIVATE_KEY`
- `CRE_EMPLOYEE_ETH_PRIVATE_KEY`
- `LAMBDA_URL`
- `SEPOLIA_RPC_URL` (optional, defaults are present in scripts)

Useful optional variables:
- `STRICT_ONCHAIN_KYC=false` (for local simulation only)
- `ACE_E2E_AMOUNT_WEI`
- `ACE_EMPLOYEE_MIN_GAS_WEI`
- `ACE_POLICY_ENGINE_ADDRESS`
- `PRIVATE_ROUNDS_SETTLEMENT_TIMEOUT_SECONDS`

## Install

```bash
npm --prefix contracts install
npm --prefix EquityWorkflowCre install
npm --prefix lambda-function install
npm --prefix ace-private-transfers/api-scripts install
```

## Build and Deploy

Compile contracts:

```bash
npm --prefix contracts run compile
```

Full redeploy (standard):

```bash
npm --prefix contracts run deploy:equity:new
```

Full redeploy in local testing mode (forwarder bypass + auto config/env updates):

```bash
npm --prefix contracts run deploy:equity:new:test-mode
```

Register/update ACE policy for token in official ACE vault:

```bash
npm --prefix contracts run ace:setup-policy
```

## CRE Workflow Commands

Local simulation compile/run:

```bash
cre workflow simulate ./EquityWorkflowCre --target local-simulation --non-interactive --trigger-index 0
```

Broadcast a payload to onchain receiver from local simulation:

```bash
node -e "const {spawnSync}=require('child_process'); const p=JSON.stringify({action:'SYNC_KYC',employeeAddress:'0xYourAddress',verified:true,identityAddress:'0x00000000000000000000000000000000000000E5',country:840}); const r=spawnSync('cre',['workflow','simulate','./EquityWorkflowCre','--target','local-simulation','--non-interactive','--trigger-index','0','--http-payload',p,'--broadcast'],{encoding:'utf8'}); console.log(r.stdout); console.error(r.stderr); process.exit(r.status||0);"
```

## Test Commands

CRE and protocol E2E:

```bash
npm --prefix EquityWorkflowCre run test:sync-write
npm --prefix EquityWorkflowCre run test:lambda-sync
npm --prefix EquityWorkflowCre run test:lambda-cre-ace-ticket
npm --prefix EquityWorkflowCre run test:private-rounds-market
```

Lambda unit tests:

```bash
npm --prefix lambda-function test
```

## Local Simulation Notes

- Current deployed snapshot was generated with `testModeForwarderBypass=true`.
- `SYNC_REDEEM_TICKET` is intentionally disabled in receiver. Ticket redeem must be executed by the employee wallet directly on ACE vault.
- `EquityWorkflowCre/config.staging.json` and `config.production.json` are now git-ignored locally to avoid leaking Lambda URLs.
- `secrets.yaml` is only required for deployed CRE targets. For local simulation, config + `.env` are sufficient.

## Diagrams

- Full architecture: `equity_cre_architecture.svg`
- Solidity architecture: `equity_solidity_architecture.svg`
- CRE internal flow: `cre_internal_workflow.svg`
- ACE ticket flow: `cre_lambda_ace_ticket_workflow.svg`
- Private market flow: `equity_private_market_liquidity.svg`

## Known Boundaries

- USDC payment leg is public onchain in this phase.
- ACE privacy is applied to the token leg (private balances/transfers/tickets), not USDC.
- This repo is configured for Sepolia testing and demo workflows, not production hardening.
