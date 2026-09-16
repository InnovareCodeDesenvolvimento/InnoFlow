import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/api/middleware/errorHandler'
import { deltaPct, resolveEffectivePeriod, resolvePeriodWindow, zonedStartOfDayToUtc } from '../../src/api/lib/reportingWindow'

const TZ = 'America/Sao_Paulo' // UTC-3, sem DST desde 2019 — fuso alvo do MVP.

describe('lib/reportingWindow — zonedStartOfDayToUtc', () => {
  it('meia-noite em America/Sao_Paulo é 03:00 UTC (UTC-3)', () => {
    const start = zonedStartOfDayToUtc(2026, 9, 16, TZ)
    expect(start.toISOString()).toBe('2026-09-16T03:00:00.000Z')
  })

  it('meia-noite em UTC é o próprio instante', () => {
    const start = zonedStartOfDayToUtc(2026, 9, 16, 'UTC')
    expect(start.toISOString()).toBe('2026-09-16T00:00:00.000Z')
  })
})

describe('lib/reportingWindow — resolvePeriodWindow', () => {
  // "Agora" fixo para os testes: 16/09/2026 14:00 UTC = 11:00 em São Paulo.
  const now = new Date('2026-09-16T14:00:00.000Z')

  it('period=today cobre só o dia corrente no fuso do site, não UTC', () => {
    const window = resolvePeriodWindow({ period: 'today', tz: TZ }, now)
    expect(window.from.toISOString()).toBe('2026-09-16T03:00:00.000Z')
    expect(window.to.toISOString()).toBe('2026-09-17T03:00:00.000Z')
  })

  it('period=7d inclui hoje + 6 dias anteriores (7 dias no total)', () => {
    const window = resolvePeriodWindow({ period: '7d', tz: TZ }, now)
    expect(window.from.toISOString()).toBe('2026-09-10T03:00:00.000Z')
    expect(window.to.toISOString()).toBe('2026-09-17T03:00:00.000Z')
    expect((window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000)).toBe(7)
  })

  it('period anterior tem o MESMO tamanho e termina exatamente onde o atual começa', () => {
    const window = resolvePeriodWindow({ period: '30d', tz: TZ }, now)
    const currentMs = window.to.getTime() - window.from.getTime()
    const previousMs = window.previousTo.getTime() - window.previousFrom.getTime()
    expect(previousMs).toBe(currentMs)
    expect(window.previousTo.getTime()).toBe(window.from.getTime())
  })

  it('period=month vai do dia 1 do mês corrente até hoje (mês incompleto, nunca inclui dia futuro)', () => {
    const window = resolvePeriodWindow({ period: 'month', tz: TZ }, now)
    expect(window.from.toISOString()).toBe('2026-09-01T03:00:00.000Z')
    expect(window.to.toISOString()).toBe('2026-09-17T03:00:00.000Z')
  })

  it('period=prev_month cobre o mês anterior inteiro', () => {
    const window = resolvePeriodWindow({ period: 'prev_month', tz: TZ }, now)
    expect(window.from.toISOString()).toBe('2026-08-01T03:00:00.000Z')
    expect(window.to.toISOString()).toBe('2026-09-01T03:00:00.000Z')
  })

  it('period=custom é inclusivo em "to" (o dia inteiro de "to" entra na janela)', () => {
    const window = resolvePeriodWindow({ period: 'custom', from: '2026-09-01', to: '2026-09-05', tz: TZ }, now)
    expect(window.from.toISOString()).toBe('2026-09-01T03:00:00.000Z')
    expect(window.to.toISOString()).toBe('2026-09-06T03:00:00.000Z')
  })

  it('period=custom sem from/to lança VALIDATION_ERROR', () => {
    expect(() => resolvePeriodWindow({ period: 'custom', tz: TZ }, now)).toThrow(AppError)
    try {
      resolvePeriodWindow({ period: 'custom', tz: TZ }, now)
    } catch (err) {
      expect((err as AppError).code).toBe('VALIDATION_ERROR')
      expect((err as AppError).statusCode).toBe(400)
    }
  })

  it('janela maior que 366 dias lança VALIDATION_ERROR (400)', () => {
    expect(() => resolvePeriodWindow({ period: 'custom', from: '2020-01-01', to: '2026-09-16', tz: TZ }, now)).toThrow(AppError)
  })

  it('custom com to < from lança VALIDATION_ERROR', () => {
    expect(() => resolvePeriodWindow({ period: 'custom', from: '2026-09-10', to: '2026-09-01', tz: TZ }, now)).toThrow(AppError)
  })
})

describe('lib/reportingWindow — deltaPct', () => {
  it('retorna null quando o período anterior é zero (nunca ∞)', () => {
    expect(deltaPct(1000, 0)).toBeNull()
  })

  it('calcula a variação percentual corretamente', () => {
    expect(deltaPct(150, 100)).toBe(50)
    expect(deltaPct(50, 100)).toBe(-50)
  })

  it('zero atual com anterior positivo dá -100%, não null', () => {
    expect(deltaPct(0, 100)).toBe(-100)
  })
})

describe('lib/reportingWindow — resolveEffectivePeriod', () => {
  // O frontend nunca manda `period` — só `from`/`to` já resolvidos (ver
  // `frontend/src/lib/period.ts`). Sem este ajuste, `period` fica no default
  // Zod ('30d') e `from`/`to` explícitos são silenciosamente ignorados.
  it('from e to presentes força custom, mesmo com period default (30d)', () => {
    expect(resolveEffectivePeriod('30d', '2026-09-01', '2026-09-10')).toBe('custom')
  })

  it('sem from/to mantém o period pedido (ex.: preset "today" de uma chamada manual/curl)', () => {
    expect(resolveEffectivePeriod('today', undefined, undefined)).toBe('today')
  })

  it('só from OU só to (nunca os dois) não força custom', () => {
    expect(resolveEffectivePeriod('30d', '2026-09-01', undefined)).toBe('30d')
    expect(resolveEffectivePeriod('30d', undefined, '2026-09-10')).toBe('30d')
  })

  it('period=custom explícito com from/to continua custom (idempotente)', () => {
    expect(resolveEffectivePeriod('custom', '2026-09-01', '2026-09-10')).toBe('custom')
  })
})
