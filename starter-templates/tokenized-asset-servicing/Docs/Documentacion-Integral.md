# Documentacion Integral del Proyecto

## 1) Objetivo
Este proyecto implementa un sistema de "tokenized asset servicing" para equity corporativo con sincronizacion bidireccional entre:

- Web2 corporativo (Lambda + DynamoDB + inputs de RRHH)
- Workflow descentralizado en Chainlink CRE
- Protocolo Solidity on-chain (Base Sepolia)

El objetivo operativo es que los cambios de negocio (KYC, empleo, goals, freeze, grants) se reflejen on-chain de forma segura y auditable, y que los eventos on-chain vuelvan a la capa operativa off-chain.

## 2) Alcance de esta documentacion
Esta doc general cubre la arquitectura completa, flujos end-to-end, operacion y riesgos.

Para detalle tecnico por dominio:

- Protocolo Solidity: `Docs/Protocolo-Solidity.md`
- Workflow CRE: `Docs/Workflow-CRE-Chainlink.md`

## 3) Arquitectura general

### 3.1 Vista por capas

```text
[Web2 Empresa]
  Sistemas HR / Backoffice / Integraciones
          |
          v
[AWS Lambda]
  - Persistencia y lectura en DynamoDB
  - Generacion de payloads SYNC_*
          |
          v
[Chainlink CRE Workflow (main.ts)]
  Trigger 0 (HTTP): escribe en blockchain via writeReport
  Trigger 1/2 (EVM logs): consume eventos y los envia a Lambda
          |
          v
[EquityWorkflowReceiver.sol]
  Valida/recibe reportes CRE y enruta acciones
          |
          v
[Protocolo Solidity]
  IdentityRegistry | EmployeeVesting | Token | Compliance
          |
          v
[Eventos on-chain]
  IdentityRegistered, GoalUpdated, GrantCreated, etc.
          |
          v
[CRE log trigger -> Lambda -> DynamoDB]
```

### 3.2 Componentes principales

| Componente | Rol |
|---|---|
| `lambda-function/index.mjs` | API de entrada empresa y sincronizacion con DynamoDB. |
| `EquityWorkflowCre/main.ts` | Orquestacion CRE: valida payloads, encodea ABI, ejecuta `writeReport`, procesa logs. |
| `contracts/equity-protocol/EquityWorkflowReceiver.sol` | Bridge on-chain desde reportes CRE hacia contratos de dominio. |
| `contracts/equity-protocol/IdentityRegistry.sol` | Estado KYC y pais por wallet. |
| `contracts/equity-protocol/EmployeeVesting.sol` | Grants, vesting, empleo, goals y claims. |
| `contracts/equity-protocol/Token.sol` | Token estilo ERC-3643 con restricciones de identidad/compliance/freeze. |
| `contracts/equity-protocol/Compliance.sol` | Modulo de compliance conectado al token. |

### 3.3 Contratos y red configurados
Valores leidos de `EquityWorkflowCre/config.staging.json` y `EquityWorkflowCre/config.production.json`:

- `receiverAddress`: `0x83905819019A6DeeDFF834f08DeC8238e54EBf6e`
- `identityRegistryAddress`: `0x31D26dE5f5a255D0748035D90Ec739840df55280`
- `employeeVestingAddress`: `0x78a40e81b6C7770B686D6D0812431422B2CC6dbb`
- `tokenAddress`: `0x2a177f9498edAB038eBA5f094526f76118E2416F`
- `chainSelectorName`: `ethereum-testnet-sepolia`
- `gasLimit`: `1000000`

Forwarder CRE configurado en deploy script:

- `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`

## 4) Flujos funcionales end-to-end

## 4.1 Flujo A: Off-chain -> On-chain (comando de negocio)
Secuencia estandar:

1. Empresa envia accion a Lambda (`CompanyEmployeeInput` o `ManualSyncToCre`).
2. Lambda persiste en DynamoDB y genera payload `SYNC_*`.
3. Payload se envia al trigger HTTP del workflow CRE.
4. `main.ts` valida (Zod), encodea ABI y ejecuta `evmClient.writeReport`.
5. `EquityWorkflowReceiver` procesa el reporte y llama contrato destino.
6. Se mina tx en Base Sepolia.

