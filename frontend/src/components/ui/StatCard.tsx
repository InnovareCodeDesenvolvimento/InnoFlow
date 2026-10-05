import type { LucideIcon } from "lucide-react"
import { ArrowDownRight, ArrowUpRight, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card } from "./Card"
import { IconBadge } from "./IconBadge"

/**
 * Cartão de métrica com variação vs. período anterior. `deltaPct: null`
 * nunca vira "∞" — mostra "novo no período" (valor apareceu do nada) ou
 * "sem variação" (os dois períodos são zero). Ver regra do dashboard.
 *
 * `variant="hero"` = KPI-herói: `Card inverse` com o valor em BRANCO 800 (nunca gradiente de texto sobre escuro — contraste incerto em
 * valor financeiro). No máximo UM por tela. Sem `useCountUp`: numa captura no meio da contagem o número financeiro apareceria errado.
 * Sem animação de entrada (F-D): o admin não faz espetáculo com número financeiro.
 */
export function StatCard({
  label,
  value,
  deltaPct,
  icon: Icon,
  formatValue = (v) => String(v),
  /** Para métricas onde "subir" é ruim (nenhuma das 6 do dashboard hoje, mas deixa pronto). */
  invertDeltaColor = false,
  variant = "default",
}: {
  label: string
  value: number
  deltaPct: number | null
  icon?: LucideIcon
  formatValue?: (value: number) => string
  invertDeltaColor?: boolean
  variant?: "default" | "hero"
}) {
  const isNew = deltaPct === null && value !== 0
  const isFlat = deltaPct === null && value === 0
  const isPositive = deltaPct !== null && deltaPct >= 0
  const deltaIsGood = invertDeltaColor ? !isPositive : isPositive
  const hero = variant === "hero"

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">{label}</p>
        {Icon && <IconBadge icon={Icon} size="sm" tone={hero ? "onDark" : "primary"} />}
      </div>
      <p
        className={cn(
          "mt-2 break-words text-lg leading-tight tracking-tight tabular-nums sm:text-xl xl:text-2xl",
          hero ? "font-extrabold text-white" : "font-black text-ink",
        )}
      >
        {formatValue(value)}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs font-semibold">
        {isFlat && <span className="text-ink-softer">— sem variação</span>}
        {isNew && (
          <span className={cn("inline-flex items-center gap-1", hero ? "text-lime" : "text-info-700")}>
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            novo no período
          </span>
        )}
        {deltaPct !== null && (
          <>
            <span className={cn("inline-flex items-center gap-0.5", hero ? (deltaIsGood ? "text-lime" : "text-danger-100") : deltaIsGood ? "text-success-700" : "text-danger-700")}>
              {isPositive ? <ArrowUpRight className="h-3 w-3" aria-hidden="true" /> : <ArrowDownRight className="h-3 w-3" aria-hidden="true" />}
              {Math.abs(deltaPct).toFixed(1)}%
            </span>
            <span className="text-ink-softer">vs. período anterior</span>
          </>
        )}
      </div>
    </>
  )

  return <Card variant={hero ? "inverse" : "surface"} className="p-5">{body}</Card>
}
