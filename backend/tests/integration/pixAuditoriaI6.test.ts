import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'
import { logger } from '../../src/lib/logger'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { getPagamentoPort, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { creditarTopupPix } from '../../src/services/pagamentos/creditarTopupPix'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * I-6 (auditoria), Postgres + Redis reais, FakeAdapter no lugar da Cielo:
 *  - criar Pix: a resposta precisa ter PaymentId e QrCodeString não vazios e status PENDING; senão o intent vai a FAILED + 503 SEM consumir o limite de pendentes (e sem 500 de unique);
 *  - crédito: confere MerchantOrderId e Amount da consulta com o intent (divergiu -> NÃO credita + alerta); ReturnCode do Pix fora de {0,00,4,6} só alerta (ver o teste unitário).
 */
describe('Pix — resposta de criação válida e conferência no crédito (I-6)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let fake: FakeAdapter

  beforeAll(async () => {
    resetPagamentoPortCacheParaTeste()
    fake = (await getPagamentoPort()) as FakeAdapter
    expect(fake).toBeInstanceOf(FakeAdapter)
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function motorista(label: string) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver ${label} ${suffix}`, email: `pix-i6-${label}-${suffix}@example.com` } })
    return { id: user.id, auth: { Authorization: `Bearer ${issueToken({ id: user.id, role: 'DRIVER', operatorId: null })}` } }
  }
  const criar = (m: { auth: Record<string, string> }, amountCents = 2_000) => request(app).post('/api/me/wallet/topups').set(m.auth).send({ amountCents })

  describe('criação', () => {
    it.each([
      ['status FAILED (a Cielo recusou a cobrança Pix)', { status: 'FAILED', providerPaymentId: 'pid-ok', qrCodeString: '000201...' }],
      ['PaymentId vazio', { status: 'PENDING', providerPaymentId: '', qrCodeString: '000201...' }],
      ['PaymentId só com espaços', { status: 'PENDING', providerPaymentId: '   ', qrCodeString: '000201...' }],
      ['QrCodeString vazio', { status: 'PENDING', providerPaymentId: 'pid-ok', qrCodeString: '' }],
      ['status PAID na criação (impossível: ninguém pagou ainda)', { status: 'PAID', providerPaymentId: 'pid-ok', qrCodeString: '000201...' }],
    ] as const)('%s -> 503 PAYMENT_GATEWAY_UNAVAILABLE, intent FAILED, e o limite de pendentes NÃO é consumido', async (_nome, parcial) => {
      const m = await motorista(`inv-${randomUUID().slice(0, 6)}`)
      const erro = vi.spyOn(logger, 'error')
      const real = fake.criarPix.bind(fake)
      vi.spyOn(fake, 'criarPix').mockImplementationOnce(async (pedido) => ({ ...(await real(pedido)), ...parcial, providerPaymentId: parcial.providerPaymentId === 'pid-ok' ? `pid-${randomUUID()}` : parcial.providerPaymentId }))

      const res = await criar(m)
      expect(res.status, JSON.stringify(res.body)).toBe(503)
      expect(res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
      const intents = await prisma.paymentIntent.findMany({ where: { userId: m.id } })
      expect(intents).toHaveLength(1)
      expect(intents[0].status).toBe('FAILED')
      expect(intents[0].pixQrCode).toBeNull()
      expect(erro.mock.calls.map((c) => (c[0] as { alert?: string }).alert)).toContain('payment_pix_creation_invalid_response')

      // O limite padrão é 1 pendente por motorista: se o intent inválido tivesse ficado PENDING, a próxima criação seria 409.
      const ok = await criar(m)
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    })

    it('duas respostas seguidas com PaymentId vazio NÃO colidem no @unique (antes: o 2º dava 500)', async () => {
      const m = await motorista(`vazio-${randomUUID().slice(0, 6)}`)
      const real = fake.criarPix.bind(fake)
      vi.spyOn(fake, 'criarPix').mockImplementation(async (pedido) => ({ ...(await real(pedido)), providerPaymentId: '' }))
      expect((await criar(m)).status).toBe(503)
      expect((await criar(m)).status).toBe(503)
      expect(await prisma.paymentIntent.count({ where: { userId: m.id, status: 'FAILED' } })).toBe(2)
    })

    it('resposta válida segue 201 PENDING com o QR', async () => {
      const m = await motorista(`ok-${randomUUID().slice(0, 6)}`)
      const res = await criar(m)
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body).toMatchObject({ status: 'PENDING' })
      expect(res.body.qrCodeString).toBeTruthy()
    })
  })

  describe('crédito: identidade e valor da venda consultada', () => {
    async function topupPago(amountCents: number) {
      const m = await motorista(`cred-${randomUUID().slice(0, 6)}`)
      const res = await criar(m, amountCents)
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: res.body.id } })
      fake.marcarPixComoPago(intent.cieloPaymentId!)
      return { m, intent }
    }
    const saldo = async (userId: string) => {
      const wallet = await prisma.wallet.findUnique({ where: { userId } })
      if (!wallet) return 0
      return (await prisma.walletEntry.findFirst({ where: { walletId: wallet.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } }))?.balanceAfterCents ?? 0
    }

    it('venda consultada de OUTRO MerchantOrderId: NÃO credita, alerta payment_pix_credit_divergence (motivo merchant_order_id), intent segue PENDING', async () => {
      const { m, intent } = await topupPago(3_000)
      const real = fake.consultarPix.bind(fake)
      vi.spyOn(fake, 'consultarPix').mockImplementation(async (id) => ({ ...(await real(id)), merchantOrderId: 'OUTRO-PEDIDO' }))
      const erro = vi.spyOn(logger, 'error')
      expect(await creditarTopupPix(intent.id, fake)).toBeNull()
      expect(await saldo(m.id)).toBe(0)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PENDING')
      const alerta = erro.mock.calls.find((c) => (c[0] as { alert?: string }).alert === 'payment_pix_credit_divergence')
      expect(alerta?.[0]).toMatchObject({ motivo: 'merchant_order_id', paymentIntentId: intent.id })
    })

    it('valor pago DIFERENTE do pedido (maior ou menor): NÃO credita, alerta com os dois valores (motivo amount)', async () => {
      for (const pago of [2_999, 3_001]) {
        const { m, intent } = await topupPago(3_000)
        const real = fake.consultarPix.bind(fake)
        const espiao = vi.spyOn(fake, 'consultarPix').mockImplementation(async (id) => ({ ...(await real(id)), amountCents: pago }))
        const erro = vi.spyOn(logger, 'error')
        expect(await creditarTopupPix(intent.id, fake)).toBeNull()
        expect(await saldo(m.id)).toBe(0)
        const alerta = erro.mock.calls.find((c) => (c[0] as { alert?: string }).alert === 'payment_pix_credit_divergence')
        expect(alerta?.[0]).toMatchObject({ motivo: 'amount', esperadoCents: 3_000, pagoCents: pago })
        espiao.mockRestore()
        erro.mockRestore()
      }
    })

    it('identidade e valor conferem: credita normalmente (e uma vez só)', async () => {
      const { m, intent } = await topupPago(3_000)
      expect(await creditarTopupPix(intent.id, fake)).not.toBeNull()
      expect(await saldo(m.id)).toBe(3_000)
      expect(await creditarTopupPix(intent.id, fake)).toBeNull()
      expect(await saldo(m.id)).toBe(3_000)
    })

    it('a Cielo não informa o valor (null): credita pelo valor do intent (não há o que comparar) — comportamento anterior preservado', async () => {
      const { m, intent } = await topupPago(1_500)
      const real = fake.consultarPix.bind(fake)
      vi.spyOn(fake, 'consultarPix').mockImplementation(async (id) => ({ ...(await real(id)), amountCents: null }))
      expect(await creditarTopupPix(intent.id, fake)).not.toBeNull()
      expect(await saldo(m.id)).toBe(1_500)
    })
  })
})
