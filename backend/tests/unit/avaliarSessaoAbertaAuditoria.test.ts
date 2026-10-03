import { describe, expect, it } from 'vitest'
import { avaliarSessaoAberta, calcularConfirmDeadline, CONFIG_WATCHDOG_PADRAO, type EntradaAvaliacao } from '../../src/core/sessao/avaliarSessaoAberta'

/**
 * Auditoria F5.9 do Órion — bordas NOVAS da decisão do watchdog (M5: G1 contra o intervalo de amostragem; M7: U1 só com energia nova). A matriz original
 * continua em `avaliarSessaoAberta.test.ts` (intacta). `agora` é injetado.
 */
const AGORA = new Date('2026-10-03T12:00:00.000Z')
const MIN = 60_000
const antes = (ms: number, de: Date = AGORA) => new Date(de.getTime() - ms)

/** STOP_UNCONFIRMED desde `ha` ms, carregador online, WALLET, sem prova de leitura. */
function nc(ha: number, extra: Partial<EntradaAvaliacao> & { sessao?: Partial<EntradaAvaliacao['sessao']> } = {}): EntradaAvaliacao {
  const { sessao, ...resto } = extra
  return {
    agora: AGORA,
    sessao: {
      status: 'STOP_UNCONFIRMED',
      paymentMode: 'WALLET',
      createdAt: antes(60 * MIN),
      lastActivityAt: antes(ha),
      lastMeterValuesAt: null,
      stopRequestedAt: null,
      stopAttempts: 0,
      unconfirmedAt: antes(ha),
      cardAuthorizedAt: null,
      energyAdvancedSinceStopRequest: false,
      ...sessao,
    },
    carregador: { lastSeenAt: antes(5_000), disconnectedAt: null },
    conector: { status: 'CHARGING', statusReceivedAt: antes(50 * MIN) },
    provas: { stopTransactionNoLog: false, ultimaAmostra: true },
    ultimoTriggerMeterValuesEm: null,
    config: { ...CONFIG_WATCHDOG_PADRAO },
    ...resto,
  }
}

describe('M5 — a janela G1 é validada contra o intervalo de amostragem observado', () => {
  it('sem intervalo conhecido vale G1 puro (10 min): em 10 min exatos encerra, 1 ms antes não', () => {
    expect(avaliarSessaoAberta(nc(10 * MIN)).acao).toBe('ENCERRAR_PELO_SERVIDOR')
    expect(avaliarSessaoAberta(nc(10 * MIN - 1)).acao).toBe('NADA')
  })

  it('amostragem a cada 15 min: a janela vira 1,5 x 15 = 22,5 min — em 11 min NÃO encerra (antes encerrava com o carro carregando)', () => {
    const e = (ha: number) => nc(ha, { intervaloAmostragemMs: 15 * MIN })
    expect(avaliarSessaoAberta(e(11 * MIN)).acao).toBe('NADA')
    expect(avaliarSessaoAberta(e(22 * MIN + 30_000 - 1)).acao).toBe('NADA')
    expect(avaliarSessaoAberta(e(22 * MIN + 30_000)).acao).toBe('ENCERRAR_PELO_SERVIDOR')
  })

  it('amostragem rápida (1 min): a janela continua G1 (o intervalo nunca ENCURTA a janela)', () => {
    expect(avaliarSessaoAberta(nc(10 * MIN, { intervaloAmostragemMs: MIN })).acao).toBe('ENCERRAR_PELO_SERVIDOR')
  })

  it('intervalo absurdo (3 h) é limitado a G2 (120 min): a espera nunca passa do que o dono aceitou para carregador sumido', () => {
    const e = (ha: number) => nc(ha, { intervaloAmostragemMs: 180 * MIN })
    expect(avaliarSessaoAberta(e(119 * MIN)).acao).toBe('NADA')
    expect(avaliarSessaoAberta(e(120 * MIN)).acao).toBe('ENCERRAR_PELO_SERVIDOR')
  })

  it('calcularConfirmDeadline é a MESMA conta de U2 (o DTO mostra o instante em que o watchdog age), com e sem intervalo', () => {
    for (const intervaloAmostragemMs of [null, 15 * MIN, 180 * MIN]) {
      const e = nc(0, { intervaloAmostragemMs })
      const prazo = calcularConfirmDeadline({ agora: AGORA, sessao: e.sessao, carregador: e.carregador, config: e.config, intervaloAmostragemMs })
      const noPrazo = (d: Date) => avaliarSessaoAberta({ ...e, agora: d, sessao: { ...e.sessao, unconfirmedAt: e.sessao.unconfirmedAt }, carregador: { lastSeenAt: antes(5_000, d), disconnectedAt: null } }).acao
      // mesmo `unconfirmedAt` (AGORA), `agora` deslocado para o prazo: o instante exato encerra, 1 ms antes não
      expect(noPrazo(new Date(prazo.getTime()))).toBe('ENCERRAR_PELO_SERVIDOR')
      expect(noPrazo(new Date(prazo.getTime() - 1))).toBe('NADA')
    }
  })
})

describe('M7 — U1 só reanima quem entregou energia NOVA', () => {
  const comMeterValues = (energiaAvancou: boolean | null | undefined, extra: Partial<EntradaAvaliacao['sessao']> = {}) =>
    nc(3 * MIN, { sessao: { lastMeterValuesAt: antes(MIN), energiaAvancouDesdeAMarcacao: energiaAvancou, ...extra } })

  it('energia avançou desde a marcação: REANIMA', () => {
    expect(avaliarSessaoAberta(comMeterValues(true)).acao).toBe('REANIMAR')
  })

  it('MeterValues em BUFFER (chegou, mas a energia NÃO passou da marcação): NÃO reanima e NÃO alerta "não obedece"', () => {
    const d = avaliarSessaoAberta(comMeterValues(false))
    expect(d.acao).toBe('NADA')
  })

  it('energia desconhecida (chave perdida) ou campo ausente: comportamento antigo, REANIMA por lastMeterValuesAt', () => {
    expect(avaliarSessaoAberta(comMeterValues(null)).acao).toBe('REANIMAR')
    expect(avaliarSessaoAberta(comMeterValues(undefined)).acao).toBe('REANIMAR')
  })

  it('sem MeterValues depois da marcação nada muda (energia avançada não basta)', () => {
    expect(avaliarSessaoAberta(nc(3 * MIN, { sessao: { lastMeterValuesAt: antes(5 * MIN), energiaAvancouDesdeAMarcacao: true } })).acao).toBe('NADA')
  })

  it('o anti vai-e-vem continua valendo: stopAttempts no teto bloqueia a reanimação mesmo com energia nova (e então alerta session_stop_not_obeyed)', () => {
    const d = avaliarSessaoAberta(comMeterValues(true, { stopAttempts: CONFIG_WATCHDOG_PADRAO.stopMaxAttempts }))
    expect(d).toMatchObject({ acao: 'ALERTAR', tipo: 'session_stop_not_obeyed' })
  })
})
