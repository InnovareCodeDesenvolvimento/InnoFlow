import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { getPagamentoPort, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { creditarTopupPix } from '../../src/services/pagamentos/creditarTopupPix'
import { backoffPollSegundos, chaveCursorVarredorPix, chaveProximaConsultaPix, LOTE_POLL_PIX, tentarCreditarPixPendente, varrerTopupsPixPendentes } from '../../src/services/pagamentos/pollTopupsPix'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * Conta Cielo COMPARTILHADA com o Parque (decisão do dono, 04/10/2026): o InnoFlow não cadastra URL de notificação, então o Pix pago só é descoberto por POLLING. Postgres + Redis reais, banco próprio
 * (o varredor olha TODOS os Pix PENDING do banco), FakeAdapter no lugar da Cielo. Nenhum webhook é chamado em nenhum teste deste arquivo.
 */
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('pix_poll')
})

describe('Pix creditado por POLLING (sem webhook)', () => {
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
    await banco.descartar()
  })

  async function motorista(label: string) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver ${label} ${suffix}`, email: `poll-${label}-${randomUUID().slice(0, 6)}-${suffix}@example.com` } })
    return { id: user.id, auth: { Authorization: `Bearer ${issueToken({ id: user.id, role: 'DRIVER', operatorId: null })}` } }
  }
  async function pixCriado(m: { id: string; auth: Record<string, string> }, amountCents = 3_000, idadeSegundos = 0) {
    const res = await request(app).post('/api/me/wallet/topups').set(m.auth).send({ amountCents })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    if (idadeSegundos > 0) await prisma.paymentIntent.update({ where: { id: res.body.id }, data: { createdAt: new Date(Date.now() - idadeSegundos * 1000) } })
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: res.body.id } })
    return intent
  }
  const saldo = async (userId: string) => {
    const w = await prisma.wallet.findUnique({ where: { userId } })
    if (!w) return 0
    return (await prisma.walletEntry.findFirst({ where: { walletId: w.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } }))?.balanceAfterCents ?? 0
  }
  const entradas = async (userId: string) => {
    const w = await prisma.wallet.findUnique({ where: { userId } })
    return w ? prisma.walletEntry.count({ where: { walletId: w.id, type: 'TOPUP_PIX' } }) : 0
  }

  it('backoff por idade: 15 s no 1º minuto, 30 s até 5 min, 60 s até 30 min, 120 s depois', () => {
    expect([0, 59].map(backoffPollSegundos)).toEqual([15, 15])
    expect([60, 299].map(backoffPollSegundos)).toEqual([30, 30])
    expect([300, 1799].map(backoffPollSegundos)).toEqual([60, 60])
    expect([1800, 7200].map(backoffPollSegundos)).toEqual([120, 120])
  })

  describe('varredor periódico', () => {
    it('Pix PAGO e sem nenhum webhook: o varredor credita (uma vez), o intent vira PAID e o saldo sobe', async () => {
      const m = await motorista('varredor')
      const intent = await pixCriado(m, 3_000, 20)
      fake.marcarPixComoPago(intent.cieloPaymentId!)

      const r = await varrerTopupsPixPendentes(fake)
      expect(r.creditados).toBe(1)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PAID')
      expect(await saldo(m.id)).toBe(3_000)

      // rodar de novo (e fora do backoff) nunca credita em dobro
      await redis.del(chaveProximaConsultaPix(intent.id))
      await varrerTopupsPixPendentes(fake)
      expect(await saldo(m.id)).toBe(3_000)
      expect(await entradas(m.id)).toBe(1)
    })

    it('Pix NÃO pago: consulta e NADA muda; a rodada seguinte, dentro do backoff, NÃO consulta de novo (não martela a Cielo)', async () => {
      const m = await motorista('nao-pago')
      // O `beforeEach` de `pixPollingRevalidacaoIndependente` apaga `pix-poll:*` no Redis COMPARTILHADO (suítes paralelas). Se a reserva sumir entre duas rodadas do cenário, a 2ª consulta é legítima
      // (backoff perdido por interferência alheia, não bug do varredor): o cenário é refeito com outro Pix. Só se REPETE quando a interferência foi detectada; as asserções não mudam.
      let intent = await pixCriado(m, 2_000, 20)
      const consultar = vi.spyOn(fake, 'consultarPix')
      for (let tentativa = 1; ; tentativa++) {
        consultar.mockClear()
        const sentinela = `pix-poll:sentinela:${randomUUID()}` // some junto com `pix-poll:*` se uma suíte alheia limpar o Redis no meio do cenário
        await redis.set(sentinela, '1', 'EX', 120)
        await varrerTopupsPixPendentes(fake)
        const ttl = await redis.ttl(chaveProximaConsultaPix(intent.id))
        await varrerTopupsPixPendentes(fake)
        await varrerTopupsPixPendentes(fake)
        const ttlFinal = await redis.ttl(chaveProximaConsultaPix(intent.id))
        const interferencia = ttl <= 0 || ttlFinal <= 0 || (await redis.get(sentinela)) === null
        await redis.del(sentinela)
        if (interferencia && tentativa < 5) {
          await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'FAILED' } })
          intent = await pixCriado(m, 2_000, 20)
          continue
        }
        expect(ttl).toBeGreaterThan(0)
        expect(ttl).toBeLessThanOrEqual(15) // idade ~20 s => backoff de 15 s
        break
      }

      expect(consultar.mock.calls.filter((c) => c[0] === intent.cieloPaymentId)).toHaveLength(1)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PENDING')
      expect(await saldo(m.id)).toBe(0)

      // passado o backoff, consulta de novo — e se já foi pago, credita
      fake.marcarPixComoPago(intent.cieloPaymentId!)
      await redis.del(chaveProximaConsultaPix(intent.id))
      expect((await varrerTopupsPixPendentes(fake)).creditados).toBe(1)
      expect(await saldo(m.id)).toBe(2_000)
    })

    it('idade mínima: Pix recém-criado (< 15 s) NÃO é consultado', async () => {
      const m = await motorista('novo')
      const intent = await pixCriado(m, 1_000, 0)
      const consultar = vi.spyOn(fake, 'consultarPix')
      await varrerTopupsPixPendentes(fake)
      expect(consultar.mock.calls.some((c) => c[0] === intent.cieloPaymentId)).toBe(false)
    })

    it('Pix VENCIDO fica com o varredor de expiração (este não o consulta); Pix de outro ambiente é pulado', async () => {
      const m = await motorista('vencido')
      const vencido = await pixCriado(m, 1_000, 40)
      await prisma.paymentIntent.update({ where: { id: vencido.id }, data: { pixExpiresAt: new Date(Date.now() - 60_000) } })
      const consultar = vi.spyOn(fake, 'consultarPix')
      await varrerTopupsPixPendentes(fake)
      expect(consultar.mock.calls.some((c) => c[0] === vencido.cieloPaymentId)).toBe(false)
    })

    it('Pix PENDING SEM PaymentId da Cielo (criação que não completou) NÃO é consultado pelo varredor', async () => {
      const m = await motorista('sem-paymentid')
      const intent = await pixCriado(m, 1_000, 40)
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { cieloPaymentId: null } })
      const consultar = vi.spyOn(fake, 'consultarPix')
      const r = await varrerTopupsPixPendentes(fake)
      expect(consultar).not.toHaveBeenCalled()
      expect(r.consultados).toBe(0)
    })

    it('Pix de OUTRO ambiente (intent PRODUCTION com o gateway em SANDBOX) NÃO é consultado — nem creditado — pelo varredor', async () => {
      const m = await motorista('outro-ambiente')
      const intent = await pixCriado(m, 1_000, 40)
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { environment: 'PRODUCTION' } })
      fake.marcarPixComoPago(intent.cieloPaymentId!)
      const consultar = vi.spyOn(fake, 'consultarPix')
      const r = await varrerTopupsPixPendentes(fake)
      expect(consultar.mock.calls.some((c) => c[0] === intent.cieloPaymentId)).toBe(false)
      expect(r.creditados).toBe(0)
      expect(await saldo(m.id)).toBe(0)
    })

    it('TETO por rodada: com 60 Pix pendentes consulta no máximo LOTE_POLL_PIX (50) por rodada; o resto fica para a próxima — sem re-consultar quem já foi', async () => {
      const m = await motorista('lote')
      const base = await pixCriado(m, 1_000, 40)
      const intents = [base]
      for (let i = 0; i < 59; i++) {
        const copia = await prisma.paymentIntent.create({
          data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: m.id, walletId: base.walletId, amountRequestedCents: 500, status: 'PENDING', environment: 'SANDBOX', cieloPaymentId: `lote-${randomUUID()}`, pixQrCode: 'x', pixExpiresAt: new Date(Date.now() + 30 * 60_000), createdAt: new Date(Date.now() - 40_000) },
        })
        intents.push(copia)
      }
      const consultar = vi.spyOn(fake, 'consultarPix').mockRejectedValue(new Error('Cielo fora (simulado)')) // falhar não derruba o lote nem desfaz o backoff
      const r1 = await varrerTopupsPixPendentes(fake)
      expect(r1.consultados).toBe(LOTE_POLL_PIX)
      expect(consultar).toHaveBeenCalledTimes(LOTE_POLL_PIX)
      const r2 = await varrerTopupsPixPendentes(fake)
      expect(r2.consultados).toBe(60 - LOTE_POLL_PIX) // só os 10 que ficaram
      const r3 = await varrerTopupsPixPendentes(fake)
      expect(r3.consultados).toBe(0) // todos em backoff
      expect(consultar).toHaveBeenCalledTimes(60)
      await prisma.paymentIntent.updateMany({ where: { id: { in: intents.map((i) => i.id) } }, data: { status: 'EXPIRED' } }) // não deixa lixo para os testes seguintes
    }, 60_000)

    it('IDEMPOTÊNCIA sob concorrência: varredor + leitura do app + chamada direta ao mesmo tempo creditam UMA vez', async () => {
      const m = await motorista('concorrencia')
      const intent = await pixCriado(m, 4_000, 20)
      fake.marcarPixComoPago(intent.cieloPaymentId!)
      await Promise.all([
        varrerTopupsPixPendentes(fake),
        creditarTopupPix(intent.id, fake),
        creditarTopupPix(intent.id, fake),
        request(app).get(`/api/me/wallet/topups/${intent.id}`).set(m.auth),
      ])
      expect(await saldo(m.id)).toBe(4_000)
      expect(await entradas(m.id)).toBe(1)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PAID')
    })
  })

  describe('varredor — cursor persistente (todo Pix pendente é alcançado, mesmo com mais de uma rodada de fila)', () => {
    /** Zera o estado do varredor neste banco próprio: nada pendente de testes anteriores e nenhum cursor/backoff sobrando. */
    async function zerarVarredor() {
      await prisma.paymentIntent.updateMany({ where: { purpose: 'WALLET_TOPUP_PIX', status: 'PENDING' }, data: { status: 'FAILED' } })
      await redis.del(chaveCursorVarredorPix())
    }
    async function pendentes(n: number) {
      const m = await motorista(`cursor-${n}`)
      const base = await pixCriado(m, 1_000, 40)
      const todos = [base]
      for (let i = 1; i < n; i++) {
        todos.push(
          await prisma.paymentIntent.create({
            data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: m.id, walletId: base.walletId, amountRequestedCents: 500, status: 'PENDING', environment: 'SANDBOX', cieloPaymentId: `cur-${randomUUID()}`, pixQrCode: 'x', pixExpiresAt: new Date(Date.now() + 30 * 60_000), createdAt: new Date(Date.now() - 40_000) },
          }),
        )
      }
      return todos.sort((a, b) => (a.id < b.id ? -1 : 1))
    }

    it('a chave do cursor leva o NOME DO BANCO (dois bancos no mesmo Redis não compartilham cursor)', () => {
      expect(chaveCursorVarredorPix()).toContain(banco.nome)
    })

    it('rodada que para NO MEIO de uma página (teto de 50): a próxima retoma exatamente depois do último examinado — ninguém é pulado', async () => {
      await zerarVarredor()
      const todos = await pendentes(100)
      // os 20 primeiros já estão em backoff (reservados): a rodada 1 os examina sem consultar, consulta os 50 seguintes (itens 21..70) e para no meio da 2ª página
      for (const i of todos.slice(0, 20)) await redis.set(chaveProximaConsultaPix(i.id), '1', 'EX', 60)
      const consultar = vi.spyOn(fake, 'consultarPix').mockRejectedValue(new Error('Cielo fora (simulado)'))
      const r1 = await varrerTopupsPixPendentes(fake)
      expect(r1.consultados).toBe(LOTE_POLL_PIX)
      expect(await redis.get(chaveCursorVarredorPix())).toBe(todos[69].id) // retoma DEPOIS do 70º
      const consultadosR1 = new Set(consultar.mock.calls.map((c) => c[0]))
      const r2 = await varrerTopupsPixPendentes(fake)
      expect(r2.consultados).toBe(30) // os itens 71..100 — não 0 (cursor no fim da página) e não repete os já consultados
      const todosConsultados = new Set(consultar.mock.calls.map((c) => c[0]))
      for (const i of todos.slice(20)) expect(todosConsultados.has(i.cieloPaymentId), `intent ${i.id}`).toBe(true)
      for (const i of todos.slice(0, 20)) expect(todosConsultados.has(i.cieloPaymentId)).toBe(false) // seguem em backoff
      expect(consultadosR1.size).toBe(50)
      expect(await redis.get(chaveCursorVarredorPix())).toBeNull() // viu o fim da lista: a próxima rodada recomeça do início
    })

    it('cursor ficou ALÉM de tudo que restou (os de trás foram pagos/saíram): a MESMA rodada volta ao início e alcança os que ficaram para trás', async () => {
      await zerarVarredor()
      const todos = await pendentes(80)
      for (const i of todos.slice(0, 20)) await redis.set(chaveProximaConsultaPix(i.id), '1', 'EX', 1) // ficam fora da 1ª rodada
      const consultar = vi.spyOn(fake, 'consultarPix').mockRejectedValue(new Error('Cielo fora (simulado)'))
      await varrerTopupsPixPendentes(fake) // examina 1..80: consulta 21..70 e para no 70º (teto de 50)
      expect(await redis.get(chaveCursorVarredorPix())).toBe(todos[69].id)
      // os itens 71..80 saem da fila (pagos por outro caminho) e o backoff dos 20 primeiros vence
      await prisma.paymentIntent.updateMany({ where: { id: { in: todos.slice(70).map((i) => i.id) } }, data: { status: 'PAID' } })
      await redis.del(...todos.slice(0, 20).map((i) => chaveProximaConsultaPix(i.id)))
      consultar.mockClear()
      const r = await varrerTopupsPixPendentes(fake)
      expect(r.consultados).toBe(20) // nada além do cursor => volta ao começo nesta mesma rodada
      for (const i of todos.slice(0, 20)) expect(consultar.mock.calls.some((c) => c[0] === i.cieloPaymentId), `intent ${i.id}`).toBe(true)
    })

    it('Redis sem cursor (apagado/expirado): começa do início, sem erro', async () => {
      await zerarVarredor()
      const todos = await pendentes(3)
      const consultar = vi.spyOn(fake, 'consultarPix').mockRejectedValue(new Error('Cielo fora (simulado)'))
      await redis.del(chaveCursorVarredorPix())
      expect((await varrerTopupsPixPendentes(fake)).consultados).toBe(3)
      expect(consultar).toHaveBeenCalledTimes(todos.length)
    })
  })

  describe('leitura do top-up pelo app', () => {
    it('GET /wallet/topups/:id de um Pix PAGO e ainda PENDING: reconsulta, credita e JÁ responde PAID (sem webhook, sem esperar o varredor)', async () => {
      const m = await motorista('leitura')
      const intent = await pixCriado(m, 5_000)
      expect((await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(m.auth)).body.status).toBe('PENDING') // ainda não pago
      fake.marcarPixComoPago(intent.cieloPaymentId!)
      await redis.del(`pix-poll:read:${intent.id}`) // o intervalo mínimo de 5 s entre leituras

      const lido = await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(m.auth)
      expect(lido.status).toBe(200)
      expect(lido.body.status).toBe('PAID')
      expect(await saldo(m.id)).toBe(5_000)
      // ler de novo não credita de novo
      await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(m.auth)
      expect(await entradas(m.id)).toBe(1)
    })

    it('intervalo mínimo por intent: duas leituras seguidas fazem UMA consulta à Cielo (as 4 telas abertas do app não martelam)', async () => {
      const m = await motorista('leitura-limite')
      const intent = await pixCriado(m, 1_000)
      const consultar = vi.spyOn(fake, 'consultarPix')
      for (let i = 0; i < 4; i++) await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(m.auth)
      expect(consultar.mock.calls.filter((c) => c[0] === intent.cieloPaymentId)).toHaveLength(1)
    })

    it('a Cielo fora do ar NÃO quebra a leitura: 200 com o estado atual (PENDING)', async () => {
      const m = await motorista('leitura-falha')
      const intent = await pixCriado(m, 1_000)
      vi.spyOn(fake, 'consultarPix').mockRejectedValue(new Error('Cielo fora'))
      const lido = await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(m.auth)
      expect(lido.status).toBe(200)
      expect(lido.body.status).toBe('PENDING')
    })

    it('Pix de OUTRO motorista: 404 (a reconsulta não vira oráculo); Pix já PAID não reconsulta', async () => {
      const a = await motorista('dono')
      const b = await motorista('intruso')
      const intent = await pixCriado(a, 1_000)
      expect((await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(b.auth)).status).toBe(404)
      fake.marcarPixComoPago(intent.cieloPaymentId!)
      await creditarTopupPix(intent.id, fake)
      const consultar = vi.spyOn(fake, 'consultarPix')
      await redis.del(`pix-poll:read:${intent.id}`)
      expect((await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(a.auth)).body.status).toBe('PAID')
      expect(consultar).not.toHaveBeenCalled()
    })

    it('a Cielo PENDURADA (nunca responde): tentarCreditarPixPendente devolve false dentro do PRAZO, sem lançar e sem creditar', async () => {
      const m = await motorista('pendurada')
      const intent = await pixCriado(m, 1_000, 20)
      vi.spyOn(fake, 'consultarPix').mockImplementation(() => new Promise(() => undefined))
      const inicio = Date.now()
      expect(await tentarCreditarPixPendente(intent.id, { port: fake, prazoMs: 150, minIntervaloSeg: 1 })).toBe(false)
      expect(Date.now() - inicio).toBeLessThan(2_000)
      expect(await saldo(m.id)).toBe(0)
    })

    it('tentarCreditarPixPendente nunca lança (Redis fora): devolve false', async () => {
      vi.spyOn(redis, 'set').mockRejectedValue(new Error('Redis fora'))
      expect(await tentarCreditarPixPendente('qualquer-id')).toBe(false)
    })
  })
})
