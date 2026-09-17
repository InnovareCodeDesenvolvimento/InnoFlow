import { Link } from "react-router-dom"
import logoIcon from "@/assets/logo-icon.png"

/** Rodapé do site público. Minimalista de propósito — sem inventar canais de contato ou redes sociais que não existem ainda. */
export function Footer() {
  return (
    <footer className="mt-16 border-t border-border-subtle bg-surface">
      <div className="container-app flex flex-col items-center justify-between gap-4 py-8 sm:flex-row">
        <Link to="/" className="flex items-center gap-2 font-black tracking-tight text-ink">
          <img src={logoIcon} alt="" className="h-8 w-8 shrink-0" />
          InnoFlow
        </Link>
        <p className="text-xs text-ink-softer">© {new Date().getFullYear()} InnoFlow. Carregue um futuro melhor.</p>
      </div>
    </footer>
  )
}
