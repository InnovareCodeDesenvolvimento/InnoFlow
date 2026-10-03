import { useEffect, useRef, useState, useSyncExternalStore, type PointerEventHandler } from "react"

/**
 * Hooks de movimento da landing, sem biblioteca (CSS + IntersectionObserver). `Reveal.tsx` usa `observeOnce`.
 *
 * Princípio: o HTML nasce com tudo VISÍVEL. O `Reveal` só esconde, por JS, o que está abaixo da dobra e só quando
 * o usuário NÃO pediu menos movimento — ver `landing.css`. Sem JS, ou com `prefers-reduced-motion: reduce`, o
 * conteúdo aparece pronto, no lugar.
 */

export const REDUCE_QUERY = "(prefers-reduced-motion: reduce)"

function subscribeReduce(onChange: () => void) {
  const media = window.matchMedia(REDUCE_QUERY)
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}
const getReduceSnapshot = () => window.matchMedia(REDUCE_QUERY).matches
const getReduceServerSnapshot = () => false

/** `true` quando o usuário pediu menos movimento (reage à mudança em tempo real). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, getReduceSnapshot, getReduceServerSnapshot)
}

/** Um único IntersectionObserver para todos os `Reveal` (dezenas de elementos, um observador). */
type RevealCallback = () => void
let sharedObserver: IntersectionObserver | null = null
const callbacks = new WeakMap<Element, RevealCallback>()

export function observeOnce(el: Element, cb: RevealCallback) {
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          callbacks.get(entry.target)?.()
          callbacks.delete(entry.target)
          sharedObserver?.unobserve(entry.target)
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    )
  }
  callbacks.set(el, cb)
  sharedObserver.observe(el)
}

export function unobserve(el: Element) {
  callbacks.delete(el)
  sharedObserver?.unobserve(el)
}


/** Marca `true` enquanto o elemento está (perto de) visível — usado para pausar loops fora da tela. */
export function useInView<T extends Element>(rootMargin = "100px 0px"): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { rootMargin })
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin])
  return [ref, inView]
}

/**
 * Número que sobe de 0 até `target` quando `active` vira `true` (ease-out). Com movimento reduzido mostra o valor
 * final direto. O progresso só é escrito dentro do callback do rAF (nunca síncrono no efeito).
 */
export function useCountUp(target: number, active: boolean, durationMs = 1100): number {
  const reduce = usePrefersReducedMotion()
  const [progress, setProgress] = useState(() => (typeof window !== "undefined" && window.matchMedia(REDUCE_QUERY).matches ? 1 : 0))
  useEffect(() => {
    if (reduce || !active) return
    let raf = 0
    let start = 0
    const tick = (now: number) => {
      if (!start) start = now
      const t = Math.min(1, (now - start) / durationMs)
      setProgress(t)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, reduce, durationMs])
  const eased = reduce ? 1 : 1 - (1 - progress) ** 3
  return Math.round(target * eased)
}

/**
 * Milissegundos desde que o componente montou, atualizados a cada `stepMs`. Com movimento reduzido devolve
 * `reducedValue` (um instante "meio da recarga" fixo, para o mockup mostrar números plausíveis e parados).
 * Monte o componente que usa isto só quando a animação deve (re)começar — o relógio nasce zerado.
 */
export function useElapsed(stepMs = 250, reducedValue = 0): number {
  const reduce = usePrefersReducedMotion()
  const [ms, setMs] = useState(0)
  useEffect(() => {
    if (reduce) return
    const t0 = performance.now()
    const id = window.setInterval(() => setMs(performance.now() - t0), stepMs)
    return () => window.clearInterval(id)
  }, [reduce, stepMs])
  return reduce ? reducedValue : ms
}

/** Escreve a posição do ponteiro em `--mx/--my` do card (o holofote `.lnd-spot` lê as variáveis; sem re-render). */
export const spotlightMove: PointerEventHandler<HTMLElement> = (e) => {
  if (e.pointerType === "touch") return
  const el = e.currentTarget
  const rect = el.getBoundingClientRect()
  el.style.setProperty("--mx", `${e.clientX - rect.left}px`)
  el.style.setProperty("--my", `${e.clientY - rect.top}px`)
}
