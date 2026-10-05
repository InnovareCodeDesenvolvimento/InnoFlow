import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { accountDeletionsService } from "@/services/accountDeletions"
import type { AdminAccountDeletionRefundRequest, AdminAccountDeletionRow, AdminAccountDeletionsQuery, PaginatedResponse } from "@/types/api"

export const accountDeletionsKeys = {
  all: ["admin", "account-deletions"] as const,
  list: (params: AdminAccountDeletionsQuery) => ["admin", "account-deletions", "list", params] as const,
}

/**
 * Fila de devoluções de contas excluídas. A resposta traz a CHAVE PIX decifrada (dado de titular) e cada GET é AUDITADO no backend: então esta query NÃO refaz sozinha (sem
 * refetch em foco/reconexão, sem polling, sem retry) e `gcTime: 0` joga o cache fora ao sair da tela — a chave nunca fica guardada no navegador além da visita. Refaz só quando
 * o ADMIN pede (trocar de página/filtro, "Atualizar") ou depois de registrar uma devolução.
 */
export function useAccountDeletions(params: AdminAccountDeletionsQuery) {
  return useQuery({
    queryKey: accountDeletionsKeys.list(params),
    queryFn: () => accountDeletionsService.list(params),
    placeholderData: (prev) => prev,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}

/**
 * Registra a devolução (integral). `gcTime: 0` + `reset()` na tela: o corpo leva a senha do ADMIN.
 *
 * Sucesso ATUALIZA o cache com a linha devolvida (em vez de refazer o GET): refazer releria — e AUDITARIA de novo — as chaves Pix dos demais pedidos pendentes. Na fila de
 * pendentes a linha sai (e o total desce); numa lista que mostra também os devolvidos, ela vira `REFUNDED` sem chave.
 */
export function useRefundAccountDeletion() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: ({ requestId, ...payload }: AdminAccountDeletionRefundRequest & { requestId: string }) => accountDeletionsService.refund(requestId, payload),
    onSuccess: (row) => {
      for (const query of queryClient.getQueryCache().findAll({ queryKey: accountDeletionsKeys.all })) {
        const params = query.queryKey[3] as AdminAccountDeletionsQuery | undefined
        queryClient.setQueryData<PaginatedResponse<AdminAccountDeletionRow>>(query.queryKey, (old) => {
          if (!old) return old
          const leavesQueue = params?.status === "PENDING_REFUND"
          const items = leavesQueue ? old.items.filter((i) => i.id !== row.id) : old.items.map((i) => (i.id === row.id ? row : i))
          const removed = old.items.length - items.length
          return { ...old, items, meta: { ...old.meta, total: Math.max(0, old.meta.total - removed) } }
        })
      }
    },
  })
}
