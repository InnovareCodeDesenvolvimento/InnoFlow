import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { sitesService } from "@/services/sites"
import type { CreateSiteInput, PaginationParams, PublicSitesQuery, UpdateSiteInput } from "@/types/api"

export const sitesKeys = {
  all: ["sites", "admin"] as const,
  list: (params: PaginationParams) => [...sitesKeys.all, "list", params] as const,
}

export const publicSitesKeys = {
  all: ["sites", "public"] as const,
  list: (params: PublicSitesQuery) => [...publicSitesKeys.all, "list", params] as const,
}

/** `GET /api/sites` — público, usado pela listagem de eletropostos do motorista. */
export function usePublicSites(params: PublicSitesQuery = {}) {
  return useQuery({
    queryKey: publicSitesKeys.list(params),
    queryFn: () => sitesService.listPublic(params),
    placeholderData: (prev) => prev,
  })
}

export function useSites(params: PaginationParams = {}) {
  return useQuery({
    queryKey: sitesKeys.list(params),
    queryFn: () => sitesService.list(params),
    placeholderData: (prev) => prev,
  })
}

export function useCreateSite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateSiteInput) => sitesService.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sitesKeys.all }),
  })
}

export function useUpdateSite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateSiteInput }) => sitesService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sitesKeys.all }),
  })
}

export function useDeleteSite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sitesService.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sitesKeys.all }),
  })
}
