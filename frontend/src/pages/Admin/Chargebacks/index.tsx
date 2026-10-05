import { useState } from "react"
import { Link } from "react-router-dom"
import { AlarmClock, ChevronRight, CreditCard, ShieldAlert } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { EmptyState } from "@/components/ui/EmptyState"
import { Pagination } from "@/components/ui/Pagination"
import { Select } from "@/components/ui/Select"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { useChargebacks } from "@/hooks/useReversals"
import { CHARGEBACK_STATUS_LABELS, CHARGEBACK_STATUS_VARIANT, parseReversalLoadError, responseDeadlineState } from "@/lib/reversals"
import { formatCents, formatDate } from "@/lib/utils"
import { getApiErrorMessage } from "@/services/api"
import type { ChargebackStatus } from "@/types/api"
import { ChargebackDetailDialog } from "./ChargebackDetailDialog"
import { DeadlineBadge } from "./DeadlineBadge"
import { ResolveChargebackDialog } from "./ResolveChargebackDialog"
import { UnblockCardDialog } from "./UnblockCardDialog"

const PAGE_SIZE = 20

const STATUS_OPTIONS = (Object.keys(CHARGEBACK_STATUS_LABELS) as ChargebackStatus[]).map((value) => ({ value, label: CHARGEBACK_STATUS_LABELS[value] }))

type OpenDialog = "resolve" | "unblock" | null

/**
 * Admin → Chargebacks (L1.8, ADMIN-only): a lista das contestações de cartão que a Cielo avisou ao dono, com o PRAZO DE RESPOSTA em destaque. O InnoFlow nunca descobre um chargeback
 * sozinho: o registro nasce em Pagamentos ("Registrar chargeback") e vem para cá para ganhar desfecho. Só ADMIN (o servidor devolve 403 ao OPERATOR; a rota exige o papel).
 */
export default function ChargebacksPage() {
  const [outcome, setOutcome] = useState("")
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<OpenDialog>(null)

  const { data, isLoading, isError, error, refetch, isFetching } = useChargebacks({ outcome: (outcome || undefined) as ChargebackStatus | undefined, page, pageSize: PAGE_SIZE })
  // Sempre o dado MAIS NOVO da lista (um desfecho/desbloqueio refaz a lista e o diálogo reflete o novo estado); sumiu da página -> fecha.
  const selected = data?.items.find((cb) => cb.id === selectedId) ?? null

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const urgent = data ? data.items.filter((cb) => ["overdue", "near"].includes(responseDeadlineState(cb.responseDeadline, cb.status).kind)).length : 0

  const closeAll = () => {
    setSelectedId(null)
    setDialog(null)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chargebacks"
        description="Contestações de cartão avisadas pela Cielo. Responda dentro do prazo e registre o desfecho."
        icon={ShieldAlert}
        actions={
          <Link to="/admin/pagamentos" className={buttonVariants({ variant: "outline", size: "touch-sm" })}>
            <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
            Achar a venda em Pagamentos
          </Link>
        }
      />

      <div className="w-52">
        <Select
          aria-label="Estado"
          value={outcome}
          onChange={(e) => {
            setOutcome(e.target.value)
            setPage(1)
          }}
          placeholder="Todos os estados"
          options={STATUS_OPTIONS}
        />
      </div>

      {urgent > 0 && (
        <Alert tone="danger" icon={AlarmClock} role="status" data-testid="chargebacks-urgent">
          {urgent === 1 ? "1 chargeback em aberto está com o prazo de resposta vencido ou nos próximos 3 dias." : `${urgent} chargebacks em aberto estão com o prazo de resposta vencido ou nos próximos 3 dias.`} Baixe o
          dossiê, responda no portal da Cielo e registre o desfecho.
        </Alert>
      )}

      {isLoading && <TableSkeleton cols={5} />}
      {isError && <ErrorState message={parseReversalLoadError(error, "chargeback") ?? getApiErrorMessage(error, "Não foi possível carregar os chargebacks.")} onRetry={() => void refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState
          icon={ShieldAlert}
          title={outcome ? "Nenhum chargeback neste estado" : "Nenhum chargeback registrado"}
          description={outcome ? "Escolha outro estado ou volte para todos." : "Quando a Cielo avisar uma contestação, ache a venda em Pagamentos (busca por Tid, código de autorização ou NSU) e registre aqui."}
        />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <div className={isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}>
            <Table density="compact">
              <TableHeader>
                <TableRow>
                  <TableHead>Caso</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Prazo de resposta</TableHead>
                  <TableHead>Cartão do motorista</TableHead>
                  <TableHead>
                    <span className="sr-only">Detalhes</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((cb) => (
                  <TableRow
                    key={cb.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedId(cb.id)}
                  >
                    <TableCell>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedId(cb.id)
                        }}
                        className="block min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        aria-label={`Ver chargeback do caso ${cb.caseReference}`}
                      >
                        <span className="block max-w-[14rem] truncate font-semibold text-ink" title={cb.caseReference}>{cb.caseReference}</span>
                        <span className="block text-xs text-ink-softer">Aviso em {formatDate(cb.notifiedAt)}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums text-ink">{formatCents(cb.amountCents)}</TableCell>
                    <TableCell>
                      <Badge variant={CHARGEBACK_STATUS_VARIANT[cb.status]}>{CHARGEBACK_STATUS_LABELS[cb.status]}</Badge>
                    </TableCell>
                    <TableCell>
                      <DeadlineBadge chargeback={cb} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={cb.cardBlocked ? "warning" : "success"}>{cb.cardBlocked ? "Bloqueado" : "Liberado"}</Badge>
                    </TableCell>
                    <TableCell className="w-10 text-ink-subtle">
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Pagination page={data.page} totalPages={totalPages} total={data.total} pageSize={data.pageSize} onPageChange={setPage} label="chargebacks" />
        </>
      )}

      {/* Detalhe SEMPRE montado enquanto há seleção; desfecho e desbloqueio abrem POR CIMA dele (o foco volta ao botão que os abriu, que continua no DOM). Ao terminar, o detalhe já mostra o novo estado (a lista é refeita). */}
      {selected && <ChargebackDetailDialog chargeback={selected} onResolve={() => setDialog("resolve")} onUnblock={() => setDialog("unblock")} onClose={closeAll} />}
      {selected && dialog === "resolve" && <ResolveChargebackDialog chargeback={selected} onClose={() => setDialog(null)} />}
      {selected && dialog === "unblock" && <UnblockCardDialog chargeback={selected} onClose={() => setDialog(null)} />}
    </div>
  )
}
