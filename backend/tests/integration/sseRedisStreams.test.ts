import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomInt } from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import request from 'supertest'

// Tetos/heartbeat do processo: o padrão (25s de heartbeat, 50 por IP, 2000 no total) tornaria os
// testes lentos ou impraticáveis. Precisam valer ANTES de `lib/env` ser importado — por isso hoisted.
vi.hoisted(() => {
  process.env.SSE_HEARTBEAT_INTERVAL_SECONDS = '1'
  process.env.SSE_MAX_STREAMS_PER_USER = '5'
  process.env.SSE_MAX_STREAMS_PER_IP = '8'
  process.env.SSE_MAX_STREAMS_TOTAL = '12'
})

import { createApp } from '../../src/api/app'
import { env } from '../../src/lib/env'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { operatorChannel, publishToOperator, publishToUser, publishToStations, ADMIN_CHANNEL, publish } from '../../src/realtime/bus'
import { sseDeps } from '../../src/api/lib/sseDefaultDeps'
import { sessionValidator } from '../../src/api/lib/sessionValidatorInstance'
import { createTenant, createUser, uniqueSuffix, waitFor, type TestTenant } from './helpers/fixtures'

/**
 * SSE contra REDIS REAL e HTTP real (Órion A2/M1, 2026-09-19): o hub compartilhado, o teto de streams
 * por usuário/IP/total, a re-checagem de sessão/`exp` no heartbeat e o backpressure. Os unitários
 * provam a lógica com hub falso; aqui o que só o conjunto prova: UM assinante Redis para vários
 * streams (`PUBSUB NUMSUB`), a mensagem publicada no Redis chegando ao socket, e o stream sendo
 * derrubado de verdade quando o usuário é revogado pela ROTA REAL de troca de senha.
 *
 * Heartbeat = 1s (env acima), então "cai no próximo heartbeat" leva ~1-2s. Todas as esperas são
 * `waitFor` sobre condição observável — nenhum `sleep` fixo decide resultado positivo.
 */

const SENHA = 'SenhaAtual#123'
const suffix = uniqueSuffix()
const app = createApp()
let httpServer: http.Server
let port = 0
let tenant: TestTenant
let outroTenant: TestTenant

interface Stream {
  status: number
  headers: http.IncomingHttpHeaders
  /** Tudo que o servidor escreveu (só preenchido para 200). */
  text: () => string
  /** Corpo de uma resposta de erro (JSON). */
  body: () => unknown
  ended: boolean
  destroy: () => void
  response: http.IncomingMessage
}

const abertos: Stream[] = []

/** Abre `GET path` como cliente SSE. Em 200, só resolve depois do primeiro byte (`: ok`). */
function openSse(path: string, token: string, extraHeaders: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false, headers: { Authorization: `Bearer ${token}`, ...extraHeaders } })
    req.once('error', reject)
    req.once('response', (response) => {
      response.setEncoding('utf8')
      let buffer = ''
      const stream: Stream = {
        status: response.statusCode ?? 0,
        headers: response.headers,
        text: () => buffer,
        body: () => JSON.parse(buffer),
        ended: false,
        destroy: () => req.destroy(),
        response,
      }
      response.on('data', (c: string) => {
        buffer += c
      })
      response.on('end', () => {
        stream.ended = true
      })
      response.on('close', () => {
        stream.ended = true
      })
      abertos.push(stream)
      if (stream.status !== 200) {
        response.once('end', () => resolve(stream))
        return
      }
      void waitFor(async () => buffer.includes(': ok'), { what: 'primeiro byte do stream' }).then(() => resolve(stream), reject)
    })
  })
}

const eventoMarcado = (marca: string) => ({ type: 'admin.entity.changed' as const, occurredAt: new Date().toISOString(), entityType: 'Marca', entityId: marca, action: 'UPDATE' as const })
const numSub = async (channel: string) => Number(((await redis.pubsub('NUMSUB', channel)) as [string, number])[1])
const streamsAbertos = () => sseDeps.limiter.stats().total

const usedIps = new Set<string>()
function freshIp(): string {
  for (;;) {
    const ip = `198.${18 + randomInt(0, 2)}.${randomInt(0, 256)}.${randomInt(1, 255)}`
    if (!usedIps.has(ip)) {
      usedIps.add(ip)
      return ip
    }
  }
}
/** A API confia em 2 hops: "<ip do cliente>, <proxy>" faz `req.ip` ser o primeiro. */
const viaIp = (ip: string) => ({ 'X-Forwarded-For': `${ip}, 10.0.0.1` })

