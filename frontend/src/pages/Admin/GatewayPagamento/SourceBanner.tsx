import { Database, Info } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { formatDateTime } from "@/lib/utils"
import type { PaymentGatewayConfigDTO } from "@/types/api"

/**
 * Origem dos valores efetivos: `env` = nada salvo ainda (vale o ambiente do
 * servidor; a 1ª gravação semeia a linha com o ambiente atual e com os meios
 * que já têm credencial habilitados — não desliga nada); `database` =
 * configuração salva aqui, com data/hora.
 */
export function SourceBanner({ source, updatedAt }: Pick<PaymentGatewayConfigDTO, "source" | "updatedAt">) {
  if (source === "env") {
    return (
      <Alert tone="info" role="status" icon={Info} data-testid="source-banner-env">
        <p>
          <span className="font-bold">Usando as variáveis do servidor.</span> Na primeira gravação, a configuração nasce com o ambiente atual e com &quot;habilitado&quot; nos meios que já têm
          credencial no servidor — salvar não desliga o que já funcionava. Daí em diante, vale o que for salvo aqui.
        </p>
      </Alert>
    )
  }
  return (
    <Alert tone="neutral" role="status" icon={Database} iconClassName="text-primary" data-testid="source-banner-database">
      <p>
        <span className="font-bold text-ink">Configuração salva nesta tela.</span> Última alteração em {formatDateTime(updatedAt)}.
      </p>
    </Alert>
  )
}
