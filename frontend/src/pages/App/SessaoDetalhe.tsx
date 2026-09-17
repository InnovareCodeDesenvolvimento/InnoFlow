import { Link, useLocation, useParams } from "react-router-dom"
import { AlertTriangle, ArrowLeft, CheckCircle2 } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { Card, CardContent } from "@/components/ui/Card"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { InstallPromptCard } from "@/components/pwa/InstallPromptCard"
import { useMeSessionDetail } from "@/hooks/useMeSessions"
import { getApiErrorMessage } from "@/services/api"
import {
  CHARGING_SESSION_STATUS_LABELS,
  formatCents,
  formatDateTime,
  formatEnergyWh,
  sessionStatusBadgeVariant,
} from "@/lib/utils"

const COST_ROWS: Array<{ key: "energyCostCents" | "timeCostCents" | "idleFeeCents" | "sessionFeeCents" | "minChargeAdjustmentCents"; label: string }> = [
  { key: "energyCostCents", label: "Energia" },
  { key: "timeCostCents", label: "Tempo" },
  { key: "idleFeeCents", label: "Ociosidade" },
  { key: "sessionFeeCents", label: "Taxa fixa" },
  { key: "minChargeAdjustmentCents", label: "Ajuste de cobrança mínima" },
]

/**
 * `/app/sessoes/:id` — o recibo. Decomposição linha a linha do custo (só as
 * linhas que a tarifa usada de fato gerou — os outros campos vêm `null`,
 * não `0`, e omitir a linha inteira é mais claro que mostrar "R$0,00" pra
 * algo que nem se aplica a este modelo de tarifa).
 *
 * `justCompleted` (vindo de `Sessao.tsx` só na navegação logo após parar)
 * é o único gatilho do convite de instalação — nunca em visitas posteriores
 * ao histórico.
 */
export function SessaoDetalhe() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const justCompleted = !!(location.state as { justCompleted?: boolean } | null)?.justCompleted

  const { data: session, isLoading, isError, error, refetch } = useMeSessionDetail(id)

  return (
    <div className="mx-auto max-w-md px-4 py-5">
      <Link to="/app/sessoes" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-softer hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Histórico
      </Link>

      {isLoading && (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-6 w-1/2 rounded-md" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      )}

      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar o recibo.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && session && (
        <>
          {justCompleted && (
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-success-50 px-4 py-3 text-sm font-bold text-success-700">
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
              Recarga concluída
            </div>
          )}

          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-black tracking-tight text-ink">{session.site.name}</h1>
              <p className="text-sm text-ink-softer">
                {session.chargePoint.ocppIdentity} · Conector {session.connector.connectorId}
              </p>
            </div>
            <Badge variant={sessionStatusBadgeVariant(session.status)} className="shrink-0">
              {CHARGING_SESSION_STATUS_LABELS[session.status]}
            </Badge>
          </div>

          <Card className="mt-4">
            <CardContent className="grid grid-cols-2 gap-4 p-5">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-ink-subtle">Início</p>
                <p className="text-sm font-semibold text-ink">{formatDateTime(session.startedAt)}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-ink-subtle">Fim</p>
                <p className="text-sm font-semibold text-ink">{formatDateTime(session.stoppedAt)}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-ink-subtle">Energia</p>
                <p className="text-sm font-semibold text-ink">{formatEnergyWh(session.energyDeliveredWh)}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-ink-subtle">Tarifa</p>
                <p className="truncate text-sm font-semibold text-ink">{session.tariff.name}</p>
              </div>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardContent className="p-5">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-subtle">Detalhamento do custo</p>
              <dl className="space-y-2">
                {COST_ROWS.filter((row) => session[row.key] !== null).map((row) => (
                  <div key={row.key} className="flex items-center justify-between text-sm">
                    <dt className="text-ink-softer">{row.label}</dt>
                    <dd className="font-semibold text-ink">{formatCents(session[row.key])}</dd>
                  </div>
                ))}
                <div className="flex items-center justify-between border-t border-border-subtle pt-2.5 text-base">
                  <dt className="font-bold text-ink">Total</dt>
                  <dd className="font-black text-ink">{formatCents(session.totalCostCents)}</dd>
                </div>
              </dl>

              {session.walletEntry ? (
                <div className="mt-4 flex items-center justify-between rounded-xl bg-muted px-4 py-3">
                  <span className="text-xs font-semibold text-ink-softer">Novo saldo da carteira</span>
                  <span className="text-sm font-black text-ink">{formatCents(session.walletEntry.balanceAfterCents)}</span>
                </div>
              ) : (
                <p className="mt-4 rounded-xl bg-muted px-4 py-3 text-xs text-ink-softer">A cobrança ainda está sendo processada.</p>
              )}

              {session.debt && (
                <p className="mt-3 flex items-start gap-2 rounded-xl bg-danger-50 px-4 py-3 text-xs font-semibold text-danger-700">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {formatCents(session.debt.amountCents)} ficaram em aberto — quite na carteira para poder carregar de novo.
                </p>
              )}
            </CardContent>
          </Card>

          {justCompleted && (
            <div className="mt-4">
              <InstallPromptCard />
            </div>
          )}
        </>
      )}
    </div>
  )
}
