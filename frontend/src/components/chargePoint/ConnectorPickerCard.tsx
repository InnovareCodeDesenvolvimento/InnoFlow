import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { CONNECTOR_TYPE_LABELS, formatPowerKw, landingConnectorStatus } from "@/lib/utils"
import type { PublicChargePointConnector } from "@/types/api"

/** Um card grande e tocável por conector — usado quando o carregador escaneado tem mais de um conector (adesivo por conector, mas o QR aponta só pro `ocppIdentity`). */
export function ConnectorPickerCard({ ocppIdentity, connector }: { ocppIdentity: string; connector: PublicChargePointConnector }) {
  const status = landingConnectorStatus(connector.status !== "FAULTED" && connector.status !== "UNAVAILABLE", connector.status)
  return (
    <Link
      to={`/c/${encodeURIComponent(ocppIdentity)}/${connector.connectorId}`}
      className="press flex min-h-[64px] items-center gap-4 rounded-card border border-border-subtle bg-surface p-4 shadow-card hover:border-primary/40 active:bg-primary-50"
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg font-black text-primary-700">
        {connector.connectorId}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-ink">
          {CONNECTOR_TYPE_LABELS[connector.type]} · {formatPowerKw(connector.maxPowerKw)}
        </p>
        <Badge variant={status.variant} className="mt-1">
          {status.label}
        </Badge>
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-ink-subtle" aria-hidden="true" />
    </Link>
  )
}
