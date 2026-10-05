import { afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { createApp } from '../../src/api/app'
import { env } from '../../src/lib/env'
import { redis } from '../../src/lib/redis'
import { recordCommandResult } from '../../src/ocpp/commandResultCache'
import { createTenant, createUser, uniqueSuffix } from './helpers/fixtures'

/**
 * Comportamentos que MUDARAM no endurecimento de segurança (Órion, 2026-09-19) e que só um teste de
 * ponta a ponta (rota real + banco real + Redis real) prova. O resto da lista de mudanças já tem teste
 * próprio: revogação/troca de senha/vínculo Google em sessionRevocation, DENIED por papel em
 * auditHardening, 409 sem meta em authHardening, "login só conta falhas" em loginThrottleRedis.
 */
describe('endurecimento — comportamentos que mudam (rota real, banco real, Redis real)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const chavesRedis: string[] = []

  afterAll(async () => {
    if (chavesRedis.length > 0) await redis.del(...chavesRedis)
    redis.disconnect()
  })

  describe('authenticate consulta o banco (não basta a assinatura do JWT)', () => {
    it('JWT com assinatura VÁLIDA e claims corretos, mas de um usuário que NÃO existe -> 401 UNAUTHORIZED em rota de motorista, de operador e de admin', async () => {
      const fantasma = { userId: `cfantasma${suffix}00000000000`, role: 'ADMIN', operatorId: null }
      const token = jwt.sign(fantasma, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })

      // Prova de que o token é "bom": a assinatura e o exp passam — só o banco o reprova.
      expect(jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] })).toMatchObject({ userId: fantasma.userId, role: 'ADMIN' })

      for (const rota of ['/api/admin/sites', '/api/admin/events', '/api/me/wallet', '/api/auth/password']) {
        const res = await (rota === '/api/auth/password' ? request(app).post(rota).send({ currentPassword: 'x', newPassword: 'NovaSenha#12345' }) : request(app).get(rota)).set('Authorization', `Bearer ${token}`)
        expect(res.status, rota).toBe(401)
        expect(res.body.code, rota).toBe('UNAUTHORIZED')
      }
    })

    it('a mensagem é a MESMA de token expirado/inválido (não denuncia se a conta foi apagada, desativada ou teve a senha trocada)', async () => {
      const semUsuario = jwt.sign({ userId: `cfantasma${suffix}11111111111`, role: 'DRIVER', operatorId: null }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
      const expirado = jwt.sign({ userId: 'qualquer', role: 'DRIVER', operatorId: null }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: -10 })
      const a = await request(app).get('/api/me/wallet').set('Authorization', `Bearer ${semUsuario}`)
      const b = await request(app).get('/api/me/wallet').set('Authorization', `Bearer ${expirado}`)
      expect(a.status).toBe(401)
      expect(b.status).toBe(401)
      expect(a.body).toEqual(b.body)
    })
  })

  describe('basicAuthSecret do carregador: 16 a 40 caracteres (Órion A1) pela rota real', () => {
    it('criar: 15 -> 400; 16 -> 201; 40 -> 201; 41 -> 400; 40 multibyte (80 bytes, bcrypt truncaria em silêncio) -> 400', async () => {
      const tenant = await createTenant({ suffix, label: 'secret', withCharger: false })
      const admin = await createUser({ role: 'ADMIN', label: 'secret-admin', suffix })
      const auth = { Authorization: `Bearer ${admin.token}` }
      const criar = (ident: string, basicAuthSecret: string) => request(app).post('/api/admin/charge-points').set(auth).send({ siteId: tenant.siteId, ocppIdentity: `cp-secret-${ident}-${suffix}`, basicAuthSecret })

      expect((await criar('15', 'a'.repeat(15))).status).toBe(400)
      expect((await criar('16', 'a'.repeat(16))).status).toBe(201)
      const quarenta = await criar('40', 'b'.repeat(40))
      expect(quarenta.status).toBe(201)
      expect(JSON.stringify(quarenta.body)).not.toContain('b'.repeat(40)) // o segredo nunca volta na resposta
      expect((await criar('41', 'c'.repeat(41))).status).toBe(400)
      const multibyte = await criar('mb', 'é'.repeat(40))
      expect(multibyte.status).toBe(400)
      expect(multibyte.body.code).toBe('VALIDATION_ERROR')
    })

    it('editar: o segredo é opcional, mas se vier segue a mesma regra (não dá para "trocar" por um segredo fraco); sem ele o resto se edita', async () => {
      const tenant = await createTenant({ suffix, label: 'secret-edit', withCharger: false })
      const admin = await createUser({ role: 'ADMIN', label: 'secret-edit-admin', suffix })
      const auth = { Authorization: `Bearer ${admin.token}` }
      const criado = await request(app).post('/api/admin/charge-points').set(auth).send({ siteId: tenant.siteId, ocppIdentity: `cpx-secret-edit-${suffix}`, basicAuthSecret: 'segredo-bem-comprido-01' })
      expect(criado.status).toBe(201)
      const url = `/api/admin/charge-points/${criado.body.id}`

      expect((await request(app).patch(url).set(auth).send({ basicAuthSecret: 'curto' })).status).toBe(400)
      expect((await request(app).patch(url).set(auth).send({ basicAuthSecret: 'x'.repeat(41) })).status).toBe(400)
      expect((await request(app).patch(url).set(auth).send({ vendor: 'ACME' })).status).toBe(200) // sem segredo: ok
      expect((await request(app).patch(url).set(auth).send({ basicAuthSecret: 'novo-segredo-valido-02' })).status).toBe(200)
    })
  })

  // L1.5: o registro agora carrega também o escopo (charge point/operador onde o comando foi disparado) — ids de teste fixos, só o dono importa aqui.
  const ESCOPO = (userId: string) => ({ userId, chargePointId: 'cp-teste', operatorId: 'op-teste' })

  describe('GET /api/me/commands/:correlationId só devolve o resultado ao DONO (Órion)', () => {
    it('o dono lê o resultado; OUTRO motorista e um correlationId inexistente recebem PENDING — indistinguíveis (não confirma que o id existe)', async () => {
      const dono = await createUser({ role: 'DRIVER', label: 'cmd-dono', suffix })
      const intruso = await createUser({ role: 'DRIVER', label: 'cmd-intruso', suffix })
      const correlationId = randomUUID()
      chavesRedis.push(`ocpp:cmdresult:${correlationId}`)
      await recordCommandResult(correlationId, 'ACCEPTED', ESCOPO(dono.id))
      const get = (id: string, token: string) => request(app).get(`/api/me/commands/${id}`).set('Authorization', `Bearer ${token}`)

      const doDono = await get(correlationId, dono.token)
      expect(doDono.status).toBe(200)
      expect(doDono.body).toEqual({ status: 'ACCEPTED' })

      const doIntruso = await get(correlationId, intruso.token)
      const inexistente = await get(randomUUID(), intruso.token)
      expect(doIntruso.status).toBe(200)
      expect(doIntruso.body).toEqual({ status: 'PENDING' })
      expect(doIntruso.body).toEqual(inexistente.body) // mesma resposta: nada denuncia a existência

      // Os três resultados possíveis chegam ao dono; e o do intruso continua PENDING mesmo depois de o dono já ter lido.
      for (const status of ['REJECTED', 'TIMEOUT'] as const) {
        const id = randomUUID()
        chavesRedis.push(`ocpp:cmdresult:${id}`)
        await recordCommandResult(id, status, ESCOPO(dono.id))
        expect((await get(id, dono.token)).body).toEqual({ status })
        expect((await get(id, intruso.token)).body).toEqual({ status: 'PENDING' })
      }
    })

    it('o resultado expira (TTL de 2min gravado no Redis) e a rota exige DRIVER (ADMIN/OPERATOR -> 403)', async () => {
      const dono = await createUser({ role: 'DRIVER', label: 'cmd-ttl', suffix })
      const tenant = await createTenant({ suffix, label: 'cmd-op', withCharger: false })
      const id = randomUUID()
      chavesRedis.push(`ocpp:cmdresult:${id}`)
      await recordCommandResult(id, 'ACCEPTED', ESCOPO(dono.id))

      const ttl = await redis.pttl(`ocpp:cmdresult:${id}`)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(120_000)
      expect(await redis.get(`ocpp:cmdresult:${id}`)).toBe(`${dono.id}|ACCEPTED|cp-teste|op-teste`) // vinculado ao dono E ao escopo (charge point/operador) no valor gravado

      expect((await request(app).get(`/api/me/commands/${id}`).set('Authorization', `Bearer ${tenant.staff.token}`)).status).toBe(403)
    })
  })
})
