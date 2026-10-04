import { Link } from "react-router-dom"
import { Logo } from "@/components/brand/Logo"

/**
 * Rodapé do site público: mesma moldura escura do rodapé da landing (degradê petróleo -> noite). Minimalista de propósito — sem inventar canais
 * de contato ou redes sociais que não existem ainda, e SEM links repetidos do cabeçalho ("Eletropostos" etc.): os E2E procuram esses links por nome.
 */
export function Footer() {
  return (
    <footer className="surface-dark mt-16 border-t border-white/10">
      <div className="container-app flex flex-col items-center justify-between gap-4 py-8 sm:flex-row">
        <Link to="/" className="flex items-center gap-2" aria-label="InnoFlow, início">
          <Logo tone="dark" size={32} />
        </Link>
        <p className="text-xs text-ink-softer">© {new Date().getFullYear()} InnoFlow. Carregue um futuro melhor.</p>
      </div>
    </footer>
  )
}
