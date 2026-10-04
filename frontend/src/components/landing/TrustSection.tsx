import { ShieldCheck } from "lucide-react"
import { TRUST_ITEMS } from "./landing-data"
import { Reveal } from "./Reveal"
import { SectionHeading } from "./SectionHeading"

/**
 * Privacidade e segurança, na ótica de quem usa o app. Só entra o que está implementado e é verificável no código (ver `proof` em
 * `TRUST_ITEMS`); nada de selo, certificação ou promessa genérica de "máxima segurança".
 */
export function TrustSection() {
  return (
    <section id="seguranca" aria-labelledby="seguranca-titulo" className="lnd-section relative isolate overflow-clip bg-primary-50 py-20 sm:py-28">
      <div className="pointer-events-none lnd-wash-lime absolute -right-40 top-0 -z-10 h-[28rem] w-[28rem]" aria-hidden="true" />
      <div className="mx-auto grid max-w-[1400px] gap-12 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16 lg:px-8">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Reveal>
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-950 text-accent-glow shadow-lg">
              <ShieldCheck className="h-7 w-7" aria-hidden="true" />
            </span>
          </Reveal>
          <div className="mt-6">
            <SectionHeading
              id="seguranca-titulo"
              align="left"
              eyebrow="Privacidade e segurança"
              title="Seus dados no lugar certo"
              description="A localização exata fica com você, o saldo é sempre o de agora e a sua conta tem proteção contra tentativas em excesso."
            />
          </div>
        </div>

        <ul className="grid gap-4 sm:grid-cols-2">
          {TRUST_ITEMS.map((item, i) => (
            <Reveal
              as="li"
              key={item.id}
              delay={(i % 2) * 90}
              className={`rounded-2xl border border-primary-100 bg-white p-5 shadow-card ${i === TRUST_ITEMS.length - 1 && TRUST_ITEMS.length % 2 === 1 ? "sm:col-span-2" : ""}`}
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-600 text-white">
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                  </svg>
                </span>
                <div>
                  <h3 className="text-base font-bold text-ink">{item.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-ink-soft">{item.text}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  )
}
