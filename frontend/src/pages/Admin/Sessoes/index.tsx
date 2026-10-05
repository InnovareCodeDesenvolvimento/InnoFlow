import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { Activity } from "lucide-react"
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
import { SiteFilterSelect } from "@/components/relatorios/SiteFilterSelect"
import { ExportCsvButton } from "@/components/relatorios/ExportCsvButton"
import { useSessionsReport } from "@/hooks/useReports"
import { useReportPeriod } from "@/hooks/useReportPeriod"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import {
  CHARGING_SESSION_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  SESSION_PAYMENT_STATUS_LABELS,
  formatCents,
  formatDateTime,
  paymentStatusBadgeVariant,
  reaisToCents,
  sessionStatusBadgeVariant,
} from "@/lib/utils"
import { readSessionParam, SESSION_QUERY_PARAM } from "@/lib/sessionDeepLink"
import type { ChargingSessionStatus, SessionPaymentMethod } from "@/types/api"
import { SessionDetailDialog } from "./SessionDetailDialog"

const PAGE_SIZE = 20

const STATUS_OPTIONS: Array<{ value: ChargingSessionStatus; label: string }> = Object.entries(CHARGING_SESSION_STATUS_LABELS).map(([value, label]) => ({
  value: value as ChargingSessionStatus,
  label,
}))

const METHOD_OPTIONS: Array<{ value: SessionPaymentMethod; label: string }> = [
  { value: "CARD", label: PAYMENT_METHOD_LABELS.CARD },
  { value: "WALLET", label: PAYMENT_METHOD_LABELS.WALLET },
]

export default function SessoesPage() {
  const role = useAuthStore((s) => s.user?.role)
  const isAdmin = role === "ADMIN"

  const period = useReportPeriod("30d")
  const [operatorId, setOperatorId] = useState("")
  const [siteId, setSiteId] = useState("")
  const [status, setStatus] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("")
  const [minAmountReais, setMinAmountReais] = useState("")
  const [page, setPage] = useState(1)
  // O detalhe abre por clique na linha OU por link direto (`?sessao=<id>`, ex.: "Ver sessão" da recarga remota). O id da URL só vale no formato esperado e é apagado da
  // URL ao fechar (senão um F5 reabriria o diálogo). Clique na linha continua sendo estado local: não suja o histórico.
  const [searchParams, setSearchParams] = useSearchParams()
  const [clickedSessionId, setClickedSessionId] = useState<string | null>(null)
  const linkedSessionId = readSessionParam(searchParams.get(SESSION_QUERY_PARAM))
  const selectedSessionId = clickedSessionId ?? linkedSessionId
  const setSelectedSessionId = (id: string | null) => {
    setClickedSessionId(id)
    if (id === null && searchParams.has(SESSION_QUERY_PARAM)) {
      const next = new URLSearchParams(searchParams)
      next.delete(SESSION_QUERY_PARAM)
      setSearchParams(next, { replace: true })
    }
  }
  const effectiveOperatorId = isAdmin ? operatorId || undefined : undefined

  const params = {
    from: period.from,
    to: period.to,
    siteId: siteId || undefined,
    operatorId: effectiveOperatorId,
    status: (status || undefined) as ChargingSessionStatus | undefined,
    paymentMethod: (paymentMethod || undefined) as SessionPaymentMethod | undefined,
    minAmountCents: minAmountReais ? reaisToCents(Number(minAmountReais)) : undefined,
    page,
    pageSize: PAGE_SIZE,
  }
  const { data, isLoading, isError, error, refetch } = useSessionsReport(params)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sessões"
        description="Analítico de sessões de recarga, com filtros e detalhe."
        icon={Activity}
        actions={<ExportCsvButton path="/api/admin/reports/sessions" params={{ ...params, page: undefined, pageSize: undefined }} filename={`sessoes_${period.from}_${period.to}.csv`} />}
      />

      <div className="flex flex-wrap items-center gap-3">
        <PeriodSelector preset={period.preset} from={period.from} to={period.to} onPresetChange={period.setPreset} onCustomChange={period.setCustom} />
        {isAdmin && <OperatorFilterSelect value={operatorId} onChange={setOperatorId} />}
        <SiteFilterSelect value={siteId} onChange={setSiteId} operatorId={effectiveOperatorId} />
        <div className="w-48">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Todos os status" options={STATUS_OPTIONS} />
        </div>
        <div className="w-52">
          <Select aria-label="Método de pagamento" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} placeholder="Todos os métodos" options={METHOD_OPTIONS} />
        </div>
        <div className="w-36">
          <Input
            aria-label="Valor mínimo (R$)"
            type="number"
            min={0}
            step="0.01"
            placeholder="Valor mín. (R$)"
            value={minAmountReais}
            onChange={(e) => setMinAmountReais(e.target.value)}
          />
        </div>
      </div>

      {isLoading && <TableSkeleton cols={7} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar as sessões.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState icon={Activity} title="Nenhuma sessão encontrada" description="Ajuste o período ou os filtros — pode não ter havido recarga no escopo selecionado." />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <Table density="compact">
            <TableHeader>
              <TableRow>
                <TableHead>Início</TableHead>
                <TableHead>Eletroposto</TableHead>
                <TableHead>Carregador</TableHead>
                <TableHead>Motorista</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Pagamento</TableHead>
                <TableHead className="text-right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((session) => (
                <TableRow key={session.id} className="cursor-pointer" onClick={() => setSelectedSessionId(session.id)}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(session.startedAt)}</TableCell>
                  <TableCell className="font-semibold text-ink">{session.siteName}</TableCell>
                  <TableCell>
                    {session.ocppIdentity} · {session.connectorId}
                  </TableCell>
                  <TableCell>{session.driverName}</TableCell>
                  <TableCell>
                    <Badge variant={sessionStatusBadgeVariant(session.status)}>{CHARGING_SESSION_STATUS_LABELS[session.status]}</Badge>
                  </TableCell>
                  <TableCell>
                    {session.paymentStatus ? (
                      <Badge variant={paymentStatusBadgeVariant(session.paymentStatus)}>{SESSION_PAYMENT_STATUS_LABELS[session.paymentStatus]}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{session.totalCostCents !== null ? formatCents(session.totalCostCents) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} pageSize={data.meta.pageSize} onPageChange={setPage} label="sessões" />
        </>
      )}

      <SessionDetailDialog sessionId={selectedSessionId} onOpenChange={(open) => !open && setSelectedSessionId(null)} />
    </div>
  )
}
