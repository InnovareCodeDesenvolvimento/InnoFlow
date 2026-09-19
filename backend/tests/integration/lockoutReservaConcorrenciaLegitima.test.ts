import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { randomInt } from 'node:crypto'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import WebSocket from 'ws'

// O IP do handshake sai do X-Forwarded-For só com OCPP_TRUST_PROXY_HOPS >= 1 (ver ocppAuthLockoutRedis.test.ts).
vi.hoisted(() => {
  process.env.OCPP_TRUST_PROXY_HOPS = '1'
})

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { startOcppServer } from '../../src/ocpp/server'
import { createTenant, uniqueSuffix } from './helpers/fixtures'

/**
 * Verificação INDEPENDENTE da reserva atômica (Íris, 2026-09-19, revisão das correções do Vega).
 *
 * 1) `loginRateLimit` (por IP, express-rate-limit): o Vega afirma que NÃO tinha o furo do check-then-act
 *    (incrementa na ENTRADA e devolve no sucesso). Aqui: rajada MAIOR e com números diferentes dos dele.
 *
 * 2) Efeito colateral da reserva-antes-de-avaliar: cada tentativa EM ANDAMENTO ocupa uma vaga do global
 *    do IP (30). Antes, o sucesso nunca contava (só falhas). Agora, N handshakes LEGÍTIMOS simultâneos
 *    do mesmo IP (um site com muitos carregadores atrás de um NAT, voltando juntos depois de um
 *    restart do gateway) competem pelas mesmas 30 vagas enquanto o bcrypt de cada um roda.
 *    O hash usa custo 12 (o de produção: `BCRYPT_ROUNDS`), senão o bcrypt de custo 4 é tão curto que
 *    as tentativas nem se sobrepõem e o teste não mede nada.
 */

const SEGREDO = 'segredo-do-carregador-teste-01'
const MAX_IP = 30
const suffix = uniqueSuffix()
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

let port = 0
let server: Awaited<ReturnType<typeof startOcppServer>>
let tenant: Awaited<ReturnType<typeof createTenant>>

