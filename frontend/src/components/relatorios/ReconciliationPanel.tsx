import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { cn, formatCents } from "@/lib/utils"
import type { PaymentsReconciliation } from "@/types/api"

/**
 * Bloco de conciliação em destaque (regra 3 da Nova): `expectedCents`
 * (faturamento) deve bater com `accountedCents` (cartão + carteira +
 * dívida aberta). `differenceCents !== 0` é sinal de bug real no backend —
 * esta tela existe pra pegar isso, então NUNCA escondemos a diferença.
 */
export function ReconciliationPanel({ reconciliation }: { reconciliation: PaymentsReconciliation }) {
  const isBalanced = reconciliation.differenceCents === 0

  return (
    <Card className={cn(!isBalanced && "border-danger-100 ring-1 ring-danger-100")}>
      <CardHeader>
        <CardTitle>Conciliação financeira</CardTitle>
        <CardDescription>faturamento = capturas de cartão + débitos de carteira + dívida aberta</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Figure label="Esperado (faturamento)" value={reconciliation.expectedCents} />
          <Figure label="Contabilizado" value={reconciliation.accountedCents} />
          <Figure label="Diferença" value={reconciliation.differenceCents} highlight={!isBalanced} />
        </div>
        <div
          className={cn(
            "flex items-start gap-2 rounded-xl px-4 py-3 text-sm font-semibold",
            isBalanced ? "bg-success-50 text-success-700" : "bg-danger-50 text-danger-700",
          )}
          role={isBalanced ? undefined : "alert"}
        >
          {isBalanced ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span>
            {isBalanced
              ? "Conciliação fechando em zero."
              : `Diferença de ${formatCents(Math.abs(reconciliation.differenceCents))} — sinal de bug real no backend, não é para "ajustar o número".`}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function Figure({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={cn("rounded-xl border border-border-subtle p-3", highlight && "border-danger-200 bg-danger-50")}>
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">{label}</p>
      <p className={cn("mt-1 text-lg font-black tabular-nums", highlight ? "text-danger-700" : "text-ink")}>{formatCents(value)}</p>
    </div>
  )
}
