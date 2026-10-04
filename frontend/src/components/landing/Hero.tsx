import { Link } from "react-router-dom"
import { ArrowRight, BatteryCharging, Check, MapPin, UserPlus } from "lucide-react"
import { FlowCanvas } from "./FlowCanvas"
import { Mascot, MascotFace } from "./Mascot"
import { CTA_LINKS, HERO_POINTS, SLOGAN } from "./landing-data"
import { useElapsed } from "./motion-hooks"

/** kWh de exemplo que sobe devagar no cartão flutuante (decorativo: o cartão inteiro é aria-hidden). */
function LiveKwh() {
  const ms = useElapsed(1000, 12000)
  const kwh = 18.4 + (ms / 1000) * 0.07
  return <>{kwh.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</>
}

function HeroStage() {
  return (
    <div className="lnd-stage" data-testid="hero-stage">
      <div className="lnd-mascot-enter relative">
        <div className="lnd-mascot-box-wrap relative">
          <div className="lnd-backlight" aria-hidden="true" />
          {/* O arco que gira é um elemento de verdade (`lnd-ring-sweep`), NÃO um ::after: animar um pseudo-elemento dentro de um pai
              que também anima (o anel flutua) fazia o Chromium refazer o estilo na thread principal a cada quadro (medido: ~700 ms
              de CPU a cada 3 s a 4x; com elemento real, ~5 ms). */}
          <div className="lnd-ring" aria-hidden="true">
            <i className="lnd-ring-sweep" />
          </div>
          <div className="lnd-mascot-float relative">
            <Mascot
              priority
              blink
              sizes="(min-width: 1536px) 474px, (min-width: 1280px) 445px, (min-width: 1024px) 385px, (min-width: 640px) 326px, 267px"
            />

            {/* Cabo de energia: do plugue do mascote até o cartão de recarga (viewBox na proporção do recorte, 100x135) */}
            <svg className="lnd-arc left-0 top-0 hidden h-full w-full sm:block" viewBox="0 0 100 135" aria-hidden="true">
              <path className="lnd-arc-base" d="M92.6 46 C 97 40, 93 26, 88 16" pathLength={100} vectorEffect="non-scaling-stroke" />
              <path className="lnd-arc-pulse" d="M92.6 46 C 97 40, 93 26, 88 16" pathLength={100} vectorEffect="non-scaling-stroke" />
            </svg>

            <div
              className="lnd-chip lnd-chip-bob left-[34%] top-[-7%] sm:left-[60%] sm:top-[-3%]"
              aria-hidden="true"
              data-testid="hero-chip-charging"
            >
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-glow/15 text-accent-glow">
                <BatteryCharging className="h-5 w-5" />
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent-glow ring-2 ring-[rgb(var(--lnd-night))]" />
              </span>
              <span className="text-left leading-tight">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-white/65">Recarga em andamento</span>
                <span className="block whitespace-nowrap text-lg font-extrabold tabular-nums">
                  <LiveKwh /> <span className="text-sm font-semibold text-white/70">kWh</span>
                </span>
              </span>
            </div>

            <div
              className="lnd-chip lnd-chip-bob bottom-[14%] left-[-10%] sm:left-[-26%]"
              data-d="1"
              aria-hidden="true"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-400/20 text-primary-200">
                <MapPin className="h-5 w-5" />
              </span>
              <span className="text-left leading-tight">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-white/65">Conector livre agora</span>
                <span className="block whitespace-nowrap text-sm font-bold">DC CCS2 · exemplo</span>
              </span>
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Hero: slogan, h1 único da página, dois CTAs (Ver eletropostos / Criar conta) + Entrar, e o mascote animado.
 * O h1 é texto (LCP rápido); a rede de fluxo em canvas só começa quando o navegador está ocioso.
 */
export function Hero() {
  return (
    <section id="inicio" aria-labelledby="hero-title" className="lnd-dark lnd-section relative isolate overflow-clip pb-16 pt-24 sm:pt-28 lg:pb-24 lg:pt-32">
      <FlowCanvas />
      <div className="lnd-hero-grid pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />
      <div className="lnd-glow-lime pointer-events-none absolute -left-40 top-0 -z-10 h-[30rem] w-[30rem]" aria-hidden="true" />
      <div className="lnd-glow-teal pointer-events-none absolute -right-40 bottom-0 -z-10 h-[34rem] w-[34rem]" aria-hidden="true" />

      <div className="mx-auto grid max-w-[1400px] items-center gap-14 px-4 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8 lg:px-8">
        <div className="lnd-hero-in text-center lg:text-left">
          <p className="inline-flex items-center gap-2 rounded-full bg-white/10 py-1.5 pl-1.5 pr-4 text-sm font-semibold text-white ring-1 ring-white/20">
            <MascotFace size={28} className="h-7 w-7 rounded-full bg-white/10" />
            {SLOGAN}
          </p>

          <h1
            id="hero-title"
            className="mt-6 text-balance text-4xl font-extrabold leading-[1.06] tracking-tight text-white sm:text-5xl xl:text-6xl"
          >
            Recarregue seu elétrico <span className="lnd-gradient-text">sem complicação</span>
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-white/80 lg:mx-0">
            Encontre um eletroposto, escaneie o QR code do carregador e acompanhe a recarga em tempo real. Para quem opera
            eletropostos, um painel completo com sessões, financeiro e relatórios.
          </p>

          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center lg:justify-start">
            <Link to={CTA_LINKS.eletropostos} className="lnd-btn lnd-btn-lime">
              <MapPin className="h-5 w-5" aria-hidden="true" />
              Ver eletropostos
              <ArrowRight className="h-5 w-5" aria-hidden="true" />
            </Link>
            <Link to={CTA_LINKS.cadastro} className="lnd-btn lnd-btn-glass">
              <UserPlus className="h-5 w-5" aria-hidden="true" />
              Criar conta
            </Link>
          </div>

          <p className="mt-4 text-sm font-medium text-white/75">
            Já tem conta?{" "}
            <Link to={CTA_LINKS.login} className="font-bold text-white underline decoration-accent-glow decoration-2 underline-offset-4 hover:text-accent-glow">
              Entrar
            </Link>
          </p>

          <ul className="mx-auto mt-8 flex w-fit flex-col items-start gap-2.5 lg:mx-0">
            {HERO_POINTS.map((point) => (
              <li key={point.text} className="flex items-center gap-2.5 text-sm text-white/90">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-glow text-[rgb(var(--lnd-night))]">
                  <Check className="h-3 w-3" strokeWidth={3.5} aria-hidden="true" />
                </span>
                {point.text}
              </li>
            ))}
          </ul>
        </div>

        <HeroStage />
      </div>
    </section>
  )
}
