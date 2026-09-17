import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { TrendingUp } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { Select } from "@/components/ui/Select"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton, TableSkeleton } from "@/components/ui/Skeleton"
import { PeriodSelector } from "@/components/relatorios/PeriodSelector"
import { OperatorFilterSelect } from "@/components/relatorios/OperatorFilterSelect"
import { SiteFilterSelect } from "@/components/relatorios/SiteFilterSelect"
import { ExportCsvButton } from "@/components/relatorios/ExportCsvButton"
import { RevenueBarChart } from "@/components/relatorios/RevenueBarChart"
import { useRevenueReport } from "@/hooks/useReports"
import { useReportPeriod } from "@/hooks/useReportPeriod"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import { formatCents, formatEnergyWh } from "@/lib/utils"
import type { PeriodPreset } from "@/lib/period"
import type { RevenueBreakdownDimension, RevenueGranularity } from "@/types/api"

const GRANULARITY_OPTIONS: Array<{ value: RevenueGranularity; label: string }> = [
  { value: "day", label: "Por dia" },
  { value: "week", label: "Por semana" },
  { value: "month", label: "Por mês" },
]

const BREAKDOWN_OPTIONS: Array<{ value: RevenueBreakdownDimension; label: string }> = [
  { value: "site", label: "Eletroposto" },
  { value: "chargePoint", label: "Carregador" },
  { value: "method", label: "Método de pagamento" },
  { value: "tariff", label: "Tarifa" },
]

export default function FaturamentoPage() {
  const role = useAuthStore((s) => s.user?.role)
  const isAdmin = role === "ADMIN"

  // `?period=today` vem do atalho rápido da sidebar ("Faturamento de hoje",
  // ver `adminQuickActions.ts`) — só um preset inicial, não é parâmetro de
  // contrato novo, a tela continua controlando o próprio período depois.
  const [searchParams] = useSearchParams()
  const initialPreset = (searchParams.get("period") as PeriodPreset | null) ?? "30d"
  const period = useReportPeriod(initialPreset)
  const [operatorId, setOperatorId] = useState("")
  const [siteId, setSiteId] = useState("")
  const [granularity, setGranularity] = useState<RevenueGranularity>("day")
  const [breakdown, setBreakdown] = useState<RevenueBreakdownDimension>("site")
  const effectiveOperatorId = isAdmin ? operatorId || undefined : undefined

  const params = { from: period.from, to: period.to, siteId: siteId || undefined, operatorId: effectiveOperatorId, granularity, breakdown }
  const { data, isLoading, isError, error, refetch } = useRevenueReport(params)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Faturamento"
        description="Série temporal de receita, com detalhamento por dimensão."
        icon={TrendingUp}
        actions={<ExportCsvButton path="/api/admin/reports/revenue" params={{ ...params }} filename={`faturamento_${period.from}_${period.to}.csv`} />}
      />

      <div className="flex flex-wrap items-center gap-3">
        <PeriodSelector preset={period.preset} from={period.from} to={period.to} onPresetChange={period.setPreset} onCustomChange={period.setCustom} />
        {isAdmin && <OperatorFilterSelect value={operatorId} onChange={setOperatorId} />}
        <SiteFilterSelect value={siteId} onChange={setSiteId} operatorId={effectiveOperatorId} />
        <div className="w-40">
          <Select aria-label="Granularidade" value={granularity} onChange={(e) => setGranularity(e.target.value as RevenueGranularity)} options={GRANULARITY_OPTIONS} />
        </div>
        <div className="w-48">
          <Select aria-label="Detalhar por" value={breakdown} onChange={(e) => setBreakdown(e.target.value as RevenueBreakdownDimension)} options={BREAKDOWN_OPTIONS} />
        </div>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-56 rounded-2xl" />
          <TableSkeleton cols={4} />
        </div>
      )}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar o faturamento.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && (
        <>
          <Card className="card-premium animate-fade-in-up">
            <CardHeader>
              <CardTitle>
                Faturamento total: <span className="text-gradient-brand tabular-nums">{formatCents(data.totals.revenueCents)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.series.every((p) => p.revenueCents === 0) ? (
                <EmptyState title="Sem faturamento no período" description="Nenhuma sessão encerrada gerou receita nesse intervalo." />
              ) : (
                <RevenueBarChart data={data.series.map((p) => ({ date: p.bucket, revenueCents: p.revenueCents }))} />
              )}
            </CardContent>
          </Card>

          <Card className="card-premium">
            <CardHeader>
              <CardTitle>Detalhamento por {BREAKDOWN_OPTIONS.find((o) => o.value === breakdown)?.label.toLowerCase()}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.breakdownRows.length === 0 ? (
                <EmptyState title="Sem dados no período" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{BREAKDOWN_OPTIONS.find((o) => o.value === breakdown)?.label}</TableHead>
                      <TableHead>Sessões</TableHead>
                      <TableHead>Energia</TableHead>
                      <TableHead className="text-right">Faturamento</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.breakdownRows.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell className="font-semibold text-ink">{row.label}</TableCell>
                        <TableCell>{row.sessions}</TableCell>
                        <TableCell>{formatEnergyWh(row.energyWh)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{formatCents(row.revenueCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
