# Equity CRE — Interactive Test Runner Guide

**Script:** `EquityWorkflowCre/tests/run-tests.mjs`

---

## Prerequisites

| Requirement | Details |
|---|---|
| **Node.js** | v18 or later |
| **CRE CLI** | Installed and authenticated (`cre login`) |
| **Base Sepolia ETH** | Wallet needs gas for `--broadcast` transactions |
| **`.env` file** | At `tokenized-asset-servicing/.env` (see below) |

### Required `.env` Variables

```env
# Private key of the wallet that signs CRE workflow transactions
CRE_ETH_PRIVATE_KEY=0x<your_64_hex_chars>

# AWS Lambda function URL (the equity backend)
LAMBDA_URL=https://<your-id>.lambda-url.us-east-2.on.aws/
```

> **Note:** `LAMBDA_URL` is already set in both config files. The `.env` override takes precedence.

---

## Contract Addresses (Base Sepolia)

| Contract | Address |
|---|---|
| `EquityWorkflowReceiver` | `0x1a8d23329cf8641c6645b15Da2896Bd307b56B4a` |
| `IdentityRegistry` | `0x1Ee184656d3E440c04bB874FDBdDA8Ba07F3E1A6` |
| `EmployeeVesting` | `0xe875A81E95c276816e877dDC03A153465d0D9999` |
| `Token` (ERC-3643, `EQT`) | `0xB4FE5972D8cD70494DE061471bb59BAC6F7c3c4F` |

> `IdentityRegistry` and `Token` ownership have been transferred to `EquityWorkflowReceiver`.  
> `EquityWorkflowReceiver` is also the sole authorized oracle in `EmployeeVesting`.  
> **All on-chain writes must go through CRE → Receiver.**

---

## How to Run

```bash
cd EquityWorkflowCre
node tests/run-tests.mjs
```

On startup the script:
1. Reads `config.staging.json` for contract addresses.
2. Reads `.env` for `CRE_ETH_PRIVATE_KEY` and `LAMBDA_URL`.
3. Resolves `Token` address live from `EquityWorkflowReceiver.token()` on-chain.
4. Displays the interactive menu.

---

## Menu Reference

```
1) SYNC_KYC                   — Register / update employee KYC on-chain
2) SYNC_EMPLOYMENT_STATUS      — Activate or terminate an employee
3) SYNC_GOAL                  — Mark a performance goal as achieved/pending
4) SYNC_FREEZE_WALLET          — Freeze or unfreeze a token wallet
5) Full 3-Tier Round-Trip      — Automated KYC sync with default test data
6) Read Employee Record        — Query DynamoDB + live on-chain state summary
7) List All Employees          — Table view of all DynamoDB employee records
8) Create Vesting Grant        — DynamoDB metadata + CRE SYNC_CREATE_GRANT on-chain
9) Automated Bulk Sequence     — Loads mock-employees.json, sends SYNC_BATCH
0) Exit
```

---

## Flow per Sync Action (Options 1–4)

Every sync action follows this 5-step flow:

```
Step 1  Lambda (DynamoDB persist)
Step 2  CRE simulate --broadcast  →  EquityWorkflowReceiver.onReport()  →  target contract
Step 3  Fetch tx receipt  +  on-chain state verification (via viem readContract)
Step 4  CRE log trigger  →  relay on-chain event back to Lambda  [see exceptions below]
Step 5  Lambda readEmployee — confirm DynamoDB record updated
```

### Step 4 Exception — SYNC_FREEZE_WALLET

`main.ts` only watches **IdentityRegistry** (trigger 1) and **EmployeeVesting** (trigger 2) log events.  
The `Token` contract's `AddressFrozen` event is **not** captured. Therefore:

- **Step 4 is automatically skipped** for `SYNC_FREEZE_WALLET`.
- On-chain state is still confirmed in **Step 3b** via `Token.isFrozen(address)`.
- The DynamoDB record is updated in **Step 1** (before the CRE broadcast).

### CRE Trigger Index Mapping

