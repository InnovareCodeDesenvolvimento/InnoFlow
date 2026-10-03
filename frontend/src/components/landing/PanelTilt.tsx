import { useEffect, useRef, type CSSProperties, type ReactNode } from "react"

/**
 * Painel "inclinado em perspectiva" que se endireita conforme a rolagem (efeito de sites de produto). Sem
 * biblioteca:
 *
 * - Navegadores com `animation-timeline: view()` fazem tudo em CSS (bloco no fim de `landing.css`, `.lnd-tilt-body`):
 *   zero JavaScript por quadro e roda no compositor.
 * - Os demais usam o fallback abaixo: um IntersectionObserver liga um ouvinte de rolagem (rAF) só enquanto o painel
 *   está perto da tela e escreve `--pt-p` (0 a 1) no elemento; o mesmo CSS lê essa variável.
 * - Com `prefers-reduced-motion`, ou sem JS e sem suporte nativo, o painel fica reto.
 *
 * ARMADILHA (medida no projeto irmão InnoChat): `animation-timeline: view()` prende ao ANCESTRAL de rolagem mais
 * próximo; qualquer pai com `overflow:hidden/auto` vira esse ancestral e a animação trava. As seções usam
 * `overflow: clip`.
 */
const NATIVE = "(animation-timeline: view())"

export function PanelTilt({
  children,
  className,
  tiltX,
  tiltY,
  testId,
}: {
  children: ReactNode
  className?: string
  /** Inclinação inicial (graus) em torno do eixo X (para trás) e Y (para o lado). Padrão: CSS (`.lnd-tilt`, menor no celular). */
  tiltX?: number
  tiltY?: number
  testId?: string
}) {
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    if (typeof CSS !== "undefined" && CSS.supports?.(NATIVE)) return

    stage.dataset.ptJs = "true"
    stage.style.setProperty("--pt-p", "0")
    let frame = 0
    const update = () => {
      frame = 0
      const rect = stage.getBoundingClientRect()
      const vh = window.innerHeight
      // Mesma janela do CSS nativo (`animation-range: entry 10% cover 45%`).
      const cover = (vh - rect.top) / (vh + rect.height)
      const start = (0.1 * rect.height) / (vh + rect.height)
      const p = Math.min(1, Math.max(0, (cover - start) / (0.45 - start)))
      stage.style.setProperty("--pt-p", (1 - (1 - p) ** 2.2).toFixed(3))
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const near = entries.some((e) => e.isIntersecting)
        window.removeEventListener("scroll", schedule)
        if (near) {
          window.addEventListener("scroll", schedule, { passive: true })
          schedule()
        }
      },
      { rootMargin: "20% 0px 20% 0px" },
    )
    observer.observe(stage)
    return () => {
      observer.disconnect()
      window.removeEventListener("scroll", schedule)
      delete stage.dataset.ptJs
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  const vars = {
    ...(tiltX !== undefined ? { "--pt-x": `${tiltX}deg` } : {}),
    ...(tiltY !== undefined ? { "--pt-y": `${tiltY}deg` } : {}),
  } as CSSProperties

  return (
    <div ref={stageRef} data-testid={testId} className={`lnd-tilt ${className ?? ""}`} style={vars}>
      <div aria-hidden="true" className="lnd-tilt-shadow" />
      <div className="lnd-tilt-body">
        {children}
        <div aria-hidden="true" className="lnd-tilt-sheen" />
      </div>
    </div>
  )
}
