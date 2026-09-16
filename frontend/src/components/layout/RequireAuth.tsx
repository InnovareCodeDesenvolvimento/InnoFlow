import { Link, Navigate, useLocation } from "react-router-dom"
import { ShieldAlert } from "lucide-react"
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
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-danger-100">
          <ShieldAlert className="h-8 w-8 text-danger-600" aria-hidden="true" />
        </div>
        <p className="text-lg font-bold text-ink">Acesso restrito</p>
        <p className="mb-5 mt-1 text-sm text-ink-softer">Você não tem permissão para acessar esta área.</p>
        <Link to="/" className="text-sm font-medium text-primary hover:underline">
          Voltar ao início
        </Link>
      </div>
    )
  }

  return <>{children}</>
}
