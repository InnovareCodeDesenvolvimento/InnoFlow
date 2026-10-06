import { useEffect } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { rememberReturnTo } from "@/lib/authRedirect"

/**
 * Manda quem está sem sessão para `/login` LIMPO (sem `?redirect=`) e guarda, em `sessionStorage`, a rota onde estava para o login devolvê-lo
 * (`lib/authRedirect.ts`). Gravar é efeito colateral, então acontece no efeito (não no render) e antes de navegar; é idempotente (StrictMode roda duas vezes).
 * `to` só é preciso quando o destino não é a rota atual.
 */
export function RedirectToLogin({ to }: { to?: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const destino = to ?? `${location.pathname}${location.search}`

  useEffect(() => {
    rememberReturnTo(destino)
    navigate("/login", { replace: true })
  }, [destino, navigate])

  return null
}
