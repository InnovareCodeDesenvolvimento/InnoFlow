import { MapPin, Navigation, Zap } from "lucide-react"
import { Card } from "@/components/ui/Card"
import { Badge } from "@/components/ui/Badge"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { formatDistance } from "@/lib/geo"
import { connectorGroupLabel, directionsLinks, freeSummaryLabel, STATION_STATE_LABELS, stationState, type StationState } from "@/lib/stations"
import { cn } from "@/lib/utils"
import type { PublicSite } from "@/types/api"

const STATE_BADGE: Record<StationState, "success" | "warning" | "neutral"> = {
  free: "success",
  busy: "warning",
  offline: "neutral",
}

/**
 * Card da estação — o MESMO na lista pública (`Eletropostos`), na aba Mapa e
 * no "Perto de você" (evoluído, não duplicado: `decisoes-mapa-eletropostos.md`
 * item 1). Os números "x de y livres" vêm do `connectorSummary` do servidor
 * (regra única de `isFree`); antes este card contava `status === AVAILABLE` e
 * mostrava "Disponível" pra conector de carregador OFFLINE.
 *
 * Ação primária: "Como chegar" (deep link). NÃO há "Iniciar recarga" aqui — só
 * na tela vinda do QR (senão dá pra iniciar sessão num carregador a 40 km).
 *
 * Com `onSelect`, a área de informação vira um botão (abre o detalhe) — o
 * "Como chegar" fica FORA dele (link dentro de botão é HTML inválido).
 */
export function PublicSiteCard({
  site,
  distanceKm,
  selected = false,
  onSelect,
  className,
}: {
  site: PublicSite
  distanceKm?: number | null
  selected?: boolean
  onSelect?: () => void
  className?: string
}) {
  const state = stationState(site)
  const { total, free, groups } = site.connectorSummary
  const links = directionsLinks(site)

  const info = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-ink">{site.name}</h3>
          <p className="mt-1 flex items-start gap-1.5 text-sm text-ink-softer">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              {site.addressLine} — {site.city}/{site.state}
            </span>
          </p>
        </div>
        {distanceKm !== null && distanceKm !== undefined && (
          <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-black tabular-nums text-primary-700" title="Distância em linha reta">
            {formatDistance(distanceKm)}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Badge variant={STATE_BADGE[state]}>
          <Zap className="h-3 w-3" aria-hidden="true" />
          {STATION_STATE_LABELS[state]}
        </Badge>
        <span className="text-sm font-semibold text-ink-soft">{freeSummaryLabel({ total, free })}</span>
      </div>

      {groups.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {groups.map((g) => (
            <Badge key={`${g.type}-${g.maxPowerKw}`} variant={g.free > 0 ? "primary" : "neutral"} className="normal-case">
              {connectorGroupLabel(g)}
            </Badge>
          ))}
        </div>
      )}
    </>
  )

  return (
    <Card
      data-station-id={site.id}
      data-state={state}
      // `outline`, não `ring`: o `ring-1` do card já ocupa o box-shadow; o destaque da seleção é um contorno.
      className={cn("transition-shadow", selected && "outline outline-2 outline-primary", className)}
    >
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          aria-label={`${site.name}: ver detalhes`}
          className="press block w-full rounded-t-[1.25rem] p-5 pb-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {info}
        </button>
      ) : (
        <div className="p-5 pb-3">{info}</div>
      )}

      <div className="px-5 pb-5">
        <a
          href={links.google}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "outline", className: "min-h-11 w-full" })}
        >
          <Navigation className="h-4 w-4" aria-hidden="true" />
          Como chegar
          <span className="sr-only"> em {site.name} (abre o Google Maps)</span>
        </a>
      </div>
    </Card>
  )
}
