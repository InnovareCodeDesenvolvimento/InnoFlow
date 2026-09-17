import { useState } from "react"
import { Wallet } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { PeriodSelector } from "@/components/relatorios/PeriodSelector"
import { OperatorFilterSelect } from "@/components/relatorios/OperatorFilterSelect"
import { ReconciliationPanel } from "@/components/relatorios/ReconciliationPanel"
import { usePaymentsReport } from "@/hooks/useReports"
import { useReportPeriod } from "@/hooks/useReportPeriod"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import { formatCents } from "@/lib/utils"

export default function FinanceiroPage() {
  const role = useAuthStore((s) => s.user?.role)
  const isAdmin = role === "ADMIN"

  const period = useReportPeriod("30d")
  const [operatorId, setOperatorId] = useState("")
  const effectiveOperatorId = isAdmin ? operatorId || undefined : undefined

  const { data, isLoading, isError, error, refetch } = usePaymentsReport({ from: period.from, to: period.to, operatorId: effectiveOperatorId, page: 1, pageSize: 1 })

  return (
    <div className="space-y-6">
      <PageHeader title="Financeiro" description="De onde vem cada centavo — faturamento, cartão, carteira e conciliação." icon={Wallet} />

      <div className="flex flex-wrap items-center gap-3">
        <PeriodSelector preset={period.preset} from={period.from} to={period.to} onPresetChange={period.setPreset} onCustomChange={period.setCustom} />
        {isAdmin && <OperatorFilterSelect value={operatorId} onChange={setOperatorId} />}
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      )}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os dados financeiros.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && (
        <>
          <Card className="card-premium animate-fade-in-up">
            <CardHeader>
              <CardTitle>Resumo do período</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border-subtle">
                <Row label="Faturamento" value={data.reconciliation.revenueCents} highlight />
                <Row label="Recebido em cartão" value={data.reconciliation.cardCapturedCents} />
                <Row label="Consumido de carteira" value={data.reconciliation.walletDebitCents} />
                {data.reconciliation.walletTopupPixCents !== null && (
                  <Row
                    label="Entradas de carteira via Pix"
                    value={data.reconciliation.walletTopupPixCents}
                    hint="Só ADMIN — é o saldo pré-pago da rede (passivo), não entra no faturamento."
                  />
                )}
                <Row label="A receber (dívida em aberto)" value={data.reconciliation.openDebtCents} tone="warning" />
                <Row label="Falhas/estornos" value={data.reconciliation.failedAttemptsCents} tone="neutral" hint="Tentativas de cobrança que falharam no período (informativo)." />
              </dl>
            </CardContent>
          </Card>

          <ReconciliationPanel reconciliation={data.reconciliation} />
        </>
      )}
    </div>
  )
}

function Row({ label, value, hint, tone, highlight }: { label: string; value: number; hint?: string; tone?: "warning" | "neutral"; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <dt className="font-medium text-ink-soft">{label}</dt>
        {hint && <p className="mt-0.5 text-xs text-ink-subtle">{hint}</p>}
      </div>
      <dd
        className={
          highlight
            ? "text-gradient-brand text-lg font-black tabular-nums"
            : tone === "warning"
              ? "font-black tabular-nums text-warning-700"
              : "font-black tabular-nums text-ink"
        }
      >
        {formatCents(value)}
      </dd>
    </div>
  )
}
