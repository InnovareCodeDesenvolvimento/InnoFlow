/**
 * Geografia PURA do "eletropostos perto de mim" — sem DOM, sem rede.
 *
 * REGRA DE PRIVACIDADE (LGPD, `decisoes-mapa-eletropostos.md` item 4): a
 * posição do motorista NUNCA sai do aparelho. Distância (Haversine) e
 * ordenação acontecem aqui, no cliente. O único dado de localização que vai
 * pro servidor é a bounding box, e ela é arredondada em grade de 0,1° (~11 km)
 * — a querystring cai no access log do nginx, então a caixa não pode
 * reconstituir a posição precisa.
 */

export interface LatLng {
  lat: number
  lng: number
}

const EARTH_RADIUS_KM = 6371

const toRad = (deg: number) => (deg * Math.PI) / 180

/** Distância em linha reta (km) entre dois pontos — Haversine. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Distância em pt-BR: "850 m" (arredondada a 10 m), "1,2 km" (1 casa até 10 km),
 * "12 km" (inteiro acima disso). Não finita → travessão.
 */
export function formatDistance(km: number): string {
  if (!Number.isFinite(km) || km < 0) return "—"
  const meters = Math.round((km * 1000) / 10) * 10
  if (meters < 1000) return `${meters} m`
  if (km < 10) return `${km.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`
  return `${Math.round(km).toLocaleString("pt-BR")} km`
}

/** Passo da grade da bounding box: 0,1° ≈ 11 km. */
export const GEO_GRID_DEG = 0.1

/** Raio que a caixa precisa cobrir em torno do motorista (antes do arredondamento em grade). */
export const NEARBY_RADIUS_KM = 30

const KM_PER_DEG_LAT = 111.32

// Multiplicar por 10 e dividir depois mantém o resultado "limpo" (2.3, não
// 2.3000000000000003) — vira querystring e vai pro log.
const snapDown = (v: number) => Math.floor(Math.round(v * 1e6) / 1e5) / 10
const snapUp = (v: number) => Math.ceil(Math.round(v * 1e6) / 1e5) / 10

export interface BoundingBox {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

/**
 * Bounding box ao redor da posição, com TODOS os quatro valores em múltiplos
 * de 0,1° (min arredonda pra baixo, max pra cima — a caixa sempre contém o
 * raio pedido). Duas pessoas a poucos km uma da outra mandam a MESMA URL.
 */
export function coarseBoundingBox(position: LatLng, radiusKm: number = NEARBY_RADIUS_KM): BoundingBox {
  const dLat = radiusKm / KM_PER_DEG_LAT
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(0.01, Math.cos(toRad(position.lat))))
  return {
    minLat: Math.max(-90, snapDown(position.lat - dLat)),
    maxLat: Math.min(90, snapUp(position.lat + dLat)),
    minLng: Math.max(-180, snapDown(position.lng - dLng)),
    maxLng: Math.min(180, snapUp(position.lng + dLng)),
  }
}

/** Mesma checagem que a privacidade exige: todo valor da caixa cai na grade de 0,1°. */
export function isOnGrid(value: number): boolean {
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-6
}
