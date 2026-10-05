import { createHash } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { iniciarSmtpFalso, type SmtpFalso } from '../unit/helpers/servidoresFalsos'

/**
 * L1.3 — "Esqueci minha senha" / redefinição por e-mail, ponta a ponta contra Postgres + Redis REAIS e SMTP falso (smtp-server). Prova (cada item é uma asserção abaixo):
 * sempre 202 e MESMA resposta para e-mail inexistente/ADMIN/inativo/só-Google/existente; sem enumeração por TEMPO (a rota só enfileira — prova estrutural com SMTP que nunca
 * responde + medição); token de 256 bits, só o HASH no Redis; uso único atômico (corrida); expiração; token no FRAGMENTO e origem do link vinda de configuração (Host
 * forjado não influencia); sessões revogadas, sem auto-login; política de senha igual à da troca; limites por IP/e-mail e contador de tokens inválidos; DL1 (ADMIN só pelo
 * script, com auditoria); nada de token/senha/e-mail em log nem em auditoria.
 */

const SENHA_ANTIGA = 'Senha-Antiga#2026'
const SENHA_NOVA = 'Senha-Nova-Forte#2026'
const BASE_APP = 'https://app.innoflow.test'
const HASH_ANTIGO = bcrypt.hashSync(SENHA_ANTIGA, 4) // custo 4 só para o teste ser rápido (login lê o custo do próprio hash)

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: typeof import('../../src/lib/env').env
  logger: typeof import('../../src/lib/logger').logger
  inst: typeof import('../../src/services/auth/redefinicaoSenhaInstancia')
  tokens: typeof import('../../src/services/auth/tokensRedefinicaoRedis')
  core: typeof import('../../src/core/auth/redefinicaoSenha')
  cfg: typeof import('../../src/services/comunicacao/configComunicacao')
}

const dump = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : x))
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const mediana = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

