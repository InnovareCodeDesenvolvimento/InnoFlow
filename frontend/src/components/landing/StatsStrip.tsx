import { STAT_FACTS, type StatFact } from "./landing-data"
import { Reveal } from "./Reveal"
import { spotlightMove, useCountUp, useInView } from "./motion-hooks"

function StatValue({ fact, active }: { fact: StatFact; active: boolean }) {
  const counted = useCountUp(fact.count ?? 0, active && fact.count !== undefined)
  const text = fact.count !== undefined ? String(counted) : fact.value
  return (
    <p className={`font-extrabold tabular-nums tracking-tight text-white ${fact.count !== undefined ? "text-4xl sm:text-5xl" : "text-2xl sm:text-4xl"}`}>
      {/* O número sobe de 0 até o valor: leitores de tela ouvem só o valor final (aria-label em <p> é proibido pelo axe). */}
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{fact.value}</span>
    </p>
  )
}

/**
 * Faixa de fatos do produto (NÃO são métricas de uso: o produto não publica números de clientes). Só entra aqui o
 * que é verificável no código — ver `STAT_FACTS` e a trilha `proof`. O cabo horizontal atrás dos cartões é
 * decorativo (pulso de energia viajando).
 */
export function StatsStrip() {
  const [ref, inView] = useInView<HTMLDivElement>("0px")
  return (
    <section aria-labelledby="fatos-titulo" className="lnd-dark-flat relative isolate overflow-clip pb-16 sm:pb-20">
      <h2 id="fatos-titulo" className="sr-only">
        O InnoFlow em poucos fatos
      </h2>
      <div ref={ref} className="relative mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <div className="lnd-cable-h hidden lg:block" aria-hidden="true" />
        <ul className="relative grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-5">
          {STAT_FACTS.map((fact, i) => (
            <Reveal as="li" key={fact.id} delay={i * 90} onPointerMove={spotlightMove} className="lnd-spot rounded-2xl border border-white/12 bg-white/[0.06] p-4 sm:p-6">
              <StatValue fact={fact} active={inView} />
              <p className="mt-2 text-sm font-bold text-accent-glow">{fact.label}</p>
              <p className="mt-1 text-[13px] leading-snug text-white/75 sm:text-sm">{fact.detail}</p>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  )
}
