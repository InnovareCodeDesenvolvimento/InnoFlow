import { randomUUID } from 'node:crypto'
import request from 'supertest'
import type { Express } from 'express'
import { Queue } from 'bullmq'
import { prisma } from '../../../src/lib/prisma'
import { env } from '../../../src/lib/env'
import { createRedisConnection } from '../../../src/lib/redis'
import { issueToken } from '../../../src/lib/jwt'
import { encryptPaymentSecret } from '../../../src/lib/crypto/paymentSecrets'
import type { OcppHandlerCtx } from '../../../src/ocpp/context'
import { handleStartTransaction } from '../../../src/ocpp/handlers/startTransaction'
import { handleStopTransaction } from '../../../src/ocpp/handlers/stopTransaction'
import { resetGatewayConfigCacheParaTeste } from '../../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../../src/services/pagamentos/pagamentoPortInstance'
import { resetAlertasCieloParaTeste } from '../../../src/services/pagamentos/cieloHttpClient'
import { CAPTURAR_SESSAO_CARTAO_QUEUE_NAME } from '../../../src/worker/queues'
import { capturaJobId } from '../../../src/services/pagamentos/capturarSessaoCartao'
import { createTenant, type TestTenant } from './fixtures'
import { callHandler } from './cartaoSessaoFixture'

/**
 * Cenário de cartão contra a "Cielo" HTTP FALSA com o `CieloAdapter` REAL (nada de FakeAdapter): configura o `env` do processo de teste para
 * apontar o adaptador para o servidor local, e expõe início (POST /api/me/sessions/start), StartTransaction e StopTransaction.
 * Íris, 04/10/2026. Cada arquivo de teste tem o próprio módulo `env` (Vitest isola por arquivo), então mutar `env` aqui é seguro.
 */

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

export function apontarAdaptadorParaCieloFalsa(urlCielo: string, extras: { timeoutMs?: number; sandbox?: boolean } = {}): void {
  const e = env as Record<string, unknown>
  e.CIELO_MERCHANT_ID = 'merchant-id-iris-real'
  e.CIELO_MERCHANT_KEY = 'merchant-key-iris-real-0001'
  e.CIELO_TIMEOUT_MS = extras.timeoutMs ?? 500
  e.CIELO_QUERY_TIMEOUT_MS = extras.timeoutMs ?? 500
  e.CIELO_SANDBOX = extras.sandbox ?? true
  process.env.CIELO_API_BASE_URL = urlCielo
  process.env.CIELO_API_QUERY_BASE_URL = urlCielo
  resetGatewayConfigCacheParaTeste()
  resetPagamentoPortCacheParaTeste()
  resetAlertasCieloParaTeste()
}

export interface Motorista {
  user: { id: string }
  paymentMethod: { id: string }
  token: string
}

export interface CenarioCartaoHttp {
  tenant: TestTenant
  ctx: OcppHandlerCtx
  novoMotorista(label: string): Promise<Motorista>
  novoConector(): Promise<number>
  /** `POST /api/me/sessions/start` com um "gateway OCPP" que aceita o RemoteStart. Não asserta o status: devolve a resposta crua. */
  iniciar(motorista: Motorista, connectorId: number, opcoes?: { rejeitarRemoteStart?: boolean }): Promise<request.Response>
  /** Start + StartTransaction + StopTransaction (3 kWh = 300 centavos), devolvendo o intent (CAPTURE_PENDING). */
  sessaoParada(label: string, antesDoStop?: () => Promise<void>): Promise<{ intentId: string; cieloPaymentId: string; sessionId: string }>
  /** Sessão iniciada (intent AUTHORIZED) e abandonada: o RemoteStart foi aceito mas nenhum StartTransaction chegou. */
  autorizadaAbandonada(label: string): Promise<{ intentId: string; cieloPaymentId: string }>
  envelhecer(intentId: string, minutos: number): Promise<void>
  removerJobDeCaptura(intentId: string): Promise<void>
  fechar(): Promise<void>
}

