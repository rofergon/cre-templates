# Main End-to-End Test Commands

This report summarizes the 2 main E2E commands of the project and what each one validates.

## Privacy Model (Current)

- ACE remains the onchain privacy rail.
- Confidential HTTP is used for offchain ACE REST calls (`/shielded-address`, `/private-transfer`, `/withdraw`).
- Lambda sync stays on standard HTTP with payload validation and redacted logs.

## 1) Full Employee Flow + ACE Ticket

Command:

```bash
npm --prefix EquityWorkflowCre run test:lambda-cre-ace-ticket
```

What it tests:

1. Initial state persistence in Lambda (company entry).
2. Onchain sync via receiver/CRE (KYC, freeze, and compliance baseline).
3. Onchain validation of employee requirements.
4. ACE privacy flow:
   - deposit to vault,
   - private transfer admin -> employee,
   - withdrawal ticket request.
5. Onchain ticket redemption with `withdrawWithTicket` from the employee's wallet.
6. Confidential HTTP transport for ACE REST calls with encrypted output policy.

Expected result:

- E2E validation of integration `Lambda -> CRE/Receiver -> Onchain -> ACE -> final redeem`.

Minimum required variables:

- `CRE_ETH_PRIVATE_KEY`
- `CRE_EMPLOYEE_ETH_PRIVATE_KEY`
- `LAMBDA_URL` (or fallback in config)

Optional privacy config knobs (in workflow config):

- `privacy.enableConfidentialAce` (default `true`)
- `privacy.encryptOutputAce` (default `true`)
- `privacy.redactLogs` (default `true`)
- `privacy.vaultDonSecrets[]` (for Vault DON secret references)

## 2) Private Rounds Market Flow (USDC + ComplianceV2)

Command:

```bash
npm --prefix EquityWorkflowCre run test:private-rounds-market
```

What it tests:

1. KYC baseline and investor authorization.
2. Private round creation and opening.
3. Unauthorized purchase rejection.
4. Valid purchase with USDC and successful settlement.
5. Validation of limits/caps per investor and per round.
6. Refund flow and capacity reversal.
7. Global resale restrictions (lockup + unauthorized recipient).

Expected result:

- E2E validation of `ComplianceV2 + PrivateRoundsMarket + Receiver` with positive and negative scenarios.

Minimum required variables:

- `CRE_ETH_PRIVATE_KEY`
- `CRE_EMPLOYEE_ETH_PRIVATE_KEY`

## Recommended Execution Order

Run from the repository root in this order:

```bash
npm --prefix EquityWorkflowCre run test:lambda-cre-ace-ticket
npm --prefix EquityWorkflowCre run test:private-rounds-market
```

Reason:

- First you run the full general flow `Lambda -> CRE -> Onchain -> ACE -> redeem`, then drill down into the specific private market and resale restrictions case.
