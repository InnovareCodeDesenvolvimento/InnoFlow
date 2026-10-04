import { useRef, useState, type KeyboardEvent } from "react"
import { Link } from "react-router-dom"
import { ArrowRight, Pause, Play } from "lucide-react"
import { CTA_LINKS, EXAMPLE_NOTICE, TOUR_STEPS } from "./landing-data"
import { Reveal } from "./Reveal"
import { useInView, usePrefersReducedMotion } from "./motion-hooks"
import { PhoneFrame } from "./PhoneScreens"
import { SectionHeading } from "./SectionHeading"

/**
 * "Como funciona" para o motorista: 5 etapas (achar, escanear o QR, iniciar, acompanhar, recibo) ao lado de um
 * celular que muda de tela. É um conjunto de abas (tablist) de verdade: setas/Home/End navegam, a aba ativa
 * controla o painel de texto. A rotação automática (barra de progresso no painel; o fim da animação CSS avança)
 *   - só roda sem `prefers-reduced-motion: reduce`;
 *   - pausa fora da tela, ao passar o mouse/focar o conjunto e pelo botão "Pausar animação" (WCAG 2.2.2).
 * O celular é aria-hidden: a informação está toda no texto.
 */
export function DriverTour() {
  const [step, setStep] = useState(0)
  const [userPaused, setUserPaused] = useState(false)
  const [hold, setHold] = useState(false)
  const [sectionRef, inView] = useInView<HTMLDivElement>("0px")
  const reduce = usePrefersReducedMotion()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const autoplay = !reduce && inView && !userPaused
  const current = TOUR_STEPS[step]
  const last = TOUR_STEPS.length - 1

  const go = (index: number, focus = false) => {
    const next = (index + TOUR_STEPS.length) % TOUR_STEPS.length
    setStep(next)
    if (focus) tabRefs.current[next]?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = {
      ArrowRight: step + 1,
      ArrowDown: step + 1,
      ArrowLeft: step - 1,
      ArrowUp: step - 1,
      Home: 0,
      End: last,
    }
    if (e.key in keys) {
      e.preventDefault()
      go(keys[e.key], true)
    }
  }

  return (
    <section
      id="como-funciona"
      aria-labelledby="como-funciona-titulo"
      className="lnd-section relative isolate overflow-clip bg-gradient-to-b from-white via-primary-50 to-white py-20 sm:py-28"
    >
      <div className="pointer-events-none lnd-wash-lime absolute -left-40 top-16 -z-10 h-[28rem] w-[28rem]" aria-hidden="true" />
      <div className="pointer-events-none lnd-wash-blue absolute -right-40 bottom-0 -z-10 h-[34rem] w-[34rem]" aria-hidden="true" />

      <div ref={sectionRef} className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="como-funciona-titulo"
          eyebrow="Como funciona"
          title="Da busca ao recibo, em cinco passos"
          description="Você acha um eletroposto livre, escaneia o QR code do carregador, vê a tarifa, inicia a recarga e acompanha tudo pelo celular até receber o recibo."
        />

        <div
          className="mt-14 grid grid-cols-[minmax(0,1fr)] items-center gap-12 lg:grid-cols-[minmax(0,34rem)_auto] lg:justify-center lg:gap-24"
          onPointerEnter={() => setHold(true)}
          onPointerLeave={() => setHold(false)}
          onFocusCapture={() => setHold(true)}
          onBlurCapture={() => setHold(false)}
        >
          <div className="mx-auto w-full max-w-xl lg:mx-0">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-bold text-ink-soft">
                Passo {step + 1} de {TOUR_STEPS.length}
              </p>
              {!reduce && (
                <button
                  type="button"
                  onClick={() => setUserPaused((v) => !v)}
                  aria-pressed={userPaused}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-primary-700 hover:bg-primary-100"
                >
                  {userPaused ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
                  {userPaused ? "Retomar animação" : "Pausar animação"}
                </button>
              )}
            </div>

            <div
              role="tablist"
              aria-label="Etapas da recarga"
              onKeyDown={onKeyDown}
              className="relative mt-3 flex items-center justify-between gap-1 lg:flex-col lg:items-stretch lg:justify-start"
            >
              <span className="lnd-steps-line hidden lg:block" style={{ ["--lnd-fill" as string]: `${(step / last) * 100}%` }} aria-hidden="true" />
              {TOUR_STEPS.map((s, i) => {
                const active = i === step
                const done = i < step
                return (
                  <button
                    key={s.id}
                    ref={(el) => {
                      tabRefs.current[i] = el
                    }}
                    type="button"
                    role="tab"
                    id={`tour-tab-${s.id}`}
                    aria-selected={active}
                    aria-controls="tour-panel"
                    tabIndex={active ? 0 : -1}
                    onClick={() => go(i)}
                    data-testid={`tour-tab-${s.id}`}
                    className="relative flex min-h-12 min-w-12 shrink-0 items-center justify-center gap-3 rounded-2xl text-left transition-colors hover:bg-primary-100/70 lg:min-h-11 lg:w-full lg:justify-start lg:px-1 lg:py-2.5"
                  >
                    <span
                      className={`relative z-10 flex h-[2.375rem] w-[2.375rem] shrink-0 items-center justify-center rounded-full text-sm font-extrabold ring-4 ring-white transition-colors lg:ring-primary-50 ${
                        active ? "bg-primary-950 text-accent-glow ring-primary-200 scale-110" : done ? "bg-accent-600 text-white" : "bg-primary-100 text-primary-700"
                      }`}
                    >
                      {i + 1}
                    </span>
                    {/* No celular só o número aparece (cinco rótulos não cabem na linha); o nome continua acessível. */}
                    <span className={`sr-only text-lg font-bold lg:not-sr-only ${active ? "text-ink" : "text-ink-soft"}`}>{s.title}</span>
                  </button>
                )
              })}
            </div>

            <div
              role="tabpanel"
              id="tour-panel"
              aria-labelledby={`tour-tab-${current.id}`}
              tabIndex={0}
              className="mt-5 overflow-hidden rounded-2xl border border-primary-100 bg-white shadow-card"
            >
              <span className="lnd-progress rounded-none" data-playing={autoplay} data-hold={hold} aria-hidden="true">
                {autoplay && <i key={step} data-testid="tour-progress" onAnimationEnd={() => go(step + 1)} />}
              </span>
              <div className="p-5">
                <h3 className="text-xl font-extrabold tracking-tight text-ink">{current.title}</h3>
                <p className="mt-2 text-base leading-relaxed text-ink-soft">{current.text}</p>
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link to={CTA_LINKS.eletropostos} className="lnd-btn lnd-btn-solid">
                Ver eletropostos
                <ArrowRight className="h-5 w-5" aria-hidden="true" />
              </Link>
              <Link
                to={CTA_LINKS.cadastro}
                className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-base font-bold text-primary-700 hover:bg-primary-100"
              >
                Criar conta
              </Link>
            </div>
          </div>

          <Reveal from="scale" className="relative order-first flex flex-col items-center lg:order-none">
            {/* halo de luz atrás do celular (gradiente simples, sem filter/blur: barato) - o celular é o protagonista da seção */}
            <div className="lnd-phone-halo" aria-hidden="true" />
            <PhoneFrame step={current.id} />
            <p className="mt-4 max-w-[18rem] text-center text-xs font-medium text-ink-softer">{EXAMPLE_NOTICE}</p>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
