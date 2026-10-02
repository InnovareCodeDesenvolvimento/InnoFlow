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

/** Salva e já escreve a resposta (DTO atualizado) no cache — a tela reflete o novo estado na hora — e invalida para reconferir com o servidor. */
export function useUpdatePaymentGateway() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: UpdatePaymentGatewayConfigRequest) => paymentGatewayService.update(payload),
    onSuccess: (dto) => {
      queryClient.setQueryData(paymentGatewayKeys.config, dto)
      void queryClient.invalidateQueries({ queryKey: paymentGatewayKeys.config })
    },
  })
}
