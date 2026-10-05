import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { JWT_SECRET_TROCADO, OVERRIDE_INVALIDO, trocarJwtSecret } from './helpers/chaveMestra'
import { randomBytes } from 'node:crypto'
import { iniciarHttpFalso, iniciarSmtpFalso, type HttpFalso, type SmtpFalso } from '../unit/helpers/servidoresFalsos'

/**
 * N-7 — configuração de comunicação (e-mail SMTP + WhatsApp/Evolution) pelo PAINEL ADMIN: `GET/PUT /api/admin/communication-settings` e os testes de canal.
 * Ponta a ponta contra Postgres + Redis REAIS (banco próprio: `NotificationChannelConfig` é singleton global), SMTP falso (smtp-server) e Evolution falsa (HTTP).
 * Prova: só ADMIN; step-up obrigatório e fail-closed; segredo nunca em resposta/log/auditoria e cifrado no banco; DB > env; cache que invalida e expira (TTL);
 * anti-exfiltração (trocar destino exige reenviar o segredo); anti-SSRF; canal incompleto não liga (409, nada gravado); rotação de chave cobre os segredos novos.
 */

// DNS FALSO do verificador de domínio (sem rede): `mapa` nome -> TXT[] (ou Error); nome fora do mapa = ENODATA.
const dns = vi.hoisted(() => ({ mapa: {} as Record<string, string[] | Error>, consultados: [] as string[] }))
vi.mock('../../src/services/comunicacao/verificarDominio', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/comunicacao/verificarDominio')>()
  return {
    ...real,
    resolvedorTxtDoSistema: async (nome: string) => {
      dns.consultados.push(nome)
      const v = dns.mapa[nome]
      if (v === undefined) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
      if (v instanceof Error) throw v
      return v.map((t) => [t])
    },
  }
})

const SEGREDO_SMTP = 'SenhaSmtp#Marcador-Unico-7a1c'
const APIKEY = 'EVO-APIKEY-MARCADOR-UNICO-0123456789abcdef'

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  logger: typeof import('../../src/lib/logger').logger
  issueToken: typeof import('../../src/lib/jwt').issueToken
  cfg: typeof import('../../src/services/comunicacao/configComunicacao')
  sec: typeof import('../../src/lib/crypto/paymentSecrets')
  throttle: typeof import('../../src/api/lib/loginThrottleInstance').stepUpThrottle
  recifrar: typeof import('../../src/services/pagamentos/recifrarSegredos').recifrarSegredosDePagamento
  inst: typeof import('../../src/lib/alertas/instancia')
  notif: typeof import('../../src/lib/alertas/notificador')
  dedupe: typeof import('../../src/core/alertas/dedupe')
}

const dump = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : x))

