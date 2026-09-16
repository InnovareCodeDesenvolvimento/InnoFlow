import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { tariffsService } from "@/services/tariffs"
import type { CreateTariffInput, PaginationParams, UpdateTariffInput } from "@/types/api"

export const tariffsKeys = {
  all: ["tariffs"] as const,
  list: (params: PaginationParams) => [...tariffsKeys.all, "list", params] as const,
}

export function useTariffs(params: PaginationParams = {}) {
  return useQuery({
    queryKey: tariffsKeys.list(params),
    queryFn: () => tariffsService.list(params),
    placeholderData: (prev) => prev,
  })
}

export function useCreateTariff() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateTariffInput) => tariffsService.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tariffsKeys.all }),
  })
}

export function useUpdateTariff() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateTariffInput }) => tariffsService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tariffsKeys.all }),
  })
}

export function useDeleteTariff() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => tariffsService.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tariffsKeys.all }),
  })
}
