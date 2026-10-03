import { Link } from "react-router-dom"
import { ArrowRight, MapPin, UserPlus } from "lucide-react"
import { Mascot } from "./Mascot"
import { CTA_LINKS, SLOGAN } from "./landing-data"
import { Reveal } from "./Reveal"

/** CTA final em fundo escuro, com o mascote (a arte foi feita para fundo escuro) e o mesmo brilho do hero. */
export function FinalCta() {
  return (
    <section aria-labelledby="cta-final-titulo" className="lnd-dark lnd-section relative isolate overflow-clip py-20 sm:py-28">
      <div className="mx-auto grid max-w-[1400px] items-center gap-10 px-4 sm:px-6 lg:grid-cols-[1.2fr_0.8fr] lg:px-8">
        <Reveal className="text-center lg:text-left">
          <p className="lnd-eyebrow text-accent-glow">{SLOGAN}</p>
          <h2 id="cta-final-titulo" className="mt-4 text-balance text-3xl font-extrabold leading-tight tracking-tight !text-white sm:text-4xl lg:text-5xl">
            Pronto para <span className="lnd-gradient-text">recarregar</span> ou para operar com mais controle?
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-white/80 lg:mx-0">
            Veja os eletropostos da rede, crie a sua conta de motorista ou entre para acessar o seu painel.
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
            <Link to={CTA_LINKS.login} className="lnd-btn lnd-btn-ghost">
              Entrar
            </Link>
          </div>
        </Reveal>

        <Reveal from="scale" className="flex justify-center">
          <div className="lnd-stage relative !flex [--m-h:300px] sm:[--m-h:380px] lg:[--m-h:440px]">
            <div className="relative">
              <div className="lnd-backlight" aria-hidden="true" />
              <div className="lnd-ring" aria-hidden="true" />
              <div className="lnd-mascot-float relative">
                <Mascot sizes="(min-width: 1024px) 326px, (min-width: 640px) 282px, 222px" />
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
