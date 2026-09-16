import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { connectorsService } from "@/services/connectors"
import type { CreateConnectorInput, PaginationParams, UpdateConnectorInput } from "@/types/api"

export const connectorsKeys = {
  all: ["connectors"] as const,
  list: (params: PaginationParams) => [...connectorsKeys.all, "list", params] as const,
}

export function useConnectors(params: PaginationParams = {}) {
  return useQuery({
    queryKey: connectorsKeys.list(params),
    queryFn: () => connectorsService.list(params),
    placeholderData: (prev) => prev,
  })
}

export function useCreateConnector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateConnectorInput) => connectorsService.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectorsKeys.all }),
  })
}

export function useUpdateConnector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateConnectorInput }) => connectorsService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectorsKeys.all }),
  })
}

export function useDeleteConnector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => connectorsService.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectorsKeys.all }),
  })
}
