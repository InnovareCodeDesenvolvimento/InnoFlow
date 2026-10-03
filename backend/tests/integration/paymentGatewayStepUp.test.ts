import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * Step-up de senha no `PUT /api/admin/payment-gateway` (F5.7, M2 do portão do Órion) — ponta a ponta contra Postgres + Redis REAIS
 * (banco próprio: `PaymentGatewayConfig` é singleton global). Prova: ausente -> 400; errada/sem senha -> 403 ANTES de qualquer outra
 * regra e antes de tocar o banco; limite de tentativas ERRADAS por usuário (429, valendo até com a senha certa); a senha nunca vai
 * para resposta/log/auditoria; os alertas de log.
 */

const SENHA_ERRADA = 'SenhaErrada#Marcador-Unico-9f3a'

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  logger: typeof import('../../src/lib/logger').logger
  issueToken: typeof import('../../src/lib/jwt').issueToken
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  resetPaymentSecretsKeyCacheParaTeste: typeof import('../../src/lib/crypto/paymentSecrets').resetPaymentSecretsKeyCacheParaTeste
}

function dump(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v))
}

describe('step-up de senha no PUT do gateway (M2) — Postgres + Redis reais', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  const logsWarn: Array<Record<string, unknown>> = []
  const logsTodos: string[] = []
  const envBaseline: Record<string, unknown> = {}
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgs')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_SOP_SCRIPT_URL', 'CIELO_SOP_OAUTH_TOKEN_URL', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, loggerMod, jwtMod, cfgMod, secMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/logger'),
      import('../../src/lib/jwt'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/lib/crypto/paymentSecrets'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      env: envMod.env as unknown as Record<string, unknown>,
      logger: loggerMod.logger,
      issueToken: jwtMod.issueToken,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      resetPaymentSecretsKeyCacheParaTeste: secMod.resetPaymentSecretsKeyCacheParaTeste,
    }
    app = m.createApp()
    for (const k of ['PAYMENT_SECRETS_KEY', 'CIELO_SANDBOX']) envBaseline[k] = m.env[k]
    for (const nivel of ['info', 'warn', 'error', 'debug'] as const) {
      const original = m.logger[nivel].bind(m.logger) as (...a: unknown[]) => void
      vi.spyOn(m.logger, nivel).mockImplementation(((...args: unknown[]) => {
        logsTodos.push(dump(args))
        if (nivel === 'warn' && typeof args[0] === 'object' && args[0]) logsWarn.push(args[0] as Record<string, unknown>)
        original(...args)
      }) as never)
    }
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.paymentGatewayConfig.deleteMany()
    m.invalidarCacheConfigGateway()
    logsWarn.length = 0
    logsTodos.length = 0
  })
  afterEach(() => {
    Object.assign(m.env, envBaseline)
    m.resetPaymentSecretsKeyCacheParaTeste()
  })

  async function novoAdmin(opcoes: { semSenha?: boolean } = {}) {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    const user = await m.prisma.user.create({
      data: { role: 'ADMIN', name: `Admin ${sufixo}`, email: `admin-${sufixo}@example.com`, passwordHash: opcoes.semSenha ? null : HASH_SENHA_ADMIN_TESTE },
    })
    return { id: user.id, token: m.issueToken({ id: user.id, role: 'ADMIN', operatorId: null }) }
  }
  const putRaw = (u: { token: string }, body: Record<string, unknown>) => request(app).put('/api/admin/payment-gateway').set({ Authorization: `Bearer ${u.token}` }).send(body)
  const alertas = (nome: string) => logsWarn.filter((l) => l.alert === nome)
  const linhasAuditoria = (userId: string) => m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
  async function esperarAuditoria(userId: string, n: number) {
    const limite = Date.now() + 5000
    let l = await linhasAuditoria(userId)
    while (l.length < n && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 50))
      l = await linhasAuditoria(userId)
    }
    return l
  }

  it('senha ABSENTE => 400 VALIDATION_ERROR (mesmo com o corpo todo válido); nada gravado; não gasta tentativa', async () => {
    const admin = await novoAdmin()
    const res = await putRaw(admin, { sopClientId: 'sop-id' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(JSON.stringify(res.body.details)).toContain('currentPassword')
    expect((await putRaw(admin, { sopClientId: 'sop-id', currentPassword: '' })).status).toBe(400) // senha vazia também
    expect((await putRaw(admin, { currentPassword: SENHA_ADMIN_TESTE })).status).toBe(400) // só a senha, sem campo para alterar
    expect(await m.prisma.paymentGatewayConfig.count()).toBe(0)
    expect(alertas('payment_gateway_stepup_failed')).toHaveLength(0)
  })

  it('senha ERRADA => 403 INVALID_CURRENT_PASSWORD (403, não 401); nada gravado; alerta payment_gateway_stepup_failed só com o id; auditoria DENIED sem corpo; senha em lugar nenhum', async () => {
    const admin = await novoAdmin()
    const res = await putRaw(admin, { sopClientId: 'sop-id', currentPassword: SENHA_ERRADA })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('INVALID_CURRENT_PASSWORD')
    expect(dump(res.body)).not.toContain(SENHA_ERRADA)
    expect(await m.prisma.paymentGatewayConfig.count()).toBe(0)

    const falhas = alertas('payment_gateway_stepup_failed')
    expect(falhas).toHaveLength(1)
    expect(falhas[0]).toMatchObject({ alert: 'payment_gateway_stepup_failed', actorUserId: admin.id })
    expect(Object.keys(falhas[0]!).sort()).toEqual(['actorUserId', 'alert'])

    const [linha] = await esperarAuditoria(admin.id, 1)
    expect(linha).toMatchObject({ outcome: 'DENIED', httpStatus: 403, action: 'PAYMENT_CONFIG_CHANGE', actionDetail: 'stepup_failed', entityType: 'PaymentGatewayConfig' })
    expect(linha!.changes).toBeNull() // nem os NOMES dos campos enviados
    expect(dump(linha)).not.toContain(SENHA_ERRADA)
    expect(logsTodos.join('\n')).not.toContain(SENHA_ERRADA)
  })

  it('ORDEM DO PUT: com senha errada NENHUMA outra regra roda antes — nem confirmação de produção, nem chave de cifragem, nem prontidão, nem transação no banco', async () => {
    const admin = await novoAdmin()
    const transacao = vi.spyOn(m.prisma, '$transaction')

    // (a) sandbox -> production sem confirmProduction seria 400 PRODUCTION_CONFIRMATION_REQUIRED
    const a = await putRaw(admin, { environment: 'production', currentPassword: SENHA_ERRADA })
    // (b) segredo com PAYMENT_SECRETS_KEY ausente seria 503 PAYMENT_SECRETS_KEY_MISSING
    m.env.PAYMENT_SECRETS_KEY = undefined
    m.resetPaymentSecretsKeyCacheParaTeste()
    const b = await putRaw(admin, { merchantKey: 'segredo-x', merchantId: 'mid', currentPassword: SENHA_ERRADA })
    m.env.PAYMENT_SECRETS_KEY = envBaseline.PAYMENT_SECRETS_KEY
    m.resetPaymentSecretsKeyCacheParaTeste()
    // (c) habilitar cartão sem pré-requisito seria 409 GATEWAY_NOT_READY
    const c = await putRaw(admin, { cardEnabled: true, currentPassword: SENHA_ERRADA })

    for (const r of [a, b, c]) {
      expect(r.status, dump(r.body)).toBe(403)
      expect(r.body.code).toBe('INVALID_CURRENT_PASSWORD')
    }
    expect(transacao).not.toHaveBeenCalled() // nunca abriu a transação da config (nem a semeadura)
    expect(await m.prisma.paymentGatewayConfig.count()).toBe(0)
    transacao.mockRestore()
  })

  it('validação (400) vem ANTES da senha: corpo inválido + senha errada => 400, e não conta tentativa', async () => {
    const admin = await novoAdmin()
    for (let i = 0; i < 8; i += 1) {
      const r = await putRaw(admin, { campoInexistente: 1, currentPassword: SENHA_ERRADA })
      expect(r.status).toBe(400)
    }
    expect(alertas('payment_gateway_stepup_failed')).toHaveLength(0)
    expect((await putRaw(admin, { sopClientId: 'sop-id', currentPassword: SENHA_ADMIN_TESTE })).status).toBe(200) // não foi trancada por isso
  })

  it('conta SEM senha (passwordHash nulo) => 403 INVALID_CURRENT_PASSWORD, qualquer valor enviado', async () => {
    const admin = await novoAdmin({ semSenha: true })
    for (const tentativa of [SENHA_ADMIN_TESTE, SENHA_ERRADA, ' ', 'null']) {
      const r = await putRaw(admin, { sopClientId: 'sop-id', currentPassword: tentativa })
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('INVALID_CURRENT_PASSWORD')
    }
    expect(await m.prisma.paymentGatewayConfig.count()).toBe(0)
  })

  it('senha CERTA => 200; alerta payment_config_changed com SÓ os nomes dos campos (nunca valores); a auditoria e a resposta não têm a senha nem os segredos', async () => {
    const admin = await novoAdmin()
    const segredo = 'MKEY-stepup-segredo-unico-123'
    const res = await putRaw(admin, { merchantId: 'mid-stepup', merchantKey: segredo, currentPassword: SENHA_ADMIN_TESTE })
    expect(res.status, dump(res.body)).toBe(200)
    expect(dump(res.body)).not.toContain(SENHA_ADMIN_TESTE)
    expect(dump(res.body)).not.toContain(segredo)

    const mudou = alertas('payment_config_changed')
    expect(mudou).toHaveLength(1)
    expect(mudou[0]).toMatchObject({ alert: 'payment_config_changed', actorUserId: admin.id })
    expect([...(mudou[0]!.changedFields as string[])].sort()).toEqual(expect.arrayContaining(['merchantId', 'merchantKey']))
    expect(dump(mudou[0])).not.toContain('mid-stepup') // nome do campo sim, valor não
    expect(dump(mudou[0])).not.toContain(segredo)
    expect(alertas('payment_gateway_stepup_failed')).toHaveLength(0)

    const linhas = await esperarAuditoria(admin.id, 1)
    expect(linhas).toHaveLength(1) // só a linha fail-closed da própria config (skip no middleware genérico)
    expect(linhas[0]).toMatchObject({ outcome: 'SUCCESS', action: 'PAYMENT_CONFIG_CHANGE' })
    expect(dump(linhas)).not.toContain(SENHA_ADMIN_TESTE)
    expect(dump(linhas)).not.toContain(segredo)
    expect(logsTodos.join('\n')).not.toContain(SENHA_ADMIN_TESTE)
    expect(logsTodos.join('\n')).not.toContain(segredo)
  })

  it('LIMITE de tentativas erradas por usuário: 5 erradas (403) e a 6ª, mesmo com a senha CERTA, é 429 RATE_LIMITED_PAYMENT_GATEWAY com Retry-After — sem tocar a config', async () => {
    const admin = await novoAdmin()
    for (let i = 0; i < 5; i += 1) {
      const r = await putRaw(admin, { sopClientId: 'sop-id', currentPassword: `${SENHA_ERRADA}-${i}` })
      expect(r.status, `tentativa ${i + 1}`).toBe(403)
    }
    const trancada = await putRaw(admin, { sopClientId: 'sop-id', currentPassword: SENHA_ADMIN_TESTE })
    expect(trancada.status).toBe(429)
    expect(trancada.body.code).toBe('RATE_LIMITED_PAYMENT_GATEWAY')
    expect(Number(trancada.headers['retry-after'])).toBeGreaterThan(0)
    expect(await m.prisma.paymentGatewayConfig.count()).toBe(0)
    expect(alertas('payment_gateway_stepup_locked').length).toBeGreaterThan(0)

    const outro = await novoAdmin() // o balde é por usuário
    expect((await putRaw(outro, { sopClientId: 'sop-id', currentPassword: SENHA_ADMIN_TESTE })).status).toBe(200)
  })

  it('RAJADA paralela de senhas erradas: a reserva é ANTES do bcrypt — só 5 são avaliadas (403), o resto é 429 (nunca "todas leem 0 falhas")', async () => {
    const admin = await novoAdmin()
    const respostas = await Promise.all(Array.from({ length: 9 }, (_, i) => putRaw(admin, { sopClientId: 'sop-id', currentPassword: `${SENHA_ERRADA}-rajada-${i}` })))
    const status = respostas.map((r) => r.status)
    expect(status.filter((s) => s === 403)).toHaveLength(5)
    expect(status.filter((s) => s === 429)).toHaveLength(4)
    expect(alertas('payment_gateway_stepup_failed')).toHaveLength(5)
  })

  it('senha certa ZERA as falhas: 3 erradas + 1 certa + 3 erradas não tranca (o balde recomeçou)', async () => {
    const admin = await novoAdmin()
    for (let i = 0; i < 3; i += 1) expect((await putRaw(admin, { sopClientId: 'sop-id', currentPassword: `${SENHA_ERRADA}-a${i}` })).status).toBe(403)
    expect((await putRaw(admin, { sopClientId: 'sop-id', currentPassword: SENHA_ADMIN_TESTE })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 200)) // o registerSuccess é fire-and-forget
    for (let i = 0; i < 3; i += 1) expect((await putRaw(admin, { sopClientId: 'sop-id', currentPassword: `${SENHA_ERRADA}-b${i}` })).status).toBe(403)
    expect((await putRaw(admin, { sopClientId: 'sop-id', currentPassword: SENHA_ADMIN_TESTE })).status).toBe(200)
  })

  it('DRIVER continua 403 FORBIDDEN (o step-up só roda depois do papel) e não gasta tentativa de ninguém', async () => {
    contador += 1
    const motorista = await m.prisma.user.create({ data: { role: 'DRIVER', name: 'm', email: `m-${contador}-${Math.random().toString(36).slice(2, 7)}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    const token = m.issueToken({ id: motorista.id, role: 'DRIVER', operatorId: null })
    const r = await putRaw({ token }, { sopClientId: 'sop-id', currentPassword: SENHA_ERRADA })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('FORBIDDEN')
    expect(alertas('payment_gateway_stepup_failed')).toHaveLength(0)
  })
})
