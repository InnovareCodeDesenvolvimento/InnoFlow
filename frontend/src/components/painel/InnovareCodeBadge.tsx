import { APP_VERSION, BUILD_DATE, DESENVOLVEDORA, DESENVOLVEDORA_URL, VERSAO_EXIBIDA } from "@/lib/appInfo"
import { cn } from "@/lib/utils"

/**
 * Selo da desenvolvedora — vive numa faixa de rodapé própria do shell do
 * painel (`Admin/Layout.tsx`), fora da área que rola (`<main>`). NÃO é mais
 * `fixed`: chegou a ser (mesmo padrão do projeto irmão ParquedasFeiras), mas
 * `position: fixed` no canto da tela sobrepunha conteúdo real sempre que a
 * altura da página coincidia com aquele retângulo — tanto ao rolar até o fim
 * de uma tabela longa quanto, sem rolar nada, em telas curtas (Dashboard,
 * Sessões) cujo conteúdo já nascia perto da altura da viewport. Um rodapé
 * estrutural resolve por construção (caixas empilhadas em flex-col nunca se
 * sobrepõem) em vez de tentar calcular padding suficiente. Achado real,
 * revisão premium do painel, 17/09/2026.
 *
 * Continua discreto de propósito: translúcido em repouso, opaco no hover.
 */
export function InnovareCodeBadge({ className }: { className?: string }) {
  return (
    <a
      href={DESENVOLVEDORA_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-center gap-2 rounded-xl px-2 py-1 transition-colors hover:bg-muted/60",
        className,
      )}
      aria-label={`Desenvolvido por ${DESENVOLVEDORA} — versão ${APP_VERSION}`}
      title={`Desenvolvido por ${DESENVOLVEDORA} · v${APP_VERSION} (build ${BUILD_DATE})`}
    >
      <img
        src="/brand/innovarecode.png"
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        className="h-6 w-auto sm:h-7"
      />
      <span className="hidden flex-col leading-none sm:flex">
        <span className="text-[8px] font-bold uppercase tracking-widest text-ink-softer">Desenvolvido por</span>
        <span className="text-[11px] font-black tracking-tight text-ink">{DESENVOLVEDORA}</span>
      </span>
      {/* A versão vive aqui, junto do selo — duas fontes para a mesma
          informação viram duas versões divergentes. */}
      <span className="rounded-lg bg-muted px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-ink-soft">
        {VERSAO_EXIBIDA}
      </span>
    </a>
  )
}
