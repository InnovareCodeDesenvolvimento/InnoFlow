import { afterAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { IdentidadeGoogle } from '../../src/core/auth/decidirAcaoGoogle'

// Mesmo arranjo de `googleAuthDb.test.ts`: liga o Google ANTES de `env` ser lido e troca só o verificador do ID token; o resto (rota, decisão, repositório Prisma, Postgres) é o código real.
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
import { uniqueSuffix } from './helpers/fixtures'
import { criarMotoristaComSenha } from './helpers/lgpdFixture'
import { PRIVACIDADE_VIGENTE, TERMOS_VIGENTES } from './helpers/termos'

/**
 * L1.9 — `POST /api/auth/google` (login E cadastro na mesma rota): o aceite dos termos só é EXIGIDO quando o Google vai CRIAR uma conta nova; quem já tem conta entra sem aceitar nada.
 */
describe('Google — aceite dos termos na criação da conta (L1.9)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let n = 0
  const identidade = (over: Partial<IdentidadeGoogle> = {}): IdentidadeGoogle => ({ sub: `g-legal-${++n}-${suffix}`, email: `g-legal-${n}-${suffix}@example.com`, emailVerified: true, name: 'Google Legal', ...over })
  const credencial = (id: IdentidadeGoogle) => Buffer.from(JSON.stringify(id)).toString('base64url')
  const entrar = (id: IdentidadeGoogle, extra: Record<string, unknown> = {}) => request(app).post('/api/auth/google').send({ credential: credencial(id), ...extra })

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('conta NOVA sem `acceptedTermsVersion`: 400 VALIDATION_ERROR e NADA é criado', async () => {
    const id = identidade()
    const res = await entrar(id)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    expect(await prisma.user.count({ where: { googleSub: id.sub } })).toBe(0)
  })

  it('conta NOVA com versão antiga: 409 TERMS_VERSION_OUTDATED e NADA é criado', async () => {
    const id = identidade()
    const res = await entrar(id, { acceptedTermsVersion: 'antiga' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TERMS_VERSION_OUTDATED')
    expect(await prisma.user.count({ where: { googleSub: id.sub } })).toBe(0)
  })

  it('conta NOVA com a versão vigente: 201 e o aceite gravado com origem GOOGLE_SIGNUP (usuário + carteira + aceite atômicos)', async () => {
    const id = identidade()
    const res = await entrar(id, { acceptedTermsVersion: TERMOS_VIGENTES })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const aceites = await prisma.consentRecord.findMany({ where: { userId: res.body.user.id }, })
    expect(aceites.map((a) => ({ kind: a.kind, version: a.version, source: a.source })).sort((x, y) => x.kind.localeCompare(y.kind))).toEqual([
      { kind: 'PRIVACY', version: PRIVACIDADE_VIGENTE, source: 'GOOGLE_SIGNUP' },
      { kind: 'TERMS', version: TERMOS_VIGENTES, source: 'GOOGLE_SIGNUP' },
    ])
    expect(await prisma.wallet.count({ where: { userId: res.body.user.id } })).toBe(1)
  })

  it('quem JÁ tem conta (Google) entra SEM aceitar nada — com ou sem versão no corpo, até defasada — e nenhum aceite novo é gravado', async () => {
    const id = identidade()
    const criada = await entrar(id, { acceptedTermsVersion: TERMOS_VIGENTES })
    expect(criada.status).toBe(201)
    const antes = await prisma.consentRecord.count({ where: { userId: criada.body.user.id } })
    for (const extra of [{}, { acceptedTermsVersion: 'antiga' }]) {
      const res = await entrar(id, extra)
      expect(res.status, JSON.stringify(extra)).toBe(200)
      expect(res.body.user.id).toBe(criada.body.user.id)
    }
    expect(await prisma.consentRecord.count({ where: { userId: criada.body.user.id } })).toBe(antes)
  })

  it('vincular o Google a uma conta existente por e-mail (login) também não exige aceite novo', async () => {
    const m = await criarMotoristaComSenha(suffix, 'g-vinculo')
    const res = await entrar(identidade({ email: m.email }))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.user.id).toBe(m.id)
  })
})
