import { Link } from "react-router-dom"
import { ChevronRight, QrCode, Wallet, Zap } from "lucide-react"
import { MascotFace } from "@/components/brand/Mascot"
import { AppBand } from "@/components/pwa/AppBand"
import { Badge } from "@/components/ui/Badge"
import { Card } from "@/components/ui/Card"
import { EmptyState } from "@/components/ui/EmptyState"
import { IconBadge } from "@/components/ui/IconBadge"
import { Skeleton } from "@/components/ui/Skeleton"
import { NearbyStationsSection } from "@/components/estacoes/NearbyStationsSection"
import { useActiveSession, useMeSessions, useMeWallet } from "@/hooks/useMeSessions"
import { useAuthStore } from "@/store/authStore"
import { formatSessionAmount } from "@/lib/sessionClosure"
import { CHARGING_SESSION_STATUS_LABELS, formatCents, formatDateTime, formatEnergyWh, sessionStatusBadgeVariant } from "@/lib/utils"

/**
 * `/app` — home do motorista: saldo, sessão ativa (se houver), atalho de "como carregar" e as últimas recargas.
 * Design system unificado (F-C): a moldura escura carrega o que importa primeiro (saudação, saldo, recarga em andamento); o miolo claro, o resto.
 */
export function Home() {
  const { user } = useAuthStore()
  const { data: wallet, isLoading: walletLoading } = useMeWallet({ pageSize: 1 })
  const { data: activeData } = useActiveSession()
  const { data: recentSessions, isLoading: sessionsLoading } = useMeSessions({ page: 1, pageSize: 3 })

  const session = activeData?.session

  return (
    <div>
      <AppBand className="pb-6">
        <p className="text-sm text-ink-softer">Olá, {user?.name?.split(" ")[0] ?? "motorista"}</p>
        <h1 className="text-xl font-black tracking-tight text-ink">Bem-vindo de volta</h1>

        <div className="glass-strong animate-fade-in-up mt-4 flex items-center justify-between gap-3 rounded-3xl p-5">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-ink-softer">
              <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
              Saldo
            </p>
            {walletLoading ? (
              <Skeleton className="mt-2 h-9 w-28 bg-white/10" />
            ) : (
              <p className="mt-1 text-3xl font-black tracking-tight text-white">{formatCents(wallet?.balanceCents)}</p>
            )}
          </div>
          <Link
            to="/app/carteira"
            className="flex min-h-11 shrink-0 items-center rounded-full bg-white/10 px-4 text-xs font-bold text-white ring-1 ring-white/20 hover:bg-white/15"
          >
            Ver carteira
          </Link>
        </div>

        {session && (
          <Link
            to="/app/sessao"
            className="stagger-1 animate-fade-in-up mt-3 flex items-center gap-3 rounded-2xl bg-lime/10 p-4 ring-1 ring-lime/40 transition-colors hover:bg-lime/15 active:scale-[0.99]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-lime text-on-lime">
              <Zap className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white">Recarga em andamento</p>
              <p className="truncate text-xs text-ink-softer">{session.site.name} · toque para acompanhar</p>
            </div>
            <ChevronRight className="h-5 w-5 shrink-0 text-lime" aria-hidden="true" />
          </Link>
        )}
      </AppBand>

      <div className="mx-auto max-w-md space-y-5 px-4 py-5">
        <Card className="stagger-2 animate-fade-in-up flex items-center gap-3.5 p-4">
          <IconBadge icon={QrCode} size="lg" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">Pronto para carregar?</p>
            <p className="mt-0.5 text-xs text-ink-softer">Aponte a câmera do seu celular para o QR code no carregador.</p>
          </div>
        </Card>

        <NearbyStationsSection />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink">Últimas recargas</h2>
            <Link to="/app/sessoes" className="flex min-h-11 items-center text-xs font-semibold text-primary hover:underline">
              Ver tudo
            </Link>
          </div>

          {sessionsLoading && (
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-16 rounded-2xl" />
            </div>
          )}

          {!sessionsLoading && (!recentSessions || recentSessions.items.length === 0) && (
            <EmptyState tone="brand" title="Suas recargas vão aparecer aqui." art={<MascotFace size={64} />} className="py-8" />
          )}

          {!sessionsLoading && recentSessions && recentSessions.items.length > 0 && (
            <div className="space-y-2">
              {recentSessions.items.map((item, index) => (
                <Link
                  key={item.id}
                  to={`/app/sessoes/${item.id}`}
                  className={`card-elevated pressable stagger-${Math.min(index + 3, 4)} animate-fade-in-up flex items-center gap-3 p-3.5 transition-colors hover:ring-primary/30`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="max-w-full truncate text-sm font-bold text-ink">{item.siteName}</p>
                      <Badge variant={sessionStatusBadgeVariant(item.status)} className="whitespace-nowrap">{CHARGING_SESSION_STATUS_LABELS[item.status]}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-softer">
                      {formatDateTime(item.startedAt)} · {formatEnergyWh(item.energyDeliveredWh)} · {formatSessionAmount(item.status, item.totalCostCents)}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
