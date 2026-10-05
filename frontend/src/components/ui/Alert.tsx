import type { ComponentPropsWithRef } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Aviso em linha (não é toast nem estado de tela): caixa tingida com ícone opcional e texto. Substitui as caixas `rounded-xl border border-*-600/40 bg-*-50`
 * que cada tela montava à mão (ChargePoints, Carteiras, Gateway…).
 *
 *  - `tone`  `info` (informa), `warning` (atenção, nada quebrou), `danger` (quebrou ou é irreversível), `success`, `neutral` (aviso sem cor de estado, sobre fundo da página) e `muted` (nota discreta dentro de um card).
 *  - `size`  `md` = aviso de bloco da tela (raio 12, padding 16, borda); `sm` = nota curta dentro de um card ou diálogo (raio 8, sem borda, 12 px).
 *
 * A semântica é de quem usa: passe `role="alert"` (urgente, anunciado na hora) ou `role="status"` (informativo). Sem `role` é só texto estilizado.
 * Cores de texto = `*-700` sobre `*-50` (contraste AA medido nas telas do Admin).
 */
const TONE = {
  info: { box: "bg-info-50 text-info-700", border: "border-info-600/30" },
  warning: { box: "bg-warning-50 text-warning-700", border: "border-warning-600/40" },
  danger: { box: "bg-danger-50 text-danger-700", border: "border-danger-600/40" },
  success: { box: "bg-success-50 text-success-700", border: "border-success-600/30" },
  neutral: { box: "bg-surface text-ink-soft", border: "border-border" },
  muted: { box: "bg-muted text-ink-softer", border: "border-border-subtle" },
} as const

const SIZE = {
  md: { box: "rounded-xl border p-4 text-sm", icon: "h-5 w-5" },
  sm: { box: "rounded-lg px-3 py-2 text-xs", icon: "h-3.5 w-3.5" },
} as const

export function Alert({
  tone = "info",
  size = "md",
  icon: Icon,
  iconClassName,
  className,
  children,
  ...props
}: ComponentPropsWithRef<"div"> & {
  tone?: keyof typeof TONE
  size?: keyof typeof SIZE
  icon?: LucideIcon
  /** Só para o ícone de um aviso `neutral` (que não tem cor de estado). */
  iconClassName?: string
}) {
  return (
    <div className={cn("flex items-start", size === "md" ? "gap-3" : "gap-2", TONE[tone].box, SIZE[size].box, size === "md" && TONE[tone].border, className)} {...props}>
      {Icon && <Icon className={cn("mt-0.5 shrink-0", SIZE[size].icon, iconClassName)} aria-hidden="true" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
