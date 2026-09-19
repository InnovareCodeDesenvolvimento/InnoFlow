import { useEffect, useRef } from "react"
import L from "leaflet"
// O CSS do Leaflet só existe neste chunk — quem nunca abre o mapa nunca baixa.
import "leaflet/dist/leaflet.css"
import { freeSummaryLabel, stationState, type SiteWithDistance, type StationState } from "@/lib/stations"
import type { LatLng } from "@/lib/geo"

/**
 * Mapa das estações — Leaflet imperativo (sem react-leaflet: menos peso), em
 * `React.lazy` a partir de `pages/App/Mapa.tsx`. É SECUNDÁRIO: a lista é a
 * experiência primária (`decisoes-mapa-eletropostos.md` item 7), então nada
 * daqui entra no bundle inicial nem em chunk de outra rota.
 *
 * Marcadores: `L.divIcon` (HTML/Tailwind) em vez dos PNG do Leaflet — os
 * ícones padrão quebram com bundler (URL resolvida errada). A cor + o NÚMERO
 * de conectores livres dentro do pino carregam o estado (não só a cor).
 *
 * PRIVACIDADE: a posição do motorista só aparece como um ponto NESTE mapa
 * (no aparelho) — não sai daqui pra lugar nenhum. Os tiles, porém, são
 * pedidos ao provedor pelo enquadramento visível (z/x/y): isso é inerente a
 * qualquer mapa e vai citado no handoff.
 */

/**
 * Tiles: por env (`VITE_MAP_TILE_URL`/`VITE_MAP_ATTRIBUTION`). O default é o
 * servidor padrão do OpenStreetMap — funciona sem chave e é UM host só
 * (`tile.openstreetmap.org`). O Carto Voyager que o desenho previa devolve
 * tiles com marca d'água "API KEY REQUIRED" em todas as URLs públicas
 * (verificado em 19/09/2026, `rastertiles/voyager` e `light_all`), então NÃO
 * serve de default. A política de uso do OSM tolera app pequeno com atribuição;
 * volume real de produção pede provedor com chave (MapTiler/Stadia/Carto pago)
 * ou tile server próprio — é só trocar a env, sem mexer em código.
 */
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
// `target="_blank"`: dentro do PWA instalado, um link normal navegaria pra fora do app.
const DEFAULT_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
// Só vale pra templates com `{s}` (ex.: Carto a-d); no default do OSM é ignorado.
const TILE_SUBDOMAINS = "abcd"

/** Centro de São Paulo — só se não houver estação nem posição pra enquadrar. */
const FALLBACK_CENTER: L.LatLngTuple = [-23.5505, -46.6333]

/** Quantas estações (as mais próximas) entram no enquadramento inicial quando há posição. */
const FIT_NEAREST = 6

const PIN_COLOR: Record<StationState, string> = {
  free: "bg-accent-600",
  busy: "bg-warning-700",
  offline: "bg-ink-softer",
}

function pinIcon(site: SiteWithDistance, selected: boolean): L.DivIcon {
  const state = stationState(site)
  const label = state === "offline" ? "–" : String(site.connectorSummary.free)
  const ring = selected ? "scale-110 ring-4 ring-primary/40" : ""
  return L.divIcon({
    className: "", // sem a caixa branca padrão do divIcon
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html: `<div class="flex h-11 w-11 items-center justify-center rounded-full border-[3px] border-white text-base font-black text-white shadow-lg transition-transform ${PIN_COLOR[state]} ${ring}">${label}</div>`,
  })
}

const userIcon = L.divIcon({
  className: "",
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  html: '<div class="h-[22px] w-[22px] rounded-full border-[3px] border-white bg-primary shadow-lg ring-4 ring-primary/25"></div>',
})

export interface StationsMapProps {
  sites: SiteWithDistance[]
  selectedId: string | null
  onSelect: (id: string) => void
  userPosition: LatLng | null
}

