import type { ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./Button"

/**
 * Estado de erro de uma chamada de API — nunca deixamos uma tela quebrada em branco por uma query que falhou.
 *
 * `art` (opcional, design system unificado D3): com a arte do mascote (`<MascotFace size={64} />` de `components/brand`) o erro vira um
 * card de MARCA (superfície escura, mensagem clara, "Tentar novamente" em vidro) em vez da caixa vermelha. É um SLOT porque este componente vive
 * no chunk `ui-kit` e não pode importar o mascote. Usar em telas públicas e do motorista; o admin segue com a caixa vermelha (D3: nada de mascote em dado).
 */
export function ErrorState({
  message = "Não foi possível carregar os dados.",
  onRetry,
  className,
  art,
}: {
  message?: string
  onRetry?: () => void
  className?: string
  art?: ReactNode
}) {
  if (art) {
    return (
      <div
        role="alert"
        className={cn(
          "surface-dark flex flex-col items-center justify-center gap-3 rounded-2xl bg-gradient-to-br from-primary-950 to-primary-800 px-6 py-12 text-center shadow-tinted-card ring-1 ring-white/10",
          className,
        )}
      >
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">{art}</span>
        <p className="max-w-sm text-sm font-medium text-white">{message}</p>
        {onRetry && (
          <Button type="button" variant="glass" size="sm" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Tentar novamente
          </Button>
        )}
      </div>
    )
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-danger-100 bg-danger-50 px-6 py-14 text-center",
        className,
      )}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-100 text-danger-600" aria-hidden="true">
        <AlertTriangle className="h-6 w-6" />
      </span>
      <p className="max-w-sm text-sm font-medium text-danger-700">{message}</p>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Tentar novamente
        </Button>
      )}
    </div>
  )
}
