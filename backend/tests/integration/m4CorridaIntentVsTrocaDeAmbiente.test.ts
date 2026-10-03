import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * QA da Íris (F5.8, rodada Vega-2) — a corrida RESIDUAL do M4c que o próprio Vega admite: o PUT do gateway conta os PaymentIntent vivos do
 * ambiente atual (dentro da transação, com a linha de config travada `FOR UPDATE`), mas quem CRIA o intent (Pix, pré-autorização) não toca
 * nessa linha: lê o ambiente efetivo do cache e grava. Um intent criado ENTRE a contagem do PUT e o commit escapa do bloqueio e nasce com o
 * ambiente ANTIGO, vivo, depois que o efetivo já virou.
 *
 * Forçada de verdade, sem depender de sorte de temporização: um portão (mock de `writeAuditLog`, chamado DENTRO da transação do PUT logo
 * depois da contagem) segura o PUT com a linha travada; com ele parado, uma requisição REAL de Pix cria o intent; só então o PUT é solto.
 *
 * O que fica PROVADO aqui:
 *  1) o escape acontece (200 na troca E intent vivo do ambiente antigo) — `it.fails` abaixo é o achado;
 *  2) a defesa em profundidade (d) funciona sobre o escapado: a Cielo NÃO é consultada/capturada, nada é expirado/creditado/decidido, o alerta
 *     `payment_intent_environment_mismatch` sai, e o dinheiro FICA PARADO (Pix pago e não creditado) até alguém voltar o ambiente;
 *  3) a saída existe: voltar o ambiente (o PUT de volta não é bloqueado — os vivos agora são do OUTRO ambiente) libera o crédito.
 */

const gate = vi.hoisted(() => ({
  armado: false,
  entrou: undefined as undefined | (() => void),
  liberar: undefined as undefined | Promise<void>,
}))

vi.mock('../../src/services/auditoria/writeAuditLog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/auditoria/writeAuditLog')>()
  return {
    ...real,
    writeAuditLog: async (...args: Parameters<typeof real.writeAuditLog>) => {
      if (gate.armado && args[0].action === 'PAYMENT_CONFIG_CHANGE') {
        gate.armado = false
        gate.entrou?.()
        await gate.liberar
      }
      return real.writeAuditLog(...args)
    },
  }
})

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  logger: typeof import('../../src/lib/logger').logger
  issueToken: typeof import('../../src/lib/jwt').issueToken
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  getAmbienteEfetivoParaBanco: typeof import('../../src/services/pagamentos/gatewayConfig').getAmbienteEfetivoParaBanco
  getPagamentoPort: typeof import('../../src/services/pagamentos/pagamentoPortInstance').getPagamentoPort
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  resetLogsDeAmbienteDivergenteParaTeste: typeof import('../../src/services/pagamentos/ambienteDoIntent').resetLogsDeAmbienteDivergenteParaTeste
  creditarTopupPix: typeof import('../../src/services/pagamentos/creditarTopupPix').creditarTopupPix
  varrerTopupsPixExpirados: typeof import('../../src/services/pagamentos/varrerTopupsPixExpirados').varrerTopupsPixExpirados
  FakeAdapter: typeof import('../../src/services/pagamentos/fakeAdapter').FakeAdapter
}

function dump(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v))
}

