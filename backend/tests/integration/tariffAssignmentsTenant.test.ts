import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { resolveActiveTariff } from '../../src/ocpp/tariffResolution'
import { createTenant, createUser, settle, uniqueSuffix, waitFor, type TestTenant, type TestUser } from './helpers/fixtures'

/**
 * Multi-tenant do CRUD de vínculos de tarifa (`/api/admin/tariff-assignments`,
 * F-vínculo) e exclusividade ADMIN do log de auditoria
 * (`/api/admin/audit-logs*`), contra Postgres real com DOIS operadores.
 * Regra dura: OPERATOR A nunca cria/lista/edita/apaga vínculo de B, nem
 * aponta tarifa de B para carregador de A — e a resposta a quem tenta é 404
 * (nunca 403: não confirma que o recurso do outro tenant existe).
 */
describe('tariff-assignments e audit-logs — isolamento multi-tenant (Postgres real)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()

  let a: TestTenant
  let b: TestTenant
  let admin: TestUser
  let driver: TestUser
  let assignmentB: { id: string; validTo: Date | null }
  const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` })
  const post = (u: TestUser, body: Record<string, unknown>) => request(app).post('/api/admin/tariff-assignments').set(auth(u)).send(body)

  beforeAll(async () => {
    a = await createTenant({ suffix, label: 'taA' })
    b = await createTenant({ suffix, label: 'taB' })
    admin = await createUser({ role: 'ADMIN', label: 'admin-ta', suffix })
    driver = await createUser({ role: 'DRIVER', label: 'driver-ta', suffix })
    // Vínculo do tenant B criado direto no banco (preparação; o que se testa é o acesso de A a ele).
    assignmentB = await prisma.tariffAssignment.create({ data: { operatorId: b.operatorId, tariffId: b.tariffId, scope: 'SITE', siteId: b.siteId, priority: 5 } })
  })

  afterAll(async () => {
    const operatorIds = [a.operatorId, b.operatorId]
    await prisma.tariffAssignment.deleteMany({ where: { operatorId: { in: operatorIds } } }).catch(() => undefined)
    await prisma.tariff.deleteMany({ where: { operatorId: { in: operatorIds } } }).catch(() => undefined)
    await prisma.$disconnect()
    redis.disconnect()
  })

  describe('criação', () => {
    it('OPERATOR A cria vínculo SITE para o próprio site com a própria tarifa -> 201, operatorId = A', async () => {
      const res = await post(a.staff, { tariffId: a.tariffId, scope: 'SITE', siteId: a.siteId, priority: 1 })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body).toMatchObject({ operatorId: a.operatorId, tariffId: a.tariffId, scope: 'SITE', siteId: a.siteId, chargePointId: null, connectorId: null, priority: 1 })
    })

    it('OPERATOR A mandando operatorId de B no corpo é IGNORADO (nunca escolhe o tenant): o vínculo nasce em A, e tarifa/site de B viram 404', async () => {
      const own = await post(a.staff, { operatorId: b.operatorId, tariffId: a.tariffId, scope: 'CHARGE_POINT', chargePointId: a.chargePointId })
      expect(own.status).toBe(201)
      expect(own.body.operatorId).toBe(a.operatorId)

      const forged = await post(a.staff, { operatorId: b.operatorId, tariffId: b.tariffId, scope: 'SITE', siteId: b.siteId })
      expect(forged.status).toBe(404)
      expect(await prisma.tariffAssignment.count({ where: { operatorId: b.operatorId } })).toBe(1) // só o do preparo
    })

    it('OPERATOR A apontando a tarifa de B para carregador/site/conector de A -> 404 e nada gravado', async () => {
      const before = await prisma.tariffAssignment.count({ where: { operatorId: a.operatorId } })
      const cases = [
        { tariffId: b.tariffId, scope: 'SITE', siteId: a.siteId },
        { tariffId: b.tariffId, scope: 'CHARGE_POINT', chargePointId: a.chargePointId },
        { tariffId: b.tariffId, scope: 'CONNECTOR', connectorId: a.connectorId },
        { tariffId: b.tariffId, scope: 'OPERATOR' },
      ]
      for (const body of cases) {
        const res = await post(a.staff, body)
        expect(res.status, JSON.stringify(body)).toBe(404)
        expect(res.body.code).toBe('NOT_FOUND')
      }
      expect(await prisma.tariffAssignment.count({ where: { operatorId: a.operatorId } })).toBe(before)
    })

    it('OPERATOR A apontando a própria tarifa para site/carregador/conector de B -> 404 e nada gravado', async () => {
      const before = await prisma.tariffAssignment.count({ where: { OR: [{ siteId: b.siteId }, { chargePointId: b.chargePointId }, { connectorId: b.connectorId }] } })
      const cases = [
        { tariffId: a.tariffId, scope: 'SITE', siteId: b.siteId },
        { tariffId: a.tariffId, scope: 'CHARGE_POINT', chargePointId: b.chargePointId },
        { tariffId: a.tariffId, scope: 'CONNECTOR', connectorId: b.connectorId },
      ]
      for (const body of cases) {
        const res = await post(a.staff, body)
        expect(res.status, JSON.stringify(body)).toBe(404)
      }
      expect(await prisma.tariffAssignment.count({ where: { OR: [{ siteId: b.siteId }, { chargePointId: b.chargePointId }, { connectorId: b.connectorId }] } })).toBe(before)
    })

    it('ADMIN precisa informar o operatorId, e a tarifa/alvo têm que ser DAQUELE operador (cruzar tenants -> 404)', async () => {
      expect((await post(admin, { tariffId: a.tariffId, scope: 'OPERATOR' })).status).toBe(400) // sem operatorId

      const cross = await post(admin, { operatorId: a.operatorId, tariffId: b.tariffId, scope: 'OPERATOR' })
      expect(cross.status).toBe(404)

      const ok = await post(admin, { operatorId: b.operatorId, tariffId: b.tariffId, scope: 'CONNECTOR', connectorId: b.connectorId })
      expect(ok.status).toBe(201)
      expect(ok.body.operatorId).toBe(b.operatorId)
    })

    it('validação: alvo do escopo errado e janela invertida -> 400 (nunca chega ao banco)', async () => {
      const wrongTarget = await post(a.staff, { tariffId: a.tariffId, scope: 'SITE', siteId: a.siteId, chargePointId: a.chargePointId })
      expect(wrongTarget.status).toBe(400)
      const missingTarget = await post(a.staff, { tariffId: a.tariffId, scope: 'CONNECTOR' })
      expect(missingTarget.status).toBe(400)
      const inverted = await post(a.staff, { tariffId: a.tariffId, scope: 'OPERATOR', validFrom: '2026-10-10T00:00:00Z', validTo: '2026-10-01T00:00:00Z' })
      expect(inverted.status).toBe(400)
    })

    it('rede de segurança do BANCO: CHECK tariff_assignment_scope_consistency recusa escopo CONNECTOR com siteId junto', async () => {
      await expect(
        prisma.tariffAssignment.create({ data: { operatorId: a.operatorId, tariffId: a.tariffId, scope: 'CONNECTOR', connectorId: a.connectorId, siteId: a.siteId } }),
      ).rejects.toThrow(/tariff_assignment_scope_consistency/)
      await expect(prisma.tariffAssignment.create({ data: { operatorId: a.operatorId, tariffId: a.tariffId, scope: 'SITE' } })).rejects.toThrow(/tariff_assignment_scope_consistency/)
    })
  })

  describe('leitura, edição e exclusão de vínculo de OUTRO tenant', () => {
    it('lista: OPERATOR A só vê os próprios; filtrar pela tarifa de B devolve vazio (não vaza total)', async () => {
      const list = await request(app).get('/api/admin/tariff-assignments').query({ pageSize: 100 }).set(auth(a.staff))
      expect(list.status).toBe(200)
      const items = list.body.items as { id: string; operatorId: string }[]
      expect(items.length).toBeGreaterThan(0)
      expect(items.every((i) => i.operatorId === a.operatorId)).toBe(true)
      expect(items.some((i) => i.id === assignmentB.id)).toBe(false)

      const filtered = await request(app).get('/api/admin/tariff-assignments').query({ tariffId: b.tariffId }).set(auth(a.staff))
      expect(filtered.status).toBe(200)
      expect(filtered.body.items).toEqual([])
      expect(filtered.body.meta.total).toBe(0)
    })

    it('ADMIN enxerga os dois tenants', async () => {
      const list = await request(app).get('/api/admin/tariff-assignments').query({ pageSize: 100 }).set(auth(admin))
      const operators = new Set((list.body.items as { operatorId: string }[]).map((i) => i.operatorId))
      expect(operators.has(a.operatorId)).toBe(true)
      expect(operators.has(b.operatorId)).toBe(true)
    })

    it('GET/PATCH/DELETE por id de vínculo de B -> 404 (nunca 403) e o vínculo de B fica intacto', async () => {
      const get = await request(app).get(`/api/admin/tariff-assignments/${assignmentB.id}`).set(auth(a.staff))
      const patch = await request(app).patch(`/api/admin/tariff-assignments/${assignmentB.id}`).set(auth(a.staff)).send({ priority: 999 })
      const del = await request(app).delete(`/api/admin/tariff-assignments/${assignmentB.id}`).set(auth(a.staff))
      for (const res of [get, patch, del]) {
        expect(res.status).toBe(404)
        expect(res.body.code).toBe('NOT_FOUND')
      }
      const intact = await prisma.tariffAssignment.findUniqueOrThrow({ where: { id: assignmentB.id } })
      expect(intact).toMatchObject({ priority: 5, validTo: null })
    })

    it('PATCH no PRÓPRIO vínculo reapontando para a tarifa de B -> 404; para a própria -> 200', async () => {
      const own = await prisma.tariffAssignment.create({ data: { operatorId: a.operatorId, tariffId: a.tariffId, scope: 'SITE', siteId: a.siteId, priority: 2 } })
      const other = await prisma.tariff.create({ data: { operatorId: a.operatorId, name: `Tarifa A2 ${suffix}`, model: 'PER_KWH', pricePerKwh: '2.00' } })

      const cross = await request(app).patch(`/api/admin/tariff-assignments/${own.id}`).set(auth(a.staff)).send({ tariffId: b.tariffId })
      expect(cross.status).toBe(404)
      expect((await prisma.tariffAssignment.findUniqueOrThrow({ where: { id: own.id } })).tariffId).toBe(a.tariffId)

      const okRes = await request(app).patch(`/api/admin/tariff-assignments/${own.id}`).set(auth(a.staff)).send({ tariffId: other.id, priority: 9 })
      expect(okRes.status).toBe(200)
      expect(okRes.body).toMatchObject({ tariffId: other.id, priority: 9 })
    })
  })

  describe('DELETE é soft: expira validTo em vez de apagar', () => {
    it('204, a linha continua existindo, validTo ≈ agora, e a resolução de tarifa deixa de usá-la', async () => {
      // Tudo isolado num carregador/conector próprios, para a resolução não misturar com os outros vínculos de A.
      const cp = await prisma.chargePoint.create({ data: { operatorId: a.operatorId, siteId: a.siteId, ocppIdentity: `cp-ta-soft-${suffix}`, basicAuthSecretHash: 'x' } })
      const connector = await prisma.connector.create({ data: { operatorId: a.operatorId, chargePointId: cp.id, connectorId: 1, type: 'AC_TYPE2' } })
      const specialTariff = await prisma.tariff.create({ data: { operatorId: a.operatorId, name: `Tarifa Especial ${suffix}`, model: 'PER_KWH', pricePerKwh: '9.99' } })
      // Prioridades altas de propósito (500/1000): vínculos criados por OUTROS testes deste arquivo no mesmo site (prioridade <= 9) não podem interferir na resolução.
      // Fallback no charge point (tarifa "normal" de A) + vínculo específico, de prioridade maior, no conector.
      await post(a.staff, { tariffId: a.tariffId, scope: 'CHARGE_POINT', chargePointId: cp.id, priority: 500 }).expect(201)
      const created = await post(a.staff, { tariffId: specialTariff.id, scope: 'CONNECTOR', connectorId: connector.id, priority: 1000 })
      expect(created.status).toBe(201)

      const resolve = () => resolveActiveTariff({ id: connector.id }, { id: cp.id, siteId: a.siteId, operatorId: a.operatorId })
      expect((await resolve()).id, 'antes do DELETE a tarifa especial (prioridade 1000) vence').toBe(specialTariff.id)

      const t0 = Date.now()
      const del = await request(app).delete(`/api/admin/tariff-assignments/${created.body.id}`).set(auth(a.staff))
      expect(del.status).toBe(204)

      const row = await prisma.tariffAssignment.findUniqueOrThrow({ where: { id: created.body.id } })
      expect(row.validTo, 'a linha tem que continuar existindo, com validTo preenchido').not.toBeNull()
      expect(Math.abs(row.validTo!.getTime() - t0)).toBeLessThan(10_000)
      expect(row.tariffId).toBe(specialTariff.id) // histórico preservado

      // Deixa o relógio andar (validTo é "agora"; a regra de vigência é `validTo >= now`).
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect((await resolve()).id, 'depois do DELETE o vínculo expirado é ignorado e cai no fallback').toBe(a.tariffId)

      // GET continua achando o vínculo expirado (soft delete = histórico).
      const get = await request(app).get(`/api/admin/tariff-assignments/${created.body.id}`).set(auth(a.staff))
      expect(get.status).toBe(200)
      expect(get.body.validTo).not.toBeNull()

      await prisma.tariffAssignment.deleteMany({ where: { OR: [{ connectorId: connector.id }, { chargePointId: cp.id }] } })
      await prisma.connector.deleteMany({ where: { id: connector.id } })
      await prisma.chargePoint.deleteMany({ where: { id: cp.id } })
    })
  })

  describe('/api/admin/audit-logs é ADMIN-only', () => {
    it('ADMIN lista, filtra por ator e abre o detalhe; OPERATOR/DRIVER -> 403; sem token -> 401', async () => {
      // Gera uma linha de auditoria real (o OPERATOR A criou vínculo acima).
      const seeded = await post(a.staff, { tariffId: a.tariffId, scope: 'OPERATOR', priority: 0 })
      expect(seeded.status).toBe(201)
      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: a.staff.id, entityId: seeded.body.id } }), { what: 'auditoria do vínculo criado' })
      expect(row).toMatchObject({ entityType: 'TariffAssignment', action: 'CREATE', outcome: 'SUCCESS', targetOperatorId: a.operatorId })

      const list = await request(app).get('/api/admin/audit-logs').query({ actorUserId: a.staff.id, pageSize: 100 }).set(auth(admin))
      expect(list.status, JSON.stringify(list.body)).toBe(200)
      expect((list.body.items as { id: string }[]).map((i) => i.id)).toContain(row.id)

      const detail = await request(app).get(`/api/admin/audit-logs/${row.id}`).set(auth(admin))
      expect(detail.status).toBe(200)
      expect(detail.body).toMatchObject({ id: row.id, entityType: 'TariffAssignment', hasChanges: true })

      const actors = await request(app).get('/api/admin/audit-logs/actors').set(auth(admin))
      expect(actors.status).toBe(200)
      expect((actors.body.items as { userId: string }[]).some((i) => i.userId === a.staff.id)).toBe(true)

      for (const path of ['/api/admin/audit-logs', `/api/admin/audit-logs/${row.id}`, '/api/admin/audit-logs/actors']) {
        for (const who of [a.staff, driver]) {
          const denied = await request(app).get(path).set(auth(who))
          expect(denied.status, `${who.email} em ${path}`).toBe(403)
          expect(denied.body.code).toBe('FORBIDDEN')
        }
        expect((await request(app).get(path)).status).toBe(401)
      }
      await settle()
    })
  })
})
