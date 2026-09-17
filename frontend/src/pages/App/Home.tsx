import { Link } from "react-router-dom"
import { ChevronRight, History, QrCode, Wallet, Zap } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { Card, CardContent } from "@/components/ui/Card"
import { Skeleton } from "@/components/ui/Skeleton"
import { useActiveSession, useMeSessions, useMeWallet } from "@/hooks/useMeSessions"
import { useAuthStore } from "@/store/authStore"
import { CHARGING_SESSION_STATUS_LABELS, formatCents, formatDateTime, formatEnergyWh, sessionStatusBadgeVariant } from "@/lib/utils"

/** `/app` — home do motorista: saldo, sessão ativa (se houver), atalho de "como carregar" e as últimas recargas. */
export function Home() {
  const { user } = useAuthStore()
  const { data: wallet, isLoading: walletLoading } = useMeWallet({ pageSize: 1 })
  const { data: activeData } = useActiveSession()
  const { data: recentSessions, isLoading: sessionsLoading } = useMeSessions({ page: 1, pageSize: 3 })

  const session = activeData?.session

  return (
    <div className="mx-auto max-w-md space-y-5 px-4 py-5">
      <div>
        <p className="text-sm text-ink-softer">Olá, {user?.name?.split(" ")[0] ?? "motorista"}</p>
        <h1 className="text-xl font-black tracking-tight text-ink">Bem-vindo de volta</h1>
      </div>

      <Card className="animate-fade-in-up bg-primary-950 text-white ring-0">
        <CardContent className="flex items-center justify-between gap-3 p-5">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-white/60">
              <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
              Saldo
            </p>
            {walletLoading ? (
              <Skeleton className="mt-2 h-8 w-28 bg-white/10" />
            ) : (
              <p className="mt-1 text-3xl font-black tracking-tight">{formatCents(wallet?.balanceCents)}</p>
            )}
          </div>
          <Link
            to="/app/carteira"
            className="shrink-0 rounded-full bg-white/10 px-3.5 py-2 text-xs font-bold text-white ring-1 ring-white/20 hover:bg-white/15"
          >
            Ver carteira
          </Link>
        </CardContent>
      </Card>

      {session && (
        <Link
          to="/app/sessao"
          className="pressable stagger-1 animate-fade-in-up flex items-center gap-3 rounded-2xl bg-accent/10 p-4 ring-1 ring-accent/30 transition-colors hover:bg-accent/15"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/20 text-accent-700">
            <Zap className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-accent-700">Recarga em andamento</p>
            <p className="truncate text-xs text-ink-softer">{session.site.name} · toque para acompanhar</p>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-accent-700" aria-hidden="true" />
        </Link>
      )}

      <div className="stagger-2 animate-fade-in-up rounded-2xl border border-dashed border-border-strong bg-muted/40 p-5 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <QrCode className="h-6 w-6" aria-hidden="true" />
        </span>
        <p className="mt-3 text-sm font-bold text-ink">Pronto para carregar?</p>
        <p className="mt-1 text-xs text-ink-softer">Aponte a câmera do seu celular para o QR code no carregador.</p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-ink">Últimas recargas</h2>
          <Link to="/app/sessoes" className="text-xs font-semibold text-primary hover:underline">
            Ver tudo
          </Link>
        </div>

        {sessionsLoading && (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-16 rounded-2xl" />
          </div>
        )}

        {!sessionsLoading && (!recentSessions || recentSessions.items.length === 0) && (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border-strong px-4 py-8 text-center">
            <History className="h-6 w-6 text-ink-subtle" aria-hidden="true" />
            <p className="text-xs text-ink-softer">Suas recargas vão aparecer aqui.</p>
          </div>
        )}

        {!sessionsLoading && recentSessions && recentSessions.items.length > 0 && (
          <div className="space-y-2">
            {recentSessions.items.map((item, index) => (
              <Link
                key={item.id}
                to={`/app/sessoes/${item.id}`}
                className={`pressable stagger-${Math.min(index + 3, 4)} animate-fade-in-up flex items-center gap-3 rounded-2xl border border-border-subtle bg-surface p-3.5 shadow-card transition-colors hover:border-primary/30`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-bold text-ink">{item.siteName}</p>
                    <Badge variant={sessionStatusBadgeVariant(item.status)}>{CHARGING_SESSION_STATUS_LABELS[item.status]}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-softer">
                    {formatDateTime(item.startedAt)} · {formatEnergyWh(item.energyDeliveredWh)} · {formatCents(item.totalCostCents)}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
