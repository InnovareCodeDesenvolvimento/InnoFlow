import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { publicSitesKeys } from "@/hooks/useSites"
import { meKeys } from "@/hooks/useMeSessions"
import { tariffAssignmentsKeys } from "@/hooks/useTariffAssignments"
import { tariffsKeys } from "@/hooks/useTariffs"
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

// PREPARADO, NÃO CONECTADO (F5.1): o backend real ainda não emite `topup.updated`
// (ver comentário em `TopupUpdatedEvent`, `types/api.ts`) — este teste prova que o
// handler está pronto para quando existir, mesmo sem o mock disparar o evento.
describe("topup.updated", () => {
  it("invalida só o topup específico (útil quando o evento chegar de verdade)", () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, "invalidateQueries")
    const event: RealtimeEvent = { type: "topup.updated", occurredAt: new Date().toISOString(), topupId: "topup_1", status: "PAID" }
    handleRealtimeEvent(event, client)
    expect(spy).toHaveBeenCalledWith({ queryKey: meKeys.topup("topup_1") })
  })
})

// F5.9 (sessão travada): `session.updated` = a sessão virou STOP_UNCONFIRMED ou foi reanimada.
describe("session.updated", () => {
  const updated: RealtimeEvent = { type: "session.updated", occurredAt: new Date().toISOString(), sessionId: "sess_1", chargePointId: "cp_1" }
  const stopped: RealtimeEvent = { type: "session.stopped", occurredAt: new Date().toISOString(), sessionId: "sess_1", chargePointId: "cp_1" }

  const invalidatedKeys = (event: RealtimeEvent) => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, "invalidateQueries")
    handleRealtimeEvent(event, client)
    return spy.mock.calls.map(([filters]) => filters?.queryKey)
  }

  it("invalida as MESMAS chaves de session.stopped (sessão ativa, histórico, dashboard ao vivo) + o detalhe", () => {
    const stoppedKeys = invalidatedKeys(stopped)
    const updatedKeys = invalidatedKeys(updated)
    for (const key of stoppedKeys) expect(updatedKeys).toContainEqual(key)
    expect(updatedKeys).toContainEqual(meKeys.activeSession)
    expect(updatedKeys).toContainEqual(["me", "sessions"])
    expect(updatedKeys).toContainEqual(meKeys.sessionDetail("sess_1"))
  })

  it("de fato marca o recibo em cache como velho (o refetch do detalhe acontece sem esperar o polling)", () => {
    const client = new QueryClient()
    client.setQueryData(meKeys.sessionDetail("sess_1"), { id: "sess_1", status: "STOP_UNCONFIRMED" })
    handleRealtimeEvent(updated, client)
    expect(client.getQueryState(meKeys.sessionDetail("sess_1"))?.isInvalidated).toBe(true)
  })
})

// Gap antigo: o backend já publicava `admin.entity.changed` com entityType "TariffAssignment" (middleware de auditoria), mas o frontend não tinha o que invalidar.
describe("admin.entity.changed × TariffAssignment", () => {
  it("invalida os vínculos de tarifa (lista completa e por filtro) quando OUTRO usuário cria/edita/remove um vínculo", () => {
    const client = new QueryClient()
    client.setQueryData(tariffAssignmentsKeys.everything(), { items: [], truncated: false })
    client.setQueryData(tariffAssignmentsKeys.list({ tariffId: "t1" }), { items: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } })

    const event: RealtimeEvent = { type: "admin.entity.changed", occurredAt: new Date().toISOString(), entityType: "TariffAssignment", entityId: "ta_1", action: "CREATE" }
    handleRealtimeEvent(event, client)

    expect(client.getQueryState(tariffAssignmentsKeys.everything())?.isInvalidated).toBe(true)
    expect(client.getQueryState(tariffAssignmentsKeys.list({ tariffId: "t1" }))?.isInvalidated).toBe(true)
  })

  it("não invalida as tarifas em si (outra entidade)", () => {
    const client = new QueryClient()
    client.setQueryData(tariffsKeys.list({}), { items: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } })
    const event: RealtimeEvent = { type: "admin.entity.changed", occurredAt: new Date().toISOString(), entityType: "TariffAssignment", entityId: "ta_1", action: "UPDATE" }
    handleRealtimeEvent(event, client)
    expect(client.getQueryState(tariffsKeys.list({}))?.isInvalidated).toBe(false)
  })
})
