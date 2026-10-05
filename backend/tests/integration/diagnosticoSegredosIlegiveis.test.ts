import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { JWT_SECRET_TROCADO } from './helpers/chaveMestra'

/**
 * MUDANÇA DELIBERADA (05/10/2026, chave dos segredos derivada do JWT_SECRET, como no InnoChat): trocar o JWT_SECRET não derruba o boot — os segredos salvos viram ilegíveis. O DIAGNÓSTICO DE BOOT do worker
 * (`verificarSegredosSalvos`) olha todos os lugares que guardam segredo cifrado e emite UM alerta `secrets_undecryptable` (CRITICO) com contagens por área e a orientação. Postgres real, banco próprio.
 */

type Mods = {
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  logger: typeof import('../../src/lib/logger').logger
  enc: typeof import('../../src/lib/crypto/paymentSecrets').encryptPaymentSecret
  verificar: typeof import('../../src/services/pagamentos/diagnosticoSegredos').verificarSegredosSalvos
  severidadeDoEvento: typeof import('../../src/core/alertas/severidade').severidadeDoEvento
  orientacoes: typeof import('../../src/core/alertas/severidade').ORIENTACAO_DOS_ALERTAS
}

const SEGREDO_SMTP = 'senha-smtp-super-secreta-diag-1'
const SEGREDO_MK = 'merchantkey-super-secreta-diag-2'
const TOKEN_CARTAO = 'token-de-cartao-super-secreto-diag-3'

