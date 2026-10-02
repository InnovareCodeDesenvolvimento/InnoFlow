import { Database, Info } from "lucide-react"
import { formatDateTime } from "@/lib/utils"
import type { PaymentGatewayConfigDTO } from "@/types/api"

/**
 * Origem dos valores efetivos: `env` = nada salvo ainda (vale o ambiente do
 * servidor — aviso informativo de que salvar passa a mandar); `database` =
 * configuração salva aqui, com data/hora.
 */
export function SourceBanner({ source, updatedAt }: Pick<PaymentGatewayConfigDTO, "source" | "updatedAt">) {
  if (source === "env") {
    return (
      <div role="status" className="flex items-start gap-3 rounded-xl border border-info-600/30 bg-info-50 p-4 text-info-700" data-testid="source-banner-env">
        <Info className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <p className="min-w-0 text-sm">
          <span className="font-bold">Usando as variáveis do servidor.</span> Ao salvar, passa a valer o que for salvo aqui.
        </p>
      </div>
    )
  }
  return (
    <div role="status" className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-ink-soft" data-testid="source-banner-database">
      <Database className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 text-sm">
        <span className="font-bold text-ink">Configuração salva nesta tela.</span> Última alteração em {formatDateTime(updatedAt)}.
      </p>
    </div>
  )
}
