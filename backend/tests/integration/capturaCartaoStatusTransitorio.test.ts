import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import type { PagamentoPort } from '../../src/core/pagamentos/porta'
import { getPagamentoPort } from '../../src/services/pagamentos/pagamentoPortInstance'
import { capturarSessaoCartao, CapturaCartaoNaoDefinitivaError } from '../../src/services/pagamentos/capturarSessaoCartao'
import type { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { uniqueSuffix } from './helpers/fixtures'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'

/**
 * F5.7 (Vega, 02/10/2026) — M1 do portão final do Órion: captura com status TRANSITÓRIO virava FAILED + dívida de 100%.
 * Se a Cielo respondia "pendente" e a captura concluía depois, o motorista pagava DUAS vezes (dívida + cartão). Só um
 * resultado DEFINITIVO negativo (FAILED/VOIDED) cria dívida; qualquer outro status lança para retentar/reconsultar.
 * Postgres + Redis reais; o gateway é o `FakeAdapter` (a Cielo real nunca foi chamada).
 */
describe('M1 — status transitório da captura NUNCA vira dívida; só resultado definitivo negativo', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let fake: FakeAdapter
  let fx: FixtureCartao

  beforeAll(async () => {
    fake = (await getPagamentoPort()) as unknown as FakeAdapter
    fx = await criarFixtureCartao(app, suffix, 'm1-transitorio')
  })

  afterAll(async () => {
    fake.definirModoCaptura('NORMAL')
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('Cielo "pendente" na captura: lança (retenta), nada gravado; depois conclui -> captura 1x, ZERO dívida', async () => {
    const { intent } = await fx.sessaoParada('pendente')
    const cieloPaymentId = intent.cieloPaymentId!
    fake.definirModoCaptura('PENDENTE')
    try {
      // 1ª volta: capturar() devolve CREATED (pendente) -> não definitivo -> LANÇA, nada de FAILED/dívida.
      await expect(capturarSessaoCartao(intent.id, fake)).rejects.toBeInstanceOf(CapturaCartaoNaoDefinitivaError)
      expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'CAPTURE_PENDING' })
      expect(await prisma.debt.count({ where: { paymentIntentId: intent.id } })).toBe(0)
      expect(fake.contagemCapturar(cieloPaymentId)).toBe(1)

      // 2ª volta ainda pendente: RECONSULTA (CREATED) e lança de novo — sem capturar uma 2ª vez.
      await expect(capturarSessaoCartao(intent.id, fake)).rejects.toBeInstanceOf(CapturaCartaoNaoDefinitivaError)
      expect(fake.contagemCapturar(cieloPaymentId)).toBe(1)
      expect(await prisma.debt.count({ where: { paymentIntentId: intent.id } })).toBe(0)

      // A Cielo conclui a captura. A próxima volta só espelha: CAPTURED, valor cheio, ZERO dívida (o motorista paga UMA vez).
      fake.concluirCapturaPendente(cieloPaymentId)
      const r = await capturarSessaoCartao(intent.id, fake)
      expect(r).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 300, shortfallCents: 0, debtId: null })
      expect(fake.contagemCapturar(cieloPaymentId)).toBe(1)
      expect(await prisma.debt.count({ where: { paymentIntentId: intent.id } })).toBe(0)
      expect(await fx.conciliacao()).toMatchObject({ differenceCents: 0 })
    } finally {
      fake.definirModoCaptura('NORMAL')
    }
  })

  it('Cielo NEGA a captura (FAILED definitivo): aí sim FAILED + dívida integral (CARD_CAPTURE_FAILED), conciliação em 0', async () => {
    const { intent } = await fx.sessaoParada('negada')
    fake.definirModoCaptura('NEGADA')
    try {
      const r = await capturarSessaoCartao(intent.id, fake)
      expect(r).toMatchObject({ status: 'FAILED', amountCapturedCents: 0, shortfallCents: 300 })
      expect(await prisma.debt.findFirstOrThrow({ where: { paymentIntentId: intent.id } })).toMatchObject({ amountCents: 300, status: 'OPEN', reason: 'CARD_CAPTURE_FAILED' })
      expect(await fx.conciliacao()).toMatchObject({ differenceCents: 0 })
    } finally {
      fake.definirModoCaptura('NORMAL')
    }
  })

  it.each(['CREATED', 'CAPTURE_PENDING', 'AUTHORIZED', 'XPTO-DESCONHECIDO'])('status %s devolvido pela captura é tratado como NÃO definitivo: lança, sem dívida, intent segue CAPTURE_PENDING', async (statusEstranho) => {
    const { intent } = await fx.sessaoParada(`estranho-${statusEstranho.toLowerCase().slice(0, 6)}`)
    const porta = {
      consultar: async () => ({ providerPaymentId: intent.cieloPaymentId!, merchantOrderId: intent.id, status: 'AUTHORIZED' as const, returnCode: null, amountAuthorizedCents: 5000, amountCapturedCents: null }),
      capturar: async () => ({ providerPaymentId: intent.cieloPaymentId!, status: statusEstranho, returnCode: null, amountCapturedCents: null }),
    } as unknown as PagamentoPort
    await expect(capturarSessaoCartao(intent.id, porta)).rejects.toBeInstanceOf(CapturaCartaoNaoDefinitivaError)
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'CAPTURE_PENDING' })
    expect(await prisma.debt.count({ where: { paymentIntentId: intent.id } })).toBe(0)
  })

  it('a RECONSULTA antes de capturar já vê um resultado negativo definitivo (VOIDED na Cielo): dívida, sem tentar capturar', async () => {
    const { intent } = await fx.sessaoParada('voided-antes')
    await fake.cancelar(intent.cieloPaymentId!) // a pré-autorização foi cancelada/expirou do lado da Cielo
    const r = await capturarSessaoCartao(intent.id, fake)
    expect(r).toMatchObject({ status: 'FAILED', shortfallCents: 300 })
    expect(fake.contagemCapturar(intent.cieloPaymentId!)).toBe(0)
    expect(await prisma.debt.findFirstOrThrow({ where: { paymentIntentId: intent.id } })).toMatchObject({ amountCents: 300, reason: 'CARD_CAPTURE_FAILED' })
  })
})
