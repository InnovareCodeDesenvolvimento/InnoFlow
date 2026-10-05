import { PERIOD_PRESET_LABELS, PERIOD_PRESETS, type PeriodPreset } from "@/lib/period"
import { Segmented } from "@/components/ui/Segmented"

/**
 * Seletor de período (hoje/7d/30d/mês/personalizado) — usado em todas as
 * telas de retaguarda. Controlado: quem chama guarda `preset`/`from`/`to`
 * (normalmente via `resolvePeriod`, ver `lib/period.ts`).
 */
export function PeriodSelector({
  preset,
  from,
  to,
  onPresetChange,
  onCustomChange,
}: {
  preset: PeriodPreset
  from: string
  to: string
  onPresetChange: (preset: PeriodPreset) => void
  onCustomChange: (range: { from: string; to: string }) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented size="sm" label="Período" value={preset} onChange={onPresetChange} options={PERIOD_PRESETS.map((p) => ({ value: p, label: PERIOD_PRESET_LABELS[p] }))} />

      {preset === "custom" && (
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="period-from">
            De
          </label>
          <input
            id="period-from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => onCustomChange({ from: e.target.value, to })}
            className="rounded-[var(--field-radius)] border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-focus/40 focus:border-focus"
          />
          <span className="text-xs text-ink-softer">até</span>
          <label className="sr-only" htmlFor="period-to">
            Até
          </label>
          <input
            id="period-to"
            type="date"
            value={to}
            min={from}
            onChange={(e) => onCustomChange({ from, to: e.target.value })}
            className="rounded-[var(--field-radius)] border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-focus/40 focus:border-focus"
          />
        </div>
      )}
    </div>
  )
}
