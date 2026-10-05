import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { legalService } from "@/services/legal"
import type { MeAcceptConsentsRequest } from "@/types/api"

export const legalKeys = {
  public: ["public", "legal"] as const,
  consents: ["me", "consents"] as const,
}

/**
 * Versões vigentes dos Termos/Privacidade e dados da empresa (`GET /api/public/legal`). Muda só em deploy (o servidor manda `Cache-Control: max-age=300`), então 5 min de
 * `staleTime` e SEM refetch em foco. `retry: 1`: a falha é mostrada (o cadastro não consegue mandar o aceite sem a versão), com botão para tentar de novo.
 * `enabled=false` não busca (telas que só precisam da versão quando a pessoa chega num passo específico).
 */
export function usePublicLegal(enabled = true) {
  return useQuery({
    queryKey: legalKeys.public,
    queryFn: () => legalService.getPublic(),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
    enabled,
  })
}

/**
 * Status do aceite do motorista (`GET /api/me/consents`). Só roda logado como DRIVER (`enabled`): a rota é DRIVER-only. Falha NÃO atrapalha o app (o aviso de novo aceite é
 * secundário): sem retry, sem refetch em foco.
 */
export function useMeConsents(enabled = true) {
  return useQuery({
    queryKey: legalKeys.consents,
    queryFn: () => legalService.getConsents(),
    enabled,
    staleTime: 10 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

/** `POST /api/me/consents`: o servidor devolve o status já atualizado, que vai direto para o cache (sem refetch). */
export function useAcceptConsents() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: MeAcceptConsentsRequest) => legalService.acceptConsents(payload),
    onSuccess: (status) => {
      queryClient.setQueryData(legalKeys.consents, status)
    },
  })
}
