import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis, createRedisConnection } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'
import { encryptPaymentSecret } from '../../src/lib/crypto/paymentSecrets'
import { logger } from '../../src/lib/logger'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { getPagamentoPort, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { limparControleCancelamento } from '../../src/services/pagamentos/controleCancelamentoPreAuth'
import { cancelarPreAutorizacaoCartao } from '../../src/services/pagamentos/cancelarPreAutorizacaoCartao'
import { capturarSessaoCartao } from '../../src/services/pagamentos/capturarSessaoCartao'
import { varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'
import { uniqueSuffix } from './helpers/fixtures'

// BANCO PRÓPRIO: o varredor olha TODOS os intents AUTHORIZED/CREATED do banco; no compartilhado ele varreria (e cancelaria) intents de outras suítes em paralelo. `vi.hoisted` assíncrono roda antes dos imports estáticos.
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_c2')
})

/**
 * C2 contra Postgres + Redis reais (a Cielo é o `FakeAdapter`; nenhuma chamada de rede):
 *  - C2.5: `cieloTid`/`cieloAuthorizationCode`/`cieloProofOfSale` gravados NA AUTORIZAÇÃO e de novo NA CAPTURA; vazio -> null; > 64 trunca sem derrubar o fluxo; Pix fica null;
 *  - F16: autorização sem resposta definitiva NÃO é recusa nem aprovação (intent segue CREATED, nenhuma recarga começa, 503);
 *  - F19/F20: `cancelarPreAutorizacaoCartao` só marca VOIDED com cancelamento CONFIRMADO, consulta ANTES de cancelar (nunca cancela venda já cancelada nem capturada).
 */

