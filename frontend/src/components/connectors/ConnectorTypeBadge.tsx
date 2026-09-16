import { Badge } from "@/components/ui/Badge"
import { CONNECTOR_TYPE_LABELS, formatPowerKw } from "@/lib/utils"
import type { ConnectorType } from "@/types/api"

/**
 * Tipo do conector + potência juntos — é a decisão pedida no escopo:
 * motorista e operador decidem com base nos dois ao mesmo tempo, não só o tipo.
 */
export function ConnectorTypeBadge({ type, maxPowerKw }: { type: ConnectorType; maxPowerKw?: string | number | null }) {
  return (
    <Badge variant="primary">
      {CONNECTOR_TYPE_LABELS[type]}
      {maxPowerKw !== undefined && maxPowerKw !== null && <span className="normal-case">· {formatPowerKw(maxPowerKw)}</span>}
    </Badge>
  )
}
