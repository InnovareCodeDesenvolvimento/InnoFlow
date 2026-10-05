import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import type { IdentidadeGoogle } from '../../src/core/auth/decidirAcaoGoogle'

// Mesmo desenho de `googleAuthDb.test.ts`: só o verificador do ID token é trocado (a lib do Google precisa de rede); rota, decisão, repositório, Postgres, rate limit e auditoria são os reais.
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
import { logger } from '../../src/lib/logger'
import { identidadeEhTestador } from '../../src/core/pagamentos/configGateway'
import { prismaVinculoGoogleRepository } from '../../src/services/auth/vincularGoogleAContaLogada'
import { createUser, uniqueSuffix } from './helpers/fixtures'
import { TERMOS_VIGENTES } from './helpers/termos'

/**
 * `POST /api/auth/google/link` (I-7) contra Postgres + Redis REAIS: vincula o Google à conta LOGADA sem trocar de conta, sem zerar a senha e sem revogar a sessão.
 */
describe('POST /api/auth/google/link — vínculo do Google à conta logada (Postgres real)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const baseline = { ...env } as Record<string, unknown>
  const credencial = (id: Partial<IdentidadeGoogle>) => Buffer.from(JSON.stringify(id)).toString('base64url')
  const SENHA = 'Senha-Forte-123'
  let n = 0

  afterEach(() => {
    Object.assign(env, baseline)
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  /** Motorista só-senha, criado pela API pública (token de verdade). */
  async function motoristaSoSenha() {
    const email = `link-${++n}-${Math.random().toString(36).slice(2, 7)}-${suffix}@example.com`
    const reg = await request(app).post('/api/auth/register').send({ name: 'Motorista Link', email, password: SENHA, acceptedTermsVersion: TERMOS_VIGENTES })
    expect(reg.status, JSON.stringify(reg.body)).toBe(201)
    return { email, token: reg.body.token as string, id: reg.body.user.id as string, auth: { Authorization: `Bearer ${reg.body.token}` } }
  }
  type M = Awaited<ReturnType<typeof motoristaSoSenha>>
  const googleDe = (m: { email: string }, over: Partial<IdentidadeGoogle> = {}): IdentidadeGoogle => ({ sub: `g-${Math.random().toString(36).slice(2, 12)}-${suffix}`, email: m.email, emailVerified: true, name: 'G', ...over })
  const vincular = (m: M, id: Partial<IdentidadeGoogle>) => request(app).post('/api/auth/google/link').set(m.auth).send({ credential: credencial(id) })
  const elegibilidade = async (m: M) => (await request(app).get('/api/me/payment-methods').set(m.auth)).body.cardEligibility

  it('vínculo ok: 200 {linked:true}; googleSub gravado; SENHA CONTINUA valendo; a MESMA sessão continua valendo; o cartão é liberado', async () => {
    ;(env as Record<string, unknown>).CARD_REQUIRE_VERIFIED_IDENTITY = true
    const m = await motoristaSoSenha()
    expect((await elegibilidade(m)).reason).toBe('GOOGLE_LOGIN_REQUIRED')
    const antes = await prisma.user.findUniqueOrThrow({ where: { id: m.id } })

    const g = googleDe(m)
    const res = await vincular(m, g)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ linked: true })

    const depois = await prisma.user.findUniqueOrThrow({ where: { id: m.id } })
    expect(depois.googleSub).toBe(g.sub)
    expect(depois.passwordHash).toBe(antes.passwordHash) // NÃO zera a senha
    expect(depois.passwordHash).not.toBeNull()
    expect(depois.sessionsValidAfter?.getTime() ?? null).toBe(antes.sessionsValidAfter?.getTime() ?? null) // NÃO revoga sessões
    expect(depois.id).toBe(m.id) // não trocou de conta

    // a sessão que fez o vínculo continua valendo, e agora o cartão está liberado
    expect(await elegibilidade(m)).toEqual({ eligible: true, reason: null, blockedUntil: null })
    // e a senha continua entrando
    const login = await request(app).post('/api/auth/login').send({ email: m.email, password: SENHA })
    expect(login.status).toBe(200)
    expect(login.body.user.id).toBe(m.id)
  })

  it('e-mail do Google com CAIXA diferente da conta vincula (e-mail é case-insensitive)', async () => {
    const m = await motoristaSoSenha()
    const res = await vincular(m, googleDe(m, { email: m.email.toUpperCase() }))
    expect(res.status).toBe(200)
  })

  it('auditoria: linha `google_linked` (SUCCESS, ator DRIVER) SEM o token/credencial em lugar nenhum', async () => {
    const m = await motoristaSoSenha()
    const cred = credencial(googleDe(m))
    const res = await request(app).post('/api/auth/google/link').set(m.auth).send({ credential: cred })
    expect(res.status).toBe(200)
    await vi.waitFor(async () => {
      const linhas = await prisma.auditLog.findMany({ where: { actorUserId: m.id, actionDetail: 'google_linked' } })
      expect(linhas).toHaveLength(1)
      const l = linhas[0]
      expect(l).toMatchObject({ actorRole: 'DRIVER', action: 'OTHER', outcome: 'SUCCESS', httpStatus: 200, method: 'POST', path: '/api/auth/google/link', entityType: 'User', entityId: m.id })
      expect(JSON.stringify(l)).not.toContain(cred)
    })
  })

  it('e-mail do Google DIFERENTE do da conta: 403 GOOGLE_EMAIL_MISMATCH, nada gravado, tentativa auditada (DENIED)', async () => {
    const m = await motoristaSoSenha()
    const res = await vincular(m, googleDe(m, { email: `outra-pessoa-${suffix}@example.com` }))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('GOOGLE_EMAIL_MISMATCH')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.id } })).googleSub).toBeNull()
    await vi.waitFor(async () => {
      const l = await prisma.auditLog.findFirst({ where: { actorUserId: m.id, actionDetail: 'google_link_denied:EMAIL_MISMATCH' } })
      expect(l).toMatchObject({ outcome: 'DENIED', httpStatus: 403 })
    })
  })

  it('e-mail do Google não verificado: 403 GOOGLE_EMAIL_NOT_VERIFIED; token inválido: 401 INVALID_GOOGLE_TOKEN; corpo sem credential: 400', async () => {
    const m = await motoristaSoSenha()
    const naoVerificado = await vincular(m, googleDe(m, { emailVerified: false }))
    expect(naoVerificado.status).toBe(403)
    expect(naoVerificado.body.code).toBe('GOOGLE_EMAIL_NOT_VERIFIED')
    const invalido = await request(app).post('/api/auth/google/link').set(m.auth).send({ credential: 'isto-nao-e-um-jwt' })
    expect(invalido.status).toBe(401)
    expect(invalido.body.code).toBe('INVALID_GOOGLE_TOKEN')
    expect(JSON.stringify(invalido.body)).not.toContain('isto-nao-e-um-jwt')
    expect((await request(app).post('/api/auth/google/link').set(m.auth).send({})).status).toBe(400)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.id } })).googleSub).toBeNull()
  })

  it('sem sessão: 401 (rota autenticada)', async () => {
    const res = await request(app).post('/api/auth/google/link').send({ credential: credencial({ sub: 'x', email: 'a@b.com', emailVerified: true }) })
    expect(res.status).toBe(401)
  })

  it('só DRIVER: ADMIN leva 403 GOOGLE_LOGIN_NOT_ALLOWED e nada é gravado', async () => {
    const admin = await createUser({ role: 'ADMIN', label: 'admin-link', suffix, passwordHash: await bcrypt.hash(SENHA, 4) })
    const res = await request(app)
      .post('/api/auth/google/link')
      .set({ Authorization: `Bearer ${admin.token}` })
      .send({ credential: credencial({ sub: `g-adm-${suffix}`, email: admin.email, emailVerified: true }) })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('GOOGLE_LOGIN_NOT_ALLOWED')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).googleSub).toBeNull()
  })

  it('conta que JÁ tem Google: 409 GOOGLE_ALREADY_LINKED e o googleSub antigo NÃO é sobrescrito (nem com o mesmo e-mail)', async () => {
    const m = await motoristaSoSenha()
    const primeiro = googleDe(m)
    expect((await vincular(m, primeiro)).status).toBe(200)
    const segundo = await vincular(m, googleDe(m))
    expect(segundo.status).toBe(409)
    expect(segundo.body.code).toBe('GOOGLE_ALREADY_LINKED')
    const repetido = await vincular(m, primeiro) // o MESMO Google de novo também é 409
    expect(repetido.status).toBe(409)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.id } })).googleSub).toBe(primeiro.sub)
  })

  it('Google que JÁ está em OUTRA conta: 409 GOOGLE_ALREADY_LINKED (e a outra conta não muda)', async () => {
    const dono = await motoristaSoSenha()
    const sub = `g-compartilhado-${suffix}-${n}`
    expect((await vincular(dono, googleDe(dono, { sub }))).status).toBe(200)
    const outro = await motoristaSoSenha()
    const res = await vincular(outro, googleDe(outro, { sub }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('GOOGLE_ALREADY_LINKED')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: outro.id } })).googleSub).toBeNull()
    expect((await prisma.user.findUniqueOrThrow({ where: { id: dono.id } })).googleSub).toBe(sub)
  })

  it('dois vínculos SIMULTÂNEOS na mesma conta (dois Googles com o e-mail certo): exatamente UM vence, o outro leva 409, o banco guarda o vencedor', async () => {
    const m = await motoristaSoSenha()
    const a = googleDe(m)
    const b = googleDe(m)
    const [ra, rb] = await Promise.all([vincular(m, a), vincular(m, b)])
    expect([ra.status, rb.status].sort()).toEqual([200, 409])
    const vencedor = ra.status === 200 ? a : b
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.id } })).googleSub).toBe(vencedor.sub)
  })

  it('duas contas disputando o MESMO Google ao mesmo tempo (repositório): uma grava, a outra recebe false — nunca P2002 vazando', async () => {
    const a = await motoristaSoSenha()
    const b = await motoristaSoSenha()
    const sub = `g-corrida-${suffix}-${n}`
    const resultados = await Promise.all([prismaVinculoGoogleRepository.linkSubIfFree(a.id, sub), prismaVinculoGoogleRepository.linkSubIfFree(b.id, sub)])
    expect(resultados.filter(Boolean)).toHaveLength(1)
    expect(await prisma.user.count({ where: { googleSub: sub } })).toBe(1)
  })

  it('503 GOOGLE_NOT_CONFIGURED sem GOOGLE_CLIENT_ID', async () => {
    const m = await motoristaSoSenha()
    ;(env as Record<string, unknown>).GOOGLE_CLIENT_ID = undefined
    const res = await vincular(m, googleDe(m))
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('GOOGLE_NOT_CONFIGURED')
  })

  describe('o vínculo NÃO cria atalho para o sandbox restrito / cartão por e-mail', () => {
    const testadores = (email: string) => new Set([email.toLowerCase()])

    it('conta só-senha com e-mail de TESTADOR: Google de OUTRO e-mail é recusado (403) e ela continua NÃO sendo testadora; só o Google com o MESMO e-mail verificado a torna testadora', async () => {
      const m = await motoristaSoSenha()
      const lista = testadores(m.email)
      const linha = async () => prisma.user.findUniqueOrThrow({ where: { id: m.id }, select: { email: true, role: true, googleSub: true } })

      expect(identidadeEhTestador(await linha(), lista)).toBe(false) // só-senha: não é testadora

      const atacante = await vincular(m, googleDe(m, { email: `atacante-${suffix}@example.com` })) // Google PRÓPRIO do atacante, verificado, outro e-mail
      expect(atacante.status).toBe(403)
      expect(atacante.body.code).toBe('GOOGLE_EMAIL_MISMATCH')
      expect(identidadeEhTestador(await linha(), lista)).toBe(false)

      const dono = await vincular(m, googleDe(m)) // o Google do MESMO e-mail (prova a posse do e-mail testador)
      expect(dono.status).toBe(200)
      expect(identidadeEhTestador(await linha(), lista)).toBe(true)
    })

    it('e-mail do Google igual mas NÃO verificado não vincula (não prova posse do e-mail)', async () => {
      const m = await motoristaSoSenha()
      const res = await vincular(m, googleDe(m, { emailVerified: false }))
      expect(res.status).toBe(403)
      expect(identidadeEhTestador(await prisma.user.findUniqueOrThrow({ where: { id: m.id } }), testadores(m.email))).toBe(false)
    })
  })

  describe('abuso', () => {
    it('falhas repetidas: o alerta `google_link_repeated_failures` sai UMA vez (na 5ª) e depois de 10 falhas vem 429 RATE_LIMITED_AUTH (por usuário); outro usuário não é afetado', async () => {
      const m = await motoristaSoSenha()
      const outro = await motoristaSoSenha()
      const aviso = vi.spyOn(logger, 'warn')
      for (let i = 1; i <= 10; i++) {
        const r = await vincular(m, googleDe(m, { email: `invasor-${i}-${suffix}@example.com` }))
        expect(r.status, `tentativa ${i}`).toBe(403)
      }
      const alertas = aviso.mock.calls.filter((c) => (c[0] as { alert?: string } | undefined)?.alert === 'google_link_repeated_failures')
      expect(alertas).toHaveLength(1)
      expect(JSON.stringify(alertas[0])).not.toContain('invasor') // sem e-mail/token no alerta
      expect(alertas[0][0]).toMatchObject({ userId: m.id, motivo: 'EMAIL_MISMATCH' })

      const barrado = await vincular(m, googleDe(m, { email: `invasor-11-${suffix}@example.com` }))
      expect(barrado.status).toBe(429)
      expect(barrado.body.code).toBe('RATE_LIMITED_AUTH')

      expect((await vincular(outro, googleDe(outro))).status).toBe(200)
    })

    it('SUCESSO não gasta o balde do rate limit', async () => {
      const m = await motoristaSoSenha()
      expect((await vincular(m, googleDe(m))).status).toBe(200)
      for (let i = 0; i < 10; i++) expect((await vincular(m, googleDe(m))).status, `falha ${i + 1}`).toBe(409) // 10 falhas ainda respondem; o sucesso do início não contou
      expect((await vincular(m, googleDe(m))).status).toBe(429)
    })
  })
})
