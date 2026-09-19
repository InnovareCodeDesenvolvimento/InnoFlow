import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { driversService } from "@/services/drivers"
import type { DriversListQuery, DriverWalletQuery, WalletAdjustmentRequest } from "@/types/api"

export const driversKeys = {
  all: ["drivers"] as const,
  lists: ["drivers", "list"] as const,
  list: (params: DriversListQuery) => [...driversKeys.lists, params] as const,
  wallets: (driverId: string) => ["drivers", "wallet", driverId] as const,
  wallet: (driverId: string, params: DriverWalletQuery) => [...driversKeys.wallets(driverId), params] as const,
}

/** Listagem geral NÃO é auditada no backend (só o extrato individual é) — pode refazer à vontade (foco, evento). `enabled` = false enquanto o OPERATOR não digitou o mínimo da busca. */
export function useDrivers(params: DriversListQuery, enabled = true) {
  return useQuery({
    queryKey: driversKeys.list(params),
    queryFn: () => driversService.list(params),
    enabled,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  })
}

/**
 * Extrato de UM motorista. Cada GET aqui vira uma linha de AUDITORIA no backend
 * ("ver o extrato de uma pessoa é auditável", decisão do dono) — então esta
 * query NÃO refaz sozinha: sem refetch em foco/reconexão, sem polling, sem
 * invalidação por evento em tempo real, sem retry. Refaz só quando alguém pede:
 * abrir o extrato (`gcTime: 0` joga o cache fora ao fechar — cada abertura é uma
 * consulta de verdade), trocar de página, "Atualizar" ou depois de um ajuste.
 */
export function useDriverWallet(driverId: string | null, params: DriverWalletQuery) {
  return useQuery({
    queryKey: driversKeys.wallet(driverId ?? "", params),
    queryFn: () => driversService.wallet(driverId as string, params),
    enabled: !!driverId,
    placeholderData: (prev) => prev,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}

/** Ajuste manual de saldo (ADMIN). Sucesso invalida a lista (saldo mudou) e o extrato desse motorista. */
export function useWalletAdjustment(driverId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: WalletAdjustmentRequest) => driversService.adjust(driverId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driversKeys.lists })
      void queryClient.invalidateQueries({ queryKey: driversKeys.wallets(driverId) })
    },
  })
}
