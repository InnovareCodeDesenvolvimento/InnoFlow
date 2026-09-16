import { AppError } from '../middleware/errorHandler'

/**
 * Resolução da janela de tempo dos relatórios/dashboard (módulo de
 * retaguarda). Função PURA (sem Prisma/Express) de propósito — testável sem
 * banco, e é exatamente o tipo de lógica onde "os números não batem entre
 * telas" nasce se cada rota reimplementar por conta própria.
 *
 * Regra de ouro (Nova, decisoes-retaguarda-relatorios.md): bucket de dia
 * SEMPRE no fuso do site, nunca em UTC. `startedAt` (nunca `stoppedAt`) é a
 * data que define a que dia/período uma sessão pertence.
 */

export const REPORT_PERIODS = ['today', '7d', '30d', 'month', 'prev_month', 'custom'] as const
export type ReportPeriod = (typeof REPORT_PERIODS)[number]

const MAX_WINDOW_DAYS = 366
const DAY_MS = 24 * 60 * 60 * 1000

export interface PeriodWindowInput {
  period: ReportPeriod
  from?: string // 'YYYY-MM-DD', obrigatório se period=custom
  to?: string // 'YYYY-MM-DD', obrigatório se period=custom (inclusivo)
  tz: string
}

export interface PeriodWindow {
  /** Início do período, instante UTC real (inclusive). */
  from: Date
  /** Fim do período, instante UTC real (EXCLUSIVE — usar `< to`, nunca `<= to`). */
  to: Date
  /** Período anterior, MESMO tamanho, imediatamente antes de `from`. */
  previousFrom: Date
  previousTo: Date
  tz: string
}

/**
 * Converte um instante UTC para os componentes de data/hora "de parede" no
 * fuso `tz`, como se fossem UTC (ex.: 2026-09-16 03:00 UTC em
 * America/Sao_Paulo (UTC-3) vira meia-noite — retorna os componentes de
 * "meia-noite", não o instante). Usa `Intl.DateTimeFormat`, nativo do Node,
 * sem dependência de data externa (luxon/date-fns-tz não estão no projeto).
 */
function wallClockAsUtcMs(instantMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const part of dtf.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const hour = parts.hour === '24' ? 0 : Number(parts.hour)
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second))
}

/**
 * Instante UTC real correspondente à meia-noite (00:00:00) do dia
 * `year-month-day` NO FUSO `tz`. Duas iterações convergem mesmo em fusos com
 * DST (não é o caso de `America/Sao_Paulo`, que não tem DST desde 2019, mas
 * a função aceita qualquer IANA tz vindo de `Site.timezone`).
 */
export function zonedStartOfDayToUtc(year: number, month: number, day: number, tz: string): Date {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0)
  let instant = target
  for (let i = 0; i < 2; i++) {
    const wall = wallClockAsUtcMs(instant, tz)
    instant -= wall - target
  }
  return new Date(instant)
}

function ymdInTz(instant: Date, tz: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts: Record<string, string> = {}
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
}

function addDaysUtcInstant(startOfDay: Date, days: number, tz: string): Date {
  // Anda em passos de dia "de parede" (não só +24h em ms) — correto mesmo
  // que um fuso tenha DST (dias com 23h/25h reais).
  const { year, month, day } = ymdInTz(new Date(startOfDay.getTime() + 12 * 60 * 60 * 1000), tz)
  const base = new Date(Date.UTC(year, month - 1, day))
  base.setUTCDate(base.getUTCDate() + days)
  return zonedStartOfDayToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), tz)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDateStringOrThrow(value: string, field: string): { year: number; month: number; day: number } {
  if (!DATE_RE.test(value)) {
    throw new AppError(`${field} inválido — formato esperado YYYY-MM-DD.`, 400, 'VALIDATION_ERROR', [{ path: field, message: 'formato esperado YYYY-MM-DD' }])
  }
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

export function resolvePeriodWindow(input: PeriodWindowInput, now: Date = new Date()): PeriodWindow {
  const tz = input.tz
  const todayYmd = ymdInTz(now, tz)
  const startOfToday = zonedStartOfDayToUtc(todayYmd.year, todayYmd.month, todayYmd.day, tz)
  const startOfTomorrow = addDaysUtcInstant(startOfToday, 1, tz)

  let from: Date
  let to: Date

  switch (input.period) {
    case 'today':
      from = startOfToday
      to = startOfTomorrow
      break
    case '7d':
      from = addDaysUtcInstant(startOfToday, -6, tz)
      to = startOfTomorrow
      break
    case '30d':
      from = addDaysUtcInstant(startOfToday, -29, tz)
      to = startOfTomorrow
      break
    case 'month': {
      from = zonedStartOfDayToUtc(todayYmd.year, todayYmd.month, 1, tz)
      to = startOfTomorrow // mês corrente até hoje (inclusive), nunca dia futuro
      break
    }
    case 'prev_month': {
      const prevMonthDate = new Date(Date.UTC(todayYmd.year, todayYmd.month - 2, 1))
      from = zonedStartOfDayToUtc(prevMonthDate.getUTCFullYear(), prevMonthDate.getUTCMonth() + 1, 1, tz)
      to = zonedStartOfDayToUtc(todayYmd.year, todayYmd.month, 1, tz) // início do mês corrente = fim exclusivo do mês anterior
      break
    }
    case 'custom': {
      if (!input.from || !input.to) {
        throw new AppError('from e to são obrigatórios quando period=custom.', 400, 'VALIDATION_ERROR', [
          { path: 'from', message: 'obrigatório quando period=custom' },
          { path: 'to', message: 'obrigatório quando period=custom' },
        ])
      }
      const fromYmd = parseDateStringOrThrow(input.from, 'from')
      const toYmd = parseDateStringOrThrow(input.to, 'to')
      from = zonedStartOfDayToUtc(fromYmd.year, fromYmd.month, fromYmd.day, tz)
      // `to` é inclusivo no contrato da API — o fim exclusivo é o dia SEGUINTE.
      const toStart = zonedStartOfDayToUtc(toYmd.year, toYmd.month, toYmd.day, tz)
      to = addDaysUtcInstant(toStart, 1, tz)
      if (to.getTime() <= from.getTime()) {
        throw new AppError('O intervalo "to" precisa ser igual ou posterior a "from".', 400, 'VALIDATION_ERROR', [{ path: 'to', message: 'to < from' }])
      }
      break
    }
  }

  const windowMs = to.getTime() - from.getTime()
  if (windowMs > MAX_WINDOW_DAYS * DAY_MS) {
    throw new AppError(`Janela máxima de ${MAX_WINDOW_DAYS} dias excedida.`, 400, 'VALIDATION_ERROR', [{ path: 'period', message: `janela de ${Math.ceil(windowMs / DAY_MS)} dias excede o máximo de ${MAX_WINDOW_DAYS}` }])
  }

  const previousTo = from
  const previousFrom = new Date(from.getTime() - windowMs)

  return { from, to, previousFrom, previousTo, tz }
}

/** null se o anterior for zero — nunca ∞ (regra explícita do contrato). */
export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null
  return round2Pct(((current - previous) / previous) * 100)
}

function round2Pct(value: number): number {
  return Math.round(value * 100) / 100
}
