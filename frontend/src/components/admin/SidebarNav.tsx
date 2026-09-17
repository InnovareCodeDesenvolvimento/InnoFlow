import { ChevronDown } from "lucide-react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import type { AdminNavGroup, AdminNavItem } from "./adminNav"

function NavLinkItem({
  item,
  isActive,
  collapsed,
  onNavigate,
}: {
  item: AdminNavItem
  isActive: boolean
  collapsed?: boolean
  onNavigate?: () => void
}) {
  return (
    <Link
      to={item.href}
      onClick={onNavigate}
      // Colapsado: sem `label` visível, então `title`/`aria-label` carregam o
      // nome do link — é o que mantém o rail de ícones acessível (teclado e
      // leitor de tela continuam sabendo pra onde o link vai).
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "pressable group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-bold transition-colors",
        collapsed && "justify-center px-0",
        isActive
          ? "bg-white/15 text-white shadow-[0_6px_16px_-8px_rgb(var(--color-accent-glow)/0.35)] ring-1 ring-white/20"
          : "text-white/60 hover:bg-white/10 hover:text-white",
      )}
    >
      <item.icon className={cn("h-[18px] w-[18px] shrink-0", isActive ? "text-white" : "text-white/50 group-hover:text-white/90")} aria-hidden="true" />
      {!collapsed && <span className="flex-1">{item.label}</span>}
    </Link>
  )
}

/**
 * Navegação do painel admin — usada pelo desktop (colapsável) e pelo drawer
 * mobile (sempre expandido). Dois modos:
 * - Expandido: grupos em ACCORDION (título clicável, `aria-expanded`,
 *   estado persistido em `localStorage` pelo `Admin/Layout.tsx`).
 * - Colapsado (só desktop): rail de ícones sem título de grupo — não há
 *   label pra clicar, então accordion não faz sentido aqui; só um respiro
 *   entre grupos pra não virar uma coluna de ícones indistinta.
 */
export function SidebarNav({
  nav,
  collapsed,
  isActive,
  isGroupOpen,
  onToggleGroup,
  onNavigate,
}: {
  nav: AdminNavGroup[]
  collapsed: boolean
  isActive: (item: AdminNavItem) => boolean
  isGroupOpen: (title: string) => boolean
  onToggleGroup: (title: string) => void
  onNavigate?: () => void
}) {
  if (collapsed) {
    return (
      <div className="flex flex-col gap-3">
        {nav.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            {group.items.map((item) => (
              <NavLinkItem key={item.href} item={item} isActive={isActive(item)} collapsed onNavigate={onNavigate} />
            ))}
          </div>
        ))}
      </div>
    )
  }

  return (
    <>
      {nav.map((group) => {
        const open = isGroupOpen(group.title)
        return (
          <div key={group.title} className="mb-4 last:mb-0">
            <button
              type="button"
              onClick={() => onToggleGroup(group.title)}
              aria-expanded={open}
              className="mb-1 flex w-full items-center justify-between rounded-lg px-3.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-white/35 transition-colors hover:text-white/60"
            >
              {group.title}
              <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200", !open && "-rotate-90")} aria-hidden="true" />
            </button>
            {/* Truque de grid pra colapsar com transição sem medir altura em JS: `grid-rows-[0fr]→[1fr]` anima o conteúdo dentro de um `overflow-hidden`. */}
            <div className={cn("grid transition-all duration-200", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
              <div className="overflow-hidden">
                <div className="flex flex-col gap-1 pt-0.5">
                  {group.items.map((item) => (
                    <NavLinkItem key={item.href} item={item} isActive={isActive(item)} onNavigate={onNavigate} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