export default function StationsMap({ sites, selectedId, onSelect, userPosition }: StationsMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())
  const userMarkerRef = useRef<L.Marker | null>(null)
  const fittedKeyRef = useRef<string>("")

  // `onSelect` chega por ref: os marcadores não podem ser recriados só porque o pai re-renderizou.
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  // Cria o mapa UMA vez.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(FALLBACK_CENTER, 11)
    // Sem o prefixo "Leaflet" (link pra fora do app; a licença BSD-2 não exige) — fica só a atribuição dos tiles.
    map.attributionControl.setPrefix(false)
    L.tileLayer(import.meta.env.VITE_MAP_TILE_URL || DEFAULT_TILE_URL, {
      attribution: import.meta.env.VITE_MAP_ATTRIBUTION || DEFAULT_ATTRIBUTION,
      subdomains: TILE_SUBDOMAINS,
      maxZoom: 19,
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    // O container muda de tamanho (troca lista↔mapa no mobile, rotação): sem isto o Leaflet pinta tiles cinza.
    const observer = new ResizeObserver(() => map.invalidateSize())
    observer.observe(el)

    const markers = markersRef.current
    return () => {
      observer.disconnect()
      map.remove()
      mapRef.current = null
      layerRef.current = null
      userMarkerRef.current = null
      markers.clear()
      fittedKeyRef.current = ""
    }
  }, [])

  // Sincroniza marcadores com a lista (estado muda por SSE/polling → só troca o ícone, não recria).
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    const markers = markersRef.current
    const ids = new Set(sites.map((s) => s.id))

    for (const [id, marker] of markers) {
      if (!ids.has(id)) {
        layer.removeLayer(marker)
        markers.delete(id)
      }
    }

    for (const site of sites) {
      const selected = site.id === selectedId
      const title = `${site.name} — ${freeSummaryLabel(site.connectorSummary)}`
      const existing = markers.get(site.id)
      if (existing) {
        // Título/alt novos ANTES do `setIcon` — é ele que recria o elemento lendo `options`.
        existing.options.title = title
        existing.options.alt = title
        existing.setIcon(pinIcon(site, selected))
        existing.setZIndexOffset(selected ? 1000 : 0)
      } else {
        const marker = L.marker([site.latitude, site.longitude], {
          icon: pinIcon(site, selected),
          title,
          alt: title,
          keyboard: true,
          zIndexOffset: selected ? 1000 : 0,
        })
        marker.on("click", () => onSelectRef.current(site.id))
        marker.addTo(layer)
        markers.set(site.id, marker)
      }
    }
  }, [sites, selectedId])

  // Posição do motorista (no aparelho): ponto azul, não clicável.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!userPosition) {
      userMarkerRef.current?.remove()
      userMarkerRef.current = null
      return
    }
    if (userMarkerRef.current) userMarkerRef.current.setLatLng([userPosition.lat, userPosition.lng])
    else userMarkerRef.current = L.marker([userPosition.lat, userPosition.lng], { icon: userIcon, interactive: false, keyboard: false, zIndexOffset: -500 }).addTo(map)
  }, [userPosition])

  // Enquadra QUANDO o conjunto de estações (ou a existência de posição) muda — nunca a cada troca de status,
  // senão o mapa "pularia" debaixo do dedo enquanto o motorista arrasta.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const key = `${sites.map((s) => s.id).sort().join(",")}|${userPosition ? "u" : "n"}`
    if (key === fittedKeyRef.current) return
    fittedKeyRef.current = key

    // Com posição: enquadra o motorista + as estações MAIS PRÓXIMAS (não os ~30 km inteiros —
    // ali os pinos do centro se sobrepõem e ficam impossíveis de tocar; o resto se alcança com pan/zoom).
    // Sem posição: todas.
    const framed = userPosition
      ? [...sites].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)).slice(0, FIT_NEAREST)
      : sites
    const points: L.LatLngTuple[] = framed.map((s) => [s.latitude, s.longitude])
    if (userPosition) points.push([userPosition.lat, userPosition.lng])
    if (points.length === 0) return
    if (points.length === 1) map.setView(points[0], 14, { animate: false })
    else map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15, animate: false })
  }, [sites, userPosition])

  // Seleção vinda da lista: só desloca se o marcador saiu do enquadramento (não muda o zoom).
  useEffect(() => {
    const map = mapRef.current
    const marker = selectedId ? markersRef.current.get(selectedId) : undefined
    if (!map || !marker) return
    const latLng = marker.getLatLng()
    if (!map.getBounds().pad(-0.15).contains(latLng)) {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
      map.panTo(latLng, { animate: !reduced })
    }
  }, [selectedId])

  return <div ref={containerRef} role="region" aria-label="Mapa dos eletropostos" className="h-full w-full" />
}