## 4.2 Flujo B: On-chain -> Off-chain (evento de confirmacion)
Secuencia estandar:

1. Contrato on-chain emite evento de dominio.
2. Trigger de logs CRE (IdentityRegistry o EmployeeVesting) captura evento.
3. `main.ts` decodifica log y construye payload para Lambda.
4. CRE envia POST a `LAMBDA_URL`.
5. Lambda actualiza DynamoDB con estado resultante.

## 4.3 Matriz de acciones soportadas

| Accion de entrada | ActionType | Contrato/metodo destino | Evento esperado |
|---|---:|---|---|
| `SYNC_KYC` | 0 | `IdentityRegistry.registerIdentity/deleteIdentity/setCountry` | `IdentityRegistered`, `IdentityRemoved`, `CountryUpdated` |
| `SYNC_EMPLOYMENT_STATUS` | 1 | `EmployeeVesting.updateEmploymentStatus` | `EmploymentStatusUpdated` |
| `SYNC_GOAL` | 2 | `EmployeeVesting.setGoalAchieved` | `GoalUpdated` |
| `SYNC_FREEZE_WALLET` | 3 | `Token.setAddressFrozen` | `AddressFrozen` |
| `SYNC_CREATE_GRANT` | 4 | `EmployeeVesting.createGrant` | `GrantCreated` |
| `SYNC_BATCH` | 5 | `EquityWorkflowReceiver` procesa multiples sub-acciones | Multiple eventos |

Nota operacional:
`AddressFrozen` no vuelve por log trigger hoy, porque `main.ts` no escucha logs de `Token`.

## 5) Capa Web2 (Lambda + DynamoDB)

## 5.1 Modelo de datos
Defaults:

- `TABLE_NAME`: `EquityEmployeeState`
- `PARTITION_KEY`: `RecordId`

IDs:

- Empleado: `employee:<wallet>`
- Goal: `goal:<goalId>`

Campos relevantes de empleado (segun handlers actuales):

- `employeeAddress`
- `identityAddress`
- `country`
- `kycVerified`
- `employed`
- `walletFrozen`
- `grantTotalAmount`
- `claimedAmount`
- `lastOnchainEvent`
- `updatedAt`

## 5.2 Entradas Lambda principales

- `CompanyEmployeeInput`: upsert de un empleado, opcional sync automatico a CRE.
- `CompanyEmployeeBatchInput`: upsert de multiples empleados y envio de `SYNC_BATCH`.
- `ManualSyncToCre`: envio manual de payload arbitrario a CRE.
- `readEmployee`: lectura por wallet.
- `listEmployees`: scan de empleados.

## 5.3 Eventos on-chain consumidos por Lambda

- `IdentityRegistered`
- `IdentityRemoved`
- `CountryUpdated`
- `EmploymentStatusUpdated`
- `GrantCreated`
- `TokensClaimed`
- `GrantRevoked`
- `GoalUpdated`

## 6) Capa Workflow CRE (resumen)

`EquityWorkflowCre/main.ts` registra 3 handlers:

- Trigger `0`: HTTP para escrituras on-chain.
- Trigger `1`: logs de `IdentityRegistry`.
- Trigger `2`: logs de `EmployeeVesting`.

El workflow valida payloads con Zod, encodea parametros ABI con `viem`, crea el reporte con `runtime.report`, y ejecuta `writeReport` contra `receiverAddress`.

Para detalle tecnico completo consultar:
`Docs/Workflow-CRE-Chainlink.md`

## 7) Capa Protocolo Solidity (resumen)

Contratos de dominio:

- `IdentityRegistry.sol`
- `Compliance.sol`
- `Token.sol`
- `EmployeeVesting.sol`
- `EquityWorkflowReceiver.sol`

`EquityWorkflowReceiver` es el punto de entrada de CRE y requiere permisos sobre contratos de dominio para ejecutar acciones.

Para detalle tecnico completo consultar:
`Docs/Protocolo-Solidity.md`

## 8) Seguridad y permisos

## 8.1 Modelo de permisos operativo
Segun `contracts/scripts/deploy_equity_new.cjs`:

- Ownership de `IdentityRegistry` transferido a `EquityWorkflowReceiver`.
- Ownership de `Token` transferido a `EquityWorkflowReceiver`.
- `EquityWorkflowReceiver` autorizado como oracle en `EmployeeVesting`.
- Owner de `EmployeeVesting` mantiene funciones administrativas (`fundVesting`, `setOracle`, `revoke`).

## 8.2 Seguridad del receptor de reportes
`ReceiverTemplate.sol` valida:

- Caller (`forwarderAddress`)
- `expectedWorkflowId` (opcional)
- `expectedAuthor` (opcional)
- `expectedWorkflowName` (opcional, ligado a author)

Recomendacion de hardening:
Configurar `expectedWorkflowId` y/o `expectedAuthor` en produccion para restringir aun mas la fuente de reportes.

## 9) Configuracion operativa

## 9.1 Archivos clave

- `project.yaml`: RPCs por target CRE.
- `EquityWorkflowCre/workflow.yaml`: targets (`local-simulation`, `staging-settings`, `production-settings`).
- `secrets.yaml`: mapeo de `LAMBDA_URL` para secrets vault de CRE.
- `.env`: secretos locales de desarrollo y test.

## 9.2 Variables de entorno importantes

- `CRE_ETH_PRIVATE_KEY`
- `LAMBDA_URL`
- `AWS_REGION`
- `BASE_SEPOLIA_RPC_URL` (opcional)
- `AUTO_BUMP_NONCE` (tests)

## 10) Despliegue

## 10.1 Protocolo
En `contracts/`:

```bash
npm install
npx hardhat compile
# ejecutar script de despliegue segun tu flujo actual
```

Script relevante:

- `contracts/scripts/deploy_equity_new.cjs`

Este script ademas de desplegar, configura ownership, oracle permissions y fondea vesting pool.

## 10.2 Workflow CRE
En `EquityWorkflowCre/`:

```bash
npm install
cre workflow simulate ./EquityWorkflowCre --target local-simulation
```

Para escritura real en simulacion local:

```bash
cre workflow simulate ./EquityWorkflowCre \
  --target local-simulation \
  --non-interactive \
  --trigger-index 0 \
  --http-payload '{"action":"SYNC_KYC", ...}' \
  --broadcast
```

## 11) Pruebas

## 11.1 Pruebas de workflow

- `EquityWorkflowCre/tests/run-tests.mjs` (runner interactivo)
- `EquityWorkflowCre/tests/run-sync-write-test.mjs` (E2E round-trip)
- `EquityWorkflowCre/tests/run-lambda-sync-simulation.mjs` (simulacion 3 capas)

## 11.2 Pruebas de Lambda

- `lambda-function/test/sync-protocol-types.test.mjs`

Valida tipado de payloads/eventos, acumulacion de claims y errores de validacion.

## 12) Estado actual y hallazgos clave

## 12.1 Hallazgo critico: mismatch en `SYNC_BATCH`
Estado observado:

- Workflow construye lotes como `bytes[]` de payloads internos.
- Receiver espera `bytes[]` con sub-reportes completos (`actionType + payload`).

Impacto:

- `SYNC_BATCH` puede revertir o decodificar de forma invalida.

## 12.2 Hallazgo medio: sin retorno de eventos de Token
Estado observado:

- No hay trigger para logs de `Token`.

Impacto:

- `SYNC_FREEZE_WALLET` no tiene confirmacion automatica por evento on-chain hacia Lambda.

## 12.3 Hallazgo medio: compliance permisivo
Estado observado:

- `Compliance.canTransfer` retorna `true` en todos los casos.

Impacto:

- Las reglas regulatorias reales aun no estan implementadas en la capa compliance.

## 13) Recomendaciones priorizadas

1. Corregir encoding/decoding de `SYNC_BATCH` y cubrirlo con prueba E2E dedicada.
2. Agregar log trigger para `Token` o documentar formalmente que freeze es write-only en retorno.
3. Implementar logica real en `Compliance`.
4. Endurecer `ReceiverTemplate` con workflow identity checks en produccion.
5. Mantener documentacion y comentarios sincronizados con direcciones/config actual.

## 14) Mapa de documentacion

- General (este archivo): `Docs/Documentacion-Integral.md`
- Solidity: `Docs/Protocolo-Solidity.md`
- CRE: `Docs/Workflow-CRE-Chainlink.md`