| Index | Handler | Triggered when |
|---|---|---|
| `0` | HTTP trigger | You call CRE to write a report to the blockchain |
| `1` | IdentityRegistry log | `IdentityRegistered`, `IdentityRemoved`, `CountryUpdated` events |
| `2` | EmployeeVesting log | `GrantCreated`, `EmploymentStatusUpdated`, `GoalUpdated`, etc. |

---

## Option-by-Option Guide

### Option 1 — SYNC_KYC

Registers or updates an employee's KYC identity on-chain via `IdentityRegistry`.

**Prompts:**
- `Employee wallet address` — the employee's `0x...` Ethereum wallet.
- `KYC verified?` — `Y` to register, `N` to remove from registry.
- `Identity contract address` *(if verified=Y)* — must be a **non-zero** address (e.g. their on-chain ONCHAINID contract, or any valid address for testing).
- `Country code` *(if verified=Y)* — ISO 3166 numeric (e.g. `840` = United States).

**What happens on-chain:**
- If `verified=true` and not yet registered → calls `registerIdentity(employee, identity, country)`.
- If `verified=true` and already registered with a different identity → re-registers.
- If `verified=true` and same identity → calls `setCountry(employee, country)`.
- If `verified=false` → calls `deleteIdentity(employee)`.

**On-chain verification (Step 3b):**
```
IdentityRegistry.isVerified(address)   → bool
IdentityRegistry.identity(address)     → address
IdentityRegistry.investorCountry(address) → uint16
```

---

### Option 2 — SYNC_EMPLOYMENT_STATUS

Updates the employee's employment flag in `EmployeeVesting`.

**Prompts:**
- `Employee wallet address`
- `Currently employed?` — `Y` = active, `N` = terminated.

**What happens on-chain:** calls `EmployeeVesting.updateEmploymentStatus(address, bool)`.

> If terminated and the grant is revocable, use `EmployeeVesting.revoke()` separately (owner-only, requires direct tx or CRE admin action).

**On-chain verification:**
```
EmployeeVesting.isEmployed(address) → bool
```

---

### Option 3 — SYNC_GOAL

Marks a performance goal ID as achieved or not in `EmployeeVesting`.

**Prompts:**
- `Goal ID (bytes32 hex)` — e.g. `0x000...0001`. Must be 66 hex chars (`0x` + 64).
- `Goal achieved?`

**What happens on-chain:** calls `EmployeeVesting.setGoalAchieved(bytes32, bool)`.

> Goals are stored as `goal:<goalId>` records in DynamoDB, **not** inside the employee record.  
> On-chain verification reads `EmployeeVesting.goalsAchieved(bytes32)`.

**On-chain verification:**
```
EmployeeVesting.goalsAchieved(bytes32) → bool
```

---

### Option 4 — SYNC_FREEZE_WALLET

Freezes or unfreezes a wallet on the ERC-3643 Token contract.

**Prompts:**
- `Wallet address`
- `Freeze wallet?` — `Y` = freeze, `N` = unfreeze.

**What happens on-chain:** calls `Token.setAddressFrozen(address, bool)` (via Receiver, which owns Token).

> ⚠ **Step 4 (log trigger) is SKIPPED** — `Token.AddressFrozen` is not watched by `main.ts`.  
> On-chain state is confirmed via `Token.isFrozen()` in Step 3b.

**On-chain verification:**
```
Token.isFrozen(address) → bool
```

---

### Option 5 — Full Round-Trip Test

Runs `SYNC_KYC` automatically with fixed test data:

| Field | Value |
|---|---|
| `employeeAddress` | `0x1111111111111111111111111111111111111111` |
| `identityAddress` | `0x2222222222222222222222222222222222222222` |
| `country` | `840` (US) |
| `verified` | `true` |

No prompts — confirms and runs immediately.

---

### Option 6 — Read Employee Record

Queries DynamoDB by `employeeAddress` and shows:
- Full DynamoDB record (all stored fields).
- Live on-chain state summary: `isVerified`, `investorCountry`, `isEmployed`, `isFrozen`.

---

### Option 7 — List All Employees

Scans the `EquityEmployeeState` DynamoDB table and prints a summary table with KYC, employment, freeze, and last event columns. **Read-only — no on-chain interaction.**

---

### Option 8 — Create Vesting Grant

Runs **3 phases** in sequence:

