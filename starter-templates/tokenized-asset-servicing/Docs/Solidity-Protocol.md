# Solidity Protocol - Technical Guide

## 1) Purpose
This document describes the active on-chain protocol in `contracts/equity-protocol/` used by the tokenized asset servicing flow.

It covers:

- contract responsibilities
- permissions and role model
- CRE report routing (`EquityWorkflowReceiver`)
- events and state transitions
- operational risks and hardening recommendations

## 2) Current protocol status (as of February 25, 2026)
Source of truth used in this review:

- `contracts/deployments/equity-latest.sepolia.json` (`deployedAt: 2026-02-25T00:05:26.113Z`)
- `contracts/equity-protocol/*.sol`
- `contracts/scripts/deploy_equity_new.cjs`

Network snapshot: Ethereum Sepolia (`11155111`).

Active deployed set:

| Contract | Address |
|---|---|
| `EquityWorkflowReceiver` | `0x1C312E03A316Eab45e468bf3a0F8171873cd2188` |
| `IdentityRegistry` | `0x032a3Be70148aE44C362345271485C917eb73355` |
| `ComplianceV2` | `0xEEd878eeA3D23095d5c1939471b0b130f4d9c265` |
| `Token` | `0x1Cd2325cB59A13ED00B7e703f8f052C69943170e` |
| `PrivateEmployeeEquity` | `0x853b8cd153BBB7340489F530FA9968DE7Cb2AAb2` |
| `PrivateRoundsMarket` | `0x39a7b9Bcd125B1396BFfb5aF828bDe229F87C544` |
| `MockUSDC` | `0x58384dFD613F0B8408b4197A031ED1E36F55868c` |
| Treasury | `0xaB6E247B25463F76E81aBAbBb6b0b86B40d45D38` |

External integration addresses:

- CRE forwarder (Sepolia): `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`
- ACE vault: `0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13`

## 3) Contract inventory

### 3.1 Active contracts

| Contract | Role |
|---|---|
| `IdentityRegistry.sol` | KYC identity + country state for wallets. |
| `Token.sol` | ERC-3643-like ERC-20 rail with compliance and freeze controls. |
| `ComplianceV2.sol` | Transfer policy engine (verification, authorization, lockup, trusted counterparties). |
| `PrivateEmployeeEquity.sol` | Oracle-driven employment/goal/claim requirement gating + ACE vault deposit rail. |
| `PrivateRoundsMarket.sol` | Issuer-custodied private rounds with USDC escrow and off-chain settlement confirmation. |
| `EquityWorkflowReceiver.sol` | CRE report entrypoint and action dispatcher (`0..17`). |
| `MockUSDC.sol` | 6-decimal test stablecoin for round purchases in non-production flows. |

### 3.2 Legacy contracts still in repo

- `Compliance.sol`
- `EmployeeVesting.sol`

These are retained for compatibility/history but are not the primary deployed path in the latest snapshot.

## 4) Dependency map

```text
EquityWorkflowReceiver
  -> IdentityRegistry (register/delete/setCountry)
  -> PrivateEmployeeEquity (employment, goals, claim requirements, ACE deposits)
  -> Token (freeze, mint, setCompliance)
  -> ComplianceV2 (investor auth/lockup)
  -> PrivateRoundsMarket (round lifecycle, settlement/refunds)

Token
  -> IdentityRegistry (isVerified)
  -> Compliance (interface; runtime target is ComplianceV2)

ComplianceV2
  -> IdentityRegistry (verification gate)

PrivateRoundsMarket
  -> ComplianceV2 (investor authorization)
  -> IdentityRegistry (investor verification)
  -> MockUSDC/USDC (escrow + treasury/refund transfers)

PrivateEmployeeEquity
  -> ACE Vault (deposit/withdraw rail)
  -> Token (approve/deposit token flow)
```

## 5) `EquityWorkflowReceiver.sol`

### 5.1 Responsibility
Main on-chain bridge for Chainlink CRE reports. It decodes `(uint8 actionType, bytes payload)` and routes to protocol modules.

### 5.2 Supported action map (`0..17`)

- `0` `SYNC_KYC`
- `1` `SYNC_EMPLOYMENT_STATUS`
- `2` `SYNC_GOAL`
- `3` `SYNC_FREEZE_WALLET`
- `4` `SYNC_PRIVATE_DEPOSIT`
- `5` `SYNC_BATCH`
- `6` `SYNC_REDEEM_TICKET` (disabled, reverts)
- `7` `SYNC_MINT`
- `8` `SYNC_SET_CLAIM_REQUIREMENTS`
- `9` `SYNC_SET_INVESTOR_AUTH`
- `10` `SYNC_SET_INVESTOR_LOCKUP`
- `11` `SYNC_CREATE_ROUND`
- `12` `SYNC_SET_ROUND_ALLOWLIST`
- `13` `SYNC_OPEN_ROUND`
- `14` `SYNC_CLOSE_ROUND`
- `15` `SYNC_MARK_PURCHASE_SETTLED`
- `16` `SYNC_REFUND_PURCHASE`
- `17` `SYNC_SET_TOKEN_COMPLIANCE`

### 5.3 Batch behavior
`SYNC_BATCH` decodes `bytes[]`, and each item must be a full encoded sub-report (`abi.encode(uint8, bytes)`), not a raw payload.

### 5.4 Key events/errors

- `SyncActionExecuted(ActionType, bytes)`
- `TargetsUpdated(...)`
- `UnsupportedAction`, `RedeemTicketDisabled`, `ComplianceTargetNotSet`, `MarketTargetNotSet`

## 6) `IdentityRegistry.sol`

### 6.1 Responsibility
Stores minimal KYC identity state per wallet.

### 6.2 State

