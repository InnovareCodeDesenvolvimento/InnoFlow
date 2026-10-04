import type { ReactNode } from "react"
import {
  Battery,
  Check,
  CheckCircle2,
  History,
  Home,
  Loader2,
  MapPin,
  Navigation,
  Search,
  Signal,
  Wifi,
  Wallet,
  Zap,
} from "lucide-react"
import logoIcon from "@/assets/landing/logo-icon-96.webp"
import { mulberry32 } from "./flow-network"
import { useElapsed } from "./motion-hooks"
import type { TourScreen } from "./landing-data"

/**
 * Telas do celular da seção "Como funciona". São RÉPLICAS ILUSTRATIVAS do que o app mostra (mesmo vocabulário
 * visual: `card-premium`, `text-gradient-brand`, `animate-live-glow`, mesmos rótulos de `pages/App/*` e
 * `pages/Public/ChargePointLanding.tsx`), com DADOS DE EXEMPLO — nenhum eletroposto, preço ou saldo aqui é real.
 * Tudo é aria-hidden; o texto do passo (ao lado) é quem informa. Os números ao vivo (kWh, valor, tempo, bateria)
 * sobem de verdade enquanto a tela está ativa.
 */

const TARIFF_PER_KWH = 2.1 // exemplo ilustrativo, não é preço real
const START_BALANCE = 185.28 // saldo de exemplo antes da recarga
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
const num = (v: number, d = 1) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })

function StatusBar({ dark = false }: { dark?: boolean }) {
  return (
    <div className={`flex h-7 shrink-0 items-center justify-between px-6 text-[10px] font-bold ${dark ? "text-white" : "text-ink"}`}>
      <span>09:41</span>
      <span className="flex items-center gap-1" aria-hidden="true">
        <Signal className="h-3 w-3" />
        <Wifi className="h-3 w-3" />
        <Battery className="h-3.5 w-3.5" />
      </span>
    </div>
  )
}

const NAV = [
  { label: "Início", icon: Home },
  { label: "Mapa", icon: MapPin },
  { label: "Sessão", icon: Zap },
  { label: "Histórico", icon: History },
  { label: "Carteira", icon: Wallet },
] as const

