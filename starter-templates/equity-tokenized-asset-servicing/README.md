# Equity Tokenized Asset Servicing (CRE + ERC-3643 + ACE)

End-to-end reference implementation for a tokenized equity protocol with:
- ERC-3643 style compliance and identity controls.
- Chainlink CRE workflow for Web2 <-> Onchain synchronization.
- Chainlink ACE private rail backed by the Chainlink Confidential Compute Vault (CCC Vault).
- Issuer-custodied private rounds market with USDC escrow and settlement/refund lifecycle.

This repository is currently operated in local simulation mode for workflow execution and testing.

## Current Network and Deployment

Network: Ethereum Sepolia (chainId 11155111)
Deployment snapshot file: [`contracts/deployments/equity-latest.sepolia.json`](./contracts/deployments/equity-latest.sepolia.json)
Deployed at: `2026-03-08T16:03:12.953Z`

Verification status: core protocol contracts in this snapshot are verified on Etherscan.

### Core Addresses (latest snapshot)

| Component | Address |
|---|---|
| EquityWorkflowReceiver | [`0x6b9d988880AEEC58Ec06AE2011bAfd9A52Bd398b`](https://sepolia.etherscan.io/address/0x6b9d988880AEEC58Ec06AE2011bAfd9A52Bd398b#code) |
| IdentityRegistry | [`0xFDC59B2169Cb5320c7811629f457be655b47Ae5f`](https://sepolia.etherscan.io/address/0xFDC59B2169Cb5320c7811629f457be655b47Ae5f#code) |
| ComplianceV2 | [`0x85A175a7853d7baC6E442013B5A1E115d822F786`](https://sepolia.etherscan.io/address/0x85A175a7853d7baC6E442013B5A1E115d822F786#code) |
| Token (ERC-3643 rail) | [`0x056068Ea217A09F70Cd415923B1D950cebfe5Cae`](https://sepolia.etherscan.io/address/0x056068Ea217A09F70Cd415923B1D950cebfe5Cae#code) |
| PrivateEmployeeEquity | [`0xF1B6C20118D7817EDb0D7D9c3Ab9eD79a0826289`](https://sepolia.etherscan.io/address/0xF1B6C20118D7817EDb0D7D9c3Ab9eD79a0826289#code) |
| PrivateRoundsMarket | [`0xaeaEcF197147B874E83AE7dEd6A95Ec1f1744213`](https://sepolia.etherscan.io/address/0xaeaEcF197147B874E83AE7dEd6A95Ec1f1744213#code) |
| MockUSDC (6d) | [`0x962B088AFFDc582C4Dd50d2D11bCbE952992A432`](https://sepolia.etherscan.io/address/0x962B088AFFDc582C4Dd50d2D11bCbE952992A432#code) |

### Direct Links (latest E2E validation)

#### Sepolia Explorer

Verified contracts:
- EquityWorkflowReceiver: [`0x6b9d988880AEEC58Ec06AE2011bAfd9A52Bd398b`](https://sepolia.etherscan.io/address/0x6b9d988880AEEC58Ec06AE2011bAfd9A52Bd398b#code)
- IdentityRegistry: [`0xFDC59B2169Cb5320c7811629f457be655b47Ae5f`](https://sepolia.etherscan.io/address/0xFDC59B2169Cb5320c7811629f457be655b47Ae5f#code)
- ComplianceV2: [`0x85A175a7853d7baC6E442013B5A1E115d822F786`](https://sepolia.etherscan.io/address/0x85A175a7853d7baC6E442013B5A1E115d822F786#code)
- Token: [`0x056068Ea217A09F70Cd415923B1D950cebfe5Cae`](https://sepolia.etherscan.io/address/0x056068Ea217A09F70Cd415923B1D950cebfe5Cae#code)
- PrivateEmployeeEquity: [`0xF1B6C20118D7817EDb0D7D9c3Ab9eD79a0826289`](https://sepolia.etherscan.io/address/0xF1B6C20118D7817EDb0D7D9c3Ab9eD79a0826289#code)
- PrivateRoundsMarket: [`0xaeaEcF197147B874E83AE7dEd6A95Ec1f1744213`](https://sepolia.etherscan.io/address/0xaeaEcF197147B874E83AE7dEd6A95Ec1f1744213#code)
- MockUSDC: [`0x962B088AFFDc582C4Dd50d2D11bCbE952992A432`](https://sepolia.etherscan.io/address/0x962B088AFFDc582C4Dd50d2D11bCbE952992A432#code)

#### Tenderly Virtual TestNet

Ticket flow:
- SYNC_KYC: [`0x80ee2e64131c4a7d3a8f453b25f0808aeb450e031f6d333be2c8e2393455d56f`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0x80ee2e64131c4a7d3a8f453b25f0808aeb450e031f6d333be2c8e2393455d56f)
- SYNC_FREEZE_WALLET: [`0x81abc722dd6c2409a3201983bd9e9930c5e1cb4d12791dd00118d4b5b016f600`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0x81abc722dd6c2409a3201983bd9e9930c5e1cb4d12791dd00118d4b5b016f600)
- SYNC_SET_TOKEN_COMPLIANCE: [`0xe8c025024ed41c761f46212ab35a9984f26abe56f67f148b871b208169c5b4be`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0xe8c025024ed41c761f46212ab35a9984f26abe56f67f148b871b208169c5b4be)
- SYNC_SET_CLAIM_REQUIREMENTS (future cliff): [`0x5eee2b62bd0f97c1ad2149a22cfc77926c64af66911a8e71533e11293953579e`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0x5eee2b62bd0f97c1ad2149a22cfc77926c64af66911a8e71533e11293953579e)
- SYNC_EMPLOYMENT_STATUS: [`0x8f329b156bfa8ce4e561f10dd5cd629ab6f6428c99883f66825672490eb35c03`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0x8f329b156bfa8ce4e561f10dd5cd629ab6f6428c99883f66825672490eb35c03)
- SYNC_GOAL (false): [`0xd18d6492d19c83613abc8a99a74cd3e01285cc1c8485dbced3f870b8c4f8a5b3`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0xd18d6492d19c83613abc8a99a74cd3e01285cc1c8485dbced3f870b8c4f8a5b3)
- SYNC_GOAL (true): [`0xb0e8ee7659bd5661b02f0fcc97a403674a9fc00dbe4feda905b91ca9bac5f737`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0xb0e8ee7659bd5661b02f0fcc97a403674a9fc00dbe4feda905b91ca9bac5f737)
- SYNC_SET_CLAIM_REQUIREMENTS (past cliff): [`0x07478748e59386f2070b71d80fab60986a845eb2740c0945b140a7bc3bfc5bc8`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0x07478748e59386f2070b71d80fab60986a845eb2740c0945b140a7bc3bfc5bc8)
- SYNC_MINT: [`0x8fd4a090f79de43946a53f6fcafe7805ba0b8c2bd59f597c38012c2c62bef60d`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0x8fd4a090f79de43946a53f6fcafe7805ba0b8c2bd59f597c38012c2c62bef60d)
- Token approve: [`0x4f3d4152140ae812232540fd970342d26964f964e5bf855e6ba193a7cafe1cf5`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0x4f3d4152140ae812232540fd970342d26964f964e5bf855e6ba193a7cafe1cf5)
- Vault deposit: [`0x76e89f2fb1861c7d36075565d161c7cc6a0c4ed0c40961ab5eb40fecdb975363`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0x76e89f2fb1861c7d36075565d161c7cc6a0c4ed0c40961ab5eb40fecdb975363)

Private rounds market flow:
- buyRound: [`0x94a85e93bea00f3350aeb782653594f12984bfbb9a2109998d4c786347644518`](https://dashboard.tenderly.co/explorer/vnet/3bc9b117-a045-4704-b6fd-e5b17405022d/tx/0x94a85e93bea00f3350aeb782653594f12984bfbb9a2109998d4c786347644518)

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
- `PrivateEmployeeEquity.sol`: employment/goal/cliff gating + CCC Vault deposit rail.
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
3. Admin deposits token liquidity into the Chainlink Confidential Compute Vault (CCC Vault).
4. Private transfer in ACE from admin to employee.
5. Employee requests withdraw ticket from ACE API.
6. Employee redeems onchain with `vault.withdrawWithTicket(token, amount, ticket)` from the CCC Vault.

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

Register/update ACE policy for token in the Chainlink Confidential Compute Vault (CCC Vault):

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
npm --prefix EquityWorkflowCre run test:lambda-cre-ace-ticket
npm --prefix EquityWorkflowCre run test:private-rounds-market
```

Lambda unit tests:

```bash
npm --prefix lambda-function test
```

## Local Simulation Notes

- Current deployed snapshot was generated with `testModeForwarderBypass=true`.
- `SYNC_REDEEM_TICKET` is intentionally disabled in receiver. Ticket redeem must be executed by the employee wallet directly on the CCC Vault.
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

