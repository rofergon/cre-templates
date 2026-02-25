# Equity Protocol Contracts (ERC-3643 + ACE + Private Rounds)

This directory contains the current onchain protocol used by the repository.

Network focus: Ethereum Sepolia (`11155111`)
Deployment snapshot source: `../deployments/equity-latest.sepolia.json`

## Current Deployed Addresses (latest snapshot)

| Contract | Address |
|---|---|
| `EquityWorkflowReceiver` | `0x1C312E03A316Eab45e468bf3a0F8171873cd2188` |
| `IdentityRegistry` | `0x032a3Be70148aE44C362345271485C917eb73355` |
| `ComplianceV2` | `0xEEd878eeA3D23095d5c1939471b0b130f4d9c265` |
| `Token` (ERC-3643 rail) | `0x1Cd2325cB59A13ED00B7e703f8f052C69943170e` |
| `PrivateEmployeeEquity` | `0x853b8cd153BBB7340489F530FA9968DE7Cb2AAb2` |
| `PrivateRoundsMarket` | `0x39a7b9Bcd125B1396BFfb5aF828bDe229F87C544` |
| `MockUSDC` | `0x58384dFD613F0B8408b4197A031ED1E36F55868c` |
| Treasury | `0xaB6E247B25463F76E81aBAbBb6b0b86B40d45D38` |

Related external addresses:
- CRE forwarder (Sepolia): `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`
- ACE vault (official demo): `0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13`

## Contract Set

### Active contracts

- `IdentityRegistry.sol`
  - KYC identity + country state.
- `Token.sol`
  - ERC-3643-like token with compliance hook, wallet freeze, mint/burn, forced transfer.
- `ComplianceV2.sol`
  - Global transfer controls:
    - verified sender/receiver,
    - authorized investor checks,
    - lockup enforcement,
    - trusted counterparties,
    - mint receiver must be verified and authorized/trusted.
- `PrivateEmployeeEquity.sol`
  - Employment/goal/cliff eligibility and ACE vault deposit rail.
- `PrivateRoundsMarket.sol`
  - Issuer-custodied rounds with USDC escrow and purchase states (`PENDING`, `SETTLED`, `REFUNDED`).
- `MockUSDC.sol`
  - 6-decimals mock stablecoin for test flows.
- `EquityWorkflowReceiver.sol`
  - CRE report entrypoint and dispatcher (actionType 0..17).

### Legacy contracts kept in repo

- `Compliance.sol`
- `EmployeeVesting.sol`

They are not the primary path in the current deployed flow.

## Receiver Action Map (0..17)

`EquityWorkflowReceiver` processes:

- `0` `SYNC_KYC`
- `1` `SYNC_EMPLOYMENT_STATUS`
- `2` `SYNC_GOAL`
- `3` `SYNC_FREEZE_WALLET`
- `4` `SYNC_PRIVATE_DEPOSIT`
- `5` `SYNC_BATCH`
- `6` `SYNC_REDEEM_TICKET` (disabled)
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

## Permission and Role Model

After `deploy_equity_new.cjs`:

- `IdentityRegistry` ownership -> `EquityWorkflowReceiver`
- `Token` ownership -> `EquityWorkflowReceiver`
- `PrivateEmployeeEquity` oracle -> `EquityWorkflowReceiver`
- `ComplianceV2` agent -> `EquityWorkflowReceiver`
- `PrivateRoundsMarket` oracle -> `EquityWorkflowReceiver`

Additional bootstrap setup in deploy script:
- `ComplianceV2.bindToken(token)`
- trusted counterparties include `PrivateEmployeeEquity`, `EquityWorkflowReceiver`, `PrivateRoundsMarket`
- ACE vault address gets investor authorization baseline
- deployer + private-equity addresses are registered in `IdentityRegistry` for bootstrap mint/deposit compatibility

## Build and Deploy Commands

From repo root:

Install:

```bash
npm --prefix contracts install
```

Compile:

```bash
npm --prefix contracts run compile
```

Full deploy (standard):

```bash
npm --prefix contracts run deploy:equity:new
```

Full deploy in local testing mode (receiver forwarder bypass):

```bash
npm --prefix contracts run deploy:equity:new:test-mode
```

ACE policy setup/verification for vault registration:

```bash
npm --prefix contracts run ace:setup-policy
```

## Important Operational Notes

- `SYNC_REDEEM_TICKET` is intentionally disabled in receiver to prevent server-side redemption.
  Final redeem is executed by end-user wallet via `vault.withdrawWithTicket(token, amount, ticket)`.
- The current snapshot was deployed with `testModeForwarderBypass=true`.
  This is useful for local simulation and direct `onReport` tests, not production hardening.
- Refund accounting in `PrivateRoundsMarket` releases both round sold capacity and investor purchased capacity.

## Visual Architecture

- Solidity architecture diagram: `../../equity_solidity_architecture.svg`
- System architecture diagram: `../../equity_cre_architecture.svg`
