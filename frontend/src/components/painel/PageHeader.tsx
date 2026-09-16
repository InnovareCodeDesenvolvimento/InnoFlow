import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** Cabeçalho padrão das telas do painel admin: selo com ícone da área (o mesmo do menu) + título + descrição + ações. */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  className,
}: {
  title: string
  description?: ReactNode
  icon?: LucideIcon
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={cn("flex items-start gap-3", className)}>
      {Icon && (
        <span
          className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary sm:flex"
          aria-hidden="true"
        >
          <Icon className="h-5 w-5" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tight text-ink sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-ink-softer">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
