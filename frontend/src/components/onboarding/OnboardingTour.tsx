import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { Role } from "@/types/api"
import { useMediaQuery } from "@/hooks/useMediaQuery"
import type { TourStatus } from "./onboardingStorage"
import { TourBalloon, type BalloonLayout } from "./TourBalloon"
import { computePlacement, lookDirection, padRect, type Rect, type Size } from "./tourGeometry"
import { ensureVisible, findTarget, focusables, measureVisibleRect } from "./tourDom"
import { WIDE_MIN_WIDTH, goBack, goNext, indexOfStep, keyToAction, nextFocusIndex, resolveSteps } from "./tourLogic"
import type { NavSummary } from "./tourNav"
import { TOUR_DEFINITIONS, type TourContext, type TourId } from "./tourScripts"
import "./tour.css"

/** Respiro do destaque em volta do alvo. */
const HIGHLIGHT_PAD = 6
/** Os grupos do menu abrem com animação de 200 ms: depois que assentam, mede de novo. */
const SETTLE_MS = 320

interface Props {
  tourId: TourId
  role: Role | undefined
  nav: NavSummary
  onClose: (status: TourStatus) => void
}

interface Measure {
  /** Parte visível do alvo; `null` = alvo ausente/oculto/cortado → balão centralizado. */
  rect: Rect | null
  viewport: Size
}

/**
 * O tour em si: spotlight sobre o elemento `data-tour`, balão do mascote, teclado e foco. Carregado sob demanda (`React.lazy` em `TourProvider`).
 *
 * Comportamentos que a régua de geometria e os E2E conferem: alvo ausente OU oculto OU mais de 40% cortado → balão centralizado (nunca erro, nunca apontar para o vazio);
 * reposiciona em resize/rolagem/mudança de tamanho do alvo; o resto do app fica `inert` (nada recebe foco ou clique por baixo) e o Tab fica preso no balão; ao fechar, o foco volta ao elemento
 * que o tinha antes (ex.: o item "Rever tour" do menu). Esc = pular. Setas = navegar.
 */
