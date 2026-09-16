import type { LucideIcon } from "lucide-react"
import { ArrowDownRight, ArrowUpRight, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Cartão de métrica com variação vs. período anterior. `deltaPct: null`
 * nunca vira "∞" — mostra "novo no período" (valor apareceu do nada) ou
 * "sem variação" (os dois períodos são zero). Ver regra do dashboard.
 */
export function MetricCard({
  label,
  value,
  deltaPct,
  icon: Icon,
  formatValue = (v) => String(v),
  /** Para métricas onde "subir" é ruim (nenhuma das 6 do dashboard hoje, mas deixa pronto). */
  invertDeltaColor = false,
}: {
  label: string
  value: number
  deltaPct: number | null
  icon?: LucideIcon
  formatValue?: (value: number) => string
  invertDeltaColor?: boolean
}) {
  const isNew = deltaPct === null && value !== 0
  const isFlat = deltaPct === null && value === 0
  const isPositive = deltaPct !== null && deltaPct >= 0
  const deltaIsGood = invertDeltaColor ? !isPositive : isPositive

  return (
    <div className="card-elevated p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">{label}</p>
        {Icon && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <p className="mt-2 break-words text-lg font-black leading-tight tracking-tight tabular-nums text-ink sm:text-xl xl:text-2xl">{formatValue(value)}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs font-semibold">
        {isFlat && <span className="text-ink-subtle">— sem variação</span>}
        {isNew && (
          <span className="inline-flex items-center gap-1 text-info-700">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            novo no período
          </span>
        )}
        {deltaPct !== null && (
          <>
            <span className={cn("inline-flex items-center gap-0.5", deltaIsGood ? "text-success-700" : "text-danger-700")}>
              {isPositive ? <ArrowUpRight className="h-3 w-3" aria-hidden="true" /> : <ArrowDownRight className="h-3 w-3" aria-hidden="true" />}
              {Math.abs(deltaPct).toFixed(1)}%
            </span>
            <span className="text-ink-subtle">vs. período anterior</span>
          </>
        )}
      </div>
    </div>
  )
}
