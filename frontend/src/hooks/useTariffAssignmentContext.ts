import { useMemo } from "react"
import { useChargePoints } from "@/hooks/useChargePoints"
import { useSites } from "@/hooks/useSites"
import { useTariffs } from "@/hooks/useTariffs"
import { useAllTariffAssignments } from "@/hooks/useTariffAssignments"
import type { AssignmentLookup } from "@/lib/tariffAssignmentTargets"
import type { Tariff, TariffAssignment } from "@/types/api"

const EMPTY: TariffAssignment[] = []

/**
 * Tudo que as telas de tarifa por carregador precisam para explicar "qual tarifa vale onde": todos os vínculos visíveis, os nomes
 * dos locais/carregadores/tomadas e as tarifas (preço, ativa/desativada). Usa as MESMAS chaves de query das listagens do admin
 * (`pageSize: 100`), então abrir a tela não repete chamadas que a página já fez.
 */
export function useTariffAssignmentContext() {
  const all = useAllTariffAssignments()
  const sites = useSites({ page: 1, pageSize: 100 })
  const chargePoints = useChargePoints({ page: 1, pageSize: 100 })
  const tariffs = useTariffs({ page: 1, pageSize: 100 })

  const lookup = useMemo<AssignmentLookup>(() => ({ sites: sites.data?.items ?? [], chargePoints: chargePoints.data?.items ?? [] }), [sites.data, chargePoints.data])
  const tariffsById = useMemo<ReadonlyMap<string, Tariff>>(() => new Map((tariffs.data?.items ?? []).map((t) => [t.id, t])), [tariffs.data])

  const queries = [all, sites, chargePoints, tariffs]
  return {
    assignments: all.data?.items ?? EMPTY,
    /** Há mais vínculos do que a tela leu: quem calcula "sem tarifa" não pode afirmar ausência. */
    truncated: all.data?.truncated ?? false,
    lookup,
    tariffsById,
    isLoading: queries.some((q) => q.isLoading),
    error: queries.find((q) => q.isError)?.error ?? null,
    refetch: () => queries.forEach((q) => q.isError && q.refetch()),
  }
}
