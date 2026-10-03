import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRPCError } from 'ocpp-rpc'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { withIdempotency, jsonCanonico, isErroDeterministico, JANELA_REPLAY_MS } from '../../src/ocpp/idempotency'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { chamarHandler, criarCenario, criarSessao, debitosDaSessao, minutosAtras, type Cenario } from './helpers/sessaoTravadaFixture'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * Órion, ALTO-3 — o replay de idempotência procurava a resposta OUTBOUND só por (chargePointId, ocppMessageId): sem `action`, janela nem payload. Firmware
 * com `messageId` por contador que zera no reboot reaproveita ids, e o Stop enfileirado era "respondido" com a resposta de OUTRA mensagem — `run()` nunca
 * executava e o carregador achava que fora confirmado. Além disso toda exceção virava CALL_ERROR cacheado para sempre.
 */
describe('ALTO-3 — idempotência só repete a MESMA mensagem (Postgres + Redis reais)', () => {
  const suffix = uniqueSuffix()
  let cen: Cenario

  beforeAll(async () => {
    cen = await criarCenario(suffix, 'alto3')
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const base = () => ({ chargePointId: cen.tenant.chargePointId, operatorId: cen.tenant.operatorId })
  /** Executa `withIdempotency` contando quantas vezes o `run()` de verdade rodou. */
  function chamada(messageId: string, action: string, payload: Record<string, unknown>) {
    const rodou = { n: 0 }
    const promessa = withIdempotency({ ...base(), ocppMessageId: messageId, action, rawPayload: payload, run: async () => ({ vez: ++rodou.n, action }) })
    return { rodou, promessa }
  }

  it('MESMA mensagem repetida (mesmo messageId, action e payload): replay — run() roda uma vez só e a resposta é a primeira', async () => {
    const id = randomUUID()
    const a = await chamada(id, 'StatusNotification', { connectorId: 1, status: 'Charging' }).promessa
    const b = chamada(id, 'StatusNotification', { connectorId: 1, status: 'Charging' })
    expect(await b.promessa).toEqual(a)
    expect(b.rodou.n).toBe(0)
  })

  it('o payload voltando do JSONB com OUTRA ordem de chaves continua sendo a mesma mensagem (comparação canônica)', async () => {
    const id = randomUUID()
    await chamada(id, 'StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' }).promessa
    const b = chamada(id, 'StatusNotification', { errorCode: 'NoError', status: 'Charging', connectorId: 1 })
    await b.promessa
    expect(b.rodou.n).toBe(0)
  })

  it('messageId reaproveitado com OUTRA action: é mensagem nova — executa', async () => {
    const id = randomUUID()
    await chamada(id, 'Heartbeat', {}).promessa
    const b = chamada(id, 'StatusNotification', { connectorId: 1, status: 'Available' })
    expect(await b.promessa).toEqual({ vez: 1, action: 'StatusNotification' })
    expect(b.rodou.n).toBe(1)
  })

  it('messageId reaproveitado com payload DIFERENTE (contador do firmware que zerou): executa e devolve a resposta DELA, não a antiga', async () => {
    const id = randomUUID()
    await chamada(id, 'StopTransaction', { transactionId: 1, meterStop: 100 }).promessa
    const b = chamada(id, 'StopTransaction', { transactionId: 2, meterStop: 5_000 })
    expect(await b.promessa).toEqual({ vez: 1, action: 'StopTransaction' })
    expect(b.rodou.n).toBe(1)
  })

  it('messageId reaproveitado DEPOIS da janela de 24 h: é mensagem nova mesmo com payload idêntico', async () => {
    const id = randomUUID()
    await chamada(id, 'Heartbeat', {}).promessa
    const antigo = new Date(Date.now() - JANELA_REPLAY_MS - 3_600_000)
    await prisma.ocppMessage.updateMany({ where: { chargePointId: cen.tenant.chargePointId, ocppMessageId: id }, data: { receivedAt: antigo } })
    const b = chamada(id, 'Heartbeat', {})
    await b.promessa
    expect(b.rodou.n).toBe(1)
  })

  it('exceção TRANSITÓRIA (banco, bug, deploy) NÃO é cacheada: o reenvio do mesmo messageId executa de novo e funciona', async () => {
    const id = randomUUID()
    let tentativa = 0
    const exec = () => withIdempotency({ ...base(), ocppMessageId: id, action: 'StopTransaction', rawPayload: { transactionId: 9 }, run: async () => { if (++tentativa === 1) throw new Error('connection refused'); return { ok: true } } })
    await expect(exec()).rejects.toThrow('connection refused')
    expect(await prisma.ocppMessage.count({ where: { chargePointId: cen.tenant.chargePointId, ocppMessageId: id, direction: 'OUTBOUND' } })).toBe(0)
    expect(await exec()).toEqual({ ok: true })
    expect(tentativa).toBe(2)
  })

  it('erro de PROTOCOLO (FormationViolation) é determinístico: cacheado e repetido sem reexecutar; GenericError/InternalError não', async () => {
    const id = randomUUID()
    let rodou = 0
    const exec = () => withIdempotency({ ...base(), ocppMessageId: id, action: 'StartTransaction', rawPayload: { connectorId: 99 }, run: async () => { rodou++; throw createRPCError('PropertyConstraintViolation', 'Conector 99 não cadastrado') } })
    await expect(exec()).rejects.toThrow('Conector 99')
    await expect(exec()).rejects.toMatchObject({ message: 'Conector 99 não cadastrado', rpcErrorCode: 'PropertyConstraintViolation' })
    expect(rodou).toBe(1)

    expect(isErroDeterministico(createRPCError('GenericError', 'x'))).toBe(false)
    expect(isErroDeterministico(createRPCError('InternalError', 'x'))).toBe(false)
    expect(isErroDeterministico(new Error('x'))).toBe(false)
    expect(isErroDeterministico(createRPCError('FormationViolation', 'x'))).toBe(true)
  })

  it('CENÁRIO REAL do D-A: o Stop enfileirado de OUTRA sessão chega com um messageId já usado (contador zerado no reboot) e FECHA a sessão, em vez de ser engolido', async () => {
    const velha = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [1_000] })
    const nova = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [1_000] })
    const reaproveitado = '7'
    const r1 = await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: velha.session.ocppTransactionId, meterStop: 2_000, timestamp: minutosAtras(10).toISOString() }, reaproveitado)
    expect(r1.idTagInfo.status).toBe('Accepted')
    const r2 = await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: nova.session.ocppTransactionId, meterStop: 4_000, timestamp: minutosAtras(1).toISOString() }, reaproveitado)
    expect(r2.idTagInfo.status).toBe('Accepted')

    const fechada = await prisma.chargingSession.findUniqueOrThrow({ where: { id: nova.session.id } })
    expect(fechada).toMatchObject({ status: 'STOPPED', closureSource: 'CHARGER', meterStopWh: 4_000, totalCostCents: 400 }) // antes: continuava aberta
    expect(await debitosDaSessao(nova.session.id)).toHaveLength(1)
  })

  it('jsonCanonico: ordem de chaves não importa, valores sim', () => {
    expect(jsonCanonico({ a: 1, b: [1, { y: 2, x: 1 }] })).toBe(jsonCanonico({ b: [1, { x: 1, y: 2 }], a: 1 }))
    expect(jsonCanonico({ a: 1 })).not.toBe(jsonCanonico({ a: 2 }))
  })
})
