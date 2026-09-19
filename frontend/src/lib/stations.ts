import { CONNECTOR_TYPE_LABELS, formatPowerKw } from "@/lib/utils"
import { haversineKm, type LatLng } from "@/lib/geo"
import type { PublicConnectorGroup, PublicSite } from "@/types/api"

/**
 * Regras de exibição das estações (eletropostos) — puras, testáveis.
 *
 * "Livre" NÃO é recalculado aqui: `PublicConnector.isFree`/`connectorSummary`
 * vêm do servidor (regra única: carregador online E status AVAILABLE, ver
 * `decisoes-mapa-eletropostos.md` item 2). O `landingConnectorStatus` do
 * `lib/utils.ts` é o espelho visual dessa mesma regra na tela do QR.
 */

export type StationState = "free" | "busy" | "offline"

export const STATION_STATE_LABELS: Record<StationState, string> = {
  free: "Livre agora",
  busy: "Tudo ocupado",
  offline: "Fora do ar",
}

/**
 * Estado do site inteiro. `offline` = nenhum carregador conectado (ou sem
 * conector nenhum) — é o caso que a listagem antiga escondia mostrando
 * "Disponível" pra carregador desligado. `free` = pelo menos UM conector livre.
 */
export function stationState(site: PublicSite): StationState {
  const anyOnline = site.chargePoints.some((cp) => cp.online)
  if (!anyOnline || site.connectorSummary.total === 0) return "offline"
  return site.connectorSummary.free > 0 ? "free" : "busy"
}

export type SiteWithDistance = PublicSite & { distanceKm: number | null }

/** Anexa a distância ao motorista (Haversine, no aparelho). Sem posição: `null`. */
export function withDistance(sites: PublicSite[], position: LatLng | null): SiteWithDistance[] {
  return sites.map((site) => ({
    ...site,
    distanceKm: position ? haversineKm(position, { lat: site.latitude, lng: site.longitude }) : null,
  }))
}

export type StationSort = "distance" | "connectors" | "name"

/** `distance`: mais perto primeiro (sem distância vai pro fim). `connectors`: mais conectores primeiro ("onde tem mais eletropostos"). `name`: A→Z. Desempate sempre por nome. */
export function sortStations(sites: SiteWithDistance[], sort: StationSort): SiteWithDistance[] {
  const byName = (a: PublicSite, b: PublicSite) => a.name.localeCompare(b.name, "pt-BR")
  return [...sites].sort((a, b) => {
    if (sort === "distance") {
      const da = a.distanceKm ?? Number.POSITIVE_INFINITY
      const db = b.distanceKm ?? Number.POSITIVE_INFINITY
      if (da !== db) return da - db
    } else if (sort === "connectors") {
      const diff = b.connectorSummary.total - a.connectorSummary.total
      if (diff !== 0) return diff
    }
    return byName(a, b)
  })
}

/** Minúsculas, sem acento — "sao paulo" acha "São Paulo". */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
}

/** Busca por nome, endereço, cidade ou UF (todas as palavras precisam aparecer). É o caminho quando não há permissão de localização. */
export function searchStations<T extends PublicSite>(sites: T[], query: string): T[] {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return sites
  return sites.filter((site) => {
    const haystack = normalizeText(`${site.name} ${site.addressLine} ${site.city} ${site.state}`)
    return terms.every((term) => haystack.includes(term))
  })
}

/** "DC CCS2 60 kW · 1/2" — o chip por (tipo, potência) com livres/total. */
export function connectorGroupLabel(group: PublicConnectorGroup): string {
  const power = group.maxPowerKw ? ` ${formatPowerKw(group.maxPowerKw)}` : ""
  return `${CONNECTOR_TYPE_LABELS[group.type]}${power} · ${group.free}/${group.total}`
}

/** "3 de 4 conectores livres" (singular quando o total é 1). */
export function freeSummaryLabel(summary: { total: number; free: number }): string {
  if (summary.total === 0) return "Sem conectores cadastrados"
  return `${summary.free} de ${summary.total} ${summary.total === 1 ? "conector livre" : "conectores livres"}`
}

/**
 * "Como chegar": deep links puros — sem SDK, sem chave, sem CSP envolvido.
 * A coordenada é a do ELETROPOSTO (público), nunca a do motorista.
 */
export function directionsLinks(site: Pick<PublicSite, "latitude" | "longitude">): { google: string; waze: string } {
  const dest = `${site.latitude},${site.longitude}`
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${dest}`,
    waze: `https://waze.com/ul?ll=${dest}&navigate=yes`,
  }
}

/**
 * "atualizado agora / há 12 s / há 3 min" a partir do `dataUpdatedAt` do
 * TanStack Query (NÃO de campo do servidor). `dataUpdatedAt === 0` = ainda
 * sem dado → `null`.
 */
export function formatUpdatedAgo(dataUpdatedAt: number, now: number): string | null {
  if (!dataUpdatedAt) return null
  const seconds = Math.max(0, Math.round((now - dataUpdatedAt) / 1000))
  if (seconds < 5) return "atualizado agora"
  if (seconds < 60) return `atualizado há ${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `atualizado há ${minutes} min`
  return `atualizado há ${Math.floor(minutes / 60)} h`
}
