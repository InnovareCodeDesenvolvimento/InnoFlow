import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { meService } from "@/services/me"
import type { MeCreatePaymentMethodRequest } from "@/types/api"

export const paymentMethodsKeys = {
  list: ["me", "paymentMethods"] as const,
}

/**
 * `enabled` explícito (default `true`, mesmo padrão de `useMeWallet`) — a
 * tela de iniciar recarga (`ChargePointLanding`, F5.4) precisa desligar esta
 * query para visitante anônimo/ADMIN/OPERATOR, senão bate 401/403 à toa a
 * cada render nessa tela pública.
 */
export function useMePaymentMethods(enabled = true) {
  return useQuery({
    queryKey: paymentMethodsKeys.list,
    queryFn: () => meService.listPaymentMethods(),
    enabled,
  })
}

/** Uma sessão por clique — o componente chamador decide quando abrir a aba isolada com o resultado. */
export function useCreateTokenizationSession() {
  return useMutation({
    mutationFn: () => meService.createTokenizationSession(),
  })
}

export function useAddPaymentMethod() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: MeCreatePaymentMethodRequest) => meService.createPaymentMethod(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: paymentMethodsKeys.list }),
  })
}

export function useSetDefaultPaymentMethod() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => meService.setDefaultPaymentMethod(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: paymentMethodsKeys.list }),
  })
}

export function useRemovePaymentMethod() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => meService.deletePaymentMethod(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: paymentMethodsKeys.list }),
  })
}