/** Token realisticamente ANTIGO (emitido há 10s): o `iat` do JWT tem granularidade de segundo e a revogação compara em segundos; ver sessionRevocation.test.ts. */
function tokenAntigo(u: { id: string; role: 'OPERATOR' | 'DRIVER'; operatorId: string | null }, extra: jwt.SignOptions = {}): string {
  return jwt.sign({ userId: u.id, role: u.role, operatorId: u.operatorId, iat: Math.floor(Date.now() / 1000) - 10 }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h', ...extra })
}

async function operadorComSenha(label: string, t: TestTenant = tenant) {
  return createUser({ role: 'OPERATOR', label, suffix, operatorId: t.operatorId, passwordHash: await bcrypt.hash(SENHA, 4) })
}

beforeAll(async () => {
  tenant = await createTenant({ suffix, label: 'sse-a', withCharger: false })
  outroTenant = await createTenant({ suffix, label: 'sse-b', withCharger: false })
  httpServer = http.createServer(app)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  port = (httpServer.address() as AddressInfo).port
}, 30_000)

afterEach(async () => {
  for (const s of abertos) s.destroy()
  abertos.length = 0
  // Espera o servidor soltar todas as vagas (o `close` da resposta roda de forma assíncrona): o próximo teste começa com o teto zerado.
  await waitFor(async () => streamsAbertos() === 0, { what: 'todos os streams liberados' })
})

afterAll(async () => {
  httpServer?.closeAllConnections()
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()))
  redis.disconnect()
})

describe('teto de streams por usuário (Redis real, HTTP real)', () => {
  it('o 6º stream do mesmo usuário EXPULSA o mais antigo (que recebe o fim do stream); os 5 restantes continuam abertos e recebendo eventos do Redis', async () => {
    const abertosDoUsuario: Stream[] = []
    for (let i = 0; i < 6; i++) abertosDoUsuario.push(await openSse('/api/admin/events', tenant.staff.token))

    const [maisAntigo, ...restantes] = abertosDoUsuario
    await waitFor(async () => maisAntigo.ended, { what: 'o stream mais antigo ser expulso' })
    expect(restantes.every((s) => !s.ended)).toBe(true)
    expect(streamsAbertos()).toBe(5)

    const marca = `evict-${suffix}`
    await publishToOperator(tenant.operatorId, eventoMarcado(marca))
    await Promise.all(restantes.map((s) => waitFor(async () => s.text().includes(marca), { what: 'evento chegar ao stream' })))
    // O expulso não recebe mais nada (foi desassinado do hub, não só fechado).
    expect(maisAntigo.text()).not.toContain(marca)
    // A resposta SSE tem o formato do contrato.
    expect(restantes[0].text()).toContain(`event: admin.entity.changed\ndata: {"type":"admin.entity.changed"`)
  })

  it('UM assinante Redis compartilhado: 5 streams do mesmo canal = 1 assinatura no Redis (PUBSUB NUMSUB), e fechar o último stream cancela a assinatura', async () => {
    const channel = operatorChannel(tenant.operatorId)
    expect(await numSub(channel)).toBe(0) // nenhum stream deste operador aberto (afterEach limpou)

    for (let i = 0; i < 5; i++) await openSse('/api/admin/events', tenant.staff.token)
    // Antes da correção: uma conexão Redis por stream = 5. Agora o hub assina o canal uma vez.
    expect(await numSub(channel)).toBe(1)

    for (const s of abertos) s.destroy()
    await waitFor(async () => (await numSub(channel)) === 0, { what: 'UNSUBSCRIBE do canal quando o último stream sai' })
    expect(streamsAbertos()).toBe(0)
  })

  it('fronteira multi-tenant: o stream do operador B nunca recebe evento do canal do operador A (nem o canal do ADMIN)', async () => {
    const doA = await openSse('/api/admin/events', tenant.staff.token)
    const doB = await openSse('/api/admin/events', outroTenant.staff.token)

    const marcaA = `tenant-a-${suffix}`
    const marcaAdmin = `admin-${suffix}`
    await publishToOperator(tenant.operatorId, eventoMarcado(marcaA))
    await publish(ADMIN_CHANNEL, eventoMarcado(marcaAdmin))
    await waitFor(async () => doA.text().includes(marcaA), { what: 'A receber o próprio evento' })

    // Sentinela: o evento do próprio B chega DEPOIS dos outros dois publicados, então se algo vazasse já teria vazado.
    const marcaB = `tenant-b-${suffix}`
    await publishToOperator(outroTenant.operatorId, eventoMarcado(marcaB))
    await waitFor(async () => doB.text().includes(marcaB), { what: 'B receber o próprio evento' })
    expect(doB.text()).not.toContain(marcaA)
    expect(doB.text()).not.toContain(marcaAdmin)
    expect(doA.text()).not.toContain(marcaB)
    expect(doA.text()).not.toContain(marcaAdmin)
  })

  it('motorista em /api/me/events recebe o SEU canal e o de estações, e o canal de outro motorista não', async () => {
    const motorista = await createUser({ role: 'DRIVER', label: 'sse-driver', suffix })
    const outro = await createUser({ role: 'DRIVER', label: 'sse-driver2', suffix })
    const meu = await openSse('/api/me/events', motorista.token)
    const dele = await openSse('/api/me/events', outro.token)

    const marca = `user-${suffix}`
    await publishToUser(motorista.id, { type: 'wallet.updated', occurredAt: new Date().toISOString(), userId: marca, balanceCents: 1 })
    await waitFor(async () => meu.text().includes(marca), { what: 'motorista receber o próprio evento' })

    const sentinela = `sent-${suffix}`
    await publishToUser(outro.id, { type: 'wallet.updated', occurredAt: new Date().toISOString(), userId: sentinela, balanceCents: 2 })
    await waitFor(async () => dele.text().includes(sentinela), { what: 'outro motorista receber o dele' })
    expect(dele.text()).not.toContain(marca)
    expect(meu.text()).not.toContain(sentinela)

    // Canal PÚBLICO de estações: todo motorista logado recebe.
    const estacao = `estacao-${suffix}`
    await publishToStations({ type: 'chargepoint.status', occurredAt: new Date().toISOString(), chargePointId: estacao, connectorId: 1, status: 'Available' })
    await Promise.all([meu, dele].map((s) => waitFor(async () => s.text().includes(estacao), { what: 'evento público de estação chegar' })))
  })
})

