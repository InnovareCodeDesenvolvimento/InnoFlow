import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import type { IdentidadeGoogle } from '../../src/core/auth/decidirAcaoGoogle'

// Só o verificador do ID token é trocado (a lib do Google precisa de rede); rota, decisão, repositório, Postgres, Redis, rate limit e auditoria são os reais.
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

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { issueToken } from '../../src/lib/jwt'
import { identidadeEhTestador } from '../../src/core/pagamentos/configGateway'
import { createTenant, createUser, uniqueSuffix } from './helpers/fixtures'

/**
 * Íris (rodada 3) — REVALIDAÇÃO INDEPENDENTE de `POST /api/auth/google/link` (bf4149f). Os testes da Vega cobrem o caminho principal; aqui os cantos que ela não pisou:
 * OPERATOR e conta inativa, normalização do e-mail (alias, caixa, espaço, Unicode), corrida repetida 15x, Google disputado por duas contas de e-mail com CAIXA diferente,
 * limite por usuário independente do IP, integração com o login por Google, linha de auditoria completa e contrato de códigos com o frontend.
 */
describe('google/link — revalidação independente (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const baseline = { ...env } as Record<string, unknown>
  const SENHA = 'Senha-Forte-123'
  let n = 0
  const credencial = (id: Partial<IdentidadeGoogle>) => Buffer.from(JSON.stringify(id)).toString('base64url')

  afterEach(() => {
    Object.assign(env, baseline)
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function motorista(emailLiteral?: string) {
    const email = emailLiteral ?? `rev-${++n}-${Math.random().toString(36).slice(2, 7)}-${suffix}@example.com`
    const u = await prisma.user.create({ data: { role: 'DRIVER', name: 'Rev', email, passwordHash: await bcrypt.hash(SENHA, 4) } })
    const token = issueToken({ id: u.id, role: 'DRIVER', operatorId: null })
    return { id: u.id, email, token, auth: { Authorization: `Bearer ${token}` } }
  }
  type M = Awaited<ReturnType<typeof motorista>>
  const googleDe = (email: string, over: Partial<IdentidadeGoogle> = {}): IdentidadeGoogle => ({ sub: `g-${Math.random().toString(36).slice(2, 12)}-${suffix}`, email, emailVerified: true, name: 'G', ...over })
  const vincular = (m: { auth: Record<string, string> }, id: Partial<IdentidadeGoogle>, ip?: string) =>
    request(app)
      .post('/api/auth/google/link')
      .set({ ...m.auth, ...(ip ? { 'X-Forwarded-For': `${ip}, 10.0.0.9` } : {}) })
      .send({ credential: credencial(id) })
  const subNoBanco = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { googleSub: true } })).googleSub

  it('OPERATOR e ADMIN: 403 GOOGLE_LOGIN_NOT_ALLOWED mesmo com e-mail IGUAL e verificado; nada gravado', async () => {
    const tenant = await createTenant({ suffix, label: 'rev-link' })
    const op = await createUser({ role: 'OPERATOR', label: 'rev-op', suffix, operatorId: tenant.operatorId })
    const admin = await createUser({ role: 'ADMIN', label: 'rev-adm', suffix })
    for (const u of [op, admin]) {
      const res = await vincular({ auth: { Authorization: `Bearer ${u.token}` } }, googleDe(u.email))
      expect(res.status, JSON.stringify(res.body)).toBe(403)
      expect(res.body.code).toBe('GOOGLE_LOGIN_NOT_ALLOWED')
      expect(await subNoBanco(u.id)).toBeNull()
    }
  })

  it('conta DESATIVADA: 401 (nunca vincula) e nada gravado — o token ainda é "válido" no JWT, quem decide é o banco', async () => {
    const m = await motorista()
    await prisma.user.update({ where: { id: m.id }, data: { active: false } })
    const res = await vincular(m, googleDe(m.email))
    expect(res.status).toBe(401)
    expect(await subNoBanco(m.id)).toBeNull()
  })

  it('sem Authorization: 401; credencial lixo: 401 INVALID_GOOGLE_TOKEN; corpo vazio: 400 — e nenhum desses grava', async () => {
    const m = await motorista()
    expect((await request(app).post('/api/auth/google/link').send({ credential: credencial(googleDe(m.email)) })).status).toBe(401)
    const lixo = await request(app).post('/api/auth/google/link').set(m.auth).send({ credential: '%%%não-é-base64-json%%%' })
    expect(lixo.status).toBe(401)
    expect(lixo.body.code).toBe('INVALID_GOOGLE_TOKEN')
    expect((await request(app).post('/api/auth/google/link').set(m.auth).send({})).status).toBe(400)
    expect(await subNoBanco(m.id)).toBeNull()
  })

  describe('e-mail da conta x e-mail do Google: só IGUAL (sem caixa e sem espaços nas pontas) vincula', () => {
    const recusas: Array<[string, (e: string) => string]> = [
      ['alias com +tag', (e) => e.replace('@', '+tag@')],
      ['ponto no local (gmail ignora, nós não)', (e) => `x.${e}`],
      ['subdomínio', (e) => e.replace('@', '@sub.')],
      ['domínio diferente', (e) => e.replace('@example.com', '@example.org')],
      ['sufixo extra', (e) => `${e}.br`],
      ['prefixo extra', (e) => `a${e}`],
      ['homóglifo cirílico (а em vez de a)', (e) => e.replace('a', 'а')],
      ['I maiúsculo turco (İ minúsculo vira i + ponto)', (e) => e.replace('i', 'İ')],
      ['caracteres invisíveis (zero-width)', (e) => e.replace('@', '​@')],
    ]
    it.each(recusas)('%s: 403 GOOGLE_EMAIL_MISMATCH e a conta segue sem Google', async (_nome, mutar) => {
      const m = await motorista(`rev-i-${Math.random().toString(36).slice(2, 7)}-${suffix}@example.com`)
      const res = await vincular(m, googleDe(mutar(m.email)))
      expect(res.status, JSON.stringify(res.body)).toBe(403)
      expect(res.body.code).toBe('GOOGLE_EMAIL_MISMATCH')
      expect(await subNoBanco(m.id)).toBeNull()
    })

    it('PONTO no local NÃO é dobrado (o Gmail ignora, nós não): conta a.b@ x Google ab@ (e o inverso) => 403 GOOGLE_EMAIL_MISMATCH', async () => {
      const comPonto = await motorista(`rev.ponto-${suffix}@example.com`)
      const semPonto = await motorista(`revponto2-${suffix}@example.com`)
      const r1 = await vincular(comPonto, googleDe(`revponto-${suffix}@example.com`))
      const r2 = await vincular(semPonto, googleDe(`rev.ponto2-${suffix}@example.com`))
      for (const r of [r1, r2]) {
        expect(r.status, JSON.stringify(r.body)).toBe(403)
        expect(r.body.code).toBe('GOOGLE_EMAIL_MISMATCH')
      }
    })

    it('CAIXA diferente e espaços nas pontas do e-mail do Google vinculam (normalização só nesses dois pontos)', async () => {
      const a = await motorista(`Rev-Caixa-${suffix}@Example.COM`)
      expect((await vincular(a, googleDe(`  rev-caixa-${suffix}@example.com  `))).status).toBe(200)
    })
  })

  it('CORRIDA 15x: duas credenciais (dois Googles com o e-mail certo) ao mesmo tempo na mesma conta => SEMPRE um 200 e um 409, o banco guarda o vencedor, nunca 500', async () => {
    for (let i = 0; i < 15; i++) {
      const m = await motorista()
      const a = googleDe(m.email)
      const b = googleDe(m.email)
      const [ra, rb] = await Promise.all([vincular(m, a), vincular(m, b)])
      expect([ra.status, rb.status].sort(), `rodada ${i}`).toEqual([200, 409])
      expect(await subNoBanco(m.id)).toBe(ra.status === 200 ? a.sub : b.sub)
    }
  })

  it('o MESMO Google disputado por duas contas cujos e-mails diferem só na CAIXA: um vence (200), o outro 409; um único dono no banco', async () => {
    const base = `rev-dup-${suffix}`
    let a: M
    let b: M
    try {
      a = await motorista(`${base}@example.com`)
      b = await motorista(`${base.toUpperCase()}@example.com`)
    } catch {
      return // o banco não admite e-mails que diferem só na caixa: o cenário é impossível, e isso é o desejável
    }
    const sub = `g-disputa-${suffix}`
    const [ra, rb] = await Promise.all([vincular(a, googleDe(`${base}@example.com`, { sub })), vincular(b, googleDe(`${base}@example.com`, { sub }))])
    expect([ra.status, rb.status].sort(), JSON.stringify([ra.body, rb.body])).toEqual([200, 409])
    // o 409 tem de ser o NOSSO (GOOGLE_ALREADY_LINKED), não um 409 genérico do errorHandler para violação de unique (P2002) que escapou do repositório
    expect([ra, rb].find((r) => r.status === 409)!.body.code).toBe('GOOGLE_ALREADY_LINKED')
    expect(await prisma.user.count({ where: { googleSub: sub } })).toBe(1)
  })

  it('INTEGRAÇÃO: depois do vínculo o login público por Google entra NA MESMA conta (sem criar outra), a senha continua entrando e o token antigo segue valendo', async () => {
    const m = await motorista()
    const g = googleDe(m.email)
    expect((await vincular(m, g)).status).toBe(200)
    const viaGoogle = await request(app).post('/api/auth/google').send({ credential: credencial(g) })
    expect(viaGoogle.status, JSON.stringify(viaGoogle.body)).toBe(200)
    expect(viaGoogle.body.user.id).toBe(m.id)
    expect(await prisma.user.count({ where: { email: { equals: m.email, mode: 'insensitive' } } })).toBe(1)
    expect((await request(app).post('/api/auth/login').send({ email: m.email, password: SENHA })).status).toBe(200)
    expect((await request(app).get('/api/me/payment-methods').set(m.auth)).status).toBe(200) // o JWT de antes do vínculo segue valendo
  })

  it('limite por USUÁRIO e não por IP: 10 falhas de IPs DIFERENTES esgotam o balde do mesmo usuário; 12 falhas de usuários diferentes do MESMO IP não bloqueiam ninguém', async () => {
    const alvo = await motorista()
    for (let i = 1; i <= 10; i++) expect((await vincular(alvo, googleDe(`outro-${i}-${suffix}@example.com`), `198.18.${i}.7`)).status, `falha ${i}`).toBe(403)
    expect((await vincular(alvo, googleDe(alvo.email), '198.18.200.7')).status).toBe(429) // até o pedido CERTO, de um IP novo, fica barrado

    const ipUnico = `198.18.77.${Math.floor(Math.random() * 200) + 1}`
    for (let i = 0; i < 12; i++) {
      const u = await motorista()
      expect((await vincular(u, googleDe(`errado-${i}-${suffix}@example.com`), ipUnico)).status).toBe(403) // nunca 429: o IP não entra na chave
    }
  })

  it('AUDITORIA: sucesso (200), recusas (403/409/401) gravam httpStatus e motivo certos; nenhuma linha contém a credencial, o sub do Google ou o e-mail do Google estranho', async () => {
    const m = await motorista()
    const estranho = googleDe(`estranho-${suffix}@example.com`)
    const certo = googleDe(m.email)
    const credEstranha = credencial(estranho)
    const credCerta = credencial(certo)
    expect((await request(app).post('/api/auth/google/link').set(m.auth).send({ credential: credEstranha })).status).toBe(403)
    expect((await request(app).post('/api/auth/google/link').set(m.auth).send({ credential: credCerta })).status).toBe(200)
    expect((await request(app).post('/api/auth/google/link').set(m.auth).send({ credential: credencial(googleDe(m.email)) })).status).toBe(409)
    expect((await request(app).post('/api/auth/google/link').set(m.auth).send({ credential: 'lixo' })).status).toBe(401)
    await new Promise((r) => setTimeout(r, 400)) // a gravação é fire-and-forget
    const linhas = await prisma.auditLog.findMany({ where: { actorUserId: m.id, path: '/api/auth/google/link' }, orderBy: { occurredAt: 'asc' } })
    const resumo = linhas.map((l) => `${l.actionDetail}|${l.outcome}|${l.httpStatus}`)
    // SEM ordem: a gravação é fire-and-forget e `occurredAt` é o instante da GRAVAÇÃO (flake do mesmo tipo no teste de conexão do log real).
    expect([...resumo].sort()).toEqual(
      [
        'google_link_denied:EMAIL_MISMATCH|DENIED|403',
        'google_linked|SUCCESS|200',
        'google_link_denied:ALREADY_LINKED|DENIED|409',
        'google_link_denied:INVALID_TOKEN|DENIED|401',
      ].sort(),
    )
    const tudo = JSON.stringify(linhas)
    for (const segredo of [credEstranha, credCerta, estranho.sub, certo.sub, estranho.email]) expect(tudo).not.toContain(segredo)
    expect(linhas.every((l) => l.actorRole === 'DRIVER' && l.entityId === m.id)).toBe(true)
  })

  it('CONTRATO com o frontend: todo `code` que a rota emite está em `LinkGoogleErrorCode`/códigos genéricos que a tela já trata', async () => {
    const fonte = readFileSync(join(process.cwd(), '..', 'frontend', 'src', 'types', 'api.ts'), 'utf8')
    const uniao = /export type LinkGoogleErrorCode =([\s\S]*?)\r?\n\r?\n/.exec(fonte)![1]
    const doFrontend = new Set([...uniao.matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]))
    const m = await motorista()
    const emitidos = new Set<string>()
    const coletar = (r: request.Response) => r.body.code && emitidos.add(r.body.code as string)
    coletar(await request(app).post('/api/auth/google/link').set(m.auth).send({ credential: 'lixo' }))
    coletar(await vincular(m, googleDe(m.email, { emailVerified: false })))
    coletar(await vincular(m, googleDe(`outro-${suffix}@example.com`)))
    await vincular(m, googleDe(m.email))
    coletar(await vincular(m, googleDe(m.email)))
    const admin = await createUser({ role: 'ADMIN', label: 'rev-contrato', suffix })
    coletar(await vincular({ auth: { Authorization: `Bearer ${admin.token}` } }, googleDe(admin.email)))
    ;(env as Record<string, unknown>).GOOGLE_CLIENT_ID = undefined
    coletar(await vincular(m, googleDe(m.email)))
    expect([...emitidos].sort()).toEqual(['GOOGLE_ALREADY_LINKED', 'GOOGLE_EMAIL_MISMATCH', 'GOOGLE_EMAIL_NOT_VERIFIED', 'GOOGLE_LOGIN_NOT_ALLOWED', 'GOOGLE_NOT_CONFIGURED', 'INVALID_GOOGLE_TOKEN'])
    for (const c of emitidos) expect(doFrontend.has(c), `o frontend não conhece o código ${c}`).toBe(true)
  })

  it('SEM ATALHO: vincular o Google de e-mail IGUAL não transforma conta qualquer em testadora do sandbox; a identidade verificada continua só de googleSub/staff', async () => {
    const m = await motorista()
    const lista = new Set([`outro-${suffix}@example.com`]) // a conta NÃO está na lista de testadores
    expect(identidadeEhTestador({ email: m.email, role: 'DRIVER', googleSub: null }, lista)).toBe(false)
    expect((await vincular(m, googleDe(m.email))).status).toBe(200)
    const depois = await prisma.user.findUniqueOrThrow({ where: { id: m.id }, select: { email: true, role: true, googleSub: true } })
    expect(identidadeEhTestador(depois, lista)).toBe(false) // vincular liberou o CARTÃO, não o sandbox restrito
  })
})
