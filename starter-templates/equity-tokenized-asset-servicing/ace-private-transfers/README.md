# ACE Private Transfers Toolkit

This folder contains the ACE-specific tooling used by this project:
- Foundry scripts to deploy/register policy engines and interact with the official ACE vault.
- TypeScript API scripts to call ACE REST endpoints with EIP-712 signatures.

Target network: Ethereum Sepolia (`11155111`)
Official ACE vault used here: `0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13`
ACE API base used by scripts: `https://convergence2026-token-api.cldev.cloud`

## Folder Structure

- `script/01_DeployPolicyEngine.s.sol`: deploy PolicyEngine proxy.
- `script/02_ApproveVault.s.sol`: approve token spending by vault.
- `script/03_RegisterVault.s.sol`: register token + policy engine in vault.
- `script/04_DepositToVault.s.sol`: deposit token to vault.
- `script/05_WithdrawWithTicket.s.sol`: redeem ticket onchain.
- `script/SetupAll.s.sol`: one-shot setup (deploy policy + approve + register + deposit).
- `api-scripts/src/*`: REST API helpers (`balances`, `shielded-address`, `private-transfer`, `withdraw`, `withdraw-and-redeem`).

## Prerequisites

- Foundry (`forge`, `cast`)
- Node.js 18+
- Sepolia RPC URL
- Private keys funded with Sepolia ETH

## Environment Variables

Common:
- `TOKEN_ADDRESS`: ERC-20 token address used with ACE vault.
- `SEPOLIA_RPC_URL` or `ETH_RPC_URL`: Sepolia RPC endpoint.

Foundry scripts:
- `PRIVATE_KEY`: signer for deploy/register/deposit flows.
- `POLICY_ENGINE_ADDRESS`: policy engine proxy address (for register flow).
- `DEPOSIT_AMOUNT`: deposit amount (wei, optional).
- `PRIVATE_KEY_2`: second signer (withdrawer for `05_WithdrawWithTicket`).
- `WITHDRAW_AMOUNT`: withdraw amount in wei.
- `TICKET`: ticket hex returned by `/withdraw`.

API scripts:
- `PRIVATE_KEY`: wallet used by `balances` and `private-transfer`.
- `PRIVATE_KEY_2`: wallet used by `shielded-address` and `withdraw`.
- `EMPLOYEE_PRIVATE_KEY`: preferred withdrawer key for `withdraw-and-redeem` (fallback to `PRIVATE_KEY_2`, then `PRIVATE_KEY`).

## Shell Syntax Note

Use the syntax for your shell:

Bash/WSL:
```bash
export PRIVATE_KEY=0x...
export ETH_RPC_URL=https://...
```

PowerShell:
```powershell
$env:PRIVATE_KEY="0x..."
$env:ETH_RPC_URL="https://..."
```

## Foundry Usage

From repo root:

```bash
cd ace-private-transfers
forge build
```

### 1) Deploy Policy Engine Proxy

```bash
forge script script/01_DeployPolicyEngine.s.sol:DeployPolicyEngine \
  --rpc-url $ETH_RPC_URL \
  --broadcast -vvvv
```

Take the printed proxy address and set it as `POLICY_ENGINE_ADDRESS`.

### 2) Register Token + Policy Engine in ACE Vault

```bash
forge script script/03_RegisterVault.s.sol:RegisterVault \
  --rpc-url $ETH_RPC_URL \
  --broadcast -vvvv
```

### 3) Approve + Deposit Token into Vault

```bash
forge script script/02_ApproveVault.s.sol:ApproveVault \
  --rpc-url $ETH_RPC_URL \
  --broadcast -vvvv

forge script script/04_DepositToVault.s.sol:DepositToVault \
  --rpc-url $ETH_RPC_URL \
  --broadcast -vvvv
```

### 4) Withdraw with Ticket Onchain

```bash
forge script script/05_WithdrawWithTicket.s.sol:WithdrawWithTicket \
  --rpc-url $ETH_RPC_URL \
  --broadcast -vvvv
```

### One-shot Flow

```bash
forge script script/SetupAll.s.sol:SetupAll \
  --rpc-url $ETH_RPC_URL \
  --broadcast -vvvv
```

## ACE API Scripts Usage

Install:

```bash
cd ace-private-transfers/api-scripts
npm install
```

Run scripts:

```bash
npm run balances
npm run shielded-address
npm run private-transfer -- <recipient> <token> <amount> [flags]
npm run withdraw -- <token> <amount>
npm run withdraw-and-redeem -- <token> <amount> [recipient]
```

Examples:

```bash
npm run private-transfer -- 0xRecipientOrShielded 0xToken 1000000 hide-sender
npm run withdraw -- 0xToken 1000000
npm run withdraw-and-redeem -- 0xToken 1000000
```

## Recommended Operational Flow

1. Ensure token is registered in ACE vault with a policy engine.
2. Deposit token liquidity to ACE vault.
3. Use API `private-transfer` to move private balance.
4. Use API `withdraw` to get ticket.
5. Redeem onchain with `withdrawWithTicket` from the same account that requested the ticket.

## Notes

- Ticket expiry is 1 hour (ACE-side). If not redeemed, ACE refunds private balance.
- `withdraw-and-redeem.ts` is the easiest end-to-end employee path for demo/testing.
- This folder is for Sepolia demo/testing and not production hardening.
