import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Info, Navigation, X, Zap } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { ConnectorStatusBadge } from "@/components/connectors/ConnectorStatusBadge"
import { UpdatedAgo } from "@/components/estacoes/UpdatedAgo"
import { usePublicChargePoint } from "@/hooks/usePublicChargePoint"
import { formatDistance } from "@/lib/geo"
import { directionsLinks, freeSummaryLabel, STATION_STATE_LABELS, stationState } from "@/lib/stations"
import { CONNECTOR_TYPE_LABELS, formatPowerKw, formatTariffHeadlinePrice } from "@/lib/utils"
import type { PublicChargePoint, PublicConnector, PublicSite } from "@/types/api"

/** Conector: "Livre agora" só quando o SERVIDOR diz `isFree`; carregador offline é "Fora do ar" (o status cru mente). */
function ConnectorState({ connector, online }: { connector: PublicConnector; online: boolean }) {
  if (connector.isFree) return <Badge variant="success">Livre agora</Badge>
  if (!online) return <Badge variant="neutral">Fora do ar</Badge>
  return <ConnectorStatusBadge status={connector.status} />
}

/**
 * Um carregador do site. O PREÇO só é buscado quando o detalhe abre (esta
 * lista de sites não traz tarifa: resolver tarifa é por conector — numa
 * página de 50 sites viraria ~200 consultas, `decisoes-mapa-eletropostos.md`
 * item 8). Falha ao buscar preço não derruba nada: só some o valor.
 */
function ChargePointBlock({ chargePoint }: { chargePoint: PublicChargePoint }) {
  const { data: card } = usePublicChargePoint(chargePoint.ocppIdentity)

  return (
    <section className="rounded-2xl border border-border-subtle p-3.5" aria-label={`Carregador ${chargePoint.ocppIdentity}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-bold uppercase tracking-wide text-ink-softer">
          {chargePoint.ocppIdentity}
          {chargePoint.vendor ? ` · ${chargePoint.vendor}${chargePoint.model ? ` ${chargePoint.model}` : ""}` : ""}
        </p>
        {!chargePoint.online && <Badge variant="neutral">Fora do ar</Badge>}
      </div>
      <ul className="mt-2 divide-y divide-border-subtle">
        {chargePoint.connectors.map((c) => {
          const price = card?.connectors.find((x) => x.connectorId === c.connectorId)?.tariff
          return (
            <li key={c.id} className="flex items-center gap-3 py-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-black text-primary-700">{c.connectorId}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-ink">
                  {CONNECTOR_TYPE_LABELS[c.type]} · {formatPowerKw(c.maxPowerKw)}
                </p>
                {price && <p className="text-xs font-semibold text-ink-softer">{formatTariffHeadlinePrice(price)}</p>}
              </div>
              <ConnectorState connector={c} online={chargePoint.online} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * Detalhe da estação em bottom sheet (Radix Dialog: foco preso, Esc fecha,
 * `aria-labelledby`). Ações: "Como chegar" (Google Maps) e Waze. NÃO tem
 * "Iniciar recarga" — iniciar sessão continua só na tela vinda do QR, senão
 * dá pra ligar um carregador a 40 km e outro carro plugado lá carrega na
 * conta de quem apertou (risco de produto, `decisoes-mapa-eletropostos.md`).
 *
 * Recebe o `site` da lista viva (atualizada por SSE/polling), então os números
 * mudam com o sheet aberto.
 */
export function StationDetailSheet({
  site,
  distanceKm,
  dataUpdatedAt,
  onClose,
}: {
  site: PublicSite | undefined
  distanceKm?: number | null
  dataUpdatedAt: number
  onClose: () => void
}) {
  const state = site ? stationState(site) : "offline"
  const links = site ? directionsLinks(site) : null

  return (
    <DialogPrimitive.Root open={!!site} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-scrim fixed inset-0 z-50 animate-fade-in" />
        {site && links && (
          <DialogPrimitive.Content
            aria-describedby="station-sheet-desc"
            className="animate-sheet-up fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-[var(--radius-feature)] bg-surface px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 shadow-lg focus-visible:outline-none"
          >
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border-strong" aria-hidden="true" />
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="text-lg font-black tracking-tight text-ink">{site.name}</DialogPrimitive.Title>
                <p id="station-sheet-desc" className="mt-0.5 text-sm text-ink-softer">
                  {site.addressLine} — {site.city}/{site.state}
                  {distanceKm !== null && distanceKm !== undefined && <> · {formatDistance(distanceKm)} em linha reta</>}
                </p>
              </div>
              <DialogPrimitive.Close
                className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-softer hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label="Fechar"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge variant={state === "free" ? "success" : state === "busy" ? "warning" : "neutral"}>
                <Zap className="h-3 w-3" aria-hidden="true" />
                {STATION_STATE_LABELS[state]}
              </Badge>
              <span className="text-sm font-semibold text-ink-soft">{freeSummaryLabel(site.connectorSummary)}</span>
              <UpdatedAgo dataUpdatedAt={dataUpdatedAt} className="text-xs text-ink-softer" />
            </div>

            <div className="mt-4 space-y-3">
              {site.chargePoints.length === 0 && <p className="text-sm text-ink-softer">Nenhum carregador ativo neste eletroposto.</p>}
              {site.chargePoints.map((cp) => (
                <ChargePointBlock key={cp.id} chargePoint={cp} />
              ))}
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2.5">
              <a
                href={links.google}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "lime", className: "min-h-12" })}
              >
                <Navigation className="h-4 w-4" aria-hidden="true" />
                Como chegar
                <span className="sr-only"> (abre o Google Maps)</span>
              </a>
              <a
                href={links.waze}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "outline", className: "min-h-12" })}
              >
                Waze
                <span className="sr-only"> (abre o Waze)</span>
              </a>
            </div>

            <p className="mt-4 flex items-start gap-2 rounded-xl bg-muted/60 p-3 text-xs leading-relaxed text-ink-softer">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Mostramos a disponibilidade de agora — não é possível reservar. Para carregar, escaneie o QR code no carregador.</span>
            </p>
          </DialogPrimitive.Content>
        )}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