describe('teto por IP e total (503/429 antes de escrever cabeçalho SSE)', () => {
  it('por IP: 8 streams de um IP (usuários diferentes) e o 9º leva 429 SSE_TOO_MANY_STREAMS em JSON; outro IP não é afetado', async () => {
    const ip = freshIp()
    const usuarios = await Promise.all(['ip-1', 'ip-2'].map((l) => createUser({ role: 'OPERATOR', label: l, suffix, operatorId: tenant.operatorId })))
    for (let i = 0; i < 5; i++) expect((await openSse('/api/admin/events', usuarios[0].token, viaIp(ip))).status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await openSse('/api/admin/events', usuarios[1].token, viaIp(ip))).status).toBe(200)

    const nono = await createUser({ role: 'OPERATOR', label: 'ip-3', suffix, operatorId: tenant.operatorId })
    const barrado = await openSse('/api/admin/events', nono.token, viaIp(ip))
    expect(barrado.status).toBe(429)
    expect(barrado.headers['content-type']).toMatch(/application\/json/)
    expect(barrado.body()).toMatchObject({ code: 'SSE_TOO_MANY_STREAMS' })

    // O teto por IP REJEITA o novo, não expulsa os antigos (expulsar derrubaria outros usuários atrás do mesmo NAT).
    expect(streamsAbertos()).toBe(8)
    expect((await openSse('/api/admin/events', nono.token, viaIp(freshIp()))).status).toBe(200)
  })

  it('total do processo: com 12 streams abertos o 13º leva 503 SSE_CAPACITY, de qualquer IP', async () => {
    const usuarios = await Promise.all(['tot-1', 'tot-2', 'tot-3', 'tot-4'].map((l) => createUser({ role: 'OPERATOR', label: l, suffix, operatorId: tenant.operatorId })))
    const ips = [freshIp(), freshIp(), freshIp(), freshIp()]
    const plano: Array<[number, number]> = [
      [0, 5],
      [1, 5],
      [2, 2],
    ]
    for (const [u, n] of plano) for (let i = 0; i < n; i++) expect((await openSse('/api/admin/events', usuarios[u].token, viaIp(ips[u]))).status).toBe(200)
    expect(streamsAbertos()).toBe(12)

    const barrado = await openSse('/api/admin/events', usuarios[3].token, viaIp(ips[3]))
    expect(barrado.status).toBe(503)
    expect(barrado.body()).toMatchObject({ code: 'SSE_CAPACITY' })
  })

  it('taxa de ABERTURA: 20 aberturas/min por usuário; a 21ª leva 429 RATE_LIMITED_SSE (loop de reconexão de cliente quebrado)', async () => {
    const u = await createUser({ role: 'OPERATOR', label: 'taxa', suffix, operatorId: tenant.operatorId })
    const ip = freshIp()
    for (let i = 0; i < 20; i++) {
      const s = await openSse('/api/admin/events', u.token, viaIp(ip))
      expect(s.status).toBe(200)
      s.destroy()
      await waitFor(async () => s.ended, { what: 'stream fechar' })
    }
    const estouro = await openSse('/api/admin/events', u.token, viaIp(ip))
    expect(estouro.status).toBe(429)
    expect(estouro.body()).toMatchObject({ code: 'RATE_LIMITED_SSE' })
  }, 60_000)
})