- `_identities[user] => identity`
- `_countries[user] => country`
- auxiliary registry pointers (`identityStorage`, `claimTopicsRegistry`, `trustedIssuersRegistry`, `topicsRegistry`)

### 6.3 Core functions

- `registerIdentity(address user, address identity, uint16 country)`
- `deleteIdentity(address user)`
- `setCountry(address user, uint16 country)`
- `identity(address)`
- `investorCountry(address)`
- `isVerified(address)`

All business mutations are `onlyOwner`.

### 6.4 Main events

- `IdentityRegistered`
- `IdentityRemoved`
- `CountryUpdated`

## 7) `Token.sol` (ERC-3643-like rail)

### 7.1 Responsibility
ERC-20 token with compliance and transfer restrictions.

### 7.2 Transfer checks (`transfer` and `transferFrom`)

1. token is not paused
2. sender and receiver wallets are not frozen
3. sender has enough free balance (`balance - frozenTokens`)
4. sender and receiver are verified in `IdentityRegistry`
5. `compliance.canTransfer(...) == true`

If successful, it notifies `compliance.transferred(...)`.

### 7.3 Admin functions (`onlyOwner`)

- `setIdentityRegistry`
- `setCompliance`
- `pause` / `unpause`
- `setAddressFrozen`
- `freezePartialTokens`
- `forcedTransfer`
- `mint`
- `burn`

### 7.4 Important compatibility detail
`Token` is typed against `ICompliance` but can point to `ComplianceV2` because `IComplianceV2` extends `ICompliance`.

## 8) `ComplianceV2.sol`

### 8.1 Responsibility
Global transfer policy for the token rail.

### 8.2 Policy behavior (`canTransfer`)

- Mint (`from == 0x0`): receiver must be verified and either trusted or authorized.
- Burn (`to == 0x0`): allowed.
- Normal transfer:
  - both parties verified
  - trusted counterparty path bypasses investor authorization checks
  - otherwise receiver must be authorized
  - sender lockup enforced for authorized investors

### 8.3 Roles

- `onlyOwner`: bind/unbind token, set identity registry, manage trusted counterparties, manage agents.
- `onlyAgentOrOwner`: set investor authorization and lockup.
- `onlyBoundToken`: transfer hooks (`transferred/created/destroyed`).

### 8.4 Events

- `IdentityRegistryUpdated`
- `AgentUpdated`
- `InvestorAuthorizationUpdated`
- `InvestorLockupUpdated`
- `TrustedCounterpartyUpdated`

## 9) `PrivateEmployeeEquity.sol`

### 9.1 Responsibility
Oracle-managed private servicing module replacing vesting-heavy flow with:

- employment status gating
- goal status gating
- per-employee claim requirements (cliff + optional goal)
- ACE vault deposit rail (`depositToVault`)

### 9.2 Access control

- `onlyOwner`: `setOracleStatus`
- `onlyOracle` (or owner):
  - `updateEmploymentStatus`
  - `setGoalAchieved`
  - `setClaimRequirements`
  - `depositToVault`
  - `redeemTicket` (function exists, but CRE path is intentionally disabled)

### 9.3 Eligibility evaluation
`isEmployeeEligible(employee)` returns true only when configured requirements are met:

- employment status active
- cliff time reached
- goal achieved if goal is required

Receiver uses this eligibility to auto-freeze/unfreeze wallets.

## 10) `PrivateRoundsMarket.sol`

### 10.1 Responsibility
Private issuance rounds with USDC escrow and delayed settlement confirmation.

### 10.2 Round lifecycle

- `createRound` -> `DRAFT`
- `openRound` -> `OPEN`
- `closeRound` -> `CLOSED`
- `cancelRound` -> `CANCELLED`

### 10.3 Purchase lifecycle

1. Investor calls `buyRound(roundId, usdcAmount, aceRecipientCommitment)`.
2. Contract checks verification + compliance authorization + allowlist cap + round cap.
3. USDC is escrowed in market contract, purchase stored as `PENDING`.
4. Oracle finalizes with `markPurchaseSettled(purchaseId, aceTransferRef)` and funds move to treasury.
5. Refund path:
   - buyer timeout-based `refundPurchase`
   - oracle-forced `refundPurchaseByOracle`

### 10.4 Core events

- `RoundCreated`, `RoundOpened`, `RoundClosed`, `RoundCancelled`
- `PurchaseRequested`, `PurchaseSettled`, `PurchaseRefunded`

## 11) `ReceiverTemplate.sol` security layer

`onReport(metadata, report)` validates:

- trusted `forwarderAddress` caller
- optional `expectedWorkflowId`
- optional `expectedAuthor`
- optional `expectedWorkflowName` (enforced only when author is set)

Critical note: setting forwarder to `address(0)` disables caller validation.

## 12) Deployed permission model
After `deploy_equity_new.cjs`:

- `IdentityRegistry` ownership -> `EquityWorkflowReceiver`
- `Token` ownership -> `EquityWorkflowReceiver`
- `PrivateEmployeeEquity` oracle -> `EquityWorkflowReceiver`
- `ComplianceV2` agent -> `EquityWorkflowReceiver`
- `PrivateRoundsMarket` oracle -> `EquityWorkflowReceiver`

Additional bootstrap:

- `ComplianceV2.bindToken(token)`
- trusted counterparties include `PrivateEmployeeEquity`, `EquityWorkflowReceiver`, `PrivateRoundsMarket`
- ACE vault receives baseline authorization
- deployer and private-equity module are registered in identity registry for mint/deposit bootstrap



## 13) Related documentation

- System-wide guide: `Docs/Comprehensive-Documentation.md`
- CRE workflow guide: `Docs/Workflow-CRE-Chainlink.md`
