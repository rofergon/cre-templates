# Workflow CRE Chainlink - Guia Tecnica

## 1) Objetivo

Este documento describe la version actual del workflow Chainlink CRE ubicado en `EquityWorkflowCre/`.

Cubre:

- configuracion
- triggers
- validacion de payloads
- codificacion ABI de reportes
- escritura onchain via `writeReport`
- sincronizacion onchain -> Lambda
- integracion confidencial con ACE
- comandos de simulacion y pruebas E2E

## 2) Archivos clave

| Archivo | Rol |
|---|---|
| `EquityWorkflowCre/main.ts` | Workflow principal. |
| `EquityWorkflowCre/workflow.yaml` | Targets de simulacion, staging y produccion. |
| `EquityWorkflowCre/config.staging.json` | Config activa para `local-simulation`. |
| `EquityWorkflowCre/config.production.json` | Config para despliegue productivo. |
| `project.yaml` | RPCs por target para CRE CLI. |
| `secrets.yaml` | Secrets para targets desplegados. |

## 3) Modelo de ejecucion

El workflow usa dos direcciones principales:

- HTTP trigger para recibir acciones de negocio.
- EVM log triggers para reenviar eventos onchain hacia Lambda.

Flujo conceptual:

1. un sistema externo envia una accion HTTP o se detecta un evento onchain
2. el workflow usa capacidades CRE (`EVMClient`, `HTTPClient`, `ConfidentialHTTPClient`)
3. CRE aplica consenso y ejecuta el resultado

## 4) Configuracion actual

## 4.1 `workflow.yaml`

Targets definidos:

- `local-simulation`
- `staging-settings`
- `production-settings`

Cada target define:

- `workflow-path`: `./main.ts`
- `config-path`: `./config.staging.json` o `./config.production.json`
- `secrets-path`: `../secrets.yaml`

## 4.2 Schema real de config (`main.ts`)

Campos soportados:

- `url` (opcional): fallback para Lambda en simulacion
- `aceApiUrl` (opcional)
- `evms[]` (minimo 1) con:
  - `receiverAddress`
  - `identityRegistryAddress`
  - `acePrivacyManagerAddress`
  - `complianceV2Address` (opcional)
  - `privateRoundsMarketAddress` (opcional)
  - `usdcAddress` (opcional)
  - `treasuryAddress` (opcional)
  - `aceVaultAddress`
  - `aceChainId` (opcional)
  - `chainSelectorName`
  - `gasLimit`
- `privacy` (opcional):
  - `enableConfidentialAce`
  - `encryptOutputAce`
  - `redactLogs`
  - `vaultDonSecrets[]`

El workflow actual ya no usa `employeeVestingAddress`.

## 5) Triggers registrados y orden operativo

En `initWorkflow(config)` se registra:

1. trigger HTTP en indice `0`
2. un log trigger por cada direccion incluida en:
   - `identityRegistryAddress`
   - `acePrivacyManagerAddress`
   - `complianceV2Address` si existe
   - `privateRoundsMarketAddress` si existe

En la configuracion actual el orden esperado es:

1. index `0`: HTTP
2. index `1`: `identityRegistryAddress`
3. index `2`: `acePrivacyManagerAddress`
4. index `3`: `complianceV2Address`
5. index `4`: `privateRoundsMarketAddress`

Nota:

- el workflow actual no suscribe logs del token
- `--trigger-index` debe elegirse segun ese orden al simular

## 6) Acciones soportadas

## 6.1 Acciones onchain (`SYNC_*`)

El workflow valida estas acciones y las codifica como `abi.encode(uint8 actionType, bytes payload)`:

- `SYNC_KYC`
- `SYNC_EMPLOYMENT_STATUS`
- `SYNC_GOAL`
- `SYNC_FREEZE_WALLET`
- `SYNC_PRIVATE_DEPOSIT`
- `SYNC_BATCH`
- `SYNC_REDEEM_TICKET` (aceptada por schema, pero bloqueada por diseno)
- `SYNC_MINT`
- `SYNC_SET_CLAIM_REQUIREMENTS`
- `SYNC_SET_INVESTOR_AUTH`
- `SYNC_SET_INVESTOR_LOCKUP`
- `SYNC_CREATE_ROUND`
- `SYNC_SET_ROUND_ALLOWLIST`
- `SYNC_OPEN_ROUND`
- `SYNC_CLOSE_ROUND`
- `SYNC_MARK_PURCHASE_SETTLED`
- `SYNC_REFUND_PURCHASE`
- `SYNC_SET_TOKEN_COMPLIANCE`

