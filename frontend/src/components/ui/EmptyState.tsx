import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card } from "./Card"
import { IconBadge } from "./IconBadge"

/**
 * Estado vazio — sem registro nenhum (não confundir com erro, ver `ErrorState`). Três tons:
 *  - `outline`: caixa tracejada cinza. LEGADO (era o padrão até a F-D; hoje o padrão é `quiet`) — a unificação reserva o tracejado para "drop zone";
 *    as telas migram para `quiet`/`brand` nas fases B–D.
 *  - `quiet` (padrão): sem tracejado, selo de ícone tingido. Para o ADMIN e para listas vazias por filtro/busca (nunca o mascote).
 *  - `brand`: primeiro uso no app do motorista (ainda sem recarga, sem cartão): `Card inverse` + a arte que o chamador passar em
 *    `art` (use `<MascotFace size={64} />` de `components/brand`) + CTA lima. `art` é um SLOT de propósito: este componente
 *    vive no chunk `ui-kit` e NÃO pode importar o mascote (a landing compartilha esse módulo e o caminho crítico dela é medido).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  tone = "quiet",
  art,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  className?: string
  tone?: "outline" | "quiet" | "brand"
  art?: ReactNode
}) {
  if (tone === "brand") {
    return (
      <Card variant="inverse" className={cn("flex flex-col items-center gap-3 px-6 py-10 text-center", className)}>
        {art ? <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">{art}</span> : Icon && <IconBadge icon={Icon} size="xl" tone="onDark" />}
        <div>
          <p className="text-lg font-extrabold tracking-tight text-white">{title}</p>
          {description && <p className="mt-1 max-w-sm text-sm text-ink-softer">{description}</p>}
        </div>
        {action}
      </Card>
    )
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 text-center",
        tone === "outline" ? "rounded-xl border border-dashed border-border-strong bg-muted/30 py-14" : "py-12",
        className,
      )}
    >
      {Icon && <IconBadge icon={Icon} size="xl" tone={tone === "quiet" ? "primary" : "muted"} />}
      <div>
        <p className={cn("text-ink", tone === "quiet" ? "font-bold" : "font-semibold")}>{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-ink-softer">{description}</p>}
      </div>
      {action}
    </div>
  )
}