describe('comunicação pelo painel admin (N-7) — Postgres + Redis reais, SMTP e Evolution falsos', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let smtp: SmtpFalso
  let evolution: HttpFalso
  let outro: HttpFalso
  const logsTodos: string[] = []
  const logsWarn: Array<Record<string, unknown>> = []
  const envSalvo: Record<string, string | undefined> = {}
  let contador = 0

  beforeAll(async () => {
    smtp = await iniciarSmtpFalso()
    evolution = await iniciarHttpFalso()
    outro = await iniciarHttpFalso()
    banco = await criarBancoProprio('cms')
    for (const k of Object.keys(process.env)) if (k.startsWith('ALERT_') || k.startsWith('COMMUNICATION_')) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, loggerMod, jwtMod, cfgMod, secMod, thMod, recMod, instMod, notifMod, dedMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/logger'),
      import('../../src/lib/jwt'),
      import('../../src/services/comunicacao/configComunicacao'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/api/lib/loginThrottleInstance'),
      import('../../src/services/pagamentos/recifrarSegredos'),
      import('../../src/lib/alertas/instancia'),
      import('../../src/lib/alertas/notificador'),
      import('../../src/core/alertas/dedupe'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      env: envMod.env as unknown as Record<string, unknown>,
      logger: loggerMod.logger,
      issueToken: jwtMod.issueToken,
      cfg: cfgMod,
      sec: secMod,
      throttle: thMod.stepUpThrottle,
      recifrar: recMod.recifrarSegredosDePagamento,
      inst: instMod,
      notif: notifMod,
      dedupe: dedMod,
    }
    app = m.createApp()
    envSalvo.PAYMENT_SECRETS_KEY = m.env.PAYMENT_SECRETS_KEY as string | undefined
    envSalvo.JWT_SECRET = m.env.JWT_SECRET as string | undefined
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
    await smtp.fechar()
    await evolution.fechar()
    await outro.fechar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.notificationChannelConfig.deleteMany()
    m.cfg.resetCacheComunicacaoParaTeste()
    logsWarn.length = 0
    logsTodos.length = 0
    smtp.recebidos.length = 0
    dns.mapa = {}
    dns.consultados.length = 0
    evolution.recebidas.length = 0
    outro.recebidas.length = 0
    evolution.responder((_r, res) => res.writeHead(201).end('{}'))
  })
  afterEach(() => {
    m.env.PAYMENT_SECRETS_KEY = envSalvo.PAYMENT_SECRETS_KEY
    m.env.PAYMENT_SECRETS_KEY_PREVIOUS = undefined
    m.env.JWT_SECRET = envSalvo.JWT_SECRET
    m.sec.resetPaymentSecretsKeyCacheParaTeste()
    for (const k of Object.keys(process.env)) if (k.startsWith('ALERT_') || k.startsWith('COMMUNICATION_')) delete process.env[k]
  })

  async function novoUsuario(role: 'ADMIN' | 'OPERATOR' | 'DRIVER' = 'ADMIN') {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    let operatorId: string | null = null
    if (role === 'OPERATOR') operatorId = (await m.prisma.operator.create({ data: { name: `Op ${sufixo}`, email: `op-${sufixo}@example.com` } })).id
    const user = await m.prisma.user.create({ data: { role, name: `${role} ${sufixo}`, email: `${role.toLowerCase()}-${sufixo}@example.com`, operatorId, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    return { id: user.id, token: m.issueToken({ id: user.id, role, operatorId }) }
  }
  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })
  const get = (u: { token: string }) => request(app).get('/api/admin/communication-settings').set(auth(u))
  const put = (u: { token: string }, body: Record<string, unknown>) => request(app).put('/api/admin/communication-settings').set(auth(u)).send(body)
  const post = (u: { token: string }, rota: 'test-email' | 'test-whatsapp', body: Record<string, unknown> = {}) => request(app).post(`/api/admin/communication-settings/${rota}`).set(auth(u)).send(body)
  const salvarPadrao = (u: { token: string }, extra: Record<string, unknown> = {}) =>
    put(u, {
      currentPassword: SENHA_ADMIN_TESTE,
      email: { enabled: true, host: '127.0.0.1', port: smtp.porta, secure: false, fromName: 'InnoFlow', fromAddress: 'alertas@exemplo.com.br', recipients: ['dono@exemplo.com.br'], user: null, password: SEGREDO_SMTP },
      whatsapp: { enabled: true, baseUrl: evolution.base, instance: 'minha-inst', apiKey: APIKEY, apiVersion: 2, recipients: ['+55 (11) 99999-9999'] },
      ...extra,
    })
  const esperarAuditoria = async (userId: string, n: number) => {
    const limite = Date.now() + 5000
    let l = await m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
    while (l.length < n && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 50))
      l = await m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
    }
    return l
  }

  describe('acesso', () => {
    it('sem token 401; OPERATOR e DRIVER 403 em TODAS as rotas (só ADMIN)', async () => {
      const op = await novoUsuario('OPERATOR')
      const dr = await novoUsuario('DRIVER')
      expect((await request(app).get('/api/admin/communication-settings')).status).toBe(401)
      for (const u of [op, dr]) {
        expect((await get(u)).status).toBe(403)
        expect((await put(u, { currentPassword: SENHA_ADMIN_TESTE, alerts: { dedupeMinutes: 10 } })).status).toBe(403)
        expect((await post(u, 'test-email')).status).toBe(403)
        expect((await post(u, 'test-whatsapp')).status).toBe(403)
      }
      expect(await m.prisma.notificationChannelConfig.count()).toBe(0)
    })
  })

  describe('GET', () => {
    it('sem nada salvo e sem env: source "env", canais "none", sem segredo, com os padrões', async () => {
      const admin = await novoUsuario()
      const res = await get(admin)
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body).toMatchObject({
        source: 'env',
        email: { source: 'none', enabled: false, active: false, passwordSet: false, recipients: [], minSeverity: 'IMPORTANTE' },
        whatsapp: { source: 'none', enabled: false, active: false, apiKeySet: false, apiKeyHint: null, apiVersion: 2, minSeverity: 'CRITICO' },
        alerts: { dedupeMinutes: 30, dedupeSource: 'env', globalMinSeverity: 'IMPORTANTE', maxPerHour: 20 },
        secretsKeyConfigured: true,
        secretsDecryptable: null,
        privateHostsAllowed: false,
        updatedAt: null,
      })
    })

    it('com SÓ a env configurada: source "env" e os campos da env (segredo só como "configurado")', async () => {
      Object.assign(process.env, { ALERT_EMAIL_TO: 'env@exemplo.com.br', ALERT_SMTP_HOST: '127.0.0.1', ALERT_SMTP_PORT: String(smtp.porta), ALERT_EMAIL_FROM: 'a@exemplo.com.br', ALERT_SMTP_USER: 'u', ALERT_SMTP_PASS: 'SENHA-DA-ENV-XYZ' })
      const admin = await novoUsuario()
      const res = await get(admin)
      expect(res.body).toMatchObject({ source: 'env', email: { source: 'env', enabled: true, active: true, host: '127.0.0.1', passwordSet: true, recipients: ['env@exemplo.com.br'] } })
      expect(JSON.stringify(res.body)).not.toContain('SENHA-DA-ENV-XYZ')
    })
  })

  describe('PUT — validação e step-up', () => {
    it('corpo inválido: 400 (campo desconhecido, grupo vazio, host com esquema/porta, e-mail ruim, sem alteração) — nada gravado', async () => {
      const admin = await novoUsuario()
      const senha = SENHA_ADMIN_TESTE
      for (const body of [
        { currentPassword: senha, email: { hostt: 'x' } },
        { currentPassword: senha, email: {} },
        { currentPassword: senha, email: { host: 'http://smtp.exemplo.com' } },
        { currentPassword: senha, email: { host: 'smtp.exemplo.com:587' } },
        { currentPassword: senha, email: { recipients: ['nao-e-email'] } },
        { currentPassword: senha, whatsapp: { instance: '../admin' } },
        { currentPassword: senha, whatsapp: { baseUrl: 'nao-e-url' } },
        { currentPassword: senha, alerts: { dedupeMinutes: 0 } },
        { currentPassword: senha },
        { currentPassword: senha, extra: 1, alerts: { dedupeMinutes: 5 } },
      ]) {
        const res = await put(admin, body)
        expect(res.status, dump(body)).toBe(400)
        expect(res.body.code).toBe('VALIDATION_ERROR')
      }
      expect(await m.prisma.notificationChannelConfig.count()).toBe(0)
    })

    it('step-up: sem senha 400; senha errada 403 INVALID_CURRENT_PASSWORD (nada gravado, auditoria DENIED sem corpo); a senha nunca vaza', async () => {
      const admin = await novoUsuario()
      expect((await put(admin, { alerts: { dedupeMinutes: 10 } })).status).toBe(400)
      const SENHA_ERRADA = 'SenhaErrada#Marcador-Unico-55ab'
      const res = await put(admin, { currentPassword: SENHA_ERRADA, alerts: { dedupeMinutes: 10 } })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('INVALID_CURRENT_PASSWORD')
      expect(await m.prisma.notificationChannelConfig.count()).toBe(0)
      const linhas = await esperarAuditoria(admin.id, 1)
      expect(linhas).toHaveLength(1)
      expect(linhas[0]).toMatchObject({ outcome: 'DENIED', httpStatus: 403, entityType: 'NotificationChannelConfig', actionDetail: 'communication_settings:stepup_failed' })
      expect(dump(linhas) + logsTodos.join('')).not.toContain(SENHA_ERRADA)
      expect(dump(linhas) + logsTodos.join('')).not.toContain(SENHA_ADMIN_TESTE)
    })

    it('step-up FAIL-CLOSED: throttle (Redis) indisponível => 503 STEPUP_UNAVAILABLE e nada gravado, mesmo com a senha certa', async () => {
      const admin = await novoUsuario()
      const espiao = vi.spyOn(m.throttle, 'reserveAttempt').mockRejectedValue(new Error('redis fora'))
      try {
        const res = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, alerts: { dedupeMinutes: 10 } })
        expect(res.status, dump(res.body)).toBe(503)
        expect(res.body.code).toBe('STEPUP_UNAVAILABLE')
      } finally {
        espiao.mockRestore()
      }
      expect(await m.prisma.notificationChannelConfig.count()).toBe(0)
    })

    it('SEM PAYMENT_SECRETS_KEY (modo padrão, chave derivada do JWT_SECRET): PUT com senha/apikey FUNCIONA — MUDANÇA DELIBERADA, como no InnoChat — e o DTO diz secretsKeyConfigured=true', async () => {
      const admin = await novoUsuario()
      expect(m.env.PAYMENT_SECRETS_KEY).toBeUndefined()
      const res = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { password: SEGREDO_SMTP } })
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.secretsKeyConfigured).toBe(true)
      expect(dump(res.body)).not.toContain(SEGREDO_SMTP)
    })

    it('chave-mestra INDISPONÍVEL (override PAYMENT_SECRETS_KEY definido e inválido): PUT com senha/apikey => 503 SECRETS_KEY_MISSING; sem segredo continua funcionando', async () => {
      const admin = await novoUsuario()
      m.env.PAYMENT_SECRETS_KEY = OVERRIDE_INVALIDO
      m.sec.resetPaymentSecretsKeyCacheParaTeste()
      const res = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { password: SEGREDO_SMTP } })
      expect(res.status).toBe(503)
      expect(res.body.code).toBe('SECRETS_KEY_MISSING')
      expect(await m.prisma.notificationChannelConfig.count()).toBe(0)
      expect((await put(admin, { currentPassword: SENHA_ADMIN_TESTE, alerts: { dedupeMinutes: 15 } })).status).toBe(200)
    })
  })

  describe('PUT — gravação, segredos e auditoria', () => {
    it('salva e-mail+WhatsApp: resposta com source "database", segredo NUNCA devolvido (só "set" + 4 últimos da apikey), cifrado no banco, auditado sem segredo', async () => {
      const admin = await novoUsuario()
      const res = await salvarPadrao(admin)
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body).toMatchObject({
        source: 'database',
        email: { source: 'database', enabled: true, active: true, host: '127.0.0.1', port: smtp.porta, passwordSet: true, fromName: 'InnoFlow', fromAddress: 'alertas@exemplo.com.br', recipients: ['dono@exemplo.com.br'] },
        whatsapp: { source: 'database', enabled: true, active: true, provider: 'evolution', baseUrl: evolution.base, instance: 'minha-inst', apiKeySet: true, apiKeyHint: `…${APIKEY.slice(-4)}`, apiVersion: 2, recipients: ['5511999999999'] },
        secretsDecryptable: true,
      })
      const corpo = JSON.stringify(res.body)
      expect(corpo).not.toContain(SEGREDO_SMTP)
      expect(corpo).not.toContain(APIKEY)
      expect(corpo).not.toContain('Ciphertext')
      expect(corpo).not.toContain(SENHA_ADMIN_TESTE)

      const linha = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(linha.smtpPasswordCiphertext).toMatch(/^v1:/)
      expect(linha.evolutionApiKeyCiphertext).toMatch(/^v1:/)
      expect(m.sec.decryptPaymentSecret(linha.smtpPasswordCiphertext!)).toBe(SEGREDO_SMTP)
      expect(m.sec.decryptPaymentSecret(linha.evolutionApiKeyCiphertext!)).toBe(APIKEY)
      expect(JSON.stringify(linha)).not.toContain(SEGREDO_SMTP)
      expect(JSON.stringify(linha)).not.toContain(APIKEY)

      const linhas = await esperarAuditoria(admin.id, 1)
      const auditoria = linhas.filter((l) => l.outcome === 'SUCCESS')
      expect(auditoria).toHaveLength(1) // exatamente UMA (fail-closed na transação; o middleware genérico não duplica)
      expect(auditoria[0]).toMatchObject({ action: 'UPDATE', entityType: 'NotificationChannelConfig', entityId: '1', actionDetail: 'communication_settings' })
      const changes = auditoria[0].changes as Record<string, unknown>
      expect(changes.smtpPassword).toEqual({ changed: true })
      expect(changes.evolutionApiKey).toEqual({ changed: true })
      expect(changes.smtpHost).toBeDefined()
      const brutoAuditoria = dump(auditoria)
      for (const s of [SEGREDO_SMTP, APIKEY, SENHA_ADMIN_TESTE, 'dono@exemplo.com.br', '5511999999999', linha.smtpPasswordCiphertext!, linha.evolutionApiKeyCiphertext!]) expect(brutoAuditoria, s).not.toContain(s)
      expect((changes as { emailRecipientsCount?: unknown }).emailRecipientsCount).toBeDefined() // só a CONTAGEM entra

      // log: segredos fora; alerta emitido com NOMES de campos
      const todosOsLogs = logsTodos.join('\n')
      for (const s of [SEGREDO_SMTP, APIKEY, SENHA_ADMIN_TESTE, linha.smtpPasswordCiphertext!]) expect(todosOsLogs, s).not.toContain(s)
      const alerta = logsWarn.find((l) => l.alert === 'communication_config_changed')
      expect(alerta).toBeDefined()
      expect(alerta!.actorUserId).toBe(admin.id)
      expect(alerta!.changedFields).toEqual(expect.arrayContaining(['email.password', 'whatsapp.apiKey']))
    })

    it('PUT parcial: só muda o que veio; segredos salvos permanecem; limpar um segredo com clearSecrets', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const antes = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      const res = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { minSeverity: 'CRITICO' }, alerts: { dedupeMinutes: 60 } })
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.email).toMatchObject({ minSeverity: 'CRITICO', host: '127.0.0.1', passwordSet: true })
      expect(res.body.alerts).toMatchObject({ dedupeMinutes: 60, dedupeSource: 'database' })
      const depois = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(depois.smtpPasswordCiphertext).toBe(antes.smtpPasswordCiphertext) // não foi regravado
      // limpar a apikey com o WhatsApp ligado => 409 (canal ficaria incompleto) e nada muda
      const incompleto = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, clearSecrets: ['evolutionApiKey'] })
      expect(incompleto.status).toBe(409)
      expect(incompleto.body.code).toBe('CHANNEL_INCOMPLETE')
      expect((await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })).evolutionApiKeyCiphertext).toBe(antes.evolutionApiKeyCiphertext)
      // desligando o WhatsApp e limpando: ok
      const ok = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, whatsapp: { enabled: false }, clearSecrets: ['evolutionApiKey'] })
      expect(ok.status, dump(ok.body)).toBe(200)
      expect(ok.body.whatsapp).toMatchObject({ enabled: false, apiKeySet: false })
    })

    it('1ª gravação de um grupo nasce DESLIGADA; ligar sem destinatário/remetente => 409 CHANNEL_INCOMPLETE e NADA é gravado (rollback)', async () => {
      const admin = await novoUsuario()
      const nasce = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { host: '127.0.0.1', port: smtp.porta } })
      expect(nasce.status, dump(nasce.body)).toBe(200)
      expect(nasce.body.email).toMatchObject({ source: 'database', enabled: false, active: false })
      const antes = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      const res = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { enabled: true } })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('CHANNEL_INCOMPLETE')
      expect(res.body.details[0]).toMatchObject({ channel: 'email' })
      const depois = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(depois.emailEnabled).toBe(false)
      expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime())
    })

    // MUDANÇA DELIBERADA (L1.6, item 1): o 409 CHANNEL_INCOMPLETE do e-mail deixou de cobrar destinatário de alerta — exige só servidor + remetente. O código e o formato do erro não mudam.
    it('MUDANÇA DELIBERADA L1.6: ligar o e-mail com SMTP + remetente e SEM destinatário de alerta => 200; o transacional sai, o alerta não', async () => {
      const admin = await novoUsuario()
      const res = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { enabled: true, host: '127.0.0.1', port: smtp.porta, secure: false, fromAddress: 'nao-responda@exemplo.com.br' } })
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.email).toMatchObject({ enabled: true, active: true, recipients: [] })
      expect(res.body.warnings.join(' ')).toContain('sem destinatário de alertas')

      const { enviarEmailTransacional } = await import('../../src/services/comunicacao/email')
      const r = await enviarEmailTransacional({ to: 'motorista@exemplo.com.br', subject: 'Transacional via painel', text: 'corpo-transacional-painel' })
      expect(r.ok).toBe(true)
      expect(smtp.recebidos).toHaveLength(1)
      expect(smtp.recebidos[0].para).toEqual(['motorista@exemplo.com.br'])

      const snap = await m.cfg.getConfigComunicacao()
      expect(m.inst.montarCanais(snap.config)).toEqual([]) // nenhum canal de ALERTA por e-mail
    })

    it('o que continua incompleto continua dando 409: ligar o e-mail sem remetente (mesmo com destinatário)', async () => {
      const admin = await novoUsuario()
      const res = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { enabled: true, host: '127.0.0.1', port: smtp.porta, recipients: ['dono@exemplo.com.br'] } })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('CHANNEL_INCOMPLETE')
      expect(JSON.stringify(res.body.details)).toContain('remetente')
    })

    it('ANTI-EXFILTRAÇÃO: trocar host/usuário SMTP ou URL/instância da Evolution SEM reenviar o segredo => 400 SECRET_REQUIRED_FOR_NEW_DESTINATION; com o segredo novo passa', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      for (const body of [{ email: { host: 'smtp.do-atacante.example' } }, { email: { user: 'outro' } }, { whatsapp: { baseUrl: `${outro.base}` } }, { whatsapp: { instance: 'outra' } }]) {
        const res = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, ...body })
        expect(res.status, dump(body)).toBe(400)
        expect(res.body.code).toBe('SECRET_REQUIRED_FOR_NEW_DESTINATION')
      }
      const ok = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, whatsapp: { instance: 'outra', apiKey: 'OUTRA-APIKEY-1234567890' } })
      expect(ok.status, dump(ok.body)).toBe(200)
      expect(ok.body.whatsapp.instance).toBe('outra')
      // mudar só a PORTA ou o remetente não troca o destino do segredo
      expect((await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { fromName: 'Outro nome' } })).status).toBe(200)
    })

    it('ANTI-SSRF em produção: host SMTP e URL da Evolution internos/metadados/loopback => 400 DESTINATION_NOT_ALLOWED; http só se a permissão de rede privada está ligada no deploy', async () => {
      const nodeEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        const casos: Array<[Record<string, unknown>, string]> = [
          [{ email: { host: '169.254.169.254' } }, 'email.host'],
          [{ email: { host: '127.0.0.1' } }, 'email.host'],
          [{ email: { host: '10.0.0.5' } }, 'email.host'],
          [{ email: { host: 'localhost' } }, 'email.host'],
          [{ email: { host: 'redis' } }, 'email.host'],
          [{ email: { host: 'db.internal' } }, 'email.host'],
          [{ whatsapp: { baseUrl: 'https://169.254.169.254' } }, 'whatsapp.baseUrl'],
          [{ whatsapp: { baseUrl: 'https://[::1]' } }, 'whatsapp.baseUrl'],
          [{ whatsapp: { baseUrl: 'https://192.168.0.10' } }, 'whatsapp.baseUrl'],
          [{ whatsapp: { baseUrl: 'http://evolution.exemplo.com.br' } }, 'whatsapp.baseUrl'], // http em produção
          [{ whatsapp: { baseUrl: 'http://evolution:8080' } }, 'whatsapp.baseUrl'], // privado sem a permissão do deploy
        ]
        for (const [corpo, campo] of casos) {
          const res = await put(await novoUsuario(), { currentPassword: SENHA_ADMIN_TESTE, ...corpo }) // um admin por tentativa: o PUT tem limite de 10/min por usuário
          expect(res.status, dump(corpo)).toBe(400)
          expect(res.body.code, dump(corpo)).toBe('DESTINATION_NOT_ALLOWED')
          expect(res.body.details[0].field).toBe(campo)
        }
        // nome público e https passam
        expect((await put(await novoUsuario(), { currentPassword: SENHA_ADMIN_TESTE, email: { host: 'smtp.exemplo.com.br' }, whatsapp: { baseUrl: 'https://evolution.exemplo.com.br' } })).status).toBe(200)
        // com a permissão do deploy, a rede PRIVADA (e http interno) passa — metadados nunca
        process.env.COMMUNICATION_ALLOW_PRIVATE_HOSTS = 'true'
        expect((await put(await novoUsuario(), { currentPassword: SENHA_ADMIN_TESTE, whatsapp: { baseUrl: 'http://evolution:8080', apiKey: 'K-1234567890' } })).status).toBe(200)
        expect((await put(await novoUsuario(), { currentPassword: SENHA_ADMIN_TESTE, email: { host: '10.0.0.5', password: 'x' } })).status).toBe(200)
        const meta = await put(await novoUsuario(), { currentPassword: SENHA_ADMIN_TESTE, email: { host: '169.254.169.254', password: 'x' } })
        expect(meta.status).toBe(400)
      } finally {
        process.env.NODE_ENV = nodeEnv
        delete process.env.COMMUNICATION_ALLOW_PRIVATE_HOSTS
      }
    })
  })

  describe('resolução: o painel (banco) manda, a env é reserva; cache; entre processos', () => {
    const envCompleta = () =>
      Object.assign(process.env, {
        ALERT_EMAIL_TO: 'env@exemplo.com.br',
        ALERT_SMTP_HOST: '127.0.0.1',
        ALERT_SMTP_PORT: String(smtp.porta),
        ALERT_EMAIL_FROM: 'env@exemplo.com.br',
        ALERT_WHATSAPP_PROVIDER: 'evolution',
        ALERT_EVOLUTION_BASE_URL: outro.base,
        ALERT_EVOLUTION_INSTANCE: 'inst-env',
        ALERT_EVOLUTION_APIKEY: 'APIKEY-DA-ENV',
        ALERT_WHATSAPP_TO: '5521988887777',
        ALERT_DEDUPE_MINUTES: '45',
      })

    it('banco > env por canal: linha com e-mail ligado usa SÓ o banco (host/destinatários/segredo); WhatsApp ainda sem grupo no banco segue na env; dedupe do banco vence', async () => {
      envCompleta()
      const admin = await novoUsuario()
      await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { enabled: true, host: '127.0.0.1', port: smtp.porta, fromAddress: 'db@exemplo.com.br', recipients: ['db@exemplo.com.br'], password: SEGREDO_SMTP }, alerts: { dedupeMinutes: 10 } })
      const r = await m.cfg.getConfigComunicacao()
      expect(r.fontes).toEqual({ email: 'database', whatsapp: 'env', dedupe: 'database' })
      expect(r.config.email).toMatchObject({ para: ['db@exemplo.com.br'], de: 'db@exemplo.com.br', senha: SEGREDO_SMTP, origem: 'database' })
      expect(r.config.whatsapp).toMatchObject({ instancia: 'inst-env', origem: 'env' })
      expect(r.config.dedupeMinutos).toBe(10)
    })

    it('o banco pode DESLIGAR um canal que a env liga (enabled=false manda)', async () => {
      envCompleta()
      const admin = await novoUsuario()
      await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { enabled: false } })
      const r = await m.cfg.getConfigComunicacao()
      expect(r.config.email).toBeNull()
      expect(r.fontes.email).toBe('database')
      expect(r.config.whatsapp).not.toBeNull() // o outro canal segue na env
      const tela = (await get(admin)).body
      expect(tela.email).toMatchObject({ source: 'database', enabled: false, active: false })
    })

    it('sem linha no banco: tudo da env (reserva); apagar a linha volta para a env', async () => {
      envCompleta()
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      expect((await m.cfg.getConfigComunicacao()).config.email?.origem).toBe('database')
      await m.prisma.notificationChannelConfig.deleteMany()
      m.cfg.invalidarCacheComunicacao()
      const r = await m.cfg.getConfigComunicacao()
      expect(r.source).toBe('env')
      expect(r.config.email).toMatchObject({ origem: 'env', para: ['env@exemplo.com.br'] })
    })

    it('o PUT invalida o cache DESTE processo na hora; OUTRO processo (que não viu o PUT) só enxerga após o TTL (≤ 30 s)', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      expect((await m.cfg.getConfigComunicacao()).config.email?.para).toEqual(['dono@exemplo.com.br'])

      // "outro processo": muda direto no banco (sem passar pela API, logo sem invalidar o cache daqui)
      await m.prisma.notificationChannelConfig.update({ where: { id: 1 }, data: { alertEmailRecipients: ['novo@exemplo.com.br'] } })
      expect((await m.cfg.getConfigComunicacao()).config.email?.para).toEqual(['dono@exemplo.com.br']) // ainda no cache
      const agora = Date.now()
      expect(m.cfg.CACHE_TTL_MS).toBeLessThanOrEqual(60_000) // contrato: o worker/gateway não ficam com config velha por mais que isto
      const espiao = vi.spyOn(Date, 'now').mockReturnValue(agora + 61_000)
      try {
        expect((await m.cfg.getConfigComunicacao()).config.email?.para).toEqual(['novo@exemplo.com.br']) // expirou: releu
      } finally {
        espiao.mockRestore()
      }
      // pelo PUT, a mudança vale NA HORA para o processo que gravou
      await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { recipients: ['pelo-put@exemplo.com.br'] } })
      expect((await m.cfg.getConfigComunicacao()).config.email?.para).toEqual(['pelo-put@exemplo.com.br'])
    })

    it('banco ILEGÍVEL (leitura falha): o notificador cai na env, a tela responde 503 (como o GET do gateway)', async () => {
      envCompleta()
      const admin = await novoUsuario()
      const espiao = vi.spyOn(m.prisma.notificationChannelConfig, 'findUnique').mockRejectedValue(new Error('banco fora'))
      try {
        m.cfg.resetCacheComunicacaoParaTeste()
        const r = await m.cfg.getConfigComunicacao()
        expect(r.leituraFalhou).toBe(true)
        expect(r.config.email?.origem).toBe('env')
        const tela = await get(admin)
        expect(tela.status).toBe(503)
        expect(tela.body.code).toBe('COMMUNICATION_SETTINGS_UNAVAILABLE')
      } finally {
        espiao.mockRestore()
      }
    })

    it('JWT_SECRET trocado (a chave dos segredos é derivada dele): segredos salvos não decifram => canal desligado com aviso (sem derrubar) e secretsDecryptable=false; salvar de novo restabelece', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const sessaoAntiga = admin.token
      trocarJwtSecret(m.env, JWT_SECRET_TROCADO)
      admin.token = m.issueToken({ id: admin.id, role: 'ADMIN', operatorId: null }) // trocar o JWT_SECRET derruba as sessões: o admin loga de novo
      expect((await get({ token: sessaoAntiga })).status).toBe(401)
      m.sec.resetPaymentSecretsKeyCacheParaTeste()
      m.cfg.invalidarCacheComunicacao()
      const r = await m.cfg.getConfigComunicacao()
      expect(r.segredosIlegiveis).toBe(true)
      expect(r.config.email).toBeNull()
      expect(r.config.whatsapp).toBeNull()
      const tela = await get(admin)
      expect(tela.status).toBe(200)
      expect(tela.body).toMatchObject({ secretsDecryptable: false, email: { enabled: true, active: false } })
      expect(tela.body.warnings.join(' ')).toContain('não pôde ser decifrada')
      const ok = await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { password: SEGREDO_SMTP }, whatsapp: { apiKey: APIKEY } })
      expect(ok.status, dump(ok.body)).toBe(200)
      expect(ok.body).toMatchObject({ secretsDecryptable: true, email: { active: true }, whatsapp: { active: true } })
    })
  })

  describe('rotação da PAYMENT_SECRETS_KEY cobre os segredos de comunicação', () => {
    it('dry-run conta, apply re-cifra para a chave nova, e depois de remover a anterior continua decifrando', async () => {
      const admin = await novoUsuario()
      // MUDANÇA DELIBERADA (chave derivada do JWT_SECRET): a rotação de override parte de uma chave A EXPLÍCITA (antes a suíte já a trazia fixa no vitest.config).
      const chaveA = randomBytes(32).toString('base64')
      m.env.PAYMENT_SECRETS_KEY = chaveA
      m.sec.resetPaymentSecretsKeyCacheParaTeste()
      await salvarPadrao(admin)
      const chaveB = randomBytes(32).toString('base64')
      m.env.PAYMENT_SECRETS_KEY_PREVIOUS = chaveA
      m.env.PAYMENT_SECRETS_KEY = chaveB
      m.sec.resetPaymentSecretsKeyCacheParaTeste()
      const alvo = (r: Awaited<ReturnType<Mods['recifrar']>>, nome: string) => r.alvos.find((a) => a.alvo === nome)!
      const dry = await m.recifrar({ apply: false, prisma: m.prisma })
      expect(alvo(dry, 'NotificationChannelConfig.smtpPasswordCiphertext')).toMatchObject({ total: 1, aRecifrar: 1, recifrados: 0, ilegiveis: 0 })
      expect(alvo(dry, 'NotificationChannelConfig.evolutionApiKeyCiphertext')).toMatchObject({ total: 1, aRecifrar: 1, recifrados: 0, ilegiveis: 0 })
      const antes = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      const rel = await m.recifrar({ apply: true, prisma: m.prisma })
      expect(alvo(rel, 'NotificationChannelConfig.smtpPasswordCiphertext').recifrados).toBe(1)
      expect(alvo(rel, 'NotificationChannelConfig.evolutionApiKeyCiphertext').recifrados).toBe(1)
      const depois = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(depois.smtpPasswordCiphertext).not.toBe(antes.smtpPasswordCiphertext)
      expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime()) // re-cifrar não é "alteração de configuração"
      m.env.PAYMENT_SECRETS_KEY_PREVIOUS = undefined
      m.sec.resetPaymentSecretsKeyCacheParaTeste()
      m.cfg.invalidarCacheComunicacao()
      const r = await m.cfg.getConfigComunicacao()
      expect(r.segredosIlegiveis).toBe(false)
      expect(r.config.email?.senha).toBe(SEGREDO_SMTP)
      expect(r.config.whatsapp).toMatchObject({ apikey: APIKEY })
    })
  })

  describe('chave derivada do JWT_SECRET: migração para o override e troca do JWT_SECRET', () => {
    it('segredos gravados na chave DERIVADA: virar override (PAYMENT_SECRETS_KEY) os mantém legíveis; re-cifrar os leva à chave nova; depois TROCAR o JWT_SECRET não os perde', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin) // sem override: grava com a chave derivada do JWT_SECRET
      const antes = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      m.env.PAYMENT_SECRETS_KEY = randomBytes(32).toString('base64')
      m.sec.resetPaymentSecretsKeyCacheParaTeste()
      m.cfg.invalidarCacheComunicacao()
      expect((await m.cfg.getConfigComunicacao()).config.email?.senha).toBe(SEGREDO_SMTP) // a derivada virou só-decifra automática
      const rel = await m.recifrar({ apply: true, prisma: m.prisma })
      expect(rel.totais.recifrados).toBeGreaterThanOrEqual(2)
      expect(rel.totais.ilegiveis).toBe(0)
      const depois = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(depois.smtpPasswordCiphertext).not.toBe(antes.smtpPasswordCiphertext)
      trocarJwtSecret(m.env, JWT_SECRET_TROCADO)
      m.sec.resetPaymentSecretsKeyCacheParaTeste()
      m.cfg.invalidarCacheComunicacao()
      const r = await m.cfg.getConfigComunicacao()
      expect(r.segredosIlegiveis).toBe(false)
      expect(r.config.email?.senha).toBe(SEGREDO_SMTP)
      expect(r.config.whatsapp).toMatchObject({ apikey: APIKEY })
    })
  })

  describe('teste de e-mail', () => {
    it('com a config SALVA: envia pelo SMTP falso, devolve só o destinatário mascarado, auditoria OTHER, sem segredo', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const res = await post(admin, 'test-email')
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body).toMatchObject({ channel: 'email', ok: true, error: null, to: 'd***@exemplo.com.br' })
      expect(smtp.recebidos).toHaveLength(1)
      expect(smtp.recebidos[0].para).toEqual(['dono@exemplo.com.br'])
      expect(smtp.recebidos[0].bruto).toContain('teste_de_comunicacao')
      expect(JSON.stringify(res.body)).not.toContain(SEGREDO_SMTP)
      const linhas = (await esperarAuditoria(admin.id, 2)).filter((l) => l.actionDetail === 'test_email:ok')
      expect(linhas).toHaveLength(1)
      expect(linhas[0]).toMatchObject({ action: 'OTHER', outcome: 'SUCCESS', changes: null })
    })

    it('com config NÃO salva no corpo (outro host + senha nova): usa o corpo, NÃO persiste nada; sem a senha nova => 400 (a salva não é reaproveitada)', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const antes = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      const servidor2 = await iniciarSmtpFalso()
      try {
        const semSenha = await post(admin, 'test-email', { to: 'teste@exemplo.com.br', config: { host: 'localhost', port: servidor2.porta } })
        expect(semSenha.status).toBe(400)
        expect(semSenha.body.code).toBe('SECRET_REQUIRED_FOR_NEW_DESTINATION')
        expect(servidor2.recebidos).toHaveLength(0)

        const ok = await post(admin, 'test-email', { to: 'teste@exemplo.com.br', config: { host: '127.0.0.1', port: servidor2.porta, password: 'senha-do-novo' } })
        expect(ok.status, dump(ok.body)).toBe(200)
        expect(ok.body).toMatchObject({ ok: true, to: 't***@exemplo.com.br' })
        expect(servidor2.recebidos).toHaveLength(1)
        expect(smtp.recebidos).toHaveLength(0)
      } finally {
        await servidor2.fechar()
      }
      const depois = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime())
      expect(depois.smtpPort).toBe(antes.smtpPort)
      expect(logsTodos.join('')).not.toContain('senha-do-novo')
    })

    it('falha do SMTP é o RESULTADO (200, ok:false, código tratado, sem segredo nem mensagem crua): login recusado e servidor inalcançável', async () => {
      const admin = await novoUsuario()
      const comAuth = await iniciarSmtpFalso({ usuario: 'alertas', senha: 'SENHA-CERTA' })
      try {
        await salvarPadrao(admin, { email: { enabled: true, host: '127.0.0.1', port: comAuth.porta, fromAddress: 'alertas@exemplo.com.br', recipients: ['dono@exemplo.com.br'], user: 'alertas', password: 'SENHA-ERRADA-999' } })
        const res = await post(admin, 'test-email')
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ ok: false, error: { code: 'SMTP_AUTH_FAILED' } })
        expect(JSON.stringify(res.body)).not.toContain('SENHA-ERRADA-999')
        expect(logsTodos.join('')).not.toContain('SENHA-ERRADA-999')
      } finally {
        await comAuth.fechar()
      }
      const inalcancavel = await post(admin, 'test-email', { config: { host: '127.0.0.1', port: 1, password: 'x' } })
      expect(inalcancavel.status).toBe(200)
      expect(inalcancavel.body).toMatchObject({ ok: false, error: { code: 'SMTP_CONNECTION_FAILED' } })
    }, 30_000)

    it('sem configuração e sem destinatário: resultado INVALID_CONFIGURATION (não é erro da rota)', async () => {
      const admin = await novoUsuario()
      const res = await post(admin, 'test-email')
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ ok: false, error: { code: 'INVALID_CONFIGURATION' } })
    })

    it('ANTI-SSRF no teste: em produção um host interno no corpo vira DESTINATION_BLOCKED/INVALID (nenhuma conexão aberta)', async () => {
      const admin = await novoUsuario()
      const nodeEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        const res = await post(admin, 'test-email', { to: 'x@exemplo.com.br', config: { host: '127.0.0.1', port: smtp.porta, fromAddress: 'a@exemplo.com.br' } })
        expect(res.status).toBe(200)
        expect(res.body.ok).toBe(false)
        expect(smtp.recebidos).toHaveLength(0)
        const w = await post(admin, 'test-whatsapp', { to: '5511999999999', config: { baseUrl: 'https://169.254.169.254', instance: 'i', apiKey: 'k-123456' } })
        expect(w.body.ok).toBe(false)
      } finally {
        process.env.NODE_ENV = nodeEnv
      }
    })
  })

  describe('teste de CONEXÃO SMTP (só o handshake)', () => {
    // Os PUTs destes testes emitem "communication_config_changed" pelo logger; com o notificador GLOBAL ligado os e-mails desses avisos chegariam ao SMTP falso em instantes
    // aleatórios e contaminariam os testes seguintes. Aqui ele fica desligado (e volta ao padrão preguiçoso ao final).
    beforeAll(async () => (await import('../../src/lib/alertas/hookLogger')).definirNotificadorParaTeste(null))
    afterAll(async () => (await import('../../src/lib/alertas/hookLogger')).definirNotificadorParaTeste(undefined))
    const postConexao = (u: { token: string }, body: Record<string, unknown> = {}) => request(app).post('/api/admin/communication-settings/test-smtp-connection').set(auth(u)).send(body)

    it('só ADMIN (401/403) e corpo estrito (campo desconhecido = 400)', async () => {
      expect((await request(app).post('/api/admin/communication-settings/test-smtp-connection').send({})).status).toBe(401)
      for (const role of ['OPERATOR', 'DRIVER'] as const) expect((await postConexao(await novoUsuario(role))).status).toBe(403)
      const admin = await novoUsuario()
      expect((await postConexao(admin, { to: 'x@exemplo.com.br' })).status).toBe(400)
      expect((await postConexao(admin, { config: { enabled: true } })).status).toBe(400)
    })

    it('config SALVA: stage OK, NENHUMA mensagem enviada ao servidor, sem segredo na resposta, auditoria OTHER sem corpo', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const res = await postConexao(admin)
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body).toMatchObject({ ok: true, stage: 'OK', code: null, message: null, authenticated: false })
      expect(typeof res.body.durationMs).toBe('number')
      expect(Object.keys(res.body).sort()).toEqual(['authenticated', 'code', 'durationMs', 'message', 'ok', 'stage', 'testedAt'])
      expect(smtp.recebidos).toHaveLength(0)
      expect(JSON.stringify(res.body)).not.toContain(SEGREDO_SMTP)
      const linhas = (await esperarAuditoria(admin.id, 2)).filter((l) => l.actionDetail === 'test_smtp_connection:ok')
      expect(linhas).toHaveLength(1)
      expect(linhas[0]).toMatchObject({ action: 'OTHER', outcome: 'SUCCESS', changes: null })
    })

    it('login recusado = stage AUTH; porta fechada = stage CONNECT; autenticou = authenticated true; nada de segredo nem texto cru em resposta/log/auditoria', async () => {
      const admin = await novoUsuario()
      const comAuth = await iniciarSmtpFalso({ usuario: 'alertas', senha: 'SENHA-CERTA-XYZ' })
      try {
        await salvarPadrao(admin, { email: { enabled: true, host: '127.0.0.1', port: comAuth.porta, fromAddress: 'alertas@exemplo.com.br', recipients: ['dono@exemplo.com.br'], user: 'alertas', password: 'SENHA-ERRADA-999' } })
        const erro = await postConexao(admin)
        expect(erro.status).toBe(200)
        expect(erro.body).toMatchObject({ ok: false, stage: 'AUTH', code: 'SMTP_AUTH_FAILED', authenticated: false })
        expect(typeof erro.body.message).toBe('string')

        const certo = await postConexao(admin, { config: { password: 'SENHA-CERTA-XYZ' } })
        expect(certo.body).toMatchObject({ ok: true, stage: 'OK', code: null, authenticated: true })
        expect(comAuth.recebidos).toHaveLength(0)
        for (const t of [JSON.stringify(erro.body), JSON.stringify(certo.body), logsTodos.join('')]) {
          expect(t).not.toContain('SENHA-ERRADA-999')
          expect(t).not.toContain('SENHA-CERTA-XYZ')
          expect(t).not.toContain('Invalid login')
        }
      } finally {
        await comAuth.fechar()
      }
      const fechada = await postConexao(admin, { config: { host: '127.0.0.1', port: 1, password: 'x' } })
      expect(fechada.body).toMatchObject({ ok: false, stage: 'CONNECT', code: 'SMTP_CONNECTION_FAILED' })
      const auditorias = (await esperarAuditoria(admin.id, 3)).map((l) => JSON.stringify(l))
      for (const a of auditorias) {
        expect(a).not.toContain('SENHA-ERRADA-999')
        expect(a).not.toContain('SENHA-CERTA-XYZ')
      }
    }, 30_000)

    it('ANTI-EXFILTRAÇÃO: trocar o host sem reenviar a senha é 400 e NENHUMA conexão é aberta; com a senha nova, a salva continua intocada', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const outroSmtp = await iniciarSmtpFalso({ usuario: 'u', senha: 'senha-nova-1' })
      try {
        const semSenha = await postConexao(admin, { config: { host: 'localhost', port: outroSmtp.porta } })
        expect(semSenha.status).toBe(400)
        expect(semSenha.body.code).toBe('SECRET_REQUIRED_FOR_NEW_DESTINATION')
        const comSenha = await postConexao(admin, { config: { host: '127.0.0.1', port: outroSmtp.porta, user: 'u', password: 'senha-nova-1' } })
        expect(comSenha.body).toMatchObject({ ok: true, stage: 'OK', authenticated: true })
      } finally {
        await outroSmtp.fechar()
      }
      const depois = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(depois.smtpPort).toBe(smtp.porta)
    })

    it('ANTI-SSRF: em produção um host interno é bloqueado em CONNECT (nenhuma conexão); sem host configurado é INVALID_CONFIGURATION (200)', async () => {
      const admin = await novoUsuario()
      const semHost = await postConexao(admin)
      expect(semHost.status).toBe(200)
      expect(semHost.body).toMatchObject({ ok: false, stage: 'CONNECT', code: 'INVALID_CONFIGURATION' })
      const nodeEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        const res = await postConexao(admin, { config: { host: '127.0.0.1', port: smtp.porta, fromAddress: 'a@exemplo.com.br' } })
        expect(res.status).toBe(200)
        expect(res.body.ok).toBe(false)
        expect(res.body.stage).toBe('CONNECT')
        expect(smtp.recebidos).toHaveLength(0)
      } finally {
        process.env.NODE_ENV = nodeEnv
      }
    })

    it('rate limit curto: o 6º pedido no minuto é 429', async () => {
      const admin = await novoUsuario()
      const codigos: number[] = []
      for (let i = 0; i < 6; i += 1) codigos.push((await postConexao(admin)).status)
      expect(codigos.slice(0, 5).every((c) => c === 200)).toBe(true)
      expect(codigos[5]).toBe(429)
    })
  })

  describe('verificador de DNS do domínio remetente (GET /domain-check)', () => {
    // Os PUTs destes testes emitem "communication_config_changed" pelo logger; com o notificador GLOBAL ligado os e-mails desses avisos chegariam ao SMTP falso em instantes
    // aleatórios e contaminariam os testes seguintes. Aqui ele fica desligado (e volta ao padrão preguiçoso ao final).
    beforeAll(async () => (await import('../../src/lib/alertas/hookLogger')).definirNotificadorParaTeste(null))
    afterAll(async () => (await import('../../src/lib/alertas/hookLogger')).definirNotificadorParaTeste(undefined))
    const consultar = (u: { token: string }, qs = '') => request(app).get(`/api/admin/communication-settings/domain-check${qs}`).set(auth(u))

    it('só ADMIN; query desconhecida (tentar passar o domínio) e seletor inválido são 400 — o domínio NUNCA vem do cliente', async () => {
      expect((await request(app).get('/api/admin/communication-settings/domain-check')).status).toBe(401)
      for (const role of ['OPERATOR', 'DRIVER'] as const) expect((await consultar(await novoUsuario(role))).status).toBe(403)
      const admin = await novoUsuario()
      for (const qs of ['?domain=evil.com', '?selector=a.b', '?selector=a/b', '?selector=-x', `?selector=${'a'.repeat(64)}`, '?selector=x&selector=y']) {
        expect((await consultar(admin, qs)).status, qs).toBe(400)
      }
      expect(dns.consultados).toEqual([])
    })

    it('sem e-mail remetente configurado: 200 senderConfigured=false e NENHUMA consulta DNS', async () => {
      const admin = await novoUsuario()
      const res = await consultar(admin)
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body).toMatchObject({ senderConfigured: false, domain: null, overallStatus: null })
      expect(dns.consultados).toEqual([])
    })

    it('usa o domínio do remetente SALVO (painel) e o seletor da query; devolve só TXT público e textos do sistema', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin, { email: { enabled: true, host: 'smtp.gmail.com', port: 587, fromAddress: 'Aviso@Empresa.com.br', recipients: ['dono@exemplo.com.br'], user: null, password: SEGREDO_SMTP } })
      dns.mapa = {
        'empresa.com.br': ['v=spf1 include:_spf.google.com ~all'],
        '_dmarc.empresa.com.br': ['v=DMARC1; p=none'],
        'google._domainkey.empresa.com.br': ['v=DKIM1; k=rsa; p=ABCDEF'],
      }
      const res = await consultar(admin, '?selector=google')
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body).toMatchObject({ senderConfigured: true, domain: 'empresa.com.br', overallStatus: 'ATENCAO', spf: { status: 'OK' }, dmarc: { status: 'ATENCAO' }, dkim: { status: 'OK' } })
      expect(res.body.smtpProvider).toContain('Google')
      expect([...dns.consultados].sort()).toEqual(['_dmarc.empresa.com.br', 'empresa.com.br', 'google._domainkey.empresa.com.br'])
      expect(res.headers['cache-control']).toBe('no-store')
      const texto = JSON.stringify(res.body)
      expect(texto).not.toContain(SEGREDO_SMTP)
      expect(texto).not.toContain('dono@exemplo.com.br') // destinatário de alerta não vaza
    })

    it('falha do DNS é ERRO no registro (200), nunca 500; sem seletor o DKIM pede o seletor', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin, { email: { enabled: true, host: '127.0.0.1', port: smtp.porta, fromAddress: 'aviso@empresa.com.br', recipients: ['dono@exemplo.com.br'], user: null, password: SEGREDO_SMTP } })
      dns.mapa = { 'empresa.com.br': Object.assign(new Error('boom 10.9.8.7'), { code: 'ECONNREFUSED' }) }
      const res = await consultar(admin)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ overallStatus: 'ERRO', spf: { status: 'ERRO' }, dkim: { status: 'ATENCAO', nomeConsultado: null } })
      expect(JSON.stringify(res.body)).not.toContain('10.9.8.7')
    })

    it('rate limit curto: o 7º pedido no minuto é 429', async () => {
      const admin = await novoUsuario()
      const codigos: number[] = []
      for (let i = 0; i < 7; i += 1) codigos.push((await consultar(admin)).status)
      expect(codigos.slice(0, 6).every((c) => c === 200)).toBe(true)
      expect(codigos[6]).toBe(429)
    })
  })

  describe('teste de WhatsApp (Evolution)', () => {
    it('com a config SALVA: POST /message/sendText/{instancia} com a apikey DECIFRADA no header e {number,text}; resposta sem segredo', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const res = await post(admin, 'test-whatsapp')
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body).toMatchObject({ channel: 'whatsapp', ok: true, error: null, to: '5511*****9999' })
      expect(evolution.recebidas).toHaveLength(1)
      const r = evolution.recebidas[0]
      expect(r.url).toBe('/message/sendText/minha-inst')
      expect(r.cabecalhos.apikey).toBe(APIKEY)
      expect(Object.keys(r.json as object).sort()).toEqual(['number', 'text'])
      expect((r.json as { number: string }).number).toBe('5511999999999')
      expect(JSON.stringify(res.body)).not.toContain(APIKEY)
      expect(logsTodos.join('')).not.toContain(APIKEY)
    })

    it('versão 1 usa textMessage; códigos tratados para 401/403, 404, 5xx e redirect (NÃO segue)', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      await put(admin, { currentPassword: SENHA_ADMIN_TESTE, whatsapp: { apiVersion: 1 } })
      expect((await post(admin, 'test-whatsapp')).body.ok).toBe(true)
      expect(Object.keys(evolution.recebidas[0].json as object).sort()).toEqual(['number', 'textMessage'])

      const casos: Array<[number, string]> = [[401, 'WHATSAPP_AUTH_FAILED'], [403, 'WHATSAPP_AUTH_FAILED'], [404, 'WHATSAPP_INSTANCE_OR_URL_NOT_FOUND'], [500, 'WHATSAPP_PROVIDER_ERROR'], [400, 'WHATSAPP_REJECTED']]
      for (const [status, code] of casos) {
        evolution.responder((_r, res) => res.writeHead(status).end('{"segredo":"NAO-REPASSAR"}'))
        const res = await post(await novoUsuario(), 'test-whatsapp')
        expect(res.status).toBe(200)
        expect(res.body, String(status)).toMatchObject({ ok: false, error: { code } })
        expect(JSON.stringify(res.body)).not.toContain('NAO-REPASSAR')
      }
      evolution.responder((_r, res) => res.writeHead(302, { location: `${outro.base}/roubado` }).end())
      const red = await post(await novoUsuario(), 'test-whatsapp')
      expect(red.body).toMatchObject({ ok: false, error: { code: 'WHATSAPP_REDIRECT' } })
      expect(outro.recebidas).toHaveLength(0) // a apikey não foi para outro host
    })

    it('config no corpo (URL nova) sem apikey => 400; com apikey nova usa a nova e não persiste', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const antes = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      const semChave = await post(admin, 'test-whatsapp', { to: '5511988887777', config: { baseUrl: outro.base } })
      expect(semChave.status).toBe(400)
      expect(semChave.body.code).toBe('SECRET_REQUIRED_FOR_NEW_DESTINATION')
      expect(outro.recebidas).toHaveLength(0)
      const ok = await post(admin, 'test-whatsapp', { to: '5511988887777', config: { baseUrl: outro.base, apiKey: 'CHAVE-NOVA-12345' } })
      expect(ok.body).toMatchObject({ ok: true, to: '5511*****7777' })
      expect(outro.recebidas).toHaveLength(1)
      expect(outro.recebidas[0].cabecalhos.apikey).toBe('CHAVE-NOVA-12345')
      expect(evolution.recebidas).toHaveLength(0)
      const depois = await m.prisma.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(depois.evolutionBaseUrl).toBe(antes.evolutionBaseUrl)
      expect(depois.evolutionApiKeyCiphertext).toBe(antes.evolutionApiKeyCiphertext)
    })

    it('rate limit curto: o 6º teste em 1 minuto => 429 RATE_LIMITED_COMMUNICATION_SETTINGS (por usuário)', async () => {
      const admin = await novoUsuario()
      const outroAdmin = await novoUsuario()
      for (let i = 0; i < 5; i++) expect((await post(admin, 'test-whatsapp')).status).toBe(200)
      const barrado = await post(admin, 'test-whatsapp')
      expect(barrado.status).toBe(429)
      expect(barrado.body.code).toBe('RATE_LIMITED_COMMUNICATION_SETTINGS')
      expect((await post(outroAdmin, 'test-whatsapp')).status).toBe(200) // o balde é por usuário
    })
  })

  describe('o notificador usa a config do painel (e acompanha mudanças)', () => {
    it('alerta CRITICO sai pelo canal do BANCO; depois de DESLIGAR no painel, o próximo alerta não sai (config relida)', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const provedor = async () => {
        const r = await m.cfg.getConfigComunicacao()
        return { config: r.config, canais: m.inst.montarCanais(r.config) }
      }
      const n = new m.notif.Notificador({ provedor, ttlConfigMs: 1, store: new m.dedupe.MemoriaDedupeStore(), log: () => {} })
      n.notificar({ alerta: 'payment_void_manual_review', nivelPino: 50, mensagem: 'x', dados: { paymentIntentId: 'pi_painel_1' } })
      await n.aguardarOcioso()
      expect(smtp.recebidos.filter((x) => x.bruto.includes('pi_painel_1'))).toHaveLength(1)
      expect(evolution.recebidas.filter((x) => x.corpo.includes('pi_painel_1'))).toHaveLength(1)

      await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { enabled: false }, whatsapp: { enabled: false } })
      await new Promise((r) => setTimeout(r, 10))
      n.notificar({ alerta: 'payment_void_manual_review', nivelPino: 50, mensagem: 'x', dados: { paymentIntentId: 'pi_painel_2' } })
      await n.aguardarOcioso()
      expect(smtp.recebidos.filter((x) => x.bruto.includes('pi_painel_2'))).toHaveLength(0)
      expect(evolution.recebidas.filter((x) => x.corpo.includes('pi_painel_2'))).toHaveLength(0)
    })

    it('o SERVIÇO emite "communication_config_changed" ANTES de invalidar o cache (no instante do alerta o cache ainda tem os destinatários antigos)', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      await m.cfg.getConfigComunicacao() // aquece o cache com a config antiga
      let destinatariosNoAlerta: string[] | undefined
      const espiao = vi.spyOn(m.logger, 'warn').mockImplementation(((...args: unknown[]) => {
        const a0 = args[0] as { alert?: string } | undefined
        if (a0?.alert === 'communication_config_changed') destinatariosNoAlerta = m.cfg.configEmCacheParaTeste()?.config.email?.para
      }) as never)
      try {
        await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { recipients: ['atacante@exemplo.com.br'] } })
      } finally {
        espiao.mockRestore()
      }
      expect(destinatariosNoAlerta).toEqual(['dono@exemplo.com.br'])
      expect(m.cfg.configEmCacheParaTeste()?.config.email?.para).toEqual(['atacante@exemplo.com.br']) // e DEPOIS foi invalidado e relido (a resposta do PUT relê a config nova)
    })

    it('o aviso "communication_config_changed" sai pela config ANTIGA (quem troca o destinatário não silencia o próprio aviso)', async () => {
      const admin = await novoUsuario()
      await salvarPadrao(admin)
      const provedor = async () => {
        const r = await m.cfg.getConfigComunicacao()
        return { config: r.config, canais: m.inst.montarCanais(r.config) }
      }
      const n = new m.notif.Notificador({ provedor, ttlConfigMs: 60_000, store: new m.dedupe.MemoriaDedupeStore(), log: () => {} })
      n.notificar({ alerta: 'ocpp_message_flood', nivelPino: 40, mensagem: 'aquece o snapshot', dados: { chargePointId: 'cp_aquece' } })
      await n.aguardarOcioso()
      smtp.recebidos.length = 0
      // simula o que o serviço faz: emite o alerta ANTES de invalidar o cache
      n.notificar({ alerta: 'communication_config_changed', nivelPino: 40, mensagem: 'config alterada', dados: { actorUserId: admin.id, changedFields: ['email.recipients'] } })
      await put(admin, { currentPassword: SENHA_ADMIN_TESTE, email: { recipients: ['atacante@exemplo.com.br'] } })
      await n.aguardarOcioso()
      expect(smtp.recebidos).toHaveLength(1)
      expect(smtp.recebidos[0].para).toEqual(['dono@exemplo.com.br'])
    })
  })
})
