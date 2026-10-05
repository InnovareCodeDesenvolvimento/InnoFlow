import { useState } from "react"
import { BadgeCheck, Undo2, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { useSessionRefunds } from "@/hooks/useReversals"
import { formatCents, formatDateTime } from "@/lib/utils"
import { parseReversalLoadError, REFUND_DESTINATION_LABELS, REFUND_STATUS_LABELS } from "@/lib/reversals"
import { getApiErrorMessage } from "@/services/api"
import type { RefundStatus, SessionDetail, SessionRefundDTO } from "@/types/api"
import { CancelRefundDialog, ConfirmRefundDialog } from "./RefundPendingDialogs"
import { ParqueAlertNotice, RefundFormDialog } from "./RefundFormDialog"

const STATUS_VARIANT: Record<RefundStatus, "warning" | "success" | "neutral"> = {
  PENDING_CONFIRMATION: "warning",
  CONFIRMED: "success",
  CANCELLED: "neutral",
}

type OpenDialog = { kind: "new" } | { kind: "confirm"; refund: SessionRefundDTO } | { kind: "cancel"; refund: SessionRefundDTO }

/**
 * Bloco "Devoluções" do detalhe da sessão (ADMIN-only: o servidor devolve 403 ao OPERATOR, então quem monta já decide por papel). Mostra cobrado/estornado/estornável, a lista de
 * registros (pendentes, confirmados, cancelados) e as ações. Todo valor vem do servidor: o teto não é recalculado aqui.
 */
export function RefundsSection({ session }: { session: SessionDetail }) {
  const { data, isLoading, isError, error, refetch } = useSessionRefunds(session.id)
  const [dialog, setDialog] = useState<OpenDialog | null>(null)

  const cardAvailable = session.paymentIntents.some((pi) => pi.provider === "CIELO_CARD" && pi.status === "CAPTURED")
  const canRefund = Boolean(data && data.refundableCents > 0)
  const hasCardRefund = Boolean(data?.items.some((r) => r.destination === "CARD_VIA_PORTAL" && r.status !== "CANCELLED"))

  return (
    <div data-testid="admin-refunds" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">Devoluções</p>
        <Button type="button" variant="outline" size="touch-sm" disabled={!canRefund} onClick={() => setDialog({ kind: "new" })}>
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
          Estornar
        </Button>
      </div>

      {isLoading && <Skeleton className="h-20 w-full" />}

      {isError && <ErrorState message={parseReversalLoadError(error, "refund") ?? getApiErrorMessage(error, "Não foi possível carregar as devoluções.")} onRetry={() => void refetch()} />}

      {data && (
        <>
          {/* Sem valor cobrado (aberta, em confirmação, sem custo, dívida) não há o que somar: três "R$ 0,00" diriam que algo foi apurado (mesmo cuidado do bloco de custos). */}
          {data.billedCents > 0 && (
            <dl className="grid grid-cols-3 gap-2 rounded-xl border border-border-subtle p-3">
              <Amount label="Cobrado" value={formatCents(data.billedCents)} />
              <Amount label="Estornado" value={formatCents(data.refundedCents)} />
              <Amount label="Estornável" value={formatCents(data.refundableCents)} strong />
            </dl>
          )}

          {data.billedCents === 0 && <p className="text-xs text-ink-softer">Esta sessão não tem valor cobrado (aberta, sem custo ou virou dívida): não há o que estornar.</p>}
          {data.billedCents > 0 && data.refundableCents === 0 && <p className="text-xs text-ink-softer">Tudo o que foi cobrado já está estornado ou aguardando confirmação.</p>}

          {data.items.length === 0 ? (
            <p className="text-sm text-ink-softer">Nenhuma devolução registrada.</p>
          ) : (
            <ul className="space-y-2">
              {data.items.map((refund) => (
                <li key={refund.id} data-testid="refund-item" data-status={refund.status} className="rounded-lg border border-border-subtle p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_VARIANT[refund.status]}>{REFUND_STATUS_LABELS[refund.status]}</Badge>
                      <span className="font-semibold tabular-nums text-ink">{formatCents(refund.amountCents)}</span>
                    </span>
                    <span className="text-xs text-ink-softer">{formatDateTime(refund.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-xs text-ink-softer">
                    {REFUND_DESTINATION_LABELS[refund.destination]}
                    {refund.confirmedManually && " · confirmada à mão"}
                  </p>
                  <p className="mt-1 break-words text-sm text-ink-soft">{refund.reason}</p>
                  {refund.portalReference && (
                    <p className="mt-1 break-all text-xs text-ink-softer">
                      {refund.confirmedManually ? "Comprovante do portal" : "Referência do portal"}: <span className="font-semibold text-ink-soft">{refund.portalReference}</span>
                    </p>
                  )}
                  {refund.status === "PENDING_CONFIRMATION" && (
                    <>
                      <p className="mt-2 text-xs text-ink-softer">
                        Aguardando a Cielo mostrar o estorno. Estorno parcial, ou venda com mais de 3 meses, não confirma sozinho: confira o extrato da Cielo e confirme à mão.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="touch-sm" onClick={() => setDialog({ kind: "confirm", refund })}>
                          <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          Confirmar à mão
                        </Button>
                        <Button type="button" variant="ghost" size="touch-sm" onClick={() => setDialog({ kind: "cancel", refund })}>
                          <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                          Cancelar registro
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {hasCardRefund && <ParqueAlertNotice />}
        </>
      )}

      {dialog?.kind === "new" && data && <RefundFormDialog session={session} refundableCents={data.refundableCents} cardAvailable={cardAvailable} onClose={() => setDialog(null)} />}
      {dialog?.kind === "confirm" && <ConfirmRefundDialog sessionId={session.id} refund={dialog.refund} onClose={() => setDialog(null)} />}
      {dialog?.kind === "cancel" && <CancelRefundDialog sessionId={session.id} refund={dialog.refund} onClose={() => setDialog(null)} />}
    </div>
  )
}

function Amount({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">{label}</dt>
      <dd className={strong ? "text-base font-black tabular-nums text-primary-700" : "text-sm font-semibold tabular-nums text-ink-soft"}>{value}</dd>
    </div>
  )
}
