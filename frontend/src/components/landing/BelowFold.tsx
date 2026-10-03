import { useEffect, useState, type ReactNode } from "react"
import { DriverTour } from "./DriverTour"
import { Faq } from "./Faq"
import { FinalCta } from "./FinalCta"
import { Features } from "./Features"
import { OperatorSection } from "./OperatorSection"
import { TrustSection } from "./TrustSection"

/** Seções abaixo da dobra, em ordem. Cada uma é montada numa tarefa própria (ver `useStagedCount`). */
const SECTIONS: Array<() => ReactNode> = [
  () => <DriverTour key="tour" />,
  () => <OperatorSection key="op" />,
  () => <Features key="features" />,
  () => <TrustSection key="trust" />,
  () => <Faq key="faq" />,
  () => <FinalCta key="cta" />,
]

/**
 * Monta as seções UMA POR VEZ, cada uma num callback ocioso/quadro próprio: o conjunto inteiro tem ~1.200 nós de DOM e
 * montá-lo de uma vez era uma tarefa longa (bloqueio de entrada, medido). Fatiado, nenhuma tarefa passa de ~1/6 disso.
 * Com âncora na URL (`/#recursos`) tudo é montado de uma vez para a rolagem cair no lugar certo.
 */
function useStagedCount(total: number, immediate: boolean): number {
  const [count, setCount] = useState(immediate ? total : 1)
  useEffect(() => {
    if (count >= total) return
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    const next = () => setCount((c) => Math.min(total, c + 1))
    // `timeout`: se o navegador nunca ficar ocioso (rolagem contínua), ainda assim avança.
    const id = typeof w.requestIdleCallback === "function" ? w.requestIdleCallback(next, { timeout: 600 }) : window.setTimeout(next, 50)
    return () => {
      if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(id)
      else window.clearTimeout(id)
    }
  }, [count, total])
  return count
}

export default function BelowFold() {
  const hasHash = typeof window !== "undefined" && window.location.hash.length > 1
  const count = useStagedCount(SECTIONS.length, hasHash)

  // Link direto para uma seção (`/#recursos`): quando o navegador tenta rolar até a âncora, estas seções ainda não
  // existem (chunk carregando) e ele desiste em silêncio. Ao montar, rolamos nós mesmos.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])

  return <>{SECTIONS.slice(0, count).map((render) => render())}</>
}
