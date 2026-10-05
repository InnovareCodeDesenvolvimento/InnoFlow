import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { reversalsService } from "@/services/reversals"
import type {
  CancelRefundRequest,
  ChargebacksListQuery,
  ConfirmRefundRequest,
  CreateChargebackRequest,
  CreateSessionRefundRequest,
  UnblockCardRequest,
  UpdateChargebackRequest,
} from "@/types/api"

export const reversalsKeys = {
  refundsOf: (sessionId: string) => ["admin", "refunds", sessionId] as const,
  chargebacks: ["admin", "chargebacks"] as const,
  chargebackList: (params: ChargebacksListQuery) => ["admin", "chargebacks", "list", params] as const,
}

/**
 * Devoluções de UMA sessão (ADMIN). Sem refetch em foco/reconexão e sem retry: 403 (OPERATOR) e 404 não melhoram tentando de novo, e o que muda o estado (registrar,
 * confirmar, cancelar) invalida de propósito. `gcTime: 0` — a lista traz o motivo digitado pelo ADMIN; não sobrevive à tela.
 */
export function useSessionRefunds(sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: reversalsKeys.refundsOf(sessionId ?? ""),
    queryFn: () => reversalsService.sessionRefunds(sessionId as string),
    enabled: enabled && Boolean(sessionId),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}

/**
 * MUTATIONS COM SENHA (e motivo em texto livre): `gcTime: 0` + a tela chama `reset()` ao terminar — o TanStack Query guarda o corpo em `variables` por 5 minutos, e ali estaria a
 * senha do ADMIN (mesmo cuidado do gateway; coberto por `useReversals.test.tsx`).
 */
export function useCreateRefund(sessionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (payload: CreateSessionRefundRequest) => reversalsService.createRefund(sessionId, payload),
    // Também no ERRO: um 409 de teto (`AMOUNT_EXCEEDS_REFUNDABLE`) quer dizer que outra devolução entrou — a tela precisa do teto atual para corrigir o valor.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: reversalsKeys.refundsOf(sessionId) }),
    onSuccess: () => {
      // `cardRefundedCents` (informativo) e o saldo do motorista (estorno na carteira) mudam.
      void queryClient.invalidateQueries({ queryKey: ["reports", "payments"] })
      void queryClient.invalidateQueries({ queryKey: ["drivers"] })
    },
  })
}

export function useCancelRefund(sessionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: ({ refundId, ...payload }: CancelRefundRequest & { refundId: string }) => reversalsService.cancelRefund(refundId, payload),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: reversalsKeys.refundsOf(sessionId) }),
  })
}

export function useConfirmRefund(sessionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: ({ refundId, ...payload }: ConfirmRefundRequest & { refundId: string }) => reversalsService.confirmRefund(refundId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reversalsKeys.refundsOf(sessionId) })
      void queryClient.invalidateQueries({ queryKey: ["reports", "payments"] })
    },
  })
}

/**
 * Lista de chargebacks. NÃO é auditada (só o dossiê é), então pode refazer em foco; mas é tela de uso raro: sem polling. `placeholderData` mantém a página anterior ao trocar filtro.
 */
export function useChargebacks(params: ChargebacksListQuery) {
  return useQuery({
    queryKey: reversalsKeys.chargebackList(params),
    queryFn: () => reversalsService.listChargebacks(params),
    placeholderData: (prev) => prev,
    retry: false,
  })
}

/** Registrar NÃO pede senha (contrato) e bloqueia o cartão do motorista na hora; invalida a lista e o relatório de pagamentos. */
export function useRegisterChargeback() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: ({ paymentIntentId, ...payload }: CreateChargebackRequest & { paymentIntentId: string }) => reversalsService.registerChargeback(paymentIntentId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reversalsKeys.chargebacks })
      void queryClient.invalidateQueries({ queryKey: ["reports", "payments"] })
    },
  })
}

export function useResolveChargeback() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: ({ chargebackId, ...payload }: UpdateChargebackRequest & { chargebackId: string }) => reversalsService.resolveChargeback(chargebackId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reversalsKeys.chargebacks })
      // Dívida criada (CREATE_DEBT) muda o saldo/dívida do motorista nas Carteiras.
      void queryClient.invalidateQueries({ queryKey: ["drivers"] })
    },
  })
}

export function useUnblockCard() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: ({ chargebackId, ...payload }: UnblockCardRequest & { chargebackId: string }) => reversalsService.unblockCard(chargebackId, payload),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: reversalsKeys.chargebacks }),
  })
}
