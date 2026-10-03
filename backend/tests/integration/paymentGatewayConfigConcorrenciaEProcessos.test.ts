import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * Config do gateway (F5.5) — o que a mutação da Íris (02/10/2026) mostrou que os testes do Vega NÃO seguravam:
 *  1. o `SELECT ... FOR UPDATE` do PUT: tirá-lo deixava `paymentGatewayConfig.test.ts` inteiro verde (o teste de
 *     "dois PUTs simultâneos" só confere que os dois gravaram e há 2 linhas de auditoria — cada UPDATE já trava a
 *     linha sozinho, então nada de errado aparece). O que o lock garante é o "ANTES" da auditoria (e a avaliação de
 *     readiness) ser lido sobre o resultado do PUT anterior: sem ele, vários PUTs leem o mesmo "antes" e a trilha
 *     de auditoria deixa de ser uma cadeia (A→B→C) — o histórico imutável passa a mentir sobre quem mudou o quê;
 *  2. o TTL de 10 s do cache entre processos (api x worker): só havia teste de lógica. Aqui são DOIS PROCESSOS REAIS
 *     (a API em memória no vitest grava; um filho Node, com o cache DELE, lê);
 *  3. a guarda de `PAYMENT_METHOD_DISABLED` DENTRO de `iniciarSessaoRemota` (defesa em profundidade — a rota já checa
 *     antes): tirar só a do serviço não derrubava nada.
 *
 * BANCO PRÓPRIO (singleton global; mesma razão de `paymentGatewayConfig.test.ts`).
 */

