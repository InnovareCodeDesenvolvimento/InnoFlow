import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
  disabled?: boolean
  title?: string
}

/**
 * Controle segmentado de escolha única (ordenar por, lista/mapa). Semântica de GRUPO DE BOTÕES com `aria-pressed` (não `tablist`: nada aqui troca de
 * painel com setas, e os E2E do mapa consultam `button` pelo nome). Alvo de toque >= 44 px. O item ativo usa o token de foco da superfície
 * (`bg-focus text-on-focus`): petróleo sobre claro, LIMA sobre `.surface-dark` — sem variante nem prop de tom.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = "md",
}: {
  value: T
  onChange: (value: T) => void
  options: ReadonlyArray<SegmentedOption<T>>
  /** Nome acessível do grupo (vira `aria-label`). */
  label: string
  className?: string
  /** `sm` (36 px) para barras de filtro do admin; `md` (44 px, alvo de toque) é o do app do motorista. */
  size?: "md" | "sm"
}) {
  return (
    <div className={cn("flex flex-wrap gap-1 rounded-[var(--field-radius)] border border-border bg-surface p-1", className)} role="group" aria-label={label}>
      {options.map(({ value: v, label: text, icon: Icon, disabled, title }) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          aria-pressed={value === v}
          title={title}
          onClick={() => onChange(v)}
          className={cn(
            size === "sm" ? "min-h-9" : "min-h-11",
            "flex items-center gap-1.5 rounded-[calc(var(--field-radius)-0.25rem)] px-3 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            value === v ? "bg-focus text-on-focus" : "text-ink-softer hover:bg-muted hover:text-ink",
          )}
        >
          {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
          {text}
        </button>
      ))}
    </div>
  )
}