describe('M4c — corrida: intent criado entre a contagem do PUT e o commit da troca de ambiente — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let fake: InstanceType<Mods['FakeAdapter']>
  const envBaseline: Record<string, unknown> = {}
  const logsErro: Array<Record<string, unknown>> = []
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgr')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, loggerMod, jwtMod, cfgMod, portMod, ambMod, credMod, varrMod, fakeMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/logger'),
      import('../../src/lib/jwt'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('../../src/services/pagamentos/ambienteDoIntent'),
      import('../../src/services/pagamentos/creditarTopupPix'),
      import('../../src/services/pagamentos/varrerTopupsPixExpirados'),
      import('../../src/services/pagamentos/fakeAdapter'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      env: envMod.env as unknown as Record<string, unknown>,
      logger: loggerMod.logger,
      issueToken: jwtMod.issueToken,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      getAmbienteEfetivoParaBanco: cfgMod.getAmbienteEfetivoParaBanco,
      getPagamentoPort: portMod.getPagamentoPort,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      resetLogsDeAmbienteDivergenteParaTeste: ambMod.resetLogsDeAmbienteDivergenteParaTeste,
      creditarTopupPix: credMod.creditarTopupPix,
      varrerTopupsPixExpirados: varrMod.varrerTopupsPixExpirados,
      FakeAdapter: fakeMod.FakeAdapter,
    }
    app = m.createApp()
    for (const k of ['NODE_ENV', 'CIELO_SANDBOX']) envBaseline[k] = m.env[k]
    m.resetPagamentoPortCacheParaTeste()
    fake = (await m.getPagamentoPort()) as InstanceType<Mods['FakeAdapter']>
    const original = m.logger.error.bind(m.logger) as (...a: unknown[]) => void
    vi.spyOn(m.logger, 'error').mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === 'object' && args[0]) logsErro.push(args[0] as Record<string, unknown>)
      original(...args)
    }) as never)
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.paymentIntent.updateMany({ where: { status: { in: ['CREATED', 'AUTHORIZED', 'PENDING', 'CAPTURE_PENDING'] } }, data: { status: 'EXPIRED' } })
    await m.prisma.paymentGatewayConfig.deleteMany()
    await m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: 'sandbox', cardEnabled: false, pixEnabled: true } })
    m.invalidarCacheConfigGateway()
    m.resetLogsDeAmbienteDivergenteParaTeste()
    logsErro.length = 0
    gate.armado = false
  })
  afterEach(() => {
    gate.armado = false
    Object.assign(m.env, envBaseline)
    m.invalidarCacheConfigGateway()
  })

  async function novoUsuario(role: 'ADMIN' | 'DRIVER') {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    const user = await m.prisma.user.create({
      data: { role, name: `${role} ${sufixo}`, email: `${role.toLowerCase()}-${sufixo}@example.com`, passwordHash: role === 'ADMIN' ? HASH_SENHA_ADMIN_TESTE : null },
    })
    return { id: user.id, token: m.issueToken({ id: user.id, role, operatorId: null }) }
  }
  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })
  const putConfig = (u: { token: string }, body: Record<string, unknown>) => request(app).put('/api/admin/payment-gateway').set(auth(u)).send({ currentPassword: SENHA_ADMIN_TESTE, ...body })
  const alertasDeDivergencia = () => logsErro.filter((l) => l.alert === 'payment_intent_environment_mismatch')

  /**
   * Segura o PUT sandbox -> production DENTRO da transação (depois da contagem de vivos, antes do commit), cria um Pix de verdade enquanto isso e solta.
   * Devolve a resposta do PUT, a do Pix e o intent criado.
   */
  async function trocaDeAmbienteComPixCriadoNoMeio() {
    const admin = await novoUsuario('ADMIN')
    const motorista = await novoUsuario('DRIVER')
    let soltar!: () => void
    gate.liberar = new Promise<void>((resolve) => (soltar = resolve))
    const dentro = new Promise<void>((resolve) => (gate.entrou = resolve))
    gate.armado = true

    // `pixEnabled: false` junto: produção sem credencial não pode ficar com o Pix ligado (readiness) — só o ambiente está em jogo.
    const put = putConfig(admin, { environment: 'production', confirmProduction: true, pixEnabled: false }).then((r) => r)
    await Promise.race([dentro, new Promise((_, rej) => setTimeout(() => rej(new Error('o PUT nunca chegou ao portão (writeAuditLog dentro da transação)')), 15_000))])

    // o PUT está DENTRO da transação, com a contagem de vivos já feita (0) e a linha travada — a config ainda diz sandbox
    const pix = await request(app).post('/api/me/wallet/topups').set(auth(motorista)).send({ amountCents: 2000 })
    soltar()
    const resPut = await put
    m.invalidarCacheConfigGateway() // o PUT já invalidou o cache do processo; isto só explicita
    return { admin, motorista, resPut, pix }
  }

  it('FORÇADA: a troca passa (200) e o Pix criado no meio nasce SANDBOX e fica PENDING, vivo, com o ambiente efetivo já em PRODUCTION (o escape que o Vega admite)', async () => {
    const { resPut, pix } = await trocaDeAmbienteComPixCriadoNoMeio()
    expect(resPut.status, dump(resPut.body)).toBe(200)
    expect(resPut.body.environment).toBe('production')
    expect(pix.status, dump(pix.body)).toBe(201)

    const intent = await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: pix.body.id } })
    expect(await m.getAmbienteEfetivoParaBanco()).toBe('PRODUCTION')
    expect(intent.environment).toBe('SANDBOX')
    expect(intent.status).toBe('PENDING')
  })

  it('o escapado fica PROTEGIDO pela guarda (d): a Cielo não é consultada nem o intent expirado/creditado, o alerta sai e o crédito só acontece quando o ambiente volta', async () => {
    const { admin, motorista, pix } = await trocaDeAmbienteComPixCriadoNoMeio()
    const intentId = pix.body.id as string
    const intent = await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })
    fake.marcarPixComoPago(intent.cieloPaymentId!) // o motorista PAGOU o Pix de verdade

    const consultar = vi.spyOn(fake, 'consultarPix')
    expect(await m.creditarTopupPix(intentId)).toBeNull() // o worker/webhook tenta creditar: recusa sem perguntar à Cielo
    await m.prisma.paymentIntent.update({ where: { id: intentId }, data: { pixExpiresAt: new Date(Date.now() - 3600_000) } })
    await m.varrerTopupsPixExpirados(fake) // o varredor também pula: expirar seria decidir "não foi pago" sem ter perguntado
    expect(consultar).not.toHaveBeenCalled()
    consultar.mockRestore()

    const depois = await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })
    expect(depois.status).toBe('PENDING') // nada decidido
    expect(await m.prisma.walletEntry.count({ where: { referenceId: intentId } })).toBe(0) // o dinheiro está PARADO (pago e não creditado)
    const alertas = alertasDeDivergencia().filter((a) => a.paymentIntentId === intentId)
    expect(alertas.length).toBeGreaterThanOrEqual(1)
    expect(alertas[0]).toMatchObject({ intentEnvironment: 'SANDBOX', effectiveEnvironment: 'PRODUCTION' })

    // SAÍDA: voltar o ambiente NÃO é bloqueado (os vivos agora são do OUTRO ambiente) e o mesmo intent credita.
    const volta = await putConfig(admin, { environment: 'sandbox' })
    expect(volta.status, dump(volta.body)).toBe(200)
    await m.prisma.paymentIntent.update({ where: { id: intentId }, data: { pixExpiresAt: new Date(Date.now() + 3600_000) } })
    expect(await m.creditarTopupPix(intentId)).not.toBeNull()
    expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).status).toBe('PAID')
    expect(await m.prisma.walletEntry.count({ where: { referenceId: intentId } })).toBe(1)
    void motorista
  })

  // ACHADO (severidade baixa-média, NÃO corrigido por regra da rodada): depois que a troca de ambiente COMMITA não pode restar PaymentIntent vivo do
  // ambiente antigo — foi exatamente o que o bloqueio M4c prometeu. Causa raiz: a contagem de vivos roda na transação do PUT (linha de config travada),
  // mas a CRIAÇÃO do intent (`me.routes.ts` topups; `iniciarSessaoRemota.ts`) lê o ambiente do cache e grava sem tocar essa linha — não há lock
  // compartilhado entre "criar intent" e "trocar ambiente". Correção sugerida: o INSERT do intent pegar `FOR SHARE` na linha de config e conferir o
  // ambiente DENTRO da mesma transação (a troca, que pega `FOR UPDATE`, espera o intent commitar e o conta; ou o intent espera a troca e nasce no
  // ambiente novo). Se for corrigido, trocar `it.fails` por `it`.
  it.fails('ACHADO: nenhum PaymentIntent vivo do ambiente ANTIGO pode sobrar depois da troca (hoje sobra 1)', async () => {
    const { resPut } = await trocaDeAmbienteComPixCriadoNoMeio()
    expect(resPut.status).toBe(200)
    const efetivo = await m.getAmbienteEfetivoParaBanco()
    const vivosDoAmbienteAntigo = await m.prisma.paymentIntent.count({ where: { status: { in: ['CREATED', 'AUTHORIZED', 'PENDING', 'CAPTURE_PENDING'] }, NOT: { environment: efetivo } } })
    expect(vivosDoAmbienteAntigo).toBe(0)
  })
})
