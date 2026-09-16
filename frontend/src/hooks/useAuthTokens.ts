import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { authTokensService } from "@/services/authTokens"
import type { CreateAuthTokenInput, PaginationParams, UpdateAuthTokenInput } from "@/types/api"

export const authTokensKeys = {
  all: ["authTokens"] as const,
  list: (params: PaginationParams) => [...authTokensKeys.all, "list", params] as const,
}

export function useAuthTokens(params: PaginationParams = {}) {
  return useQuery({
    queryKey: authTokensKeys.list(params),
    queryFn: () => authTokensService.list(params),
    placeholderData: (prev) => prev,
  })
}

export function useCreateAuthToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateAuthTokenInput) => authTokensService.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authTokensKeys.all }),
  })
}

export function useUpdateAuthToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateAuthTokenInput }) => authTokensService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authTokensKeys.all }),
  })
}

export function useDeleteAuthToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => authTokensService.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authTokensKeys.all }),
  })
}
