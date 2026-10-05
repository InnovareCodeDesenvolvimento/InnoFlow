import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { ScrollText } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { Badge } from "@/components/ui/Badge"
import { Select } from "@/components/ui/Select"
import { Input } from "@/components/ui/Input"
import { EmptyState } from "@/components/ui/EmptyState"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { PeriodSelector } from "@/components/relatorios/PeriodSelector"
import { OperatorFilterSelect } from "@/components/relatorios/OperatorFilterSelect"
import { AuditActorFilterSelect } from "@/components/relatorios/AuditActorFilterSelect"
import { ExportCsvButton } from "@/components/relatorios/ExportCsvButton"
import { useAuditLogs } from "@/hooks/useAuditLogs"
import { useReportPeriod } from "@/hooks/useReportPeriod"
import { useOperators } from "@/hooks/useOperators"
import { getApiErrorMessage } from "@/services/api"
import { AUDIT_ACTION_LABELS, AUDIT_OUTCOME_LABELS, auditOutcomeBadgeVariant, cn, formatDateTime, ROLE_LABELS } from "@/lib/utils"
import { AUDIT_ACTIONS, AUDIT_OUTCOMES } from "@/types/api"
import type { AuditAction, AuditOutcome } from "@/types/api"
import type { PeriodPreset } from "@/lib/period"
import { AuditLogDetailDialog } from "./AuditLogDetailDialog"

const PAGE_SIZE = 25

const ACTION_OPTIONS = AUDIT_ACTIONS.map((value) => ({ value, label: AUDIT_ACTION_LABELS[value] }))
const OUTCOME_OPTIONS = AUDIT_OUTCOMES.map((value) => ({ value, label: AUDIT_OUTCOME_LABELS[value] }))

export default function AuditoriaPage() {
  const [searchParams] = useSearchParams()
  const initialPreset = (searchParams.get("period") as PeriodPreset | null) ?? "7d"
  const period = useReportPeriod(initialPreset)

  const [actorUserId, setActorUserId] = useState("")
  const [action, setAction] = useState("")
  const [outcome, setOutcome] = useState("")
  const [entityType, setEntityType] = useState("")
  const [operatorId, setOperatorId] = useState("")
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data: operatorsData } = useOperators()
  const operatorName = (id: string | null) => (id ? operatorsData?.items.find((o) => o.id === id)?.name ?? id : null)

  const params = {
    from: period.from,
    to: period.to,
    actorUserId: actorUserId || undefined,
    action: (action || undefined) as AuditAction | undefined,
    outcome: (outcome || undefined) as AuditOutcome | undefined,
    entityType: entityType || undefined,
    operatorId: operatorId || undefined,
    q: q || undefined,
    page,
    pageSize: PAGE_SIZE,
  }
  const { data, isLoading, isError, error, refetch } = useAuditLogs(params)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Auditoria"
        description="Quem fez o quê, onde e como — trilha de toda mutação administrativa da rede."
        icon={ScrollText}
        actions={<ExportCsvButton path="/api/admin/audit-logs" params={{ ...params, page: undefined, pageSize: undefined }} filename={`auditoria_${period.from}_${period.to}.csv`} />}
      />

      <div className="flex flex-wrap items-center gap-3">
        <PeriodSelector preset={period.preset} from={period.from} to={period.to} onPresetChange={period.setPreset} onCustomChange={period.setCustom} />
        <AuditActorFilterSelect from={period.from} to={period.to} value={actorUserId} onChange={setActorUserId} />
        <div className="w-48">
          <Select aria-label="Tipo de ação" value={action} onChange={(e) => setAction(e.target.value)} placeholder="Todas as ações" options={ACTION_OPTIONS} />
        </div>
        <div className="w-48">
          <Select aria-label="Resultado" value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Todos os resultados" options={OUTCOME_OPTIONS} />
        </div>
        <div className="w-44">
          <Input aria-label="Entidade" placeholder="Entidade (ex.: Tariff)" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
        </div>
        <OperatorFilterSelect value={operatorId} onChange={setOperatorId} />
        <div className="w-56">
          <Input aria-label="Buscar" placeholder="Buscar nome, e-mail ou ID" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {isLoading && <TableSkeleton cols={5} rows={8} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar a auditoria.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState icon={ScrollText} title="Nenhum evento encontrado" description="Ajuste o período ou os filtros — pode não ter havido atividade nesse escopo." />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <Table density="compact">
            <TableHeader>
              <TableRow>
                <TableHead>Quando</TableHead>
                <TableHead>Quem</TableHead>
                <TableHead>O quê</TableHead>
                <TableHead>Onde</TableHead>
                <TableHead>Resultado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((log) => (
                <TableRow
                  key={log.id}
                  className={cn("cursor-pointer", log.outcome !== "SUCCESS" && "bg-danger-50/60 hover:bg-danger-50")}
                  onClick={() => setSelectedId(log.id)}
                >
                  <TableCell className="whitespace-nowrap">{formatDateTime(log.occurredAt)}</TableCell>
                  <TableCell>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{log.actor.name}</p>
                      <p className="truncate text-xs text-ink-softer">
                        {log.actor.email} · {ROLE_LABELS[log.actor.role]}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium text-ink-soft">{AUDIT_ACTION_LABELS[log.action]}</p>
                    {(log.entityType || log.actionDetail) && (
                      <p className="truncate text-xs text-ink-softer">{log.entityType ?? log.actionDetail}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <p className="truncate font-mono text-xs text-ink-soft">
                      {log.method} {log.path}
                    </p>
                    {log.targetOperatorId && <p className="truncate text-xs text-ink-softer">{operatorName(log.targetOperatorId)}</p>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <Badge variant={auditOutcomeBadgeVariant(log.outcome)}>{AUDIT_OUTCOME_LABELS[log.outcome]}</Badge>
                      {log.httpStatus && <span className="text-[11px] text-ink-softer">HTTP {log.httpStatus}</span>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} pageSize={data.meta.pageSize} onPageChange={setPage} label="eventos" />
        </>
      )}

      <AuditLogDetailDialog id={selectedId} onOpenChange={(open) => !open && setSelectedId(null)} />
    </div>
  )
}
