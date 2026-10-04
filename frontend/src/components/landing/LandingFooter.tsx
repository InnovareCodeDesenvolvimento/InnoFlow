import { Link } from "react-router-dom"
import logoIcon from "@/assets/landing/logo-icon-96.webp"
// Versão de 72 px de altura (2x do que aparece, 36 px) em webp: o PNG original (616x405, 100 KB) era baixado inteiro porque o
// rodapé fica dentro da distância do `loading="lazy"` numa página curta.
import innovareLogo from "@/assets/landing/innovarecode-h72.webp"
import { DESENVOLVEDORA, DESENVOLVEDORA_URL, VERSAO_EXIBIDA } from "@/lib/appInfo"
import { CTA_LINKS, NAV_ANCHORS, SLOGAN } from "./landing-data"

/**
 * Rodapé da landing: marca, atalhos das seções e a assinatura da desenvolvedora (Innovare Code). Sem redes
 * sociais, telefone ou e-mail: o produto não tem canal público de contato definido — os caminhos são Criar conta e
 * Entrar. O logotipo da Innovare Code é azul/cinza (feito para fundo claro), por isso vive numa placa branca.
 */
export function LandingFooter() {
  return (
    <footer className="lnd-dark-flat border-t border-white/10 pb-8 pt-14">
      <div className="mx-auto grid max-w-[1400px] gap-10 px-4 sm:px-6 md:grid-cols-[1.3fr_1fr_1fr] lg:px-8">
        <div>
          <Link to="/" className="inline-flex items-center gap-2.5 rounded-lg" aria-label="InnoFlow, início">
            <img src={logoIcon} alt="" width={36} height={36} className="h-9 w-9" />
            <span className="text-lg font-extrabold tracking-tight text-white">InnoFlow</span>
          </Link>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-white/75">{SLOGAN}. Plataforma de recarga de veículos elétricos para motoristas e operadores de eletropostos.</p>
        </div>

        <nav aria-label="Atalhos do rodapé">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent-glow">Na página</p>
          <ul className="mt-3 space-y-1">
            {NAV_ANCHORS.map((l) => (
              <li key={l.href}>
                <a href={l.href} className="inline-flex min-h-9 items-center text-sm font-medium text-white/80 hover:text-white">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="Acesso">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent-glow">Acesso</p>
          <ul className="mt-3 space-y-1">
            {[
              [CTA_LINKS.eletropostos, "Ver eletropostos"],
              [CTA_LINKS.cadastro, "Criar conta"],
              [CTA_LINKS.login, "Entrar"],
            ].map(([to, label]) => (
              <li key={to}>
                <Link to={to} className="inline-flex min-h-9 items-center text-sm font-medium text-white/80 hover:text-white">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="mx-auto mt-12 flex max-w-[1400px] flex-col items-start justify-between gap-5 border-t border-white/10 px-4 pt-6 sm:flex-row sm:items-center sm:px-6 lg:px-8">
        <p className="text-xs text-white/65">
          © {new Date().getFullYear()} InnoFlow. Todos os direitos reservados. <span className="tabular-nums">{VERSAO_EXIBIDA}</span>
        </p>
        <a
          href={DESENVOLVEDORA_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Desenvolvido por ${DESENVOLVEDORA} (abre em nova aba)`}
          className="flex items-center gap-3 rounded-xl bg-white px-3.5 py-2 shadow-lg transition-transform hover:-translate-y-0.5"
        >
          <span className="text-[10px] font-bold uppercase tracking-widest text-ink-softer">Desenvolvido por</span>
          <img src={innovareLogo} alt="" width={110} height={72} loading="lazy" decoding="async" className="h-9 w-auto" />
        </a>
      </div>
    </footer>
  )
}
