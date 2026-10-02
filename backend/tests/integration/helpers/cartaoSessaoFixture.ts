import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import request from 'supertest'
import type { IHandlersOption } from 'ocpp-rpc'
import type { Express } from 'express'
import { prisma } from '../../../src/lib/prisma'
import { createRedisConnection } from '../../../src/lib/redis'
import { issueToken } from '../../../src/lib/jwt'
import { encryptPaymentSecret } from '../../../src/lib/crypto/paymentSecrets'
import type { OcppHandlerCtx } from '../../../src/ocpp/context'
import { handleStartTransaction } from '../../../src/ocpp/handlers/startTransaction'
import { handleStopTransaction } from '../../../src/ocpp/handlers/stopTransaction'
import { createTenant, type TestTenant } from './fixtures'

/**
 * Fixture de sessão de recarga paga com CARTÃO, de ponta a ponta (API `/api/me/sessions/start` -> StartTransaction ->
 * StopTransaction), reaproveitada pelas suítes de captura da F5.7. Tudo leva o `suffix` do arquivo de teste (as suítes
 * rodam em paralelo no mesmo Postgres — ver `fixtures.ts`).
 */

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

export function callHandler<T>(handler: (args: IHandlersOption, ctx: OcppHandlerCtx) => Promise<T>, ctx: OcppHandlerCtx, params: unknown, messageId: string = randomUUID()): Promise<T> {
  return handler({ messageId, params, method: 'X', signal: new AbortController().signal } as unknown as IHandlersOption, ctx)
}

export interface FixtureCartao {
  tenant: TestTenant
  ctx: OcppHandlerCtx
  adminToken: string
  /** Sessão CARD iniciada e PARADA (3 kWh = 300 centavos) -> intent `CAPTURE_PENDING`. `antesDoStop` roda logo antes do Stop (ex.: derrubar o Redis). */
  sessaoParada(label: string, antesDoStop?: () => Promise<void>): Promise<{ intent: { id: string; cieloPaymentId: string | null }; stop: { idTagInfo: { status: string } }; stopMs: number }>
  /** Envelhece o intent (o `updatedAt` é o que o varredor olha). */
  envelhecer(intentId: string, minutos: number): Promise<unknown>
  /** Bloco `reconciliation` do relatório de pagamentos do operador do teste. */
  conciliacao(): Promise<Record<string, number>>
}

export async function criarFixtureCartao(app: Express, suffix: string, label: string): Promise<FixtureCartao> {
  const tenant = await createTenant({ suffix, label })
  await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { active: true, lastSeenAt: new Date() } })
  await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
  const ctx: OcppHandlerCtx = { chargePointId: tenant.chargePointId, operatorId: tenant.operatorId, ocppIdentity: tenant.ocppIdentity }
  const admin = await prisma.user.create({ data: { role: 'ADMIN', name: `Admin ${label} ${suffix}`, email: `admin-${label}-${suffix}@example.com` } })
  const adminToken = issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })
  const connectorCounter = { n: 100 }

  async function newDriverWithCard(l: string) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista ${label} ${l} ${suffix}`, email: `driver-${label}-${l}-${suffix}@example.com` } })
    const paymentMethod = await prisma.paymentMethod.create({
      data: { userId: user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(`test-card-token-${label}-${l}-${suffix}`), brand: 'Visa', last4: '4242', isDefault: true },
    })
    return { user, paymentMethod, token: issueToken({ id: user.id, role: 'DRIVER', operatorId: null }) }
  }

  async function newConnector() {
    connectorCounter.n += 1
    return prisma.connector.create({ data: { operatorId: tenant.operatorId, chargePointId: tenant.chargePointId, connectorId: connectorCounter.n, type: 'AC_TYPE2', status: 'AVAILABLE' } })
  }

  /** Fake gateway OCPP: responde ao RemoteStartTransaction publicado (sem WebSocket de verdade). */
  async function startCardSession(driver: Awaited<ReturnType<typeof newDriverWithCard>>, connectorId: number) {
    const subscriber = createRedisConnection()
    const publisher = createRedisConnection()
    const channel = `ocpp:cmd:${tenant.chargePointId}`
    await subscriber.subscribe(channel)
    subscriber.on('message', (ch, message) => {
      if (ch !== channel) return
      try {
        const payload = JSON.parse(message) as { correlationId: string; method: string }
        if (payload.method !== 'RemoteStartTransaction') return
        // `.catch`: o `disconnect()` do `finally` pode chegar antes do ACK — sem isto o ioredis rejeita sem ouvinte e o vitest sai com código 1.
        publisher.publish(`ocpp:reply:${payload.correlationId}`, JSON.stringify({ correlationId: payload.correlationId, ok: true, result: { status: 'Accepted' } })).catch(() => {})
      } catch {
        // mensagem malformada — ignora
      }
    })
    try {
      const res = await request(app)
        .post('/api/me/sessions/start')
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ ocppIdentity: tenant.ocppIdentity, connectorId, payment: { mode: 'CARD', paymentMethodId: driver.paymentMethod.id } })
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      const authToken = await prisma.authToken.findFirstOrThrow({ where: { userId: driver.user.id, type: 'VIRTUAL' }, orderBy: { createdAt: 'desc' } })
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { authTokenId: authToken.id } })
      return { authToken, intent }
    } finally {
      subscriber.disconnect()
      publisher.disconnect()
    }
  }

  return {
    tenant,
    ctx,
    adminToken,
    async sessaoParada(l, antesDoStop) {
      const driver = await newDriverWithCard(l)
      const { connectorId } = await newConnector()
      const { authToken, intent } = await startCardSession(driver, connectorId)
      const meterStart = 500
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(10).toISOString() })
      await antesDoStop?.()
      const t0 = Date.now()
      const stop = await callHandler(handleStopTransaction, ctx, { transactionId: start.transactionId, meterStop: meterStart + 3_000, timestamp: minutesAgo(1).toISOString(), reason: 'Local' })
      return { intent, stop, stopMs: Date.now() - t0 }
    },
    envelhecer: (intentId, minutos) => prisma.paymentIntent.update({ where: { id: intentId }, data: { updatedAt: minutesAgo(minutos) } }),
    async conciliacao() {
      const from = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)
      const to = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10)
      const res = await request(app).get('/api/admin/reports/payments').query({ from, to, operatorId: tenant.operatorId, pageSize: 100 }).set('Authorization', `Bearer ${adminToken}`)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.reconciliation as Record<string, number>
    },
  }
}
