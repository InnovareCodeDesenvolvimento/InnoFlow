import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { meService } from "@/services/me"
import { authService } from "@/services/auth"
import { useAuthStore } from "@/store/authStore"
import type { ChangePasswordRequest, MeProfile, UpdateMeProfileRequest } from "@/types/api"

export const profileKeys = {
  profile: ["me", "profile"] as const,
}

/**
 * Perfil do motorista (`GET /api/me/profile`). Fica sob `["me", ...]` de propósito: o que invalida "tudo do motorista" já o alcança.
 * Sem política própria de refetch: o `staleTime` global (60 s) basta - perfil muda raramente e só por esta tela.
 */
export function useMeProfile() {
  return useQuery({
    queryKey: profileKeys.profile,
    queryFn: () => meService.getProfile(),
  })
}

/**
 * `PATCH /api/me/profile`. O servidor devolve o DTO JÁ atualizado: ele vai direto para o cache (sem refetch). O nome também mora no `authStore` (é o que o
 * cabeçalho do app lê) - sem o `patchUser` o nome novo só apareceria no próximo login.
 */
export function useUpdateMeProfile() {
  const queryClient = useQueryClient()
  const patchUser = useAuthStore((s) => s.patchUser)
  return useMutation({
    mutationFn: (payload: UpdateMeProfileRequest) => meService.updateProfile(payload),
    // CPF e telefone são dado pessoal: `gcTime: 0` tira o corpo de `variables`/`MutationCache` assim que a tela chama `reset()` (mesmo cuidado do gateway, Órion B7).
    gcTime: 0,
    onSuccess: (profile: MeProfile) => {
      queryClient.setQueryData(profileKeys.profile, profile)
      patchUser({ name: profile.name })
    },
  })
}

/**
 * `POST /api/auth/password`. O servidor revoga TODOS os tokens (inclusive o desta aba) e devolve um novo: trocamos a sessão ANTES de qualquer outra coisa
 * (`replaceSession` grava o token no `localStorage`, de onde o interceptor e o SSE leem). Sem isso, a próxima chamada sairia com o token morto e deslogaria
 * quem acabou de trocar a senha. Em seguida o perfil em cache passa a dizer `hasPassword: true` (a conta só-Google deixa de ser "Definir senha").
 */
export function useChangePassword() {
  const queryClient = useQueryClient()
  const replaceSession = useAuthStore((s) => s.replaceSession)
  return useMutation({
    mutationFn: (payload: ChangePasswordRequest) => authService.changePassword(payload),
    // O corpo carrega a senha atual e a nova: `gcTime: 0` + `reset()` na tela impedem que fiquem 5 min em `variables`/`MutationCache` (mesmo cuidado do gateway, Órion B7).
    gcTime: 0,
    onSuccess: ({ token, user }) => {
      replaceSession(token, user)
      queryClient.setQueryData<MeProfile>(profileKeys.profile, (old) => (old ? { ...old, hasPassword: true } : old))
    },
  })
}
