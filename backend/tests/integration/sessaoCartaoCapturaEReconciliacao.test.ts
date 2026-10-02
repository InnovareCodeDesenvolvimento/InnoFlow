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
import { creditarTopupPix } from '../../src/services/pagamentos/creditarTopupPix'
import { liquidarSessao } from '../../src/services/carteira/liquidarSessao'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import type { OcppHandlerCtx } from '../../src/ocpp/context'
import { handleStartTransaction } from '../../src/ocpp/handlers/startTransaction'
import { handleMeterValues } from '../../src/ocpp/handlers/meterValues'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { createTenant, waitFor, uniqueSuffix, type TestTenant } from './helpers/fixtures'

/**
 * F5.4 (Íris, 2026-09-30) — provas que `sessaoCartao.test.ts` (Vega) NÃO
 * cobria, pedidas no handoff da missão de QA contra Postgres + Redis reais:
 *
 *   1. Captura PARCIAL DE VERDADE (autorizado < consumo real) com Debt de
 *      diferença exata — o describe "captura parcial" do Vega, na prática,
 *      sempre captura o valor CHEIO (autorizado >> consumo), nunca exercita
 *      `shortfallCents > 0`.
 *   2. A MESMA dívida sendo quitada por crédito Pix (`debtSettledCents`) —
 *      fecha o ciclo completo da identidade de conciliação estendida (§4 da
 *      Nova), inclusive o termo que a F5.2 deixou pendente.
 *   3. Guarda do MeterValues no limiar EXATO (não "parece que para") —
 *      1 centavo abaixo não dispara, o centavo exato dispara.
 *   4. `StartTransaction` chegando DEPOIS do varredor já ter expirado a
 *      pré-autorização abandonada — o teste do Vega só prova que o varredor
 *      cancela, nunca que uma tentativa de uso tardio é rejeitada sem cobrar
 *      nada.
 *   5. Concorrência real (`Promise.all`) em `capturarSessaoCartao` para o
 *      MESMO intent — nunca captura 2x (mesmo padrão de
 *      `topupPixConcorrenciaEReconsulta.test.ts`, F5.2).
 *
 * Mais dois gaps REAIS encontrados nesta rodada (`it.fails` originais,
 * corrigidos por Vega em 2026-09-30 — trocados por `it`, asserção
 * inalterada):
 *   A. `liquidarSessao`/`debitarSessao` (caminho do job de retry, SEM `tx`)
 *      não olhava `ChargingSession.paymentMode` — uma sessão CARD já
 *      STOPPED que passasse por ali (cenário de corrida documentado no
 *      handoff) seria debitada da CARTEIRA por cima da captura do cartão.
 *      CORRIGIDO: `liquidarSessaoComTx` agora não-opera (com log de alerta)
 *      quando `paymentMode !== 'WALLET'`.
 *   B. `prepararFechamentoCartao` (ação VOID) não mudava o `status` do
 *      intent dentro da transação — se a chamada de rede pós-commit
 *      (`cancelarPreAutorizacaoCartao`) falhasse, o intent ficava preso
 *      `AUTHORIZED` com `chargingSessionId` já preenchido, e
 *      `varrerPreAutorizacoesCartao` (caso A) só pegava `chargingSessionId
 *      IS NULL` — nunca resolvia esse caso. CORRIGIDO sem mexer no schema:
 *      o caso A do varredor agora também cobre AUTHORIZED com sessão
 *      vinculada já `STOPPED` (ver comentário em
 *      `varrerPreAutorizacoesCartao.ts`) — mais simples que introduzir um
 *      estado `VOID_PENDING` novo no enum, e resolve o mesmo gap.
 */

function callHandler<T>(handler: (args: IHandlersOption, ctx: OcppHandlerCtx) => Promise<T>, ctx: OcppHandlerCtx, params: unknown, messageId: string = randomUUID()): Promise<T> {
  return handler({ messageId, params, method: 'X', signal: new AbortController().signal } as unknown as IHandlersOption, ctx)
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

/** Mesmo fake gateway OCPP de `sessaoCartao.test.ts` — responde ao RemoteStartTransaction publicado sem WebSocket de verdade. */
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
      // mensagem malformada — ignora
    }
  })
  try {
    return await fn()
  } finally {
    subscriber.disconnect()
    publisher.disconnect()
  }
}

