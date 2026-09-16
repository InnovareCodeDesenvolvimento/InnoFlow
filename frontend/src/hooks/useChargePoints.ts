import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { chargePointsService } from "@/services/chargePoints"
import { getApiErrorMessage } from "@/services/api"
import type { ChangeAvailabilityParams, ResetCommandParams, TriggerMessageParams, UnlockCommandParams } from "@/services/chargePoints"
import type { ChargePointCommandType, CreateChargePointInput, PaginationParams, UpdateChargePointInput } from "@/types/api"

export const chargePointsKeys = {
  all: ["chargePoints"] as const,
  list: (params: PaginationParams) => [...chargePointsKeys.all, "list", params] as const,
}

export function useChargePoints(params: PaginationParams = {}) {
  return useQuery({
    queryKey: chargePointsKeys.list(params),
    queryFn: () => chargePointsService.list(params),
    placeholderData: (prev) => prev,
  })
}

export function useCreateChargePoint() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateChargePointInput) => chargePointsService.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chargePointsKeys.all }),
  })
}

export function useUpdateChargePoint() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateChargePointInput }) =>
      chargePointsService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chargePointsKeys.all }),
  })
}

export function useDeleteChargePoint() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => chargePointsService.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chargePointsKeys.all }),
  })
}

/**
 * Dispara um comando remoto (reset/unlock/change-availability/trigger-message).
 * O toast de sucesso é deliberadamente "comando enviado" — não "concluído":
 * a resposta 202 só confirma o enfileiramento, o carregador pode nunca
 * confirmar (offline, timeout) e não há canal de volta nesta fase.
 */
export function useSendChargePointCommand() {
  return useMutation({
    mutationFn: ({
      id,
      command,
      params,
    }: {
      id: string
      command: ChargePointCommandType
      params?: ResetCommandParams | UnlockCommandParams | ChangeAvailabilityParams | TriggerMessageParams
    }) => chargePointsService.sendCommand(id, command, params),
    onSuccess: () => {
      toast.success("Comando enviado ao carregador.", {
        description: "Sem confirmação em tempo real nesta fase — acompanhe pelos logs do operador.",
      })
    },
    onError: (err) => {
      toast.error("Não foi possível enviar o comando.", { description: getApiErrorMessage(err) })
    },
  })
}
