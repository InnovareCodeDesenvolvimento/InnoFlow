import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { IconBadge } from "@/components/ui/IconBadge"
import { cn } from "@/lib/utils"

/**
 * Cabeçalho padrão das telas do painel admin: selo com ícone da área (o mesmo do menu) + título + descrição + ações.
 *
 * Design system unificado: `eyebrow` opcional (rótulo caixa-alta acima do título, `accent-700` no claro). Os DEFAULTS continuam os de hoje
 * (h1 peso 900, entrada `animate-fade-in-up`) de propósito: trocar para 800 e tirar a animação muda o visual das 14 telas do admin de uma
 * vez, então isso acontece na F-D junto com o shell (`animate={false}` já existe para quem migrar antes). É o ÚNICO título da página:
 * o header do shell vai deixar de repeti-lo.
 */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  eyebrow,
  animate = true,
  className,
}: {
  title: string
  description?: ReactNode
  icon?: LucideIcon
  actions?: ReactNode
  eyebrow?: string
  /** Entrada em fade+subida. No admin a regra nova é sem animação (F-D). */
  animate?: boolean
  className?: string
}) {
  return (
    <header className={cn(animate && "animate-fade-in-up", "flex items-start gap-3", className)}>
      {Icon && <IconBadge icon={Icon} size="lg" tinted className="hidden sm:flex" />}
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-1 text-accent-700">{eyebrow}</p>}
          <h1 className="text-xl font-black tracking-tight text-ink sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-ink-softer">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
