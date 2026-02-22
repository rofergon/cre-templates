# Equity Solidity Protocol (Tokenized Asset Servicing)

This directory contains the smart contracts (written in Solidity) that make up the protocol for managing equity and tokenized assets, integrating compliance rules, identity management, and employee vesting schedules.

Furthermore, the protocol is designed to receive verified off-chain information through Chainlink CRE (Compute Runtime Environment) oracles and workflows.

## Contract Architecture

Below is the architecture and flow diagram of the protocol's contracts:

![Solidity Architecture](../../equity_solidity_architecture.svg)

## Deployed Contracts (Base Sepolia Testnet)

| Contract | Address |
|---|---|
| `EquityWorkflowReceiver` | `0x1a8d23329cf8641c6645b15Da2896Bd307b56B4a` |
| `IdentityRegistry` | `0x1Ee184656d3E440c04bB874FDBdDA8Ba07F3E1A6` |
| `EmployeeVesting` | `0xe875A81E95c276816e877dDC03A153465d0D9999` |
| `Token` (ERC-3643 `EQT`) | `0xB4FE5972D8cD70494DE061471bb59BAC6F7c3c4F` |

> **Ownership model**: Ownership of `IdentityRegistry` and `Token` has been transferred to `EquityWorkflowReceiver`. `EquityWorkflowReceiver` is also registered as an oracle in `EmployeeVesting`. This means all state changes flow exclusively through CRE-verified reports.

> **Chainlink Forwarder (Base Sepolia)**: `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`

## Main Components

### 1. ERC-3643 Token (`Token.sol` & `IERC3643.sol`)
The core of the tokenized asset. It implements the ERC-3643 standard (with backward compatibility to ERC-20 interfaces), designed or adapted to handle financial assets and security tokens. This contract ensures close interaction with the identity registry system and compliance rules before allowing transfers.

Key operations routed through CRE:
- `setAddressFrozen(address, bool)` — called by `SYNC_FREEZE_WALLET`

### 2. Identity Management (`IdentityRegistry.sol` & `IIdentityRegistry.sol`)
Manages the credentials and KYC/AML verification status of the different addresses (wallets) in the ecosystem. A user can only receive or operate with tokens if they maintain a valid status within this registry.

Key operations routed through CRE:
- `registerIdentity(address, address, uint16)` — called by `SYNC_KYC` when `verified=true` and identity not yet registered
- `deleteIdentity(address)` — called by `SYNC_KYC` when `verified=false`
- `setCountry(address, uint16)` — called by `SYNC_KYC` when identity already registered and country changes

### 3. Compliance Rules (`Compliance.sol` & `ICompliance.sol`)
Acts as a plug-and-play module that validates whether a transfer complies with regulations (e.g., holding limits, transfer blocks between certain countries, or frozen wallet controls). The Token contract is bound to `Compliance` via `bindToken()` during deployment.

### 4. Employee Vesting (`EmployeeVesting.sol`)
A specialized contract for the creation and administration of contractual plans (*grants*) for employees. It includes:
- **Cliff periods** and linear *Vesting* duration.
- **Revocable Grants**: allowing compensation schemes to be frozen if the employment relationship is terminated.
- **Performance Goals**: vesting can depend on meeting business metrics that are validated through oracles.

Key operations routed through CRE:
- `updateEmploymentStatus(address, bool)` — called by `SYNC_EMPLOYMENT_STATUS`
- `setGoalAchieved(bytes32, bool)` — called by `SYNC_GOAL`

### 5. Smart Chain Workflow (`EquityWorkflowReceiver.sol`)
The bridge contract that receives reports calculated by Chainlink CRE. It translates payloads created off-chain into on-chain state updates by processing multiple types of actions, such as:
- `SYNC_KYC` (0): Synchronizes user verification information with the `IdentityRegistry`.
- `SYNC_EMPLOYMENT_STATUS` (1): Modifies an employee's employment status in `EmployeeVesting`.
- `SYNC_GOAL` (2): Reports the fulfillment (or non-fulfillment) of performance goals by connecting to `EmployeeVesting`.
- `SYNC_FREEZE_WALLET` (3): Allows entire accounts to be frozen in case of emergencies, updating the policies in `Token`.
- `SYNC_CREATE_GRANT` (4): Creates on-chain vesting grants via `EmployeeVesting`.
- `SYNC_BATCH` (5): Accepts a `bytes[]` array of nested action payloads and processes them recursively in a single transaction. This enables bulk processing of multiple employees/actions, reducing gas overhead by ~95%.

## Chainlink CRE Integration

`EquityWorkflowReceiver.sol` inherits from a receiver oracle template (`ReceiverTemplate.sol`), ensuring that real-world events are securely cross-communicated cryptographically to the settlement layer on the blockchain, bridging the gap between human capital / business metrics (Web2) and Web3 infrastructure.

### CRE Log Trigger Mapping (main.ts)

| Trigger Index | Contract | Events Forwarded to Lambda |
|---|---|---|
| 0 | HTTP (send to blockchain) | — |
| 1 | `IdentityRegistry` | `IdentityRegistered`, `IdentityRemoved`, `CountryUpdated` |
| 2 | `EmployeeVesting` | `GrantCreated`, `TokensClaimed`, `EmploymentStatusUpdated`, `GoalUpdated`, `GrantRevoked` |

> **Note:** `Token` (`AddressFrozen`) events are **not** watched by any log trigger in the current `main.ts`. The `SYNC_FREEZE_WALLET` action writes state to the blockchain, but the log-trigger step (Step 4) is skipped. On-chain state can be verified directly via `Token.isFrozen(address)`.
