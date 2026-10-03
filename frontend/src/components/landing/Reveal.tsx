import { useEffect, useRef, type CSSProperties, type PointerEventHandler, type ReactNode } from "react"
import { observeOnce, REDUCE_QUERY, unobserve } from "./motion-hooks"

/**
 * Leituras e escritas de layout em LOTE. Cada `Reveal` precisa saber se está abaixo da dobra (leitura de
 * `getBoundingClientRect`) e, se estiver, marcar `data-reveal="hidden"` (escrita que invalida o estilo). Fazer
 * "ler, escrever, ler, escrever" em ~40 elementos força um recálculo de layout por elemento (layout thrashing —
 * medido no Lighthouse: "Style & Layout" ~2 s a 4x de CPU). Aqui os pedidos são enfileirados e resolvidos num único
 * quadro: primeiro todas as leituras, depois todas as escritas.
 */
const queue: HTMLElement[] = []
let flushScheduled = false

function flush() {
  flushScheduled = false
  const batch = queue.splice(0)
  const limit = window.innerHeight * 0.92
  const below = batch.map((el) => ({ el, below: el.isConnected && el.getBoundingClientRect().top >= limit }))
  for (const { el, below: isBelow } of below) {
    if (!isBelow) continue
    el.dataset.reveal = "hidden"
    observeOnce(el, () => {
      el.dataset.reveal = "shown"
    })
  }
}

function enqueue(el: HTMLElement) {
  queue.push(el)
  if (!flushScheduled) {
    flushScheduled = true
    window.requestAnimationFrame(flush)
  }
}

export interface RevealProps {
  as?: "div" | "section" | "li" | "article" | "p" | "span" | "ul" | "header"
  className?: string
  /** Atraso (ms) para escalonar irmãos. */
  delay?: number
  from?: "up" | "left" | "right" | "scale"
  style?: CSSProperties
  children?: ReactNode
  id?: string
  /** Para cards com holofote (`.lnd-spot`): use `spotlightMove`. */
  onPointerMove?: PointerEventHandler<HTMLElement>
}

/**
 * Entrada suave ao rolar. Só esconde se o elemento estiver abaixo da dobra no momento da montagem (o que já está
 * na tela nunca pisca) e só sem `prefers-reduced-motion: reduce`.
 */
export function Reveal({ as = "div", className, delay = 0, from = "up", style, children, id, onPointerMove }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || window.matchMedia(REDUCE_QUERY).matches) return
    enqueue(el)
    return () => {
      unobserve(el)
      // Desmontou escondido (troca de rota): não deixa o elemento preso em "hidden" se for reaproveitado.
      if (el.dataset.reveal === "hidden") delete el.dataset.reveal
    }
  }, [])

  const merged = { ...style, "--reveal-delay": `${delay}ms` } as CSSProperties
  // Tag dinâmica (li/section/...): o cast evita a união gigante de tipos de intrínsecos do JSX.
  const Tag = as as "div"
  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement | null>}
      id={id}
      className={className}
      style={merged}
      onPointerMove={onPointerMove as PointerEventHandler<HTMLDivElement> | undefined}
      data-reveal-from={from === "up" ? undefined : from}
    >
      {children}
    </Tag>
  )
}
