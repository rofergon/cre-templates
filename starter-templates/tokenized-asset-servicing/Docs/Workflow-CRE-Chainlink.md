# Workflow CRE Chainlink - Guia Tecnica

## 1) Objetivo
Este documento describe en detalle la implementacion del workflow Chainlink CRE ubicada en `EquityWorkflowCre/`, incluyendo:

- configuracion
- triggers
- validacion de payloads
- ABI encoding/decoding
- escritura on-chain (`writeReport`)
- propagacion de logs on-chain a Lambda
- pruebas operativas

## 2) Archivos clave

| Archivo | Rol |
|---|---|
| `EquityWorkflowCre/main.ts` | Workflow principal. |
| `EquityWorkflowCre/workflow.yaml` | Targets de simulacion/staging/produccion. |
| `EquityWorkflowCre/config.staging.json` | Config de staging/local simulation. |
| `EquityWorkflowCre/config.production.json` | Config de produccion. |
| `project.yaml` | RPCs por target para CRE CLI. |
| `secrets.yaml` | Mapeo de secrets (`LAMBDA_URL`). |

## 3) Modelo de ejecucion CRE aplicado a este proyecto

El workflow usa el modelo trigger-callback:

- Trigger HTTP para aceptar comandos de negocio (`SYNC_*`).
- Trigger de logs EVM para escuchar eventos on-chain y sincronizarlos a Lambda.

Conceptualmente:

1. trigger dispara callback
2. callback usa capacidades (`EVMClient`, `HTTPClient`)
3. CRE aplica consenso y entrega resultado

## 4) Configuracion del workflow

## 4.1 `workflow.yaml`
Targets definidos:

- `local-simulation`
- `staging-settings`
- `production-settings`

Cada target define:

- `workflow-path`: `./main.ts`
- `config-path`: staging o production json
- `secrets-path`: `../secrets.yaml`

## 4.2 Estructura de config (`main.ts`)
Schema Zod (`configSchema`):

- `url` (opcional, fallback para Lambda en simulacion)
- `evms[]` (min 1) con:
  - `receiverAddress`
  - `identityRegistryAddress`
  - `employeeVestingAddress`
  - `chainSelectorName`
  - `gasLimit`

Nota:
`config.staging.json` incluye tambien `tokenAddress`, pero no forma parte del schema actual del workflow.

## 5) Triggers registrados y mapping de indices

En `initWorkflow(config)` se registran 3 handlers en este orden:

1. index `0`: `HTTPCapability().trigger({})`
2. index `1`: `evmClient.logTrigger` para `identityRegistryAddress`
3. index `2`: `evmClient.logTrigger` para `employeeVestingAddress`

Implicacion operativa:

- al simular no interactivo, debes usar `--trigger-index` correcto
- `Token` no esta suscrito como log trigger

## 6) Acciones de entrada soportadas

## 6.1 Schemas de payload
Validadas con `syncInputSchema` (Zod discriminated union):

- `SYNC_KYC`
- `SYNC_EMPLOYMENT_STATUS`
- `SYNC_GOAL`
- `SYNC_FREEZE_WALLET`
- `SYNC_CREATE_GRANT`
- `SYNC_BATCH`

## 6.2 `ACTION_TYPE`
Mapeo numerico usado para codificacion de reportes:

- `SYNC_KYC`: `0`
- `SYNC_EMPLOYMENT_STATUS`: `1`
- `SYNC_GOAL`: `2`
- `SYNC_FREEZE_WALLET`: `3`
- `SYNC_CREATE_GRANT`: `4`
- `SYNC_BATCH`: `5`

## 7) Pipeline HTTP -> writeReport

## 7.1 `onHTTPTrigger`

1. Valida que payload no este vacio.
2. Parse JSON.
3. Valida contra `syncInputSchema`.
4. Llama `buildInstruction`.
5. Llama `submitInstruction`.

## 7.2 `buildInstruction` por accion
Cada accion construye `payload` ABI con `encodeAbiParameters` + `parseAbiParameters`.

### `SYNC_KYC`
Tuple:

- `(address employee, bool verified, address identity, uint16 country)`

Regla adicional:

- si `verified=true`, exige `identityAddress`.

### `SYNC_EMPLOYMENT_STATUS`
Tuple:

- `(address employee, bool employed)`

### `SYNC_GOAL`
Tuple:

- `(bytes32 goalId, bool achieved)`

### `SYNC_FREEZE_WALLET`
Tuple:

- `(address wallet, bool frozen)`

### `SYNC_CREATE_GRANT`
Tuple:

- `(address employee, uint256 amount, uint256 startTime, uint256 cliffDuration, uint256 vestingDuration, bool isRevocable, bytes32 performanceGoalId)`

### `SYNC_BATCH`
Tuple actual en workflow:

- `(bytes[] batches)`

Cada elemento se llena actualmente con `buildInstruction(batch).payload`.

## 7.3 `submitInstruction`