describe('C2 — identificadores da adquirente, autorização não definitiva e cancelamento (Postgres + Redis reais, FakeAdapter)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let fake: FakeAdapter
  let fixture: FixtureCartao

  beforeAll(async () => {
    resetPagamentoPortCacheParaTeste()
    fake = (await getPagamentoPort()) as FakeAdapter
    expect(fake).toBeInstanceOf(FakeAdapter)
    fixture = await criarFixtureCartao(app, suffix, 'c2')
  }, 30_000)

  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
    await banco.descartar()
  })

  // ------------------------------------------------------------------------------------------------------------------
  describe('C2.5 — identificadores gravados na autorização e de novo na captura', () => {
    it('a AUTORIZAÇÃO (POST /api/me/sessions/start) grava Tid/AuthorizationCode/ProofOfSale no PaymentIntent; a CAPTURA devolve os mesmos e o intent os mantém', async () => {
      const { intent: ref } = await fixture.sessaoParada('ident-feliz')
      const antes = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: ref.id } })
      expect(antes.status).toBe('CAPTURE_PENDING')
      expect(antes.cieloTid).toMatch(/^FAKETID/)
      expect(antes.cieloAuthorizationCode).toMatch(/^A/)
      expect(antes.cieloProofOfSale).toMatch(/^P/)

      const r = await capturarSessaoCartao(ref.id)
      expect(r?.status).toBe('CAPTURED')
      const depois = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: ref.id } })
      expect(depois).toMatchObject({ status: 'CAPTURED', cieloTid: antes.cieloTid, cieloAuthorizationCode: antes.cieloAuthorizationCode, cieloProofOfSale: antes.cieloProofOfSale })
    })

    it('a CAPTURA grava DE NOVO o que a Cielo devolver (valor novo substitui); vazio (null) NÃO apaga o que a autorização gravou; valor > 64 é truncado em 64 e o fluxo NÃO cai', async () => {
      const { intent: ref } = await fixture.sessaoParada('ident-captura')
      const original = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: ref.id } })
      const real = fake.capturar.bind(fake)
      vi.spyOn(fake, 'capturar').mockImplementation(async (id, cents) => {
        const r = await real(id, cents)
        return { ...r, identificadores: { tid: 'T'.repeat(100), authorizationCode: 'NOVO-AUTH', proofOfSale: null } }
      })

      const r = await capturarSessaoCartao(ref.id)
      expect(r?.status).toBe('CAPTURED') // a Cielo já cobrou: o metadado comprido NUNCA derruba o registro da captura

      const depois = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: ref.id } })
      expect(depois.status).toBe('CAPTURED')
      expect(depois.cieloTid).toBe('T'.repeat(64))
      expect(depois.cieloAuthorizationCode).toBe('NOVO-AUTH')
      expect(depois.cieloProofOfSale).toBe(original.cieloProofOfSale) // null na captura não apagou o da autorização
    })

    it('Pix NÃO grava os identificadores de cartão: ficam null', async () => {
      const driver = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver pix ${suffix}`, email: `pix-c2-${suffix}@example.com` } })
      const token = issueToken({ id: driver.id, role: 'DRIVER', operatorId: null })
      const res = await request(app).post('/api/me/wallet/topups').set('Authorization', `Bearer ${token}`).send({ amountCents: 2_000 })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: res.body.id } })
      expect(intent.provider).toBe('CIELO_PIX')
      expect([intent.cieloTid, intent.cieloAuthorizationCode, intent.cieloProofOfSale]).toEqual([null, null, null])
    })

    it('FakeAdapter: autorização aprovada devolve os três; negada devolve só o Tid; captura devolve os mesmos da autorização', async () => {
      const f = new FakeAdapter({ cardTokensNegados: ['recusado'] })
      const ok = await f.autorizar({ merchantOrderId: 'o1', amountRequestedCents: 1000, cartao: { cardToken: 'bom' }, cliente: { name: 'N' } })
      expect(ok.identificadores.tid).toMatch(/^FAKETID/)
      expect(ok.identificadores.authorizationCode).toBeTruthy()
      expect(ok.identificadores.proofOfSale).toBeTruthy()
      expect((await f.capturar(ok.providerPaymentId, 500)).identificadores).toEqual(ok.identificadores)
      const negado = await f.autorizar({ merchantOrderId: 'o2', amountRequestedCents: 1000, cartao: { cardToken: 'recusado' }, cliente: { name: 'N' } })
      expect(negado.identificadores).toMatchObject({ authorizationCode: null, proofOfSale: null })
      expect(negado.identificadores.tid).toBeTruthy()
    })
  })

  // ------------------------------------------------------------------------------------------------------------------
  describe('F16 — autorização SEM resposta definitiva não é recusa nem aprovação', () => {
    it('a Cielo devolve status não definitivo (Status 0/12 ou desconhecido): 503, NENHUM idTag criado, intent segue CREATED com o PaymentId — o varredor reconsulta e cancela se ela autorizar depois', async () => {
      const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver pend ${suffix}`, email: `pend-c2-${suffix}@example.com` } })
      const pm = await prisma.paymentMethod.create({ data: { userId: user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(`tok-pend-${suffix}`), brand: 'Visa', last4: '4242', isDefault: true } })
      const connector = await prisma.connector.create({ data: { operatorId: fixture.tenant.operatorId, chargePointId: fixture.tenant.chargePointId, connectorId: 777, type: 'AC_TYPE2', status: 'AVAILABLE' } })
      vi.spyOn(fake, 'autorizar').mockResolvedValue({
        providerPaymentId: `pend-${randomUUID()}`,
        status: 'CREATED',
        returnCode: null,
        amountAuthorizedCents: null,
        identificadores: { tid: 'TID-PEND', authorizationCode: null, proofOfSale: null },
      })

      const res = await request(app)
        .post('/api/me/sessions/start')
        .set('Authorization', `Bearer ${issueToken({ id: user.id, role: 'DRIVER', operatorId: null })}`)
        .send({ ocppIdentity: fixture.tenant.ocppIdentity, connectorId: connector.connectorId, payment: { mode: 'CARD', paymentMethodId: pm.id } })

      expect(res.status, JSON.stringify(res.body)).toBe(503)
      expect(res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
      expect(await prisma.authToken.count({ where: { userId: user.id } })).toBe(0) // nenhuma recarga começa
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: user.id } })
      expect(intent.status).toBe('CREATED') // NÃO DENIED: a Cielo pode autorizar depois e o varredor precisa enxergá-lo
      expect(intent.cieloPaymentId).toBeTruthy()
      expect(intent.cieloTid).toBe('TID-PEND')
    })

    it('S-7: a Cielo autorizou um valor DIFERENTE do pedido -> a recarga segue (a captura usa min(consumo, autorizado)) e sai o alerta payment_authorized_amount_mismatch', async () => {
      const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver s7 ${suffix}`, email: `s7-c2-${suffix}@example.com` } })
      const pm = await prisma.paymentMethod.create({ data: { userId: user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(`tok-s7-${suffix}`), brand: 'Visa', last4: '4242', isDefault: true } })
      const connector = await prisma.connector.create({ data: { operatorId: fixture.tenant.operatorId, chargePointId: fixture.tenant.chargePointId, connectorId: 779, type: 'AC_TYPE2', status: 'AVAILABLE' } })
      const real = fake.autorizar.bind(fake)
      vi.spyOn(fake, 'autorizar').mockImplementation(async (pedido) => ({ ...(await real(pedido)), amountAuthorizedCents: pedido.amountRequestedCents - 1 }))
      const aviso = vi.spyOn(logger, 'warn')
      const subscriber = createRedisConnection()
      const publisher = createRedisConnection()
      const channel = `ocpp:cmd:${fixture.tenant.chargePointId}`
      await subscriber.subscribe(channel)
      subscriber.on('message', (ch, message) => {
        const payload = JSON.parse(message) as { correlationId: string; method: string }
        if (ch === channel && payload.method === 'RemoteStartTransaction') publisher.publish(`ocpp:reply:${payload.correlationId}`, JSON.stringify({ correlationId: payload.correlationId, ok: true, result: { status: 'Accepted' } })).catch(() => {})
      })
      try {
        const res = await request(app)
          .post('/api/me/sessions/start')
          .set('Authorization', `Bearer ${issueToken({ id: user.id, role: 'DRIVER', operatorId: null })}`)
          .send({ ocppIdentity: fixture.tenant.ocppIdentity, connectorId: connector.connectorId, payment: { mode: 'CARD', paymentMethodId: pm.id } })
        expect(res.status, JSON.stringify(res.body)).toBe(202)
        expect(aviso.mock.calls.map((c) => (c[0] as { alert?: string }).alert)).toContain('payment_authorized_amount_mismatch')
      } finally {
        await new Promise((r) => setTimeout(r, 120))
        subscriber.disconnect()
        publisher.disconnect()
      }
    })

    it('a Cielo NEGA (status FAILED na porta): continua 402 + DENIED, e grava o Tid da tentativa recusada', async () => {
      const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver neg ${suffix}`, email: `neg-c2-${suffix}@example.com` } })
      const pm = await prisma.paymentMethod.create({ data: { userId: user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(`tok-neg-${suffix}`), brand: 'Visa', last4: '4242', isDefault: true } })
      const connector = await prisma.connector.create({ data: { operatorId: fixture.tenant.operatorId, chargePointId: fixture.tenant.chargePointId, connectorId: 778, type: 'AC_TYPE2', status: 'AVAILABLE' } })
      vi.spyOn(fake, 'autorizar').mockResolvedValue({
        providerPaymentId: `neg-${randomUUID()}`,
        status: 'FAILED',
        returnCode: '51',
        amountAuthorizedCents: null,
        identificadores: { tid: 'TID-NEG', authorizationCode: null, proofOfSale: null },
      })
      const res = await request(app)
        .post('/api/me/sessions/start')
        .set('Authorization', `Bearer ${issueToken({ id: user.id, role: 'DRIVER', operatorId: null })}`)
        .send({ ocppIdentity: fixture.tenant.ocppIdentity, connectorId: connector.connectorId, payment: { mode: 'CARD', paymentMethodId: pm.id } })
      expect(res.status, JSON.stringify(res.body)).toBe(402)
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: user.id } })
      expect(intent).toMatchObject({ status: 'DENIED', returnCode: '51', cieloTid: 'TID-NEG' })
    })
  })

  // ------------------------------------------------------------------------------------------------------------------
  describe('F19/F20 — cancelarPreAutorizacaoCartao', () => {
    async function preAutorizacao(f: FakeAdapter) {
      const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver cancel ${randomUUID().slice(0, 6)}`, email: `cancel-${randomUUID()}@example.com` } })
      const intent = await prisma.paymentIntent.create({
        data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX' },
      })
      const aut = await f.autorizar({ merchantOrderId: intent.id, amountRequestedCents: 1_000, cartao: { cardToken: 'tok' }, cliente: { name: 'N' } })
      const authToken = await prisma.authToken.create({ data: { idTag: `V${randomUUID().replace(/-/g, '')}`.slice(0, 20), type: 'VIRTUAL', userId: user.id, status: 'ACCEPTED' } })
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'AUTHORIZED', cieloPaymentId: aut.providerPaymentId, returnCode: '00', amountAuthorizedCents: 1_000, authorizedAt: new Date(Date.now() - 3600_000), authTokenId: authToken.id },
      })
      return { intentId: intent.id, authTokenId: authToken.id, paymentId: aut.providerPaymentId }
    }
    const estado = async (id: string) => prisma.paymentIntent.findUniqueOrThrow({ where: { id } })
    const tokenStatus = async (id: string) => (await prisma.authToken.findUniqueOrThrow({ where: { id } })).status

    it('cancelamento CONFIRMADO (Status 10, ReturnCode 0): intent VOIDED, idTag EXPIRED, true', async () => {
      const f = new FakeAdapter()
      const p = await preAutorizacao(f)
      expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(true)
      expect(await estado(p.intentId)).toMatchObject({ status: 'VOIDED', returnCode: '0' })
      expect(await tokenStatus(p.authTokenId)).toBe('EXPIRED')
    })

    it('estorno (Status 11, ReturnCode 9: depois de 23h59) também é CONFIRMADO -> VOIDED', async () => {
      const f = new FakeAdapter({ modoCancelamento: 'ESTORNO' })
      const p = await preAutorizacao(f)
      expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(true)
      expect(await estado(p.intentId)).toMatchObject({ status: 'VOIDED', returnCode: '9' })
    })

    it.each([
      ['EM_ANDAMENTO', 'payment_void_in_progress'],
      ['RECUSADO', 'payment_void_refused'],
      ['INDEFINIDO', 'payment_void_unconfirmed'],
    ] as const)('desfecho %s: NADA muda (intent segue AUTHORIZED, idTag segue ACCEPTED), devolve false e o alerta %s é emitido — o dinheiro nunca é dado como devolvido sem prova', async (modo, alerta) => {
      const f = new FakeAdapter({ modoCancelamento: modo })
      const p = await preAutorizacao(f)
      const spy = vi.spyOn(logger, modo === 'RECUSADO' ? 'error' : 'warn')
      expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
      expect((await estado(p.intentId)).status).toBe('AUTHORIZED')
      expect(await tokenStatus(p.authTokenId)).toBe('ACCEPTED')
      expect(spy.mock.calls.map((c) => (c[0] as { alert?: string }).alert)).toContain(alerta)
    })

    it('F20: a Cielo diz que a venda JÁ foi cancelada (o void anterior pegou e a resposta se perdeu): só espelha VOIDED, SEM chamar cancelar de novo', async () => {
      const f = new FakeAdapter()
      const p = await preAutorizacao(f)
      await f.cancelar(p.paymentId) // o void "anterior" que pegou lá
      expect(f.contagemCancelar(p.paymentId)).toBe(1)
      expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(true)
      expect((await estado(p.intentId)).status).toBe('VOIDED')
      expect(f.contagemCancelar(p.paymentId)).toBe(1) // nenhuma segunda chamada
    })

    it('a Cielo diz que a venda já foi CAPTURADA: NUNCA cancela (seria estornar o que foi cobrado) — nada muda, alerta payment_void_skipped_already_captured', async () => {
      const f = new FakeAdapter()
      const p = await preAutorizacao(f)
      await f.capturar(p.paymentId, 500)
      const erro = vi.spyOn(logger, 'error')
      expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
      expect(f.contagemCancelar(p.paymentId)).toBe(0)
      expect((await estado(p.intentId)).status).toBe('AUTHORIZED')
      expect(erro.mock.calls.map((c) => (c[0] as { alert?: string }).alert)).toContain('payment_void_skipped_already_captured')
    })

    it('consulta que falha antes de cancelar: nada muda e NENHUM cancelamento é tentado (o varredor repete)', async () => {
      const f = new FakeAdapter()
      const p = await preAutorizacao(f)
      vi.spyOn(f, 'consultar').mockRejectedValue(new Error('Cielo fora'))
      expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
      expect(f.contagemCancelar(p.paymentId)).toBe(0)
      expect((await estado(p.intentId)).status).toBe('AUTHORIZED')
    })

    it('cancelar() que lança (timeout): nada muda; na rodada seguinte, com a Cielo de volta, o cancelamento conclui', async () => {
      const f = new FakeAdapter()
      const p = await preAutorizacao(f)
      const real = f.cancelar.bind(f)
      vi.spyOn(f, 'cancelar').mockRejectedValueOnce(new Error('timeout'))
      expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
      expect((await estado(p.intentId)).status).toBe('AUTHORIZED')
      vi.spyOn(f, 'cancelar').mockImplementation(real)
      expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(true)
      expect((await estado(p.intentId)).status).toBe('VOIDED')
    })

    it('o varredor só conta como cancelada a pré-autorização que REALMENTE virou VOIDED nesta rodada', async () => {
      const f = new FakeAdapter({ modoCancelamento: 'EM_ANDAMENTO' })
      const p = await preAutorizacao(f)
      await prisma.paymentIntent.update({ where: { id: p.intentId }, data: { authorizedAt: new Date(Date.now() - 24 * 3600_000), chargingSessionId: null } })
      const r1 = await varrerPreAutorizacoesCartao(f)
      expect(r1.canceladasAbandonadas).toBe(0)
      expect((await estado(p.intentId)).status).toBe('AUTHORIZED')
      f.definirModoCancelamento('NORMAL')
      await limparControleCancelamento(p.intentId) // o desfecho "em andamento" deixou um backoff (I-3); limpa para a próxima rodada ser imediata
      const r2 = await varrerPreAutorizacoesCartao(f)
      expect(r2.canceladasAbandonadas).toBeGreaterThanOrEqual(1)
      expect((await estado(p.intentId)).status).toBe('VOIDED')
    })
  })
})
