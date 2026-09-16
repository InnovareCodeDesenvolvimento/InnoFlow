import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ChevronDown, LayoutDashboard, LogOut, Menu, User, X, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/store/authStore"

/**
 * Cabeçalho do site público (mapa/lista de eletropostos). Lê autenticação
 * direto do store — não recebe nada por prop. Só uma instância na árvore
 * (ver `Layout.tsx`).
 */
export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const { user, isAuthenticated, logout } = useAuthStore()
  const isStaff = user?.role === "ADMIN" || user?.role === "OPERATOR"

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
    <header className="sticky top-0 z-40 border-b border-border-subtle bg-surface/90 backdrop-blur-md">
      <div className="container-app flex h-16 items-center gap-4">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="-ml-1 flex h-10 w-10 items-center justify-center rounded-lg text-ink-soft hover:bg-muted md:hidden"
          aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>

        <Link to="/" className="flex items-center gap-2 font-black tracking-tight text-ink">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white">
            <Zap className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="hidden sm:inline">InnoElektron</span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 md:flex" aria-label="Navegação principal">
          <Link to="/" className="rounded-lg px-3 py-2 text-sm font-semibold text-ink-soft hover:bg-muted hover:text-ink">
            Início
          </Link>
          <Link
            to="/eletropostos"
            className="rounded-lg px-3 py-2 text-sm font-semibold text-ink-soft hover:bg-muted hover:text-ink"
          >
            Eletropostos
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {isAuthenticated && user ? (
            <div className="relative" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setUserMenuOpen((v) => !v)}
                className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-muted"
                aria-label={`Conta de ${user.name}`}
                aria-expanded={userMenuOpen}
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-white" aria-hidden="true">
                  {user.name.trim().charAt(0).toUpperCase()}
                </span>
                <span className="hidden text-sm font-semibold text-ink sm:inline">{user.name.split(" ")[0]}</span>
                <ChevronDown className={cn("hidden h-3.5 w-3.5 text-ink-softer transition-transform sm:block", userMenuOpen && "rotate-180")} aria-hidden="true" />
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-56 rounded-2xl border border-border-subtle bg-surface py-2 shadow-lg">
                  <div className="border-b border-border-subtle px-4 py-2.5">
                    <p className="truncate text-sm font-bold text-ink">{user.name}</p>
                    <p className="truncate text-xs text-ink-softer">{user.email}</p>
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
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-danger-600 hover:bg-danger-50"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    Sair
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded-lg px-3 py-2 text-sm font-semibold text-ink-soft hover:bg-muted hover:text-ink"
              >
                Entrar
              </Link>
              <Link
                to="/cadastro"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-700"
              >
                <User className="h-4 w-4" aria-hidden="true" />
                Criar conta
              </Link>
            </>
          )}
        </div>
      </div>

      {mobileOpen && (
        <nav className="border-t border-border-subtle bg-surface px-4 py-3 md:hidden" aria-label="Navegação principal (mobile)">
          <Link to="/" onClick={() => setMobileOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-semibold text-ink hover:bg-muted">
            Início
          </Link>
          <Link to="/eletropostos" onClick={() => setMobileOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-semibold text-ink hover:bg-muted">
            Eletropostos
          </Link>
        </nav>
      )}
    </header>
  )
}