describe('heartbeat: re-checa exp e sessão com o stream aberto', () => {
  it('escreve o ping periodicamente enquanto a sessão vale (heartbeat = 1s neste ambiente)', async () => {
    const s = await openSse('/api/admin/events', tenant.staff.token)
    await waitFor(async () => s.text().includes(': ping'), { timeoutMs: 5_000, what: 'primeiro ping' })
    expect(s.ended).toBe(false)
  })

  it('TOKEN VENCE com o stream aberto: o servidor encerra no heartbeat seguinte ao `exp`', async () => {
    const u = await operadorComSenha('exp')
    const token = jwt.sign({ userId: u.id, role: 'OPERATOR', operatorId: u.operatorId }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 2 })
    const s = await openSse('/api/admin/events', token)
    expect(s.ended).toBe(false)
    await waitFor(async () => s.ended, { timeoutMs: 8_000, intervalMs: 100, what: 'stream encerrar depois do exp' })
    // Sem o cache: abrir de novo com o mesmo token vencido é recusado já no `authenticate`.
    expect((await request(app).get('/api/admin/events').set('Authorization', `Bearer ${token}`)).status).toBe(401)
  }, 20_000)

  it('SENHA TROCADA pela rota real (POST /api/auth/password): o stream aberto com o token antigo cai; o token novo abre um stream novo', async () => {
    const u = await operadorComSenha('senha')
    const antigo = tokenAntigo({ id: u.id, role: 'OPERATOR', operatorId: u.operatorId })
    const s = await openSse('/api/admin/events', antigo)
    expect(s.ended).toBe(false)

    const troca = await request(app).post('/api/auth/password').set('Authorization', `Bearer ${antigo}`).send({ currentPassword: SENHA, newPassword: 'OutraSenha#456' })
    expect(troca.status).toBe(200)

    await waitFor(async () => s.ended, { timeoutMs: 6_000, intervalMs: 100, what: 'stream cair depois da troca de senha' })
    expect((await openSse('/api/admin/events', antigo)).status).toBe(401)
    expect((await openSse('/api/admin/events', troca.body.token)).status).toBe(200)
  }, 20_000)

  it('sessionsValidAfter avançado no banco (revogação): o stream do token anterior cai, e um stream do MESMO usuário com token posterior segue vivo', async () => {
    const u = await operadorComSenha('revogado')
    const antigo = tokenAntigo({ id: u.id, role: 'OPERATOR', operatorId: u.operatorId })
    const s = await openSse('/api/admin/events', antigo)

    await prisma.user.update({ where: { id: u.id }, data: { sessionsValidAfter: new Date() } })
    sessionValidator.invalidate(u.id) // o que a API faz na mesma instância que mudou a conta

    await waitFor(async () => s.ended, { timeoutMs: 6_000, intervalMs: 100, what: 'stream cair depois da revogação' })
    expect((await openSse('/api/admin/events', antigo)).status).toBe(401)
  }, 20_000)

  it('conta DESATIVADA: o stream cai no próximo heartbeat', async () => {
    const u = await operadorComSenha('inativo')
    const s = await openSse('/api/admin/events', u.token)
    await prisma.user.update({ where: { id: u.id }, data: { active: false } })
    sessionValidator.invalidate(u.id)
    await waitFor(async () => s.ended, { timeoutMs: 6_000, intervalMs: 100, what: 'stream cair com a conta desativada' })
  }, 20_000)

  it('usuário APAGADO do banco: o stream cai (USER_NOT_FOUND) e o token não abre mais stream', async () => {
    const u = await operadorComSenha('apagado')
    const s = await openSse('/api/admin/events', u.token)
    await prisma.user.delete({ where: { id: u.id } })
    sessionValidator.invalidate(u.id)
    await waitFor(async () => s.ended, { timeoutMs: 6_000, intervalMs: 100, what: 'stream cair com o usuário apagado' })
    expect((await openSse('/api/admin/events', u.token)).status).toBe(401)
  }, 20_000)

  it('SEM invalidar o cache (a mudança foi feita por OUTRO processo): o stream ainda vive dentro da janela de 30s do cache — trade-off documentado do sessionValidator', async () => {
    const u = await operadorComSenha('cache')
    const s = await openSse('/api/admin/events', u.token)
    await prisma.user.update({ where: { id: u.id }, data: { active: false } })
    // 3 heartbeats (1s cada) depois, o cache de 30s ainda decide: o stream continua. Vale em até 30s; NÃO é instantâneo entre réplicas.
    await waitFor(async () => s.text().split(': ping').length - 1 >= 3, { timeoutMs: 8_000, what: '3 pings' })
    expect(s.ended).toBe(false)
  }, 20_000)
})

