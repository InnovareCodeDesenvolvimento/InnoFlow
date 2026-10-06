import { RedirectToLogin } from "@/components/layout/RedirectToLogin"
import { AccessDenied } from "@/components/feedback/AccessDenied"
import { useAuthStore } from "@/store/authStore"
import type { Role } from "@/types/api"

/**
 * Guarda de rota: exige login e, opcionalmente, um papel específico. Sem
 * isto, um visitante sem token acessando `/admin` via URL veria as queries
 * falharem com 401 em vez de ser mandado ao login — e depois de autenticar
 * volta para a rota que pretendia (guardada em `sessionStorage`, o `/login` fica limpo).
 */
export function RequireAuth({ children, roles }: { children: React.ReactNode; roles?: Role[] }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const user = useAuthStore((s) => s.user)

  if (!isAuthenticated) {
    return <RedirectToLogin />
  }

  if (roles && (!user || !roles.includes(user.role))) {
    return <AccessDenied description="Você não tem permissão para acessar esta área." />
  }

  return <>{children}</>
}
