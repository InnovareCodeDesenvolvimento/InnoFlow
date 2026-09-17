import { Zap } from "lucide-react"
import { Link } from "react-router-dom"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/DropdownMenu"
import { getQuickActions } from "./adminQuickActions"
import { cn } from "@/lib/utils"
import type { Role } from "@/types/api"

/**
 * Atalhos rápidos do HEADER (faixa GLOBAL, visível em toda página do admin —
 * não duplicado em cada `PageHeader`). Dois formatos pro mesmo dado
 * (`adminQuickActions.ts`), escolhidos pelo caller via `className` de
 * visibilidade responsiva (ver `Admin/Layout.tsx`):
 * - `QuickActionsBar`: ícones compactos lado a lado — cabe no header a
 *   partir de `lg` (mais largura livre que a sidebar tinha).
 * - `QuickActionsDropdown`: um único botão que abre um menu — evita espremer
 *   5 ícones num header já apertado em tablet/mobile.
 */
export function QuickActionsBar({ role, className }: { role: Role | undefined; className?: string }) {
  const actions = getQuickActions(role)
  if (actions.length === 0) return null

  return (
    <div className={cn("items-center gap-1.5", className)}>
      {actions.map((action) => (
        <Link
          key={action.href}
          to={action.href}
          title={`${action.label} — ${action.hint}`}
          aria-label={action.label}
          className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-white text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
        >
          <action.icon className="h-4 w-4" aria-hidden="true" />
        </Link>
      ))}
    </div>
  )
}

export function QuickActionsDropdown({ role, className }: { role: Role | undefined; className?: string }) {
  const actions = getQuickActions(role)
  if (actions.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-white text-ink-soft transition-colors hover:border-primary/40 hover:text-primary",
            className,
          )}
          aria-label="Atalhos rápidos"
          title="Atalhos rápidos"
        >
          <Zap className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Atalhos rápidos</DropdownMenuLabel>
        {actions.map((action) => (
          <DropdownMenuItem key={action.href} asChild>
            <Link to={action.href} className="flex items-center gap-2.5">
              <action.icon className="h-4 w-4 text-ink-subtle" aria-hidden="true" />
              {action.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
