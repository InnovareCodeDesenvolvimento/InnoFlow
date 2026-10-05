import { lazy, Suspense, useState } from "react"
import { useLocation } from "react-router-dom"
import { List, Map as MapIcon, MapPin, Search } from "lucide-react"
import { MascotFace } from "@/components/brand/Mascot"
import { AppBand } from "@/components/pwa/AppBand"
import { Button } from "@/components/ui/Button"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Input } from "@/components/ui/Input"
import { Segmented } from "@/components/ui/Segmented"
import { Skeleton } from "@/components/ui/Skeleton"
import { LocationPrompt } from "@/components/estacoes/LocationPrompt"
import { StationDetailSheet } from "@/components/estacoes/StationDetailSheet"
import { UpdatedAgo } from "@/components/estacoes/UpdatedAgo"
import { PublicSiteCard } from "@/components/sites/PublicSiteCard"
import { useGeolocation } from "@/hooks/useGeolocation"
import { useMediaQuery } from "@/hooks/useMediaQuery"
import { useStations } from "@/hooks/useStations"
import { getApiErrorMessage } from "@/services/api"
import { NEARBY_RADIUS_KM } from "@/lib/geo"
import type { StationSort } from "@/lib/stations"

// Leaflet só é baixado quando o mapa é de fato mostrado (aba "Mapa" no mobile,
// sempre visível a partir de `lg`) — nunca no bundle inicial nem em chunk de
// outra rota. A LISTA é a experiência primária.
const StationsMap = lazy(() => import("@/components/estacoes/StationsMap"))

const SORT_OPTIONS: Array<{ value: StationSort; label: string }> = [
  { value: "distance", label: "Mais próximos" },
  { value: "connectors", label: "Mais conectores" },
  { value: "name", label: "Nome" },
]

type View = "list" | "map"

/**
 * `/app/mapa` — eletropostos perto de mim. Lista primária + mapa secundário.
 * "Livre agora" é o estado de AGORA (carimbo "atualizado há Xs"), nunca uma
 * promessa pra quando o motorista chegar: não existe reserva. A ação primária
 * é "Como chegar"; iniciar recarga continua só na tela do QR.
 */
