import { Link } from "react-router-dom"
import { BrandBackdrop } from "@/components/brand/BrandBackdrop"
import { Mascot } from "@/components/brand/Mascot"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { cn } from "@/lib/utils"

/**
 * Erro de tela inteira: o que quebrou a rota (chunk que não baixou, exceção na renderização). Mostra o mascote, uma frase humana e duas saídas
 * ("Tentar de novo" recarrega a tela, "Voltar ao início"). A mensagem técnica NUNCA vai para o usuário em produção (só em dev, para depurar).
 *
 * Só a VISÃO: o error boundary é `RouteError.tsx` (sem imports pesados, vive no bundle inicial) e carrega esta tela sob demanda — assim o caminho
 * crítico da landing não paga mascote, botões nem ui-kit só para ter um boundary.
 */
export function RouteErrorView({ error, onRetry, compact = false, className }: { error?: unknown; onRetry?: () => void; compact?: boolean; className?: string }) {
  const detail = import.meta.env.DEV && error instanceof Error ? error.message : null
  return (
    <main
      role="alert"
      className={cn(
        "surface-dark surface-dark-rich relative flex flex-col items-center justify-center overflow-hidden px-4 py-16 text-center",
        compact ? "rounded-2xl" : "min-h-screen",
        className,
      )}
    >
      <BrandBackdrop />
      <div className="relative z-10 flex flex-col items-center">
        <div className="relative mb-6">
          <div className="brand-backlight" aria-hidden="true" />
          <Mascot sizes="(min-width: 640px) 240px, 190px" className="[--m-h:200px] sm:[--m-h:260px]" />
        </div>
        <p className="eyebrow text-lime">Algo deu errado</p>
        <h1 className="mt-3 text-balance text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">Não foi possível abrir esta tela</h1>
        <p className="mt-3 max-w-md text-balance text-base leading-relaxed text-ink-soft">
          Foi um problema do nosso lado ou da sua conexão. Tente de novo; se continuar, volte ao início e tente mais tarde.
        </p>
        {detail && <p className="mt-3 max-w-md break-words rounded-lg bg-white/5 px-3 py-2 font-mono text-xs text-ink-softer">{detail}</p>}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={onRetry ?? (() => window.location.reload())} className={cn(buttonVariants({ variant: "lime", size: "lg" }))}>
            Tentar de novo
          </button>
          <Link to="/" className={cn(buttonVariants({ variant: "glass", size: "lg" }))}>
            Voltar ao início
          </Link>
        </div>
      </div>
    </main>
  )
}
