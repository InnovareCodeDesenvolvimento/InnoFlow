import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'

/**
 * Achado da Íris (auditoria de QA, 2026-09-17): o isolamento multi-tenant
 * (`tenantScope.ts`/`reportingScope.ts`) foi validado MANUALMENTE contra
 * produção real, mas nunca teve teste automatizado — "funciona hoje porque a
 * Íris testou na mão; nada no CI pegaria uma regressão amanhã". Este arquivo
 * fecha essa lacuna, bloqueante antes da F5 (a partir dali um bug de escopo
 * é dinheiro real vazando entre operadores, não dado sintético).
 *
 * Fixture com DOIS operadores reais (não mock) — a mesma exigência que a
 * Íris fez ao testar na mão.
 */
describe('Isolamento multi-tenant (escopo de operador)', () => {
  const app = createApp()
  const suffix = randomUUID().slice(0, 8)

  let operatorA: { id: string }
  let operatorB: { id: string }
  let siteA: { id: string }
  let siteB: { id: string }
  let chargePointA: { id: string }
  let chargePointB: { id: string }
  let operatorAStaffToken: string
  let adminToken: string

  beforeAll(async () => {
    operatorA = await prisma.operator.create({ data: { name: `Operador A ${suffix}`, email: `operador-a-${suffix}@example.com` } })
    operatorB = await prisma.operator.create({ data: { name: `Operador B ${suffix}`, email: `operador-b-${suffix}@example.com` } })

    siteA = await prisma.site.create({
      data: { operatorId: operatorA.id, name: `Site A ${suffix}`, addressLine: 'Rua A', city: 'São Paulo', state: 'SP', postalCode: '00000-000', latitude: -23.5, longitude: -46.6 },
    })
    siteB = await prisma.site.create({
      data: { operatorId: operatorB.id, name: `Site B ${suffix}`, addressLine: 'Rua B', city: 'São Paulo', state: 'SP', postalCode: '00000-000', latitude: -23.5, longitude: -46.6 },
    })

    chargePointA = await prisma.chargePoint.create({ data: { operatorId: operatorA.id, siteId: siteA.id, ocppIdentity: `cp-a-${suffix}`, basicAuthSecretHash: 'x' } })
    chargePointB = await prisma.chargePoint.create({ data: { operatorId: operatorB.id, siteId: siteB.id, ocppIdentity: `cp-b-${suffix}`, basicAuthSecretHash: 'x' } })

    const staffA = await prisma.user.create({ data: { role: 'OPERATOR', operatorId: operatorA.id, name: `Staff A ${suffix}`, email: `staff-a-${suffix}@example.com` } })
    const admin = await prisma.user.create({ data: { role: 'ADMIN', name: `Admin ${suffix}`, email: `admin-${suffix}@example.com` } })

    operatorAStaffToken = issueToken({ id: staffA.id, role: 'OPERATOR', operatorId: staffA.operatorId })
    adminToken = issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })
  })

  afterAll(async () => {
    // Best-effort — só as entidades sem dependência de tabela append-only
    // (WalletEntry/Debt não entram neste fixture, então a cadeia inteira é
    // deletável aqui, ao contrário do fixture de conciliação financeira).
    await prisma.chargePoint.deleteMany({ where: { id: { in: [chargePointA.id, chargePointB.id] } } })
    await prisma.site.deleteMany({ where: { id: { in: [siteA.id, siteB.id] } } })
    await prisma.user.deleteMany({ where: { operatorId: { in: [operatorA.id, operatorB.id] } } })
    await prisma.user.deleteMany({ where: { email: `admin-${suffix}@example.com` } })
    await prisma.operator.deleteMany({ where: { id: { in: [operatorA.id, operatorB.id] } } })
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('OPERATOR listando charge points só vê os do próprio operador', async () => {
    const res = await request(app).get('/api/admin/charge-points').set('Authorization', `Bearer ${operatorAStaffToken}`)
    expect(res.status).toBe(200)
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toContain(chargePointA.id)
    expect(ids).not.toContain(chargePointB.id)
  })

  it('OPERATOR acessando charge point de outro operador por ID -> 404 (nunca 403 — não confirma existência de recurso de outro tenant)', async () => {
    const res = await request(app).get(`/api/admin/charge-points/${chargePointB.id}`).set('Authorization', `Bearer ${operatorAStaffToken}`)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('OPERATOR forjando siteId de outro operador em rota de relatório -> 404', async () => {
    const res = await request(app).get('/api/admin/dashboard/live').query({ siteId: siteB.id }).set('Authorization', `Bearer ${operatorAStaffToken}`)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('OPERATOR forjando chargePointId de outro operador em rota de relatório -> 404', async () => {
    const res = await request(app).get('/api/admin/dashboard/live').query({ chargePointId: chargePointB.id }).set('Authorization', `Bearer ${operatorAStaffToken}`)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('OPERATOR forjando operatorId de outro operador em rota de relatório -> 403', async () => {
    const res = await request(app).get('/api/admin/dashboard/live').query({ operatorId: operatorB.id }).set('Authorization', `Bearer ${operatorAStaffToken}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('ADMIN enxerga charge points dos dois operadores (sem filtro de tenant)', async () => {
    const res = await request(app).get('/api/admin/charge-points').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toContain(chargePointA.id)
    expect(ids).toContain(chargePointB.id)
  })

  it('sem token -> 401', async () => {
    const res = await request(app).get('/api/admin/charge-points')
    expect(res.status).toBe(401)
  })
})
