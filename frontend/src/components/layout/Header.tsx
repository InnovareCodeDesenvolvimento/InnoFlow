import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Building2, ChevronDown, LayoutDashboard, LogOut, Menu, Smartphone, X } from "lucide-react"
import { Logo } from "@/components/brand/Logo"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { cn, operatorContextLabel } from "@/lib/utils"
import { useAuthStore } from "@/store/authStore"

/**
 * Cabeçalho do site público (`/eletropostos`). Lê autenticação direto do store — não recebe nada por prop. Só uma instância na árvore
 * (ver `Layout.tsx`).
 *
 * Design system unificado (F-B): MOLDURA ESCURA (`surface-dark`, mesmo tom `night/90` do cabeçalho da landing, sem `backdrop-filter` pelo mesmo motivo
 * de custo), CTA "Criar conta" em lima, e o menu da conta vira dropdown escuro (os tokens do escopo trocam sozinhos). Nomes acessíveis, textos e
 * a ordem dos elementos NÃO mudam (os E2E procuram por eles).
 */
const NAV_LINK = "rounded-lg px-3 py-2 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const { user, isAuthenticated, logout } = useAuthStore()
  const isStaff = user?.role === "ADMIN" || user?.role === "OPERATOR"
  const contextLabel = operatorContextLabel(user)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [])

  const handleLogout = () => {
    logout()
    setUserMenuOpen(false)
    navigate("/")
  }

  return (
    <header className="surface-dark sticky top-0 z-40 border-b border-white/10 bg-none bg-night/90">
      <div className="container-app flex h-16 items-center gap-4">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="-ml-1 flex h-10 w-10 items-center justify-center rounded-lg text-white hover:bg-white/10 md:hidden"
          aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>

        <Link to="/" className="flex items-center gap-2">
          <Logo tone="dark" size={36} showName={false} />
          <span className="hidden text-lg font-extrabold tracking-tight text-white sm:inline">InnoFlow</span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 md:flex" aria-label="Navegação principal">
          <Link to="/" className={NAV_LINK}>
            Início
          </Link>
          <Link to="/eletropostos" className={NAV_LINK}>
            Eletropostos
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {isAuthenticated && user && contextLabel && (
            <span
              className="hidden items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/90 md:inline-flex"
              title={contextLabel}
            >
              <Building2 className="h-3.5 w-3.5 text-white/70" aria-hidden="true" />
              {contextLabel}
            </span>
          )}
          {isAuthenticated && user ? (
            <div className="relative" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setUserMenuOpen((v) => !v)}
                className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-white/10"
                aria-label={`Conta de ${user.name}`}
                aria-expanded={userMenuOpen}
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-lime text-sm font-extrabold text-on-lime" aria-hidden="true">
                  {user.name.trim().charAt(0).toUpperCase()}
                </span>
                <span className="hidden text-sm font-semibold text-white sm:inline">{user.name.split(" ")[0]}</span>
                <ChevronDown className={cn("hidden h-3.5 w-3.5 text-white/70 transition-transform sm:block", userMenuOpen && "rotate-180")} aria-hidden="true" />
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-56 rounded-card border border-border bg-surface py-2 shadow-lg">
                  <div className="border-b border-border-subtle px-4 py-2.5">
                    <p className="truncate text-sm font-bold text-ink">{user.name}</p>
                    <p className="truncate text-xs text-ink-softer">{user.email}</p>
                    {contextLabel && (
                      <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs font-semibold text-primary-300 md:hidden">
                        <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {contextLabel}
                      </p>
                    )}
                  </div>
                  {isStaff && (
                    <Link
                      to="/admin"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-ink hover:bg-muted"
                    >
                      <LayoutDashboard className="h-4 w-4 text-ink-softer" aria-hidden="true" />
                      Painel administrativo
                    </Link>
                  )}
                  {user.role === "DRIVER" && (
                    <Link
                      to="/app"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-ink hover:bg-muted"
                    >
                      <Smartphone className="h-4 w-4 text-ink-softer" aria-hidden="true" />
                      Meu app
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-danger-100 hover:bg-danger/20"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    Sair
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <Link to="/login" className={NAV_LINK}>
                Entrar
              </Link>
              <Link to="/cadastro" className={buttonVariants({ variant: "lime", size: "sm" })}>
                Criar conta
              </Link>
            </>
          )}
        </div>
      </div>

      {mobileOpen && (
        <nav className="border-t border-white/10 bg-night px-4 py-3 md:hidden" aria-label="Navegação principal (mobile)">
          <Link to="/" onClick={() => setMobileOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-semibold text-white hover:bg-white/10">
            Início
          </Link>
          <Link to="/eletropostos" onClick={() => setMobileOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-semibold text-white hover:bg-white/10">
            Eletropostos
          </Link>
        </nav>
      )}
    </header>
  )
}
