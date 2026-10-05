import { useMutation } from "@tanstack/react-query"
import { authService } from "@/services/auth"
import type { ForgotPasswordRequest, ResetPasswordRequest } from "@/types/api"

/**
 * Esqueci / redefinir senha (L1.3). Mutations SEM cache: o corpo do `reset` carrega o token e a senha nova, e o do `forgot` o e-mail - `gcTime: 0` + `reset()` na tela
 * impedem que fiquem 5 min em `variables`/`MutationCache` (mesmo cuidado de `useChangePassword`).
 */
export function useForgotPassword() {
  return useMutation({ mutationFn: (payload: ForgotPasswordRequest) => authService.forgotPassword(payload), gcTime: 0 })
}

export function useResetPassword() {
  return useMutation({ mutationFn: (payload: ResetPasswordRequest) => authService.resetPassword(payload), gcTime: 0 })
}
