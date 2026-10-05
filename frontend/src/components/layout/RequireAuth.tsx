import { Navigate, useLocation } from "react-router-dom"
import { AccessDenied } from "@/components/feedback/AccessDenied"
import { useAuthStore } from "@/store/authStore"
import type { Role } from "@/types/api"

/**
 * Guarda de rota: exige login e, opcionalmente, um papel específico. Sem
 * isto, um visitante sem token acessando `/admin` via URL veria as queries
 * falharem com 401 em vez de ser mandado ao login — e depois de autenticar
 * volta para a rota que pretendia.
 */
export function RequireAuth({ children, roles }: { children: React.ReactNode; roles?: Role[] }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const user = useAuthStore((s) => s.user)
  const location = useLocation()

  if (!isAuthenticated) {
    const redirect = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?redirect=${redirect}`} replace />
  }

  if (roles && (!user || !roles.includes(user.role))) {
    return <AccessDenied description="Você não tem permissão para acessar esta área." />
  }

  return <>{children}</>
}