describe('redefinição de senha por e-mail (L1.3) — Postgres + Redis reais, SMTP falso', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let smtp: SmtpFalso
  const logsTodos: string[] = []
  let contador = 0

  beforeAll(async () => {
    smtp = await iniciarSmtpFalso()
    banco = await criarBancoProprio('rst')
    for (const k of Object.keys(process.env)) if (k.startsWith('ALERT_') || k.startsWith('COMMUNICATION_')) delete process.env[k]
    Object.assign(process.env, {
      ALERT_EMAIL_TO: 'dono@exemplo.com.br',
      ALERT_SMTP_HOST: '127.0.0.1',
      ALERT_SMTP_PORT: String(smtp.porta),
      ALERT_EMAIL_FROM: 'InnoFlow <nao-responder@innoflow.test>',
      COMMUNICATION_DISABLE_DB_CONFIG: 'true',
      PUBLIC_APP_URL: BASE_APP,
      PASSWORD_RESET_MAX_EMAILS_PER_HOUR: '100000',
    })
    const [appMod, prismaMod, redisMod, envMod, loggerMod, instMod, tokMod, coreMod, cfgMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/logger'),
      import('../../src/services/auth/redefinicaoSenhaInstancia'),
      import('../../src/services/auth/tokensRedefinicaoRedis'),
      import('../../src/core/auth/redefinicaoSenha'),
      import('../../src/services/comunicacao/configComunicacao'),
    ])
    m = { createApp: appMod.createApp, prisma: prismaMod.prisma, redis: redisMod.redis, env: envMod.env, logger: loggerMod.logger, inst: instMod, tokens: tokMod, core: coreMod, cfg: cfgMod }
    app = m.createApp()
    for (const nivel of ['info', 'warn', 'error', 'debug'] as const) {
      const original = m.logger[nivel].bind(m.logger) as (...a: unknown[]) => void
      vi.spyOn(m.logger, nivel).mockImplementation(((...args: unknown[]) => {
        logsTodos.push(dump(args))
        original(...args)
      }) as never)
    }
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await m?.inst.filaDeEmailsDeSenha.aguardarOciosa()
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
    await smtp.fechar()
  }, 60_000)

  beforeEach(async () => {
    await m.inst.filaDeEmailsDeSenha.aguardarOciosa()
    smtp.recebidos.length = 0
    logsTodos.length = 0
  })

  // ---------------------------------------------------------------------------------------------- helpers

  const ipUnico = (): string => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`

  async function novaConta(extra: { role?: 'ADMIN' | 'OPERATOR' | 'DRIVER'; active?: boolean; googleSub?: string; semSenha?: boolean } = {}) {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 8)}`
    const role = extra.role ?? 'DRIVER'
    let operatorId: string | null = null
    if (role === 'OPERATOR') operatorId = (await m.prisma.operator.create({ data: { name: `Op ${sufixo}`, email: `op-${sufixo}@example.com` } })).id
    const user = await m.prisma.user.create({
      data: {
        role,
        name: `Maria Teste ${sufixo}`,
        email: `${role.toLowerCase()}-${sufixo}@example.com`,
        operatorId,
        active: extra.active ?? true,
        googleSub: extra.googleSub ?? null,
        passwordHash: extra.semSenha ? null : HASH_ANTIGO,
      },
    })
    return user
  }

  const forgot = (email: unknown, ip = ipUnico(), extraHeaders: Record<string, string> = {}) => request(app).post('/api/auth/password/forgot').set('X-Forwarded-For', ip).set(extraHeaders).send({ email })
  const reset = (token: unknown, newPassword: unknown, ip = ipUnico()) => request(app).post('/api/auth/password/reset').set('X-Forwarded-For', ip).send({ token, newPassword })
  const login = (email: string, password: string) => request(app).post('/api/auth/login').set('X-Forwarded-For', ipUnico()).send({ email, password })

  const aguardarFila = () => m.inst.filaDeEmailsDeSenha.aguardarOciosa()
  const emailsPara = (email: string) => smtp.recebidos.filter((r) => r.para.includes(email))

  /** Pede o link e devolve o token extraído do e-mail recebido (do TEXTO PURO, que carrega o link por extenso). */
  async function pedirLink(email: string): Promise<string> {
    expect((await forgot(email)).status).toBe(202)
    await aguardarFila()
    const emails = emailsPara(email)
    expect(emails.length).toBeGreaterThan(0)
    const achado = /https:\/\/app\.innoflow\.test\/redefinir-senha#t=([A-Za-z0-9_-]{43})/.exec(emails[emails.length - 1].bruto)
    expect(achado).not.toBeNull()
    return achado![1]
  }

  // ---------------------------------------------------------------------------------------------- forgot: sempre 202, mesma forma

  it('e-mail EXISTENTE: 202 { ok: true }, e-mail enviado à conta com link no FRAGMENTO e origem de configuração', async () => {
    const u = await novaConta()
    const r = await forgot(u.email)
    expect(r.status).toBe(202)
    expect(r.body).toEqual({ ok: true })
    await aguardarFila()
    const e = emailsPara(u.email)
    expect(e).toHaveLength(1)
    expect(e[0].bruto).toMatch(/Subject:.*Redefini/)
    expect(e[0].bruto).toContain('Redefina sua senha')
    expect(e[0].bruto).toContain('30 minutos')
    expect(e[0].bruto).toMatch(/ignorar este e-mail/)
    expect(e[0].bruto).toMatch(/Content-Type: text\/html/i) // multipart: HTML + texto
    expect(e[0].bruto).toContain('InnoFlow')
    const link = /(https:\/\/app\.innoflow\.test\/redefinir-senha#t=[A-Za-z0-9_-]{43})/.exec(e[0].bruto)![1]
    const url = new URL(link)
    expect(url.origin).toBe(BASE_APP)
    expect(url.pathname).toBe('/redefinir-senha')
    expect(url.search).toBe('') // nada em query
    expect(e[0].bruto).not.toMatch(/[?&]t(oken)?=/)
  })

  it('MESMO corpo, status e cabeçalhos relevantes para: inexistente, ADMIN, inativo, só-Google e existente', async () => {
    const existente = await novaConta()
    const admin = await novaConta({ role: 'ADMIN' })
    const inativo = await novaConta({ active: false })
    const google = await novaConta({ googleSub: `g-${Math.random()}`, semSenha: true })
    const alvos = [`ninguem-${Math.random().toString(36).slice(2)}@example.com`, admin.email, inativo.email, google.email, existente.email]
    const respostas = []
    for (const email of alvos) respostas.push(await forgot(email))
    for (const r of respostas) {
      expect(r.status).toBe(202)
      expect(r.text).toBe('{"ok":true}')
      expect(r.headers['content-type']).toBe(respostas[0].headers['content-type'])
      expect(r.headers['content-length']).toBe(respostas[0].headers['content-length'])
    }
    await aguardarFila()
  })

  it('só RECEBE e-mail quem deve: existente (link), só-Google (aviso SEM token); ADMIN, inativo e inexistente NADA', async () => {
    const existente = await novaConta()
    const admin = await novaConta({ role: 'ADMIN' })
    const inativo = await novaConta({ active: false })
    const google = await novaConta({ googleSub: `g-${Math.random()}`, semSenha: true })
    const fantasma = `fantasma-${Math.random().toString(36).slice(2)}@example.com`
    for (const email of [existente.email, admin.email, inativo.email, google.email, fantasma]) expect((await forgot(email)).status).toBe(202)
    await aguardarFila()

    expect(emailsPara(existente.email)).toHaveLength(1)
    expect(emailsPara(admin.email)).toHaveLength(0)
    expect(emailsPara(inativo.email)).toHaveLength(0)
    expect(emailsPara(fantasma)).toHaveLength(0)

    const aviso = emailsPara(google.email)
    expect(aviso).toHaveLength(1)
    expect(aviso[0].bruto).toContain('Subject: Sua conta InnoFlow entra com o Google')
    expect(aviso[0].bruto).not.toContain('redefinir-senha')
    // nenhum token foi emitido para o só-Google nem para o ADMIN
    expect(await m.redis.get(`pwdreset:user:${google.id}`)).toBeNull()
    expect(await m.redis.get(`pwdreset:user:${admin.id}`)).toBeNull()
    expect(await m.redis.get(`pwdreset:user:${existente.id}`)).not.toBeNull()
  })

  it('ADMIN: a tentativa fica na AUDITORIA (PASSWORD_RESET/DENIED), sem token nem senha', async () => {
    const admin = await novaConta({ role: 'ADMIN' })
    await forgot(admin.email)
    await aguardarFila()
    const linhas = await m.prisma.auditLog.findMany({ where: { actorUserId: admin.id, action: 'PASSWORD_RESET' } })
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({ outcome: 'DENIED', actionDetail: 'password_reset_denied_admin', actorRole: 'ADMIN', httpStatus: 202 })
    expect(JSON.stringify(linhas[0])).not.toMatch(/pwdreset|token/i)
  })

  it('e-mail MALFORMADO: 400 VALIDATION_ERROR (não revela nada sobre contas); sem corpo também', async () => {
    for (const ruim of ['sem-arroba', '', 'a@', 123, null, 'a'.repeat(200) + '@x.com']) {
      const r = await forgot(ruim)
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('VALIDATION_ERROR')
    }
    expect((await request(app).post('/api/auth/password/forgot').set('X-Forwarded-For', ipUnico()).send({})).status).toBe(400)
  })

  it('a caixa do e-mail não importa: MARIA@ acha a conta maria@', async () => {
    const u = await novaConta()
    expect((await forgot(u.email.toUpperCase())).status).toBe(202)
    await aguardarFila()
    expect(emailsPara(u.email)).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------------------------- sem enumeração por tempo

  it('ESTRUTURAL: com o SMTP que NUNCA responde, a resposta do e-mail existente sai na hora (o envio não está no caminho)', async () => {
    const u = await novaConta()
    const sockets = new Set<Socket>()
    const buraco: Server = createServer((s) => {
      sockets.add(s)
    })
    await new Promise<void>((resolve) => buraco.listen(0, '127.0.0.1', resolve))
    const portaOriginal = process.env.ALERT_SMTP_PORT
    process.env.ALERT_SMTP_PORT = String((buraco.address() as { port: number }).port)
    m.cfg.resetCacheComunicacaoParaTeste()
    try {
      const t0 = performance.now()
      const r = await forgot(u.email)
      const ms = performance.now() - t0
      expect(r.status).toBe(202)
      expect(ms).toBeLessThan(1000) // inline levaria >= 5 s (prazo de saudação do SMTP)
      await dormir(300) // a tarefa de fundo já conectou e está pendurada esperando a saudação
      expect(sockets.size).toBeGreaterThan(0)
    } finally {
      for (const s of sockets) s.destroy() // a falha rápida libera a fila
      await aguardarFila()
      await new Promise<void>((resolve) => buraco.close(() => resolve()))
      process.env.ALERT_SMTP_PORT = portaOriginal
      m.cfg.resetCacheComunicacaoParaTeste()
    }
  }, 30_000)

  it('MEDIDO: o tempo de resposta de e-mail existente e inexistente tem a mesma ordem de grandeza', async () => {
    const u = await novaConta()
    const comConta: number[] = []
    const semConta: number[] = []
    await forgot(`aquece-${Math.random()}@example.com`) // aquece o caminho (JIT, conexão)
    await aguardarFila()
    for (let i = 0; i < 7; i++) {
      // o limite por e-mail é silencioso (3/h), então o "existente" repetido continua 202 — e, quando silenciado, faz MENOS trabalho; por isso alterna e-mails existentes distintos
      const v = i === 0 ? u : await novaConta()
      let t0 = performance.now()
      await forgot(v.email)
      comConta.push(performance.now() - t0)
      t0 = performance.now()
      await forgot(`nao-existe-${i}-${Math.random().toString(36).slice(2)}@example.com`)
      semConta.push(performance.now() - t0)
      await aguardarFila()
    }
    const a = mediana(comConta)
    const b = mediana(semConta)
    expect(Math.abs(a - b)).toBeLessThan(25) // ms: ordem de grandeza — o envio inline (SMTP+banco+Redis) somaria dezenas de ms ou mais
  }, 30_000)

  // ---------------------------------------------------------------------------------------------- token: hash, TTL, uso único

  it('Redis guarda SÓ o hash (sha-256), nunca o token; TTL de 30 min; valor sem e-mail', async () => {
    const u = await novaConta()
    const token = await pedirLink(u.email)
    const hash = sha256(token)

    expect(await m.redis.exists(`pwdreset:${hash}`)).toBe(1)
    expect(await m.redis.exists(`pwdreset:${token}`)).toBe(0)
    const ttl = await m.redis.ttl(`pwdreset:${hash}`)
    expect(ttl).toBeGreaterThan(1790)
    expect(ttl).toBeLessThanOrEqual(1800)
    expect(await m.redis.get(`pwdreset:user:${u.id}`)).toBe(hash)

    // varredura: NENHUMA chave nem valor do namespace contém o token em claro
    const chaves = await m.redis.keys('pwdreset:*')
    for (const k of chaves) {
      expect(k).not.toContain(token)
      const v = await m.redis.get(k)
      if (v) expect(v).not.toContain(token)
    }
    const valor = JSON.parse((await m.redis.get(`pwdreset:${hash}`))!) as Record<string, unknown>
    expect(Object.keys(valor).sort()).toEqual(['emitidoEm', 'impressao', 'userId'])
    expect(valor.userId).toBe(u.id)
    expect(JSON.stringify(valor)).not.toContain(u.email)
  })

  it('uso único: o 2º uso do mesmo token é 400 RESET_TOKEN_INVALID', async () => {
    const u = await novaConta()
    const token = await pedirLink(u.email)
    expect((await reset(token, SENHA_NOVA)).status).toBe(204)
    const de_novo = await reset(token, 'Outra-Senha-Forte#1')
    expect(de_novo.status).toBe(400)
    expect(de_novo.body.code).toBe('RESET_TOKEN_INVALID')
    expect((await login(u.email, SENHA_NOVA)).status).toBe(200) // a 2ª tentativa não trocou nada
  })

  it('CORRIDA: 10 resets simultâneos com o mesmo token => exatamente 1 sucesso (consumo atômico)', async () => {
    const u = await novaConta()
    const token = await pedirLink(u.email)
    const respostas = await Promise.all(Array.from({ length: 10 }, (_, i) => reset(token, `Senha-Corrida-Forte#${i}`)))
    expect(respostas.filter((r) => r.status === 204)).toHaveLength(1)
    const falhas = respostas.filter((r) => r.status === 400)
    expect(falhas).toHaveLength(9)
    for (const f of falhas) expect(f.body.code).toBe('RESET_TOKEN_INVALID')
    // e a senha gravada é a do vencedor (uma só das 10), a antiga não vale mais
    expect((await login(u.email, SENHA_ANTIGA)).status).toBe(401)
    const auditorias = await m.prisma.auditLog.count({ where: { actorUserId: u.id, action: 'PASSWORD_RESET', outcome: 'SUCCESS' } })
    expect(auditorias).toBe(1)
  }, 30_000)

  it('EXPIRAÇÃO: token vencido (TTL do Redis) é RESET_TOKEN_INVALID', async () => {
    const u = await novaConta()
    const token = await pedirLink(u.email)
    await m.redis.pexpire(`pwdreset:${sha256(token)}`, 200)
    await dormir(400)
    const r = await reset(token, SENHA_NOVA)
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('RESET_TOKEN_INVALID')
    expect((await login(u.email, SENHA_ANTIGA)).status).toBe(200) // senha antiga intacta
  })

  it('pedir DE NOVO invalida o anterior: só o último link vale', async () => {
    const u = await novaConta()
    const primeiro = await pedirLink(u.email)
    const segundo = await pedirLink(u.email)
    expect(segundo).not.toBe(primeiro)
    const r1 = await reset(primeiro, SENHA_NOVA)
    expect(r1.status).toBe(400)
    expect(r1.body.code).toBe('RESET_TOKEN_INVALID')
    expect((await reset(segundo, SENHA_NOVA)).status).toBe(204)
  })

  it('token malformado/vazio/objeto: 400 RESET_TOKEN_INVALID (um código só) — nunca VALIDATION_ERROR por causa do token', async () => {
    for (const ruim of ['curto', 'a'.repeat(43) + '!', 'a'.repeat(44), 'x'.repeat(150)]) {
      const r = await reset(ruim, SENHA_NOVA)
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('RESET_TOKEN_INVALID')
    }
    // sem token / token que não é string: validação do corpo (400 VALIDATION_ERROR), sem consultar o Redis
    expect((await reset(undefined, SENHA_NOVA)).body.code).toBe('VALIDATION_ERROR')
    expect((await reset({ $ne: 1 }, SENHA_NOVA)).body.code).toBe('VALIDATION_ERROR')
  })

  // ---------------------------------------------------------------------------------------------- host header

  it('HOST HEADER INJECTION: Host/X-Forwarded-Host/Origin/Referer forjados NÃO mudam o domínio do link', async () => {
    const u = await novaConta()
    const r = await forgot(u.email, ipUnico(), {
      Host: 'evil.example.com',
      'X-Forwarded-Host': 'evil.example.com',
      'X-Forwarded-Proto': 'http',
      Referer: 'https://evil.example.com/pagina',
    })
    expect(r.status).toBe(202)
    // Origin forjado nem chega: o CORS recusa (403) antes da rota
    expect((await forgot(u.email, ipUnico(), { Origin: 'https://evil.example.com' })).status).toBe(403)
    await aguardarFila()
    const e = emailsPara(u.email)
    expect(e).toHaveLength(1)
    expect(e[0].bruto).toContain('https://app.innoflow.test/redefinir-senha#t=')
    expect(e[0].bruto).not.toMatch(/evil\.example\.com/i)
    expect(e[0].bruto).not.toContain('http://')
  })

  // ---------------------------------------------------------------------------------------------- reset: efeitos

  it('troca a senha, REVOGA as sessões antigas, NÃO faz auto-login e manda o e-mail "senha alterada"', async () => {
    const u = await novaConta()
    const antigo = jwt.sign({ userId: u.id, role: 'DRIVER', operatorId: null, iat: Math.floor(Date.now() / 1000) - 120 }, m.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' })
    expect((await request(app).get('/api/me/profile').set('Authorization', `Bearer ${antigo}`)).status).toBe(200)

    const token = await pedirLink(u.email)
    const r = await reset(token, SENHA_NOVA)
    expect(r.status).toBe(204)
    expect(r.text).toBe('') // sem corpo => sem JWT de auto-login
    expect(r.headers['set-cookie']).toBeUndefined()

    expect((await request(app).get('/api/me/profile').set('Authorization', `Bearer ${antigo}`)).status).toBe(401) // sessão antiga morreu
    expect((await login(u.email, SENHA_ANTIGA)).status).toBe(401)
    expect((await login(u.email, SENHA_NOVA)).status).toBe(200)
    const noBanco = await m.prisma.user.findUnique({ where: { id: u.id } })
    expect(noBanco!.sessionsValidAfter).not.toBeNull()
    expect(await bcrypt.compare(SENHA_NOVA, noBanco!.passwordHash!)).toBe(true)
    expect(noBanco!.passwordHash).toMatch(/^\$2[aby]\$12\$/) // custo de produção

    await aguardarFila()
    const emails = emailsPara(u.email)
    const confirmacao = emails.find((x) => x.bruto.includes('Subject: Sua senha do InnoFlow foi alterada'))
    expect(confirmacao).toBeDefined()
    expect(confirmacao!.bruto).toContain('desconectado de todos os aparelhos')
    expect(confirmacao!.bruto).not.toContain(SENHA_NOVA)
    expect(confirmacao!.bruto).not.toContain(token)
  })

  it('AUDITORIA do sucesso: PASSWORD_RESET/SUCCESS com o próprio usuário como ator, sem token nem senha', async () => {
    const u = await novaConta()
    const token = await pedirLink(u.email)
    expect((await reset(token, SENHA_NOVA)).status).toBe(204)
    const linhas = await m.prisma.auditLog.findMany({ where: { actorUserId: u.id, action: 'PASSWORD_RESET' } })
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({ outcome: 'SUCCESS', actorRole: 'DRIVER', entityId: u.id, httpStatus: 204, path: '/api/auth/password/reset', actionDetail: 'password_reset_by_email' })
    const texto = JSON.stringify(linhas[0])
    expect(texto).not.toContain(token)
    expect(texto).not.toContain(SENHA_NOVA)
  })

  it('OPERATOR também redefine por e-mail (DL1) — auditoria com o operador', async () => {
    const op = await novaConta({ role: 'OPERATOR' })
    const token = await pedirLink(op.email)
    expect((await reset(token, SENHA_NOVA)).status).toBe(204)
    expect((await login(op.email, SENHA_NOVA)).status).toBe(200)
    const linha = await m.prisma.auditLog.findFirst({ where: { actorUserId: op.id, action: 'PASSWORD_RESET' } })
    expect(linha).toMatchObject({ actorRole: 'OPERATOR', targetOperatorId: op.operatorId, outcome: 'SUCCESS' })
  })

  it('conta com Google VINCULADO mas COM senha recebe o link normal', async () => {
    const u = await novaConta({ googleSub: `g-${Math.random()}` })
    const token = await pedirLink(u.email)
    expect((await reset(token, SENHA_NOVA)).status).toBe(204)
  })

  it('ADMIN: mesmo um token FORJADO no Redis para o ADMIN é recusado (defesa em profundidade) e a senha não muda', async () => {
    const admin = await novaConta({ role: 'ADMIN' })
    const porta = m.tokens.criarTokensDeRedefinicaoRedis(m.redis)
    const token = await porta.emitir(admin.id, m.core.impressaoDaSenha(admin.passwordHash))
    const r = await reset(token, SENHA_NOVA)
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('RESET_TOKEN_INVALID')
    expect((await login(admin.email, SENHA_ANTIGA)).status).toBe(200)
  })

  it('a senha mudou por OUTRO caminho depois do pedido: o link morre (impressão da senha)', async () => {
    const u = await novaConta()
    const token = await pedirLink(u.email)
    await m.prisma.user.update({ where: { id: u.id }, data: { passwordHash: bcrypt.hashSync('Troquei-Por-Outro-Caminho#1', 4) } })
    const r = await reset(token, SENHA_NOVA)
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('RESET_TOKEN_INVALID')
    expect((await login(u.email, 'Troquei-Por-Outro-Caminho#1')).status).toBe(200)
  })

  it('a conta foi desativada depois do pedido: o link não vale', async () => {
    const u = await novaConta()
    const token = await pedirLink(u.email)
    await m.prisma.user.update({ where: { id: u.id }, data: { active: false } })
    const r = await reset(token, SENHA_NOVA)
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('RESET_TOKEN_INVALID')
  })

  it('TOCTOU na gravação: se a senha mudou/ a conta foi desativada ENTRE a leitura e a escrita, a troca não acontece (condicional) e nada é auditado', async () => {
    const u = await novaConta()
    const auditoria = (id: string) => ({
      actorUserId: id,
      actorRole: 'DRIVER' as const,
      actorEmail: u.email,
      actorName: u.name,
      action: 'PASSWORD_RESET' as const,
      actionDetail: 'password_reset_by_email',
      outcome: 'SUCCESS' as const,
      httpStatus: 204,
      entityType: 'User',
      entityId: id,
      method: 'POST',
      path: '/api/auth/password/reset',
    })
    const novoHash = bcrypt.hashSync(SENHA_NOVA, 4)

    // 1) outra troca de senha aconteceu depois da leitura: o `hashEsperado` ficou velho
    const hashLido = (await m.prisma.user.findUnique({ where: { id: u.id } }))!.passwordHash
    await m.prisma.user.update({ where: { id: u.id }, data: { passwordHash: bcrypt.hashSync('Outra-Troca-No-Meio#1', 4) } })
    expect(await m.inst.repoDeContasPrisma.trocarSenha({ id: u.id, hashEsperado: hashLido, novoHash, agora: new Date(), auditoria: auditoria(u.id) })).toBe(false)
    expect(await bcrypt.compare('Outra-Troca-No-Meio#1', (await m.prisma.user.findUnique({ where: { id: u.id } }))!.passwordHash!)).toBe(true)

    // 2) conta desativada no meio
    const v = await novaConta()
    await m.prisma.user.update({ where: { id: v.id }, data: { active: false } })
    expect(await m.inst.repoDeContasPrisma.trocarSenha({ id: v.id, hashEsperado: v.passwordHash, novoHash, agora: new Date(), auditoria: auditoria(v.id) })).toBe(false)

    expect(await m.prisma.auditLog.count({ where: { actorUserId: { in: [u.id, v.id] }, action: 'PASSWORD_RESET' } })).toBe(0)

    // 3) auditoria que FALHA (campo obrigatório ausente => lança DEPOIS do UPDATE, dentro da transação) derruba a troca inteira (fail-closed)
    const w = await novaConta()
    await expect(
      m.inst.repoDeContasPrisma.trocarSenha({ id: w.id, hashEsperado: w.passwordHash, novoHash, agora: new Date(), auditoria: { ...auditoria(w.id), method: null as never } }),
    ).rejects.toThrow()
    expect((await m.prisma.user.findUnique({ where: { id: w.id } }))!.passwordHash).toBe(w.passwordHash) // a senha NÃO mudou sem o registro de auditoria
  })

  // ---------------------------------------------------------------------------------------------- política de senha

  it('senha FRACA recusada (400 VALIDATION_ERROR por campo) e o token continua valendo para a senha boa', async () => {
    const u = await novaConta()
    const token = await pedirLink(u.email)
    for (const fraca of ['curta123', 'abcdefghi', '']) {
      const r = await reset(token, fraca)
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('VALIDATION_ERROR')
      expect(r.body.details[0].path).toBe('newPassword')
    }
    expect((await reset(token, 'a'.repeat(73))).body.code).toBe('VALIDATION_ERROR') // 73 bytes: o bcrypt truncaria
    expect((await reset(token, 'ç'.repeat(37))).body.code).toBe('VALIDATION_ERROR') // 74 BYTES em UTF-8 (37 caracteres)
    expect((await reset(token, 'a'.repeat(72))).status).toBe(204) // 72 bytes ainda passa; o token NÃO foi gasto pelas recusas
  })

  // ---------------------------------------------------------------------------------------------- limites

  it('RATE LIMIT por IP no forgot: a 6ª em 15 min é 429 RATE_LIMITED_AUTH', async () => {
    const ip = ipUnico()
    for (let i = 0; i < 5; i++) expect((await forgot(`x${i}-${Math.random()}@example.com`, ip)).status).toBe(202)
    const r = await forgot('x6@example.com', ip)
    expect(r.status).toBe(429)
    expect(r.body.code).toBe('RATE_LIMITED_AUTH')
    expect((await forgot('x7@example.com', ipUnico())).status).toBe(202) // outro IP segue normal
  })

  it('limite POR E-MAIL é SILENCIOSO: IPs diferentes, mesmo e-mail — 6 pedidos, todos 202, só 3 e-mails', async () => {
    const u = await novaConta()
    for (let i = 0; i < 6; i++) expect((await forgot(u.email, ipUnico())).status).toBe(202)
    await aguardarFila()
    expect(emailsPara(u.email)).toHaveLength(3)
  })

  it('tokens INVÁLIDOS por IP: após 10, o IP é bloqueado (429 + Retry-After) SEM gastar um token válido; outro IP segue', async () => {
    const u = await novaConta()
    const token = await pedirLink(u.email)
    const ipRuim = ipUnico()
    for (let i = 0; i < 10; i++) {
      const r = await reset(m.core.gerarTokenRedefinicao(), SENHA_NOVA, ipRuim)
      expect(r.status).toBe(400)
    }
    const bloqueado = await reset(token, SENHA_NOVA, ipRuim) // token VÁLIDO, mas o IP já estourou
    expect(bloqueado.status).toBe(429)
    expect(bloqueado.body.code).toBe('RATE_LIMITED_AUTH')
    expect(Number(bloqueado.headers['retry-after'])).toBeGreaterThan(0)
    expect(await m.redis.exists(`pwdreset:${sha256(token)}`)).toBe(1) // não foi consumido pelo bloqueio
    expect((await reset(token, SENHA_NOVA, ipUnico())).status).toBe(204) // de outro IP, vale
  })

  // ---------------------------------------------------------------------------------------------- armazém (Redis real)

  it('armazém: emitir → consumir é de uso único; 20 consumos simultâneos => exatamente 1 valor', async () => {
    const porta = m.tokens.criarTokensDeRedefinicaoRedis(m.redis)
    const t = await porta.emitir('user-x', 'imp')
    const resultados = await Promise.all(Array.from({ length: 20 }, () => porta.consumir(t)))
    expect(resultados.filter((r) => r !== null)).toHaveLength(1)
    expect(await porta.consumir(t)).toBeNull()
  })

  it('armazém: devolver restaura SÓ se ainda for o último token do usuário', async () => {
    const porta = m.tokens.criarTokensDeRedefinicaoRedis(m.redis)
    const t1 = await porta.emitir('user-d', 'imp')
    const v1 = await porta.consumir(t1)
    expect(v1).not.toBeNull()
    await porta.devolver(t1, v1!)
    const de_novo = await porta.consumir(t1) // voltou: um erro nosso não queima o link
    expect(de_novo).not.toBeNull()

    const t2 = await porta.emitir('user-d', 'imp')
    const t3 = await porta.emitir('user-d', 'imp') // invalida t2
    expect(await porta.consumir(t2)).toBeNull()
    await porta.devolver(t2, { userId: 'user-d', emitidoEm: Date.now(), impressao: 'imp' }) // t2 não é mais o último: não ressuscita
    expect(await porta.consumir(t2)).toBeNull()
    expect(await porta.consumir(t3)).not.toBeNull()
  })

  // ---------------------------------------------------------------------------------------------- logs

  it('NENHUM log do fluxo completo contém token, senha nova ou e-mail da conta', async () => {
    const u = await novaConta()
    logsTodos.length = 0
    const token = await pedirLink(u.email)
    expect((await reset(token, SENHA_NOVA)).status).toBe(204)
    await aguardarFila()
    const tudo = logsTodos.join('\n')
    expect(tudo.length).toBeGreaterThan(0)
    expect(tudo).not.toContain(token)
    expect(tudo).not.toContain(SENHA_NOVA)
    expect(tudo).not.toContain(u.email)
  })
})
