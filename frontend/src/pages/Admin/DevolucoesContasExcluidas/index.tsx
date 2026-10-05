import { useState } from "react"
import { AlarmClock, HandCoins, KeyRound, RefreshCw, UserX } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { EmptyState } from "@/components/ui/EmptyState"
import { Pagination } from "@/components/ui/Pagination"
import { Select } from "@/components/ui/Select"
import { Skeleton } from "@/components/ui/Skeleton"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { CopyButton } from "@/pages/Admin/GatewayPagamento/CopyButton"
import { useAccountDeletions } from "@/hooks/useAccountDeletions"
import { ageLabel, DELETION_REFUND_DEADLINE_DAYS, parseReversalLoadError } from "@/lib/reversals"
import { formatCents, formatDate, formatDateTime } from "@/lib/utils"
import { getApiErrorMessage } from "@/services/api"
import type { AccountDeletionRefundStatus, AdminAccountDeletionRow } from "@/types/api"
import { RefundDeletionDialog } from "./RefundDeletionDialog"

const PAGE_SIZE = 20

type StatusFilter = AccountDeletionRefundStatus | "ALL"
const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "PENDING_REFUND", label: "Pendentes de devolução" },
  { value: "REFUNDED", label: "Já devolvidas" },
  { value: "ALL", label: "Todas" },
]

const shortId = (id: string) => id.slice(-8)

/**
 * Admin → Devoluções de contas excluídas (L1.4, ADMIN-only): quem excluiu a conta (LGPD) com saldo positivo deixou uma chave Pix; o ADMIN devolve o saldo POR FORA e registra aqui.
 * A fila mostra os mais ANTIGOS primeiro e destaca os que passaram de 30 dias (prazo recomendado). A chave Pix é dado de titular: vem decifrada só para o ADMIN, cada leitura da lista
 * é AUDITADA (por isso não há atualização automática) e nada disto é guardado no navegador.
 */
export default function DevolucoesContasExcluidasPage() {
  const [status, setStatus] = useState<StatusFilter>("PENDING_REFUND")
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<AdminAccountDeletionRow | null>(null)

  const { data, isLoading, isError, error, refetch, isFetching } = useAccountDeletions({ status: status === "ALL" ? undefined : status, page, pageSize: PAGE_SIZE })
  const overdue = data ? data.items.filter((row) => row.overdue).length : 0
  const showsKeys = status !== "REFUNDED"

  return (
    <div className="space-y-6">
      <PageHeader
        title="Devoluções de contas excluídas"
        description={`Saldo de quem excluiu a conta (LGPD). Devolva por Pix, fora do sistema, e registre aqui. Prazo recomendado: ${DELETION_REFUND_DEADLINE_DAYS} dias.`}
        icon={UserX}
        actions={
          <Button type="button" variant="outline" size="touch-sm" loading={isFetching && !isLoading} onClick={() => void refetch()}>
            {!(isFetching && !isLoading) && <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
            Atualizar
          </Button>
        }
      />

      <div className="w-60">
        <Select
          aria-label="Situação"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StatusFilter)
            setPage(1)
          }}
          options={STATUS_OPTIONS}
        />
      </div>

      {showsKeys && (
        <Alert tone="neutral" icon={KeyRound}>
          A chave Pix é dado pessoal do titular: aparece só para você e cada abertura desta lista fica registrada na auditoria.
        </Alert>
      )}

      {overdue > 0 && (
        <Alert tone="danger" icon={AlarmClock} role="status" data-testid="deletions-overdue">
          {overdue === 1 ? "1 devolução está atrasada" : `${overdue} devoluções estão atrasadas`} (mais de {DELETION_REFUND_DEADLINE_DAYS} dias). Comece pelas primeiras da lista.
        </Alert>
      )}

      {isLoading && (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}
      {isError && <ErrorState message={parseReversalLoadError(error, "deletion") ?? getApiErrorMessage(error, "Não foi possível carregar as devoluções.")} onRetry={() => void refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState
          icon={HandCoins}
          title={status === "PENDING_REFUND" ? "Nenhuma devolução pendente" : "Nenhum pedido encontrado"}
          description={status === "PENDING_REFUND" ? "Quando alguém excluir a conta com saldo, o pedido aparece aqui com a chave Pix para devolver." : "Mude a situação para ver outros pedidos."}
        />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <ul className={isFetching ? "space-y-3 opacity-60 transition-opacity" : "space-y-3 transition-opacity"}>
            {data.items.map((row) => (
              <li
                key={row.id}
                data-testid="deletion-row"
                data-overdue={row.overdue ? "true" : "false"}
                className={row.overdue ? "rounded-xl border border-danger-600/40 bg-danger-50 p-4" : "rounded-xl border border-border-subtle bg-surface p-4"}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    {row.refundStatus === "PENDING_REFUND" && <Badge variant="warning">Pendente</Badge>}
                    {row.refundStatus === "REFUNDED" && <Badge variant="success">Devolvida</Badge>}
                    {row.refundStatus === "NOT_REQUIRED" && <Badge variant="neutral">Sem saldo</Badge>}
                    {row.overdue && (
                      <Badge variant="danger">
                        <AlarmClock className="h-3 w-3" aria-hidden="true" />
                        Atrasada
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-ink-softer">
                    Pedido de {formatDate(row.requestedAt)} · {ageLabel(row.ageDays)}
                  </span>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Saldo a devolver</p>
                    <p className="text-lg font-black tabular-nums text-ink">{formatCents(row.balanceCentsAtRequest)}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Chave Pix</p>
                    {row.refundPixKey ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 break-all font-mono text-sm text-ink">{row.refundPixKey}</span>
                        <CopyButton value={row.refundPixKey} label={`Copiar chave Pix do pedido ${shortId(row.id)}`} />
                      </div>
                    ) : row.refundPixKeyUnreadable ? (
                      <p className="text-sm font-medium text-danger-700">
                        Chave ilegível: a chave de segredos do servidor mudou (o JWT_SECRET foi trocado). Fale com o titular por outro canal para obter a chave.
                      </p>
                    ) : (
                      <p className="text-sm text-ink-softer">{row.refundStatus === "REFUNDED" ? "Apagada após a devolução." : "Não informada."}</p>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-ink-softer">
                    Pedido {shortId(row.id)} · conta anonimizada {shortId(row.userId)}
                    {row.refundedAt && ` · devolvida em ${formatDateTime(row.refundedAt)}`}
                  </p>
                  {row.refundStatus === "PENDING_REFUND" && (
                    <Button type="button" size="touch" onClick={() => setSelected(row)} aria-label={`Devolver ${formatCents(row.balanceCentsAtRequest)} do pedido ${shortId(row.id)}`}>
                      <HandCoins className="h-4 w-4" aria-hidden="true" />
                      Devolver
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} pageSize={data.meta.pageSize} onPageChange={setPage} label="pedidos" />
        </>
      )}

      {selected && <RefundDeletionDialog key={selected.id} row={selected} onClose={() => setSelected(null)} onStale={() => void refetch()} />}
    </div>
  )
}