describe('diagnóstico de segredos ilegíveis no boot (secrets_undecryptable) — Postgres real, banco próprio', () => {
  let m: Mods
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let jwtOriginal: unknown
  const alertas: Array<Record<string, unknown>> = []
  const tudoLogado: string[] = []

  beforeAll(async () => {
    banco = await criarBancoProprio('dsg')
    const [prismaMod, redisMod, envMod, loggerMod, secMod, diagMod, sevMod] = await Promise.all([
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/logger'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/diagnosticoSegredos'),
      import('../../src/core/alertas/severidade'),
    ])
    m = {
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      env: envMod.env as unknown as Record<string, unknown>,
      logger: loggerMod.logger,
      enc: secMod.encryptPaymentSecret,
      verificar: diagMod.verificarSegredosSalvos,
      severidadeDoEvento: sevMod.severidadeDoEvento,
      orientacoes: sevMod.ORIENTACAO_DOS_ALERTAS,
    }
    jwtOriginal = m.env.JWT_SECRET
    for (const nivel of ['info', 'warn', 'error', 'debug'] as const) {
      const original = m.logger[nivel].bind(m.logger) as (...a: unknown[]) => void
      vi.spyOn(m.logger, nivel).mockImplementation(((...args: unknown[]) => {
        tudoLogado.push(JSON.stringify(args))
        if (typeof args[0] === 'object' && args[0] && typeof (args[0] as { alert?: unknown }).alert === 'string') alertas.push(args[0] as Record<string, unknown>)
        original(...args)
      }) as never)
    }
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    m.env.JWT_SECRET = jwtOriginal
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  beforeEach(async () => {
    m.env.JWT_SECRET = jwtOriginal
    alertas.length = 0
    tudoLogado.length = 0
    await m.prisma.paymentMethod.deleteMany()
    await m.prisma.paymentGatewayConfig.deleteMany()
    await m.prisma.notificationChannelConfig.deleteMany()
    await m.prisma.$executeRawUnsafe(`DELETE FROM "BackupConfig"`)
  })

  async function popular() {
    const user = await m.prisma.user.create({ data: { role: 'DRIVER', name: 'Motorista Diag', email: `diag-${Math.random().toString(36).slice(2, 8)}@example.com` } })
    await m.prisma.paymentMethod.create({ data: { userId: user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.enc(TOKEN_CARTAO), brand: 'Visa', last4: '4242', isDefault: true, environment: 'SANDBOX' } })
    await m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: 'sandbox', cardEnabled: true, pixEnabled: true, merchantKeyCiphertext: m.enc(SEGREDO_MK) } })
    await m.prisma.notificationChannelConfig.create({ data: { id: 1, smtpPasswordCiphertext: m.enc(SEGREDO_SMTP) } })
  }

  it('CONTROLE: tudo legível => nenhum alerta, executado=true, 0 ilegíveis', async () => {
    await popular()
    const r = await m.verificar(m.prisma)
    expect(r).toEqual({ executado: true, ilegiveis: 0, porAlvo: {} })
    expect(alertas.filter((a) => a.alert === 'secrets_undecryptable')).toHaveLength(0)
  })

  it('JWT_SECRET trocado => UM alerta secrets_undecryptable com contagem por ÁREA (cartões, gateway, comunicação), sem NENHUM valor (segredo, ciphertext, JWT) no log; nada é gravado/apagado', async () => {
    await popular()
    const antes = JSON.stringify({
      cartoes: await m.prisma.paymentMethod.findMany({ select: { id: true, cieloCardTokenCiphertext: true } }),
      gw: await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } }),
      com: await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } }),
    })
    m.env.JWT_SECRET = JWT_SECRET_TROCADO
    const r = await m.verificar(m.prisma)
    expect(r).toMatchObject({ executado: true, ilegiveis: 3, porAlvo: { cartoes_dos_motoristas: 1, gateway_cielo: 1, comunicacao_email_whatsapp: 1 } })
    const avisos = alertas.filter((a) => a.alert === 'secrets_undecryptable')
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toMatchObject({ modoDaChave: 'derivada', ilegiveis: 3 })
    const log = tudoLogado.join('\n')
    for (const v of [SEGREDO_SMTP, SEGREDO_MK, TOKEN_CARTAO, JWT_SECRET_TROCADO, String(jwtOriginal)]) expect(log, v.slice(0, 8)).not.toContain(v)
    const cifrados = JSON.parse(antes) as { cartoes: Array<{ cieloCardTokenCiphertext: string }> }
    expect(log).not.toContain(cifrados.cartoes[0]!.cieloCardTokenCiphertext) // nem o ciphertext
    // dry-run: nada mudou no banco
    const depois = JSON.stringify({
      cartoes: await m.prisma.paymentMethod.findMany({ select: { id: true, cieloCardTokenCiphertext: true } }),
      gw: await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } }),
      com: await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } }),
    })
    expect(depois).toBe(antes)
    // voltar ao JWT_SECRET antigo: o diagnóstico fica limpo (tudo continua lá)
    m.env.JWT_SECRET = jwtOriginal
    alertas.length = 0
    expect(await m.verificar(m.prisma)).toMatchObject({ ilegiveis: 0 })
    expect(alertas.filter((a) => a.alert === 'secrets_undecryptable')).toHaveLength(0)
  })

  it('o alerta é CRITICO e tem orientação (voltar ao JWT_SECRET antigo / recadastrar / motoristas recadastram o cartão)', () => {
    expect(m.severidadeDoEvento('secrets_undecryptable', 50)).toBe('CRITICO')
    expect(m.orientacoes.secrets_undecryptable).toMatch(/JWT_SECRET/)
    expect(m.orientacoes.secrets_undecryptable).toMatch(/cartao/i)
    expect(m.severidadeDoEvento('payment_secrets_key_invalid', 50)).toBe('CRITICO')
  })

  it('NUNCA lança: sem a chave-mestra (override inválido) devolve executado=false, e não derruba o boot', async () => {
    await popular()
    m.env.PAYMENT_SECRETS_KEY = 'isto-nao-e-uma-chave-base64-de-32-bytes'
    try {
      const r = await m.verificar(m.prisma)
      expect(r).toMatchObject({ executado: false, ilegiveis: 0 })
    } finally {
      m.env.PAYMENT_SECRETS_KEY = undefined
    }
  })
})
