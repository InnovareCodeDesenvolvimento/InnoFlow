import { AlertTriangle, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./Button"

/** Estado de erro de uma chamada de API — nunca deixamos uma tela quebrada em branco por uma query que falhou. */
export function ErrorState({
  message = "Não foi possível carregar os dados.",
  onRetry,
  className,
}: {
  message?: string
  onRetry?: () => void
  className?: string
}) {
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
