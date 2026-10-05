import { useChargePoints } from "@/hooks/useChargePoints"
import { useCommunicationSettings } from "@/hooks/useCommunicationSettings"
import { useConnectors } from "@/hooks/useConnectors"
import { usePaymentGatewayConfig } from "@/hooks/usePaymentGateway"
import { useSites } from "@/hooks/useSites"
import { useTariffAssignments } from "@/hooks/useTariffAssignments"
import { useTariffs } from "@/hooks/useTariffs"
import type { PaginatedResponse } from "@/types/api"
import { deriveChecklist, hasActiveAssignment, isCommunicationActive, isGatewayReady, type ChecklistView } from "./checklistLogic"

/** Uma linha só interessa: "há pelo menos um?". `meta.total` responde sem trazer a lista inteira. */
const ONE = { page: 1, pageSize: 1 }

function anyRow(data: PaginatedResponse<unknown> | undefined): boolean | undefined {
  return data ? data.meta.total > 0 : undefined
}

/**
 * Dados do checklist do Dashboard. NENHUM endpoint novo: são as mesmas consultas que as telas já fazem (sites, carregadores, conectores, tarifas, vínculos, gateway, comunicação).
 * Consulta que falha deixa o item DESCONHECIDO (some do card) em vez de "faltando" — não se afirma pendência sem ter lido o dado.
 * `loading` enquanto alguma ainda não respondeu: o card só aparece com tudo lido, para não piscar e não empurrar o conteúdo do Dashboard duas vezes.
 *
 * Lacuna registrada: não existe "contagem" barata de vínculos de tarifa em vigor — usamos a 1ª página de 100 e `meta.total` (ver `hasActiveAssignment`).
 */
export function useAdminChecklist(): { loading: boolean; view: ChecklistView } {
  const sites = useSites(ONE)
  const chargePoints = useChargePoints(ONE)
  const connectors = useConnectors(ONE)
  const tariffs = useTariffs(ONE)
  const assignments = useTariffAssignments({ page: 1, pageSize: 100 })
  const gateway = usePaymentGatewayConfig()
  const communication = useCommunicationSettings()

  const loading = [sites, chargePoints, connectors, tariffs, assignments, gateway, communication].some((q) => q.isPending)

  const view = deriveChecklist({
    site: anyRow(sites.data),
    chargePoint: anyRow(chargePoints.data),
    connector: anyRow(connectors.data),
    tariff: anyRow(tariffs.data),
    assignment: assignments.data ? hasActiveAssignment(assignments.data.items, assignments.data.meta.total) : undefined,
    gateway: gateway.data ? isGatewayReady(gateway.data) : undefined,
    communication: communication.data ? isCommunicationActive(communication.data) : undefined,
  })
  return { loading, view }
}
