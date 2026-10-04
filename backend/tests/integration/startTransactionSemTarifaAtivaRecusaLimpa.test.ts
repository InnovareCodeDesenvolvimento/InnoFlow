import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { handleStartTransaction } from '../../src/ocpp/handlers/startTransaction'
import { chamarHandler, criarCenario, type Cenario } from './helpers/sessaoTravadaFixture'
import { makeIdTag, uniqueSuffix } from './helpers/fixtures'

/**
 * Achado menor da Íris (rodada 2): StartTransaction com a tarifa DESATIVADA no admin respondia InternalError ao carregador (o `resolveActiveTariff` lançava um Error cru).
 * Agora é uma RECUSA limpa — `Blocked`, transactionId 0 (o carregador não libera a tomada) — com alerta para o operador, sem sessão criada e sem mexer na carteira. O caminho
 * normal (tarifa ativa) segue idêntico.
 */
describe('StartTransaction sem tarifa ativa: recusa limpa (Blocked + alerta) em vez de InternalError (Postgres + Redis reais)', () => {
  const suffix = uniqueSuffix()
  let c: Cenario
  let numero = 60

  beforeAll(async () => {
    c = await criarCenario(suffix, 'sem-tarifa')
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function motoristaComSaldo() {
    const driver = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista ${suffix}`, email: `st-${randomUUID().slice(0, 8)}-${suffix}@example.com` } })
    const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: 100_000, balanceAfterCents: 100_000, referenceType: 'MANUAL', description: 'saldo de teste' } })
    const token = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driver.id } })
    return { driver, wallet, token }
  }
  async function conectorNovo() {
    return prisma.connector.create({ data: { operatorId: c.tenant.operatorId, chargePointId: c.tenant.chargePointId, connectorId: ++numero, type: 'AC_TYPE2' } })
  }
  const start = (connectorId: number, idTag: string) => chamarHandler(handleStartTransaction, c.ctx, { connectorId, idTag, meterStart: 0, timestamp: new Date().toISOString() })

  it('controle: com a tarifa ATIVA a sessão abre normalmente (Accepted, sessão STARTED com snapshot da tarifa)', async () => {
    await prisma.tariff.update({ where: { id: c.tenant.tariffId }, data: { active: true } })
    const m = await motoristaComSaldo()
    const con = await conectorNovo()
    const r = await start(con.connectorId, m.token.idTag)
    expect(r.idTagInfo.status).toBe('Accepted')
    expect(r.transactionId).toBeGreaterThan(0)
    expect(await prisma.chargingSession.count({ where: { userId: m.driver.id } })).toBe(1)
  })

  it('tarifa DESATIVADA: responde Blocked com transactionId 0 (NÃO lança), não cria sessão, não mexe na carteira e emite o alerta com os identificadores do conector', async () => {
    const erro = vi.spyOn(logger, 'error')
    const m = await motoristaComSaldo()
    const con = await conectorNovo()
    await prisma.tariff.update({ where: { id: c.tenant.tariffId }, data: { active: false } })
    try {
      const r = await start(con.connectorId, m.token.idTag)
      expect(r).toEqual({ transactionId: 0, idTagInfo: { status: 'Blocked' } })
    } finally {
      await prisma.tariff.update({ where: { id: c.tenant.tariffId }, data: { active: true } })
    }
    expect(await prisma.chargingSession.count({ where: { userId: m.driver.id } })).toBe(0)
    expect(await prisma.walletEntry.count({ where: { walletId: m.wallet.id } })).toBe(1) // só o crédito de teste
    const alertas = erro.mock.calls.filter((a) => (a[0] as { alert?: string } | undefined)?.alert === 'ocpp_start_transaction_no_active_tariff')
    expect(alertas).toHaveLength(1)
    expect(alertas[0][0]).toMatchObject({ chargePointId: c.tenant.chargePointId, connectorId: con.connectorId, operatorId: c.tenant.operatorId })
    expect(JSON.stringify(alertas[0])).not.toContain(m.token.idTag) // o idTag (credencial do motorista) não vai no alerta
  })

  it('reativada a tarifa, o MESMO conector volta a aceitar (a recusa não deixou estado preso)', async () => {
    const m = await motoristaComSaldo()
    const con = await conectorNovo()
    await prisma.tariff.update({ where: { id: c.tenant.tariffId }, data: { active: false } })
    try {
      expect((await start(con.connectorId, m.token.idTag)).idTagInfo.status).toBe('Blocked')
    } finally {
      await prisma.tariff.update({ where: { id: c.tenant.tariffId }, data: { active: true } })
    }
    expect((await start(con.connectorId, m.token.idTag)).idTagInfo.status).toBe('Accepted')
  })

  it('outro erro de verdade na resolução da tarifa (banco caiu) CONTINUA propagando — só a falta de tarifa virou recusa limpa', async () => {
    const m = await motoristaComSaldo()
    const con = await conectorNovo()
    vi.spyOn(prisma.tariffAssignment, 'findMany').mockRejectedValueOnce(new Error('banco caiu (simulado)'))
    await expect(start(con.connectorId, m.token.idTag)).rejects.toThrow(/banco caiu/)
    expect(await prisma.chargingSession.count({ where: { userId: m.driver.id } })).toBe(0)
  })

  it('conector inexistente continua sendo erro do protocolo (PropertyConstraintViolation), não recusa de tarifa', async () => {
    const m = await motoristaComSaldo()
    await expect(start(9_999, m.token.idTag)).rejects.toThrow()
  })
})
