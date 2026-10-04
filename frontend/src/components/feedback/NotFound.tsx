import { Link } from "react-router-dom"
import { BrandBackdrop } from "@/components/brand/BrandBackdrop"
import { Mascot } from "@/components/brand/Mascot"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { cn } from "@/lib/utils"

/**
 * Página 404 de verdade (decisão D5 do dono): mascote sobre superfície escura de marca, o que aconteceu em linguagem simples e dois caminhos
 * de volta. Antes, rota inexistente redirecionava em silêncio para "/" — escondia link quebrado, inclusive QR impresso com identidade errada.
 *
 * ATENÇÃO — ainda NÃO está ligado à rota `*` (a F-A só entrega o componente; a ligação é da F-B, que reescreve de propósito o E2E
 * `landing.spec.ts` "rota inexistente continua caindo na landing" e a baseline `pub-rota-inexistente`).
 * `compact` = versão sem `min-h-screen`, para o catálogo `/__ds` e para blocos dentro de outra tela.
 */
export function NotFound({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <main
      className={cn(
        "surface-dark surface-dark-rich relative flex flex-col items-center justify-center overflow-hidden px-4 py-16 text-center",
        compact ? "rounded-2xl" : "min-h-screen",
        className,
      )}
    >
      <BrandBackdrop dots />
      <div className="relative z-10 flex flex-col items-center">
        <div className="relative mb-6">
          <div className="brand-backlight" aria-hidden="true" />
          <Mascot sizes="(min-width: 640px) 240px, 190px" className="[--m-h:220px] sm:[--m-h:280px]" />
        </div>
        <p className="eyebrow text-lime">Erro 404</p>
        <h1 className="mt-3 text-balance text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">Página não encontrada</h1>
        <p className="mt-3 max-w-md text-balance text-base leading-relaxed text-ink-soft">
          O endereço que você abriu não existe ou foi movido. Se veio de um QR code de um carregador, confira se o código impresso está correto.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link to="/" className={cn(buttonVariants({ variant: "lime", size: "lg" }))}>
            Voltar ao início
          </Link>
          <Link to="/eletropostos" className={cn(buttonVariants({ variant: "glass", size: "lg" }))}>
            Ver eletropostos
          </Link>
        </div>
      </div>
    </main>
  )
}
