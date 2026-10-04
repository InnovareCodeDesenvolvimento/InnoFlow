import { Link } from "react-router-dom"
import { ArrowRight, UserPlus } from "lucide-react"
import { BENEFITS, CTA_LINKS } from "./landing-data"
import { Reveal } from "./Reveal"
import { spotlightMove } from "./motion-hooks"
import { SectionHeading } from "./SectionHeading"

/**
 * Vantagens para o motorista: o que muda na vida de quem recarrega (menos dúvida, custo previsível, controle, uma conta
 * só...). Em fundo escuro, para alternar com o "Como funciona" (claro) e os recursos (claros) e dar destaque ao bloco.
 * O texto é de benefício; o "como" mora em `Features`. Cada item tem a prova no código (`BENEFITS` em landing-data.ts).
 */
export function Benefits() {
  return (
    <section id="vantagens" aria-labelledby="vantagens-titulo" className="lnd-dark lnd-section relative isolate overflow-clip py-20 sm:py-28">
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="vantagens-titulo"
          tone="dark"
          eyebrow="Vantagens para o motorista"
          title="Menos dúvida, mais controle na sua recarga"
          description="Do mapa ao recibo, o InnoFlow tira da frente o que costuma complicar a recarga de um elétrico: não saber o que esperar, o quanto vai custar e onde acompanhar."
        />

        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
          {BENEFITS.map((b, i) => (
            <Reveal
              as="li"
              key={b.id}
              delay={(i % 3) * 90}
              onPointerMove={spotlightMove}
              className="lnd-spot rounded-3xl border border-white/12 bg-white/[0.06] p-6 sm:p-7"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-glow/15 text-accent-glow ring-1 ring-accent-glow/25">
                <b.icon className="h-7 w-7" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-xl font-extrabold tracking-tight !text-white">{b.title}</h3>
              <p className="mt-2 text-base leading-relaxed text-white/80">{b.text}</p>
              <p className="mt-5 inline-flex rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white/85 ring-1 ring-white/15">No app: {b.where}</p>
            </Reveal>
          ))}
        </ul>

        <Reveal className="mt-12 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <Link to={CTA_LINKS.cadastro} className="lnd-btn lnd-btn-lime">
            <UserPlus className="h-5 w-5" aria-hidden="true" />
            Criar conta
          </Link>
          <Link to={CTA_LINKS.eletropostos} className="lnd-btn lnd-btn-glass">
            Ver eletropostos
            <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </Link>
        </Reveal>
      </div>
    </section>
  )
}
