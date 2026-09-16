import { Badge } from "@/components/ui/Badge"
import { CONNECTOR_STATUS_LABELS } from "@/lib/utils"
import type { ConnectorStatus } from "@/types/api"

/**
 * Cor por status do conector — o mesmo vocabulário visual em toda a app
 * (listagem admin e listagem pública), para não reinventar "o que cada cor
 * significa" em dois lugares.
 */
const VARIANT_BY_STATUS: Record<ConnectorStatus, "success" | "primary" | "warning" | "info" | "neutral" | "danger"> = {
  AVAILABLE: "success",
  CHARGING: "primary",
  PREPARING: "warning",
  FINISHING: "warning",
  SUSPENDED_EVSE: "warning",
  SUSPENDED_EV: "warning",
  RESERVED: "info",
  UNAVAILABLE: "neutral",
  FAULTED: "danger",
}

export function ConnectorStatusBadge({ status }: { status: ConnectorStatus }) {
  return <Badge variant={VARIANT_BY_STATUS[status]}>{CONNECTOR_STATUS_LABELS[status]}</Badge>
}