/** Casca do app (cabeçalho + barra de navegação inferior) — igual a `pages/App/Layout.tsx`. */
function AppChrome({ active, children }: { active: (typeof NAV)[number]["label"]; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-background">
      <StatusBar />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-3.5">
        <img src={logoIcon} alt="" width={22} height={22} className="h-[22px] w-[22px]" />
        <span className="text-xs font-black tracking-tight text-ink">InnoFlow</span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
      <div className="flex shrink-0 items-stretch justify-around border-t border-border-subtle bg-surface pb-2 pt-1">
        {NAV.map((item) => {
          const on = item.label === active
          return (
            <span key={item.label} className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-[9px] font-semibold ${on ? "text-primary" : "text-ink-softer"}`}>
              <span className={`flex h-5 w-9 items-center justify-center rounded-full ${on ? "bg-primary/10" : ""}`}>
                <item.icon className="h-3.5 w-3.5" />
              </span>
              {item.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 1. Mapa */
function StationCard({ name, distance, free, total, connectors, delay }: { name: string; distance: string; free: number; total: number; connectors: string[]; delay: number }) {
  return (
    <div className="lnd-a-rise rounded-2xl border border-border-subtle bg-surface p-3 shadow-card" style={{ "--a-d": `${delay}ms` } as React.CSSProperties}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-bold text-ink">{name}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-softer">
            <MapPin className="h-2.5 w-2.5 shrink-0" />
            Endereço de exemplo
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-black tabular-nums text-primary-700">{distance}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-success-100 px-2 py-0.5 text-[10px] font-bold text-success-700">
          <Zap className="h-2.5 w-2.5" />
          Livre
        </span>
        <span className="text-[10px] font-semibold text-ink-soft">
          {free} de {total} livres
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {connectors.map((c) => (
            <span key={c} className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold text-primary-700">
              {c}
            </span>
          ))}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary px-2 py-1 text-[10px] font-bold text-white">
          <Navigation className="h-2.5 w-2.5" />
          Como chegar
        </span>
      </div>
    </div>
  )
}

function MapaScreen() {
  return (
    <AppChrome active="Mapa">
      <div className="space-y-2.5 px-3 pt-2.5">
        <div className="relative h-[108px] overflow-hidden rounded-2xl bg-primary-100 ring-1 ring-border-subtle">
          <svg viewBox="0 0 250 108" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice">
            <rect width="250" height="108" fill="rgb(var(--color-primary-100))" />
            <path d="M-10 70 C 60 50, 90 90, 150 60 S 230 40, 270 50" stroke="#fff" strokeWidth="9" fill="none" />
            <path d="M40 -10 C 55 30, 80 60, 100 118" stroke="#fff" strokeWidth="6" fill="none" />
            <path d="M170 -10 C 180 30, 200 70, 190 118" stroke="#fff" strokeWidth="6" fill="none" />
            <rect x="110" y="8" width="38" height="26" rx="6" fill="rgb(var(--color-accent-200))" />
          </svg>
          <span className="absolute left-[34%] top-[40%] flex h-6 w-6 items-center justify-center">
            <span className="lnd-a-ping absolute inset-0 rounded-full bg-accent/40" />
            <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white shadow-md ring-2 ring-white">
              <Zap className="h-3 w-3" />
            </span>
          </span>
          <span className="absolute left-[68%] top-[22%] flex h-5 w-5 items-center justify-center rounded-full bg-primary text-white shadow-md ring-2 ring-white">
            <Zap className="h-2.5 w-2.5" />
          </span>
          <span className="absolute right-[10%] top-[62%] flex h-5 w-5 items-center justify-center rounded-full bg-ink-softer text-white shadow-md ring-2 ring-white">
            <Zap className="h-2.5 w-2.5" />
          </span>
          <span className="absolute left-[52%] top-[56%] h-2.5 w-2.5 rounded-full bg-info ring-4 ring-info/25" />
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-2.5 py-1.5 text-[10px] text-ink-softer">
          <Search className="h-3 w-3" />
          Buscar por nome ou cidade
        </div>
        <StationCard name="Eletroposto de exemplo A" distance="1,2 km" free={2} total={3} connectors={["DC CCS2 · 60 kW", "AC Tipo 2 · 22 kW"]} delay={150} />
        <StationCard name="Eletroposto de exemplo B" distance="3,4 km" free={1} total={2} connectors={["DC CHAdeMO · 50 kW"]} delay={300} />
      </div>
    </AppChrome>
  )
}

/* ---------------------------------------------------------------- 2. QR */
const QR_SIZE = 21
const QR_CELLS: Array<[number, number]> = (() => {
  const rand = mulberry32(42)
  const cells: Array<[number, number]> = []
  const inFinder = (x: number, y: number) => (x < 8 && y < 8) || (x > QR_SIZE - 9 && y < 8) || (x < 8 && y > QR_SIZE - 9)
  for (let y = 0; y < QR_SIZE; y++) for (let x = 0; x < QR_SIZE; x++) if (!inFinder(x, y) && rand() > 0.52) cells.push([x, y])
  return cells
})()

function Finder({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width="7" height="7" fill="#0b2231" />
      <rect x="1" y="1" width="5" height="5" fill="#fff" />
      <rect x="2" y="2" width="3" height="3" fill="#0b2231" />
    </g>
  )
}

function QrScreen() {
  return (
    <div className="relative flex h-full flex-col bg-gradient-to-b from-[#0a1d2a] via-[#0f2c3f] to-[#06151f] text-white">
      <StatusBar dark />
      <p className="px-6 pt-3 text-center text-[11px] font-semibold text-white/80">Aponte a câmera para o QR code do carregador</p>
      <div className="relative mx-auto mt-6 flex h-[196px] w-[196px] items-center justify-center">
        {(["left-0 top-0 border-l-4 border-t-4 rounded-tl-2xl", "right-0 top-0 border-r-4 border-t-4 rounded-tr-2xl", "left-0 bottom-0 border-l-4 border-b-4 rounded-bl-2xl", "right-0 bottom-0 border-r-4 border-b-4 rounded-br-2xl"] as const).map((c) => (
          <span key={c} className={`absolute h-9 w-9 border-accent-glow ${c}`} />
        ))}
        <div className="rounded-xl bg-white p-2.5 shadow-2xl">
          <svg viewBox={`0 0 ${QR_SIZE} ${QR_SIZE}`} width="136" height="136" shapeRendering="crispEdges">
            {QR_CELLS.map(([x, y]) => (
              <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#0b2231" />
            ))}
            <Finder x={0} y={0} />
            <Finder x={QR_SIZE - 7} y={0} />
            <Finder x={0} y={QR_SIZE - 7} />
          </svg>
        </div>
        <span className="lnd-scan" />
      </div>
      <div className="lnd-a-rise mx-4 mt-auto mb-6 flex items-center gap-2.5 rounded-2xl bg-white p-3 text-ink shadow-2xl" style={{ "--a-d": "1800ms" } as React.CSSProperties}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-success-100 text-success-700">
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
        <span className="min-w-0 text-left">
          <span className="block text-[11px] font-black">Carregador encontrado</span>
          <span className="block truncate text-[10px] text-ink-softer">Abrindo a página do carregador…</span>
        </span>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 3. Iniciar */
function IniciarScreen() {
  return (
    <div className="relative flex h-full flex-col bg-background">
      <div className="relative shrink-0 overflow-hidden bg-gradient-to-br from-primary-950 via-primary-900 to-primary-800 pb-10 text-center">
        <StatusBar dark />
        <div className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 bg-[radial-gradient(closest-side,rgb(var(--color-accent-glow)/0.5),transparent)]" />
        <div className="relative mt-1 flex items-center justify-center gap-1.5">
          <img src={logoIcon} alt="" width={20} height={20} className="h-5 w-5" />
          <span className="text-xs font-black text-white">InnoFlow</span>
        </div>
        <p className="relative mt-1.5 text-[15px] font-black leading-snug text-white">
          Carregue um <span className="bg-gradient-to-r from-accent-300 to-accent-glow bg-clip-text text-transparent">futuro melhor</span>.
        </p>
      </div>
      <div className="relative z-10 -mt-7 px-3">
        <div className="card-premium p-3.5">
          <p className="text-[9px] font-bold uppercase tracking-wide text-ink-subtle">Eletroposto de exemplo A</p>
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-softer">
            <MapPin className="h-2.5 w-2.5" />
            Endereço de exemplo
          </p>
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-lg font-black text-primary-700">1</span>
              <div>
                <p className="text-[12px] font-bold text-ink">DC CCS2</p>
                <p className="text-[10px] text-ink-softer">60 kW</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-success-100 px-2 py-0.5 text-[10px] font-bold text-success-700">
              <Zap className="h-2.5 w-2.5" />
              Livre
            </span>
          </div>
          <div className="mt-3 rounded-xl bg-primary-50 p-2.5">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-ink-softer">Tarifa</p>
            <p className="text-lg font-black tracking-tight text-gradient-brand">{brl(TARIFF_PER_KWH)} / kWh</p>
          </div>
          <div className="mt-2.5 flex items-center justify-between rounded-xl bg-muted px-3 py-2">
            <span className="text-[10px] font-semibold text-ink-softer">Seu saldo</span>
            <span className="text-[11px] font-black text-ink">{brl(START_BALANCE)}</span>
          </div>
          <div className="lnd-a-tap btn-glow-primary mt-3 flex h-10 items-center justify-center gap-1.5 rounded-xl bg-primary text-[12px] font-bold text-white">
            <Zap className="h-3.5 w-3.5" />
            Iniciar recarga
          </div>
        </div>
      </div>

      {/* Estado "Conectando ao carregador…" (Sessao.tsx, awaitingStart) */}
      <div className="lnd-a-fade absolute inset-0 z-20 flex flex-col items-center justify-center bg-background/95 px-6 text-center" style={{ "--a-d": "2900ms" } as React.CSSProperties}>
        <span className="relative flex h-14 w-14 items-center justify-center">
          <span className="lnd-a-ping absolute inset-0 rounded-full bg-primary/20" />
          <span className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </span>
        </span>
        <p className="mt-4 text-[14px] font-black text-ink">Conectando ao carregador…</p>
        <p className="mt-1 text-[11px] text-ink-softer">Comando aceito — aguardando o carregador iniciar a recarga.</p>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 4. Carregando */
function CarregandoLive() {
  const ms = useElapsed(250, 20000)
  const s = ms / 1000
  const kwh = 12.4 + s * 0.42
  const total = 21 * 60 + 7 + s
  const hh = String(Math.floor(total / 3600)).padStart(2, "0")
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0")
  const ss = String(Math.floor(total % 60)).padStart(2, "0")
  const soc = Math.min(96, 54 + s * 0.28)
  return (
    <div className="card-premium animate-live-glow mx-3 mt-3 p-4 text-center">
      <p className="text-5xl font-black leading-none tracking-tight text-gradient-brand">
        {num(kwh)}
        <span className="ml-1 text-base font-bold text-ink-softer">kWh</span>
      </p>
      <p className="mt-2 text-sm font-bold text-primary-700">{brl(kwh * TARIFF_PER_KWH)}</p>
      <p className="mt-3 text-2xl font-black tabular-nums text-ink">
        {hh}:{mm}:{ss}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-left">
        <div className="rounded-xl bg-muted px-2.5 py-2">
          <p className="text-[9px] font-bold uppercase tracking-wide text-ink-subtle">Potência</p>
          <p className="text-[12px] font-bold text-ink">{num(48.2)} kW</p>
        </div>
        <div className="rounded-xl bg-muted px-2.5 py-2">
          <p className="text-[9px] font-bold uppercase tracking-wide text-ink-subtle">Bateria</p>
          <p className="text-[12px] font-bold text-ink">{Math.round(soc)}%</p>
        </div>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-gradient-to-r from-accent-500 to-accent-glow" style={{ width: `${soc}%` }} />
      </div>
    </div>
  )
}

function CarregandoScreen({ active }: { active: boolean }) {
  return (
    <AppChrome active="Sessão">
      <div className="px-3 pt-3">
        <p className="px-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-subtle">Eletroposto de exemplo A</p>
        <p className="px-0.5 text-[11px] text-ink-softer">CP-EXEMPLO · Conector 1</p>
      </div>
      {/* só monta o relógio quando a tela está ativa: o contador nasce zerado a cada visita */}
      {active ? (
        <CarregandoLive />
      ) : (
        <div className="card-premium mx-3 mt-3 p-4 text-center">
          <p className="text-5xl font-black leading-none tracking-tight text-gradient-brand">
            12,4<span className="ml-1 text-base font-bold text-ink-softer">kWh</span>
          </p>
        </div>
      )}
      <div className="mx-3 mt-4 flex h-10 items-center justify-center rounded-xl border border-danger-600/30 bg-danger-50 text-[12px] font-bold text-danger-700">Parar recarga</div>
    </AppChrome>
  )
}

/* ---------------------------------------------------------------- 5. Recibo */
function ReciboScreen() {
  const energy = 31.8
  return (
    <AppChrome active="Histórico">
      <div className="space-y-2.5 px-3 pt-3">
        <div className="lnd-a-rise flex items-center gap-2 rounded-xl bg-success-50 px-3 py-2 text-[12px] font-bold text-success-700">
          <CheckCircle2 className="lnd-a-pop h-4 w-4 shrink-0" style={{ "--a-d": "250ms" } as React.CSSProperties} />
          Recarga concluída
        </div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-black text-ink">Eletroposto de exemplo A</p>
            <p className="text-[10px] text-ink-softer">CP-EXEMPLO · Conector 1</p>
          </div>
          <span className="shrink-0 rounded-full bg-success-100 px-2 py-0.5 text-[10px] font-bold text-success-700">Concluída</span>
        </div>
        <div className="card-premium lnd-a-rise grid grid-cols-2 gap-2.5 p-3" style={{ "--a-d": "150ms" } as React.CSSProperties}>
          {[
            ["Início", "hoje, 09:41"],
            ["Fim", "hoje, 10:19"],
            ["Energia", `${num(energy)} kWh`],
            ["Tarifa", "Tarifa de exemplo"],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="text-[9px] font-bold uppercase tracking-wide text-ink-subtle">{k}</p>
              <p className="truncate text-[11px] font-semibold text-ink">{v}</p>
            </div>
          ))}
        </div>
        <div className="card-premium lnd-a-rise p-3" style={{ "--a-d": "300ms" } as React.CSSProperties}>
          <p className="mb-2 text-[9px] font-bold uppercase tracking-wide text-ink-subtle">Detalhamento do custo</p>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-ink-softer">Energia</span>
            <span className="font-semibold text-ink">{brl(energy * TARIFF_PER_KWH)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border-subtle pt-2">
            <span className="text-[12px] font-bold text-ink">Total</span>
            <span className="text-base font-black text-gradient-brand">{brl(energy * TARIFF_PER_KWH)}</span>
          </div>
          <div className="mt-2.5 flex items-center justify-between rounded-lg bg-muted px-2.5 py-2">
            <span className="text-[10px] font-semibold text-ink-softer">Novo saldo da carteira</span>
            <span className="text-[11px] font-black text-ink">{brl(START_BALANCE - energy * TARIFF_PER_KWH)}</span>
          </div>
        </div>
      </div>
    </AppChrome>
  )
}

/** Moldura do celular com as cinco telas empilhadas; só a ativa aparece (as outras ficam `visibility:hidden`). */
export function PhoneFrame({ step }: { step: TourScreen }) {
  const screens: Array<{ id: TourScreen; node: ReactNode }> = [
    { id: "mapa", node: <MapaScreen /> },
    { id: "qr", node: <QrScreen /> },
    { id: "iniciar", node: <IniciarScreen /> },
    { id: "carregando", node: <CarregandoScreen active={step === "carregando"} /> },
    { id: "recibo", node: <ReciboScreen /> },
  ]
  return (
    <div className="lnd-phone" aria-hidden="true" data-testid="tour-phone" data-step={step}>
      <div className="lnd-phone-screen">
        {screens.map((s) => (
          <div key={s.id} className="lnd-screen" data-active={s.id === step ? "true" : "false"} data-screen={s.id}>
            {s.node}
          </div>
        ))}
        <span className="pointer-events-none absolute left-1/2 top-2 z-30 h-[18px] w-20 -translate-x-1/2 rounded-full bg-[#06121b]" />
      </div>
    </div>
  )
}
