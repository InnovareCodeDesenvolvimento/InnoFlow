import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { tariffAssignmentsService } from "@/services/tariffAssignments"
import type {
  CreateTariffAssignmentInput,
  TariffAssignment,
  TariffAssignmentListParams,
  UpdateTariffAssignmentInput,
} from "@/types/api"

export const tariffAssignmentsKeys = {
  all: ["tariffAssignments"] as const,
  list: (params: TariffAssignmentListParams) => [...tariffAssignmentsKeys.all, "list", params] as const,
  everything: () => [...tariffAssignmentsKeys.all, "everything"] as const,
}

/** Teto de páginas (100 vínculos cada) lido por `useAllTariffAssignments` — passou disso o resultado vem marcado `truncated`. */
const MAX_PAGES = 20

export function useTariffAssignments(params: TariffAssignmentListParams = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: tariffAssignmentsKeys.list(params),
    queryFn: () => tariffAssignmentsService.list(params),
    placeholderData: (prev) => prev,
    enabled: options.enabled ?? true,
  })
}

export interface AllTariffAssignments {
  items: TariffAssignment[]
  /** `true` = existem mais vínculos do que o teto lido; quem calcula "sem tarifa" a partir da lista NÃO pode afirmar ausência. */
  truncated: boolean
}

/**
 * Todos os vínculos visíveis ao usuário (ADMIN = todos os operadores; OPERATOR = o próprio). A API não tem um filtro
 * "tudo que vale para este carregador" (só um campo por vez), então "qual tarifa vale" é calculado no cliente sobre
 * a lista completa — a mesma regra de `resolveActiveTariff` do servidor (ver `lib/tariffAssignments.ts`).
 */
export function useAllTariffAssignments() {
  return useQuery({
    queryKey: tariffAssignmentsKeys.everything(),
    queryFn: async (): Promise<AllTariffAssignments> => {
      const first = await tariffAssignmentsService.list({ page: 1, pageSize: 100 })
      const items = [...first.items]
      const lastPage = Math.min(first.meta.totalPages, MAX_PAGES)
      for (let page = 2; page <= lastPage; page++) {
        items.push(...(await tariffAssignmentsService.list({ page, pageSize: 100 })).items)
      }
      return { items, truncated: first.meta.totalPages > MAX_PAGES }
    },
  })
}

export function useCreateTariffAssignment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateTariffAssignmentInput) => tariffAssignmentsService.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tariffAssignmentsKeys.all }),
  })
}

export function useUpdateTariffAssignment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateTariffAssignmentInput }) => tariffAssignmentsService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tariffAssignmentsKeys.all }),
  })
}

/** `DELETE` expira o vínculo (`validTo = agora`) — não apaga a linha. */
export function useRemoveTariffAssignment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => tariffAssignmentsService.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tariffAssignmentsKeys.all }),
  })
}