export async function criarCenarioCartaoHttp(app: Express, suffix: string, label: string, opcoes: { ambiente?: 'SANDBOX' | 'PRODUCTION' } = {}): Promise<CenarioCartaoHttp> {
  const tenant = await createTenant({ suffix, label })
  await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { active: true, lastSeenAt: new Date() } })
  await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
  const ctx: OcppHandlerCtx = { chargePointId: tenant.chargePointId, operatorId: tenant.operatorId, ocppIdentity: tenant.ocppIdentity }
  const contador = { n: 100 }
  const filaCaptura = new Queue(CAPTURAR_SESSAO_CARTAO_QUEUE_NAME, { connection: createRedisConnection() })

  async function novoMotorista(l: string): Promise<Motorista> {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista ${label} ${l} ${suffix}`, email: `driver-${label}-${l}-${suffix}-${randomUUID().slice(0, 6)}@example.com` } })
    const paymentMethod = await prisma.paymentMethod.create({
      data: { userId: user.id, type: 'CREDIT_CARD', environment: opcoes.ambiente ?? 'SANDBOX', cieloCardTokenCiphertext: encryptPaymentSecret(`TOKEN-DE-CARTAO-IRIS-${label}-${l}-${suffix}`), brand: 'Visa', last4: '4242', isDefault: true },
    })
    return { user, paymentMethod, token: issueToken({ id: user.id, role: 'DRIVER', operatorId: null }) }
  }

  async function novoConector(): Promise<number> {
    contador.n += 1
    const c = await prisma.connector.create({ data: { operatorId: tenant.operatorId, chargePointId: tenant.chargePointId, connectorId: contador.n, type: 'AC_TYPE2', status: 'AVAILABLE' } })
    return c.connectorId
  }

  async function iniciar(motorista: Motorista, connectorId: number, opcoes: { rejeitarRemoteStart?: boolean } = {}): Promise<request.Response> {
    const subscriber = createRedisConnection()
    const publisher = createRedisConnection()
    const channel = `ocpp:cmd:${tenant.chargePointId}`
    await subscriber.subscribe(channel)
    subscriber.on('message', (ch, message) => {
      if (ch !== channel) return
      try {
        const payload = JSON.parse(message) as { correlationId: string; method: string }
        if (payload.method !== 'RemoteStartTransaction') return
        publisher.publish(`ocpp:reply:${payload.correlationId}`, JSON.stringify({ correlationId: payload.correlationId, ok: true, result: { status: opcoes.rejeitarRemoteStart ? 'Rejected' : 'Accepted' } })).catch(() => {})
      } catch {
        // ignora
      }
    })
    try {
      return await request(app)
        .post('/api/me/sessions/start')
        .set('Authorization', `Bearer ${motorista.token}`)
        .send({ ocppIdentity: tenant.ocppIdentity, connectorId, payment: { mode: 'CARD', paymentMethodId: motorista.paymentMethod.id } })
    } finally {
      // dá tempo do ACK do RemoteStart ser consumido pela rota antes de fechar as conexões
      await new Promise((r) => setTimeout(r, 120))
      subscriber.disconnect()
      publisher.disconnect()
    }
  }

  async function intentDoMotorista(userId: string) {
    return prisma.paymentIntent.findFirstOrThrow({ where: { userId, purpose: 'SESSION_CARD_CAPTURE' }, orderBy: { createdAt: 'desc' } })
  }

  async function removerJobDeCaptura(intentId: string): Promise<void> {
    const job = await filaCaptura.getJob(capturaJobId(intentId))
    await job?.remove().catch(() => {})
  }

  return {
    tenant,
    ctx,
    novoMotorista,
    novoConector,
    iniciar,
    async sessaoParada(l, antesDoStop) {
      const motorista = await novoMotorista(l)
      const connectorId = await novoConector()
      const res = await iniciar(motorista, connectorId)
      if (res.status !== 202) throw new Error(`start devolveu ${res.status}: ${JSON.stringify(res.body)}`)
      const authToken = await prisma.authToken.findFirstOrThrow({ where: { userId: motorista.user.id, type: 'VIRTUAL' }, orderBy: { createdAt: 'desc' } })
      const meterStart = 500
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(10).toISOString() })
      await antesDoStop?.()
      await callHandler(handleStopTransaction, ctx, { transactionId: start.transactionId, meterStop: meterStart + 3_000, timestamp: minutesAgo(1).toISOString(), reason: 'Local' })
      const intent = await intentDoMotorista(motorista.user.id)
      await removerJobDeCaptura(intent.id) // o job vai para a fila de nome fixo, compartilhada com outras suítes: tira antes que outro worker o pegue
      if (intent.status !== 'CAPTURE_PENDING') throw new Error(`intent ficou ${intent.status}, esperado CAPTURE_PENDING`)
      return { intentId: intent.id, cieloPaymentId: intent.cieloPaymentId!, sessionId: intent.chargingSessionId! }
    },
    async autorizadaAbandonada(l) {
      const motorista = await novoMotorista(l)
      const connectorId = await novoConector()
      const res = await iniciar(motorista, connectorId)
      if (res.status !== 202) throw new Error(`start devolveu ${res.status}: ${JSON.stringify(res.body)}`)
      const intent = await intentDoMotorista(motorista.user.id)
      return { intentId: intent.id, cieloPaymentId: intent.cieloPaymentId! }
    },
    async envelhecer(intentId, minutos) {
      const atual = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId }, select: { authorizedAt: true } })
      await prisma.paymentIntent.update({ where: { id: intentId }, data: { updatedAt: minutesAgo(minutos), createdAt: minutesAgo(minutos), ...(atual.authorizedAt ? { authorizedAt: minutesAgo(minutos) } : {}) } })
    },
    removerJobDeCaptura,
    fechar: () => filaCaptura.close(),
  }
}
