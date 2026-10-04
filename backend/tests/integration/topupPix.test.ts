import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Worker } from 'bullmq'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'
import { getPagamentoPort, isUsandoFakeAdapter, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import type { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { getCieloWebhookHeaderSecret, getCieloWebhookPathToken } from '../../src/services/pagamentos/webhookCieloSecrets'
import { startCreditarTopupPixWorker } from '../../src/worker/jobs/creditarTopupPixJob'
import { varrerTopupsPixExpirados } from '../../src/services/pagamentos/varrerTopupsPixExpirados'
import { subscribeChannels, userChannel } from '../../src/realtime/bus'
import type { RealtimeEvent } from '../../src/realtime/events'
import { settle, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * F5.2 (Vega, 2026-09-30) — fluxo Pix real contra Postgres + Redis REAIS
 * (as mesmas instâncias que o resto da suíte de integração usa). A Cielo em
 * si NUNCA é chamada — não temos credencial de sandbox ainda (ver handoff) —
 * então quem faz o papel dela é o `FakeAdapter` (F5.1), escolhido
 * automaticamente por `getPagamentoPort()` porque `CIELO_MERCHANT_ID` não
 * está setado no ambiente de teste. `marcarPixComoPago`/`marcarPixComoExpirado`
 * (helpers só de teste do `FakeAdapter`) simulam "o motorista pagou o QR no
 * banco dele" — o mesmo evento que dispararia o webhook de verdade.
 *
 * O worker roda DE VERDADE aqui (`startCreditarTopupPixWorker`, BullMQ
 * contra o Redis real) — não é uma chamada direta da função de serviço; é
 * prova de ponta a ponta: webhook grava `WebhookEvent` -> enfileira -> o
 * worker processa -> credita -> publica no Redis pub/sub (conferido via
 * `subscribeChannels`, a mesma infraestrutura que o SSE usa).
 */
describe('Recarga de carteira via Pix (F5.2) — Postgres + Redis reais, FakeAdapter no lugar da Cielo', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let worker: Worker

  beforeAll(async () => {
    resetPagamentoPortCacheParaTeste()
    fakePort = (await getPagamentoPort()) as FakeAdapter // força a resolução preguiçosa agora (decide Cielo real x FakeAdapter), ainda em beforeAll
    expect(isUsandoFakeAdapter(), 'este teste exige FakeAdapter — CIELO_MERCHANT_ID não pode estar setado no ambiente de teste').toBe(true)
    worker = startCreditarTopupPixWorker()
    await settle(300) // dá tempo do Worker terminar de conectar ao Redis antes do 1º job
  })

  afterAll(async () => {
    await worker.close()
    await prisma.$disconnect()
    redis.disconnect()
  })

  let fakePort: FakeAdapter
  function port(): FakeAdapter {
    return fakePort // singleton do processo — resolvido no beforeAll (getPagamentoPort é assíncrono desde a F5.5)
  }

  async function newDriver(label: string) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver ${label} ${suffix}`, email: `driver-${label}-${suffix}@example.com` } })
    return { id: user.id, token: issueToken({ id: user.id, role: 'DRIVER', operatorId: null }) }
  }

  async function saldo(userId: string): Promise<number> {
    const wallet = await prisma.wallet.findUnique({ where: { userId } })
    if (!wallet) return 0
    const last = await prisma.walletEntry.findFirst({ where: { walletId: wallet.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
    return last?.balanceAfterCents ?? 0
  }

  async function postWebhook(paymentId: string, changeType = 1) {
    return request(app).post(`/api/webhooks/cielo/${getCieloWebhookPathToken()}`).set('InnoFlowWebhookSecret', await getCieloWebhookHeaderSecret()).send({ PaymentId: paymentId, ChangeType: changeType })
  }

  async function createTopup(token: string, amountCents: number) {
    const res = await request(app).post('/api/me/wallet/topups').set('Authorization', `Bearer ${token}`).send({ amountCents })
    return res
  }

  // ---------------------------------------------------------------------------
  describe('fluxo feliz completo', () => {
    it('cria o Pix, webhook confirma pago, credita a carteira e publica wallet.updated + topup.updated em tempo real', async () => {
      const driver = await newDriver('feliz')

      const received: RealtimeEvent[] = []
      const unsubscribe = subscribeChannels([userChannel(driver.id)], (event) => received.push(event))

      const createRes = await createTopup(driver.token, 5_000)
      expect(createRes.status, JSON.stringify(createRes.body)).toBe(201)
      expect(createRes.body).toMatchObject({ status: 'PENDING', amountCents: 5_000, debtSettledCents: 0, paidAt: null })
      expect(createRes.body.qrCodeString).toBeTruthy()
      expect(createRes.body.qrCodeImageBase64).toBeTruthy() // FakeAdapter sempre devolve uma imagem — prova que o cache Redis não é a única fonte na resposta de criação
      expect(createRes.body.expiresAt).toBeTruthy()
      const topupId = createRes.body.id as string

      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: topupId } })
      expect(intent.status).toBe('PENDING')
      expect(intent.cieloPaymentId).toBeTruthy()
      expect(intent.provider).toBe('CIELO_PIX')
      expect(intent.purpose).toBe('WALLET_TOPUP_PIX')

      port().marcarPixComoPago(intent.cieloPaymentId!)

      const webhookRes = await postWebhook(intent.cieloPaymentId!)
      expect(webhookRes.status, JSON.stringify(webhookRes.body)).toBe(200)

      await waitFor(async () => (await saldo(driver.id)) === 5_000, { what: 'carteira creditada após webhook' })

      const getRes = await request(app).get(`/api/me/wallet/topups/${topupId}`).set('Authorization', `Bearer ${driver.token}`)
      expect(getRes.status).toBe(200)
      expect(getRes.body).toMatchObject({ status: 'PAID', debtSettledCents: 0 })
      expect(getRes.body.paidAt).toBeTruthy()
      expect(getRes.body.qrCodeImageBase64).toBeTruthy() // ainda vem do cache Redis na 2ª leitura

      const walletEntry = await prisma.walletEntry.findFirstOrThrow({ where: { type: 'TOPUP_PIX', referenceType: 'PAYMENT_INTENT', referenceId: topupId } })
      expect(walletEntry.amountCents).toBe(5_000)

      const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: 'PAYMENT_CREDIT', entityId: topupId } })
      expect(auditRow.actorRole).toBe('SYSTEM')
      expect(auditRow.outcome).toBe('SUCCESS')
      expect(auditRow.httpStatus).toBeNull() // SYSTEM não tem requisição HTTP por trás
      expect(auditRow.method).toBeNull()
      expect(auditRow.path).toBeNull()

      const webhookEvent = await prisma.webhookEvent.findFirstOrThrow({ where: { externalId: intent.cieloPaymentId! } })
      expect(webhookEvent.processedAt).not.toBeNull()

      await waitFor(() => received.some((e) => e.type === 'wallet.updated'), { what: 'wallet.updated publicado' })
      await waitFor(() => received.some((e) => e.type === 'topup.updated'), { what: 'topup.updated publicado' })
      const walletEvent = received.find((e): e is Extract<RealtimeEvent, { type: 'wallet.updated' }> => e.type === 'wallet.updated')
      expect(walletEvent).toMatchObject({ userId: driver.id, balanceCents: 5_000 })
      const topupEvent = received.find((e): e is Extract<RealtimeEvent, { type: 'topup.updated' }> => e.type === 'topup.updated')
      expect(topupEvent).toMatchObject({ topupId, status: 'PAID' })

      unsubscribe()
    })
  })

  // ---------------------------------------------------------------------------
  describe('idempotência do webhook', () => {
    it('o MESMO PaymentId reprocessado (webhook duplicado da própria Cielo) credita só UMA vez', async () => {
      const driver = await newDriver('idempotente')
      const createRes = await createTopup(driver.token, 2_000)
      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: createRes.body.id } })
      port().marcarPixComoPago(intent.cieloPaymentId!)

      await postWebhook(intent.cieloPaymentId!)
      await waitFor(async () => (await saldo(driver.id)) === 2_000, { what: '1º crédito' })

      // A Cielo reenvia a MESMA notificação (rede instável do lado dela) — 2x mais.
      await postWebhook(intent.cieloPaymentId!)
      await postWebhook(intent.cieloPaymentId!)
      await settle(500)

      expect(await saldo(driver.id)).toBe(2_000)
      expect(await prisma.walletEntry.count({ where: { type: 'TOPUP_PIX', referenceType: 'PAYMENT_INTENT', referenceId: intent.id } })).toBe(1)
      expect(await prisma.webhookEvent.count({ where: { externalId: intent.cieloPaymentId! } })).toBe(3) // 3 EVENTOS gravados (a caixa de entrada não deduplica a escrita)...
      const processed = await prisma.webhookEvent.findMany({ where: { externalId: intent.cieloPaymentId! } })
      expect(processed.every((w) => w.processedAt !== null)).toBe(true) // ...mas todos processados sem duplicar o EFEITO
    })
  })

  // ---------------------------------------------------------------------------
  describe('quitação automática de múltiplas dívidas', () => {
    it('quita as dívidas mais ANTIGAS primeiro, para quando o crédito não cobre a próxima inteira, e credita o restante como saldo livre', async () => {
      const driver = await newDriver('dividas')
      // 1000 (mais antiga) + 1500 (do meio) cabem nos 3000 de crédito (2500); 3000 (mais nova) NÃO cabe no restante (500) — fica OPEN.
      const d1 = await prisma.debt.create({ data: { userId: driver.id, amountCents: 1_000, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE', createdAt: new Date(Date.now() - 3 * 60_000) } })
      const d2 = await prisma.debt.create({ data: { userId: driver.id, amountCents: 1_500, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE', createdAt: new Date(Date.now() - 2 * 60_000) } })
      const d3 = await prisma.debt.create({ data: { userId: driver.id, amountCents: 3_000, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE', createdAt: new Date(Date.now() - 1 * 60_000) } })

      const createRes = await createTopup(driver.token, 3_000)
      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: createRes.body.id } })
      port().marcarPixComoPago(intent.cieloPaymentId!)
      await postWebhook(intent.cieloPaymentId!)

      await waitFor(async () => (await saldo(driver.id)) === 500, { what: 'saldo livre após quitar 2 dívidas' })

      expect((await prisma.debt.findUniqueOrThrow({ where: { id: d1.id } })).status).toBe('SETTLED')
      expect((await prisma.debt.findUniqueOrThrow({ where: { id: d2.id } })).status).toBe('SETTLED')
      expect((await prisma.debt.findUniqueOrThrow({ where: { id: d3.id } })).status).toBe('OPEN')

      const settledD1 = await prisma.debt.findUniqueOrThrow({ where: { id: d1.id } })
      expect(settledD1.settledAt).not.toBeNull()
      expect(settledD1.settledByWalletEntryId).toBeTruthy()

      const settlementEntries = await prisma.walletEntry.findMany({ where: { type: 'DEBT_SETTLEMENT', walletId: (await prisma.wallet.findUniqueOrThrow({ where: { userId: driver.id } })).id } })
      expect(settlementEntries).toHaveLength(2)
      expect(settlementEntries.map((e) => e.amountCents).sort((a, b) => a - b)).toEqual([-1_500, -1_000])

      const getRes = await request(app).get(`/api/me/wallet/topups/${intent.id}`).set('Authorization', `Bearer ${driver.token}`)
      expect(getRes.body.debtSettledCents).toBe(2_500)
    })
  })

  // ---------------------------------------------------------------------------
  describe('varredor de expiração — reconsulta antes de expirar', () => {
    it('pagamento confirmado pela Cielo DEPOIS do prazo do QR ainda credita (nunca expira sem reconsultar)', async () => {
      const driver = await newDriver('atrasado')
      const createRes = await createTopup(driver.token, 4_000)
      const intentId = createRes.body.id as string

      // Simula o relógio: o QR "já venceu" sem esperar os 30 minutos de verdade.
      await prisma.paymentIntent.update({ where: { id: intentId }, data: { pixExpiresAt: new Date(Date.now() - 1_000) } })
      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })

      // O motorista pagou DEPOIS do prazo do QR, mas a Cielo confirma quando reconsultada.
      port().marcarPixComoPago(intent.cieloPaymentId!)

      const resultado = await varrerTopupsPixExpirados(port())
      expect(resultado.creditados).toBeGreaterThanOrEqual(1)

      expect(await saldo(driver.id)).toBe(4_000)
      const final = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })
      expect(final.status).toBe('PAID')
    })

    it('expira de verdade quando a Cielo confirma que NÃO foi pago', async () => {
      const driver = await newDriver('expirado')
      const createRes = await createTopup(driver.token, 1_500)
      const intentId = createRes.body.id as string
      await prisma.paymentIntent.update({ where: { id: intentId }, data: { pixExpiresAt: new Date(Date.now() - 1_000) } })

      await varrerTopupsPixExpirados(port())

      const final = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })
      expect(final.status).toBe('EXPIRED')
      expect(await saldo(driver.id)).toBe(0)

      const getRes = await request(app).get(`/api/me/wallet/topups/${intentId}`).set('Authorization', `Bearer ${driver.token}`)
      expect(getRes.body.status).toBe('EXPIRED')
    })
  })

  // ---------------------------------------------------------------------------
  describe('validação de entrada', () => {
    it('rejeita valor abaixo do mínimo com TOPUP_AMOUNT_OUT_OF_RANGE', async () => {
      const driver = await newDriver('valor-baixo')
      const res = await createTopup(driver.token, 999)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('TOPUP_AMOUNT_OUT_OF_RANGE')
    })

    it('rejeita valor acima do máximo com TOPUP_AMOUNT_OUT_OF_RANGE', async () => {
      const driver = await newDriver('valor-alto')
      const res = await createTopup(driver.token, 50_001)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('TOPUP_AMOUNT_OUT_OF_RANGE')
    })

    it('rejeita CPF mal formado com INVALID_CPF (mas aceita sem CPF — é opcional)', async () => {
      const driver = await newDriver('cpf-invalido')
      const res = await request(app).post('/api/me/wallet/topups').set('Authorization', `Bearer ${driver.token}`).send({ amountCents: 2_000, cpf: '11111111111' })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('INVALID_CPF')
    })

    it('bloqueia uma 2ª recarga Pix enquanto a 1ª ainda está PENDING', async () => {
      const driver = await newDriver('duplo-pix')
      const first = await createTopup(driver.token, 2_000)
      expect(first.status).toBe(201)
      const second = await createTopup(driver.token, 2_000)
      expect(second.status).toBe(409)
      expect(second.body.code).toBe('TOO_MANY_PENDING_TOPUPS')
    })

    it('motorista não consegue ver o topup de outro motorista (404, nunca 403 — anti-enumeração)', async () => {
      const a = await newDriver('dono')
      const b = await newDriver('estranho')
      const created = await createTopup(a.token, 2_000)
      const res = await request(app).get(`/api/me/wallet/topups/${created.body.id}`).set('Authorization', `Bearer ${b.token}`)
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('TOPUP_NOT_FOUND')
    })

    it('topup inexistente -> 404 TOPUP_NOT_FOUND', async () => {
      const driver = await newDriver('inexistente')
      const res = await request(app).get(`/api/me/wallet/topups/${randomUUID()}`).set('Authorization', `Bearer ${driver.token}`)
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('TOPUP_NOT_FOUND')
    })

    it('sem token -> 401', async () => {
      const res = await request(app).post('/api/me/wallet/topups').send({ amountCents: 2_000 })
      expect(res.status).toBe(401)
    })
  })

  // ---------------------------------------------------------------------------
  describe('webhook — segurança', () => {
    it('pathToken errado devolve 404 (rota nem existe para quem não sabe o token)', async () => {
      const res = await request(app).post('/api/webhooks/cielo/token-completamente-errado').set('InnoFlowWebhookSecret', await getCieloWebhookHeaderSecret()).send({ PaymentId: 'x', ChangeType: 1 })
      expect(res.status).toBe(404)
    })

    it('header secreto errado (pathToken certo) devolve 401', async () => {
      const res = await request(app).post(`/api/webhooks/cielo/${getCieloWebhookPathToken()}`).set('InnoFlowWebhookSecret', 'segredo-forjado').send({ PaymentId: 'x', ChangeType: 1 })
      expect(res.status).toBe(401)
    })

    it('sem o header secreto -> 401 (não é opcional)', async () => {
      const res = await request(app).post(`/api/webhooks/cielo/${getCieloWebhookPathToken()}`).send({ PaymentId: 'x', ChangeType: 1 })
      expect(res.status).toBe(401)
    })

    it('PaymentId desconhecido AINDA recebe 200 (evita tempestade de retentativa da Cielo) — só grava e loga', async () => {
      const res = await postWebhook(`payment-desconhecido-${randomUUID()}`)
      expect(res.status).toBe(200)
    })

    it('PaymentId PRESENTE porém malformado -> 400 (não é ping: ping é só o corpo SEM PaymentId/ChangeType)', async () => {
      const res = await request(app).post(`/api/webhooks/cielo/${getCieloWebhookPathToken()}`).set('InnoFlowWebhookSecret', await getCieloWebhookHeaderSecret()).send({ PaymentId: { x: 1 }, ChangeType: 1 })
      expect(res.status).toBe(400)
    })

    // C1.4 (F26/F28): ao salvar a URL no Site Cielo ela faz um POST de teste SEM PaymentId/ChangeType e exige 200.
    describe('ping de validação da URL', () => {
      const urlComToken = () => `/api/webhooks/cielo/${getCieloWebhookPathToken()}`

      it('corpo vazio e corpo sem PaymentId respondem 200 (com o token do caminho certo), SEM gravar WebhookEvent', async () => {
        const antes = await prisma.webhookEvent.count()
        for (const corpo of [{}, { ChangeType: 1 }, { PaymentId: '', ChangeType: 1 }, { PaymentId: 'x' }]) {
          const res = await request(app).post(urlComToken()).send(corpo)
          expect(res.status, JSON.stringify(corpo)).toBe(200)
          expect(res.body).toEqual({ received: true })
        }
        const semCorpo = await request(app).post(urlComToken())
        expect(semCorpo.status).toBe(200)
        expect(await prisma.webhookEvent.count()).toBe(antes)
      })

      it('o ping NÃO afrouxa o portão: token do caminho errado segue 404 (com ou sem corpo) e notificação real sem o header segue 401', async () => {
        expect((await request(app).post('/api/webhooks/cielo/token-errado-do-ping').send({})).status).toBe(404)
        expect((await request(app).post('/api/webhooks/cielo/token-errado-do-ping').send({ PaymentId: 'x', ChangeType: 1 })).status).toBe(404)
        expect((await request(app).post(urlComToken()).send({ PaymentId: 'x', ChangeType: 1 })).status).toBe(401)
      })

      it('o header só com letras vale em qualquer caixa (HTTP é case-insensitive) — e o nome antigo com hífens NÃO é mais lido', async () => {
        const segredo = await getCieloWebhookHeaderSecret()
        const paymentId = `payment-desconhecido-${randomUUID()}`
        expect((await request(app).post(urlComToken()).set('innoflowwebhooksecret', segredo).send({ PaymentId: paymentId, ChangeType: 1 })).status).toBe(200)
        expect((await request(app).post(urlComToken()).set('INNOFLOWWEBHOOKSECRET', segredo).send({ PaymentId: paymentId, ChangeType: 1 })).status).toBe(200)
        expect((await request(app).post(urlComToken()).set('x-innoelektron-webhook-secret', segredo).send({ PaymentId: paymentId, ChangeType: 1 })).status).toBe(401)
      })
    })
  })
})
