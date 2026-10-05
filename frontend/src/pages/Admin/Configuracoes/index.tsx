import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import { LogOut, Pencil, Settings } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Skeleton } from "@/components/ui/Skeleton"
import { cn } from "@/lib/utils"
import { DirtyContext, type DirtyRegistry } from "./dirtyContext"
import { CONFIG_TABS, configTabFromPathname, configTabHref } from "./tabs"

/**
 * Admin → Configurações (ADMIN-ONLY: o guarda de papel mora na ROTA, `RequireAuth roles=["ADMIN"]`, e o servidor confere de novo, 403).
 * Casca: título "Configurações · <aba>", barra de abas (links para SUBROTAS) e o aviso de alteração não salva ao trocar de aba. O conteúdo é a rota filha, lazy.
 * O menu lateral e o botão Voltar do navegador não passam pelo aviso (só `beforeunload` cobre fechar/recarregar).
 */
export default function ConfiguracoesPage() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const active = CONFIG_TABS.find((t) => t.id === configTabFromPathname(pathname)) ?? null
  const dirtyIds = useRef(new Set<string>())
  const [leaveTo, setLeaveTo] = useState<string | null>(null)

  const set = useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyIds.current.add(id)
    else dirtyIds.current.delete(id)
  }, [])
  const registry = useMemo<DirtyRegistry>(() => ({ set }), [set])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyIds.current.size > 0) event.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [])

  const onTabClick = (event: MouseEvent<HTMLAnchorElement>, href: string, isActive: boolean) => {
    if (isActive || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    if (dirtyIds.current.size === 0) return
    event.preventDefault()
    setLeaveTo(href)
  }

  const confirmLeave = () => {
    const href = leaveTo
    dirtyIds.current.clear()
    setLeaveTo(null)
    if (href) navigate(href)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Settings}
        title={active ? `Configurações · ${active.label}` : "Configurações da plataforma"}
        description={active?.description ?? "Dados da empresa, e-mail, WhatsApp e alertas da plataforma."}
      />

      <nav aria-label="Assuntos das configurações" data-testid="config-tabs" className="border-b border-border">
        <ul className="-mb-px flex gap-1 overflow-x-auto">
          {CONFIG_TABS.map(({ id, label, icon: Icon }) => {
            const href = configTabHref(id)
            return (
              <li key={id}>
                <NavLink
                  to={href}
                  onClick={(event) => onTabClick(event, href, active?.id === id)}
                  className={({ isActive }) =>
                    cn(
                      "flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-bold transition-colors",
                      isActive ? "border-focus text-ink" : "border-transparent text-ink-softer hover:text-ink",
                    )
                  }
                >
                  <Icon className="hidden h-4 w-4 sm:block" aria-hidden="true" />
                  {label}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </nav>

      <DirtyContext.Provider value={registry}>
        <Suspense fallback={<Skeleton className="h-96 w-full rounded-card" />}>
          <Outlet />
        </Suspense>
      </DirtyContext.Provider>

      <Dialog open={leaveTo !== null} onOpenChange={(open) => !open && setLeaveTo(null)}>
        <DialogContent>
          <DialogHeader icon={Pencil}>
            <DialogTitle>Você tem alterações não salvas</DialogTitle>
            <DialogDescription>Se trocar de aba agora, o que você digitou nesta aba se perde. Salve antes, se quiser guardar.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="touch" onClick={() => setLeaveTo(null)}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Continuar editando
            </Button>
            <Button type="button" variant="destructive" size="touch" onClick={confirmLeave}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Sair sem salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
