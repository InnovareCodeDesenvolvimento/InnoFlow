import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { publicSitesKeys } from "@/hooks/useSites"
import { makeSite } from "@/test/siteFixtures"
import { handleRealtimeEvent, isChargePointInLoadedStations } from "./realtimeEventHandlers"
import type { PaginatedResponse, PublicSite, RealtimeEvent } from "@/types/api"

function clientWithStations(sites: PublicSite[]) {
  const client = new QueryClient()
  const data: PaginatedResponse<PublicSite> = { items: sites, meta: { page: 1, pageSize: 100, total: sites.length, totalPages: 1 } }
  client.setQueryData(publicSitesKeys.list({ pageSize: 100 }), data)
  return client
}

const statusEvent = (chargePointId: string): RealtimeEvent => ({
  type: "chargepoint.status",
  occurredAt: new Date().toISOString(),
  chargePointId,
  connectorId: 1,
  status: "CHARGING",
})

describe("chargepoint.status × estações carregadas", () => {
  const site = makeSite({ id: "a" }, [{ id: "cp_da_lista", connectors: [{}] }])

  it("carregador QUE ESTÁ na lista carregada: invalida as estações", () => {
    const client = clientWithStations([site])
    const spy = vi.spyOn(client, "invalidateQueries")
    handleRealtimeEvent(statusEvent("cp_da_lista"), client)
    expect(isChargePointInLoadedStations(client, "cp_da_lista")).toBe(true)
    expect(spy).toHaveBeenCalledWith({ queryKey: publicSitesKeys.all })
  })

  it("carregador de OUTRO lugar da plataforma: NÃO refaz o fetch (a guarda que evita N motoristas × cada mudança)", () => {
    const client = clientWithStations([site])
    const spy = vi.spyOn(client, "invalidateQueries")
    handleRealtimeEvent(statusEvent("cp_de_outra_cidade"), client)
    expect(isChargePointInLoadedStations(client, "cp_de_outra_cidade")).toBe(false)
    expect(spy).not.toHaveBeenCalledWith({ queryKey: publicSitesKeys.all })
  })

  it("sem nenhuma lista carregada (ex.: motorista fora da aba Mapa): nunca invalida", () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, "invalidateQueries")
    handleRealtimeEvent(statusEvent("qualquer"), client)
    expect(spy).not.toHaveBeenCalledWith({ queryKey: publicSitesKeys.all })
  })
})
