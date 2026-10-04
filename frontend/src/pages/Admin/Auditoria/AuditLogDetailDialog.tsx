import { ScrollText } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Badge } from "@/components/ui/Badge"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { useAuditLogDetail } from "@/hooks/useAuditLogs"
import { getApiErrorMessage } from "@/services/api"
import { AUDIT_ACTION_LABELS, AUDIT_OUTCOME_LABELS, auditOutcomeBadgeVariant, formatDateTime, ROLE_LABELS } from "@/lib/utils"

/** Valor bruto de `changes` → texto legível. `null`/`undefined` vira "—" em vez de "null" cru na tela. */
function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "boolean") return value ? "Sim" : "Não"
  return String(value)
}

/**
 * Drill-down de um evento de auditoria. O diff (`changes`) é a razão de ser
 * desta tela — formatado como "campo: antes → depois", nunca um JSON cru
 * dumped (pedido explícito: é tela forense, humano vai ler pra investigar).
 */
export function AuditLogDetailDialog({ id, onOpenChange }: { id: string | null; onOpenChange: (open: boolean) => void }) {
  const { data, isLoading, isError, error, refetch } = useAuditLogDetail(id ?? undefined)

  return (
    <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-xl">
        <DialogHeader icon={ScrollText}>
          <DialogTitle>Detalhe do evento de auditoria</DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar o evento.")} onRetry={() => refetch()} />}

        {!isLoading && !isError && data && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={auditOutcomeBadgeVariant(data.outcome)}>{AUDIT_OUTCOME_LABELS[data.outcome]}</Badge>
              <span className="text-ink-softer">{AUDIT_ACTION_LABELS[data.action]}</span>
              {data.httpStatus && (
                <>
                  <span className="text-ink-softer">·</span>
                  <span className="text-ink-softer">HTTP {data.httpStatus}</span>
                </>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-3">
              <Field label="Quando" value={formatDateTime(data.occurredAt)} />
              <Field label="Ator" value={`${data.actor.name} (${ROLE_LABELS[data.actor.role]})`} />
              <Field label="E-mail" value={data.actor.email} />
              <Field label="Entidade" value={data.entityType ? `${data.entityType}${data.entityId ? ` · ${data.entityId}` : ""}` : "—"} />
              <Field label="Rota" value={`${data.method} ${data.path}`} mono />
              <Field label="IP" value={data.ipAddress ?? "—"} />
              {data.correlationId && <Field label="Correlation ID" value={data.correlationId} mono />}
              {data.requestId && <Field label="Request ID" value={data.requestId} mono />}
            </dl>

            {data.actionDetail && <p className="rounded-lg bg-muted/60 px-3 py-2 text-ink-soft">{data.actionDetail}</p>}

            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-softer">Alterações</p>
              {!data.hasChanges || !data.changes ? (
                <p className="rounded-lg border border-dashed border-border-strong px-3 py-3 text-ink-softer">Nenhuma alteração registrada para este evento.</p>
              ) : (
                <ul className="space-y-1.5">
                  {Object.entries(data.changes).map(([field, rawValue]) => {
                    const change = rawValue as { from?: unknown; to?: unknown } | unknown
                    const isPair = change !== null && typeof change === "object" && ("from" in (change as object) || "to" in (change as object))
                    return (
                      <li key={field} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-border-subtle px-3 py-2">
                        <span className="font-semibold text-ink">{field}</span>
                        {isPair ? (
                          <span className="text-ink-soft">
                            <span className="text-ink-softer line-through">{formatChangeValue((change as { from?: unknown }).from)}</span>{" "}
                            <span aria-hidden="true">→</span> <span className="font-medium">{formatChangeValue((change as { to?: unknown }).to)}</span>
                          </span>
                        ) : (
                          <span className="text-ink-soft">{formatChangeValue(change)}</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">{label}</dt>
      <dd className={mono ? "truncate font-mono text-xs text-ink" : "font-semibold text-ink"}>{value}</dd>
    </div>
  )
}
