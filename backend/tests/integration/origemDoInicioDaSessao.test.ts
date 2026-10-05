import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

// O gateway OCPP real não existe aqui: só o ENVIO do comando é trocado (aceito na hora). Rota, serviço, Redis, handler de StartTransaction e Postgres são os reais.
const sendCommandMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/ocpp/commands', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/ocpp/commands')>()), sendCommand: sendCommandMock }))

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { handleStartTransaction } from '../../src/ocpp/handlers/startTransaction'
import { aplicarOrigemDoInicio, guardarOrigemDoInicio } from '../../src/services/sessao/origemDoInicio'
import { normalizarOrigemDoInicio } from '../../src/core/sessao/origemDoInicio'
import { callHandler } from './helpers/cartaoSessaoFixture'
import { createTenant, createUser, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * L1.8, item 5 — `startIp`/`startUserAgent` da `ChargingSession`: gravados quando a sessão é iniciada pelo APP (`POST /api/me/sessions/start`), truncados nas medidas das colunas
 * (IP 64, User-Agent 512), e NUNCA derrubam o início da sessão. A sessão só nasce no StartTransaction do carregador, então o dado viaja por um Redis de vida curta (ver origemDoInicio.ts).
 */
describe('origem do início da sessão pelo app (startIp / startUserAgent)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const ctxDe = (t: Awaited<ReturnType<typeof cenario>>['tenant']) => ({ chargePointId: t.chargePointId, operatorId: t.operatorId, ocppIdentity: t.ocppIdentity })

  beforeEach(() => {
    sendCommandMock.mockReset()
    sendCommandMock.mockResolvedValue({ status: 'Accepted' })
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function cenario(label: string) {
    const tenant = await createTenant({ suffix, label })
    await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { active: true, lastSeenAt: new Date() } })
    await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
    const driver = await createUser({ role: 'DRIVER', label: `driver-${label}`, suffix })
    const admin = await createUser({ role: 'ADMIN', label: `admin-${label}`, suffix })
    const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'TOPUP_PIX', amountCents: 5000, balanceAfterCents: 5000, createdAt: new Date(Date.now() - 5000) } })
    return { tenant, driver, admin }
  }

  /** O app inicia (202), o carregador devolve o StartTransaction com o idTag virtual -> sessão. */
  async function iniciarPeloApp(c: Awaited<ReturnType<typeof cenario>>, cabecalhos: Record<string, string> = {}) {
    const res = await request(app).post('/api/me/sessions/start').set(auth(c.driver.token)).set(cabecalhos).send({ ocppIdentity: c.tenant.ocppIdentity, connectorId: 1, payment: { mode: 'WALLET' } })
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    const token = await prisma.authToken.findFirstOrThrow({ where: { userId: c.driver.id, type: 'VIRTUAL' }, orderBy: { createdAt: 'desc' } })
    return { res, token }
  }
  const startTransaction = (c: Awaited<ReturnType<typeof cenario>>, idTag: string) =>
    callHandler(handleStartTransaction, ctxDe(c.tenant), { connectorId: 1, idTag, meterStart: 100, timestamp: new Date().toISOString() })
  const sessaoDe = (userId: string) => prisma.chargingSession.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } })

  it('o app inicia -> a sessão grava IP (respeitando trust proxy) e User-Agent; a chave do Redis é apagada depois', async () => {
    const c = await cenario('o-ok')
    const { token } = await iniciarPeloApp(c, { 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'InnoFlowPWA/1.0 (Android 14)' })
    const iniciado = await startTransaction(c, token.idTag)
    expect(iniciado.idTagInfo.status).toBe('Accepted')

    const sessao = await waitFor(async () => {
      const s = await sessaoDe(c.driver.id)
      return s.startIp ? s : null
    })
    expect(sessao).toMatchObject({ startIp: '203.0.113.9', startUserAgent: 'InnoFlowPWA/1.0 (Android 14)' })
    expect(await redis.get(`session-origin:${token.idTag}`)).toBeNull()
  })

  it('User-Agent GIGANTE é truncado em 512 e o início NÃO falha (o INSERT/UPDATE nunca estoura por um campo de prova)', async () => {
    const c = await cenario('o-ua')
    const { token } = await iniciarPeloApp(c, { 'X-Forwarded-For': '203.0.113.10', 'User-Agent': `Mozilla/5.0 ${'x'.repeat(5000)}` })
    expect((await startTransaction(c, token.idTag)).idTagInfo.status).toBe('Accepted')
    const sessao = await waitFor(async () => {
      const s = await sessaoDe(c.driver.id)
      return s.startUserAgent ? s : null
    })
    expect(sessao.startUserAgent).toHaveLength(512)
    expect(sessao.startUserAgent!.startsWith('Mozilla/5.0 xxx')).toBe(true)
  })

  it('o remote-start do ADMIN (suporte) NÃO grava origem: sessão do suporte fica com startIp/startUserAgent nulos', async () => {
    const c = await cenario('o-admin')
    const res = await request(app)
      .post(`/api/admin/charge-points/${c.tenant.chargePointId}/commands/remote-start`)
      .set(auth(c.admin.token))
      .set({ 'X-Forwarded-For': '198.51.100.7', 'User-Agent': 'painel-admin' })
      .send({ connectorId: 1, userId: c.driver.id, reason: 'Cliente sem o app, recarga assistida pelo suporte' })
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    const token = await prisma.authToken.findFirstOrThrow({ where: { userId: c.driver.id, type: 'VIRTUAL' }, orderBy: { createdAt: 'desc' } })
    expect(await redis.get(`session-origin:${token.idTag}`)).toBeNull() // nada foi guardado
    expect((await startTransaction(c, token.idTag)).idTagInfo.status).toBe('Accepted')
    await new Promise((r) => setTimeout(r, 300))
    const sessao = await sessaoDe(c.driver.id)
    expect(sessao.startIp).toBeNull()
    expect(sessao.startUserAgent).toBeNull()
  })

  it('Redis RECUSA guardar a origem -> o start do app responde 202 do mesmo jeito e a sessão abre (sem origem)', async () => {
    const c = await cenario('o-redis-set')
    const original = redis.set.bind(redis)
    vi.spyOn(redis, 'set').mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('session-origin:')) return Promise.reject(new Error('Redis fora (simulado)'))
      return (original as (...a: unknown[]) => unknown)(...args)
    }) as never)
    const { token } = await iniciarPeloApp(c, { 'X-Forwarded-For': '203.0.113.11', 'User-Agent': 'x' })
    vi.restoreAllMocks()
    expect((await startTransaction(c, token.idTag)).idTagInfo.status).toBe('Accepted')
    await new Promise((r) => setTimeout(r, 300))
    expect((await sessaoDe(c.driver.id)).startIp).toBeNull()
  })

  it('Redis TRAVADO (sem resposta) ao guardar: o prazo curto corta e o start não espera (e não lança)', async () => {
    const c = await cenario('o-redis-lento')
    const original = redis.set.bind(redis)
    vi.spyOn(redis, 'set').mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('session-origin:')) return new Promise(() => {}) // nunca responde
      return (original as (...a: unknown[]) => unknown)(...args)
    }) as never)
    const t0 = Date.now()
    await iniciarPeloApp(c, { 'X-Forwarded-For': '203.0.113.12', 'User-Agent': 'x' })
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('falha ao LER/GRAVAR a origem no StartTransaction NUNCA derruba o início: a sessão abre e a resposta ao carregador é Accepted', async () => {
    const c = await cenario('o-falha-aplicar')
    const { token } = await iniciarPeloApp(c, { 'X-Forwarded-For': '203.0.113.13', 'User-Agent': 'x' })
    vi.spyOn(redis, 'get').mockImplementation((() => Promise.reject(new Error('Redis caiu na leitura (simulado)'))) as never)
    const iniciado = await startTransaction(c, token.idTag)
    vi.restoreAllMocks()
    expect(iniciado.idTagInfo.status).toBe('Accepted')
    expect(iniciado.transactionId).toBeGreaterThan(0)
    expect((await sessaoDe(c.driver.id)).status).toBe('STARTED')
  })

  it('Redis TRAVADO na leitura: o StartTransaction NÃO espera pela origem (resposta ao carregador em menos de 250 ms; a gravação é em segundo plano)', async () => {
    const c = await cenario('o-nao-bloqueia')
    const { token } = await iniciarPeloApp(c, { 'X-Forwarded-For': '203.0.113.14', 'User-Agent': 'x' })
    const original = redis.get.bind(redis)
    vi.spyOn(redis, 'get').mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('session-origin:')) return new Promise(() => {}) // nunca responde
      return (original as (...a: unknown[]) => unknown)(...args)
    }) as never)
    const t0 = Date.now()
    const iniciado = await startTransaction(c, token.idTag)
    const gastou = Date.now() - t0
    vi.restoreAllMocks()
    expect(iniciado.idTagInfo.status).toBe('Accepted')
    expect(gastou).toBeLessThan(250)
  })

  it('aplicarOrigemDoInicio: sem chave -> false e nada muda; valor corrompido/enorme no Redis é re-normalizado (nunca estoura a coluna); nunca lança com banco fora', async () => {
    const c = await cenario('o-aplicar')
    const { token } = await iniciarPeloApp(c) // sem User-Agent/IP úteis? (supertest manda IP de loopback) — a chave existe
    const sessao = await startTransaction(c, token.idTag)
    await new Promise((r) => setTimeout(r, 300))
    const s = await sessaoDe(c.driver.id)
    expect(sessao.idTagInfo.status).toBe('Accepted')

    expect(await aplicarOrigemDoInicio(s.id, 'idtag-sem-chave')).toBe(false)
    await redis.set('session-origin:idtag-lixo', 'isto não é JSON', 'EX', 60)
    expect(await aplicarOrigemDoInicio(s.id, 'idtag-lixo')).toBe(false)
    await redis.set('session-origin:idtag-enorme', JSON.stringify({ ip: `1.2.3.4${'9'.repeat(200)}`, userAgent: 'u'.repeat(9000) }), 'EX', 60)
    expect(await aplicarOrigemDoInicio(s.id, 'idtag-enorme')).toBe(true)
    const depois = await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.id } })
    expect(depois.startIp).toHaveLength(64)
    expect(depois.startUserAgent).toHaveLength(512)
    expect(await aplicarOrigemDoInicio('sessao-que-nao-existe', 'idtag-enorme')).toBe(false) // update falha -> engole
  })

  it('guardarOrigemDoInicio: sem IP e sem User-Agent não guarda nada; a chave tem TTL (o dado pessoal não fica no Redis)', async () => {
    await guardarOrigemDoInicio('idtag-vazia', { ip: '', userAgent: undefined })
    expect(await redis.get('session-origin:idtag-vazia')).toBeNull()
    await guardarOrigemDoInicio('idtag-com-ttl', { ip: '203.0.113.20', userAgent: 'ua' })
    const ttl = await redis.ttl('session-origin:idtag-com-ttl')
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(900)
    await redis.del('session-origin:idtag-com-ttl')
  })

  it('normalizarOrigemDoInicio (puro): trunca 64/512, tira caracteres de controle e vazio vira null', () => {
    expect(normalizarOrigemDoInicio({ ip: ' 203.0.113.9 ', userAgent: 'ua\r\nInjetado: x' })).toEqual({ ip: '203.0.113.9', userAgent: 'uaInjetado: x' })
    expect(normalizarOrigemDoInicio({ ip: 'a'.repeat(100), userAgent: 'b'.repeat(900) })).toEqual({ ip: 'a'.repeat(64), userAgent: 'b'.repeat(512) })
    expect(normalizarOrigemDoInicio({ ip: '', userAgent: '   ' })).toBeNull()
    expect(normalizarOrigemDoInicio({ ip: 123, userAgent: null })).toBeNull()
    expect(normalizarOrigemDoInicio({ ip: '2001:db8::1', userAgent: undefined })).toEqual({ ip: '2001:db8::1', userAgent: null })
  })
})
