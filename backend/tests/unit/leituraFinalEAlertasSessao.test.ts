import { describe, expect, it } from 'vitest'
import { deveZerarCusto, escolherLeituraFinal } from '../../src/core/sessao/leituraFinal'
import { severidadeDoAlerta } from '../../src/core/sessao/severidadeAlertas'
import { fotoAindaVale, type FotoDaSessao } from '../../src/services/sessao/travarSessao'
import type { TipoAlertaSessao } from '../../src/core/sessao/avaliarSessaoAberta'

/**
 * F5.9b1 — peças PURAS do encerramento pelo servidor: a escolha da leitura final (ordem de prova do desenho), a política D2, a
 * severidade dos alertas e o compare-and-swap da foto do watchdog. Sem banco, sem Redis.
 */

const inicio = new Date('2026-10-03T10:00:00.000Z')
const tsStop = new Date('2026-10-03T10:20:00.000Z')
const tsAmostra = new Date('2026-10-03T10:15:00.000Z')

describe('escolherLeituraFinal — ordem de prova: Stop do log > última amostra > nenhuma leitura', () => {
  const stopNoLog = { meterStopWh: 9_000, timestamp: tsStop, reason: 'PowerLoss' }
  const ultimaAmostra = { meterWh: 7_000.4, timestamp: tsAmostra }

  it('com o Stop no log E uma amostra, o Stop vence (o carregador DISSE a leitura), com o horário do payload', () => {
    expect(escolherLeituraFinal({ stopNoLog, ultimaAmostra, meterStartWh: 1_000, startedAt: inicio })).toEqual({
      prova: 'STOP_TRANSACTION',
      meterStopWh: 9_000,
      timestamp: tsStop,
      reason: 'PowerLoss',
    })
  })

  it('só com amostra: LAST_METER_SAMPLE, leitura arredondada para Wh inteiro e horário da amostra', () => {
    expect(escolherLeituraFinal({ stopNoLog: null, ultimaAmostra, meterStartWh: 1_000, startedAt: inicio })).toEqual({
      prova: 'LAST_METER_SAMPLE',
      meterStopWh: 7_000,
      timestamp: tsAmostra,
      reason: null,
    })
  })

  it('sem nenhuma prova: NO_READING com energia entregue 0 (meterStop = meterStart) e horário = startedAt — NUNCA estima energia', () => {
    expect(escolherLeituraFinal({ stopNoLog: null, ultimaAmostra: null, meterStartWh: 1_234, startedAt: inicio })).toEqual({
      prova: 'NO_READING',
      meterStopWh: 1_234,
      timestamp: inicio,
      reason: null,
    })
  })
})

describe('deveZerarCusto — política D2 só vale para NO_READING', () => {
  it.each([
    ['NO_READING', 'NO_CHARGE', true],
    ['NO_READING', 'MIN_FEE', false],
    ['LAST_METER_SAMPLE', 'NO_CHARGE', false],
    ['LAST_METER_SAMPLE', 'MIN_FEE', false],
    ['STOP_TRANSACTION', 'NO_CHARGE', false],
    ['STOP_TRANSACTION', 'MIN_FEE', false],
  ] as const)('prova %s + política %s => zerar custo = %s', (prova, politica, esperado) => {
    expect(deveZerarCusto(prova, politica)).toBe(esperado)
  })
})

describe('severidadeDoAlerta — aviso / erro / info conforme o desenho (§4)', () => {
  it.each<[TipoAlertaSessao, string]>([
    ['session_stop_unconfirmed', 'warn'],
    ['session_closed_by_server', 'warn'],
    ['session_max_duration_reached', 'warn'],
    ['session_no_meter_values', 'warn'],
    ['session_closed_without_meter_reading', 'error'],
    ['session_revived_after_unconfirmed', 'error'],
    ['session_stop_not_obeyed', 'error'],
    ['session_metering_after_close', 'error'],
    ['card_session_hold_deadline', 'error'],
  ])('%s => %s', (tipo, severidade) => {
    expect(severidadeDoAlerta(tipo)).toBe(severidade)
  })

  it('session_late_stop_transaction: ERRO se a diferença não cobrada > 0, INFO se 0 (ou sem informar)', () => {
    expect(severidadeDoAlerta('session_late_stop_transaction', { diferencaCents: 1 })).toBe('error')
    expect(severidadeDoAlerta('session_late_stop_transaction', { diferencaCents: 0 })).toBe('info')
    expect(severidadeDoAlerta('session_late_stop_transaction')).toBe('info')
  })
})

describe('fotoAindaVale — qualquer campo que a decisão leu e mudou invalida a decisão', () => {
  const t = new Date('2026-10-03T11:00:00.000Z')
  const base: FotoDaSessao = { status: 'STOP_UNCONFIRMED', lastActivityAt: t, lastMeterValuesAt: null, stopRequestedAt: t, stopAttempts: 1, unconfirmedAt: t }

  it('foto idêntica (datas iguais por valor, não por referência) vale', () => {
    expect(fotoAindaVale({ ...base, lastActivityAt: new Date(t.getTime()) }, base)).toBe(true)
  })

  it.each<[string, Partial<FotoDaSessao>]>([
    ['status', { status: 'STOPPED' }],
    ['lastActivityAt (atividade nova)', { lastActivityAt: new Date(t.getTime() + 1) }],
    ['lastActivityAt virou nulo', { lastActivityAt: null }],
    ['lastMeterValuesAt (MeterValues novo)', { lastMeterValuesAt: new Date(t.getTime() + 1) }],
    ['stopRequestedAt (novo pedido de parada)', { stopRequestedAt: new Date(t.getTime() + 1) }],
    ['stopAttempts', { stopAttempts: 2 }],
    ['unconfirmedAt (reanimou e marcou de novo)', { unconfirmedAt: new Date(t.getTime() + 1) }],
  ])('mudou %s => a foto não vale mais', (_nome, mudanca) => {
    expect(fotoAindaVale({ ...base, ...mudanca }, base)).toBe(false)
  })
})
