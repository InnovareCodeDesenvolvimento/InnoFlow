import { Link } from "react-router-dom"
import { ChevronRight, MapPin, Zap } from "lucide-react"
import { IconBadge } from "@/components/ui/IconBadge"
import { LocationPrompt } from "@/components/estacoes/LocationPrompt"
import { UpdatedAgo } from "@/components/estacoes/UpdatedAgo"
import { Skeleton } from "@/components/ui/Skeleton"
import { useGeolocation } from "@/hooks/useGeolocation"
import { useStations } from "@/hooks/useStations"
import { formatDistance } from "@/lib/geo"
import { freeSummaryLabel, STATION_STATE_LABELS, stationState, type StationState } from "@/lib/stations"
import { cn } from "@/lib/utils"

const DOT: Record<StationState, string> = {
  free: "bg-accent-600",
  busy: "bg-warning-700",
  offline: "bg-state-off",
}

/**
 * "Perto de você" da Home (3 mais próximos, com distância e "x de y livres").
 * Sem posição: só o convite — ele NÃO dispara o pedido sozinho e a query
 * nem roda (nenhuma requisição de estações sem posição na Home). A posição
 * fica em memória (`store/geoStore.ts`), compartilhada com a aba Mapa.
 */
export function NearbyStationsSection() {
  const geo = useGeolocation()
  const hasPosition = geo.position !== null
  const { sites, isLoading, isError, dataUpdatedAt } = useStations({ position: geo.position, enabled: hasPosition })
  const nearest = sites.slice(0, 3)

  return (
    <section aria-labelledby="perto-de-voce" className="stagger-2 animate-fade-in-up">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="perto-de-voce" className="text-sm font-bold text-ink">
          Perto de você
        </h2>
        <Link to="/app/mapa" className="flex min-h-11 items-center text-xs font-semibold text-primary hover:underline">
          Ver mapa
        </Link>
      </div>

      {!hasPosition && (
        <div className="space-y-2">
          <LocationPrompt status={geo.status} hasPosition={false} onRequest={geo.request} />
          <Link to="/app/mapa" className="flex min-h-11 items-center justify-center gap-1.5 text-xs font-semibold text-primary hover:underline">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            Ou busque por cidade ou endereço
          </Link>
        </div>
      )}

      {hasPosition && isLoading && (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-16 rounded-2xl" />
          <Skeleton className="h-16 rounded-2xl" />
        </div>
      )}

      {hasPosition && isError && <p className="rounded-2xl bg-muted px-4 py-5 text-center text-xs text-ink-softer">Não foi possível carregar os eletropostos agora.</p>}

      {hasPosition && !isLoading && !isError && nearest.length === 0 && (
        <p className="rounded-2xl bg-muted px-4 py-5 text-center text-xs text-ink-softer">
          Nenhum eletroposto num raio de cerca de 30 km.{" "}
          <Link to="/app/mapa" className="font-semibold text-primary hover:underline">
            Ver todos
          </Link>
        </p>
      )}

      {hasPosition && !isLoading && !isError && nearest.length > 0 && (
        <>
          <ul className="space-y-2">
            {nearest.map((site) => {
              const state = stationState(site)
              return (
                <li key={site.id}>
                  <Link
                    to="/app/mapa"
                    state={{ stationId: site.id }}
                    data-station-id={site.id}
                    data-state={state}
                    className="card-elevated pressable flex min-h-14 items-center gap-3 p-3.5 transition-colors hover:ring-primary/30"
                  >
                    <IconBadge icon={Zap} size="lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">{site.name}</p>
                      <p className="flex items-center gap-1.5 text-xs text-ink-softer">
                        <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[state])} aria-hidden="true" />
                        <span className="sr-only">{STATION_STATE_LABELS[state]}: </span>
                        {freeSummaryLabel(site.connectorSummary)}
                      </p>
                    </div>
                    {site.distanceKm !== null && <span className="shrink-0 text-sm font-black tabular-nums text-primary-700">{formatDistance(site.distanceKm)}</span>}
                    <ChevronRight className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  </Link>
                </li>
              )
            })}
          </ul>
          <div className="mt-1.5 flex justify-end">
            <UpdatedAgo dataUpdatedAt={dataUpdatedAt} className="text-[11px] text-ink-softer" />
          </div>
        </>
      )}
    </section>
  )
}
