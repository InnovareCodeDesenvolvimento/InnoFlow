import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom"
import { History, Home, LogOut, ShieldAlert, Wallet, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/store/authStore"
import { useActiveSession } from "@/hooks/useMeSessions"
// Variante pequena — ver comentário em `Public/ChargePointLanding.tsx`.
import logoIcon from "@/assets/logo-icon-sm.png"

/**
 * Casca do PWA do motorista — barra de navegação FIXA embaixo (padrão de
 * app mobile, não a topbar do site público/admin): é onde o polegar chega
 * sem esforço segurando o celular em pé do lado do carro. 4 destinos fixos,
 * sem sub-menus.
 */
const NAV_ITEMS = [
  { href: "/app", label: "Início", icon: Home, exact: true },
  { href: "/app/sessao", label: "Sessão", icon: Zap, exact: true },
  { href: "/app/sessoes", label: "Histórico", icon: History, exact: true },
  { href: "/app/carteira", label: "Carteira", icon: Wallet, exact: true },
] as const

function AppShell() {
  const { user, logout } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()
  // Só para o "pingo" de sessão ativa no ícone "Sessão" — não afeta a Home,
  // que já busca isso por conta própria.
  const { data: activeData } = useActiveSession()
  const hasActiveSession = !!activeData?.session

  const handleLogout = () => {
    logout()
    navigate("/")
  }

  const isActive = (href: string, exact: boolean) => (exact ? location.pathname === href : location.pathname.startsWith(href))

  return (
    <div className="flex min-h-screen flex-col bg-background lg:bg-gradient-to-b lg:from-primary-50 lg:via-background lg:to-background">
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface/90 px-4 backdrop-blur-md backdrop-saturate-150">
        <Link to="/app" className="flex items-center gap-2 font-black tracking-tight text-ink">
          <img src={logoIcon} alt="" className="h-7 w-7 shrink-0" />
          <span className="text-sm">InnoFlow</span>
        </Link>
        <span className="ml-1 truncate text-xs text-ink-softer">{user?.name?.split(" ")[0]}</span>
        <button
          type="button"
          onClick={handleLogout}
          className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-ink-softer hover:bg-muted hover:text-ink"
          aria-label="Sair"
          title="Sair"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <main className="flex-1 pb-24">
        <Outlet />
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md backdrop-saturate-150"
        aria-label="Navegação do aplicativo"
      >
        <div className="mx-auto flex max-w-md items-stretch justify-around">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href, item.exact)
            return (
              <Link
                key={item.href}
                to={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "pressable relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors",
                  active ? "text-primary" : "text-ink-softer hover:text-ink-soft",
                )}
              >
                <span
                  className={cn(
                    "relative flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                    active && "bg-primary/10",
                  )}
                >
                  <item.icon className="h-5 w-5" aria-hidden="true" />
                  {item.href === "/app/sessao" && hasActiveSession && (
                    <span
                      className="absolute right-1.5 top-0.5 h-2 w-2 animate-pulse rounded-full bg-accent ring-2 ring-surface"
                      aria-label="Sessão ativa"
                    />
                  )}
                </span>
                {item.label}
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}

export function AppLayout() {
  const { user, isAuthenticated } = useAuthStore()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />
  }

  if (user?.role !== "DRIVER") {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-danger-100">
          <ShieldAlert className="h-8 w-8 text-danger-600" aria-hidden="true" />
        </div>
        <p className="text-lg font-bold text-ink">Área exclusiva de motoristas</p>
        <p className="mb-5 mt-1 text-sm text-ink-softer">
          Contas de administrador/operador usam o painel administrativo, não este app.
        </p>
        <Link to="/admin" className="text-sm font-medium text-primary hover:underline">
          Ir para o painel administrativo
        </Link>
      </div>
    )
  }

  return <AppShell />
}
