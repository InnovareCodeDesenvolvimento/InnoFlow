import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { createApp } from '../../src/api/app'
import { redis } from '../../src/lib/redis'
import { createTenant, createUser, uniqueSuffix } from './helpers/fixtures'

/**
 * Endurecimento de auth/busca contra Postgres REAL (Órion M7/M9 e helmet, 2026-09-19). Sem Redis
 * no ambiente, o throttle de login por conta cai no fail-open (também coberto: o login NÃO pode
 * pendurar com o Redis fora do ar).
 */
describe('auth e busca — endurecimento (Postgres real)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const SENHA = 'SenhaAtual#123'

  afterAll(async () => {
    redis.disconnect()
  })

  describe('M9 — busca de motoristas por OPERATOR não é curinga', () => {
    it('?search=%%%% (passa no mínimo de 3 chars) NÃO lista a rede inteira; uma busca real por nome continua funcionando', async () => {
      const tenant = await createTenant({ suffix, label: 'busca', withCharger: false })
      const alvo = await createUser({ role: 'DRIVER', label: 'zebra-unica', suffix })
      await createUser({ role: 'DRIVER', label: 'outro-motorista', suffix })
      const auth = { Authorization: `Bearer ${tenant.staff.token}` }

      const curinga = await request(app).get('/api/admin/drivers').query({ search: '%%%%' }).set(auth)
      expect(curinga.status).toBe(200)
      expect(curinga.body.total).toBe(0) // antes: TODOS os motoristas da rede
      expect(curinga.body.items).toEqual([])

      const sublinhado = await request(app).get('/api/admin/drivers').query({ search: '___' }).set(auth)
      expect(sublinhado.body.total).toBe(0)

      const real = await request(app).get('/api/admin/drivers').query({ search: `zebra-unica ${suffix}` }).set(auth)
      expect(real.status).toBe(200)
      expect(real.body.items.map((i: { id: string }) => i.id)).toEqual([alvo.id])
    })
  })

  describe('M7 — login', () => {
    it('login correto continua funcionando (e não pendura com o Redis fora do ar: fail-open)', async () => {
      const passwordHash = await bcrypt.hash(SENHA, 4)
      const u = await createUser({ role: 'DRIVER', label: 'login-ok', suffix, passwordHash })

      const res = await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })

      expect(res.status).toBe(200)
      expect(res.body.user).toMatchObject({ id: u.id, hasPassword: true })
    })

    it('credencial inválida de e-mail INEXISTENTE, conta INATIVA, conta SÓ-GOOGLE e senha errada: MESMA resposta (401 INVALID_CREDENTIALS)', async () => {
      const passwordHash = await bcrypt.hash(SENHA, 4)
      const inativo = await createUser({ role: 'DRIVER', label: 'inativo', suffix, passwordHash })
      const { prisma } = await import('../../src/lib/prisma')
      await prisma.user.update({ where: { id: inativo.id }, data: { active: false } })
      const soGoogle = await createUser({ role: 'DRIVER', label: 'sogoogle', suffix, passwordHash: null })
      const errada = await createUser({ role: 'DRIVER', label: 'errada', suffix, passwordHash })

      const casos = [
        { email: `nao-existe-${suffix}@example.com`, password: SENHA },
        { email: inativo.email, password: SENHA },
        { email: soGoogle.email, password: SENHA },
        { email: errada.email, password: 'errada-errada-1' },
      ]
      const respostas = []
      for (const c of casos) respostas.push(await request(app).post('/api/auth/login').send(c))

      for (const r of respostas) {
        expect(r.status).toBe(401)
        expect(r.body).toEqual({ error: 'E-mail ou senha inválidos.', code: 'INVALID_CREDENTIALS' })
      }
    })

    it('TEMPO CONSTANTE: e-mail inexistente/inativo/só-Google NÃO respondem ~instantaneamente (fazem o mesmo bcrypt do caminho da senha errada)', async () => {
      const passwordHash = await bcrypt.hash(SENHA, 12) // custo real (novo) para a conta que existe
      const existente = await createUser({ role: 'DRIVER', label: 'tempo', suffix, passwordHash })
      const soGoogle = await createUser({ role: 'DRIVER', label: 'tempo-google', suffix, passwordHash: null })

      const medir = async (email: string): Promise<number> => {
        const t0 = process.hrtime.bigint()
        await request(app).post('/api/auth/login').send({ email, password: 'senha-errada-qualquer' })
        return Number(process.hrtime.bigint() - t0) / 1e6
      }
      await medir(existente.email) // aquece (gera o hash falso na 1ª vez, conexões, JIT)

      const comSenhaErrada = await medir(existente.email)
      const inexistente = await medir(`fantasma-${suffix}@example.com`)
      const semSenha = await medir(soGoogle.email)

      // Antes: inexistente/só-Google ~0-5ms vs ~250ms (bcrypt custo 12). Agora todos pagam o bcrypt.
      expect(inexistente).toBeGreaterThan(comSenhaErrada * 0.4)
      expect(semSenha).toBeGreaterThan(comSenhaErrada * 0.4)
      expect(inexistente).toBeGreaterThan(50)
    })
  })

  describe('helmet — HSTS é do nginx', () => {
    it('a API NÃO envia Strict-Transport-Security (antes: max-age=15552000; includeSubDomains, duplicado com o do nginx)', async () => {
      const res = await request(app).get('/api/public/config') // /health depende do Redis (não há Redis neste ambiente)
      expect(res.headers['strict-transport-security']).toBeUndefined()
      expect(res.headers['x-content-type-options']).toBe('nosniff') // o resto do helmet continua
    })
  })

  describe('409 DUPLICATE não devolve o meta do Prisma', () => {
    it('violação de unique de verdade (P2002): 409 DUPLICATE sem `details`/meta com nomes de constraint/coluna', async () => {
      const tenant = await createTenant({ suffix, label: 'dup', withCharger: false })
      const admin = await createUser({ role: 'ADMIN', label: 'dup-admin', suffix })
      const body = { siteId: tenant.siteId, ocppIdentity: `cpx-dup-${suffix}`, basicAuthSecret: 'segredo-do-carregador-01' }
      const auth = { Authorization: `Bearer ${admin.token}` }

      const primeira = await request(app).post('/api/admin/charge-points').set(auth).send(body)
      expect(primeira.status).toBe(201)

      const duplicada = await request(app).post('/api/admin/charge-points').set(auth).send(body)
      expect(duplicada.status).toBe(409)
      expect(duplicada.body).toEqual({ error: 'Registro duplicado. Verifique os dados informados.', code: 'DUPLICATE' })
    })

    it('segredo do carregador com menos de 16 caracteres é recusado (Órion A1)', async () => {
      const tenant = await createTenant({ suffix, label: 'dup2', withCharger: false })
      const admin = await createUser({ role: 'ADMIN', label: 'dup2-admin', suffix })
      const res = await request(app)
        .post('/api/admin/charge-points')
        .set({ Authorization: `Bearer ${admin.token}` })
        .send({ siteId: tenant.siteId, ocppIdentity: `cp-curto-${suffix}`, basicAuthSecret: 'curta1234' })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('VALIDATION_ERROR')
    })
  })
})
