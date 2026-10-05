import { useState } from "react"
import { CalendarDays } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Card } from "@/components/ui/Card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { EmptyState } from "@/components/ui/EmptyState"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { PeriodSelector } from "@/components/relatorios/PeriodSelector"
import { OperatorFilterSelect } from "@/components/relatorios/OperatorFilterSelect"
import { SiteFilterSelect } from "@/components/relatorios/SiteFilterSelect"
import { ExportCsvButton } from "@/components/relatorios/ExportCsvButton"
import { useDailyMovementReport } from "@/hooks/useReports"
import { useReportPeriod } from "@/hooks/useReportPeriod"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import { formatCents, formatDate, formatEnergyWh } from "@/lib/utils"

const PAGE_SIZE = 30

export default function MovimentoDiarioPage() {
  const role = useAuthStore((s) => s.user?.role)
  const isAdmin = role === "ADMIN"

  const period = useReportPeriod("30d")
  const [operatorId, setOperatorId] = useState("")
  const [siteId, setSiteId] = useState("")
  const [page, setPage] = useState(1)
  const effectiveOperatorId = isAdmin ? operatorId || undefined : undefined

  const params = { from: period.from, to: period.to, siteId: siteId || undefined, operatorId: effectiveOperatorId, page, pageSize: PAGE_SIZE }
  const { data, isLoading, isError, error, refetch } = useDailyMovementReport(params)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Movimento diário"
        description="Sessões, energia e faturamento por dia e por eletroposto."
        icon={CalendarDays}
        actions={<ExportCsvButton path="/api/admin/reports/daily-movement" params={{ from: period.from, to: period.to, siteId, operatorId: effectiveOperatorId }} filename={`movimento-diario_${period.from}_${period.to}.csv`} />}
      />

      <div className="flex flex-wrap items-center gap-3">
        <PeriodSelector preset={period.preset} from={period.from} to={period.to} onPresetChange={period.setPreset} onCustomChange={period.setCustom} />
        {isAdmin && <OperatorFilterSelect value={operatorId} onChange={setOperatorId} />}
        <SiteFilterSelect value={siteId} onChange={setSiteId} operatorId={effectiveOperatorId} />
      </div>

      {isLoading && <TableSkeleton cols={6} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar o movimento diário.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState icon={CalendarDays} title="Sem movimento no período" description="Nenhuma sessão foi encerrada no intervalo e escopo selecionados." />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">Total de sessões</p>
              <p className="mt-1 text-xl font-black tabular-nums text-ink">{data.totals.sessions.toLocaleString("pt-BR")}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">Energia total</p>
              <p className="mt-1 text-xl font-black tabular-nums text-ink">{formatEnergyWh(data.totals.energyWh)}</p>
            </Card>
            <Card variant="inverse" className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">Faturamento total</p>
              <p className="mt-1 text-xl font-extrabold tabular-nums text-ink">{formatCents(data.totals.revenueCents)}</p>
            </Card>
          </div>

          <Table density="compact">
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Eletroposto</TableHead>
                <TableHead>Sessões</TableHead>
                <TableHead>Energia</TableHead>
                <TableHead>Ticket médio</TableHead>
                <TableHead className="text-right">Faturamento</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((row) => (
                <TableRow key={`${row.date}_${row.siteId}`}>
                  <TableCell className="whitespace-nowrap">{formatDate(row.date)}</TableCell>
                  <TableCell className="font-semibold text-ink">{row.siteName}</TableCell>
                  <TableCell>{row.sessions}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatEnergyWh(row.energyWh)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatCents(row.avgTicketCents)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatCents(row.revenueCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} pageSize={data.meta.pageSize} onPageChange={setPage} label="linhas" />
        </>
      )}
    </div>
  )
}
