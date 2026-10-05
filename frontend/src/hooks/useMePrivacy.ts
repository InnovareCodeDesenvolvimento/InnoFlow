import { useMutation, useQuery } from "@tanstack/react-query"
import { downloadJson } from "@/lib/download"
import { exportFileName } from "@/lib/accountDeletion"
import { meService } from "@/services/me"
import type { MeAccountDeletionRequest } from "@/types/api"

/**
 * `GET /api/me/data-export` + download. O arquivo é baixado DENTRO da `mutationFn` e nada é devolvido: a cópia dos dados (dado pessoal inteiro, inclusive o CPF) não fica
 * em `data` do React Query nem na `MutationCache`. `gcTime: 0` pelo mesmo motivo (mesmo cuidado do gateway/perfil, Órion B7).
 */
export function useExportMyData() {
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const data = await meService.exportData()
      downloadJson(data, exportFileName())
    },
    gcTime: 0,
  })
}

/**
 * `POST /api/me/account/deletion`. O corpo carrega a senha atual (ou a credencial do Google) e a chave Pix: `gcTime: 0` + `reset()` na tela impedem que fiquem em
 * `variables`/`MutationCache`. NÃO mexe na sessão: quem chama decide o que fazer depois do 200 (limpar o estado e ir ao login) - e só ali, nunca num erro.
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: (payload: MeAccountDeletionRequest) => meService.deleteAccount(payload),
    gcTime: 0,
  })
}

/**
 * Saldo e dívida NA HORA em que o diálogo de exclusão abre. Consulta própria e sempre fresca (`staleTime: 0`, `gcTime: 0`): a decisão "precisa de chave Pix?" e "tem dívida?" não pode
 * vir de um cache de minutos atrás. Pede 1 lançamento só (a tela só lê `balanceCents` e `openDebtCents`). A chave fica sob `["me", ...]` como o resto da carteira.
 */
export function useBalanceForDeletion(enabled: boolean) {
  return useQuery({
    queryKey: ["me", "wallet", "deletion-check"] as const,
    queryFn: () => meService.wallet({ page: 1, pageSize: 1 }),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
    refetchOnWindowFocus: false,
  })
}
