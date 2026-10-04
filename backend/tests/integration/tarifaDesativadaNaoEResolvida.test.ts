import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { resolveActiveTariff } from '../../src/ocpp/tariffResolution'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'
import { createTenant, uniqueSuffix } from './helpers/fixtures'

/**
 * Achado da Lyra / decisão do Atlas: `resolveActiveTariff` NÃO filtrava `Tariff.active` — desativar uma tarifa no admin (soft delete) não a tirava de uso (nem no início de recarga,
 * nem na tela pública). Agora só tarifas ATIVAS entram; sem nenhuma ativa -> o erro existente "Nenhuma tarifa ativa". Sessão JÁ em andamento cobra pelo `tariffSnapshot`.
 */
describe('tarifa desativada (Tariff.active = false) não é mais resolvida', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let fixture: FixtureCartao

  beforeAll(async () => {
    fixture = await criarFixtureCartao(app, suffix, 'tarifa-ativa')
  }, 30_000)
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  /** Tenant novo com uma tarifa ativa vinculada ao OPERADOR (o `createTenant` cria a tarifa mas não o vínculo). */
  async function tenantComTarifa(label: string) {
    const t = await createTenant({ suffix, label })
    await prisma.tariffAssignment.create({ data: { operatorId: t.operatorId, tariffId: t.tariffId, scope: 'OPERATOR' } })
    const chargePoint = await prisma.chargePoint.findUniqueOrThrow({ where: { id: t.chargePointId } })
    return { t, chargePoint, connector: { id: t.connectorId } }
  }

  it('tarifa ativa é resolvida; desativada -> "Nenhuma tarifa ativa"; reativada volta a valer', async () => {
    const { t, chargePoint, connector } = await tenantComTarifa('resolve')
    expect((await resolveActiveTariff(connector, chargePoint)).id).toBe(t.tariffId)

    await prisma.tariff.update({ where: { id: t.tariffId }, data: { active: false } })
    await expect(resolveActiveTariff(connector, chargePoint)).rejects.toThrow(/Nenhuma tarifa ativa/)

    await prisma.tariff.update({ where: { id: t.tariffId }, data: { active: true } })
    expect((await resolveActiveTariff(connector, chargePoint)).id).toBe(t.tariffId)
  })

  it('o vínculo de MAIOR prioridade com tarifa desativada é ignorado: vale o próximo vínculo ATIVO (não o erro, não a tarifa morta)', async () => {
    const { t, chargePoint, connector } = await tenantComTarifa('prioridade')
    const maisPrioritaria = await prisma.tariff.create({ data: { operatorId: t.operatorId, name: `Tarifa premium ${suffix}`, model: 'PER_KWH', pricePerKwh: '2.00' } })
    await prisma.tariffAssignment.create({ data: { operatorId: t.operatorId, tariffId: maisPrioritaria.id, scope: 'CONNECTOR', connectorId: t.connectorId, priority: 10 } })
    expect((await resolveActiveTariff(connector, chargePoint)).id).toBe(maisPrioritaria.id)

    await prisma.tariff.update({ where: { id: maisPrioritaria.id }, data: { active: false } })
    expect((await resolveActiveTariff(connector, chargePoint)).id).toBe(t.tariffId)

    await prisma.tariff.update({ where: { id: t.tariffId }, data: { active: false } })
    await expect(resolveActiveTariff(connector, chargePoint)).rejects.toThrow(/Nenhuma tarifa ativa/)
  })

  it('tela pública do carregador: tarifa desativada some do resumo (tariff: null) — antes continuava sendo mostrada', async () => {
    const { t, chargePoint } = await tenantComTarifa('publica')
    await prisma.chargePoint.update({ where: { id: chargePoint.id }, data: { active: true } })
    const antes = await request(app).get(`/api/public/charge-points/${encodeURIComponent(chargePoint.ocppIdentity)}`)
    expect(antes.status, JSON.stringify(antes.body)).toBe(200)
    expect(antes.body.connectors[0].tariff).toMatchObject({ pricePerKwh: '1' })

    await prisma.tariff.update({ where: { id: t.tariffId }, data: { active: false } })
    const depois = await request(app).get(`/api/public/charge-points/${encodeURIComponent(chargePoint.ocppIdentity)}`)
    expect(depois.status).toBe(200)
    expect(depois.body.connectors[0].tariff).toBeNull()
  })

  it('SESSÃO JÁ ABERTA cobra pelo snapshot mesmo com a tarifa desativada no meio da carga', async () => {
    // Sessão aberta com a tarifa ATIVA (1.00/kWh); a tarifa é desativada ANTES do Stop (callback `antesDoStop` da fixture); 3 kWh = R$ 3,00 pelo snapshot.
    const s = await fixture.sessaoParada('snapshot', async () => {
      await prisma.tariff.update({ where: { id: fixture.tenant.tariffId }, data: { active: false } })
    })
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: s.intent.id } })
    expect(intent.status).toBe('CAPTURE_PENDING')
    expect(intent.captureAmountCents).toBe(300) // cobrou pelo snapshot, não falhou por "nenhuma tarifa ativa"
    const sessao = await prisma.chargingSession.findUniqueOrThrow({ where: { id: intent.chargingSessionId! } })
    expect(sessao.totalCostCents).toBe(300)
    expect(sessao.tariffSnapshot).toMatchObject({ pricePerKwh: expect.anything() })

    // Uma NOVA recarga no mesmo conector: a resolução (a mesma do StartTransaction e do POST /sessions/start) já não acha tarifa — a tarifa morta não vale mais.
    const chargePoint = await prisma.chargePoint.findUniqueOrThrow({ where: { id: fixture.tenant.chargePointId } })
    await expect(resolveActiveTariff({ id: fixture.tenant.connectorId }, chargePoint)).rejects.toThrow(/Nenhuma tarifa ativa/)
  })
})