**Why not just CRE for everything?**  
`EmployeeVesting.createGrant()` is `onlyOwner`. The `EquityWorkflowReceiver` was only granted **oracle rights** (`setOracle`), not ownership of `EmployeeVesting`. CRE can only call functions accessible to the Receiver.

#### Phase A — Lambda (DynamoDB metadata persist)
Stores vesting schedule parameters for the employee in DynamoDB.

#### Phase B — CRE → `SYNC_EMPLOYMENT_STATUS` on-chain
Uses the full 3-tier CRE flow to call `EmployeeVesting.updateEmploymentStatus(address, true)` via the Receiver oracle. This registers the employee as **active on-chain** and eligible to receive a grant.

```
Lambda → CRE → EquityWorkflowReceiver → EmployeeVesting.updateEmploymentStatus()
                                          ↓ EmploymentStatusUpdated event
CRE log trigger 2 → Lambda (DynamoDB sync)
```

On-chain verification: `EmployeeVesting.isEmployed(address) → true`

#### Phase C — Manual owner wallet (printed instructions)
After Phase B, the script prints the exact transaction calls the **owner wallet** must execute to finalize the on-chain grant:

1. `Token.approve(EmployeeVesting, amount)` — fund the vesting pool
2. `EmployeeVesting.createGrant(employee, amount, startTime, cliff, duration, revocable, goalId)`

Once `GrantCreated` is emitted, **CRE log trigger 2** will automatically sync it back to Lambda/DynamoDB.

**Prompts:**
- Employee wallet address
- Total vesting amount (integer, in token units)
- Cliff period (months)
- Vesting duration (months)
- Revocable? (Y/N)
- Notes (free text)

---

### Option 9 — Automated Bulk Sequence (SYNC_BATCH)

Loads all employees from `tests/mock-employees.json` and processes them in a **single batched transaction** using the `SYNC_BATCH` action type.

**Flow:**
1. Reads `mock-employees.json` (20 employees by default).
2. Persists all employees to DynamoDB via `CompanyEmployeeBatchInput` Lambda action.
3. Builds a `SYNC_BATCH` CRE payload containing all sync actions (KYC, Employment, Goal, Freeze, Grant) for every employee.
4. Submits the entire batch as **one CRE `writeReport` transaction** on-chain.

**Gas savings:** By bundling ~80+ individual actions into a single transaction, the base transaction overhead (21,000 gas) is paid only once instead of per-action, reducing total gas cost by ~95% in overhead fees.

> **Note:** Step 4 (CRE LogTrigger) is skipped for `SYNC_BATCH` since multiple events are emitted. Individual log triggers can be tested via Options 1–4.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `LAMBDA_URL not found` | Missing `.env` entry | Add `LAMBDA_URL=...` to `.env` |
| `CRE command failed` | CRE CLI not installed or not logged in | Run `cre login` and ensure `cre` is in PATH |
| `Transient tx error — waiting...` | Nonce collision, will auto-retry up to 4× | Wait; if persistent, check wallet nonce on Basescan |
| `No tx hash found in output` | CRE ran in dry-run mode | Ensure `--broadcast` flag is present (it is by default) |
| `Lambda persist failed 400` | Missing required field in payload | Check action name and required params in `lambda-function/index.mjs` |
| `isVerified = false` after SYNC_KYC | Receiver does not own IdentityRegistry | Verify ownership: call `IdentityRegistry.owner()` — must be Receiver address |
| `isFrozen` not updated | Token ownership not with Receiver | Verify: call `Token.owner()` — must be Receiver address |

---

## Useful Basescan Links

- [EquityWorkflowReceiver](https://sepolia.basescan.org/address/0x1a8d23329cf8641c6645b15Da2896Bd307b56B4a)
- [IdentityRegistry](https://sepolia.basescan.org/address/0x1Ee184656d3E440c04bB874FDBdDA8Ba07F3E1A6)
- [EmployeeVesting](https://sepolia.basescan.org/address/0xe875A81E95c276816e877dDC03A153465d0D9999)
- [Token (EQT)](https://sepolia.basescan.org/address/0xB4FE5972D8cD70494DE061471bb59BAC6F7c3c4F)
