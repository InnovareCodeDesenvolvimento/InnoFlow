import { Suspense } from "react"
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom"
import { History, Home, LogOut, MapPin, ShieldAlert, Wallet, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/store/authStore"
import { useActiveSession } from "@/hooks/useMeSessions"
import { Logo } from "@/components/brand/Logo"
import { MascotFace } from "@/components/brand/Mascot"
import { LoadingScreen } from "@/components/feedback/LoadingScreen"

/**
 * Casca do PWA do motorista — barra de navegação FIXA embaixo (padrão de
 * app mobile, não a topbar do site público/admin): é onde o polegar chega
 * sem esforço segurando o celular em pé do lado do carro. 5 destinos fixos,
 * sem sub-menus (em 320px cada aba tem 64px de largura e ~58px de altura — o
 * alvo de toque passa de 44px; o rótulo mais longo, "Histórico", cabe em 11px).
 *
 * Design system unificado (F-C): moldura ESCURA (cabeçalho e navegação) e miolo claro. O cabeçalho é sólido em `primary-950`, a mesma cor do
 * `theme_color` do manifesto e do `<meta name="theme-color">` — a barra de status do celular e o cabeçalho viram uma peça só (antes o cabeçalho era
 * branco sob uma barra escura). A navegação vira um trilho lateral a partir de `lg` (o app aberto no desktop deixa de parecer um site com barra de
 * celular). A aba ativa tem ícone/rótulo brancos, pílula `white/10` e traço lima; o pingo de "sessão ativa" é lima ESTÁTICO (loop em navegação é
 * proibido pelo guia de motion).
 */
const NAV_ITEMS = [
  { href: "/app", label: "Início", icon: Home, exact: true },
  { href: "/app/mapa", label: "Mapa", icon: MapPin, exact: true },
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
    <div className="flex min-h-screen flex-col bg-background" data-app-shell>
      <header className="surface-dark sticky top-0 z-40 flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-white/10 bg-primary-950 bg-none px-4 pt-[env(safe-area-inset-top)]">
        <Link to="/app" className="flex items-center rounded-md">
          <Logo tone="dark" size={28} />
        </Link>
        <span className="ml-1 truncate text-xs text-ink-softer">{user?.name?.split(" ")[0]}</span>
        <button
          type="button"
          onClick={handleLogout}
          className="ml-auto flex h-11 w-11 items-center justify-center rounded-[var(--field-radius)] text-ink-softer hover:bg-white/10 hover:text-white"
          aria-label="Sair"
          title="Sair"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <main className="flex-1 pb-24 lg:pb-10 lg:pl-24">
        <Suspense fallback={<LoadingScreen variant="inline" className="mt-4" art={<MascotFace size={48} />} />}>
          <Outlet />
        </Suspense>
      </main>

      <nav
        className="surface-dark fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-night/95 bg-none pb-[env(safe-area-inset-bottom)] lg:inset-x-auto lg:bottom-0 lg:left-0 lg:top-14 lg:w-24 lg:border-r lg:border-t-0 lg:pb-0"
        aria-label="Navegação do aplicativo"
      >
        <div className="mx-auto flex max-w-md items-stretch justify-around lg:max-w-none lg:flex-col lg:justify-start lg:gap-1 lg:pt-4">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href, item.exact)
            return (
              <Link
                key={item.href}
                to={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors active:scale-[0.97] lg:flex-none lg:py-3",
                  active ? "text-white" : "text-white/70 hover:text-white",
                )}
              >
                {active && (
                  <span
                    className="absolute left-1/2 top-0 h-[3px] w-8 -translate-x-1/2 rounded-b-full bg-lime lg:left-0 lg:top-1/2 lg:h-8 lg:w-[3px] lg:-translate-y-1/2 lg:translate-x-0 lg:rounded-b-none lg:rounded-r-full"
                    aria-hidden="true"
                  />
                )}
                <span className={cn("relative flex h-7 w-11 items-center justify-center rounded-full transition-colors", active && "bg-white/10")}>
                  <item.icon className="h-5 w-5" aria-hidden="true" />
                  {item.href === "/app/sessao" && hasActiveSession && (
                    <span className="absolute right-1.5 top-0.5 h-2 w-2 rounded-full bg-lime ring-2 ring-night" aria-label="Sessão ativa" />
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
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-card bg-danger-100">
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
