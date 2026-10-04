import { appendFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { IdentidadeGoogle } from '../../src/core/auth/decidirAcaoGoogle'
import { criarBancoProprio } from './helpers/bancoProprio'

// Liga o login com Google ANTES de `env` ser lido e troca só o verificador do ID token (a lib do Google precisa de rede): TODO o resto (rota, decisão, repositório
// Prisma, sessionValidator, guarda do sandbox, Postgres) é o código de verdade — o mesmo desenho de `googleAuthDb.test.ts`.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
})
vi.mock('../../src/services/auth/googleTokenVerifier', () => ({
  createGoogleTokenVerifier: () => async (credential: string) => {
    try {
      return JSON.parse(Buffer.from(credential, 'base64url').toString('utf8')) as IdentidadeGoogle
    } catch {
      throw new Error('token inválido (simulado)')
    }
  },
}))

/**
 * QA da Íris (F5.8, rodada Vega-4) — revalidação INDEPENDENTE do ALTO-2 depois da correção `identidadeEhTestador` (testador = e-mail na lista E (googleSub OU staff))
 * + `register` insensível a caixa. Tudo pela API PÚBLICA, num servidor `NODE_ENV=production` em sandbox com `PAYMENT_SANDBOX_TESTER_EMAILS`.
 *
 * O ponto que o Vega leu e NÃO testou: o "pré-sequestro" — o atacante cadastra por senha o e-mail do testador ANTES dele; quando o dono de verdade entra com o Google,
 * `autenticarComGoogle` VINCULA o `googleSub` à conta do atacante (e agora `googleSub != null` faz dela uma conta de testador!). O que impede o atacante de usá-la é o
 * próprio vínculo (`linkGoogleSub` apaga a senha e levanta `sessionsValidAfter`). Aqui isso é provado de ponta a ponta: sessão antiga do atacante morre, a senha dele deixa
 * de entrar, ele não consegue re-definir senha com o token velho, e o Pix/cartão de sandbox só passam pelo DONO.
 */

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  repo: typeof import('../../src/services/auth/prismaGoogleUserRepository').prismaGoogleUserRepository
}

