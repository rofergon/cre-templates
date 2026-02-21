# Equity Solidity Protocol (Tokenized Asset Servicing)

This directory contains the smart contracts (written in Solidity) that make up the protocol for managing equity and tokenized assets, integrating compliance rules, identity management, and employee vesting schedules.

Furthermore, the protocol is designed to receive verified off-chain information through Chainlink CRE (Compute Runtime Environment) oracles and workflows.

## Contract Architecture

Below is the architecture and flow diagram of the protocol's contracts:

![Solidity Architecture](../../equity_solidity_architecture.svg)

## Main Components

### 1. ERC-3643 Token (`Token.sol` & `IERC3643.sol`)
The core of the tokenized asset. It implements the ERC-3643 standard (with backward compatibility to ERC-20 interfaces), designed or adapted to handle financial assets and security tokens. This contract ensures close interaction with the identity registry system and compliance rules before allowing transfers.

### 2. Identity Management (`IdentityRegistry.sol` & `IIdentityRegistry.sol`)
Manages the credentials and KYC/AML verification status of the different addresses (wallets) in the ecosystem. A user can only receive or operate with tokens if they maintain a valid status within this registry.

### 3. Compliance Rules (`Compliance.sol` & `ICompliance.sol`)
Acts as a plug-and-play module that validates whether a transfer complies with regulations (e.g., holding limits, transfer blocks between certain countries, or frozen wallet controls).

### 4. Employee Vesting (`EmployeeVesting.sol`)
A specialized contract for the creation and administration of contractual plans (*grants*) for employees. It includes:
- **Cliff periods** and linear *Vesting* duration.
- **Revocable Grants**: allowing compensation schemes to be frozen if the employment relationship is terminated.
- **Performance Goals**: vesting can depend on meeting business metrics that are validated through oracles.

### 5. Smart Chain Workflow (`EquityWorkflowReceiver.sol`)
The bridge contract that receives reports calculated by Chainlink CRE. It translates payloads created off-chain into on-chain state updates by processing multiple types of actions, such as:
- `SYNC_KYC`: Synchronizes user verification information with the `IdentityRegistry`.
- `SYNC_EMPLOYMENT_STATUS`: Modifies an employee's employment status in `EmployeeVesting`.
- `SYNC_GOAL`: Reports the fulfillment (or non-fulfillment) of performance goals by connecting to `EmployeeVesting`.
- `SYNC_FREEZE_WALLET`: Allows entire accounts to be frozen in case of emergencies, updating the policies in `Token`.

## Chainlink CRE Integration

`EquityWorkflowReceiver.sol` inherits from a receiver oracle template (`ReceiverTemplate.sol`), ensuring that real-world events are securely cross-communicated cryptographically to the settlement layer on the blockchain, bridging the gap between human capital / business metrics (Web2) and Web3 infrastructure.
