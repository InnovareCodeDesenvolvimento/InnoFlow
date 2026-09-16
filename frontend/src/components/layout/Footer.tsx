import { Link } from "react-router-dom"
import { Zap } from "lucide-react"

/** Rodapé do site público. Minimalista de propósito — sem inventar canais de contato ou redes sociais que não existem ainda. */
export function Footer() {
  return (
    <footer className="mt-16 border-t border-border-subtle bg-surface">
      <div className="container-app flex flex-col items-center justify-between gap-4 py-8 sm:flex-row">
        <Link to="/" className="flex items-center gap-2 font-black tracking-tight text-ink">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white">
            <Zap className="h-4 w-4" aria-hidden="true" />
          </span>
          InnoElektron
        </Link>
        <p className="text-xs text-ink-softer">© {new Date().getFullYear()} InnoElektron. Plataforma de eletropostos.</p>
      </div>
    </footer>
  )
}
