import { useEffect, useRef, useState, type ReactNode } from "react"
import { DriverTour } from "./DriverTour"
import { Faq } from "./Faq"
import { FinalCta } from "./FinalCta"
import { Features } from "./Features"
import { Benefits } from "./Benefits"
import { TrustSection } from "./TrustSection"
import { SLOT_KEYS, slotClass, type SlotKey } from "./landing-slots"

/** Seções abaixo da dobra (mesma ordem de `SLOT_KEYS`). Cada uma é montada numa tarefa própria (ver `useStagedMount`). */
const SECTIONS: Record<SlotKey, () => ReactNode> = {
  tour: () => <DriverTour />,
  adv: () => <Benefits />,
  feat: () => <Features />,
  trust: () => <TrustSection />,
  faq: () => <Faq />,
  cta: () => <FinalCta />,
}

/**
 * Monta as seções UMA POR VEZ, cada uma num callback ocioso/quadro próprio: o conjunto inteiro tem ~1.200 nós de DOM e
 * montá-lo de uma vez era uma tarefa longa (bloqueio de entrada, medido). Fatiado, nenhuma tarefa passa de ~1/6 disso.
 * A ordem NÃO é fixa: a cada fatia entra a seção mais PRÓXIMA do que a pessoa está vendo — quem rola rápido até o meio
 * da página não espera as de cima para ver o que está na tela. Com âncora na URL (`/#recursos`) tudo é montado de uma
 * vez para a rolagem cair no lugar certo.
 */
function useStagedMount(slots: React.RefObject<Array<HTMLElement | null>>, immediate: boolean): ReadonlySet<SlotKey> {
  const [mounted, setMounted] = useState<ReadonlySet<SlotKey>>(() => new Set(immediate ? SLOT_KEYS : []))
  useEffect(() => {
    if (mounted.size >= SLOT_KEYS.length) return
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    const next = () => {
      const center = window.innerHeight / 2
      let best: SlotKey | null = null
      let bestDistance = Infinity
      SLOT_KEYS.forEach((key, i) => {
        if (mounted.has(key)) return
        const el = slots.current[i]
        if (!el) return
        const rect = el.getBoundingClientRect()
        const distance = rect.top > center ? rect.top - center : rect.bottom < center ? center - rect.bottom : 0
        if (distance < bestDistance) {
          best = key
          bestDistance = distance
        }
      })
      if (best) setMounted((prev) => new Set(prev).add(best as SlotKey))
    }
    // `timeout`: se o navegador nunca ficar ocioso (rolagem contínua), ainda assim avança.
    const id = typeof w.requestIdleCallback === "function" ? w.requestIdleCallback(next, { timeout: 600 }) : window.setTimeout(next, 50)
    return () => {
      if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(id)
      else window.clearTimeout(id)
    }
  }, [mounted, slots])
  return mounted
}

export default function BelowFold() {
  const hasHash = typeof window !== "undefined" && window.location.hash.length > 1
  const slots = useRef<Array<HTMLElement | null>>([])
  const mounted = useStagedMount(slots, hasHash)

  // Link direto para uma seção (`/#recursos`): quando o navegador tenta rolar até a âncora, estas seções ainda não
  // existem (chunk carregando) e ele desiste em silêncio. Ao montar, rolamos nós mesmos.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])

  // Os espaços (`.lnd-slot-*`, altura reservada) existem desde o início e PERSISTEM: a seção entra dentro do espaço dela.
  return (
    <>
      {SLOT_KEYS.map((key, i) => (
        <div
          key={key}
          ref={(el) => {
            slots.current[i] = el
          }}
          className={slotClass(key)}
        >
          {mounted.has(key) ? SECTIONS[key]() : null}
        </div>
      ))}
    </>
  )
}