const BASE_URL = process.env.DATABASE_URL!
const NOME_BANCO = `pgw_${Math.random().toString(36).slice(2, 10)}`
const URL_BANCO = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${NOME_BANCO}$1`)

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  issueToken: typeof import('../../src/lib/jwt').issueToken
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  CACHE_TTL_MS: number
  iniciarSessaoRemota: typeof import('../../src/services/sessao/iniciarSessaoRemota').iniciarSessaoRemota
}

describe('Config do gateway (F5.5) — concorrência do PUT e consistência entre PROCESSOS (Postgres + Redis reais, banco próprio)', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let adminPrisma: PrismaClient
  let contador = 0

  beforeAll(async () => {
    adminPrisma = new PrismaClient({ datasources: { db: { url: BASE_URL } } })
    await adminPrisma.$executeRawUnsafe(`CREATE DATABASE "${NOME_BANCO}"`)
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: URL_BANCO }, stdio: 'pipe', cwd: process.cwd() })

    process.env.DATABASE_URL = URL_BANCO
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_WEBHOOK_HEADER_SECRET', 'CIELO_WEBHOOK_PATH_TOKEN', 'PUBLIC_API_BASE_URL']) delete process.env[k]

    const [appMod, prismaMod, redisMod, jwtMod, cfgMod, iniciarMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/jwt'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/sessao/iniciarSessaoRemota'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      issueToken: jwtMod.issueToken,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      CACHE_TTL_MS: cfgMod.CACHE_TTL_MS,
      iniciarSessaoRemota: iniciarMod.iniciarSessaoRemota,
    }
    app = m.createApp()
  }, 120_000)

  afterAll(async () => {
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await adminPrisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${NOME_BANCO}" WITH (FORCE)`)
    await adminPrisma.$disconnect()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.paymentGatewayConfig.deleteMany()
    m.invalidarCacheConfigGateway()
  })

  async function novoAdmin(label: string) {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    const user = await m.prisma.user.create({ data: { role: 'ADMIN', name: `${label} ${sufixo}`, email: `${label}-${sufixo}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    return { id: user.id, token: m.issueToken({ id: user.id, role: 'ADMIN', operatorId: null }) }
  }
  async function novoMotorista() {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    const user = await m.prisma.user.create({ data: { role: 'DRIVER', name: `motorista ${sufixo}`, email: `motorista-${sufixo}@example.com` } })
    return { id: user.id, token: m.issueToken({ id: user.id, role: 'DRIVER', operatorId: null }) }
  }
  const put = (u: { token: string }, body: Record<string, unknown>) => request(app).put('/api/admin/payment-gateway').set({ Authorization: `Bearer ${u.token}` }).send({ currentPassword: SENHA_ADMIN_TESTE, ...body })

  // ----------------------------------------------------------------------------------------------
  it('N PUTs simultâneos formam uma CADEIA na auditoria: o "antes" de cada um é o "depois" de outro (só o primeiro parte de vazio) — prova o FOR UPDATE', async () => {
    const N = 8
    const admins = await Promise.all(Array.from({ length: N }, (_, i) => novoAdmin(`conc${i}`)))
    const valores = admins.map((_, i) => `sop-id-${i}`)

    const respostas = await Promise.all(admins.map((a, i) => put(a, { sopClientId: valores[i] })))
    expect(respostas.map((r) => r.status)).toEqual(Array(N).fill(200))

    const final = (await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })).sopClientId
    expect(valores).toContain(final) // um dos PUTs ganhou por último — nenhum valor "inventado"

    const linhas = (await m.prisma.auditLog.findMany({ where: { actorUserId: { in: admins.map((a) => a.id) }, action: 'PAYMENT_CONFIG_CHANGE' } })).map((l) => (l.changes as Record<string, { from: string | null; to: string }>).sopClientId)
    expect(linhas).toHaveLength(N)

    const froms = linhas.map((c) => c.from)
    const tos = linhas.map((c) => c.to)
    expect(froms.filter((f) => f === null)).toHaveLength(1) // só UM PUT enxergou a config vazia; sem o lock vários leem o mesmo "antes" nulo
    expect(new Set(froms).size).toBe(N) // cada "antes" é distinto: nenhum valor foi "sobrescrito sem ser visto" por dois PUTs
    // encadeamento completo: todo "antes" não nulo é o "depois" de algum outro PUT, e só o valor final nunca é "antes" de ninguém
    const naoUsadosComoAntes = tos.filter((t) => !froms.includes(t))
    expect(naoUsadosComoAntes).toEqual([final])
  }, 60_000)

  // ----------------------------------------------------------------------------------------------
  it('defesa em profundidade: `iniciarSessaoRemota` com cartão desligado recusa (409 PAYMENT_METHOD_DISABLED) SEM depender da checagem da rota', async () => {
    const admin = await novoAdmin('flag')
    const motorista = await novoMotorista()
    expect((await put(admin, { cardEnabled: false, pixEnabled: false })).status).toBe(200)

    await expect(
      m.iniciarSessaoRemota({ chargePointId: 'cp-que-nao-existe', chargePointScope: {}, connectorId: 1, userId: motorista.id, payment: { mode: 'CARD', paymentMethodId: 'cabcdefghijklmnopqrstuvwx' } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_METHOD_DISABLED' }) // não chegou nem ao 404 do carregador
    // a carteira nunca passa pela guarda do cartão: segue até a checagem do carregador
    await expect(m.iniciarSessaoRemota({ chargePointId: 'cp-que-nao-existe', chargePointScope: {}, connectorId: 1, userId: motorista.id, payment: { mode: 'WALLET' } })).rejects.toMatchObject({ statusCode: 404, code: 'CHARGE_POINT_NOT_FOUND' })
  })

  // ----------------------------------------------------------------------------------------------
  describe('DOIS PROCESSOS REAIS (API grava, "worker" lê com o cache DELE): consistência eventual de no máximo CACHE_TTL_MS', () => {
    let leitor: ChildProcess | undefined
    let respostas: AsyncIterator<string> | undefined
    let rl: ReturnType<typeof createInterface> | undefined
    const stderr: string[] = []

    afterAll(() => {
      rl?.close()
      if (leitor && leitor.exitCode === null) leitor.kill()
    })

    async function lerNoFilho(): Promise<{ ok: boolean; source?: string; pixEnabled?: boolean; erro?: string }> {
      leitor!.stdin!.write('ler\n')
      const { value, done } = await respostas!.next()
      if (done) throw new Error(`o processo-filho encerrou sem responder. stderr:\n${stderr.join('')}`)
      return JSON.parse(value as string)
    }

    it('o filho continua vendo a config ANTIGA logo depois do PUT (cache dele), e passa a ver a NOVA em no máximo CACHE_TTL_MS — sem reiniciar nada', async () => {
      const admin = await novoAdmin('tt1')
      // Estado inicial: SEM linha (source 'env'). O filho lê agora e guarda no cache dele.
      leitor = spawn(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'tests/integration/helpers/leitorConfigGatewayProcesso.ts'], {
        env: { ...process.env, DATABASE_URL: URL_BANCO },
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      leitor.stderr!.on('data', (c: Buffer) => stderr.push(c.toString()))
      rl = createInterface({ input: leitor.stdout! })
      respostas = rl[Symbol.asyncIterator]()
      const pronto = await Promise.race([respostas.next(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`o filho não ficou pronto em 60s. stderr:\n${stderr.join('')}`)), 60_000))])
      expect(pronto.value).toBe('PRONTO')

      const antes = await lerNoFilho()
      const tCache = Date.now()
      expect(antes).toMatchObject({ ok: true, source: 'env' })

      // A API (este processo) TAMBÉM tem cache: lê antes de gravar para que a invalidação pós-PUT tenha o que invalidar (sem isto, um PUT
      // que esquecesse de invalidar o próprio cache passaria despercebido — o cache da API estaria vazio).
      expect((await request(app).get('/api/admin/payment-gateway').set({ Authorization: `Bearer ${admin.token}` })).body).toMatchObject({ source: 'env' })

      // A API (este processo) grava: a linha passa a existir e o Pix é desligado.
      const gravou = await put(admin, { pixEnabled: false, cardEnabled: false })
      expect(gravou.status).toBe(200)
      expect(gravou.body).toMatchObject({ source: 'database', pixEnabled: false })
      const tGravou = Date.now()

      // 1) A API enxerga NA HORA (invalida o próprio cache).
      expect((await request(app).get('/api/admin/payment-gateway').set({ Authorization: `Bearer ${admin.token}` })).body).toMatchObject({ source: 'database', pixEnabled: false })

      // 2) O filho, dentro da janela do TTL, ainda serve o valor velho do cache DELE. Só afirma se a janela de fato ainda está aberta
      //    (se a máquina travou por mais que o TTL entre a leitura e aqui, esta checagem não prova nada e é pulada — nunca dá falso vermelho).
      const stale = await lerNoFilho()
      if (Date.now() - tCache < m.CACHE_TTL_MS - 1_500) expect(stale).toMatchObject({ ok: true, source: 'env' })

      // 3) Convergência: dentro do TTL (+ folga) o filho enxerga o estado novo.
      let visto = stale
      const limite = tGravou + m.CACHE_TTL_MS + 5_000
      while (visto.source !== 'database' && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 250))
        visto = await lerNoFilho()
      }
      expect(visto).toMatchObject({ ok: true, source: 'database', pixEnabled: false })
      const convergiuEm = Date.now() - tGravou
      expect(convergiuEm).toBeLessThanOrEqual(m.CACHE_TTL_MS + 5_000)
    }, 90_000)
  })
})