function handshake(identity: string, password: string, ip: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${encodeURIComponent(identity)}`, ['ocpp1.6'], {
      headers: { Authorization: `Basic ${Buffer.from(`${identity}:${password}`).toString('base64')}`, 'X-Forwarded-For': ip },
      handshakeTimeout: 60_000,
    })
    ws.once('open', () => {
      ws.once('close', () => resolve(101))
      ws.close()
    })
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    ws.once('error', reject)
  })
}

beforeAll(async () => {
  tenant = await createTenant({ suffix, label: 'reserva-legit', withCharger: false })
  port = await freePort()
  server = await startOcppServer(port)
}, 30_000)

afterAll(async () => {
  await server?.close({ awaitPending: false }).catch(() => {})
  for (const ip of usedIps) {
    const keys = await redis.keys(`ocpp:auth:fail:*${ip}`)
    if (keys.length > 0) await redis.del(...keys)
  }
  redis.disconnect()
})

describe('loginRateLimit (por IP) sob rajada — confirma ou refuta o "não tinha o furo" do Vega', () => {
  const app = createApp()

  it('60 senhas erradas EM PARALELO do mesmo IP, 60 e-mails diferentes: EXATAMENTE 20 chegam ao bcrypt (401) e 40 são barradas (429 RATE_LIMITED_AUTH)', async () => {
    const ip = freshIp()
    const N = 60
    const respostas = await Promise.all(
      Array.from({ length: N }, (_, i) => request(app).post('/api/auth/login').set('X-Forwarded-For', `${ip}, 10.0.0.1`).send({ email: `iris-rajada-${i}-${suffix}@example.com`, password: 'errada' })),
    )
    expect(respostas.filter((r) => r.status === 401)).toHaveLength(20)
    const barradas = respostas.filter((r) => r.status === 429)
    expect(barradas).toHaveLength(N - 20)
    for (const r of barradas) expect(r.body.code).toBe('RATE_LIMITED_AUTH')
  }, 60_000)

  it('o balde é POR IP: outro IP, na mesma hora, não é afetado pela rajada acima', async () => {
    const atacante = freshIp()
    const legitimo = freshIp()
    await Promise.all(Array.from({ length: 30 }, (_, i) => request(app).post('/api/auth/login').set('X-Forwarded-For', `${atacante}, 10.0.0.1`).send({ email: `iris-ip-${i}-${suffix}@example.com`, password: 'errada' })))
    const outro = await request(app).post('/api/auth/login').set('X-Forwarded-For', `${legitimo}, 10.0.0.1`).send({ email: `iris-ip-x-${suffix}@example.com`, password: 'errada' })
    expect(outro.status).toBe(401) // avaliado (não 429)
  }, 60_000)
})

describe('handshakes LEGÍTIMOS simultâneos do mesmo IP (site com muitos carregadores atrás de um NAT)', () => {
  /** Um hash de custo 12 (produção) reaproveitado por todos os carregadores: o custo é o da comparação, não o do cadastro. */
  let hash12 = ''
  beforeAll(async () => {
    hash12 = await bcrypt.hash(SEGREDO, 12)
  }, 60_000)

  async function carregadoresDoSite(qtd: number, label: string): Promise<string[]> {
    const identities = Array.from({ length: qtd }, (_, i) => `cp-site-${label}-${i}-${suffix}`)
    await prisma.chargePoint.createMany({ data: identities.map((ocppIdentity) => ({ operatorId: tenant.operatorId, siteId: tenant.siteId, ocppIdentity, basicAuthSecretHash: hash12 })) })
    return identities
  }

  it('25 carregadores legítimos do MESMO IP conectando ao mesmo tempo (abaixo do limite de 30): todos entram e o IP não fica com falha nenhuma', async () => {
    const ids = await carregadoresDoSite(25, 'a')
    const ip = freshIp()
    const t0 = Date.now()
    const status = await Promise.all(ids.map((id) => handshake(id, SEGREDO, ip)))
    console.log(`[medicao] 25 handshakes legitimos simultaneos (bcrypt custo 12): ${Date.now() - t0}ms; status=${JSON.stringify(status.reduce<Record<number, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {}))}`)
    expect(status.every((s) => s === 101)).toBe(true)
    expect(await redis.keys(`ocpp:auth:fail:*${ip}`)).toEqual([]) // o sucesso devolveu a vaga do IP e zerou o par: nada sobra
  }, 120_000)

  /**
   * ACHADO (Íris, 2026-09-19 — NÃO corrigido aqui, é código de produção): a reserva conta a tentativa EM
   * ANDAMENTO no global do IP (limite 30) e só a devolve DEPOIS do bcrypt. Um site com mais de 30
   * carregadores atrás do mesmo IP que reconectam JUNTOS (restart/deploy do gateway) tem os excedentes
   * barrados com 429 — carregadores com a credencial CERTA, sem nenhuma falha. Antes da correção o sucesso
   * nunca contava e isso não acontecia. O carregador barrado se recupera sozinho no backoff do OCPP-J, mas
   * o comportamento contradiz a regra escrita no cabeçalho de `authRateLimiter.ts` ("o sucesso não conta
   * como falha"). `it.fails` = comportamento DESEJADO; vire `it` ao corrigir (ex.: teto de tentativas em
   * andamento separado do teto de falhas, ou só as FALHAS contarem no global e a reserva ser por par).
   */
  it.fails('40 carregadores legítimos do MESMO IP conectando ao mesmo tempo (acima das 30 vagas do IP): todos entram (ACHADO: os excedentes levam 429 mesmo com a senha certa)', async () => {
    const ids = await carregadoresDoSite(40, 'b')
    const ip = freshIp()
    const status = await Promise.all(ids.map((id) => handshake(id, SEGREDO, ip)))
    const contagem = status.reduce<Record<number, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {})
    console.log(`[medicao] 40 handshakes legitimos simultaneos do mesmo IP (limite ${MAX_IP}): ${JSON.stringify(contagem)}`)
    expect(status.every((s) => s === 101)).toBe(true)
  }, 180_000)
})