Mapeo numerico actual:

- `SYNC_KYC`: `0`
- `SYNC_EMPLOYMENT_STATUS`: `1`
- `SYNC_GOAL`: `2`
- `SYNC_FREEZE_WALLET`: `3`
- `SYNC_PRIVATE_DEPOSIT`: `4`
- `SYNC_BATCH`: `5`
- `SYNC_REDEEM_TICKET`: `6`
- `SYNC_MINT`: `7`
- `SYNC_SET_CLAIM_REQUIREMENTS`: `8`
- `SYNC_SET_INVESTOR_AUTH`: `9`
- `SYNC_SET_INVESTOR_LOCKUP`: `10`
- `SYNC_CREATE_ROUND`: `11`
- `SYNC_SET_ROUND_ALLOWLIST`: `12`
- `SYNC_OPEN_ROUND`: `13`
- `SYNC_CLOSE_ROUND`: `14`
- `SYNC_MARK_PURCHASE_SETTLED`: `15`
- `SYNC_REFUND_PURCHASE`: `16`
- `SYNC_SET_TOKEN_COMPLIANCE`: `17`

## 6.2 Acciones ACE (`ACE_*`)

Estas acciones no escriben reportes onchain; llaman la API ACE:

- `ACE_GENERATE_SHIELDED_ADDRESS`
- `ACE_PRIVATE_TRANSFER`
- `ACE_WITHDRAW_TICKET`

La base por defecto es:

- `https://convergence2026-token-api.cldev.cloud`

## 7) Pipeline HTTP -> onchain / ACE

## 7.1 `onHTTPTrigger`

1. valida que el payload exista
2. parsea JSON
3. valida contra `syncInputSchema`
4. si la accion es `ACE_*`, ejecuta `executeAceAction`
5. si la accion es `SYNC_REDEEM_TICKET`, revierte de forma explicita
6. en el resto, construye la instruccion y la envia con `writeReport`

## 7.2 ABI payloads por accion

Principales payloads actuales:

- `SYNC_KYC`
  - `(address employee, bool verified, address identity, uint16 country)`
- `SYNC_EMPLOYMENT_STATUS`
  - `(address employee, bool employed)`
- `SYNC_GOAL`
  - `(bytes32 goalId, bool achieved, address employeeHint)`
- `SYNC_FREEZE_WALLET`
  - `(address walletAddress, bool frozen)`
- `SYNC_PRIVATE_DEPOSIT`
  - `(uint256 amount)`
- `SYNC_MINT`
  - `(address to, uint256 amount)`
- `SYNC_SET_CLAIM_REQUIREMENTS`
  - `(address employee, uint64 cliffEndTimestamp, bytes32 goalId, bool goalRequired)`
- `SYNC_SET_INVESTOR_AUTH`
  - `(address investor, bool authorized)`
- `SYNC_SET_INVESTOR_LOCKUP`
  - `(address investor, uint64 lockupUntil)`
- `SYNC_CREATE_ROUND`
  - `(uint256 roundId, uint64 startTime, uint64 endTime, uint256 tokenPriceUsdc6, uint256 maxUsdc)`
- `SYNC_SET_ROUND_ALLOWLIST`
  - `(uint256 roundId, address investor, uint256 capUsdc)`
- `SYNC_OPEN_ROUND`
  - `(uint256 roundId)`
- `SYNC_CLOSE_ROUND`
  - `(uint256 roundId)`
- `SYNC_MARK_PURCHASE_SETTLED`
  - `(uint256 purchaseId, bytes32 aceTransferRef)`
- `SYNC_REFUND_PURCHASE`
  - `(uint256 purchaseId, bytes32 reason)`
- `SYNC_SET_TOKEN_COMPLIANCE`
  - `(address complianceAddress)`

## 7.3 `SYNC_BATCH`

`SYNC_BATCH` codifica:

- `payload = abi.encode(bytes[] batches)`

Cada item de `batches` es un sub-reporte completo, no un payload crudo:

- `abi.encode(uint8 actionType, bytes payload)`

Esto ya esta alineado con `EquityWorkflowReceiver.sol`.

