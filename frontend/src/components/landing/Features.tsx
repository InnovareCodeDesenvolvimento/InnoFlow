import { Reveal } from "./Reveal"
import { spotlightMove } from "./motion-hooks"
import { FEATURES } from "./landing-data"
import { SectionHeading } from "./SectionHeading"

/** Recursos em grade "bento": cards grandes (2 colunas) e médios, com holofote que segue o ponteiro. */
export function Features() {
  return (
    <section id="recursos" aria-labelledby="recursos-titulo" className="lnd-section relative isolate overflow-clip bg-gradient-to-b from-white to-primary-50 py-20 sm:py-28">
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="recursos-titulo"
          eyebrow="Recursos do app"
          title="Tudo o que você usa antes, durante e depois de carregar"
          description="Mapa, tarifa, acompanhamento ao vivo, carteira e histórico, no celular e sem complicação."
        />

        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
          {FEATURES.map((f, i) => {
            const big = f.size === "lg"
            return (
              <Reveal
                as="li"
                key={f.id}
                delay={(i % 3) * 90}
                onPointerMove={spotlightMove}
                className={`lnd-spot group relative overflow-hidden rounded-3xl border p-6 shadow-card sm:p-7 ${
                  big
                    ? "border-primary-900/30 bg-gradient-to-br from-primary-950 to-primary-800 text-white sm:col-span-2"
                    : "border-primary-100 bg-white"
                }`}
              >
                <f.icon
                  className={`pointer-events-none absolute -bottom-6 -right-6 h-36 w-36 ${big ? "text-white/[0.06]" : "text-primary-100"}`}
                  strokeWidth={1.2}
                  aria-hidden="true"
                />
                <span
                  className={`relative flex h-12 w-12 items-center justify-center rounded-2xl ${
                    big ? "bg-accent-glow/15 text-accent-glow" : "bg-primary/10 text-primary"
                  }`}
                >
                  <f.icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <h3 className={`relative mt-5 text-xl font-bold tracking-tight ${big ? "!text-white" : "text-ink"}`}>{f.title}</h3>
                <p className={`relative mt-2 text-base leading-relaxed ${big ? "text-white/80" : "text-ink-soft"}`}>{f.text}</p>
                {f.id === "mapa" && (
                  <ul className="relative mt-6 flex flex-wrap gap-2" aria-label="Tipos de conector" data-testid="feature-connectors">
                    {["AC Tipo 2", "DC CCS2", "DC CHAdeMO"].map((c) => (
                      <li key={c} className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white ring-1 ring-white/20">
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
                {f.id === "tempo-real" && (
                  <ul className="relative mt-6 flex flex-wrap gap-2" aria-label="O que você acompanha">
                    {["Energia (kWh)", "Valor estimado", "Tempo", "Potência", "Bateria"].map((c) => (
                      <li key={c} className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white ring-1 ring-white/20">
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
                {f.note && (
                  <p className="relative mt-3 inline-flex rounded-xl bg-warning-100 px-3 py-1.5 text-xs font-bold leading-snug text-warning-700">{f.note}</p>
                )}
              </Reveal>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
