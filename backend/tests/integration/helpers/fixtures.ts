import { randomUUID } from 'node:crypto'
import type { Role } from '@prisma/client'
import { prisma } from '../../../src/lib/prisma'
import { issueToken } from '../../../src/lib/jwt'

/**
 * Fixtures compartilhadas pelas suítes de integração (Íris, 2026-09-19).
 *
 * As suítes rodam EM PARALELO contra o MESMO Postgres (vitest = 1 worker por
 * arquivo), então a regra de ouro aqui é: TODO dado de um teste leva um
 * sufixo único e o teste só afirma sobre os ids que ELE criou — nunca sobre
 * contagens globais de tabela.
 */

export function uniqueSuffix(): string {
  return randomUUID().slice(0, 8)
}

/** idTag OCPP tem no máximo 20 caracteres. */
export function makeIdTag(): string {
  return `T${randomUUID().replace(/-/g, '')}`.slice(0, 20)
}

export interface TestUser {
  id: string
  email: string
  name: string
  role: Role
  operatorId: string | null
  token: string
}

export async function createUser(input: { role: Role; label: string; suffix: string; operatorId?: string | null; passwordHash?: string | null }): Promise<TestUser> {
  const email = `${input.label}-${input.suffix}@example.com`
  const name = `${input.label} ${input.suffix}`
  const user = await prisma.user.create({
    data: {
      role: input.role,
      operatorId: input.role === 'OPERATOR' ? (input.operatorId ?? null) : null,
      name,
      email,
      passwordHash: input.passwordHash ?? null,
    },
  })
  return {
    id: user.id,
    email,
    name,
    role: input.role,
    operatorId: user.operatorId,
    token: issueToken({ id: user.id, role: input.role, operatorId: user.operatorId }),
  }
}

export interface TestTenant {
  operatorId: string
  siteId: string
  chargePointId: string
  ocppIdentity: string
  connectorId: string
  tariffId: string
  staff: TestUser
}

export interface CreateTenantOptions {
  suffix: string
  label: string
  latitude?: number
  longitude?: number
  /** Cria também o conector 1 (AC_TYPE2, AVAILABLE) e a tarifa PER_KWH com vínculo de escopo OPERATOR. Default: true. */
  withCharger?: boolean
}

/** Um operador completo (operador + site + charge point + conector + tarifa + usuário OPERATOR). Os ids saem tipados pra o teste usar direto. */
export async function createTenant(opts: CreateTenantOptions): Promise<TestTenant> {
  const { suffix, label } = opts
  const operator = await prisma.operator.create({ data: { name: `Operador ${label} ${suffix}`, email: `operador-${label}-${suffix}@example.com` } })
  const site = await prisma.site.create({
    data: {
      operatorId: operator.id,
      name: `Site ${label} ${suffix}`,
      addressLine: `Rua ${label}`,
      city: 'São Paulo',
      state: 'SP',
      postalCode: '00000-000',
      latitude: opts.latitude ?? -23.5,
      longitude: opts.longitude ?? -46.6,
    },
  })
  const chargePoint = await prisma.chargePoint.create({
    data: { operatorId: operator.id, siteId: site.id, ocppIdentity: `cp-${label}-${suffix}`, basicAuthSecretHash: 'x' },
  })
  const connector = await prisma.connector.create({ data: { operatorId: operator.id, chargePointId: chargePoint.id, connectorId: 1, type: 'AC_TYPE2' } })
  const tariff = await prisma.tariff.create({ data: { operatorId: operator.id, name: `Tarifa ${label} ${suffix}`, model: 'PER_KWH', pricePerKwh: '1.00' } })
  const staff = await createUser({ role: 'OPERATOR', label: `staff-${label}`, suffix, operatorId: operator.id })

  return {
    operatorId: operator.id,
    siteId: site.id,
    chargePointId: chargePoint.id,
    ocppIdentity: chargePoint.ocppIdentity,
    connectorId: connector.id,
    tariffId: tariff.id,
    staff,
  }
}

/**
 * Tenta `fn` até devolver algo "truthy" (ou estourar o tempo). Existe porque
 * a auditoria é fire-and-forget (`res.on('finish')` — a linha aparece DEPOIS
 * da resposta HTTP). Nunca use `setTimeout` fixo no lugar disto para afirmar
 * que ALGO existe; para afirmar que algo NÃO existe use `settle()` abaixo.
 */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const intervalMs = opts.intervalMs ?? 50
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`waitFor: condição não satisfeita em ${timeoutMs}ms${opts.what ? ` (${opts.what})` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Janela de "assentamento" para afirmar AUSÊNCIA de efeito assíncrono
 * (ex.: 400/401 não gravam auditoria). Só é válida DEPOIS de já ter esperado
 * (via `waitFor`) por um efeito irmão da MESMA rodada — o caso "sentinela":
 * a linha do request seguinte já apareceu, então a do request anterior (se
 * fosse existir) já teria aparecido também.
 */
export function settle(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