export default function OnboardingTour({ tourId, role, nav, onClose }: Props) {
  const definition = TOUR_DEFINITIONS[tourId]
  const isWide = useMediaQuery(`(min-width: ${WIDE_MIN_WIDTH}px)`)
  const ctx = useMemo<TourContext>(() => ({ role, isWide, navHrefs: nav.hrefs, navLabels: nav.labels, navGroups: nav.groups }), [role, isWide, nav])
  const steps = useMemo(() => resolveSteps(definition, ctx), [definition, ctx])

  const [stepId, setStepId] = useState(steps[0]?.id ?? "")
  const index = indexOfStep(steps, stepId)
  const step = steps[index]

  const [measure, setMeasure] = useState<Measure | null>(null)
  const [balloonSize, setBalloonSize] = useState<Size | null>(null)
  const balloonRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<Element | null>(null)

  const stepKey = step?.id ?? ""
  const targetName = step?.kind === "step" ? step.target : undefined

  const close = useCallback((status: TourStatus) => onClose(status), [onClose])

  const go = useCallback(
    (to: { index: number; done: boolean }) => {
      if (to.done) close("completed")
      else if (steps[to.index]) setStepId(steps[to.index].id)
    },
    [steps, close],
  )

  // Mede o alvo do passo. Tudo agendado por rAF/timeout (nunca setState síncrono no corpo do efeito).
  useLayoutEffect(() => {
    let raf = 0
    let observer: ResizeObserver | null = null

    const measureNow = () => {
      raf = 0
      const el = targetName ? findTarget(targetName) : null
      setMeasure({ rect: el ? measureVisibleRect(el) : null, viewport: { width: window.innerWidth, height: window.innerHeight } })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measureNow)
    }

    const first = targetName ? findTarget(targetName) : null
    if (first) {
      ensureVisible(first)
      observer = new ResizeObserver(schedule)
      observer.observe(first)
    }
    schedule()
    // O menu abre os grupos com animação: depois que assenta, garante o alvo à vista e mede de novo.
    const settle = window.setTimeout(() => {
      const again = targetName ? findTarget(targetName) : null
      if (again) ensureVisible(again)
      schedule()
    }, SETTLE_MS)
    window.addEventListener("resize", schedule)
    window.addEventListener("scroll", schedule, true)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(settle)
      observer?.disconnect()
      window.removeEventListener("resize", schedule)
      window.removeEventListener("scroll", schedule, true)
    }
  }, [targetName, stepKey])

  // Tamanho real do balão (a altura varia com o texto de cada passo e com a largura da janela).
  useEffect(() => {
    const el = balloonRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setBalloonSize((prev) => (prev && prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Foco: guarda quem tinha o foco, deixa o resto do app `inert` (nada por baixo recebe foco/clique/leitor de tela) e devolve o foco ao fechar.
  useEffect(() => {
    previouslyFocused.current = document.activeElement
    const root = document.getElementById("root")
    root?.setAttribute("inert", "")
    return () => {
      root?.removeAttribute("inert")
      const el = previouslyFocused.current
      if (el instanceof HTMLElement && el !== document.body && el.isConnected) el.focus({ preventScroll: true })
    }
  }, [])

  const ready = measure !== null && balloonSize !== null

  // Foco no botão principal quando o balão fica visível (nasce `visibility:hidden` até ser medido, e elemento oculto não recebe foco) e sempre que o botão focado sumir
  // (ex.: "Voltar" no primeiro passo). Com o foco já dentro do balão, não mexe: quem usa teclado continua onde está.
  useEffect(() => {
    const root = balloonRef.current
    if (ready && root && !root.contains(document.activeElement)) root.querySelector<HTMLElement>("[data-tour-primary]")?.focus()
  }, [ready, stepKey])

  // Teclado: setas, Esc, e Tab preso dentro do balão.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Tab") {
        const root = balloonRef.current
        if (!root) return
        const items = focusables(root)
        if (items.length === 0) return
        e.preventDefault()
        items[nextFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey)]?.focus()
        return
      }
      const action = keyToAction(e)
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      if (action === "next") go(goNext(index, steps.length))
      else if (action === "back") go(goBack(index))
      else close("skipped")
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [go, close, index, steps.length])

  if (!step) return null

  // Durante o quadro entre um passo e a medição do seguinte vale a última medição (o destaque e o balão deslizam para o lugar novo, sem piscar no centro).
  const highlight = measure?.rect && step.kind === "step" ? padRect(measure.rect, HIGHLIGHT_PAD) : null

  let layout: BalloonLayout = { kind: "center" }
  let look: ReturnType<typeof lookDirection> = "none"
  if (highlight && balloonSize && measure) {
    const placement = computePlacement({ target: highlight, balloon: balloonSize, viewport: measure.viewport })
    look = lookDirection(placement)
    if (placement.mode === "anchored") layout = { kind: "anchored", side: placement.side, left: placement.left, top: placement.top, arrow: placement.arrow }
  }

  return createPortal(
    <div className="tour-root" data-tour-overlay="">
      {/* Camada que captura cliques: o usuário não mexe na tela por baixo durante o tour. */}
      <div className="tour-blocker" aria-hidden="true" />
      {highlight ? <div className="tour-spot" data-tour-spot="" aria-hidden="true" style={{ top: highlight.top, left: highlight.left, width: highlight.width, height: highlight.height }} /> : <div className="tour-dim" aria-hidden="true" />}
      <TourBalloon
        ref={balloonRef}
        label={definition.dialogLabel}
        step={step}
        position={index + 1}
        total={steps.length}
        layout={layout}
        look={look}
        ready={ready}
        onNext={() => go(goNext(index, steps.length))}
        onBack={() => go(goBack(index))}
        onSkip={() => close("skipped")}
      />
    </div>,
    document.body,
  )
}
