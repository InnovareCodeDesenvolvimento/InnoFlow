import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight, LayoutDashboard, Menu, Smartphone, X } from "lucide-react"
import logoIcon from "@/assets/landing/logo-icon-96.webp"
import { useAuthStore } from "@/store/authStore"
import { CTA_LINKS, NAV_ANCHORS } from "./landing-data"

/**
 * Cabeçalho da landing: fixo, em vidro escuro sobre o hero (a arte do mascote é feita para fundo escuro). É
 * PRÓPRIO da landing e não o `Header` do site público porque aquele é claro, não tem âncoras de seção e a landing
 * precisa do menu de seções. As demais páginas públicas (`/eletropostos`) seguem no `Layout` de sempre. Quem já está
 * logado vê o atalho certo para a área dele (app do motorista ou painel) no lugar de "Criar conta".
 */
export function LandingHeader() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(() => typeof window !== "undefined" && window.scrollY > 8)
  const menuRef = useRef<HTMLDivElement>(null)
  const { user, isAuthenticated } = useAuthStore()
  const isStaff = user?.role === "ADMIN" || user?.role === "OPERATOR"

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // Esc fecha o menu e devolve o foco ao botão; clicar fora também fecha.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false)
        menuRef.current?.querySelector<HTMLButtonElement>("button[aria-controls]")?.focus()
      }
    }
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onPointer)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onPointer)
    }
  }, [open])

  const accountHref = isStaff ? "/admin" : "/app"
  const accountLabel = isStaff ? "Painel" : "Meu app"
  const AccountIcon = isStaff ? LayoutDashboard : Smartphone

  return (
    <header className="lnd-header fixed inset-x-0 top-0 z-50" data-scrolled={scrolled}>
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link to="/" aria-label="InnoFlow, início" className="-ml-1 flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg px-1">
          <img src={logoIcon} alt="" width={36} height={36} className="h-9 w-9 shrink-0" />
          <span className="hidden text-lg font-extrabold tracking-tight text-white sm:inline">InnoFlow</span>
        </Link>

        <nav aria-label="Seções da página" className="ml-4 hidden items-center gap-0.5 lg:flex">
          {NAV_ANCHORS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              {link.label}
            </a>
          ))}
          <Link
            to={CTA_LINKS.eletropostos}
            className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            Eletropostos
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {isAuthenticated && user ? (
            <Link to={accountHref} className="lnd-btn lnd-btn-lime lnd-btn-sm">
              <AccountIcon className="h-4 w-4" aria-hidden="true" />
              {accountLabel}
            </Link>
          ) : (
            <>
              <Link to={CTA_LINKS.login} className="lnd-btn lnd-btn-ghost lnd-btn-sm lnd-sm-up">
                Entrar
              </Link>
              <Link to={CTA_LINKS.cadastro} className="lnd-btn lnd-btn-lime lnd-btn-sm">
                Criar conta
              </Link>
            </>
          )}

          <div ref={menuRef} className="lg:hidden">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls="menu-secoes"
              aria-label={open ? "Fechar menu" : "Abrir menu"}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-white hover:bg-white/10"
            >
              {open ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
            </button>
            {open && (
              <nav
                id="menu-secoes"
                aria-label="Seções da página (menu)"
                className="absolute inset-x-3 top-[calc(100%+0.25rem)] rounded-2xl border border-white/15 bg-[rgb(var(--lnd-night))] p-2 shadow-2xl"
              >
                {NAV_ANCHORS.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="flex min-h-11 items-center rounded-xl px-3 text-base font-semibold text-white hover:bg-white/10"
                  >
                    {link.label}
                  </a>
                ))}
                <Link
                  to={CTA_LINKS.eletropostos}
                  className="flex min-h-11 items-center justify-between rounded-xl px-3 text-base font-semibold text-white hover:bg-white/10"
                >
                  Eletropostos
                  <ArrowRight className="h-4 w-4 text-accent-glow" aria-hidden="true" />
                </Link>
                {!isAuthenticated && (
                  <Link
                    to={CTA_LINKS.login}
                    className="mt-1 flex min-h-11 items-center rounded-xl border-t border-white/10 px-3 pt-1 text-base font-semibold text-white hover:bg-white/10 sm:hidden"
                  >
                    Entrar
                  </Link>
                )}
              </nav>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
