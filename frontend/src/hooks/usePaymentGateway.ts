import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { paymentGatewayService } from "@/services/paymentGateway"
import type { UpdatePaymentGatewayConfigRequest } from "@/types/api"

export const paymentGatewayKeys = {
  config: ["admin", "payment-gateway"] as const,
}

/**
 * Configuração atual do gateway. Sem refetch em foco/reconexão: o rascunho da
 * tela é local (sobreposição sobre este dado), e a prontidão que o servidor
 * calcula só muda quando o próprio admin salva — refazer a cada foco só
 * geraria tráfego numa tela de uso raro. Sem retry: 403/503 não melhoram
 * tentando de novo.
 */
export function usePaymentGatewayConfig() {
  return useQuery({
    queryKey: paymentGatewayKeys.config,
    queryFn: () => paymentGatewayService.get(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}

/**
 * Salva e já escreve a resposta (DTO atualizado) no cache — a tela reflete o novo estado na hora — e invalida para reconferir com o servidor.
 *
 * `gcTime: 0` (Órion B7): o corpo do PUT carrega SEGREDOS e a SENHA ATUAL, e o TanStack Query guarda esse corpo em `variables`
 * (na mutation e no `MutationCache`) por 5 minutos depois de a tela largá-la. Com `gcTime: 0` a mutation sai do cache assim
 * que termina e perde o observador (a tela chama `reset()`); coberto por `usePaymentGateway.test.tsx`.
 */
export function useUpdatePaymentGateway() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (payload: UpdatePaymentGatewayConfigRequest) => paymentGatewayService.update(payload),
    onSuccess: (dto) => {
      queryClient.setQueryData(paymentGatewayKeys.config, dto)
      void queryClient.invalidateQueries({ queryKey: paymentGatewayKeys.config })
    },
  })
}
