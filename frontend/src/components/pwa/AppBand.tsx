import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Faixa de moldura escura das telas do app do motorista (D1: escuro emoldura, claro é onde se lê). Continua o cabeçalho do shell sem emenda: ele é
 * sólido na cor de topo do degradê (`primary-950`, a mesma do `theme_color` do manifesto) e a faixa começa nela e desce até `night`.
 *
 *  - `back`: link "voltar" no topo (texto branco em escuro). O nome acessível é o próprio texto, igual ao de antes.
 *  - `children`: título, descrição, o herói da tela (saldo, painel ao vivo) — tudo que vive sobre escuro. Os componentes de `ui` trocam de tom sozinhos
 *    dentro de `.surface-dark` (Input, Badge, Skeleton, texto `ink-*`).
 *  - `overlap`: quanto o miolo claro sobe por cima da faixa (cartões "flutuando" sobre a fronteira). Sem isso a faixa termina reta com cantos
 *    arredondados. O conteúdo da página é responsável por aplicar o `-mt-*` equivalente no primeiro bloco claro.
 */
export function AppBand({
  back,
  children,
  className,
  wide = false,
}: {
  back?: { to: string; label: string }
  children: ReactNode
  className?: string
  /** Mesma largura do miolo da página: `true` só no mapa (que usa `lg:max-w-6xl`). */
  wide?: boolean
}) {
  return (
    <div className={cn("surface-dark surface-dark-rich relative overflow-hidden rounded-b-[2rem] px-4 pb-8 pt-4", className)}>
      <div className={cn("mx-auto max-w-md", wide && "lg:max-w-6xl")}>
        {back && (
          <Link to={back.to} className="mb-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-ink-softer hover:text-white">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {back.label}
          </Link>
        )}
        {children}
      </div>
    </div>
  )
}
