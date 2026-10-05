import type { RefObject } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Building2, LogOut, Route, X } from "lucide-react"
import { SidebarNav } from "./SidebarNav"
import type { AdminNavGroup, AdminNavItem } from "./adminNav"

/**
 * Menu do Admin abaixo de `lg`, como DIÁLOGO de verdade (Radix): `role="dialog"` com nome (o "Menu" visível), foco entra ao abrir
 * (primeiro focável = "Fechar menu"), Tab preso dentro, Esc e clique no véu fecham, e o resto da página fica `aria-hidden` enquanto
 * aberto. O visual é o do drawer de antes (painel `surface-dark` à direita, véu `dialog-scrim` sem desfoque, sem animação).
 *
 * O gatilho ("Abrir menu") mora no cabeçalho, longe daqui, então não é um `Dialog.Trigger`: o Radix só devolve o foco a um Trigger.
 * `returnFocusTo` aponta para o botão e o devolvemos nós mesmos em `onCloseAutoFocus` (mesma razão do `ui/Dialog`).
 */
export function AdminDrawer({
  open,
  onOpenChange,
  returnFocusTo,
  contextLabel,
  nav,
  isActive,
  isGroupOpen,
  onToggleGroup,
  onLogout,
  onReplayTour,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocusTo: RefObject<HTMLElement | null>
  contextLabel: string | null | undefined
  nav: AdminNavGroup[]
  isActive: (item: AdminNavItem) => boolean
  isGroupOpen: (title: string) => boolean
  onToggleGroup: (title: string) => void
  onLogout: () => void
  /** "Rever tour" (onboarding). Ausente = sem o item (usuário sem tour). O chamador fecha o drawer e abre o tour. */
  onReplayTour?: () => void
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-scrim fixed inset-0 z-50 lg:hidden" />
        <DialogPrimitive.Content
          // Sem descrição própria: o nome ("Menu") e a navegação dentro já dizem o que é. `undefined` explícito silencia o aviso do Radix.
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target = returnFocusTo.current
            if (target?.isConnected) target.focus()
          }}
          className="surface-dark fixed inset-y-0 right-0 z-50 flex w-72 flex-col shadow-2xl focus-visible:outline-none lg:hidden"
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
            <div className="min-w-0">
              {/* `asChild` num <span>: o Radix liga o nome do diálogo a este texto sem criar um heading (o h1 da página é o do PageHeader). */}
              <DialogPrimitive.Title asChild>
                <span className="text-sm font-black uppercase tracking-widest text-white">Menu</span>
              </DialogPrimitive.Title>
              {contextLabel && (
                <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs font-semibold text-white/70">
                  <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {contextLabel}
                </p>
              )}
            </div>
            <DialogPrimitive.Close
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white"
              aria-label="Fechar menu"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <nav className="flex-1 overflow-y-auto p-4" aria-label="Navegação do painel administrativo (mobile)">
            <SidebarNav
              nav={nav}
              collapsed={false}
              isActive={isActive}
              isGroupOpen={isGroupOpen}
              onToggleGroup={onToggleGroup}
              onNavigate={() => onOpenChange(false)}
            />
          </nav>
          <div className="border-t border-white/10 p-4">
            {onReplayTour && (
              <button
                type="button"
                onClick={onReplayTour}
                className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 px-4 py-3 text-sm font-bold text-white"
              >
                <Route className="h-4 w-4" aria-hidden="true" />
                Rever tour
              </button>
            )}
            <button
              type="button"
              onClick={onLogout}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 px-4 py-3 text-sm font-bold text-white"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Sair do painel
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
