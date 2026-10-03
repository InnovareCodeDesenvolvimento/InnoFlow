import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { Hero } from "@/components/landing/Hero"
import { LandingFooter } from "@/components/landing/LandingFooter"
import { LandingHeader } from "@/components/landing/LandingHeader"
import { StatsStrip } from "@/components/landing/StatsStrip"
import { SLOGAN } from "@/components/landing/landing-data"
import "@/components/landing/landing.css"

// Tudo abaixo da dobra vem num segundo chunk: o hero (texto + mascote) não espera pelo celular, pelo painel 3D etc.
const loadBelowFold = () => import("@/components/landing/BelowFold")
const BelowFold = lazy(loadBelowFold)

const PAGE_TITLE = `InnoFlow — ${SLOGAN}: recarga de veículos elétricos`

/** Eventos que indicam que a pessoa vai rolar/navegar: montam o conteúdo de baixo sem esperar a margem de proximidade. */
const INTENT_EVENTS = ["scroll", "wheel", "touchstart", "pointerdown", "keydown", "hashchange"] as const

/**
 * Decide QUANDO montar o conteúdo abaixo da dobra. Baixar o chunk é barato (feito quando o navegador está ocioso);
 * MONTAR é que custa: ~1.500 nós de DOM, cinco telas de celular, painel 3D e dezenas de observadores. Quem só olha
 * o hero não paga isso. Monta quando:
 *   - a faixa-reserva entra a 700px da tela (rolagem se aproximando), ou
 *   - há sinal de intenção (rolar, roda do mouse, toque, clique, tecla — Tab inclusive —, mudança de hash), ou
 *   - a URL já chegou com âncora (`/#recursos`), ou
 *   - passaram 6 s desde o carregamento (leitores de tela e quem só espera: o conteúdo existe sempre).
 */
function useBelowFoldGate(): [boolean, React.RefObject<HTMLDivElement | null>] {
  const [armed, setArmed] = useState(() => typeof window !== "undefined" && window.location.hash.length > 1)
  const sentinel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (armed) return
    const arm = () => setArmed(true)
    for (const ev of INTENT_EVENTS) window.addEventListener(ev, arm, { passive: true, once: true })
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && arm(), { rootMargin: "700px 0px" })
    if (sentinel.current) observer.observe(sentinel.current)
    // Rede de segurança: leitores de tela navegam pelo conteúdo sem disparar rolagem/teclado na página, e quem só
    // espera também merece a página inteira. Se ninguém interagiu, monta sozinho 6 s depois do carregamento (tempo de
    // sobra para o hero ter sido visto); o custo é fatiado em uma seção por tarefa (ver BelowFold).
    let late = 0
    const schedule = () => {
      late = window.setTimeout(arm, 6000)
    }
    if (document.readyState === "complete") schedule()
    else window.addEventListener("load", schedule, { once: true })

    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    const preload = () => void loadBelowFold()
    const idle = typeof w.requestIdleCallback === "function" ? w.requestIdleCallback(preload, { timeout: 4000 }) : window.setTimeout(preload, 2000)

    return () => {
      for (const ev of INTENT_EVENTS) window.removeEventListener(ev, arm)
      observer.disconnect()
      window.removeEventListener("load", schedule)
      window.clearTimeout(late)
      if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(idle)
      else window.clearTimeout(idle)
    }
  }, [armed])

  return [armed, sentinel]
}

/**
 * `/` — landing pública do InnoFlow (sem login). Casca PRÓPRIA (cabeçalho escuro fixo + rodapé), fora do `Layout`
 * público, porque o hero é escuro e precisa do menu de seções; `/eletropostos` continua no `Layout` de sempre.
 * O `<title>` é restaurado ao sair da página (as outras rotas não definem o próprio).
 *
 * Conteúdo: tudo o que a página afirma está em `components/landing/landing-data.ts`, com a prova (arquivo/rota)
 * de cada afirmação. O pagamento real (Pix/cartão) ainda NÃO está no ar: só aparece como "em breve".
 */
export function Home() {
  const [belowArmed, sentinel] = useBelowFoldGate()

  useEffect(() => {
    const previous = document.title
    document.title = PAGE_TITLE
    return () => {
      document.title = previous
    }
  }, [])

  return (
    <div className="lnd-root min-h-screen">
      <a
        href="#conteudo"
        className="fixed left-3 top-[-4rem] z-[100] rounded-lg bg-primary px-4 py-2 font-bold text-white shadow-lg transition-[top] duration-200 focus:top-3"
      >
        Pular para o conteúdo
      </a>
      <LandingHeader />
      <main id="conteudo">
        <Hero />
        <StatsStrip />
        {belowArmed ? (
          <Suspense fallback={<div className="h-[60vh] bg-white" aria-hidden="true" />}>
            <BelowFold />
          </Suspense>
        ) : (
          <div ref={sentinel} className="h-[60vh] bg-white" aria-hidden="true" data-testid="below-fold-placeholder" />
        )}
      </main>
      <LandingFooter />
    </div>
  )
}