export function Mapa() {
  const location = useLocation()
  const geo = useGeolocation()
  const isDesktop = useMediaQuery("(min-width: 1024px)")

  const [query, setQuery] = useState("")
  const [sortChoice, setSortChoice] = useState<StationSort | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [view, setView] = useState<View>("list")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Vindo do "Perto de você" da Home: abre o detalhe da estação tocada (por `state` de navegação — não vai pra URL).
  const [detailId, setDetailId] = useState<string | null>((location.state as { stationId?: string } | null)?.stationId ?? null)

  const { sites, isLoading, isError, error, refetch, dataUpdatedAt, scope, sort } = useStations({
    position: geo.position,
    query,
    sort: sortChoice ?? undefined,
    showAll,
  })

  const hasPosition = geo.position !== null
  const searching = query.trim() !== ""
  const showList = isDesktop || view === "list"
  const selected = sites.find((s) => s.id === selectedId)
  const detail = sites.find((s) => s.id === detailId)

  const selectFromCard = (id: string) => {
    setSelectedId(id)
    setDetailId(id)
  }

  const selectFromMap = (id: string) => {
    setSelectedId(id)
    // No desktop a lista está ao lado: leva o card destacado pra dentro da área visível.
    if (isDesktop) {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
      document.querySelector(`[data-station-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" })
    }
  }

  const list = (
    <div className="space-y-3" aria-live="polite">
      {isLoading && (
        <div className="space-y-3" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-[1.25rem]" />
          ))}
        </div>
      )}

      {isError && <ErrorState tone="page" art={<MascotFace size={64} />} message={getApiErrorMessage(error, "Não foi possível carregar os eletropostos.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && sites.length === 0 && (
        <EmptyState
          tone="quiet"
          icon={MapPin}
          title={searching ? "Nada encontrado" : scope === "nearby" ? "Nenhum eletroposto por perto" : "Nenhum eletroposto cadastrado"}
          description={
            searching
              ? "Tente outra cidade, bairro ou parte do endereço."
              : scope === "nearby"
                ? `Não há eletropostos num raio de cerca de ${NEARBY_RADIUS_KM} km da sua localização.`
                : "Ainda não há eletropostos cadastrados nesta rede."
          }
          action={
            scope === "nearby" ? (
              <Button type="button" variant="outline" className="min-h-11" onClick={() => setShowAll(true)}>
                Ver todos os eletropostos
              </Button>
            ) : undefined
          }
        />
      )}

      {!isLoading &&
        !isError &&
        sites.map((site) => (
          <div key={site.id}>
            <PublicSiteCard site={site} distanceKm={site.distanceKm} selected={site.id === selectedId} onSelect={() => selectFromCard(site.id)} />
          </div>
        ))}
    </div>
  )

  const map = (
    // `isolate`: os painéis do Leaflet usam z-index até 1000 — sem criar um contexto de empilhamento próprio, o mapa cobriria o header, a bottom-nav e o sheet.
    <div className="relative isolate h-[52vh] min-h-[320px] overflow-hidden rounded-[1.25rem] border border-border-subtle shadow-card lg:h-[calc(100vh-15rem)]">
      <Suspense fallback={<Skeleton className="h-full w-full rounded-none" />}>
        <StationsMap sites={sites} selectedId={selectedId} onSelect={selectFromMap} userPosition={geo.position} />
      </Suspense>
    </div>
  )

  const mapBlock = (
    <div className="space-y-2">
      {map}
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] font-semibold text-ink-softer" aria-label="Legenda do mapa">
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-accent-600" aria-hidden="true" />
          Tem conector livre
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-warning-700" aria-hidden="true" />
          Tudo ocupado
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-state-off" aria-hidden="true" />
          Fora do ar
        </li>
      </ul>
    </div>
  )

  return (
    <div>
      <AppBand wide className="pb-6">
        <h1 className="flex items-center gap-2 text-xl font-black tracking-tight text-ink">
          <MapPin className="h-5 w-5 text-lime" aria-hidden="true" />
          Eletropostos
        </h1>
        <p className="mt-1 text-sm text-ink-softer">Disponibilidade de agora, perto de você.</p>

        <div className="mt-4">
          <Input
            type="search"
            aria-label="Buscar por cidade ou endereço"
            placeholder="Buscar por cidade ou endereço"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            leftIcon={<Search className="h-4 w-4" aria-hidden="true" />}
          />
        </div>
      </AppBand>

      <div className="mx-auto max-w-md space-y-4 px-4 py-5 lg:max-w-6xl">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr] lg:items-start lg:gap-6">
          <div className="min-w-0 space-y-4">
            <LocationPrompt status={geo.status} hasPosition={hasPosition} onRequest={geo.request} compact={hasPosition} />

            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                label="Ordenar por"
                value={sort}
                onChange={setSortChoice}
                options={SORT_OPTIONS.map((opt) => {
                  const disabled = opt.value === "distance" && !hasPosition
                  return { ...opt, disabled, title: disabled ? "Ative a localização para ordenar por distância" : undefined }
                })}
              />

              {/* Alternador lista/mapa só no mobile — no desktop os dois aparecem lado a lado. */}
              <Segmented
                label="Modo de exibição"
                value={view}
                onChange={setView}
                className="ml-auto lg:hidden"
                options={[
                  { value: "list", label: "Lista", icon: List },
                  { value: "map", label: "Mapa", icon: MapIcon },
                ]}
              />
            </div>

          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-softer">
            <span>
              {scope === "nearby" ? (
                <>
                  Na sua região (~{NEARBY_RADIUS_KM} km) ·{" "}
                  <button type="button" onClick={() => setShowAll(true)} className="min-h-11 font-semibold text-primary hover:underline">
                    Ver todos
                  </button>
                </>
              ) : hasPosition && showAll && !searching ? (
                <button type="button" onClick={() => setShowAll(false)} className="min-h-11 font-semibold text-primary hover:underline">
                  Voltar para perto de mim
                </button>
              ) : (
                <>Todos os eletropostos da rede</>
              )}
            </span>
            <UpdatedAgo dataUpdatedAt={dataUpdatedAt} />
          </div>

          {!isDesktop && view === "map" && mapBlock}

          {showList && list}

          {/* Mobile, modo mapa: o card do pino tocado aparece logo abaixo (sem lista inteira sob o mapa). */}
          {!isDesktop && view === "map" && (
            <div>
              {selected ? (
                <PublicSiteCard site={selected} distanceKm={selected.distanceKm} selected onSelect={() => setDetailId(selected.id)} />
              ) : (
                <p className="rounded-card bg-muted px-4 py-5 text-center text-xs text-ink-softer">
                  Toque num pino do mapa para ver o eletroposto. O número dentro do pino é quantos conectores estão livres agora.
                </p>
              )}
            </div>
          )}
        </div>

          {isDesktop && <div className="lg:sticky lg:top-20">{mapBlock}</div>}
        </div>
      </div>

      <StationDetailSheet site={detail} distanceKm={detail?.distanceKm} dataUpdatedAt={dataUpdatedAt} onClose={() => setDetailId(null)} />
    </div>
  )
}
