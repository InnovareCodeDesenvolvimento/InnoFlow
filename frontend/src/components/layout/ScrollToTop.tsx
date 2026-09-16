import { useEffect } from "react"
import { useLocation } from "react-router-dom"

/** Volta o scroll ao topo a cada troca de rota — sem isto, navegar de uma lista rolada para outra tela mantinha a posição antiga. */
export function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}
