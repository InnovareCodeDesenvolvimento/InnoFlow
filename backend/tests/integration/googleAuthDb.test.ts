import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { IdentidadeGoogle } from '../../src/core/auth/decidirAcaoGoogle'

// Liga o login com Google ANTES de `env` ser lido (vi.hoisted roda antes dos imports) e
// troca só o verificador de ID token (a lib do Google precisa de rede/chaves reais) —
// TODO o resto (rota, decisão, repositório Prisma, Postgres) é o código de verdade.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
})
vi.mock('../../src/services/auth/googleTokenVerifier', () => ({
  /** "Credencial" de teste = a identidade em JSON/base64url; qualquer outra coisa lança (= token inválido). */
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
import { autenticarComGoogle } from '../../src/services/auth/autenticarComGoogle'
import { prismaGoogleUserRepository } from '../../src/services/auth/prismaGoogleUserRepository'
import { createTenant, createUser, settle, uniqueSuffix, waitFor, type TestTenant } from './helpers/fixtures'

/**
 * Login/cadastro com Google contra Postgres REAL. O que a suíte unitária
 * (`autenticarComGoogle.test.ts`, repositório em memória) NÃO consegue provar:
 * unique de verdade em `googleSub`/`email`, `mode: 'insensitive'` executado
 * pelo Postgres, atomicidade User+Wallet e a corrida real entre dois
 * requests simultâneos.
 */
describe('Google — banco e rota (Postgres real)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const deps = (identity: IdentidadeGoogle) => ({ verifyIdToken: async () => identity, users: prismaGoogleUserRepository })
  const identity = (label: string, over: Partial<IdentidadeGoogle> = {}): IdentidadeGoogle => ({
    sub: `google-sub-${label}-${suffix}`,
    email: `google-${label}-${suffix}@example.com`,
    emailVerified: true,
    name: `Google ${label}`,
    ...over,
  })
  const credentialOf = (id: Partial<IdentidadeGoogle>) => Buffer.from(JSON.stringify(id)).toString('base64url')

  let tenant: TestTenant

  beforeAll(async () => {
    tenant = await createTenant({ suffix, label: 'goog' })
  })

  afterAll(async () => {
    await prisma.wallet.deleteMany({ where: { user: { email: { contains: suffix } } } }).catch(() => undefined)
    await prisma.$disconnect()
    redis.disconnect()
  })

  describe('User.googleSub no banco', () => {
    it('googleSub é UNIQUE: dois usuários com o mesmo sub -> violação (P2002)', async () => {
      const sub = `dup-sub-${suffix}`
      await prisma.user.create({ data: { role: 'DRIVER', name: 'A', email: `dup-a-${suffix}@example.com`, googleSub: sub } })
      await expect(prisma.user.create({ data: { role: 'DRIVER', name: 'B', email: `dup-b-${suffix}@example.com`, googleSub: sub } })).rejects.toMatchObject({ code: 'P2002' })
    })

    it('NULL não colide: vários usuários SEM googleSub coexistem', async () => {
      await prisma.user.create({ data: { role: 'DRIVER', name: 'N1', email: `null-1-${suffix}@example.com` } })
      await prisma.user.create({ data: { role: 'DRIVER', name: 'N2', email: `null-2-${suffix}@example.com` } })
      expect(await prisma.user.count({ where: { email: { startsWith: 'null-', endsWith: `${suffix}@example.com` }, googleSub: null } })).toBe(2)
    })

    it('e-mail continua UNIQUE no banco (a corrida por e-mail também é barrada pelo Postgres)', async () => {
      await prisma.user.create({ data: { role: 'DRIVER', name: 'E1', email: `email-dup-${suffix}@example.com` } })
      await expect(prisma.user.create({ data: { role: 'DRIVER', name: 'E2', email: `email-dup-${suffix}@example.com` } })).rejects.toMatchObject({ code: 'P2002' })
    })
  })

  describe('criação atômica e corrida real (autenticarComGoogle + repositório Prisma)', () => {
    it('conta nova: 1 User DRIVER (sem senha) + 1 Wallet, sub gravado', async () => {
      const id = identity('novo')
      const r = await autenticarComGoogle('cred', deps(id))
      expect(r).toMatchObject({ status: 'OK', created: true, linked: false })

      const user = await prisma.user.findUniqueOrThrow({ where: { googleSub: id.sub }, include: { wallet: true } })
      expect(user).toMatchObject({ role: 'DRIVER', email: id.email, passwordHash: null, operatorId: null, active: true })
      expect(user.wallet).not.toBeNull()
    })

    it('DOIS requests simultâneos do MESMO Google (sub+e-mail) -> 1 User + 1 Wallet, nenhum lança, o perdedor "entra"', async () => {
      // Várias identidades, vários pares: uma corrida só pode escapar por sorte; 6 pares deixam a janela aberta de verdade.
      for (let i = 0; i < 6; i++) {
        const id = identity(`corrida${i}`)
        const [a, b] = await Promise.all([autenticarComGoogle('c', deps(id)), autenticarComGoogle('c', deps(id))])

        expect(a.status).toBe('OK')
        expect(b.status).toBe('OK')
        const users = await prisma.user.findMany({ where: { OR: [{ googleSub: id.sub }, { email: id.email }] }, include: { wallet: true } })
        expect(users, `par ${i}: tem que existir exatamente 1 User`).toHaveLength(1)
        expect(users[0].wallet, `par ${i}: e exatamente 1 Wallet`).not.toBeNull()
        expect(await prisma.wallet.count({ where: { userId: users[0].id } })).toBe(1)
        if (a.status === 'OK' && b.status === 'OK') {
          expect(a.user.id).toBe(b.user.id)
          // Exatamente um venceu a criação; o outro caiu no LOGIN.
          expect([a.created, b.created].filter(Boolean)).toHaveLength(1)
        }
      }
    })

    it('DOIS requests simultâneos, MESMO e-mail com subs DIFERENTES -> 1 User (o 2º é recusado, sem 500 e sem sobrescrever o vínculo)', async () => {
      const base = identity('mesmo-email')
      const first = { ...base, sub: `${base.sub}-1` }
      const second = { ...base, sub: `${base.sub}-2` }
      const settled = await Promise.allSettled([autenticarComGoogle('c', deps(first)), autenticarComGoogle('c', deps(second))])

      expect(settled.every((s) => s.status === 'fulfilled'), 'nenhuma das duas pode lançar (lançar = 500 na rota)').toBe(true)
      const statuses = settled.map((s) => (s.status === 'fulfilled' ? s.value.status : 'x')).sort()
      expect(statuses).toEqual(['ACCOUNT_MISMATCH', 'OK'])

      const users = await prisma.user.findMany({ where: { email: base.email } })
      expect(users).toHaveLength(1)
      expect([first.sub, second.sub]).toContain(users[0].googleSub)
    })
  })

  describe('regra de staff (e-mail com caixa diferente) contra o Postgres', () => {
    for (const role of ['ADMIN', 'OPERATOR'] as const) {
      it(`conta ${role} cadastrada com e-mail em CAIXA MISTA + Google com e-mail minúsculo -> STAFF_NOT_ALLOWED, nada criado nem vinculado`, async () => {
        const mixed = `Staff-${role}-Mixed-${suffix}@Example.COM`
        const staff = await prisma.user.create({
          data: { role, operatorId: role === 'OPERATOR' ? tenant.operatorId : null, name: `Staff ${role}`, email: mixed, passwordHash: 'x' },
        })
        const id = identity(`staff-${role}`, { email: mixed.toLowerCase() })

        const r = await autenticarComGoogle('c', deps(id))

        expect(r.status).toBe('STAFF_NOT_ALLOWED')
        if (r.status === 'STAFF_NOT_ALLOWED') expect(r.staff.id).toBe(staff.id)
        expect((await prisma.user.findUniqueOrThrow({ where: { id: staff.id } })).googleSub).toBeNull() // nunca vinculado
        expect(await prisma.user.count({ where: { googleSub: id.sub } })).toBe(0) // nenhum DRIVER "fantasma" criado
        expect(await prisma.user.count({ where: { email: { equals: id.email, mode: 'insensitive' } } })).toBe(1)
      })
    }

    it('DRIVER e STAFF com a mesma grafia-insensível: a presença do staff recusa, mesmo havendo um DRIVER', async () => {
      const email = `misto-${suffix}@example.com`
      const staff = await prisma.user.create({ data: { role: 'ADMIN', name: 'Admin misto', email: email.toUpperCase(), passwordHash: 'x' } })
      await prisma.user.create({ data: { role: 'DRIVER', name: 'Driver misto', email } })
      const r = await autenticarComGoogle('c', deps(identity('misto', { email })))
      expect(r.status).toBe('STAFF_NOT_ALLOWED')
      if (r.status === 'STAFF_NOT_ALLOWED') expect(r.staff.id).toBe(staff.id)
    })
  })

  describe('vínculo e recusas de DRIVER', () => {
    it('DRIVER existente (cadastrado por senha, e-mail em caixa diferente) é VINCULADO ao sub — mesmo usuário, mesma carteira', async () => {
      const driver = await prisma.user.create({ data: { role: 'DRIVER', name: 'Driver senha', email: `Vincula-${suffix}@Example.com`, passwordHash: 'hash', wallet: { create: {} } }, include: { wallet: true } })
      const id = identity('vincula', { email: `vincula-${suffix}@example.com` })

      const r = await autenticarComGoogle('c', deps(id))
      expect(r).toMatchObject({ status: 'OK', created: false, linked: true })
      if (r.status === 'OK') expect(r.user.id).toBe(driver.id)

      const after = await prisma.user.findUniqueOrThrow({ where: { id: driver.id }, include: { wallet: true } })
      expect(after.googleSub).toBe(id.sub)
      expect(after.passwordHash).toBe('hash') // login por senha continua valendo
      expect(after.wallet?.id).toBe(driver.wallet?.id)
      expect(await prisma.wallet.count({ where: { userId: driver.id } })).toBe(1)

      // Segunda entrada: agora pelo sub — LOGIN puro, nada muda.
      const again = await autenticarComGoogle('c', deps(id))
      expect(again).toMatchObject({ status: 'OK', created: false, linked: false })
    })

    it('DRIVER já vinculado a OUTRO sub do Google -> ACCOUNT_MISMATCH e o vínculo original NÃO é sobrescrito', async () => {
      const original = `orig-sub-${suffix}`
      const driver = await prisma.user.create({ data: { role: 'DRIVER', name: 'Driver ocupado', email: `ocupado-${suffix}@example.com`, googleSub: original } })
      const r = await autenticarComGoogle('c', deps(identity('ocupado', { sub: `outro-sub-${suffix}`, email: driver.email })))
      expect(r.status).toBe('ACCOUNT_MISMATCH')
      expect((await prisma.user.findUniqueOrThrow({ where: { id: driver.id } })).googleSub).toBe(original)
    })

    it('DRIVER inativo -> INACTIVE, sem vincular', async () => {
      const driver = await prisma.user.create({ data: { role: 'DRIVER', name: 'Driver inativo', email: `inativo-${suffix}@example.com`, active: false } })
      const r = await autenticarComGoogle('c', deps(identity('inativo', { email: driver.email })))
      expect(r.status).toBe('INACTIVE')
      expect((await prisma.user.findUniqueOrThrow({ where: { id: driver.id } })).googleSub).toBeNull()
    })

    it('e-mail NÃO verificado no Google -> EMAIL_NOT_VERIFIED e nada é gravado', async () => {
      const id = identity('nao-verificado', { emailVerified: false })
      expect((await autenticarComGoogle('c', deps(id))).status).toBe('EMAIL_NOT_VERIFIED')
      expect(await prisma.user.count({ where: { OR: [{ googleSub: id.sub }, { email: id.email }] } })).toBe(0)
    })
  })

  describe('POST /api/auth/google (rota completa, verificador simulado)', () => {
    it('conta nova -> 201 com token e user DRIVER; segunda vez -> 200 (mesmo usuário)', async () => {
      const id = identity('rota-nova')
      const first = await request(app).post('/api/auth/google').send({ credential: credentialOf(id) })
      expect(first.status, JSON.stringify(first.body)).toBe(201)
      expect(first.body.user).toMatchObject({ role: 'DRIVER', email: id.email, operatorId: null })
      expect(typeof first.body.token).toBe('string')

      const second = await request(app).post('/api/auth/google').send({ credential: credentialOf(id) })
      expect(second.status).toBe(200)
      expect(second.body.user.id).toBe(first.body.user.id)
    })

    it('credencial inválida -> 401 INVALID_GOOGLE_TOKEN; e-mail não verificado -> 403', async () => {
      const bad = await request(app).post('/api/auth/google').send({ credential: 'isto-nao-e-um-token' })
      expect(bad.status).toBe(401)
      expect(bad.body.code).toBe('INVALID_GOOGLE_TOKEN')

      const unverified = await request(app).post('/api/auth/google').send({ credential: credentialOf(identity('rota-nv', { emailVerified: false })) })
      expect(unverified.status).toBe(403)
      expect(unverified.body.code).toBe('GOOGLE_EMAIL_NOT_VERIFIED')
    })

    it('conta de STAFF (e-mail em caixa diferente) -> 403 GOOGLE_LOGIN_NOT_ALLOWED e grava LOGIN_FAILED "google_login_blocked" no AuditLog', async () => {
      const staff = await createUser({ role: 'ADMIN', label: 'admin-google', suffix })
      const res = await request(app)
        .post('/api/auth/google')
        .send({ credential: credentialOf(identity('rota-staff', { email: staff.email.toUpperCase() })) })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('GOOGLE_LOGIN_NOT_ALLOWED')

      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: staff.id, action: 'LOGIN_FAILED' } }), { what: 'auditoria do login Google bloqueado' })
      expect(row).toMatchObject({ outcome: 'FAILED', httpStatus: 403, actionDetail: 'google_login_blocked', path: '/api/auth/google', actorRole: 'ADMIN' })
      await settle()
      expect(await prisma.auditLog.count({ where: { actorUserId: staff.id } })).toBe(1)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: staff.id } })).googleSub).toBeNull()
    })

    it('recusa de DRIVER (mismatch) NÃO grava auditoria — só staff bloqueado é sinal de segurança', async () => {
      const driver = await prisma.user.create({ data: { role: 'DRIVER', name: 'Driver mm', email: `rota-mm-${suffix}@example.com`, googleSub: `rota-mm-orig-${suffix}` } })
      const res = await request(app).post('/api/auth/google').send({ credential: credentialOf(identity('rota-mm', { sub: `rota-mm-outro-${suffix}`, email: driver.email })) })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('GOOGLE_LOGIN_NOT_ALLOWED')
      await settle()
      expect(await prisma.auditLog.count({ where: { actorUserId: driver.id } })).toBe(0)
    })
  })
})
