import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { IconBadge } from "@/components/ui/IconBadge"
import { cn } from "@/lib/utils"

/**
 * Cabeçalho padrão das telas do painel admin: selo com ícone da área (o mesmo do menu) + título + descrição + ações.
 *
 * Design system unificado: `eyebrow` opcional (rótulo caixa-alta acima do título, `accent-700` no claro). Desde a F-D: h1 peso 800, sem animação de entrada, e é o
 * ÚNICO título da página (o header do shell mostra só a trilha "Painel administrativo / <área>", sem heading).
 */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  eyebrow,
  className,
}: {
  title: string
  description?: ReactNode
  icon?: LucideIcon
  actions?: ReactNode
  eyebrow?: string
  className?: string
}) {
  return (
    <header className={cn("flex items-start gap-3", className)}>
      {Icon && <IconBadge icon={Icon} size="lg" tinted className="hidden sm:flex" />}
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-1 text-accent-700">{eyebrow}</p>}
          <h1 className="text-xl font-extrabold tracking-tight text-ink sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-ink-softer">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
