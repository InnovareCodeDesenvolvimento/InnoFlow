import { describe, expect, it } from 'vitest'
import {
  CHARGE_POINT_ONLINE_THRESHOLD_MS,
  OCPP_HEARTBEAT_INTERVAL_SECONDS,
  isChargePointOnline,
  isConnectorFree,
  resumirConectores,
} from '../../src/core/estacoes/disponibilidade'

const NOW = new Date('2026-09-19T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

describe('isChargePointOnline', () => {
  it('nunca visto (lastSeenAt null) -> offline', () => {
    expect(isChargePointOnline({ lastSeenAt: null }, NOW)).toBe(false)
  })

  it('visto há menos que o limiar -> online', () => {
    expect(isChargePointOnline({ lastSeenAt: ago(CHARGE_POINT_ONLINE_THRESHOLD_MS - 1) }, NOW)).toBe(true)
    expect(isChargePointOnline({ lastSeenAt: ago(1_000) }, NOW)).toBe(true)
  })

  it('exatamente no limiar (ou além) -> offline (mesma fronteira `>` do SQL do dashboard: lastSeenAt > agora - limiar)', () => {
    expect(isChargePointOnline({ lastSeenAt: ago(CHARGE_POINT_ONLINE_THRESHOLD_MS) }, NOW)).toBe(false)
    expect(isChargePointOnline({ lastSeenAt: ago(CHARGE_POINT_ONLINE_THRESHOLD_MS + 60_000) }, NOW)).toBe(false)
  })

  it('caiu DEPOIS da última mensagem -> offline NA HORA, mesmo dentro do limiar (o bug de "verde depois que cai")', () => {
    const lastSeenAt = ago(10_000)
    expect(isChargePointOnline({ lastSeenAt, disconnectedAt: ago(5_000) }, NOW)).toBe(false)
  })

  it('caiu no MESMO instante da última mensagem -> offline (empate favorece "caiu")', () => {
    const t = ago(10_000)
    expect(isChargePointOnline({ lastSeenAt: t, disconnectedAt: t }, NOW)).toBe(false)
  })

  it('voltou: mensagem/conexão POSTERIOR à queda -> online de novo, sem ninguém limpar disconnectedAt', () => {
    expect(isChargePointOnline({ lastSeenAt: ago(2_000), disconnectedAt: ago(20_000) }, NOW)).toBe(true)
  })

  it('queda antiga com lastSeenAt velho continua offline pelo limiar (queda do gateway sem `close` também é coberta)', () => {
    expect(isChargePointOnline({ lastSeenAt: ago(CHARGE_POINT_ONLINE_THRESHOLD_MS + 1), disconnectedAt: ago(CHARGE_POINT_ONLINE_THRESHOLD_MS * 2) }, NOW)).toBe(false)
  })
})

describe('heartbeat x limiar (anti-"pisca offline")', () => {
  it('o limiar comporta pelo menos 3 heartbeats — um heartbeat perdido não derruba um carregador saudável', () => {
    // Com 300s/300s (valor antigo) a razão era 1: o próximo heartbeat chegava exatamente quando o limiar vencia.
    expect(CHARGE_POINT_ONLINE_THRESHOLD_MS / (OCPP_HEARTBEAT_INTERVAL_SECONDS * 1000)).toBeGreaterThanOrEqual(3)
  })
})

describe('isConnectorFree', () => {
  it('online + AVAILABLE -> livre', () => {
    expect(isConnectorFree(true, 'AVAILABLE')).toBe(true)
  })

  it('OFFLINE nunca é livre, mesmo com o último status persistido AVAILABLE (o bug do GET /api/sites)', () => {
    expect(isConnectorFree(false, 'AVAILABLE')).toBe(false)
  })

  it.each(['PREPARING', 'CHARGING', 'SUSPENDED_EVSE', 'SUSPENDED_EV', 'FINISHING', 'RESERVED', 'UNAVAILABLE', 'FAULTED'])('online mas %s -> não livre', (status) => {
    expect(isConnectorFree(true, status)).toBe(false)
  })
})

describe('resumirConectores', () => {
  it('lista vazia -> zeros e nenhum grupo', () => {
    expect(resumirConectores([])).toEqual({ total: 0, free: 0, groups: [] })
  })

  it('agrupa por (tipo, potência) somando total e livres', () => {
    const resumo = resumirConectores([
      { type: 'DC_CCS2', maxPowerKw: 60, free: true },
      { type: 'DC_CCS2', maxPowerKw: 60, free: false },
      { type: 'DC_CCS2', maxPowerKw: 120, free: true },
      { type: 'AC_TYPE2', maxPowerKw: 22, free: false },
    ])

    expect(resumo.total).toBe(4)
    expect(resumo.free).toBe(2)
    expect(resumo.groups).toEqual([
      { type: 'AC_TYPE2', maxPowerKw: 22, total: 1, free: 0 },
      { type: 'DC_CCS2', maxPowerKw: 120, total: 1, free: 1 },
      { type: 'DC_CCS2', maxPowerKw: 60, total: 2, free: 1 },
    ])
  })

  it('mesmo tipo com potências diferentes NÃO se mistura; potência desconhecida (null) é um grupo próprio e fica por último', () => {
    const resumo = resumirConectores([
      { type: 'DC_CCS2', maxPowerKw: null, free: true },
      { type: 'DC_CCS2', maxPowerKw: 50, free: true },
      { type: 'DC_CCS2', maxPowerKw: null, free: false },
    ])

    expect(resumo.groups).toEqual([
      { type: 'DC_CCS2', maxPowerKw: 50, total: 1, free: 1 },
      { type: 'DC_CCS2', maxPowerKw: null, total: 2, free: 1 },
    ])
  })

  it('invariante: soma dos grupos == total e soma dos livres == free (o número da lista não pode divergir do do mapa)', () => {
    const resumo = resumirConectores([
      { type: 'DC_CCS2', maxPowerKw: 60, free: true },
      { type: 'DC_CHADEMO', maxPowerKw: 50, free: false },
      { type: 'AC_TYPE2', maxPowerKw: 22, free: true },
      { type: 'AC_TYPE2', maxPowerKw: 22, free: true },
    ])
    expect(resumo.groups.reduce((s, g) => s + g.total, 0)).toBe(resumo.total)
    expect(resumo.groups.reduce((s, g) => s + g.free, 0)).toBe(resumo.free)
  })

  it('a ordem de entrada não muda a saída (resposta estável entre requisições)', () => {
    const a = [
      { type: 'AC_TYPE2', maxPowerKw: 22, free: true },
      { type: 'DC_CCS2', maxPowerKw: 60, free: false },
    ]
    expect(resumirConectores(a)).toEqual(resumirConectores([...a].reverse()))
  })
})
