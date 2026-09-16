import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** Estado vazio das listagens — sem registro nenhum (não confundir com erro, ver `ErrorState`). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong bg-muted/30 px-6 py-14 text-center", className)}>
      {Icon && (
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-ink-subtle" aria-hidden="true">
          <Icon className="h-6 w-6" />
        </span>
      )}
      <div>
        <p className="font-semibold text-ink">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-ink-softer">{description}</p>}
      </div>
      {action}
    </div>
  )
}
