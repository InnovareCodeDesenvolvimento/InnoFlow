import { Link } from "react-router-dom"
import { getQuickActions } from "./adminQuickActions"
import type { Role } from "@/types/api"

/**
 * Faixa de atalhos rápidos, fixa ACIMA dos grupos de navegação (não briga com
 * eles: é uma seção própria, com título e visual mais discreto que os
 * `NavLinkItem`, então o operador não confunde "atalho" com "página nova").
 * Curadoria estática — ver `adminQuickActions.ts`.
 */
export function QuickActions({ role, onNavigate }: { role: Role | undefined; onNavigate?: () => void }) {
  const actions = getQuickActions(role)
  if (actions.length === 0) return null

  return (
    <div className="mb-6 px-3.5">
      <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-white/35">Atalhos rápidos</p>
      <div className="grid grid-cols-2 gap-1.5">
        {actions.map((action) => (
          <Link
            key={action.href}
            to={action.href}
            onClick={onNavigate}
            title={action.hint}
            className="pressable flex flex-col gap-1 rounded-xl bg-white/[0.06] px-2.5 py-2 text-white/70 ring-1 ring-white/10 transition-colors hover:bg-white/10 hover:text-white"
          >
            <action.icon className="h-4 w-4 shrink-0 text-white/50" aria-hidden="true" />
            <span className="truncate text-[11px] font-bold leading-tight">{action.label}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
