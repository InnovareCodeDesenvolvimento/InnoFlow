import { WifiOff } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { ConnectorStatusBadge } from "@/components/connectors/ConnectorStatusBadge"
import { CONNECTOR_TYPE_LABELS, formatPowerKw } from "@/lib/utils"
import { CHARGE_POINT_OFFLINE_NOTICE, isConnectorStartable } from "@/lib/remoteStart"
import type { Connector } from "@/types/api"
import { RadioRow } from "./RadioRow"

/**
 * Escolha do conector. Lista TODOS (para o suporte ver por que um não serve), mas só os livres (`isConnectorStartable`) são selecionáveis; os outros ficam
 * desabilitados com o status escrito. Sem nenhum livre: aviso (o POST nem é tentado). Carregador OFFLINE (`ChargePoint.online === false`): NENHUM é escolhível, e o
 * aviso de offline toma o lugar do "nenhum livre" (o motivo real é o offline, não o status dos conectores).
 */
export function ConnectorChoice({
  connectors,
  value,
  onChange,
  error,
  offline = false,
}: {
  connectors: Connector[]
  /** `connectorId` OCPP (1, 2…) escolhido, ou `null`. */
  value: number | null
  onChange: (connectorId: number) => void
  error?: string
  offline?: boolean
}) {
  const sorted = [...connectors].sort((a, b) => a.connectorId - b.connectorId)
  const startableNow = (status: Connector["status"]) => !offline && isConnectorStartable(status)
  const anyStartable = sorted.some((c) => startableNow(c.status))

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 block text-sm font-medium text-ink-soft">
        Conector <span className="text-danger">*</span>
      </legend>
      {sorted.length === 0 && (
        <Alert tone="muted" size="sm" role="status">
          Este carregador não tem conectores cadastrados.
        </Alert>
      )}
      {offline && (
        <Alert tone="warning" size="sm" icon={WifiOff} role="status" data-testid="remote-start-offline">
          {CHARGE_POINT_OFFLINE_NOTICE}
        </Alert>
      )}
      {sorted.length > 0 && !offline && !anyStartable && (
        <Alert tone="warning" size="sm" role="status">
          Nenhum conector está livre agora. Só dá para iniciar uma recarga em conector disponível.
        </Alert>
      )}
      <div className="space-y-2">
        {sorted.map((c) => {
          const startable = startableNow(c.status)
          return (
            <RadioRow key={c.id} name="remote-start-connector" value={String(c.connectorId)} checked={value === c.connectorId} disabled={!startable} onChange={() => onChange(c.connectorId)}>
              <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="font-semibold">
                  Conector {c.connectorId}
                  <span className="font-normal text-ink-softer">
                    {" "}
                    · {CONNECTOR_TYPE_LABELS[c.type]}
                    {c.maxPowerKw !== null && c.maxPowerKw !== undefined ? ` · ${formatPowerKw(c.maxPowerKw)}` : ""}
                  </span>
                </span>
                <ConnectorStatusBadge status={c.status} />
              </span>
            </RadioRow>
          )
        })}
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </fieldset>
  )
}
