import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'
import { encryptPaymentSecret } from '../../src/lib/crypto/paymentSecrets'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { getAmbienteEfetivoParaBancoOu503 } from '../../src/services/pagamentos/gatewayConfig'
import { limparRiscoDeCartaoParaTeste } from '../../src/services/pagamentos/elegibilidadeCartao'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * N-9 (Órion, 05/10/2026) — o teto de 5 cartões ativos por motorista tinha corrida check-then-insert: N cadastros paralelos liam a MESMA
 * contagem dentro de transações READ COMMITTED e todos inseriam. Aqui, Postgres e Redis reais, requisições HTTP paralelas de verdade.
 *
 * Para a corrida ser de fato disputada (e não depender de sorte de agendamento), a "consulta do cartão na Cielo" (que roda ANTES da transação)
 * vira uma barreira: nenhuma requisição segue enquanto as N não chegaram; liberadas juntas, as N entram na transação no mesmo instante.
 */

const N_PARALELAS = 8 // = teto do rate limit do cadastro (8/min por motorista): o máximo que um motorista consegue disparar de uma vez
const SEM_DADOS = { brand: null, last4: null, holderName: null, expiryMonth: null, expiryYear: null }

describe('POST /api/me/payment-methods — teto de 5 cartões sob concorrência (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()

  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function novoMotorista(label: string) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver ${label} ${suffix}`, email: `teto-${label}-${suffix}@example.com` } })
    await limparRiscoDeCartaoParaTeste(user.id)
    return { id: user.id, auth: { Authorization: `Bearer ${issueToken({ id: user.id, role: 'DRIVER', operatorId: null })}` } }
  }

  /** Cartão já cadastrado direto no banco (sem passar pela rota), no ambiente efetivo. */
  async function semearCartoes(userId: string, quantos: number) {
    const environment = await getAmbienteEfetivoParaBancoOu503()
    for (let i = 0; i < quantos; i++) {
      await prisma.paymentMethod.create({
        data: { userId, environment, type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(randomUUID()), brand: 'Visa', last4: '4242', isDefault: i === 0, active: true },
      })
    }
  }

  /** A consulta à Cielo (antes da transação) só retorna quando as N requisições chegaram a ela. */
  function barreira(n: number) {
    let chegaram = 0
    let liberar!: () => void
    const portao = new Promise<void>((resolve) => (liberar = resolve))
    vi.spyOn(FakeAdapter.prototype, 'consultarCartaoTokenizado').mockImplementation(async (cardToken: string) => {
      if (++chegaram >= n) liberar()
      await Promise.race([portao, new Promise((r) => setTimeout(r, 5_000))])
      return { cardToken, ...SEM_DADOS }
    })
  }

  const cadastrar = (m: { auth: Record<string, string> }, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/me/payment-methods').set(m.auth).send({ cardToken: randomUUID(), brand: 'Visa', ...extra })

  async function cartoesAtivos(userId: string) {
    return prisma.paymentMethod.findMany({ where: { userId, active: true } })
  }

  it(`${N_PARALELAS} cadastros paralelos de quem não tem cartão: no máximo 5 entram (os demais levam 409 TOO_MANY_PAYMENT_METHODS) e há exatamente UM padrão`, async () => {
    barreira(N_PARALELAS)
    const m = await novoMotorista('zero')

    const respostas = await Promise.all(Array.from({ length: N_PARALELAS }, () => cadastrar(m, { makeDefault: true })))

    const criados = respostas.filter((r) => r.status === 201)
    const barrados = respostas.filter((r) => r.status === 409)
    expect(respostas.map((r) => r.status).sort(), JSON.stringify(respostas.map((r) => r.body))).toEqual([...Array(5).fill(201), ...Array(N_PARALELAS - 5).fill(409)])
    expect(criados).toHaveLength(5)
    for (const r of barrados) expect(r.body.code).toBe('TOO_MANY_PAYMENT_METHODS')

    const ativos = await cartoesAtivos(m.id)
    expect(ativos).toHaveLength(5)
    expect(ativos.filter((c) => c.isDefault)).toHaveLength(1)
  })

  it(`com 4 cartões já cadastrados, ${N_PARALELAS} cadastros paralelos criam EXATAMENTE 1 (o 5º) — nunca 4 + N`, async () => {
    const m = await novoMotorista('quatro')
    await semearCartoes(m.id, 4)
    barreira(N_PARALELAS)

    const respostas = await Promise.all(Array.from({ length: N_PARALELAS }, () => cadastrar(m)))

    expect(respostas.filter((r) => r.status === 201), JSON.stringify(respostas.map((r) => r.body))).toHaveLength(1)
    expect(respostas.filter((r) => r.status === 409)).toHaveLength(N_PARALELAS - 1)
    expect(await cartoesAtivos(m.id)).toHaveLength(5)
  })

  it('o lock é por motorista: a rajada de um não segura nem derruba o cadastro de outro', async () => {
    barreira(N_PARALELAS + 1)
    const rajada = await novoMotorista('rajada')
    const outro = await novoMotorista('outro')

    const respostas = await Promise.all([...Array.from({ length: N_PARALELAS }, () => cadastrar(rajada)), cadastrar(outro)])

    expect(respostas[N_PARALELAS].status).toBe(201)
    expect(await cartoesAtivos(outro.id)).toHaveLength(1)
    expect(await cartoesAtivos(rajada.id)).toHaveLength(5)
  })

  it('cadastro sequencial normal segue igual: 5 passam e o 6º leva 409; remover um libera a vaga', async () => {
    const m = await novoMotorista('sequencial')
    vi.spyOn(FakeAdapter.prototype, 'consultarCartaoTokenizado').mockImplementation(async (cardToken: string) => ({ cardToken, ...SEM_DADOS }))
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await cadastrar(m)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      ids.push(r.body.id)
    }
    const sexto = await cadastrar(m)
    expect(sexto.status).toBe(409)
    expect(sexto.body.code).toBe('TOO_MANY_PAYMENT_METHODS')

    expect((await request(app).delete(`/api/me/payment-methods/${ids[1]}`).set(m.auth)).status).toBe(204)
    expect((await cadastrar(m)).status).toBe(201)
  })
})
