import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { companyProfileService } from "@/services/companyProfile"
import type { UpdateCompanyProfileRequest } from "@/types/api"

export const companyProfileKeys = {
  profile: ["admin", "company-profile"] as const,
}

/** Dados da empresa. Sem refetch em foco/reconexão (o rascunho da tela é local) e sem retry: 403/503 não melhoram tentando de novo. Nada aqui é segredo. */
export function useCompanyProfile() {
  return useQuery({
    queryKey: companyProfileKeys.profile,
    queryFn: () => companyProfileService.get(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}

/** Salva e escreve a resposta (DTO atualizado) no cache. O DTO de comunicação não muda com isto. */
export function useUpdateCompanyProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: UpdateCompanyProfileRequest) => companyProfileService.update(payload),
    onSuccess: (dto) => {
      queryClient.setQueryData(companyProfileKeys.profile, dto)
    },
  })
}
