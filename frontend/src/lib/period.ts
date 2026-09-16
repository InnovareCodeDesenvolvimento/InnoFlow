/**
 * Seletor de período das telas de retaguarda (dashboard/relatórios).
 * Resolve presets em `{from, to}` no formato `YYYY-MM-DD` (sem hora) — quem
 * decide o corte de dia é o backend, no fuso do SITE, nunca em UTC (regra 4
 * da Nova, ver `.claude/agent-memory/nova/decisoes-retaguarda-relatorios.md`).
 * O frontend só manda datas de calendário "cruas".
 */

export type PeriodPreset = "today" | "7d" | "30d" | "month" | "custom"

export interface PeriodValue {
  preset: PeriodPreset
  from: string
  to: string
}

export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  today: "Hoje",
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
  month: "Este mês",
  custom: "Personalizado",
}

export const PERIOD_PRESETS: PeriodPreset[] = ["today", "7d", "30d", "month", "custom"]

function toISODate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function daysAgo(days: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d
}

function startOfMonth(): Date {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function resolvePeriod(preset: PeriodPreset, custom?: { from: string; to: string }): PeriodValue {
  const today = new Date()
  switch (preset) {
    case "today":
      return { preset, from: toISODate(today), to: toISODate(today) }
    case "7d":
      return { preset, from: toISODate(daysAgo(6)), to: toISODate(today) }
    case "30d":
      return { preset, from: toISODate(daysAgo(29)), to: toISODate(today) }
    case "month":
      return { preset, from: toISODate(startOfMonth()), to: toISODate(today) }
    case "custom":
      return { preset, from: custom?.from ?? toISODate(today), to: custom?.to ?? toISODate(today) }
  }
}

/** Período imediatamente anterior, de mesmo tamanho — só para exibição (o backend calcula o dele independentemente). */
export function previousPeriodLabel(from: string, to: string): string {
  const fromDate = new Date(`${from}T00:00:00`)
  const toDate = new Date(`${to}T00:00:00`)
  const days = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1)
  const prevTo = new Date(fromDate)
  prevTo.setDate(prevTo.getDate() - 1)
  const prevFrom = new Date(prevTo)
  prevFrom.setDate(prevFrom.getDate() - (days - 1))
  return `${toISODate(prevFrom)} a ${toISODate(prevTo)}`
}
