import { Prisma } from '@prisma/client'
import type { ReportingScope } from './reportingScope'

/**
 * Fragmentos de `WHERE` compartilhados pelas queries de agregação
 * (`$queryRaw`). `operatorId`/`siteId`/`chargePointId` SEMPRE entram como
 * bind param (`Prisma.sql`), nunca concatenados na string — só o nome do
 * alias da tabela (fixo no código, nunca vindo de request) usa
 * `Prisma.raw`.
 */

function col(alias: string, name: string): Prisma.Sql {
  return Prisma.raw(`${alias}."${name}"`)
}

/** Para tabelas com FK direta (ChargingSession, MeterSample...): operatorId/siteId/chargePointId são colunas próprias. */
export function tenantConditions(scope: ReportingScope, alias: string): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = []
  if (scope.operatorId) conditions.push(Prisma.sql`${col(alias, 'operatorId')} = ${scope.operatorId}`)
  if (scope.siteId) conditions.push(Prisma.sql`${col(alias, 'siteId')} = ${scope.siteId}`)
  if (scope.chargePointId) conditions.push(Prisma.sql`${col(alias, 'chargePointId')} = ${scope.chargePointId}`)
  return conditions
}

/** Para a própria tabela ChargePoint: "chargePointId" do escopo se refere ao `id` dela, não a uma FK. */
export function chargePointTenantConditions(scope: ReportingScope, alias: string): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = []
  if (scope.operatorId) conditions.push(Prisma.sql`${col(alias, 'operatorId')} = ${scope.operatorId}`)
  if (scope.siteId) conditions.push(Prisma.sql`${col(alias, 'siteId')} = ${scope.siteId}`)
  if (scope.chargePointId) conditions.push(Prisma.sql`${col(alias, 'id')} = ${scope.chargePointId}`)
  return conditions
}

/** Regra de ouro: a data que define o período é SEMPRE `startedAt`, nunca `stoppedAt`. */
export function periodConditions(alias: string, from: Date, to: Date): Prisma.Sql[] {
  return [Prisma.sql`${col(alias, 'startedAt')} >= ${from}`, Prisma.sql`${col(alias, 'startedAt')} < ${to}`]
}

export function whereSql(conditions: Prisma.Sql[]): Prisma.Sql {
  return conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`
}

/** Converte um valor numérico que pode vir como `bigint`/`Decimal`/string do driver em `number` JS seguro. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (value === null || value === undefined) return 0
  return Number(value)
}
