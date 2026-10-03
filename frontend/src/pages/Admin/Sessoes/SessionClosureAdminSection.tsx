import { Info } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { ADMIN_CLOSURE_COPY } from "@/lib/sessionClosureCopy"
import {
  CLOSURE_SOURCE_LABELS,
  METER_STOP_SOURCE_LABELS,
  STOP_REQUESTER_LABELS,
  STOP_UNCONFIRMED_REASON_LABELS,
} from "@/lib/sessionClosure"
import { formatCents, formatDateTime, formatEnergyWh } from "@/lib/utils"
import type { SessionDetail } from "@/types/api"

const F = ADMIN_CLOSURE_COPY.fields

/**
 * F5.9 — como/por que a sessão fechou (ou por que ainda não fechou), no detalhe do ADMIN.
 * O bloco "StopTransaction tardio" é INFORMATIVO: o servidor já tinha encerrado e cobrado com a melhor prova
 * disponível; o que chegou depois só é registrado (`unbilledCostCents` = o que teria sido cobrado a mais).
 * Retorna `null` quando não há nada a mostrar (sessão normal e anterior à F5.9).
 */
export function SessionClosureAdminSection({ session }: { session: SessionDetail }) {
  const { closure, lateStop } = session
  const unconfirmed = session.status === "STOP_UNCONFIRMED"
  const hasStopRequest = session.stopRequestedAt !== null || session.stopAttempts > 0 || session.stopRequestedBy !== null
  const hasClosure = closure.source !== null || closure.meterStopSource !== null
  if (!unconfirmed && !hasStopRequest && !hasClosure && !lateStop) return null

  return (
    <div data-testid="admin-session-closure" className="space-y-3">
      <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">{ADMIN_CLOSURE_COPY.sectionTitle}</p>

      {unconfirmed && (
        <p className="flex items-start gap-2 rounded-xl bg-warning-50 px-3 py-2.5 text-xs font-semibold text-warning-700">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {ADMIN_CLOSURE_COPY.unconfirmedNote}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-3 rounded-xl border border-border-subtle p-3">
        {unconfirmed && (
          <>
            <Item label={F.unconfirmedReason} value={closure.unconfirmedReason ? STOP_UNCONFIRMED_REASON_LABELS[closure.unconfirmedReason] : "—"} />
            <Item label={F.unconfirmedSince} value={formatDateTime(closure.unconfirmedSince)} />
            <Item label={F.confirmDeadline} value={formatDateTime(closure.confirmDeadline)} />
          </>
        )}
        {hasStopRequest && (
          <>
            <Item label={F.stopRequestedBy} value={session.stopRequestedBy ? STOP_REQUESTER_LABELS[session.stopRequestedBy] : "—"} />
            <Item label={F.stopRequestedAt} value={formatDateTime(session.stopRequestedAt)} />
            <Item label={F.stopAttempts} value={String(session.stopAttempts)} />
          </>
        )}
        {closure.source && <Item label={F.closureSource} value={CLOSURE_SOURCE_LABELS[closure.source]} />}
        {closure.meterStopSource && <Item label={F.meterStopSource} value={METER_STOP_SOURCE_LABELS[closure.meterStopSource]} />}
        {closure.source === "SERVER" && <Item label={F.billedUntil} value={formatDateTime(closure.billedUntil)} />}
      </dl>

      {lateStop && (
        <div data-testid="admin-late-stop" className="rounded-xl border border-info/30 bg-info-50 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-xs font-bold uppercase tracking-wide text-info-700">{ADMIN_CLOSURE_COPY.lateStopTitle}</p>
            <Badge variant="info" className="whitespace-nowrap">
              Informativo
            </Badge>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <Item label={F.lateMeterStopWh} value={formatEnergyWh(lateStop.meterStopWh)} />
            <Item label={F.lateStoppedAt} value={formatDateTime(lateStop.stoppedAt)} />
            <Item label={F.lateReceivedAt} value={formatDateTime(lateStop.receivedAt)} />
            <Item label={F.lateUnbilledCost} value={formatCents(lateStop.unbilledCostCents)} />
          </dl>
          <p className="mt-2 text-xs text-info-700">{ADMIN_CLOSURE_COPY.lateStopNote}</p>
        </div>
      )}
    </div>
  )
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  )
}
