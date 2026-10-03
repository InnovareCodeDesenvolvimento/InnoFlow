import { Link } from "react-router-dom"
import { ArrowRight, BarChart3, Gauge, LayoutDashboard, Receipt, DollarSign, Zap, CheckCircle2, BatteryCharging } from "lucide-react"
import logoIcon from "@/assets/logo-icon-sm.png"
import { ADMIN_MOCK_NAV, CTA_LINKS, EXAMPLE_NOTICE, OPERATOR_AREAS } from "./landing-data"
import { PanelTilt } from "./PanelTilt"
import { Reveal } from "./Reveal"
import { spotlightMove } from "./motion-hooks"
import { SectionHeading } from "./SectionHeading"

/**
 * Mock do painel administrativo (réplica ILUSTRATIVA de `pages/Admin/Dashboard`: mesmos 6 cartões de métrica e a
 * mesma navegação lateral de `adminNav.ts`). Os números são de EXEMPLO e a moldura traz o selo "Dados de exemplo".
 */
const METRICS = [
  { label: "Faturamento", value: "R$ 8.450,00", delta: "+12%", icon: DollarSign, hi: true },
  { label: "Sessões", value: "128", delta: "+8%", icon: Zap },
  { label: "Energia", value: "1,2 MWh", delta: "+10%", icon: BatteryCharging },
  { label: "Ticket médio", value: "R$ 66,02", delta: "+3%", icon: Receipt },
  { label: "Taxa de sucesso", value: "96,1%", delta: "+1%", icon: CheckCircle2 },
  { label: "Utilização", value: "38,4%", delta: "+5%", icon: Gauge },
] as const

const BARS = [38, 52, 44, 68, 60, 82, 74, 92, 70, 86, 98, 90]

function AdminMock() {
  return (
    <div className="overflow-hidden rounded-2xl bg-surface text-ink shadow-2xl ring-1 ring-white/25" data-testid="admin-mock">
      <div className="flex items-center gap-2 border-b border-border-subtle bg-muted px-3.5 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <i className="h-2.5 w-2.5 rounded-full bg-danger-600/70" />
          <i className="h-2.5 w-2.5 rounded-full bg-warning/80" />
          <i className="h-2.5 w-2.5 rounded-full bg-accent-500/80" />
        </span>
        <span className="mx-auto truncate rounded-md bg-surface px-3 py-0.5 text-[11px] font-semibold text-ink-softer">Painel administrativo · Dashboard</span>
        <span className="shrink-0 rounded-full bg-warning-100 px-2 py-0.5 text-[10px] font-bold text-warning-700">Dados de exemplo</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div className="hidden w-44 shrink-0 bg-primary-950 p-3 text-white sm:block">
          <div className="mb-3 flex items-center gap-2 px-1.5">
            <img src={logoIcon} alt="" width={22} height={22} className="h-[22px] w-[22px]" />
            <span className="text-xs font-extrabold">InnoFlow</span>
          </div>
          <ul className="space-y-0.5 text-[11px] font-semibold">
            {ADMIN_MOCK_NAV.map((item, i) => (
              <li key={item} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${i === 0 ? "bg-white/15 text-white" : "text-white/70"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${i === 0 ? "bg-accent-glow" : "bg-white/30"}`} />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 bg-background p-3.5 sm:p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <LayoutDashboard className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-extrabold leading-none">Dashboard</p>
              <p className="mt-1 text-[10px] text-ink-softer">Visão geral do faturamento e da operação.</p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {METRICS.map((m) => (
              <div key={m.label} className={`rounded-xl border p-2.5 ${"hi" in m && m.hi ? "border-primary/20 bg-primary-50" : "border-border-subtle bg-surface"}`}>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold text-ink-softer">{m.label}</p>
                  <m.icon className="h-3.5 w-3.5 text-primary" />
                </div>
                <p className="mt-1 text-sm font-extrabold tabular-nums sm:text-base">{m.value}</p>
                <p className="text-[10px] font-bold text-success-700">{m.delta}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-[1.4fr_1fr]">
            <div className="rounded-xl border border-border-subtle bg-surface p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-bold">
                <BarChart3 className="h-3.5 w-3.5 text-primary" />
                Faturamento no período
              </p>
              <div className="mt-2 flex h-24 items-end gap-1.5" aria-hidden="true">
                {BARS.map((h, i) => (
                  <i
                    key={i}
                    className="lnd-grow flex-1 rounded-t-md bg-gradient-to-t from-primary-600 to-brand-teal"
                    style={{ height: `${h}%`, ["--d" as string]: `${i * 55}ms` }}
                  />
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border-subtle bg-surface p-3">
              <p className="text-[11px] font-bold">Sessões ativas agora</p>
              <ul className="mt-2 space-y-2">
                {[
                  ["CP-EXEMPLO-01", 72],
                  ["CP-EXEMPLO-02", 41],
                  ["CP-EXEMPLO-03", 18],
                ].map(([name, pct], i) => (
                  <li key={name}>
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="font-semibold">{name}</span>
                      <span className="inline-flex items-center gap-1 font-bold text-accent-700">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-500" />
                        Em recarga
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <i
                        className="lnd-grow-x block h-full rounded-full bg-gradient-to-r from-accent-500 to-accent-glow"
                        style={{ width: `${pct}%`, ["--d" as string]: `${300 + i * 150}ms` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * "Para quem opera": painel em perspectiva (se endireita ao rolar) + as 8 áreas reais do painel. Fundo escuro para
 * alternar com as seções claras vizinhas.
 */
export function OperatorSection() {
  return (
    <section
      id="para-quem-opera"
      aria-labelledby="operadores-titulo"
      className="lnd-dark lnd-section relative isolate overflow-clip py-20 sm:py-28"
    >
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="operadores-titulo"
          tone="dark"
          eyebrow="Para quem opera"
          title="Um painel completo para o seu eletroposto"
          description="Dashboard, sessões, financeiro, tarifas e carregadores no mesmo lugar, com cada operador vendo apenas os próprios dados."
        />

        <div className="mx-auto mt-14 max-w-4xl">
          <PanelTilt testId="operator-tilt">
            <AdminMock />
          </PanelTilt>
          <p className="mt-8 text-center text-xs font-medium text-white/65">{EXAMPLE_NOTICE}</p>
        </div>

        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {OPERATOR_AREAS.map((area, i) => (
            <Reveal
              as="li"
              key={area.id}
              delay={(i % 4) * 80}
              onPointerMove={spotlightMove}
              className="lnd-spot rounded-2xl border border-white/12 bg-white/[0.06] p-5"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-glow/15 text-accent-glow">
                <area.icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-lg font-bold !text-white">{area.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-white/75">{area.text}</p>
            </Reveal>
          ))}
        </ul>

        <Reveal className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to={CTA_LINKS.login} className="lnd-btn lnd-btn-lime">
            Entrar no painel
            <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </Link>
        </Reveal>
      </div>
    </section>
  )
}