## 7.4 `submitInstruction`

1. crea `reportData = abi.encode(uint8 actionType, bytes payload)`
2. genera el reporte CRE con:
   - `encoderName: evm`
   - `signingAlgo: ecdsa`
   - `hashingAlgo: keccak256`
3. llama `evmClient.writeReport`
4. valida `TxStatus.SUCCESS`
5. retorna `txHash`

## 8) Integracion confidencial con ACE

La integracion ACE usa `ConfidentialHTTPClient` por defecto cuando:

- `privacy.enableConfidentialAce=true`

Se firma EIP-712 para:

- generar shielded address
- private transfer
- withdraw ticket

Controles actuales:

- `assertExternalPayloadPolicy` bloquea secretos en HTTP plano
- `redactLogs` evita exponer identificadores o credenciales en logs
- `vaultDonSecrets[]` permite inyectar secretos desde Vault DON
- `encryptOutputAce=true` habilita cifrado de respuesta en Confidential HTTP

## 9) Pipeline log EVM -> Lambda

`buildLambdaPayloadFromLog` decodifica y reenvia estos eventos:

- `IdentityRegistered`
- `IdentityRemoved`
- `CountryUpdated`
- `EmploymentStatusUpdated`
- `GoalUpdated`
- `PrivateDeposit`
- `TicketRedeemed`
- `InvestorAuthorizationUpdated`
- `InvestorLockupUpdated`
- `RoundCreated`
- `RoundOpened`
- `RoundClosed`
- `PurchaseRequested`
- `PurchaseSettled`
- `PurchaseRefunded`

`onLogTrigger`:

1. decodifica el log
2. construye payload de negocio
3. resuelve `LAMBDA_URL` desde secret o `config.url`
4. envia HTTP estandar a Lambda

## 10) Limites actuales del workflow

- `SYNC_REDEEM_TICKET` esta deshabilitado intencionalmente
  - el ticket se solicita via `ACE_WITHDRAW_TICKET`
  - el redeem final lo firma la wallet del usuario en el CCC Vault
- no hay log trigger del token
  - eventos como `AddressFrozen` no regresan automaticamente a Lambda
- la simulacion local y el modo test pueden usar bypass del forwarder
  - util para demos
  - no equivale a hardening productivo

## 11) Comandos operativos utiles

## 11.1 Simulacion local

```bash
cre workflow simulate ./EquityWorkflowCre --target local-simulation --non-interactive --trigger-index 0
```

## 11.2 Trigger HTTP no interactivo

```bash
cre workflow simulate ./EquityWorkflowCre \
  --target local-simulation \
  --non-interactive \
  --trigger-index 0 \
  --http-payload '{"action":"SYNC_KYC","employeeAddress":"0x...","verified":true,"identityAddress":"0x...","country":840}' \
  --broadcast
```

## 11.3 Replay de log trigger

Para el primer log trigger configurado:

```bash
cre workflow simulate ./EquityWorkflowCre \
  --target local-simulation \
  --non-interactive \
  --trigger-index 1 \
  --evm-tx-hash <TX_HASH> \
  --evm-event-index <INDEX_EN_LOGS_TX> \
  --broadcast
```

Si `complianceV2Address` y `privateRoundsMarketAddress` estan configurados, sus triggers quedan despues en el orden descrito en la seccion 5.

## 12) Pruebas relevantes

- `EquityWorkflowCre/tests/run-lambda-cre-ace-ticket-flow.mjs`
  - valida Lambda -> CRE -> onchain -> ACE/CCC -> redeem final
- `EquityWorkflowCre/tests/run-private-rounds-market-flow.mjs`
  - valida KYC, autorizacion de inversor, rondas privadas, settlement, refund y restricciones de reventa

Comandos:

```bash
npm --prefix EquityWorkflowCre run test:lambda-cre-ace-ticket
npm --prefix EquityWorkflowCre run test:private-rounds-market
```

## 13) Checklist operativo

1. revisar direcciones en `config.staging.json` o `config.production.json`
2. verificar `chainSelectorName` y RPC en `project.yaml`
3. cargar `LAMBDA_URL` como secret en despliegues reales
4. confirmar ownership y permisos del receiver
5. validar configuracion de `privacy.*` si se usa Confidential HTTP
6. recordar que el redeem final ocurre desde la wallet del usuario, no desde CRE
