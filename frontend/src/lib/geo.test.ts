import { describe, expect, it } from "vitest"
import { coarseBoundingBox, formatDistance, haversineKm, isOnGrid, NEARBY_RADIUS_KM } from "./geo"

describe("haversineKm", () => {
  it("distância conhecida: São Paulo ↔ Rio de Janeiro ≈ 357 km", () => {
    const km = haversineKm({ lat: -23.5505, lng: -46.6333 }, { lat: -22.9068, lng: -43.1729 })
    expect(km).toBeGreaterThan(350)
    expect(km).toBeLessThan(365)
  })

  it("mesmo ponto = 0 e é simétrica", () => {
    const a = { lat: -23.56, lng: -46.65 }
    const b = { lat: -23.6, lng: -46.7 }
    expect(haversineKm(a, a)).toBe(0)
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 10)
  })

  it("Av. Paulista ↔ Ibirapuera ≈ 3 km", () => {
    const km = haversineKm({ lat: -23.5614, lng: -46.6559 }, { lat: -23.5874, lng: -46.6576 })
    expect(km).toBeGreaterThan(2.5)
    expect(km).toBeLessThan(3.3)
  })
})

describe("formatDistance (pt-BR)", () => {
  it("menos de 1 km: metros arredondados a 10 m", () => {
    expect(formatDistance(0.85)).toBe("850 m")
    expect(formatDistance(0.0421)).toBe("40 m")
  })

  it("de 1 a 10 km: uma casa decimal com vírgula", () => {
    expect(formatDistance(1.2)).toBe("1,2 km")
    expect(formatDistance(9.94)).toBe("9,9 km")
  })

  it("10 km ou mais: inteiro", () => {
    expect(formatDistance(12.4)).toBe("12 km")
    expect(formatDistance(357.2)).toBe("357 km")
  })

  it("valor inválido vira travessão", () => {
    expect(formatDistance(Number.NaN)).toBe("—")
    expect(formatDistance(-1)).toBe("—")
  })
})

describe("coarseBoundingBox — privacidade (grade de 0,1°)", () => {
  const positions = [
    { lat: -23.561412, lng: -46.655933 },
    { lat: -23.5, lng: -46.6 },
    { lat: -23.4999, lng: -46.6001 },
    { lat: 0.04, lng: -0.04 },
    { lat: -89.97, lng: 179.96 },
  ]

  it.each(positions)("os 4 limites caem em múltiplos de 0,1 (%o)", (pos) => {
    const box = coarseBoundingBox(pos)
    for (const v of Object.values(box)) expect(isOnGrid(v)).toBe(true)
    // E a URL que vira querystring nunca carrega a posição exata.
    expect(Object.values(box)).not.toContain(pos.lat)
    expect(Object.values(box)).not.toContain(pos.lng)
  })

  it("a caixa CONTÉM o raio pedido (min arredonda pra baixo, max pra cima)", () => {
    const pos = { lat: -23.5614, lng: -46.6559 }
    const box = coarseBoundingBox(pos)
    const dLat = NEARBY_RADIUS_KM / 111.32
    expect(box.minLat).toBeLessThanOrEqual(pos.lat - dLat)
    expect(box.maxLat).toBeGreaterThanOrEqual(pos.lat + dLat)
    expect(box.minLng).toBeLessThan(pos.lng)
    expect(box.maxLng).toBeGreaterThan(pos.lng)
  })

  it("posições vizinhas (mesma célula) mandam a MESMA caixa — URL idêntica, cacheável", () => {
    expect(coarseBoundingBox({ lat: -23.5601, lng: -46.6551 })).toEqual(coarseBoundingBox({ lat: -23.5649, lng: -46.6599 }))
  })

  it("nunca sai dos limites do planeta", () => {
    const box = coarseBoundingBox({ lat: 89.99, lng: 179.99 })
    expect(box.maxLat).toBeLessThanOrEqual(90)
    expect(box.maxLng).toBeLessThanOrEqual(180)
  })
})
