import { useState } from "react"
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom"
import { Building2, ExternalLink, LogOut, Menu, ShieldAlert, X } from "lucide-react"
import { useAuthStore } from "@/store/authStore"
import { getAdminNav, type AdminNavItem } from "@/components/admin/adminNav"
import { QuickActions } from "@/components/admin/QuickActions"
import { matchNavItem } from "@/components/painel/navegacao"
import { InnovareCodeBadge } from "@/components/painel/InnovareCodeBadge"
import { cn, operatorContextLabel, ROLE_LABELS } from "@/lib/utils"
import logoIcon from "@/assets/logo-icon.png"

/**
 * Casca do painel administrativo — sidebar azul-marca fixa no desktop,
 * drawer no mobile. `ADMIN` vê tudo; `OPERATOR` vê o mesmo menu menos
 * "Tokens de autenticação" (ver `getAdminNav`) — o filtro de DADOS
 * (só os próprios sites/charge-points) é feito pelo backend
 * (`operatorScopeWhere`), aqui só escondemos/mostramos navegação.
 */

function NavLinkItem({ item, isActive, onNavigate }: { item: AdminNavItem; isActive: boolean; onNavigate?: () => void }) {
  return (
    <Link
      to={item.href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "pressable group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-bold transition-colors",
        isActive ? "bg-white/15 text-white shadow-[0_6px_16px_-8px_rgb(var(--color-accent-glow)/0.35)] ring-1 ring-white/20" : "text-white/60 hover:bg-white/10 hover:text-white",
      )}
    >
      <item.icon className={cn("h-[18px] w-[18px] shrink-0", isActive ? "text-white" : "text-white/50 group-hover:text-white/90")} aria-hidden="true" />
      <span className="flex-1">{item.label}</span>
    </Link>
  )
}

function AdminShell() {
  const { user, logout } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const nav = getAdminNav(user?.role)
  const current = matchNavItem(nav, location.pathname)
  const contextLabel = operatorContextLabel(user)

  const isActive = (item: AdminNavItem) =>
    item.exact ? location.pathname === item.href || location.pathname === `${item.href}/` : location.pathname.startsWith(item.href)

  const navGroups = (onNavigate?: () => void) =>
    nav.map((group) => (
      <div key={group.title} className="mb-6 last:mb-0">
        <p className="mb-2 px-3.5 text-[10px] font-black uppercase tracking-widest text-white/35">{group.title}</p>
        <div className="flex flex-col gap-1">
          {group.items.map((item) => (
            <NavLinkItem key={item.href} item={item} isActive={isActive(item)} onNavigate={onNavigate} />
          ))}
        </div>
      </div>
    ))

  const handleLogout = () => {
    logout()
    navigate("/")
  }

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
      {/* Sidebar desktop */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col bg-primary-950 lg:flex">
        <div className="flex h-16 items-center gap-2 border-b border-white/10 px-5">
          <Link to="/" className="flex items-center gap-2 font-black tracking-tight text-white" aria-label="Ir para o site público">
            <img src={logoIcon} alt="" className="h-8 w-8 shrink-0" />
            InnoFlow
          </Link>
        </div>
        <div className="space-y-2 px-5 py-4">
          <span className="inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white ring-1 ring-white/20">
            Painel administrativo
          </span>
          {contextLabel && (
            <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-white/70" title={contextLabel}>
              <Building2 className="h-3.5 w-3.5 shrink-0 text-white/50" aria-hidden="true" />
              {contextLabel}
            </p>
          )}
        </div>
        <nav className="flex-1 overflow-y-auto px-4 pb-4" aria-label="Navegação do painel administrativo">
          <QuickActions role={user?.role} />
          {navGroups()}
        </nav>
        <div className="border-t border-white/10 p-4">
          <div className="flex items-center gap-3 rounded-xl bg-white/10 p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15 text-sm font-black text-white" aria-hidden="true">
              {(user?.name ?? "A").charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-white">{user?.name}</p>
              <p className="truncate text-[11px] text-white/50">{user ? ROLE_LABELS[user.role] : ""}</p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/15 hover:text-white"
              aria-label="Sair do painel"
              title="Sair"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>

      {/* Drawer mobile */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/50 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 right-0 flex w-72 flex-col bg-primary-950 shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
              <div className="min-w-0">
                <span className="text-sm font-black uppercase tracking-widest text-white">Menu</span>
                {contextLabel && (
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs font-semibold text-white/60">
                    <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {contextLabel}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white"
                aria-label="Fechar menu"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-4" aria-label="Navegação do painel administrativo (mobile)">
              <QuickActions role={user?.role} onNavigate={() => setDrawerOpen(false)} />
              {navGroups(() => setDrawerOpen(false))}
            </nav>
            <div className="border-t border-white/10 p-4">
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 px-4 py-3 text-sm font-bold text-white"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Sair do painel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Conteúdo — coluna de altura fixa (viewport inteira): header e footer
          não rolam, só o `main` do meio rola. */}
      <div className="flex h-screen flex-col lg:pl-64">
        <header className="z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border-subtle bg-background/85 px-4 backdrop-blur-md backdrop-saturate-150 sm:px-6">
          <div className="hidden min-w-0 flex-1 lg:block">
            <p className="text-[11px] font-bold uppercase tracking-widest text-ink-subtle">Painel administrativo</p>
            <h2 className="truncate text-lg font-black tracking-tight text-ink">{current?.label ?? "Administração"}</h2>
          </div>

          <Link to="/" className="lg:hidden font-black text-ink" aria-label="Ir para o site público">
            InnoFlow
          </Link>

          <div className="flex flex-1 items-center justify-end gap-2 lg:flex-none">
            <Link
              to="/eletropostos"
              className="pressable hidden items-center gap-1.5 rounded-full border border-border bg-white px-3 py-2 text-xs font-semibold text-ink-softer transition-colors hover:border-primary/40 hover:text-primary sm:flex"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Ver site público
            </Link>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-white text-ink-soft lg:hidden"
              aria-label="Abrir menu"
              aria-expanded={drawerOpen}
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
        <main className="flex-1 overflow-y-auto p-4 pb-8 sm:p-6 sm:pb-10 lg:p-8 lg:pb-10">
          <Outlet />
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
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />
  }

  if (user?.role !== "ADMIN" && user?.role !== "OPERATOR") {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-danger-100">
          <ShieldAlert className="h-8 w-8 text-danger-600" aria-hidden="true" />
        </div>
        <p className="text-lg font-bold text-ink">Acesso restrito</p>
        <p className="mb-5 mt-1 text-sm text-ink-softer">Esta área é exclusiva para administradores e operadores.</p>
        <Link to="/" className="text-sm font-medium text-primary hover:underline">
          Voltar ao início
        </Link>
      </div>
    )
  }

  return <AdminShell />
}
