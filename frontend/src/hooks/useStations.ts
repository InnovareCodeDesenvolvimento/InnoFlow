import { useMemo } from "react"
import { usePublicSites } from "@/hooks/useSites"
import { coarseBoundingBox, type LatLng } from "@/lib/geo"
import { searchStations, sortStations, withDistance, type SiteWithDistance, type StationSort } from "@/lib/stations"

/** Uma página só: o servidor limita a 100 e uma caixa de ~30 km em volta do motorista cabe nisso com folga. */
const STATIONS_PAGE_SIZE = 100

export type StationsScope = "nearby" | "all"

/**
 * Estações prontas pra tela (distância, busca, ordenação). Reaproveita
 * `usePublicSites` — não é um segundo caminho de dados.
 *
 * Privacidade: com posição, a query leva a bounding box ARREDONDADA em
 * grade de 0,1° (`coarseBoundingBox`); a posição exata só existe aqui, no
 * aparelho, pra calcular distância. Sem posição — ou com busca ativa, ou
 * "ver todos" — não vai bbox nenhuma.
 */
export function useStations({
  position,
  query = "",
  sort,
  showAll = false,
  enabled = true,
}: {
  position: LatLng | null
  query?: string
  sort?: StationSort
  showAll?: boolean
  enabled?: boolean
}) {
  const scope: StationsScope = position && !showAll && query.trim() === "" ? "nearby" : "all"

  // A identidade do objeto muda a cada leitura de GPS, mas a chave da query é
  // por VALOR (TanStack faz hash estrutural) e o arredondamento em grade faz
  // posições vizinhas darem a mesma caixa — então não refaz a busca à toa.
  const box = useMemo(() => (scope === "nearby" && position ? coarseBoundingBox(position) : null), [scope, position])

  const result = usePublicSites({ pageSize: STATIONS_PAGE_SIZE, ...(box ?? {}) }, { enabled })

  const effectiveSort: StationSort = sort ?? (position ? "distance" : "name")

  const sites: SiteWithDistance[] = useMemo(() => {
    const items = result.data?.items ?? []
    return sortStations(searchStations(withDistance(items, position), query), effectiveSort)
  }, [result.data, position, query, effectiveSort])

  return { ...result, sites, scope, sort: effectiveSort }
}
