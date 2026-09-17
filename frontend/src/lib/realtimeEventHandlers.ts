import type { QueryClient } from "@tanstack/react-query"
import { meKeys } from "@/hooks/useMeSessions"
import { sitesKeys } from "@/hooks/useSites"
import { chargePointsKeys } from "@/hooks/useChargePoints"
import { connectorsKeys } from "@/hooks/useConnectors"
import { tariffsKeys } from "@/hooks/useTariffs"
import { authTokensKeys } from "@/hooks/useAuthTokens"
import type { MeActiveSessionResponse, RealtimeEvent } from "@/types/api"

/** `entityType` do evento → raiz da query que precisa ser invalidada (ver `admin.entity.changed`). `TariffAssignment` não tem hook ainda (gap conhecido, ver PROGRESSO.md) — evento chega mas não tem o que invalidar. */
const ENTITY_QUERY_KEYS: Partial<Record<string, readonly unknown[]>> = {
  Site: sitesKeys.all,
  ChargePoint: chargePointsKeys.all,
  Connector: connectorsKeys.all,
  Tariff: tariffsKeys.all,
  AuthToken: authTokensKeys.all,
}

/**
 * Handler central de todo evento SSE (admin ou motorista) — DEFAULT é
 * `invalidateQueries` na chave certa (o evento só diz "isto ficou velho", o
 * REST continua fonte única de forma/autorização; ver
 * `decisoes-tempo-real-sse.md` item 6). Única exceção enumerada pela Nova:
 * `session.metrics` vai direto em `setQueryData` — a cada poucos segundos,
 * invalidate+refetch seria só reinventar o polling com passos a mais.
 */
export function handleRealtimeEvent(event: RealtimeEvent, queryClient: QueryClient): void {
  switch (event.type) {
    case "session.metrics":
      queryClient.setQueryData<MeActiveSessionResponse | undefined>(meKeys.activeSession, (old) => {
        if (!old?.session || old.session.id !== event.sessionId) return old
        return {
          ...old,
          session: {
            ...old.session,
            energyDeliveredWh: event.energyWh,
            lastPowerW: event.powerW,
            lastSoc: event.soc,
            estimatedCostCents: event.partialCostCents,
            lastSampleAt: event.occurredAt,
          },
        }
      })
      return

    case "session.started":
    case "session.stopped":
      queryClient.invalidateQueries({ queryKey: meKeys.activeSession })
      queryClient.invalidateQueries({ queryKey: ["me", "sessions"] })
      queryClient.invalidateQueries({ queryKey: ["dashboard", "live"] })
      return

    case "wallet.updated":
      queryClient.invalidateQueries({ queryKey: ["me", "wallet"] })
      return

    case "chargepoint.status":
      queryClient.invalidateQueries({ queryKey: connectorsKeys.all })
      queryClient.invalidateQueries({ queryKey: ["dashboard", "live"] })
      return

    case "admin.entity.changed": {
      const keys = ENTITY_QUERY_KEYS[event.entityType]
      if (keys) queryClient.invalidateQueries({ queryKey: keys })
      return
    }

    // Throttle de no máx. 1/5s já é do SERVIDOR (ver contrato) — nunca
    // recalcula o agregado aqui, só invalida (`getDashboardSummary`/`getDashboardLive` buscam de novo).
    case "dashboard.dirty":
      queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      return
  }
}
