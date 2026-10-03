import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Badge } from "@/components/ui/Badge"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { SessionClosureAdminSection } from "./SessionClosureAdminSection"
import { useSessionDetail } from "@/hooks/useReports"
import { getApiErrorMessage } from "@/services/api"
import {
  CHARGING_SESSION_STATUS_LABELS,
  PAYMENT_INTENT_STATUS_LABELS,
  formatCents,
  formatDateTime,
  formatDurationMinutes,
  formatEnergyWh,
  paymentStatusBadgeVariant,
  sessionStatusBadgeVariant,
} from "@/lib/utils"

/**
 * Drill-down de uma sessão (clique na linha da tela de Sessões). `driver.email`
 * só vem preenchido para ADMIN — a UI simplesmente não pede/mostra o campo
 * pro OPERATOR (o backend já nem manda, LGPD), não é um `if` de esconder aqui.
 */
export function SessionDetailDialog({ sessionId, onOpenChange }: { sessionId: string | null; onOpenChange: (open: boolean) => void }) {
  const { data, isLoading, isError, error, refetch } = useSessionDetail(sessionId ?? undefined)
  // F5.9: em `STOP_UNCONFIRMED` ainda não há custo calculado (campos `null`) — "R$ 0,00" diria que já foi apurado.
  const money = (cents: number | null) => (data?.status === "STOP_UNCONFIRMED" && cents === null ? "—" : formatCents(cents))

  return (
    <Dialog open={Boolean(sessionId)} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Detalhe da sessão{data ? ` #${data.ocppTransactionId}` : ""}</DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar a sessão.")} onRetry={() => refetch()} />}

        {!isLoading && !isError && data && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={sessionStatusBadgeVariant(data.status)}>{CHARGING_SESSION_STATUS_LABELS[data.status]}</Badge>
              <span className="text-ink-softer">{data.site.name}</span>
              <span className="text-ink-subtle">·</span>
              <span className="text-ink-softer">
                {data.chargePoint.ocppIdentity} · conector {data.connectorId}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-3">
              <Field label="Motorista" value={data.driver.name} />
              {/* `email` só vem preenchido para ADMIN — não mostramos o rótulo nem "—" pro OPERATOR, a UI simplesmente não pede o campo. */}
              {data.driver.email && <Field label="E-mail" value={data.driver.email} />}
              <Field label="Início" value={formatDateTime(data.startedAt)} />
              <Field label="Fim" value={formatDateTime(data.stoppedAt)} />
              <Field label="Energia entregue" value={formatEnergyWh(data.energyDeliveredWh)} />
              <Field label="Ociosidade" value={data.idleSeconds !== null ? formatDurationMinutes(data.idleSeconds / 60) : "—"} />
              <Field label="Tarifa" value={data.tariffName} />
              <Field label="Motivo de encerramento" value={data.stopReason ?? "—"} />
            </dl>

            <SessionClosureAdminSection session={data} />

            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-softer">Custos</p>
              <dl className="grid grid-cols-2 gap-2 rounded-xl border border-border-subtle p-3">
                <Field label="Energia" value={money(data.costs.energyCostCents)} compact />
                <Field label="Ociosidade" value={money(data.costs.idleFeeCents)} compact />
                <Field label="Taxa de sessão" value={money(data.costs.sessionFeeCents)} compact />
                <Field label="Ajuste (mínimo)" value={money(data.costs.minChargeAdjustmentCents)} compact />
                <Field label="Total" value={money(data.costs.totalCostCents)} compact strong />
              </dl>
            </div>

            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-softer">Pagamentos</p>
              {data.paymentIntents.length === 0 ? (
                <p className="text-ink-softer">Nenhuma tentativa de pagamento registrada.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.paymentIntents.map((pi) => (
                    <li key={pi.id} className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle px-3 py-2">
                      <span className="flex items-center gap-2">
                        <Badge variant={paymentStatusBadgeVariant(pi.status)}>{PAYMENT_INTENT_STATUS_LABELS[pi.status]}</Badge>
                        <span className="text-ink-softer">{formatDateTime(pi.createdAt)}</span>
                      </span>
                      <span className="font-semibold tabular-nums text-ink">{formatCents(pi.amountCapturedCents ?? pi.amountRequestedCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, compact, strong }: { label: string; value: string; compact?: boolean; strong?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">{label}</dt>
      <dd className={compact ? (strong ? "text-gradient-brand text-base font-black" : "text-ink-soft") : "font-semibold text-ink"}>{value}</dd>
    </div>
  )
}