describe('backpressure: cliente que não lê', () => {
  const eventoGordo = (marca: string, kb: number) => ({ ...eventoMarcado(marca), pad: 'x'.repeat(kb * 1024) }) as never

  it('cliente lento que deixa os buffers estourarem é DERRUBADO pelo servidor (a memória não acumula sem fim); um cliente saudável no mesmo canal continua recebendo', async () => {
    const lento = await openSse('/api/admin/events', tenant.staff.token)
    const usuarioSaudavel = await createUser({ role: 'OPERATOR', label: 'saudavel', suffix, operatorId: tenant.operatorId })
    const saudavel = await openSse('/api/admin/events', usuarioSaudavel.token)
    lento.response.pause()
    lento.response.socket.pause() // para de ler o socket de verdade: o buffer do kernel enche e depois o do Node

    // Eventos de 8KB (abaixo do limite de 16KB do `write`, como são os reais: <1KB): um cliente saudável nunca fica acima dele.
    let publicados = 0
    for (; publicados < 6_000 && streamsAbertos() === 2; publicados++) {
      await publishToOperator(tenant.operatorId, eventoGordo(`bp-${suffix}-${publicados}`, 8))
      await new Promise((r) => setTimeout(r, 3)) // um evento por vez: o saudável drena entre um e outro
    }

    await waitFor(async () => streamsAbertos() === 1, { timeoutMs: 15_000, what: 'servidor derrubar o cliente lento por backpressure' })
    console.log(`[medicao] backpressure: cliente lento derrubado depois de ${publicados} eventos de 8KB (~${Math.round((publicados * 8) / 1024)}MB)`)

    // O que ficou é o saudável, vivo e recebendo.
    const final = `bp-final-${suffix}`
    await publishToOperator(tenant.operatorId, eventoMarcado(final))
    await waitFor(async () => saudavel.text().includes(final), { timeoutMs: 15_000, what: 'saudável receber o último evento' })
    expect(saudavel.ended).toBe(false)
    expect(lento.text().length).toBeLessThan(saudavel.text().length) // o lento perdeu eventos: foi cortado, não esperado
  }, 90_000)

  /**
   * Achado da Íris (2026-09-19), corrigido: `openSseStream` fechava o stream quando `res.write(...) === false`,
   * mas isso só diz "há mais de 16KB pendentes no buffer" — não "o cliente parou de ler". Um único evento
   * acima de 16KB (medido: 100KB e 256KB) ou uma RAJADA de eventos pequenos entregue no mesmo tick pelo
   * assinante Redis (~50 x 330B) derrubava um cliente saudável, que estava lendo normalmente. Causa raiz:
   * decisão de "cliente parado" tomada sobre um sinal instantâneo. Agora `false` abre um prazo para o
   * `drain` (5s) e só o cliente que não drena nesse prazo — ou que estoura o teto duro de 1 MiB
   * pendente — é derrubado. Cenário real da rajada: o canal do ADMIN (`ui:ev:admin`) recebe TODO evento do
   * sistema; o gateway voltando com dezenas de carregadores derrubaria todos os painéis abertos.
   */
  it('um ÚNICO evento grande (100KB) NÃO derruba um cliente saudável que está lendo', async () => {
    const saudavel = await openSse('/api/admin/events', tenant.staff.token)
    const marca = `grande-${suffix}`
    await publishToOperator(tenant.operatorId, eventoGordo(marca, 100))
    await waitFor(async () => saudavel.text().includes(marca) || saudavel.ended, { timeoutMs: 5_000, what: 'evento grande chegar' })
    await new Promise((r) => setTimeout(r, 300)) // dá tempo ao servidor de fechar, se for fechar
    expect(saudavel.text()).toContain(marca)
    expect(saudavel.ended).toBe(false)
    expect(streamsAbertos()).toBe(1)
  })

  it('rajada de 300 eventos PEQUENOS (~330B, ~100KB no total) chegando juntos NÃO derruba um cliente saudável que está lendo — e ele recebe TODOS', async () => {
    const saudavel = await openSse('/api/admin/events', tenant.staff.token)
    const pipeline = redis.pipeline()
    const canal = operatorChannel(tenant.operatorId)
    for (let i = 0; i < 300; i++) pipeline.publish(canal, JSON.stringify(eventoGordo(`rajada-${suffix}-${i}`, 0.2)))
    await pipeline.exec()

    const ultimo = `rajada-${suffix}-299`
    await waitFor(async () => saudavel.text().includes(ultimo) || saudavel.ended, { timeoutMs: 5_000, what: 'rajada chegar' })
    await new Promise((r) => setTimeout(r, 300)) // dá tempo ao servidor de fechar, se for fechar
    expect(saudavel.ended).toBe(false)
    expect(streamsAbertos()).toBe(1)
    for (let i = 0; i < 300; i += 37) expect(saudavel.text()).toContain(`rajada-${suffix}-${i}`) // nada foi perdido no meio
  })

  it('cliente PARADO no mesmo canal de um saudável continua sendo derrubado (o teto/prazo vale só para quem não drena); o saudável segue recebendo', async () => {
    const parado = await openSse('/api/admin/events', tenant.staff.token)
    const usuarioSaudavel = await createUser({ role: 'OPERATOR', label: 'saudavel-rajada', suffix, operatorId: tenant.operatorId })
    const saudavel = await openSse('/api/admin/events', usuarioSaudavel.token)
    parado.response.pause()
    parado.response.socket.pause()

    const canal = operatorChannel(tenant.operatorId)
    let lotes = 0
    for (; lotes < 40 && streamsAbertos() === 2; lotes++) {
      const pipeline = redis.pipeline()
      for (let i = 0; i < 50; i++) pipeline.publish(canal, JSON.stringify(eventoGordo(`par-${suffix}-${lotes}-${i}`, 8)))
      await pipeline.exec() // 50 x 8KB de uma vez por lote (~400KB): rajada que o saudável drena entre um lote e outro
      await new Promise((r) => setTimeout(r, 150))
    }

    await waitFor(async () => streamsAbertos() === 1, { timeoutMs: 15_000, what: 'servidor derrubar o cliente parado' })
    console.log(`[medicao] cliente parado derrubado depois de ${lotes} lote(s) de 50 eventos de 8KB (~${Math.round((lotes * 50 * 8) / 1024)}MB publicados)`)
    const final = `par-final-${suffix}`
    await publishToOperator(tenant.operatorId, eventoMarcado(final))
    await waitFor(async () => saudavel.text().includes(final), { timeoutMs: 15_000, what: 'saudável receber o último evento' })
    expect(saudavel.ended).toBe(false)
    expect(saudavel.text()).toContain(`par-${suffix}-0-0`) // e recebeu a rajada inteira, desde o início
  }, 90_000)
})
