import { useState } from "react"
import { CreditCard } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { Badge } from "@/components/ui/Badge"
import { Select } from "@/components/ui/Select"
import { EmptyState } from "@/components/ui/EmptyState"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { PeriodSelector } from "@/components/relatorios/PeriodSelector"
import { OperatorFilterSelect } from "@/components/relatorios/OperatorFilterSelect"
import { ExportCsvButton } from "@/components/relatorios/ExportCsvButton"
import { usePaymentsReport } from "@/hooks/useReports"
import { useReportPeriod } from "@/hooks/useReportPeriod"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import { PAYMENT_INTENT_STATUS_LABELS, formatCents, formatDateTime, paymentStatusBadgeVariant } from "@/lib/utils"
import { PAYMENT_INTENT_STATUSES, type PaymentIntentStatus, type PaymentProvider } from "@/types/api"

const PAGE_SIZE = 20

const PROVIDER_OPTIONS: Array<{ value: PaymentProvider; label: string }> = [
  { value: "CIELO_CARD", label: "Cielo (cartão)" },
  { value: "CIELO_PIX", label: "Cielo (Pix)" },
  { value: "WALLET", label: "Carteira" },
]

const STATUS_OPTIONS: Array<{ value: PaymentIntentStatus; label: string }> = PAYMENT_INTENT_STATUSES.map((value) => ({
  value,
  label: PAYMENT_INTENT_STATUS_LABELS[value],
}))

export default function PagamentosPage() {
  const role = useAuthStore((s) => s.user?.role)
  const isAdmin = role === "ADMIN"

  const period = useReportPeriod("30d")
  const [operatorId, setOperatorId] = useState("")
  const [provider, setProvider] = useState("")
  const [status, setStatus] = useState("")
  const [page, setPage] = useState(1)
  const effectiveOperatorId = isAdmin ? operatorId || undefined : undefined

  const params = {
    from: period.from,
    to: period.to,
    operatorId: effectiveOperatorId,
    provider: (provider || undefined) as PaymentProvider | undefined,
    status: (status || undefined) as PaymentIntentStatus | undefined,
    page,
    pageSize: PAGE_SIZE,
  }
  const { data, isLoading, isError, error, refetch } = usePaymentsReport(params)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pagamentos"
        description="Tentativas de cobrança — cartão, Pix e carteira."
        icon={CreditCard}
        actions={<ExportCsvButton path="/api/admin/reports/payments" params={{ ...params, page: undefined, pageSize: undefined }} filename={`pagamentos_${period.from}_${period.to}.csv`} />}
      />

      <div className="flex flex-wrap items-center gap-3">
        <PeriodSelector preset={period.preset} from={period.from} to={period.to} onPresetChange={period.setPreset} onCustomChange={period.setCustom} />
        {isAdmin && <OperatorFilterSelect value={operatorId} onChange={setOperatorId} />}
        <div className="w-52">
          <Select aria-label="Provedor" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Todos os provedores" options={PROVIDER_OPTIONS} />
        </div>
        <div className="w-48">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Todos os status" options={STATUS_OPTIONS} />
        </div>
      </div>

      {isLoading && <TableSkeleton cols={6} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os pagamentos.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState icon={CreditCard} title="Nenhum pagamento encontrado" description="Ajuste o período ou os filtros." />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <Table density="compact">
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Usuário</TableHead>
                <TableHead>Eletroposto</TableHead>
                <TableHead>Provedor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(row.createdAt)}</TableCell>
                  <TableCell className="font-semibold text-ink">{row.userName}</TableCell>
                  <TableCell>{row.siteName ?? "—"}</TableCell>
                  <TableCell>{PROVIDER_OPTIONS.find((o) => o.value === row.provider)?.label ?? row.provider}</TableCell>
                  <TableCell>
                    <Badge variant={paymentStatusBadgeVariant(row.status)}>{PAYMENT_INTENT_STATUS_LABELS[row.status]}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatCents(row.amountCapturedCents ?? row.amountRequestedCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} pageSize={data.meta.pageSize} onPageChange={setPage} label="pagamentos" />
        </>
      )}
    </div>
  )
}