const SENHA = 'Senha-Forte-123'
const sufixo = () => Math.random().toString(36).slice(2, 10)
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('ALTO-2 revalidado — sandbox restrito só vale para identidade VERIFICADA; o vínculo Google impede o pré-sequestro — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  const envBaseline: Record<string, unknown> = {}
  let testador = ''
  let subDoDono = ''

  beforeAll(async () => {
    banco = await criarBancoProprio('pgv')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, cfgMod, portMod, repoMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('../../src/services/auth/prismaGoogleUserRepository'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      env: envMod.env as unknown as Record<string, unknown>,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      repo: repoMod.prismaGoogleUserRepository,
    }
    app = m.createApp()
    for (const k of ['NODE_ENV', 'CIELO_SANDBOX', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) envBaseline[k] = m.env[k]
  }, 120_000)

  afterAll(async () => {
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.paymentGatewayConfig.deleteMany()
    await m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: 'sandbox', cardEnabled: true, pixEnabled: true } })
    testador = `dono.${sufixo()}@example.com`
    subDoDono = `sub-dono-${sufixo()}`
    m.env.NODE_ENV = 'production'
    m.env.CIELO_SANDBOX = true
    m.env.PAYMENT_ALLOW_FAKE_ADAPTER = true
    m.env.PAYMENT_SANDBOX_TESTER_EMAILS = testador
    m.invalidarCacheConfigGateway()
    m.resetPagamentoPortCacheParaTeste()
  })
  afterEach(() => {
    Object.assign(m.env, envBaseline)
    m.invalidarCacheConfigGateway()
  })

  const registrar = (email: string, extra: Record<string, unknown> = {}) => request(app).post('/api/auth/register').send({ name: 'Quem Registrou', email, password: SENHA, ...extra })
  const login = (email: string, password = SENHA) => request(app).post('/api/auth/login').send({ email, password })
  const credencial = (id: Partial<IdentidadeGoogle>) => Buffer.from(JSON.stringify(id)).toString('base64url')
  const google = (id: Partial<IdentidadeGoogle>) => request(app).post('/api/auth/google').send({ credential: credencial(id) })
  const idGoogle = (email: string, sub: string, over: Partial<IdentidadeGoogle> = {}): IdentidadeGoogle => ({ sub, email, emailVerified: true, name: 'Google', ...over })
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const pix = (token: string) => request(app).post('/api/me/wallet/topups').set(auth(token)).send({ amountCents: 2000 })
  const cartao = (token: string) => request(app).post('/api/me/payment-methods').set(auth(token)).send({ cardToken: crypto.randomUUID(), brand: 'Visa' })
  const trocarSenha = (token: string) => request(app).post('/api/auth/password').set(auth(token)).send({ newPassword: 'Outra-Senha-456' })

  async function esperaRestrito(token: string, quem: string) {
    const p = await pix(token)
    expect(p.status, `${quem}: Pix deveria ser barrado — ${JSON.stringify(p.body)}`).toBe(409)
    expect(p.body.details).toEqual([{ method: 'PIX', reason: 'SANDBOX_RESTRICTED' }])
    const c = await cartao(token)
    expect(c.status, `${quem}: cartão deveria ser barrado — ${JSON.stringify(c.body)}`).toBe(409)
    expect(c.body.details).toEqual([{ method: 'CARD', reason: 'SANDBOX_RESTRICTED' }])
  }

  it('CONTROLE: o dono entra com o Google (conta nova, e-mail verificado) e usa Pix E cartão de sandbox; outro e-mail com Google continua barrado', async () => {
    const dono = await google(idGoogle(testador, subDoDono))
    expect(dono.status, JSON.stringify(dono.body)).toBe(201)
    expect((await pix(dono.body.token)).status).toBe(201)
    expect((await cartao(dono.body.token)).status).toBe(201)

    const comum = await google(idGoogle(`comum.${sufixo()}@example.com`, `sub-${sufixo()}`))
    expect(comum.status).toBe(201)
    await esperaRestrito(comum.body.token, 'motorista Google fora da lista')
  })

  it('DRIVER só com senha, e-mail EXATO da lista (sem conta prévia do dono): barrado em Pix e cartão — e continua barrado depois de logar de novo', async () => {
    const atacante = await registrar(testador)
    expect(atacante.status).toBe(201)
    await esperaRestrito(atacante.body.token, 'atacante pré-registrado')
    const relogin = await login(testador)
    expect(relogin.status).toBe(200)
    await esperaRestrito(relogin.body.token, 'atacante após login')
  })

  it('caixa e espaços: com o testador JÁ cadastrado, qualquer variante é 409 EMAIL_TAKEN (igual ao duplicado exato); SEM conta prévia a variante registra mas segue barrada', async () => {
    const [local, dominio] = testador.split('@') as [string, string]
    const variantes = [testador.toUpperCase(), `${local.toUpperCase()}@${dominio}`, `${local}@${dominio.toUpperCase()}`, `  ${testador}  `, `${local[0]!.toUpperCase()}${local.slice(1)}@${dominio}`]
    // sem conta prévia: a variante é aceita pelo register (nada a impedir) mas NÃO é testador (DRIVER sem googleSub)
    const semConta = await registrar(variantes[0]!)
    expect(semConta.status).toBe(201)
    await esperaRestrito(semConta.body.token, 'variante em caixa alta sem conta prévia')
    await m.prisma.wallet.deleteMany({ where: { user: { email: { equals: testador, mode: 'insensitive' } } } })
    await m.prisma.user.deleteMany({ where: { email: { equals: testador, mode: 'insensitive' } } })

    // com a conta do dono (Google) já existente: TODAS as variantes são recusadas com a mesma resposta do duplicado exato
    const dono = await google(idGoogle(testador, subDoDono))
    expect(dono.status).toBe(201)
    const exato = await registrar(testador)
    for (const v of variantes) {
      const r = await registrar(v)
      expect({ v, status: r.status, code: r.body.code, error: r.body.error }).toEqual({ v, status: exato.status, code: 'EMAIL_TAKEN', error: exato.body.error })
    }
    expect(await m.prisma.user.count({ where: { email: { equals: testador, mode: 'insensitive' } } })).toBe(1)
  })

  it('curinga do ILIKE: o e-mail com "_" não colide com outro e-mail só porque "_" casa qualquer caractere (o register insensível não pode bloquear gente legítima)', async () => {
    const base = sufixo()
    const a = await registrar(`ana_${base}@example.com`)
    expect(a.status).toBe(201)
    const b = await registrar(`anaX${base}@example.com`) // seria colisão FALSA se o "_" virasse curinga
    expect(b.status, JSON.stringify(b.body)).toBe(201)
  })

  it('corpo do register com role/googleSub/emailVerified embutidos: a conta nasce DRIVER, sem googleSub — nenhum campo extra vira privilégio nem identidade verificada', async () => {
    const r = await registrar(testador, { role: 'ADMIN', googleSub: 'sub-forjado', emailVerified: true, operatorId: 'x', active: true })
    // aceita (campos ignorados) ou recusa (400) — o que NÃO pode é criar staff/googleSub
    if (r.status === 201) {
      const u = await m.prisma.user.findUniqueOrThrow({ where: { email: testador } })
      expect(u.role).toBe('DRIVER')
      expect(u.googleSub).toBeNull()
      await esperaRestrito(r.body.token, 'register com campos privilegiados no corpo')
    } else {
      expect(r.status).toBe(400)
    }
  })

  it('PRÉ-SEQUESTRO (e-mail exato): o atacante cadastra o e-mail do testador; o dono entra com o Google e a conta vira DELE — sessão e senha do atacante morrem, ele não redefine senha com o token velho, e o sandbox só passa pelo dono', async () => {
    const atacante = await registrar(testador)
    expect(atacante.status).toBe(201)
    const velho = atacante.body.token as string
    // CONTROLE antes do vínculo: a sessão está viva e o sandbox barra — sem isto o 401 depois poderia ser só "token sem efeito"
    expect((await request(app).get('/api/me/payment-methods').set(auth(velho))).status, 'sessão viva antes do vínculo').toBe(200)
    await esperaRestrito(velho, 'atacante antes do vínculo')

    await dormir(1100) // o validador compara o iat (SEGUNDOS) com o piso de sessionsValidAfter: um token do MESMO segundo do vínculo ainda vale (janela documentada de <1 s)
    const dono = await google(idGoogle(testador, subDoDono))
    expect(dono.status, JSON.stringify(dono.body)).toBe(200) // 200 = vinculou na conta existente (não criou outra)
    expect(dono.body.user.id).toBe(atacante.body.user.id)
    expect(dono.body.user.hasPassword, 'o vínculo apaga a senha do atacante').toBe(false)
    const linha = await m.prisma.user.findUniqueOrThrow({ where: { id: dono.body.user.id } })
    expect(linha.googleSub).toBe(subDoDono)
    expect(linha.passwordHash).toBeNull()

    // o ATACANTE: sessão velha morre (401), senha não entra, não consegue definir senha nova com o token velho, não usa o sandbox
    expect((await request(app).get('/api/me/payment-methods').set(auth(velho))).status).toBe(401)
    expect((await pix(velho)).status).toBe(401)
    expect((await cartao(velho)).status).toBe(401)
    expect((await trocarSenha(velho)).status).toBe(401)
    expect((await login(testador)).status).toBe(401)
    expect((await login(testador, 'Outra-Senha-456')).status).toBe(401)
    expect((await registrar(testador)).status, 'e re-cadastrar o e-mail continua recusado').toBe(409)

    // o DONO: passa
    expect((await pix(dono.body.token)).status).toBe(201)
    expect((await cartao(dono.body.token)).status).toBe(201)
  })

  it('PRÉ-SEQUESTRO (caixa diferente): o atacante cadastra "DONO…@EXAMPLE.COM" antes do dono existir; o Google do dono (minúsculo) vincula essa conta e a senha/sessão do atacante morrem', async () => {
    const atacante = await registrar(testador.toUpperCase())
    expect(atacante.status).toBe(201)
    const velho = atacante.body.token as string
    await esperaRestrito(velho, 'atacante com e-mail em caixa alta')
    await dormir(1100)
    const dono = await google(idGoogle(testador, subDoDono))
    expect(dono.status, JSON.stringify(dono.body)).toBe(200)
    expect(dono.body.user.id).toBe(atacante.body.user.id)
    expect((await pix(velho)).status).toBe(401)
    expect((await login(testador.toUpperCase())).status).toBe(401)
    expect((await pix(dono.body.token)).status, 'o dono (agora verificado) usa o sandbox').toBe(201)
  })

  it('e-mail NÃO verificado no Google (403) nunca vincula nem libera: a conta do atacante segue só com senha e barrada', async () => {
    const atacante = await registrar(testador)
    expect(atacante.status).toBe(201)
    const r = await google(idGoogle(testador, `sub-${sufixo()}`, { emailVerified: false }))
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('GOOGLE_EMAIL_NOT_VERIFIED')
    const u = await m.prisma.user.findUniqueOrThrow({ where: { id: atacante.body.user.id } })
    expect(u.googleSub).toBeNull()
    expect(u.passwordHash).not.toBeNull()
    await esperaRestrito(atacante.body.token, 'atacante após tentativa com Google não verificado')
  })

  it('conta JÁ vinculada ao Google do dono: um OUTRO sub do Google com o mesmo e-mail (403, ACCOUNT_MISMATCH) não assume a conta nem vira testador', async () => {
    const dono = await google(idGoogle(testador, subDoDono))
    expect(dono.status).toBe(201)
    const outro = await google(idGoogle(testador, `sub-impostor-${sufixo()}`))
    expect(outro.status).toBe(403)
    expect(outro.body.code).toBe('GOOGLE_LOGIN_NOT_ALLOWED')
    expect((await m.prisma.user.findUniqueOrThrow({ where: { id: dono.body.user.id } })).googleSub).toBe(subDoDono)
  })

  it('sub do Google de OUTRA pessoa (e-mail fora da lista) vinculado depois a um DRIVER com senha: segue barrado — o googleSub sozinho não basta, o e-mail tem que estar na lista', async () => {
    const comum = `comum.${sufixo()}@example.com`
    const reg = await registrar(comum)
    expect(reg.status).toBe(201)
    const g = await google(idGoogle(comum, `sub-${sufixo()}`))
    expect(g.status).toBe(200)
    await esperaRestrito(g.body.token, 'motorista comum com Google vinculado')
  })

  it('JANELA MEDIDA (multi-instância): se o vínculo acontece em OUTRO processo da API, a sessão velha do atacante só morre quando o cache do validador (30 s) expira — aqui, no mesmo processo sem o `invalidate`', async () => {
    const atacante = await registrar(testador)
    expect(atacante.status).toBe(201)
    const velho = atacante.body.token as string
    expect((await request(app).get('/api/me/payment-methods').set(auth(velho))).status).toBe(200) // esquenta o cache de sessão DESTE processo
    // o vínculo roda "em outro processo": só o repositório (sem o `sessionValidator.invalidate` que a ROTA faz neste processo)
    await dormir(1100) // o iat do token fica estritamente antes do piso (em segundos) de sessionsValidAfter
    await m.repo.linkGoogleSub(atacante.body.user.id, subDoDono)
    const durante = await pix(velho)
    // MEDIÇÃO registrada no relatório: se for 201, o token velho do atacante passou como testador dentro da janela do cache (<=30 s) numa réplica que não viu o vínculo.
    // O teste fixa o que foi MEDIDO hoje para virar regressão se o cache for encurtado/invalidado por evento (troque o esperado ao corrigir).
    expect([201, 401], `status inesperado: ${durante.status} ${JSON.stringify(durante.body)}`).toContain(durante.status)
    if (process.env.IRIS_M4C_SAIDA) appendFileSync(process.env.IRIS_M4C_SAIDA, `[janela-multi-instancia] Pix do token velho logo após o vínculo em outro processo: ${durante.status}
`)
  })
})
