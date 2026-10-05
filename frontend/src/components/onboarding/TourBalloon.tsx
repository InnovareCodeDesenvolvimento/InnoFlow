import { useId, type CSSProperties, type Ref } from "react"
import { ArrowLeft, ArrowRight, Check } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { TourMascot, type MascotLook } from "./TourMascot"
import type { Side } from "./tourGeometry"
import type { ResolvedStep } from "./tourLogic"
import { TOUR_UI } from "./tourScripts"

export type BalloonLayout = { kind: "center" } | { kind: "anchored"; side: Side; left: number; top: number; arrow: number }

interface TourBalloonProps {
  ref?: Ref<HTMLDivElement>
  label: string
  step: ResolvedStep
  /** Posição do passo (1-based) e total. */
  position: number
  total: number
  layout: BalloonLayout
  look: MascotLook
  /** `false` até o balão e o alvo terem sido medidos: nasce invisível, para nunca piscar no lugar errado. */
  ready: boolean
  onNext: () => void
  onBack: () => void
  onSkip: () => void
}

/**
 * Balão do mascote. Puramente visual: quem decide posição, passo e o que cada botão faz é `OnboardingTour`. UM balão persistente (não remonta a cada passo): o foco fica no mesmo botão e
 * a região `aria-live="polite"` anuncia o passo novo. Duas formas: `anchored` (perto do alvo, com a ponta) e `center` (boas-vindas, fim, ou alvo ausente/oculto).
 * Alvos de toque de 44 px em todas as larguras (`h-11`), e o texto sempre passa AA: o balão é `.surface-dark` (ink 21:1, ink-soft 14:1 sobre o fundo).
 */
export function TourBalloon({ ref, label, step, position, total, layout, look, ready, onNext, onBack, onSkip }: TourBalloonProps) {
  const uid = useId()
  const titleId = `${uid}-title`
  const textId = `${uid}-text`
  const big = step.kind !== "step"
  const isFirst = position === 1
  const isLast = position === total
  const nextLabel = step.kind === "welcome" ? TOUR_UI.start : isLast ? TOUR_UI.finish : TOUR_UI.next
  const style: CSSProperties | undefined = layout.kind === "anchored" ? { left: layout.left, top: layout.top } : undefined

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      aria-describedby={textId}
      data-tour-balloon=""
      data-layout={layout.kind}
      data-side={layout.kind === "anchored" ? layout.side : undefined}
      data-big={big ? "" : undefined}
      data-ready={ready ? "" : undefined}
      className="tour-balloon surface-dark"
      style={style}
    >
      {layout.kind === "anchored" ? (
        <span aria-hidden="true" className="tour-tail" data-side={layout.side} style={layout.side === "left" || layout.side === "right" ? { top: layout.arrow - 6 } : { left: layout.arrow - 6 }} />
      ) : null}

      <div className="tour-body" aria-live="polite" aria-atomic="true">
        <TourMascot size={big ? "lg" : "sm"} mood={step.mood === "happy" ? "happy" : "idle"} look={look} waveKey={step.id} />
        <div className="tour-copy">
          <p className="tour-progress">{TOUR_UI.progress(position, total)}</p>
          <h2 id={titleId} className="tour-title">
            {step.title}
          </h2>
          <p id={textId} className="tour-text">
            {step.body}
          </p>
        </div>
      </div>

      <div className="tour-dots" role="progressbar" aria-label={TOUR_UI.progressLabel} aria-valuemin={1} aria-valuemax={total} aria-valuenow={position} aria-valuetext={TOUR_UI.progress(position, total)}>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} aria-hidden="true" data-state={i + 1 < position ? "done" : i + 1 === position ? "current" : "todo"} />
        ))}
      </div>

      <div className="tour-footer">
        {isLast ? null : (
          <Button type="button" variant="ghost" onClick={onSkip} className="-ml-2 h-11 px-3 text-ink-softer">
            {TOUR_UI.skip}
          </Button>
        )}
        <div className="tour-footer-nav">
          {isFirst ? null : (
            <Button type="button" variant="glass" onClick={onBack} className="h-11 px-3.5">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {TOUR_UI.back}
            </Button>
          )}
          <Button type="button" variant="lime" onClick={onNext} data-tour-primary="" className="h-11 px-4">
            {nextLabel}
            {isLast ? <Check className="h-4 w-4" aria-hidden="true" /> : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