1. Construye `reportData = abi.encode(uint8 actionType, bytes payload)`.
2. Crea reporte CRE:
   - `encoderName: evm`
   - `signingAlgo: ecdsa`
   - `hashingAlgo: keccak256`
3. Ejecuta `evmClient.writeReport`:
   - `receiver = receiverAddress`
   - `gasLimit = evmConfig.gasLimit`
4. Si `txStatus != SUCCESS`, lanza error.
5. Retorna `txHash`.

## 8) Pipeline log EVM -> Lambda

## 8.1 Decodificacion de evento
`buildLambdaPayloadFromLog`:

- toma `topics` y `data`
- intenta decodificar con `decodeEventLog` sobre `eventAbi`
- si no coincide con ABI soportado, ignora log

Eventos soportados:

- `IdentityRegistered`
- `IdentityRemoved`
- `CountryUpdated`
- `GrantCreated`
- `TokensClaimed`
- `EmploymentStatusUpdated`
- `GoalUpdated`
- `GrantRevoked`

## 8.2 Envio HTTP a Lambda
`onLogTrigger`:

1. Construye payload de negocio.
2. Resuelve URL:
   - intenta `runtime.getSecret("LAMBDA_URL")`
   - fallback a `runtime.config.url`
3. Usa `HTTPClient.sendRequest` con `consensusIdenticalAggregation`.
4. Retorna accion procesada.

## 9) Integracion con contratos y ABI esperada

El receiver on-chain (`EquityWorkflowReceiver`) espera reportes en formato:

- `abi.encode(uint8 actionType, bytes payload)`

Para `SYNC_BATCH`, el receiver espera:

- `payload = abi.encode(bytes[] batches)`
- donde cada item de `batches` es otro `report` valido con `(uint8, bytes)`

## 10) Limites y desviaciones detectadas

## 10.1 `SYNC_BATCH` con posible mismatch de encoding
Estado actual en workflow:

- genera `bytes[]` con payloads internos (sin actionType por sub-item).

Estado esperado por receiver:

- cada sub-item debe ser reporte completo con `actionType + payload`.

Impacto:

- riesgo de revert/decoding error al procesar batch.

## 10.2 `SYNC_FREEZE_WALLET` sin log-trigger de retorno
Estado actual:

- workflow no escucha logs de `Token`.

Impacto:

- no hay paso automatico de confirmacion on-chain via evento `AddressFrozen`.

## 11) Comandos operativos utiles

## 11.1 Simulacion local

```bash
cre workflow simulate ./EquityWorkflowCre --target local-simulation
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
Para `IdentityRegistry` (trigger 1):

```bash
cre workflow simulate ./EquityWorkflowCre \
  --target local-simulation \
  --non-interactive \
  --trigger-index 1 \
  --evm-tx-hash <TX_HASH> \
  --evm-event-index <INDEX_EN_LOGS_TX> \
  --broadcast
```

Para `EmployeeVesting` cambia a `--trigger-index 2`.

## 12) Pruebas del workflow

## 12.1 Runner interactivo
- `EquityWorkflowCre/tests/run-tests.mjs`

Funcionalidades:

- SYNC_KYC
- SYNC_EMPLOYMENT_STATUS
- SYNC_GOAL
- SYNC_FREEZE_WALLET
- SYNC_CREATE_GRANT
- SYNC_BATCH
- lectura/listado en Lambda

## 12.2 E2E sync write
- `EquityWorkflowCre/tests/run-sync-write-test.mjs`

Valida:

1. HTTP trigger (write)
2. receipt + event index
3. log trigger replay
4. verificacion de record en Lambda/DynamoDB

Incluye manejo de nonce bajo reemplazo (opcional `AUTO_BUMP_NONCE=false`).

## 12.3 Simulacion 3 capas
- `EquityWorkflowCre/tests/run-lambda-sync-simulation.mjs`

Ejecuta secuencia Lambda -> CRE -> Chain -> CRE -> Lambda.

## 13) Checklist de produccion

1. Revisar direcciones en `config.production.json`.
2. Verificar `chainSelectorName` y RPC de `project.yaml`.
3. Cargar `LAMBDA_URL` en secrets vault.
4. Confirmar ownership/oracle permissions del receiver en contratos.
5. Definir politicas de retry para nonce/network errors.
6. Corregir/validar `SYNC_BATCH` antes de usar en cargas masivas.
7. Definir estrategia para eventos de `Token` (agregar log trigger o compensacion).

## 14) Backlog recomendado para el workflow

1. Corregir serializacion de sub-reportes en `SYNC_BATCH`.
2. Agregar log trigger para `tokenAddress` y mapear `AddressFrozen`.
3. Agregar pruebas E2E dedicadas para:
   - `SYNC_BATCH`
   - `SYNC_CREATE_GRANT`
   - freeze con confirmacion on-chain + sync off-chain
4. Normalizar documentacion de trigger-index en README y tests.