describe('Sessão de recarga com cartão — captura parcial real, conciliação e concorrência (F5.4, Íris, Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let pagamentoPort: Awaited<ReturnType<typeof getPagamentoPort>> // resolvido no beforeAll (getPagamentoPort é assíncrono desde a F5.5) // FakeAdapter singleton — gerarId default já é randomUUID() (fix ab887fc), seguro entre arquivos.

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

  const reportFor = async () => {
    const from = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)
    const to = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10)
    const res = await request(app).get('/api/admin/reports/payments').query({ from, to, operatorId: tenant.operatorId, pageSize: 100 }).set('Authorization', `Bearer ${adminToken}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.reconciliation as Record<string, number>
  }

  async function startCardSession(driver: Awaited<ReturnType<typeof newDriverWithCard>>, connectorId: number, remoteStartStatus: 'Accepted' | 'Rejected' = 'Accepted') {
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
    pagamentoPort = await getPagamentoPort()
    tenant = await createTenant({ suffix, label: 'card-iris' })
    await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { active: true, lastSeenAt: new Date() } })
    await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
    ctx = { chargePointId: tenant.chargePointId, operatorId: tenant.operatorId, ocppIdentity: tenant.ocppIdentity }

    const admin = await prisma.user.create({ data: { role: 'ADMIN', name: `Admin Card Iris ${suffix}`, email: `admin-card-iris-${suffix}@example.com` } })
    adminToken = issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  // ---------------------------------------------------------------------------
  describe('captura PARCIAL de verdade (autorizado < consumo real) gera Debt com a diferença exata, e a quitação via Pix fecha a identidade', () => {
    it('shortfall vira Debt OPEN; crédito Pix quita a dívida e a conciliação fecha em 0 em CADA etapa', async () => {
      const driver = await newDriverWithCard('parcial')
      const { connectorId } = await newConnector()

      const { authToken, intent } = await startCardSession(driver, connectorId)

      // Reduz o autorizado para BEM menos do que vamos consumir — diferente
      // do describe "ciclo feliz" do Vega (que nunca ultrapassa o teto
      // default de R$50), aqui o consumo real FICA MAIOR que o autorizado,
      // simulando a janela entre a guarda disparar o RemoteStopTransaction e
      // o carregador de fato obedecer (fire-and-forget, sem carregador real
      // neste teste) — StopTransaction chega com mais energia do que a
      // pré-autorização cobria.
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { amountAuthorizedCents: 500 } })

      const meterStart = 2_000
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(20).toISOString() })
      expect(start.idTagInfo.status).toBe('Accepted')
      const session = await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: start.transactionId } })

      // 8 kWh a R$1,00/kWh = 800 centavos — 300 centavos ACIMA do autorizado (500).
      const stop = await callHandler(handleStopTransaction, ctx, { transactionId: start.transactionId, meterStop: meterStart + 8_000, timestamp: minutesAgo(5).toISOString(), reason: 'Local' })
      expect(stop.idTagInfo.status).toBe('Accepted')

      const stoppedSession = await prisma.chargingSession.findUniqueOrThrow({ where: { id: session.id } })
      expect(stoppedSession.totalCostCents).toBe(800)

      const intentAfterStop = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      // captureAmountCents = min(total, autorizado) = min(800, 500) = 500 — NUNCA o total.
      expect(intentAfterStop).toMatchObject({ status: 'CAPTURE_PENDING', captureAmountCents: 500 })

      const capturado = await capturarSessaoCartao(intent.id, pagamentoPort)
      expect(capturado).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 500, shortfallCents: 300 })
      expect(capturado?.debtId).not.toBeNull()

      const debt = await prisma.debt.findUniqueOrThrow({ where: { id: capturado!.debtId! } })
      expect(debt).toMatchObject({ amountCents: 300, status: 'OPEN', reason: 'CARD_CAPTURE_SHORTFALL', userId: driver.user.id, chargingSessionId: session.id })

      // Etapa 1: capturado parcialmente + dívida aberta — identidade fecha em 0.
      const r1 = await reportFor()
      expect(r1).toMatchObject({ revenueCents: 800, cardCapturedCents: 500, cardCapturePendingCents: 0, openDebtCents: 300, debtSettledCents: 0, expectedCents: 800, accountedCents: 800, differenceCents: 0 })

      // Quita a dívida via crédito Pix (F5.2) — usa um FakeAdapter PRÓPRIO
      // com gerarId sufixado (nunca o singleton para criar dinheiro novo,
      // achado da Íris em 30/09 na F5.2: singleton sem gerarId colide entre
      // arquivos/execuções).
      const adapterPix = new FakeAdapter({ gerarId: () => `fake-iris-card-${suffix}-pix` })
      const pix = await adapterPix.criarPix({ merchantOrderId: 'placeholder', amountRequestedCents: 300, cliente: { name: driver.user.name } })
      adapterPix.marcarPixComoPago(pix.providerPaymentId)
      const wallet = await prisma.wallet.create({ data: { userId: driver.user.id } })
      const topupIntent = await prisma.paymentIntent.create({
        data: {
          purpose: 'WALLET_TOPUP_PIX',
          provider: 'CIELO_PIX',
          userId: driver.user.id,
          walletId: wallet.id,
          amountRequestedCents: 300,
          status: 'PENDING',
          cieloPaymentId: pix.providerPaymentId,
          pixQrCode: pix.qrCodeString,
          pixExpiresAt: pix.expiresAt,
        },
      })
      const credito = await creditarTopupPix(topupIntent.id, adapterPix)
      expect(credito).toMatchObject({ debtSettledCents: 300, totalCreditedCents: 300 })

      const debtAfter = await prisma.debt.findUniqueOrThrow({ where: { id: debt.id } })
      expect(debtAfter.status).toBe('SETTLED')

      // Etapa 2: dívida quitada — openDebtCents zera, debtSettledCents assume o valor. Identidade CONTINUA em 0.
      const r2 = await reportFor()
      expect(r2).toMatchObject({ revenueCents: 800, cardCapturedCents: 500, openDebtCents: 0, debtSettledCents: 300, expectedCents: 800, accountedCents: 800, differenceCents: 0 })
    })
  })

  // ---------------------------------------------------------------------------
  describe('guarda do MeterValues — limiar EXATO, não "parece que para"', () => {
    it('1 centavo abaixo do autorizado NÃO dispara; o centavo exato dispara', async () => {
      const driver = await newDriverWithCard('limiar')
      const { connectorId } = await newConnector()
      const { authToken, intent } = await startCardSession(driver, connectorId)

      // R$1,00/kWh -> 10 Wh = 1 centavo exato. Autoriza 500 centavos (5000 Wh).
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { amountAuthorizedCents: 500 } })

      const meterStart = 1_000
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(5).toISOString() })
      const sessionId = (await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: start.transactionId } })).id
      const dedupeKey = `ocpp:autostop:${sessionId}`

      // 4990 Wh -> 499 centavos, 1 ABAIXO do limite — não deve disparar.
      await callHandler(handleMeterValues, ctx, {
        connectorId,
        transactionId: start.transactionId,
        meterValue: [{ timestamp: minutesAgo(3).toISOString(), sampledValue: [{ value: String(meterStart + 4_990), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
      })
      // Sentinela: dá tempo do guard (fire-and-forget) rodar e NÃO setar a chave.
      await waitFor(async () => (await prisma.chargingSession.findUniqueOrThrow({ where: { id: sessionId } })).lastSampleAt !== null, { what: 'primeira amostra processada (sentinela)' })
      expect(await redis.get(dedupeKey)).toBeNull()

      // +10 Wh (total 5000 Wh = 500 centavos) -> EXATAMENTE o limite — dispara.
      await callHandler(handleMeterValues, ctx, {
        connectorId,
        transactionId: start.transactionId,
        meterValue: [{ timestamp: minutesAgo(1).toISOString(), sampledValue: [{ value: String(meterStart + 5_000), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
      })
      await waitFor(() => redis.get(dedupeKey), { what: 'guarda dispara exatamente no limite autorizado' })
      await redis.del(dedupeKey)
    })
  })

  // ---------------------------------------------------------------------------
  describe('StartTransaction chegando DEPOIS do varredor expirar a pré-autorização abandonada', () => {
    it('é rejeitado (Expired), nenhuma sessão é criada, nada é cobrado', async () => {
      const driver = await newDriverWithCard('tardio')
      const token = await prisma.authToken.create({ data: { idTag: `V${randomUUID().replace(/-/g, '')}`.slice(0, 20), type: 'VIRTUAL', userId: driver.user.id, status: 'ACCEPTED' } })

      const autorizacao = await pagamentoPort.autorizar({
        merchantOrderId: `tardio-${suffix}`,
        amountRequestedCents: 3000,
        cartao: { cardToken: 'test-card-token-tardio' },
        cliente: { name: driver.user.name },
      })

      const intent = await prisma.paymentIntent.create({
        data: {
          purpose: 'SESSION_CARD_CAPTURE',
          provider: 'CIELO_CARD',
          userId: driver.user.id,
          paymentMethodId: driver.paymentMethod.id,
          authTokenId: token.id,
          status: 'AUTHORIZED',
          cieloPaymentId: autorizacao.providerPaymentId,
          returnCode: autorizacao.returnCode,
          amountRequestedCents: 3000,
          amountAuthorizedCents: autorizacao.amountAuthorizedCents,
          authorizedAt: minutesAgo(30), // muito mais que CARD_PREAUTH_ABANDON_MINUTES (default 5)
        },
      })

      const varredura = await varrerPreAutorizacoesCartao(pagamentoPort)
      expect(varredura.canceladasAbandonadas).toBeGreaterThanOrEqual(1)

      const intentAfter = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(intentAfter.status).toBe('VOIDED')
      const tokenAfter = await prisma.authToken.findUniqueOrThrow({ where: { id: token.id } })
      expect(tokenAfter.status).toBe('EXPIRED')

      // O carregador finalmente manda o StartTransaction — TARDE DEMAIS: o
      // idTag virtual já foi expirado pelo varredor. `sessaoCartao.test.ts`
      // (Vega) nunca chega até aqui — prova só que o varredor cancela, não
      // que uma tentativa de uso tardio é barrada sem cobrar nada.
      const connector = await newConnector()
      const start = await callHandler(handleStartTransaction, ctx, { connectorId: connector.connectorId, idTag: token.idTag, meterStart: 0, timestamp: new Date().toISOString() })
      expect(start).toMatchObject({ transactionId: 0, idTagInfo: { status: 'Expired' } })

      expect(await prisma.chargingSession.count({ where: { authTokenId: token.id } })).toBe(0)
      // O intent continua exatamente como o varredor deixou — StartTransaction rejeitado não mexe em nada.
      const intentFinal = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(intentFinal).toMatchObject({ status: 'VOIDED', chargingSessionId: null })
    })
  })

  // ---------------------------------------------------------------------------
  describe('concorrência real em capturarSessaoCartao — Promise.all para o MESMO intent', () => {
    it('N chamadas concorrentes nunca capturam 2x nem duplicam a Debt/relatório', async () => {
      const driver = await newDriverWithCard('concorrencia')
      const { connectorId } = await newConnector()
      const { authToken, intent } = await startCardSession(driver, connectorId)

      const meterStart = 500
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(10).toISOString() })
      // 3 kWh -> 300 centavos, bem dentro do teto default — capture integral, sem dívida (o foco aqui é a CORRIDA, não o shortfall).
      const stop = await callHandler(handleStopTransaction, ctx, { transactionId: start.transactionId, meterStop: meterStart + 3_000, timestamp: minutesAgo(1).toISOString(), reason: 'Local' })
      expect(stop.idTagInfo.status).toBe('Accepted')

      const intentPending = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(intentPending.status).toBe('CAPTURE_PENDING')

      // 8 disparos concorrentes de VERDADE (Promise.all, não sequencial) —
      // mesmo padrão de `topupPixConcorrenciaEReconsulta.test.ts` (F5.2).
      // `allSettled` porque uma implementação insegura pode LANÇAR (o
      // `FakeAdapter.capturar` lança se o intent já não estiver mais
      // AUTHORIZED do lado dele) em vez de devolver null — queremos ver os
      // dois formatos de falha, não deixar o teste abortar no primeiro reject.
      const resultados = await Promise.allSettled(Array.from({ length: 8 }, () => capturarSessaoCartao(intent.id, pagamentoPort)))

      const rejeitadas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      const capturasConfirmadas = resultados.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof capturarSessaoCartao>>> => r.status === 'fulfilled' && r.value?.status === 'CAPTURED')

      // A garantia que REALMENTE importa (dinheiro): nunca mais de 1 captura
      // efetivada e nunca mais de 1 Debt/WalletEntry por trás — verificado
      // direto no banco, não só no valor de retorno da função.
      expect(capturasConfirmadas.length, JSON.stringify(resultados)).toBeLessThanOrEqual(1)

      const intentFinal = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(intentFinal.status).toBe('CAPTURED')
      expect(intentFinal.amountCapturedCents).toBe(300)
      expect(await prisma.debt.count({ where: { paymentIntentId: intent.id } })).toBe(0)

      // Documenta o formato real observado (informativo — não trava o teste
      // em um formato específico, só prova que NENHUMA chamada concorrente
      // conseguiu recapturar/duplicar o efeito financeiro).
      if (rejeitadas.length > 0) {
        console.info(`[concorrência capturarSessaoCartao] ${rejeitadas.length}/8 chamadas concorrentes rejeitaram (ver handoff) — nenhuma duplicou o efeito financeiro.`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  describe('reconsulta ANTES de recapturar — job reentregue depois que a Cielo já confirmou, mas antes de gravarmos local', () => {
    it('nosso processo "morreu" entre capturar() ter sucesso e o commit local — o retry reconsulta e NUNCA chama capturar() de novo', async () => {
      const driver = await newDriverWithCard('reconsulta-antes-retry')
      const { connectorId } = await newConnector()
      const { authToken, intent } = await startCardSession(driver, connectorId)

      const meterStart = 700
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(8).toISOString() })
      const stop = await callHandler(handleStopTransaction, ctx, { transactionId: start.transactionId, meterStop: meterStart + 4_000, timestamp: minutesAgo(1).toISOString(), reason: 'Local' })
      expect(stop.idTagInfo.status).toBe('Accepted')

      const intentPending = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(intentPending).toMatchObject({ status: 'CAPTURE_PENDING', captureAmountCents: 400 })

      // Simula a Cielo já ter confirmado a captura (chamando o adapter
      // DIRETO, por fora de `capturarSessaoCartao` — representa a primeira
      // tentativa, cujo processo caiu ANTES de gravar `status='CAPTURED'`
      // localmente) — o banco continua dizendo CAPTURE_PENDING.
      const capturaNaCielo = await pagamentoPort.capturar(intentPending.cieloPaymentId!, intentPending.captureAmountCents!)
      expect(capturaNaCielo.status).toBe('CAPTURED')

      // O job é reentregue (retry do BullMQ) — se `capturarSessaoCartao`
      // chamasse `capturar()` de novo às cegas, o `FakeAdapter` lançaria
      // ("esperado AUTHORIZED, está CAPTURED") — a chamada REAL à Cielo
      // teria um destino incerto (ver "A CONFIRMAR" no cabeçalho do
      // arquivo). A reconsulta ANTES de capturar é o que evita isso.
      const resultado = await capturarSessaoCartao(intent.id, pagamentoPort)
      expect(resultado).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 400, shortfallCents: 0, debtId: null })

      const intentFinal = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(intentFinal.status).toBe('CAPTURED')
    })
  })

  // ---------------------------------------------------------------------------
  describe('GAP A (corrigido, Vega 2026-09-30): job de retry de liquidação agora olha paymentMode', () => {
    it('sessão CARD já STOPPED não deveria ser debitada da CARTEIRA pelo caminho de retry (sem tx) de liquidarSessao', async () => {
      const driver = await newDriverWithCard('gap-liquidar')
      // Pré-condição real: motorista TEM carteira com saldo (senão
      // `debitarSessao` nem chegaria a criar o `WalletEntry` — com saldo 0
      // o "débito" vira só uma `Debt` extra, prova igualmente real do gap
      // mas menos direta de afirmar; com saldo dá pra afirmar o
      // `CHARGE_DEBIT` em si, que é o efeito mais grave: cartão E carteira
      // cobrando a MESMA sessão).
      const wallet = await prisma.wallet.create({ data: { userId: driver.user.id } })
      await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: 5_000, balanceAfterCents: 5_000, description: 'Saldo de teste (Íris, GAP A)' } })
      const { connectorId } = await newConnector()
      const { authToken } = await startCardSession(driver, connectorId)

      const meterStart = 100
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(5).toISOString() })
      const stop = await callHandler(handleStopTransaction, ctx, { transactionId: start.transactionId, meterStop: meterStart + 1_000, timestamp: minutesAgo(1).toISOString(), reason: 'Local' })
      expect(stop.idTagInfo.status).toBe('Accepted')

      const session = await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: start.transactionId } })
      expect(session).toMatchObject({ status: 'STOPPED', paymentMode: 'CARD', totalCostCents: 100 })

      // Cenário de corrida documentado no handoff: o job de retry de
      // liquidação (`enqueueLiquidarSessaoRetry`, chamado por
      // `stopTransaction.ts` quando `finalizarSessao` LANÇA) roda depois,
      // já com a sessão STOPPED por outro caminho (ex.: reconciliação de
      // boot bem-sucedida entre a falha transitória e o retry). Simulado
      // aqui chamando `liquidarSessao` diretamente (sem `tx` — é exatamente
      // o que o worker `liquidarSessaoJob.ts` faz).
      await liquidarSessao(session.id)

      // Comportamento DESEJADO: uma sessão CARD nunca deveria gerar
      // CHARGE_DEBIT — quem cobra é a captura do cartão. CORRIGIDO:
      // `liquidarSessaoComTx` agora olha `paymentMode` e não-opera (com log
      // de alerta) para sessões CARD — sem a correção, a corrida acima
      // duplicaria a cobrança (cartão capturado + carteira debitada pela
      // mesma sessão).
      expect(await prisma.walletEntry.count({ where: { type: 'CHARGE_DEBIT', referenceType: 'CHARGING_SESSION', referenceId: session.id } })).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  describe('GAP B (corrigido, Vega 2026-09-30): varredor agora cobre AUTHORIZED com chargingSessionId já preenchido', () => {
    it('pré-autorização "presa" AUTHORIZED com sessão STOPPED vinculada (cancelamento pós-commit falhou) deveria ser resolvida pelo varredor', async () => {
      const driver = await newDriverWithCard('gap-void-preso')
      const { connectorId } = await newConnector()
      const { authToken, intent } = await startCardSession(driver, connectorId)

      const meterStart = 900
      const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: authToken.idTag, meterStart, timestamp: minutesAgo(20).toISOString() })
      const session = await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: start.transactionId } })

      // Simula o StopTransaction de uma sessão SEM consumo (totalCostCents=0
      // -> ação VOID) cuja chamada de rede pós-commit
      // (`cancelarPreAutorizacaoCartao`) falhou (ex.: Cielo fora do ar
      // naquele instante) — SEM chamar o handler real (que chamaria a rede
      // de verdade e teria sucesso com o FakeAdapter); em vez disso replica
      // só o efeito que `prepararFechamentoCartao` grava (NADA — a ação VOID
      // não muda o status do intent dentro da transação, ver
      // `fecharSessaoCartao.ts`) e o `ChargingSession.status='STOPPED'` que
      // `finalizarSessao` já teria persistido ANTES de tentar a chamada de
      // rede.
      await prisma.chargingSession.update({ where: { id: session.id }, data: { status: 'STOPPED', stoppedAt: new Date(), totalCostCents: 0, energyDeliveredWh: 0 } })
      // `intent` continua AUTHORIZED com chargingSessionId preenchido (igual
      // ficaria na vida real se `cancelarPreAutorizacaoCartao` pós-commit
      // falhasse) — nada a fazer aqui, é o estado que `StartTransaction` já
      // deixou.
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('AUTHORIZED')

      // Autorizado há muito mais que CARD_PREAUTH_ABANDON_MINUTES — se o
      // varredor cobrisse este caso, cairia no mesmo caminho do "abandonada".
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { authorizedAt: minutesAgo(30) } })

      await varrerPreAutorizacoesCartao(pagamentoPort)

      // Comportamento DESEJADO: o varredor deveria cancelar esta
      // pré-autorização "presa" (sessão já STOPPED, ninguém nunca vai mais
      // capturar nem cancelar). CORRIGIDO: o caso A do varredor agora
      // também cobre AUTHORIZED com sessão vinculada já STOPPED (antes o
      // filtro exigia `chargingSessionId: null`, e o intent ficava
      // AUTHORIZED para sempre, sem rede de segurança nenhuma).
      const intentAfter = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(intentAfter.status).toBe('VOIDED')
    })
  })
})
