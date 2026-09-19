import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { env } from '../../src/lib/env'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'
import { sessionValidator } from '../../src/api/lib/sessionValidatorInstance'
import { autenticarComGoogle } from '../../src/services/auth/autenticarComGoogle'
import { prismaGoogleUserRepository } from '../../src/services/auth/prismaGoogleUserRepository'
import { createUser, uniqueSuffix } from './helpers/fixtures'

/**
 * Revogação de sessão + troca de senha contra Postgres REAL (Órion A3/M1, 2026-09-19).
 * O que os testes unitários (regra pura + cache com `load` falso) NÃO provam: `authenticate`
 * de verdade lendo `User.active`/`sessionsValidAfter` do banco, o `iat` real do jsonwebtoken
 * (segundos) contra o `sessionsValidAfter` do Postgres (ms), e o vínculo do Google apagando a
 * senha do pré-registrador.
 */
describe('sessão revogável — banco e rotas (Postgres real)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const SENHA = 'SenhaAtual#123'
  const NOVA = 'OutraSenha#456'

  afterAll(async () => {
    redis.disconnect()
  })

  /**
   * Token assinado como se tivesse sido emitido há 10s. O `iat` do JWT tem granularidade de
   * SEGUNDO e a revogação compara em segundos (piso) — um token emitido NO MESMO SEGUNDO do bump
   * ainda vale (janela <1s, documentada em `sessaoValida.ts`). Um atacante real tem tokens de
   * minutos/horas; o teste precisa de um token realisticamente antigo, senão a corrida contra o
   * relógio do próprio teste decide o resultado.
   */
  function tokenAntigo(u: { id: string; role: 'DRIVER'; operatorId: string | null }): string {
    return jwt.sign({ userId: u.id, role: u.role, operatorId: u.operatorId, iat: Math.floor(Date.now() / 1000) - 10 }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' })
  }

  async function driverComSenha(label: string) {
    const passwordHash = await bcrypt.hash(SENHA, 4)
    return createUser({ role: 'DRIVER', label, suffix, passwordHash })
  }

  const wallet = (token: string) => request(app).get('/api/me/wallet').set('Authorization', `Bearer ${token}`)

  it('sem revogação: o token vale (linha de base)', async () => {
    const u = await driverComSenha('base')
    expect((await wallet(u.token)).status).toBe(200)
  })

  it('conta DESATIVADA corta o token (Órion M1) — depois do cache de 30s, ou na hora se o cache for derrubado', async () => {
    const u = await driverComSenha('inativo')
    expect((await wallet(u.token)).status).toBe(200)

    await prisma.user.update({ where: { id: u.id }, data: { active: false } })
    sessionValidator.invalidate(u.id) // o que a API faria na mesma instância; em outra, vale em até 30s

    const res = await wallet(u.token)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('UNAUTHORIZED')
  })

  it('papel alterado no banco depois da emissão -> token antigo recusado', async () => {
    const u = await driverComSenha('papel')
    await prisma.user.update({ where: { id: u.id }, data: { role: 'ADMIN' } })
    sessionValidator.invalidate(u.id)
    expect((await wallet(u.token)).status).toBe(401)
  })

  describe('POST /api/auth/password', () => {
    it('exige autenticação', async () => {
      const res = await request(app).post('/api/auth/password').send({ newPassword: NOVA })
      expect(res.status).toBe(401)
    })

    it('conta COM senha: sem a atual -> 400 CURRENT_PASSWORD_REQUIRED; atual errada -> 403 (NÃO 401); nova curta -> 400', async () => {
      const u = await driverComSenha('trocaerros')
      const post = (body: object) => request(app).post('/api/auth/password').set('Authorization', `Bearer ${u.token}`).send(body)

      const semAtual = await post({ newPassword: NOVA })
      expect(semAtual.status).toBe(400)
      expect(semAtual.body.code).toBe('CURRENT_PASSWORD_REQUIRED')

      const errada = await post({ currentPassword: 'errada-errada-1', newPassword: NOVA })
      expect(errada.status).toBe(403)
      expect(errada.body.code).toBe('INVALID_CURRENT_PASSWORD')

      const curta = await post({ currentPassword: SENHA, newPassword: 'curta123' })
      expect(curta.status).toBe(400)
      expect(curta.body.code).toBe('VALIDATION_ERROR')

      const igual = await post({ currentPassword: SENHA, newPassword: SENHA })
      expect(igual.status).toBe(400)
      expect(igual.body.code).toBe('PASSWORD_UNCHANGED')

      // Nada disso mexeu na sessão: o token continua valendo.
      expect((await wallet(u.token)).status).toBe(200)
    })

    it('sucesso: token NOVO vale, o ANTIGO morre, a senha antiga não loga mais e a nova sim (12 rounds no hash)', async () => {
      const u = await driverComSenha('trocaok')
      const antigo = tokenAntigo({ id: u.id, role: 'DRIVER', operatorId: null })
      expect((await wallet(antigo)).status).toBe(200)

      const res = await request(app).post('/api/auth/password').set('Authorization', `Bearer ${u.token}`).send({ currentPassword: SENHA, newPassword: NOVA })
      expect(res.status).toBe(200)
      expect(res.body.token).toEqual(expect.any(String))
      expect(res.body.user).toMatchObject({ id: u.id, role: 'DRIVER', hasPassword: true })
      expect(JSON.stringify(res.body)).not.toContain(NOVA)

      // O `iat` do token novo (segundos) NÃO pode ser recusado pelo `sessionsValidAfter` (ms) do MESMO instante.
      expect((await wallet(res.body.token)).status).toBe(200)
      expect((await wallet(antigo)).status).toBe(401)

      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
      expect(row.sessionsValidAfter).not.toBeNull()
      expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/) // custo 12 embutido no hash
      expect(await bcrypt.compare(NOVA, row.passwordHash!)).toBe(true)

      const loginAntiga = await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })
      expect(loginAntiga.status).toBe(401)
      const loginNova = await request(app).post('/api/auth/login').send({ email: u.email, password: NOVA })
      expect(loginNova.status).toBe(200)
      expect(loginNova.body.user.hasPassword).toBe(true)
    })

    it('conta só-Google (sem hash): DEFINE a primeira senha sem a atual; depois disso passa a exigir', async () => {
      const u = await createUser({ role: 'DRIVER', label: 'soGoogle', suffix, passwordHash: null })

      const primeira = await request(app).post('/api/auth/password').set('Authorization', `Bearer ${u.token}`).send({ newPassword: NOVA })
      expect(primeira.status).toBe(200)
      expect(primeira.body.user.hasPassword).toBe(true)

      const segunda = await request(app).post('/api/auth/password').set('Authorization', `Bearer ${primeira.body.token}`).send({ newPassword: 'MaisUmaSenha#789' })
      expect(segunda.status).toBe(400)
      expect(segunda.body.code).toBe('CURRENT_PASSWORD_REQUIRED')
    })

    it('limite por USUÁRIO: 8 tentativas e a 9ª leva 429 RATE_LIMITED_PASSWORD (outro usuário não é afetado)', async () => {
      const u = await driverComSenha('ratelimit')
      const outro = await driverComSenha('ratelimit-outro')
      const post = (token: string) => request(app).post('/api/auth/password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'errada-errada-1', newPassword: NOVA })

      for (let i = 0; i < 8; i++) expect((await post(u.token)).status).toBe(403)
      const bloqueada = await post(u.token)
      expect(bloqueada.status).toBe(429)
      expect(bloqueada.body.code).toBe('RATE_LIMITED_PASSWORD')

      expect((await post(outro.token)).status).toBe(403) // ainda tem tentativas: o balde é por usuário
    })
  })

  describe('vínculo do Google (pré-sequestro de conta, Órion A3)', () => {
    it('DRIVER pré-registrado por um atacante: quando a vítima vincula o Google, a SENHA do atacante morre e as sessões dele caem', async () => {
      const atacante = await driverComSenha('presequestro')
      const tokenDoAtacante = tokenAntigo({ id: atacante.id, role: 'DRIVER', operatorId: null })
      expect((await wallet(tokenDoAtacante)).status).toBe(200) // o atacante está logado

      const resultado = await autenticarComGoogle('credencial-de-teste', {
        verifyIdToken: async () => ({ sub: `sub-${suffix}-presequestro`, email: atacante.email, emailVerified: true, name: 'Vítima' }),
        users: prismaGoogleUserRepository,
      })
      expect(resultado).toMatchObject({ status: 'OK', linked: true, created: false })
      sessionValidator.invalidate(atacante.id) // a rota faz isto ao vincular

      const row = await prisma.user.findUniqueOrThrow({ where: { id: atacante.id } })
      expect(row.googleSub).toBe(`sub-${suffix}-presequestro`)
      expect(row.passwordHash).toBeNull()
      expect(row.sessionsValidAfter).not.toBeNull()

      // Senha do atacante: morta. Sessão do atacante: morta.
      const login = await request(app).post('/api/auth/login').send({ email: atacante.email, password: SENHA })
      expect(login.status).toBe(401)
      expect((await wallet(tokenDoAtacante)).status).toBe(401)

      // A vítima (dona do e-mail) entra pelo Google: um token EMITIDO AGORA vale, apesar de no mesmo segundo do bump.
      const tokenDaVitima = issueToken({ id: atacante.id, role: 'DRIVER', operatorId: null })
      expect((await wallet(tokenDaVitima)).status).toBe(200)
    })
  })
})
