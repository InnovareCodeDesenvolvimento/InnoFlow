import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom"
import { RedirectToLogin } from "@/components/layout/RedirectToLogin"
import { Building2, ChevronRight, ExternalLink, LogOut, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { useAuthStore } from "@/store/authStore"
import { getAdminNav, type AdminNavItem } from "@/components/admin/adminNav"
import { SidebarNav } from "@/components/admin/SidebarNav"
import { AdminDrawer } from "@/components/admin/AdminDrawer"
import { AdminUserMenu } from "@/components/admin/AdminUserMenu"
import { TourProvider } from "@/components/onboarding/TourProvider"
import { useTour } from "@/components/onboarding/tourContext"
import { useMediaQuery } from "@/hooks/useMediaQuery"
import { QuickActionsBar, QuickActionsDropdown } from "@/components/admin/QuickActionsBar"
import { matchNavItem } from "@/components/painel/navegacao"
import { InnovareCodeBadge } from "@/components/painel/InnovareCodeBadge"
import { cn, operatorContextLabel, ROLE_LABELS } from "@/lib/utils"
import { Logo } from "@/components/brand/Logo"
import { MascotFace } from "@/components/brand/Mascot"
import { AccessDenied } from "@/components/feedback/AccessDenied"
import { LoadingScreen } from "@/components/feedback/LoadingScreen"

/**
 * Casca do painel administrativo — sidebar azul-marca fixa no desktop
 * (colapsável pro modo "só ícones"), drawer no mobile. `ADMIN` vê tudo;
 * `OPERATOR` vê o mesmo menu menos "Tokens de autenticação"/"Auditoria" (ver
 * `getAdminNav`) — o filtro de DADOS (só os próprios sites/charge-points) é
 * feito pelo backend (`operatorScopeWhere`), aqui só escondemos/mostramos
 * navegação.
 *
 * Onboarding (tour do painel): `AdminLayout` envolve o shell no `TourProvider` (abre sozinho na 1ª visita de cada usuário). Os `data-tour` (`admin-sidebar`, `admin-menu-button`,
 * `admin-user`, `admin-quick-actions` e `nav-*` em `SidebarNav`) são os alvos do roteiro em `components/onboarding/tourScripts.ts`. "Rever tour": menu do nome (rodapé da sidebar) e
 * item no drawer. Com o tour aberto, todos os grupos do menu ficam abertos (senão os itens-alvo estariam recolhidos e o balão cairia no centro).
 */

const SIDEBAR_COLLAPSED_KEY = "innoelektron-admin-sidebar-collapsed"
const NAV_GROUPS_OPEN_KEY = "innoelektron-admin-nav-groups-open"

function readCollapsedPref(): boolean {
  if (typeof window === "undefined") return false
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"
}

function readOpenGroupsPref(): Record<string, boolean> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(NAV_GROUPS_OPEN_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function AdminShell() {
  const { user, logout } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  // O drawer só existe abaixo de `lg` (1024 px). Se a janela crescer com ele aberto (girar o tablet), o diálogo ficaria invisível mas
  // ainda travando foco/leitor de tela — fecha. Derivado no render, sem efeito com setState.
  const isDesktop = useMediaQuery("(min-width: 1024px)")
  const drawerVisible = drawerOpen && !isDesktop
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsedPref)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(readOpenGroupsPref)

  const tour = useTour()
  const nav = useMemo(() => getAdminNav(user?.role), [user?.role])
  const current = matchNavItem(nav, location.pathname)
  const contextLabel = operatorContextLabel(user)

  const isActive = (item: AdminNavItem) =>
    item.exact ? location.pathname === item.href || location.pathname === `${item.href}/` : location.pathname.startsWith(item.href)

  const activeGroupTitle = nav.find((group) => group.items.some(isActive))?.title

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0")
  }, [collapsed])

  useEffect(() => {
    window.localStorage.setItem(NAV_GROUPS_OPEN_KEY, JSON.stringify(openGroups))
  }, [openGroups])

  // O grupo da rota ATIVA nunca pode aparecer fechado — mesmo que o
  // localStorage guarde `false` de uma sessão anterior — senão o admin entra
  // numa página e não vê onde está no menu. Isso é derivado no RENDER (não
  // num efeito com `setState`): o grupo ativo sempre nasce (e continua)
  // expandido enquanto for a rota atual; o clique no título continua
  // gravando a preferência em `localStorage`, só não fecha visualmente
  // enquanto o admin está dentro dele.
  const isGroupOpen = (title: string): boolean => tour.active || title === activeGroupTitle || (openGroups[title] ?? true)
  const toggleGroup = (title: string) => setOpenGroups((prev) => ({ ...prev, [title]: !(prev[title] ?? true) }))

  const handleLogout = () => {
    logout()
    navigate("/")
  }

  // Abre o tour depois que o menu/drawer de onde o pedido veio terminou de fechar e devolveu o foco (o tour guarda o elemento focado para devolver ao fechar).
  const replayTour = tour.available ? () => window.setTimeout(tour.restart, 200) : undefined
  const replayTourFromDrawer = replayTour
    ? () => {
        setDrawerOpen(false)
        replayTour()
      }
    : undefined

  return (
    // `h-screen overflow-hidden`: o shell inteiro tem a altura da viewport e não
    // rola — só o `<main>` (flex-1 overflow-y-auto) rola por dentro. Antes era
    // a PÁGINA/`body` inteira que rolava, e o `InnovareCodeBadge` (fixed no
    // canto) sobrepunha conteúdo real sempre que a altura natural da página
    // (com ou sem rolar) coincidia com o retângulo fixo do selo — acontecia
    // tanto ao rolar até o fim de uma tabela longa quanto, sem rolar nada,
    // quando o conteúdo de uma tela curta (Dashboard, Sessões) já nascia perto
    // da altura da viewport. Com o shell fixo, o selo deixou de ser `fixed`:
    // agora é uma faixa de rodapé própria (`footer`, fora da área de rolagem
    // do `main`) — não overlap é garantido pela própria disposição em flex-col
    // (header/main/footer são caixas empilhadas, nunca sobrepostas), não por
    // cálculo de padding. Achado real, revisão premium do painel, 17/09/2026.
    <div className="h-screen overflow-hidden bg-background">
      {/* Sidebar desktop — largura anima entre expandida (256px) e colapsada
          (só ícones, 80px); a preferência persiste em localStorage (por
          navegador, não vai pro backend — pedido do dono). */}
      <aside
        data-tour="admin-sidebar"
        className={cn(
          "surface-dark fixed inset-y-0 left-0 z-20 hidden flex-col transition-[width] duration-200 lg:flex",
          collapsed ? "w-20" : "w-64",
        )}
      >
        <div className={cn("flex h-16 items-center border-b border-white/10", collapsed ? "justify-center px-2" : "gap-2 px-5")}>
          {!collapsed && (
            <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 font-black tracking-tight text-white" aria-label="Ir para o site público">
              <Logo tone="dark" size={32} className="min-w-0" />
            </Link>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
            title={collapsed ? "Expandir menu" : "Recolher menu"}
          >
            {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden="true" /> : <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden="true" />}
          </button>
        </div>

        {!collapsed && (
          <div className="space-y-2 px-5 py-4">
            <span className="inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white ring-1 ring-white/20">
              Painel administrativo
            </span>
            {contextLabel && (
              <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-white/70" title={contextLabel}>
                <Building2 className="h-3.5 w-3.5 shrink-0 text-white/60" aria-hidden="true" />
                {contextLabel}
              </p>
            )}
          </div>
        )}

        <nav className={cn("flex-1 overflow-y-auto pb-4", collapsed ? "px-2 pt-3" : "px-4")} aria-label="Navegação do painel administrativo">
          <SidebarNav nav={nav} collapsed={collapsed} isActive={isActive} isGroupOpen={isGroupOpen} onToggleGroup={toggleGroup} />
        </nav>

        <div className={cn("border-t border-white/10", collapsed ? "p-2" : "p-4")}>
          <div className={cn("flex items-center rounded-xl bg-white/10", collapsed ? "flex-col gap-2 p-2" : "gap-3 p-3")} data-tour="admin-user">
            <AdminUserMenu name={user?.name} subtitle={user ? ROLE_LABELS[user.role] : ""} collapsed={collapsed} onReplayTour={replayTour} />
            <button
              type="button"
              onClick={handleLogout}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/15 hover:text-white"
              aria-label="Sair do painel"
              title="Sair"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>

      {/* Drawer mobile — diálogo acessível (Radix) sempre no modo expandido (accordion); ver `AdminDrawer`. */}
      <AdminDrawer
        open={drawerVisible}
        onOpenChange={setDrawerOpen}
        returnFocusTo={menuButtonRef}
        contextLabel={contextLabel}
        nav={nav}
        isActive={isActive}
        isGroupOpen={isGroupOpen}
        onToggleGroup={toggleGroup}
        onLogout={handleLogout}
        onReplayTour={replayTourFromDrawer}
      />

      {/* Conteúdo — coluna de altura fixa (viewport inteira): header e footer
          não rolam, só o `main` do meio rola. `pl-*` acompanha a largura da
          sidebar (expandida/colapsada) pra não sobrar nem faltar espaço. */}
      <div className={cn("flex h-screen flex-col transition-[padding] duration-200", collapsed ? "lg:pl-20" : "lg:pl-64")}>
        <header className="z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border-subtle bg-surface px-4 sm:px-6">
          {/* Trilha, NÃO título: o h1 da página é o do `PageHeader` (a Nova achou o título repetido header x PageHeader). Texto em 12 px, sem heading. */}
          <p className="hidden min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-semibold text-ink-softer lg:flex">
            <span>Painel administrativo</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />
            <span className="truncate text-ink">{current?.label ?? "Administração"}</span>
          </p>

          <Link to="/" className="lg:hidden" aria-label="Ir para o site público">
            <Logo tone="light" size={28} />
          </Link>

          {/* Atalhos rápidos — faixa GLOBAL do header (pedido do dono, saiu da
              sidebar: "navegação" e "ação" em faixas separadas). Ícones lado a
              lado a partir de `lg` (mais espaço livre); dropdown compacto
              abaixo disso, pra não espremer o header em tablet/mobile. */}
          <QuickActionsBar role={user?.role} className="hidden lg:flex" />

          <div className="flex flex-1 items-center justify-end gap-2 lg:flex-none">
            <QuickActionsDropdown role={user?.role} className="lg:hidden" />
            <Link
              to="/eletropostos"
              className="hidden min-h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-xs font-semibold text-ink-softer transition-colors hover:border-primary/40 hover:text-primary sm:flex"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Ver site público
            </Link>
            <button
              type="button"
              ref={menuButtonRef}
              data-tour="admin-menu-button"
              onClick={() => setDrawerOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-ink-soft lg:hidden"
              aria-label="Abrir menu"
              aria-haspopup="dialog"
              aria-expanded={drawerVisible}
            >
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* `flex-1 overflow-y-auto`: única área que rola — sobra de espaço da
            coluna (viewport menos header e rodapé), nunca o tamanho do
            conteúdo. Padding extra mantido de propósito (era a mitigação
            antiga para o selo fixo); com o rodapé próprio abaixo já não é
            estritamente necessário, mas não faz mal manter como respiro. */}
        <main className="flex-1 scroll-pb-28 overflow-y-auto p-4 pb-8 sm:p-6 sm:pb-10 lg:p-8 lg:pb-10">
          {/* As páginas são lazy: o fallback fica DENTRO do shell (sidebar e cabeçalho continuam), com o mascote só se a espera passar de 0,7 s. */}
          <Suspense fallback={<LoadingScreen variant="inline" className="mx-0 min-h-[40svh]" art={<MascotFace size={48} />} />}>
            <Outlet />
          </Suspense>
        </main>

        {/* Rodapé do shell — fora da área de rolagem do `main`, então nunca
            sobrepõe conteúdo real (são caixas empilhadas em flex-col, não
            camadas). Sempre visível, mesmo em listagens longas, sem depender
            de o operador rolar até o fim. */}
        <footer className="flex h-11 shrink-0 items-center justify-end border-t border-border-subtle bg-background px-3 sm:h-14 sm:px-4">
          <InnovareCodeBadge />
        </footer>
      </div>
    </div>
  )
}

export function AdminLayout() {
  const { user, isAuthenticated } = useAuthStore()
  // Menu efetivo do papel, estável entre renders: o tour decide quais passos existem a partir dele (OPERATOR não tem os passos só-ADMIN).
  const tourNav = useMemo(() => getAdminNav(user?.role), [user?.role])

  if (!isAuthenticated) {
    return <RedirectToLogin />
  }

  if (user?.role !== "ADMIN" && user?.role !== "OPERATOR") {
    return <AccessDenied description="Esta área é exclusiva para administradores e operadores." />
  }

  return (
    <TourProvider userId={user.id} role={user.role} nav={tourNav}>
      <AdminShell />
    </TourProvider>
  )
}
