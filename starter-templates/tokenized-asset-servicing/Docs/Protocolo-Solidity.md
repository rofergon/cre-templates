# Protocolo Solidity - Guia Tecnica

## 1) Objetivo
Este documento describe en detalle la capa on-chain ubicada en `contracts/equity-protocol/`, enfocada en:

- responsabilidades de cada contrato
- modelo de permisos
- flujo de llamadas desde CRE
- eventos emitidos
- riesgos y recomendaciones de hardening

## 2) Inventario de contratos

| Contrato | Rol |
|---|---|
| `IdentityRegistry.sol` | Registro KYC (identity + country) por wallet. |
| `Compliance.sol` | Modulo de compliance conectado al token. |
| `Token.sol` | Token ERC-20 compatible con interfaz ERC-3643. |
| `EmployeeVesting.sol` | Grants, vesting, goals, employment y claims. |
| `EquityWorkflowReceiver.sol` | Entrada de reportes CRE y dispatcher de acciones. |
| `IIdentityRegistry.sol` | Interfaz de registry. |
| `ICompliance.sol` | Interfaz de compliance. |
| `IERC3643.sol` | Interfaz del token security-like. |

Dependencias de infraestructura:

- `contracts/interfaces/ReceiverTemplate.sol`
- `contracts/interfaces/IReceiver.sol`
- `contracts/interfaces/IERC165.sol`

## 3) Mapa de dependencias entre contratos

```text
EquityWorkflowReceiver
  -> IIdentityRegistry (register/delete/setCountry)
  -> EmployeeVesting (updateEmploymentStatus/setGoalAchieved/createGrant)
  -> IERC3643 Token (setAddressFrozen)

Token
  -> IIdentityRegistry (isVerified)
  -> ICompliance (canTransfer + hooks)

EmployeeVesting
  -> IERC20 Token (funding + claim transfers)
```

## 4) `IdentityRegistry.sol`

## 4.1 Responsabilidad
Mantener estado KYC minimo necesario para el protocolo:

- identity address asociada a un usuario
- country code del usuario

## 4.2 Estado

- `_identities[user] => identity`
- `_countries[user] => country`
- punteros de registries auxiliares (`identityStorage`, `claimTopicsRegistry`, etc.)

## 4.3 Funciones clave

- `registerIdentity(address user, address identity, uint16 country)`
- `deleteIdentity(address user)`
- `setCountry(address user, uint16 country)`
- `identity(address)`
- `investorCountry(address)`
- `isVerified(address)`

Todas las funciones mutables de negocio son `onlyOwner`.

## 4.4 Eventos

- `IdentityRegistered`
- `IdentityRemoved`
- `CountryUpdated`
- Eventos de update de registries auxiliares

## 5) `Compliance.sol`

## 5.1 Responsabilidad
Ofrecer interfaz de compliance para que `Token` consulte y notifique movimientos.

## 5.2 Implementacion actual

- `canTransfer` retorna `true` siempre.
- hooks `transferred`, `created`, `destroyed` existen pero sin logica.

## 5.3 Administracion

- bind/unbind token: `bindToken`, `unbindToken`
- agentes: `addTokenAgent`, `removeTokenAgent`

## 5.4 Implicacion actual
El contrato hoy funciona como "pass-through" sin enforcement regulatorio efectivo.

## 6) `Token.sol`

## 6.1 Responsabilidad
Token ERC-20 con extensiones/controles inspirados en ERC-3643:

- validacion de identidad
- validacion de compliance
- freeze global por wallet
- freeze parcial de balance
- pausa de transferencias

## 6.2 Estado principal

- `identityRegistry`
- `compliance`
- `_frozen[address]`
- `_frozenTokens[address]`
- `_paused`

## 6.3 Reglas de transferencia
Aplican en `transfer` y `transferFrom`:

1. token no pausado
2. sender y receiver no congelados
3. balance libre suficiente (`balance - frozenTokens`)
4. sender verificado en registry
5. receiver verificado en registry
6. `compliance.canTransfer == true`

Si transfiere con exito, notifica `compliance.transferred`.

## 6.4 Funciones admin

- `setIdentityRegistry`
- `setCompliance`
- `pause` / `unpause`
- `setAddressFrozen`
- `freezePartialTokens`
- `forcedTransfer`
- `mint`
- `burn`

Todas admin son `onlyOwner`.

## 6.5 Eventos relevantes

- `AddressFrozen`
- `IdentityRegistryAdded`
- `ComplianceAdded`

## 7) `EmployeeVesting.sol`

## 7.1 Responsabilidad
Gestionar grants de vesting para empleados con soporte de:

- cliff
- vesting lineal
- goals de performance
- revocacion por owner

## 7.2 Modelo de grant

```solidity
Grant {
  uint256 totalAmount;
  uint256 startTime;
  uint256 cliffDuration;
  uint256 vestingDuration;
  uint256 amountClaimed;
  bool isRevocable;
  bytes32 performanceGoalId;
}
```

