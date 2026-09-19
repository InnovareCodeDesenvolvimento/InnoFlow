import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { sitesService } from "@/services/sites"
import { useAuthStore } from "@/store/authStore"
import { useRealtimeHealthy } from "@/store/realtimeStore"
import type { CreateSiteInput, PaginationParams, PublicSitesQuery, UpdateSiteInput } from "@/types/api"

export const sitesKeys = {
  all: ["sites", "admin"] as const,
  list: (params: PaginationParams) => [...sitesKeys.all, "list", params] as const,
}

export const publicSitesKeys = {
  all: ["sites", "public"] as const,
  list: (params: PublicSitesQuery) => [...publicSitesKeys.all, "list", params] as const,
}

/**
 * `GET /api/sites` — público, ÚNICO caminho de dados das estações (lista
 * pública, "Perto de você" da Home e a aba Mapa; ver
 * `decisoes-mapa-eletropostos.md` item 1 — nada de segundo endpoint pro
 * mesmo número).
 *
 * Tempo real: `chargepoint.status` invalida esta query quando o carregador
 * está na lista carregada (`lib/realtimeEventHandlers.ts`); o polling é a
 * rede de segurança, função da saúde do stream — motorista logado com stream
 * fora do ar 20s; stream saudável OU visitante anônimo (não existe SSE
 * público) 60s.
 */
export function usePublicSites(params: PublicSitesQuery = {}, options: { enabled?: boolean } = {}) {
  const realtimeHealthy = useRealtimeHealthy()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery({
    queryKey: publicSitesKeys.list(params),
    queryFn: () => sitesService.listPublic(params),
    placeholderData: (prev) => prev,
    enabled: options.enabled ?? true,
    staleTime: 15_000,
    refetchInterval: isAuthenticated && !realtimeHealthy ? 20_000 : 60_000,
    refetchIntervalInBackground: false,
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
