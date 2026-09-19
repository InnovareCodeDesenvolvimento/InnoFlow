import { describe, expect, it } from "vitest"
import { makeSite } from "@/test/siteFixtures"
import {
  connectorGroupLabel,
  directionsLinks,
  formatUpdatedAgo,
  freeSummaryLabel,
  normalizeText,
  searchStations,
  sortStations,
  stationState,
  withDistance,
} from "./stations"

describe("stationState — usa isFree do servidor, nunca só o status", () => {
  it("free: pelo menos um conector livre", () => {
    expect(stationState(makeSite({}, [{ connectors: [{ status: "CHARGING" }, { status: "AVAILABLE" }] }]))).toBe("free")
  })

  it("busy: tudo ocupado", () => {
    expect(stationState(makeSite({}, [{ connectors: [{ status: "CHARGING" }, { status: "PREPARING" }] }]))).toBe("busy")
  })

  it("offline: conector AVAILABLE num carregador OFFLINE não é livre (a mentira que a listagem antiga contava)", () => {
    const site = makeSite({}, [{ online: false, connectors: [{ status: "AVAILABLE" }, { status: "AVAILABLE" }] }])
    expect(site.connectorSummary.free).toBe(0)
    expect(stationState(site)).toBe("offline")
  })

  it("offline: sem conectores", () => {
    expect(stationState(makeSite({}, [{ connectors: [] }]))).toBe("offline")
  })

  it("um carregador offline + outro online ocupado = busy (não offline)", () => {
    expect(stationState(makeSite({}, [{ online: false, connectors: [{}] }, { connectors: [{ status: "CHARGING" }] }]))).toBe("busy")
  })
})

describe("resumo de conectores", () => {
  it("'3 de 4 conectores livres' e singular quando é 1", () => {
    expect(freeSummaryLabel({ total: 4, free: 3 })).toBe("3 de 4 conectores livres")
    expect(freeSummaryLabel({ total: 1, free: 0 })).toBe("0 de 1 conector livre")
    expect(freeSummaryLabel({ total: 0, free: 0 })).toBe("Sem conectores cadastrados")
  })

  it("chip por (tipo, potência) com livres/total", () => {
    const site = makeSite({}, [{ connectors: [{ type: "DC_CCS2", maxPowerKw: 60, status: "AVAILABLE" }, { type: "DC_CCS2", maxPowerKw: 60, status: "CHARGING" }] }])
    expect(connectorGroupLabel(site.connectorSummary.groups[0])).toBe("DC CCS2 60 kW · 1/2")
  })
})

describe("ordenação e distância", () => {
  const paulista = makeSite({ id: "a", name: "Paulista", latitude: -23.5614, longitude: -46.6559 }, [{ connectors: [{}, {}, {}, {}] }])
  const osasco = makeSite({ id: "b", name: "Osasco", latitude: -23.5325, longitude: -46.7917 }, [{ connectors: [{}] }])
  const guarulhos = makeSite({ id: "c", name: "Guarulhos", latitude: -23.4356, longitude: -46.4731 }, [{ connectors: [{}, {}] }])
  const me = { lat: -23.5631, lng: -46.6544 } // ~200 m da Paulista

  it("distance: mais perto primeiro; sem posição a distância é null e vai pro fim", () => {
    const sorted = sortStations(withDistance([guarulhos, osasco, paulista], me), "distance")
    expect(sorted.map((s) => s.id)).toEqual(["a", "b", "c"])
    expect(sorted[0].distanceKm).toBeLessThan(0.5)
    expect(withDistance([paulista], null)[0].distanceKm).toBeNull()
  })

  it("connectors: mais conectores primeiro (onde tem mais eletropostos)", () => {
    expect(sortStations(withDistance([osasco, guarulhos, paulista], null), "connectors").map((s) => s.id)).toEqual(["a", "c", "b"])
  })

  it("name: A→Z", () => {
    expect(sortStations(withDistance([paulista, osasco, guarulhos], null), "name").map((s) => s.name)).toEqual(["Guarulhos", "Osasco", "Paulista"])
  })
})

describe("busca (fallback sem permissão de localização)", () => {
  const sites = [
    makeSite({ id: "1", name: "Shopping Vila Norte", city: "São Paulo", addressLine: "Av. das Nações, 1200" }),
    makeSite({ id: "2", name: "Estação Anhanguera", city: "Jundiaí", addressLine: "Rod. Anhanguera, km 98" }),
  ]

  it("normalizeText ignora acento e caixa", () => {
    expect(normalizeText("  São PAULO ")).toBe("sao paulo")
  })

  it("acha por cidade sem acento", () => {
    expect(searchStations(sites, "jundiai").map((s) => s.id)).toEqual(["2"])
  })

  it("acha por endereço e exige todas as palavras", () => {
    expect(searchStations(sites, "nacoes 1200").map((s) => s.id)).toEqual(["1"])
    expect(searchStations(sites, "nacoes jundiai")).toEqual([])
  })

  it("busca vazia devolve tudo", () => {
    expect(searchStations(sites, "   ")).toHaveLength(2)
  })
})

describe("Como chegar — deep links puros (coordenada do ELETROPOSTO)", () => {
  it("Google Maps e Waze, sem SDK/chave", () => {
    const links = directionsLinks({ latitude: -23.5614, longitude: -46.6559 })
    expect(links.google).toBe("https://www.google.com/maps/dir/?api=1&destination=-23.5614,-46.6559")
    expect(links.waze).toBe("https://waze.com/ul?ll=-23.5614,-46.6559&navigate=yes")
  })
})

describe("formatUpdatedAgo — vem do dataUpdatedAt do TanStack", () => {
  const t0 = 1_000_000
  it("agora / segundos / minutos / horas", () => {
    expect(formatUpdatedAgo(t0, t0 + 2_000)).toBe("atualizado agora")
    expect(formatUpdatedAgo(t0, t0 + 12_000)).toBe("atualizado há 12 s")
    expect(formatUpdatedAgo(t0, t0 + 3 * 60_000 + 5_000)).toBe("atualizado há 3 min")
    expect(formatUpdatedAgo(t0, t0 + 2 * 3_600_000)).toBe("atualizado há 2 h")
  })

  it("sem dado ainda (0) não mostra nada", () => {
    expect(formatUpdatedAgo(0, t0)).toBeNull()
  })
})
