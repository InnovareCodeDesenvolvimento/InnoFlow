/**
 * Allowlist de campos por entidade para o diff do log de auditoria
 * (`AuditLog.changes`, ver `core/auditoria/diffEntity.ts`). Fica em
 * `api/lib/` (não em `core/`) porque descreve o VOCABULÁRIO das rotas REST
 * (nomes de campo do Prisma), não é lógica de domínio pura — mas o cálculo
 * do diff em si continua em `core/`.
 *
 * Regra (Nova): allowlist, nunca denylist. Campo novo em qualquer model
 * SOME do log por padrão até alguém decidir explicitamente incluí-lo aqui —
 * o oposto de vazar por padrão.
 */
export const AUDIT_ALLOWLIST_BY_ENTITY: Record<string, readonly string[]> = {
  Site: ['name', 'addressLine', 'city', 'state', 'postalCode', 'country', 'latitude', 'longitude', 'timezone', 'openingHours', 'active'],
  ChargePoint: ['siteId', 'ocppIdentity', 'vendor', 'model', 'serialNumber', 'firmwareVersion', 'active'],
  Connector: ['chargePointId', 'connectorId', 'type', 'maxPowerKw', 'status'],
  Tariff: [
    'name',
    'model',
    'pricePerKwh',
    'pricePerMinute',
    'sessionFeeCents',
    'minChargeCents',
    'idleFeePerMinute',
    'idleGracePeriodSeconds',
    'currency',
    'active',
  ],
  TariffAssignment: ['tariffId', 'scope', 'connectorId', 'chargePointId', 'siteId', 'priority', 'validFrom', 'validTo'],
  // `idTag` entra na allowlist mas é MASCARADO por `diffEntity` (só os 4
  // últimos caracteres) — nunca o valor completo, mesmo aqui.
  AuthToken: ['idTag', 'type', 'userId', 'status', 'expiresAt'],
}

export function allowlistFor(entityType: string | null): readonly string[] {
  if (!entityType) return []
  return AUDIT_ALLOWLIST_BY_ENTITY[entityType] ?? []
}
