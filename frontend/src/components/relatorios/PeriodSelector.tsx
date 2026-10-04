import { PERIOD_PRESET_LABELS, PERIOD_PRESETS, type PeriodPreset } from "@/lib/period"
import { cn } from "@/lib/utils"

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
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1" role="group" aria-label="Período">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPresetChange(p)}
            aria-pressed={preset === p}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-bold transition-colors",
              preset === p ? "bg-primary text-primary-foreground" : "text-ink-softer hover:bg-muted hover:text-ink",
            )}
          >
            {PERIOD_PRESET_LABELS[p]}
          </button>
        ))}
      </div>

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
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
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
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
          />
        </div>
      )}
    </div>
  )
}
