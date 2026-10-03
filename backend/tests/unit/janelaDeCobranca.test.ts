import { describe, expect, it } from 'vitest'
import { normalizarJanelaDeCobranca } from '../../src/core/tarifacao/janelaDeCobranca'
import { calcularCustoSessao, type TariffSnapshot } from '../../src/core/tarifacao/calcularCustoSessao'
import { escolherLeituraFinal } from '../../src/core/sessao/leituraFinal'

/** ALTO-1 (Órion): a janela de cobrança é normalizada ANTES da conta, e o instante final da leitura é max(prova, chargingEndedAt, startedAt). */
const t = (min: number) => new Date(Date.UTC(2026, 9, 3, 10, min))
const TARIFA: TariffSnapshot = { id: 'x', model: 'PER_KWH', pricePerKwh: '1.00', pricePerMinute: null, sessionFeeCents: null, minChargeCents: null, idleFeePerMinute: 0, idleGracePeriodSeconds: 0, windows: [] }

describe('normalizarJanelaDeCobranca', () => {
  it('janela em ordem: devolve igual e ajustada=false', () => {
    const j = normalizarJanelaDeCobranca({ startedAt: t(0), chargingEndedAt: t(5), stoppedAt: t(10) })
    expect(j).toMatchObject({ ajustada: false })
    expect(j.chargingEndedAt).toEqual(t(5))
    expect(j.stoppedAt).toEqual(t(10))
  })
  it('stoppedAt antes de startedAt (RTC resetado): sobe para startedAt', () => {
    const j = normalizarJanelaDeCobranca({ startedAt: t(30), chargingEndedAt: null, stoppedAt: t(0) })
    expect(j.stoppedAt).toEqual(t(30))
    expect(j.ajustada).toBe(true)
  })
  it('chargingEndedAt depois de stoppedAt: limitado a stoppedAt; antes de startedAt: sobe para startedAt', () => {
    expect(normalizarJanelaDeCobranca({ startedAt: t(0), chargingEndedAt: t(20), stoppedAt: t(10) }).chargingEndedAt).toEqual(t(10))
    expect(normalizarJanelaDeCobranca({ startedAt: t(5), chargingEndedAt: t(1), stoppedAt: t(10) }).chargingEndedAt).toEqual(t(5))
  })
  it('as DUAS anomalias juntas: o resultado satisfaz o contrato de calcularCustoSessao (não lança)', () => {
    const j = normalizarJanelaDeCobranca({ startedAt: t(30), chargingEndedAt: t(50), stoppedAt: t(0) })
    expect(() => calcularCustoSessao(TARIFA, { energyDeliveredWh: 2_000, startedAt: j.startedAt, chargingEndedAt: j.chargingEndedAt, stoppedAt: j.stoppedAt, timezone: 'America/Sao_Paulo' })).not.toThrow()
  })
  it('a entrada crua REALMENTE lança em calcularCustoSessao (o que o ALTO-1 descreve)', () => {
    expect(() => calcularCustoSessao(TARIFA, { energyDeliveredWh: 2_000, startedAt: t(0), chargingEndedAt: t(10), stoppedAt: t(2), timezone: 'America/Sao_Paulo' })).toThrow()
  })
})

describe('escolherLeituraFinal — instante final = max(prova, chargingEndedAt, startedAt)', () => {
  const base = { meterStartWh: 0, startedAt: t(0), stopNoLog: null }
  it('amostra ANTES de chargingEndedAt: usa chargingEndedAt', () => {
    expect(escolherLeituraFinal({ ...base, ultimaAmostra: { meterWh: 1_000, timestamp: t(2) }, chargingEndedAt: t(10) }).timestamp).toEqual(t(10))
  })
  it('Stop do log com timestamp ANTES do início: usa startedAt', () => {
    expect(escolherLeituraFinal({ meterStartWh: 0, startedAt: t(30), stopNoLog: { meterStopWh: 5, timestamp: t(0), reason: null }, ultimaAmostra: null }).timestamp).toEqual(t(30))
  })
  it('sem anomalia o instante da prova é mantido; NO_READING com chargingEndedAt usa chargingEndedAt', () => {
    expect(escolherLeituraFinal({ ...base, ultimaAmostra: { meterWh: 1, timestamp: t(7) }, chargingEndedAt: t(3) }).timestamp).toEqual(t(7))
    expect(escolherLeituraFinal({ ...base, ultimaAmostra: null, chargingEndedAt: t(4) })).toMatchObject({ prova: 'NO_READING', timestamp: t(4) })
  })
})