Mappings:

- `grants[address]`
- `isEmployed[address]`
- `goalsAchieved[bytes32]`
- `oracles[address]`

## 7.3 Control de acceso

- `onlyOwner`: `setOracle`, `fundVesting`, `revoke`
- `onlyOracle`: `createGrant`, `updateEmploymentStatus`, `setGoalAchieved`

`onlyOracle` permite tambien al owner (`msg.sender == owner`) ademas de oracles explicitamente autorizados.

## 7.4 Flujo economico

1. Owner aprueba tokens al vesting contract.
2. Owner llama `fundVesting(amount)`.
3. Oracle/owner crea grants con `createGrant`.
4. Empleado hace `claim()` segun `calculateVestedAmount`.

## 7.5 Vesting math

- Antes de `start + cliff`: vested = 0
- Despues de `start + vestingDuration`: vested = total (si goal aplica y esta logrado)
- Durante periodo lineal: vested proporcional al tiempo transcurrido
- Si goal requerido no logrado: vested = 0

## 7.6 Revocacion
`revoke(employee)`:

- requiere `grant.isRevocable == true`
- borra grant
- marca empleado no activo
- transfiere remanente al owner

## 8) `EquityWorkflowReceiver.sol`

## 8.1 Responsabilidad
Puente on-chain que recibe reportes desde Chainlink CRE y ejecuta acciones de negocio.

## 8.2 Herencia y seguridad
Hereda `ReceiverTemplate`, que valida caller forwarder y (opcionalmente) metadatos de workflow.

## 8.3 ActionType soportados

- `0 SYNC_KYC`
- `1 SYNC_EMPLOYMENT_STATUS`
- `2 SYNC_GOAL`
- `3 SYNC_FREEZE_WALLET`
- `4 SYNC_CREATE_GRANT`
- `5 SYNC_BATCH`

## 8.4 Despacho interno
`_processReport` delega a `_processSingleReport(report)`.

`_processSingleReport`:

1. `abi.decode(report, (uint8, bytes))`
2. switch por actionType
3. decodifica payload de accion
4. llama contrato destino
5. emite `SyncActionExecuted`

## 8.5 Lote (`SYNC_BATCH`)
Decodifica `bytes[]` y procesa cada item recursivamente con `_processSingleReport`.

Importante:
Cada item del lote debe ser un sub-reporte completo (`abi.encode(uint8, bytes)`), no solo payload plano.

## 8.6 Permisos requeridos
Para ejecutar todas las rutas de negocio, receiver debe tener:

- ownership en `IdentityRegistry`
- ownership en `Token`
- permiso de oracle en `EmployeeVesting`

## 9) `ReceiverTemplate.sol` (infraestructura de recepcion)

## 9.1 Que valida
`onReport(metadata, report)` valida:

- sender == `forwarderAddress` (si esta seteado)
- `expectedWorkflowId` (opcional)
- `expectedAuthor` (opcional)
- `expectedWorkflowName` (opcional, solo si hay author)

## 9.2 Riesgo conocido
Si `forwarderAddress` se configura en `address(0)`, cualquiera podria invocar `onReport`.

## 10) Matriz de permisos

| Funcion / Operacion | Contrato | Restriccion |
|---|---|---|
| register/delete/setCountry | IdentityRegistry | `onlyOwner` |
| setAddressFrozen | Token | `onlyOwner` |
| updateEmploymentStatus | EmployeeVesting | `onlyOracle` |
| setGoalAchieved | EmployeeVesting | `onlyOracle` |
| createGrant | EmployeeVesting | `onlyOracle` |
| fundVesting | EmployeeVesting | `onlyOwner` |
| revoke | EmployeeVesting | `onlyOwner` |
| onReport | ReceiverTemplate | caller forwarder + checks opcionales |

## 11) Flujo de despliegue y ownership
`contracts/scripts/deploy_equity_new.cjs` implementa:

1. Deploy registry, compliance, token, vesting, receiver.
2. Bind de token en compliance.
3. KYC del deployer para permitir mint inicial.
4. Mint al deployer para pre-fund.
5. KYC de EmployeeVesting para que token acepte transfer hacia vesting.
6. Transfer ownership de registry y token al receiver.
7. Autorizar receiver como oracle en vesting.
8. Fundear vesting pool.

## 12) Riesgos tecnicos actuales

1. `Compliance` sin enforcement real.
2. Dependencia de configuracion correcta de ownership/oracle.
3. `SYNC_BATCH` exige encoding consistente entre CRE y receiver.
4. Falta de log trigger de `Token` en capa CRE para confirmacion off-chain automatica.

## 13) Recomendaciones para evolucion

1. Implementar reglas reales en `Compliance` (country rules, caps, blacklists, ventanas).
2. Asegurar tests de integracion para `SYNC_BATCH` (payload valido e invalido).
3. Activar validaciones de identidad de workflow en `ReceiverTemplate` para produccion.
4. Evaluar eventos/telemetria adicional para auditoria y observabilidad.

