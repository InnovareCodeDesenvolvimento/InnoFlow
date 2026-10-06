import { useEffect } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { rememberReturnTo } from "@/lib/authRedirect"

/**
 * Link antigo/favorito `/login?redirect=/x` (ou `/cadastro?redirect=/x`): aceita UMA vez. O valor é validado (`safeRedirect`, dentro de `rememberReturnTo`) e guardado
 * como destino de retorno; um valor hostil (`//evil`, `\`, controle) é descartado. Em qualquer caso o parâmetro sai da barra (`replace`), que passa a mostrar `/login` limpo.
 * O estado da rota (avisos de "senha alterada"/"conta excluída") é preservado.
 */
export function useAbsorbLegacyRedirect() {
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const legacy = params.get("redirect")

  useEffect(() => {
    if (legacy === null) return
    rememberReturnTo(legacy)
    const rest = new URLSearchParams(location.search)
    rest.delete("redirect")
    const search = rest.toString()
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true, state: location.state })
  }, [legacy, location.pathname, location.search, location.state, navigate])
}
