import { APP_VERSION, BUILD_DATE, DESENVOLVEDORA, DESENVOLVEDORA_URL, VERSAO_EXIBIDA } from "@/lib/appInfo"
import { cn } from "@/lib/utils"

/**
 * Selo da desenvolvedora no canto inferior direito dos painéis.
 *
 * Fica fixo na tela porque a assinatura em texto do rodapé só aparece depois
 * de rolar a página inteira — em listagem longa o operador nunca chega lá.
 *
 * Discreto de propósito: translúcido em repouso, opaco no hover. Ele divide o
 * canto com conteúdo real (paginação, botões de ação das listagens), então
 * não pode brigar por atenção nem cobrir nada — daí o tamanho pequeno e o
 * recuo maior no celular, onde a área útil é menor.
 *
 * Mesmo componente do projeto irmão ParquedasFeiras
 * (`frontend/src/components/painel/InnovareCodeBadge.tsx` lá) — porta 1:1
 * o padrão visual, só trocando a paleta pelos tokens do InnoElektron.
 */
export function InnovareCodeBadge({ className }: { className?: string }) {
  return (
    <a
      href={DESENVOLVEDORA_URL}
      target="_blank"
      rel="noopener noreferrer"
      // `pointer-events-none` no contêiner e `auto` no conteúdo: o selo é
      // clicável, mas o espaço em volta dele não intercepta clique de quem
      // está usando o que estiver embaixo.
      className={cn(
        "pointer-events-auto fixed bottom-4 right-4 z-40 flex items-center gap-2",
        "rounded-2xl bg-white/85 px-2.5 py-1.5 shadow-lg ring-1 ring-border-subtle backdrop-blur-md",
        "opacity-70 transition-all hover:-translate-y-0.5 hover:opacity-100 hover:shadow-xl",
        "sm:bottom-6 sm:right-6",
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
        className="h-7 w-auto sm:h-8"
      />
      <span className="hidden flex-col leading-none sm:flex">
        <span className="text-[8px] font-bold uppercase tracking-widest text-ink-subtle">Desenvolvido por</span>
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
