import { ChevronDown } from "lucide-react"
import { FAQ_ITEMS } from "./landing-data"
import { Reveal } from "./Reveal"
import { SectionHeading } from "./SectionHeading"

/**
 * Perguntas frequentes com `<details>` nativo: abre/fecha por teclado (Enter/Espaço), leitores de tela anunciam o
 * estado, e funciona até sem JavaScript. O atributo `name` (acordeão exclusivo) é aprimoramento progressivo — onde
 * não há suporte, vários itens podem ficar abertos, o que também é aceitável.
 */
export function Faq() {
  return (
    <section id="perguntas" aria-labelledby="perguntas-titulo" className="lnd-section bg-white py-20 sm:py-28">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="perguntas-titulo"
          eyebrow="Perguntas frequentes"
          title="Tire suas dúvidas"
          description="Respostas diretas sobre como a plataforma funciona hoje."
        />
        <div className="lnd-faq mt-12 space-y-3">
          {FAQ_ITEMS.map((item, i) => (
            <Reveal key={item.q} delay={Math.min(i, 4) * 60}>
              <details name="faq" className="group rounded-2xl border border-primary-100 bg-white shadow-card open:border-primary-300 open:bg-primary-50/50">
                <summary className="flex min-h-14 items-center justify-between gap-4 rounded-2xl px-5 py-4 text-left text-base font-bold text-ink">
                  {item.q}
                  <ChevronDown className="lnd-faq-chev h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                </summary>
                <p className="px-5 pb-5 text-base leading-relaxed text-ink-soft">{item.a}</p>
              </details>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
