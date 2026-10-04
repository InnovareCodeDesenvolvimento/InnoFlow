import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * C1.3 (R2/F25) — o cadastro de cartão NÃO depende de `GET /1/card/{token}` (endpoint não confirmado na doc nem usado pelo Parque). A página
 * isolada envia `last4`, `expiryMonth` e `expiryYear` (o script do SOP não os devolve); a consulta, se existir, é só enriquecimento. Postgres e
 * Redis reais; o `FakeAdapter` faz o papel da Cielo e a consulta é espiada para devolver "sem dados" (o que o `CieloAdapter` faz quando o GET falha).
 */

const SEM_DADOS = { brand: null, last4: null, holderName: null, expiryMonth: null, expiryYear: null }

describe('POST /api/me/payment-methods com os dados enviados pela página isolada (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()

  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function novoMotorista(label: string) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver ${label} ${suffix}`, email: `cartao-${label}-${suffix}@example.com` } })
    return { id: user.id, auth: { Authorization: `Bearer ${issueToken({ id: user.id, role: 'DRIVER', operatorId: null })}` } }
  }

  const cadastrar = (m: { auth: Record<string, string> }, corpo: Record<string, unknown>) => request(app).post('/api/me/payment-methods').set(m.auth).send({ cardToken: `${randomUUID()}`, brand: 'Visa', ...corpo })

  function consultaSemDados() {
    return vi.spyOn(FakeAdapter.prototype, 'consultarCartaoTokenizado').mockImplementation(async (cardToken: string) => ({ cardToken, ...SEM_DADOS }))
  }

  it('consulta sem dados (GET da Cielo indisponível): grava last4, validade e bandeira que a PÁGINA enviou — 201, e o token cifrado nunca volta', async () => {
    consultaSemDados()
    const m = await novoMotorista('envio')
    const res = await cadastrar(m, { brand: 'Master', last4: '4242', expiryMonth: 12, expiryYear: 2031 })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toMatchObject({ brand: 'Master', last4: '4242', expiryMonth: 12, expiryYear: 2031, isDefault: true })
    expect(JSON.stringify(res.body)).not.toMatch(/cardToken|Ciphertext/i)

    const linha = await prisma.paymentMethod.findUniqueOrThrow({ where: { id: res.body.id } })
    expect(linha).toMatchObject({ brand: 'Master', last4: '4242', expiryMonth: 12, expiryYear: 2031, active: true })
    expect(linha.cieloCardTokenCiphertext).toBeTruthy()
  })

  it('compatível com a página anterior: só cardToken + brand, consulta sem dados -> 201 com last4/validade nulos (não quebra)', async () => {
    consultaSemDados()
    const m = await novoMotorista('legado')
    const res = await cadastrar(m, {})
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toMatchObject({ last4: null, expiryMonth: null, expiryYear: null })
  })

  it('quando a Cielo devolve dados, os dela prevalecem sobre os enviados pela página', async () => {
    vi.spyOn(FakeAdapter.prototype, 'consultarCartaoTokenizado').mockImplementation(async (cardToken: string) => ({ cardToken, brand: 'Elo', last4: '1111', holderName: 'FULANO', expiryMonth: 1, expiryYear: 2032 }))
    const m = await novoMotorista('cielo')
    const res = await cadastrar(m, { brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2031 })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toMatchObject({ brand: 'Elo', last4: '1111', expiryMonth: 1, expiryYear: 2032 })
  })

  it('a consulta enriquece só o que falta: sem validade na Cielo, vale a enviada', async () => {
    vi.spyOn(FakeAdapter.prototype, 'consultarCartaoTokenizado').mockImplementation(async (cardToken: string) => ({ cardToken, ...SEM_DADOS, last4: '9999' }))
    const m = await novoMotorista('parcial')
    const res = await cadastrar(m, { last4: '4242', expiryMonth: 6, expiryYear: 2030 })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ last4: '9999', expiryMonth: 6, expiryYear: 2030 })
  })

  describe('validação Zod dos campos novos (sem PAN, sem CVV no backend)', () => {
    it.each([
      ['last4 com 3 dígitos', { last4: '424' }],
      ['last4 com 5 dígitos', { last4: '42424' }],
      ['last4 com letras', { last4: '42ab' }],
      ['PAN INTEIRO no last4 (nunca é truncado em silêncio: é recusado)', { last4: '4242424242424242' }],
      ['mês 0', { expiryMonth: 0, expiryYear: 2030 }],
      ['mês 13', { expiryMonth: 13, expiryYear: 2030 }],
      ['mês fracionário', { expiryMonth: 1.5, expiryYear: 2030 }],
      ['ano com 2 dígitos (a página normaliza para AAAA)', { expiryMonth: 12, expiryYear: 31 }],
      ['mês sem ano', { expiryMonth: 12 }],
      ['ano sem mês', { expiryYear: 2030 }],
      ['mês como texto', { expiryMonth: '12', expiryYear: 2030 }],
    ])('%s -> 400 e nada é gravado', async (_nome, extra) => {
      const m = await novoMotorista(`inv-${randomUUID().slice(0, 6)}`)
      const res = await cadastrar(m, extra)
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(await prisma.paymentMethod.count({ where: { userId: m.id } })).toBe(0)
    })

    it('S-1: PAN em qualquer formato e texto livre são recusados (400) e nada é gravado; o token do SOP SIMULADO estruturado é aceito COM o FakeAdapter', async () => {
      consultaSemDados()
      const m = await novoMotorista('s1')
      for (const ruim of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', 'qualquer-texto', 'tok-123']) {
        const res = await request(app).post('/api/me/payment-methods').set(m.auth).send({ cardToken: ruim, brand: 'Visa' })
        expect(res.status, ruim).toBe(400)
      }
      expect(await prisma.paymentMethod.count({ where: { userId: m.id } })).toBe(0)
      const mock = await request(app).post('/api/me/payment-methods').set(m.auth).send({ cardToken: 'mocktok.4242.122030.Rm9vIEJhcg==.17910000000001', brand: 'Visa' })
      expect(mock.status, JSON.stringify(mock.body)).toBe(201)
    })

    it('S-5: a sessão de tokenização (AccessToken do SOP) nunca é cacheável', async () => {
      const m = await novoMotorista('s5')
      const res = await request(app).post('/api/me/payment-methods/tokenization-session').set(m.auth)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('cardToken gigante (> 256) é recusado', async () => {
      const m = await novoMotorista('tokgrande')
      const res = await request(app).post('/api/me/payment-methods').set(m.auth).send({ cardToken: 'x'.repeat(257), brand: 'Visa' })
      expect(res.status).toBe(400)
    })

    it('campos de PAN/CVV que alguém mande a mais NÃO chegam ao banco (o schema só repassa os campos conhecidos)', async () => {
      consultaSemDados()
      const m = await novoMotorista('lixo')
      const res = await cadastrar(m, { last4: '4242', cardNumber: '4242424242424242', securityCode: '123' })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const linha = await prisma.paymentMethod.findUniqueOrThrow({ where: { id: res.body.id } })
      expect(JSON.stringify(linha)).not.toContain('4242424242424242')
      expect(JSON.stringify(res.body)).not.toContain('4242424242424242')
    })
  })
})
