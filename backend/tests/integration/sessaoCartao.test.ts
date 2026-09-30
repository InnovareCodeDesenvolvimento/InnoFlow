import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { IHandlersOption } from 'ocpp-rpc'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis, createRedisConnection } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'
import { encryptPaymentSecret } from '../../src/lib/crypto/paymentSecrets'
import { getPagamentoPort } from '../../src/services/pagamentos/pagamentoPortInstance'
import { capturarSessaoCartao } from '../../src/services/pagamentos/capturarSessaoCartao'
import { varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import type { OcppHandlerCtx } from '../../src/ocpp/context'
import { handleStartTransaction } from '../../src/ocpp/handlers/startTransaction'
import { handleMeterValues } from '../../src/ocpp/handlers/meterValues'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { createTenant, waitFor, uniqueSuffix, type TestTenant } from './helpers/fixtures'

/**
 * F5.4 (Vega, 2026-09-30) — sessão de recarga cobrando de cartão
 * (pré-auth + captura parcial). Cobre os cenários mínimos pedidos no
 * handoff: ciclo feliz com captura parcial, sessão sem consumo (VOIDED),
 * RemoteStart rejeitado (VOIDED na hora), guarda do MeterValues pelo teto
 * autorizado (não pelo saldo da carteira), e o varredor cancelando
 * pré-autorização abandonada. `FakeAdapter` no lugar da Cielo (sem
 * credencial de sandbox — ver `pagamentoPortInstance.ts`: sem
 * `CIELO_MERCHANT_ID`/`_KEY`, todo teste cai no `FakeAdapter` sozinho).
 *
 * `callHandler`/padrão de fixture copiados de `ledgerConciliation.test.ts` —
 * handlers OCPP chamados direto (o transporte WebSocket não muda a regra de
 * negócio).
 */

function callHandler<T>(handler: (args: IHandlersOption, ctx: OcppHandlerCtx) => Promise<T>, ctx: OcppHandlerCtx, params: unknown, messageId: string = randomUUID()): Promise<T> {
  return handler({ messageId, params, method: 'X', signal: new AbortController().signal } as unknown as IHandlersOption, ctx)
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

/**
 * Fake "gateway OCPP" — responde ao `RemoteStartTransaction` publicado por
 * `iniciarSessaoRemota` (via `ocpp/commands.ts`) SEM precisar de uma conexão
 * OCPP-RPC de verdade. `fn` recebe o corpo INTEIRO do teste (não só a
 * chamada HTTP): a rota responde 202 de forma fire-and-forget, então o
 * assinante Redis precisa continuar vivo até qualquer reação assíncrona ao
 * Accepted/Rejected (ex.: `waitFor` esperando o VOIDED) já ter acontecido —
 * desconectar logo depois do POST derrubaria o listener ANTES da réplica
 * chegar.
 */
async function withFakeRemoteStartResponder<T>(chargePointId: string, status: 'Accepted' | 'Rejected', fn: () => Promise<T>): Promise<T> {
  const subscriber = createRedisConnection()
  const publisher = createRedisConnection()
  const channel = `ocpp:cmd:${chargePointId}`
  await subscriber.subscribe(channel)
  subscriber.on('message', (ch, message) => {
    if (ch !== channel) return
    try {
      const payload = JSON.parse(message) as { correlationId: string; method: string }
      if (payload.method !== 'RemoteStartTransaction') return
      void publisher.publish(`ocpp:reply:${payload.correlationId}`, JSON.stringify({ correlationId: payload.correlationId, ok: true, result: { status } }))
    } catch {
      // mensagem malformada — ignora, mesmo espírito do listener real
    }
  })
  try {
    return await fn()
  } finally {
    subscriber.disconnect()
    publisher.disconnect()
  }
}

describe('Sessão de recarga com cartão (F5.4, Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const pagamentoPort = getPagamentoPort() // FakeAdapter — sem credencial Cielo no ambiente de teste (ver pagamentoPortInstance.ts)

  let tenant: TestTenant
  let ctx: OcppHandlerCtx
  let adminToken: string
  const connectorCounter = { n: 1 }

  async function newDriverWithCard(label: string) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista Cartao ${label} ${suffix}`, email: `driver-card-${label}-${suffix}@example.com` } })
    const cardToken = `test-card-token-${label}-${suffix}`
    const paymentMethod = await prisma.paymentMethod.create({
      data: { userId: user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(cardToken), brand: 'Visa', last4: '4242', isDefault: true },
    })
    const token = issueToken({ id: user.id, role: 'DRIVER', operatorId: null })
    return { user, paymentMethod, token }
  }

  async function newConnector() {
    connectorCounter.n += 1
    const connector = await prisma.connector.create({ data: { operatorId: tenant.operatorId, chargePointId: tenant.chargePointId, connectorId: connectorCounter.n, type: 'AC_TYPE2', status: 'AVAILABLE' } })
    return connector
  }

  const reportFor = async (auth: string) => {
    const from = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)
    const to = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10)
    const res = await request(app).get('/api/admin/reports/payments').query({ from, to, operatorId: tenant.operatorId, pageSize: 100 }).set('Authorization', `Bearer ${auth}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.reconciliation as Record<string, number>
  }

  /** Início de sessão CARD via HTTP, dentro do fake gateway — devolve a resposta HTTP + o AuthToken/PaymentIntent já ligados (síncronos, antes do 202 voltar). */
  async function startCardSession(driver: Awaited<ReturnType<typeof newDriverWithCard>>, connectorId: number, remoteStartStatus: 'Accepted' | 'Rejected') {
    return withFakeRemoteStartResponder(tenant.chargePointId, remoteStartStatus, async () => {
      const res = await request(app)
        .post('/api/me/sessions/start')
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ ocppIdentity: tenant.ocppIdentity, connectorId, payment: { mode: 'CARD', paymentMethodId: driver.paymentMethod.id } })
      expect(res.status, JSON.stringify(res.body)).toBe(202)

      const authToken = await prisma.authToken.findFirstOrThrow({ where: { userId: driver.user.id, type: 'VIRTUAL' }, orderBy: { createdAt: 'desc' } })
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { authTokenId: authToken.id } })
      return { res, authToken, intent }
    })
  }

  beforeAll(async () => {
    tenant = await createTenant({ suffix, label: 'card' })
    await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { active: true, lastSeenAt: new Date() } })
    await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
    ctx = { chargePointId: tenant.chargePointId, operatorId: tenant.operatorId, ocppIdentity: tenant.ocppIdentity }

    const admin = await prisma.user.create({ data: { role: 'ADMIN', name: `Admin Card ${suffix}`, email: `admin-card-${suffix}@example.com` } })
    adminToken = issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  // ---------------------------------------------------------------------------
  describe('ciclo feliz: pré-auth -> StartTransaction liga o intent -> consumo dentro do teto -> captura parcial -> conciliação fecha em zero', () => {
    it('faz o ciclo completo e a diferença de conciliação é exatamente 0', async () => {
      const driver = await newDriverWithCard('feliz')
      const { connectorId } = await newConnector()

      const { res: startRes, authToken, intent: intentAfterAuth } = await startCardSession(driver, connectorId, 'Accepted')
      expect(startRes.body.paymentMode).toBe('CARD')
      expect(startRes.body.authorizedCents).toBeGreaterThan(0)
      expect(intentAfterAuth).toMatchObject({ status: 'AUTHORIZED', purpose: 'SESSION_CARD_CAPTURE' })
      expect(intentAfterAuth.amountAuthorizedCents).toBeGreaterThan(0)

      const meterStart = 5_000
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(30).toISOString() })
      expect(start.idTagInfo.status).toBe('Accepted')
      const session = await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: start.transactionId } })
      expect(session.paymentMode).toBe('CARD')

      const intentAfterStart = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentAfterAuth.id } })
      expect(intentAfterStart.chargingSessionId).toBe(session.id)

      // Consumo BEM dentro do teto autorizado (tarifa R$1,00/kWh, piso de
      // reserva default R$50,00) — 10 kWh = 1000 centavos.
      await callHandler(handleMeterValues, ctx, {
        connectorId,
        transactionId: start.transactionId,
        meterValue: [{ timestamp: minutesAgo(15).toISOString(), sampledValue: [{ value: String(meterStart + 10_000), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
      })

      const stop = await callHandler(handleStopTransaction, ctx, { transactionId: start.transactionId, meterStop: meterStart + 10_000, timestamp: minutesAgo(5).toISOString(), reason: 'Local' })
      expect(stop.idTagInfo.status).toBe('Accepted')

      const stoppedSession = await prisma.chargingSession.findUniqueOrThrow({ where: { id: session.id } })
      expect(stoppedSession).toMatchObject({ status: 'STOPPED', totalCostCents: 1000 })

      const intentAfterStop = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentAfterAuth.id } })
      expect(intentAfterStop).toMatchObject({ status: 'CAPTURE_PENDING', captureAmountCents: 1000 })

      // O worker real não está rodando neste teste — chama a captura direto
      // (mesma função que o job chamaria).
      const capturado = await capturarSessaoCartao(intentAfterAuth.id, pagamentoPort)
      expect(capturado).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 1000, debtId: null, shortfallCents: 0 })

      expect(await prisma.debt.count({ where: { userId: driver.user.id } })).toBe(0)

      const r = await reportFor(adminToken)
      expect(r).toMatchObject({ revenueCents: 1000, cardCapturedCents: 1000, cardCapturePendingCents: 0, expectedCents: 1000, accountedCents: 1000, differenceCents: 0 })
    })
  })

  // ---------------------------------------------------------------------------
  describe('sessão sem consumo (total=0) -> cancela a pré-auth direto (VOIDED), nunca chega a CAPTURE_PENDING', () => {
    it('StopTransaction com 0 Wh entregue cancela a pré-autorização', async () => {
      const driver = await newDriverWithCard('zero')
      const { connectorId } = await newConnector()

      const { authToken, intent } = await startCardSession(driver, connectorId, 'Accepted')

      const meterStart = 8_000
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(10).toISOString() })
      const session = await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: start.transactionId } })

      // 0 Wh entregue — carro nunca chegou a puxar energia.
      await callHandler(handleStopTransaction, ctx, { transactionId: start.transactionId, meterStop: meterStart, timestamp: minutesAgo(1).toISOString(), reason: 'EVDisconnected' })

      const stoppedSession = await prisma.chargingSession.findUniqueOrThrow({ where: { id: session.id } })
      expect(stoppedSession.totalCostCents).toBe(0)

      const intentAfter = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(intentAfter.status).toBe('VOIDED')
      expect(intentAfter.cancelledAt).not.toBeNull()

      const tokenAfter = await prisma.authToken.findUniqueOrThrow({ where: { id: authToken.id } })
      expect(tokenAfter.status).toBe('EXPIRED')

      // A sessão de 0 Wh não soma NADA em nenhum termo (revenue += 0, sem
      // captura/dívida) — a conciliação acumulada do operador (que já tem a
      // sessão CAPTURADA de 1000 do describe anterior, executado ANTES deste
      // por ordem de declaração — vitest roda describes/it top-a-baixo por
      // padrão) continua fechando em zero.
      const r = await reportFor(adminToken)
      expect(r).toMatchObject({ revenueCents: 1000, cardCapturedCents: 1000, accountedCents: 1000, differenceCents: 0 })
    })
  })

  // ---------------------------------------------------------------------------
  describe('RemoteStart rejeitado pelo carregador -> cancela a pré-autorização na hora', () => {
    it('Rejected devolvido pelo carregador cancela o intent sem esperar o varredor', async () => {
      const driver = await newDriverWithCard('rejeitado')
      const { connectorId } = await newConnector()

      await withFakeRemoteStartResponder(tenant.chargePointId, 'Rejected', async () => {
        const res = await request(app)
          .post('/api/me/sessions/start')
          .set('Authorization', `Bearer ${driver.token}`)
          .send({ ocppIdentity: tenant.ocppIdentity, connectorId, payment: { mode: 'CARD', paymentMethodId: driver.paymentMethod.id } })
        expect(res.status, JSON.stringify(res.body)).toBe(202)

        const authToken = await prisma.authToken.findFirstOrThrow({ where: { userId: driver.user.id, type: 'VIRTUAL' }, orderBy: { createdAt: 'desc' } })
        const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { authTokenId: authToken.id } })
        expect(intent.status).toBe('AUTHORIZED') // ainda autorizado na hora do 202 — o cancelamento é assíncrono (reação ao Rejected)

        const cancelado = await waitFor(async () => {
          const row = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
          return row.status === 'VOIDED' ? row : null
        }, { what: 'PaymentIntent VOIDED depois do RemoteStart rejeitado' })
        expect(cancelado.status).toBe('VOIDED')

        const tokenAfter = await prisma.authToken.findUniqueOrThrow({ where: { id: authToken.id } })
        expect(tokenAfter.status).toBe('EXPIRED')
      })
    })
  })

  // ---------------------------------------------------------------------------
  describe('guarda do MeterValues — limite é o valor AUTORIZADO no cartão, não o saldo da carteira', () => {
    it('custo parcial atingindo o authorizedCents dispara o dedupe de auto-stop', async () => {
      const driver = await newDriverWithCard('guarda')
      const { connectorId } = await newConnector()

      const { authToken, intent } = await startCardSession(driver, connectorId, 'Accepted')

      // Reduz o autorizado para um valor pequeno e determinístico — simula
      // uma pré-autorização baixa sem depender do piso/teto default de
      // `calcularTetoReserva` (R$50,00), que tornaria o teste lento/gigante.
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { amountAuthorizedCents: 500 } })

      const meterStart = 1_000
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(5).toISOString() })

      const dedupeKey = `ocpp:autostop:${(await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: start.transactionId } })).id}`
      expect(await redis.get(dedupeKey)).toBeNull()

      // 6 kWh a R$1,00/kWh = 600 centavos >= 500 autorizados -> guarda dispara.
      await callHandler(handleMeterValues, ctx, {
        connectorId,
        transactionId: start.transactionId,
        meterValue: [{ timestamp: minutesAgo(1).toISOString(), sampledValue: [{ value: String(meterStart + 6_000), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
      })

      await waitFor(() => redis.get(dedupeKey), { what: 'guarda de CARD disparou o RemoteStopTransaction' })
      await redis.del(dedupeKey)
    })
  })

  // ---------------------------------------------------------------------------
  describe('varredor: pré-autorização AUTHORIZED abandonada (sem StartTransaction) é cancelada', () => {
    it('intent AUTHORIZED sem chargingSessionId, autorizado há muito tempo, é VOIDED pelo varredor', async () => {
      const driver = await newDriverWithCard('abandonada')
      const token = await prisma.authToken.create({ data: { idTag: `V${randomUUID().replace(/-/g, '')}`.slice(0, 20), type: 'VIRTUAL', userId: driver.user.id, status: 'ACCEPTED' } })

      const autorizacao = await pagamentoPort.autorizar({
        merchantOrderId: `abandoned-${suffix}`,
        amountRequestedCents: 3000,
        cartao: { cardToken: 'test-card-token-abandonada' },
        cliente: { name: driver.user.name },
      })
      expect(autorizacao.status).toBe('AUTHORIZED')

      const intent = await prisma.paymentIntent.create({
        data: {
          purpose: 'SESSION_CARD_CAPTURE',
          provider: 'CIELO_CARD',
          userId: driver.user.id,
          paymentMethodId: driver.paymentMethod.id,
          authTokenId: token.id,
          status: 'AUTHORIZED',
          cieloPaymentId: autorizacao.providerPaymentId,
          // CHECK payment_intent_return_code_required (migration 20260917130000) exige
          // returnCode para SESSION_CARD_CAPTURE em AUTHORIZED/CAPTURED — faltava aqui,
          // a fixture nunca tinha rodado contra Postgres real (achado da Íris, 30/09/2026).
          returnCode: autorizacao.returnCode,
          amountRequestedCents: 3000,
          amountAuthorizedCents: autorizacao.amountAuthorizedCents,
          // "timeout"/abandono: autorizado há muito mais que CARD_PREAUTH_ABANDON_MINUTES (default 5min).
          authorizedAt: minutesAgo(30),
        },
      })

      await varrerPreAutorizacoesCartao(pagamentoPort)

      const intentAfter = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(intentAfter.status).toBe('VOIDED')
      const tokenAfter = await prisma.authToken.findUniqueOrThrow({ where: { id: token.id } })
      expect(tokenAfter.status).toBe('EXPIRED')
    })
  })
})
