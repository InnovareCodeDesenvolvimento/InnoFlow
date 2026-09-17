import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Prisma } from '@prisma/client'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'

/**
 * PWA do motorista (F6, 2026-09-17) — cobre as duas lacunas mais sensíveis
 * pedidas pelo Atlas para esta entrega:
 *
 *   1. Motorista A não pode ver/parar a sessão de motorista B (isolamento por
 *      `userId`, sempre 404 — nunca 403, mesma convenção anti-enumeração já
 *      testada em `tenantScope.test.ts` para operador).
 *   2. Lock anti-duplo-toque (`me:start:{userId}`) e `ALREADY_HAS_ACTIVE_SESSION`
 *      — duas requisições de start do MESMO motorista nunca completam as
 *      duas com sucesso.
 *
 * NOTA para quem reexecutar isto localmente: `driverA` recebe uma
 * `WalletEntry` (append-only por trigger) — não é removida no `afterAll`
 * pela mesma razão documentada em `paymentsReconciliation.test.ts`. Nomes
 * únicos (`suffix`) evitam colisão entre execuções.
 */
describe('PWA do motorista — isolamento por userId e lock anti-duplo-toque (/api/me/*)', () => {
  const app = createApp()
  const suffix = randomUUID().slice(0, 8)
  const now = new Date()

  let operator: { id: string }
  let site: { id: string }
  let chargePoint: { id: string; ocppIdentity: string }
  let connector: { id: string }
  let tariff: { id: string }
  let driverA: { id: string }
  let driverB: { id: string }
  let driverAToken: string
  let driverBToken: string
  let activeSessionOfA: string

  const sessionIds: string[] = []
  const authTokenIds: string[] = []
  const extraUserIds: string[] = []

  function makeIdTag(): string {
    return `T${randomUUID().replace(/-/g, '')}`.slice(0, 20)
  }

  const tariffSnapshot = {
    id: 'placeholder',
    model: 'PER_KWH',
    pricePerKwh: '1.00',
    pricePerMinute: null,
    sessionFeeCents: null,
    minChargeCents: null,
    idleFeePerMinute: 0,
    idleGracePeriodSeconds: 0,
    windows: [],
  } as unknown as Prisma.InputJsonValue

  beforeAll(async () => {
    operator = await prisma.operator.create({ data: { name: `Operador Me ${suffix}`, email: `operador-me-${suffix}@example.com` } })
    site = await prisma.site.create({
      data: { operatorId: operator.id, name: `Site Me ${suffix}`, addressLine: 'Rua Me', city: 'São Paulo', state: 'SP', postalCode: '00000-000', latitude: -23.5, longitude: -46.6 },
    })
    chargePoint = await prisma.chargePoint.create({
      data: { operatorId: operator.id, siteId: site.id, ocppIdentity: `cp-me-${suffix}`, basicAuthSecretHash: 'x', active: true, lastSeenAt: now },
    })
    connector = await prisma.connector.create({ data: { operatorId: operator.id, chargePointId: chargePoint.id, connectorId: 1, type: 'AC_TYPE2', status: 'AVAILABLE' } })
    tariff = await prisma.tariff.create({ data: { operatorId: operator.id, name: `Tarifa Me ${suffix}`, model: 'PER_KWH', pricePerKwh: '1.00' } })
    await prisma.tariffAssignment.create({ data: { operatorId: operator.id, tariffId: tariff.id, scope: 'OPERATOR' } })

    driverA = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista A ${suffix}`, email: `driver-a-me-${suffix}@example.com` } })
    driverB = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista B ${suffix}`, email: `driver-b-me-${suffix}@example.com` } })
    driverAToken = issueToken({ id: driverA.id, role: 'DRIVER', operatorId: null })
    driverBToken = issueToken({ id: driverB.id, role: 'DRIVER', operatorId: null })

    // Saldo suficiente para os dois — driverB precisa poder de fato chegar a
    // 202 no teste de lock concorrente (senão cairia em INSUFFICIENT_BALANCE
    // de qualquer forma e o teste não provaria nada sobre o lock).
    const walletA = await prisma.wallet.create({ data: { userId: driverA.id } })
    await prisma.walletEntry.create({ data: { walletId: walletA.id, type: 'TOPUP_PIX', amountCents: 5000, balanceAfterCents: 5000 } })
    const walletB = await prisma.wallet.create({ data: { userId: driverB.id } })
    await prisma.walletEntry.create({ data: { walletId: walletB.id, type: 'TOPUP_PIX', amountCents: 5000, balanceAfterCents: 5000 } })

    const authTokenA = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driverA.id } })
    authTokenIds.push(authTokenA.id)

    // Sessão ATIVA de A — usada nos testes de isolamento (B não pode ver/
    // parar) e no teste de ALREADY_HAS_ACTIVE_SESSION (A tentando iniciar
    // uma segunda enquanto já tem esta).
    const sessionA = await prisma.chargingSession.create({
      data: {
        operatorId: operator.id,
        siteId: site.id,
        chargePointId: chargePoint.id,
        connectorId: connector.id,
        authTokenId: authTokenA.id,
        userId: driverA.id,
        status: 'STARTED',
        meterStartWh: 0,
        startedAt: now,
        tariffId: tariff.id,
        tariffSnapshot,
      },
    })
    activeSessionOfA = sessionA.id
    sessionIds.push(sessionA.id)
  })

  afterAll(async () => {
    await prisma.chargingSession.deleteMany({ where: { id: { in: sessionIds } } })
    await prisma.authToken.deleteMany({ where: { id: { in: authTokenIds } } })
    await prisma.authToken.deleteMany({ where: { userId: { in: [driverB.id, ...extraUserIds] } } })
    await prisma.connector.deleteMany({ where: { id: connector.id } })
    await prisma.chargePoint.deleteMany({ where: { id: chargePoint.id } })
    await prisma.tariffAssignment.deleteMany({ where: { operatorId: operator.id } })
    await prisma.tariff.deleteMany({ where: { id: tariff.id } })
    await prisma.site.deleteMany({ where: { id: site.id } })
    // driverA/driverB têm WalletEntry (append-only por trigger) — não
    // removíveis, mesma limitação documentada em paymentsReconciliation.test.ts.
    await prisma.user.deleteMany({ where: { id: { in: extraUserIds } } })
    await prisma.$disconnect()
    redis.disconnect()
  })

  describe('isolamento entre motoristas — recurso de outro motorista é 404, nunca 403', () => {
    it('motorista B tentando ver o detalhe da sessão de A -> 404 SESSION_NOT_FOUND', async () => {
      const res = await request(app).get(`/api/me/sessions/${activeSessionOfA}`).set('Authorization', `Bearer ${driverBToken}`)
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('SESSION_NOT_FOUND')
    })

    it('motorista B tentando parar a sessão de A -> 404 SESSION_NOT_FOUND (nunca chega a disparar comando nenhum)', async () => {
      const res = await request(app).post(`/api/me/sessions/${activeSessionOfA}/stop`).set('Authorization', `Bearer ${driverBToken}`)
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('SESSION_NOT_FOUND')
    })

    it('motorista A vê e a própria sessão normalmente (prova que o 404 acima é isolamento, não um bug genérico)', async () => {
      const res = await request(app).get(`/api/me/sessions/${activeSessionOfA}`).set('Authorization', `Bearer ${driverAToken}`)
      expect(res.status).toBe(200)
      expect(res.body.id).toBe(activeSessionOfA)
    })

    it('ADMIN/OPERATOR não têm papel em /api/me/* — só DRIVER (403)', async () => {
      const admin = await prisma.user.create({ data: { role: 'ADMIN', name: `Admin Me ${suffix}`, email: `admin-me-${suffix}@example.com` } })
      extraUserIds.push(admin.id)
      const adminToken = issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })

      const res = await request(app).get('/api/me/wallet').set('Authorization', `Bearer ${adminToken}`)
      expect(res.status).toBe(403)
    })
  })

  describe('ALREADY_HAS_ACTIVE_SESSION — checagem contra sessão já persistida', () => {
    it('motorista com ChargingSession ativa tentando iniciar outra -> 409 com details.sessionId apontando pra sessão existente', async () => {
      const res = await request(app)
        .post('/api/me/sessions/start')
        .set('Authorization', `Bearer ${driverAToken}`)
        .send({ ocppIdentity: chargePoint.ocppIdentity, connectorId: 1 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('ALREADY_HAS_ACTIVE_SESSION')
      expect(res.body.details?.[0]?.sessionId).toBe(activeSessionOfA)
    })
  })

  describe('lock anti-duplo-toque (me:start:{userId})', () => {
    it('lock já ocupado por outra requisição -> 409 ALREADY_HAS_ACTIVE_SESSION IMEDIATAMENTE (antes de qualquer checagem de negócio)', async () => {
      const lockKey = `me:start:${driverB.id}`
      const acquired = await redis.set(lockKey, '1', 'PX', 30_000, 'NX')
      expect(acquired).toBe('OK')

      try {
        const res = await request(app)
          .post('/api/me/sessions/start')
          .set('Authorization', `Bearer ${driverBToken}`)
          .send({ ocppIdentity: chargePoint.ocppIdentity, connectorId: 1 })
        expect(res.status).toBe(409)
        expect(res.body.code).toBe('ALREADY_HAS_ACTIVE_SESSION')
      } finally {
        await redis.del(lockKey)
      }
    })

    it('duas requisições de start quase simultâneas do MESMO motorista nunca completam as duas com 202 — o lock serializa', async () => {
      const authTokensBefore = await prisma.authToken.count({ where: { userId: driverB.id, type: 'VIRTUAL' } })

      const [res1, res2] = await Promise.all([
        request(app).post('/api/me/sessions/start').set('Authorization', `Bearer ${driverBToken}`).send({ ocppIdentity: chargePoint.ocppIdentity, connectorId: 1 }),
        request(app).post('/api/me/sessions/start').set('Authorization', `Bearer ${driverBToken}`).send({ ocppIdentity: chargePoint.ocppIdentity, connectorId: 1 }),
      ])

      const statuses = [res1.status, res2.status]
      // Nunca as duas 202 juntas — pelo menos uma tem que ser barrada pelo
      // lock (409 ALREADY_HAS_ACTIVE_SESSION).
      expect(statuses).not.toEqual([202, 202])
      expect(statuses.some((s) => s === 409)).toBe(true)

      // Prova de nível de dado (não só o código HTTP): no máximo UM idTag
      // VIRTUAL novo foi criado para este motorista — nunca dois
      // RemoteStartTransaction concorrentes disparados de verdade.
      const authTokensAfter = await prisma.authToken.count({ where: { userId: driverB.id, type: 'VIRTUAL' } })
      expect(authTokensAfter - authTokensBefore).toBeLessThanOrEqual(1)
    })
  })
})
