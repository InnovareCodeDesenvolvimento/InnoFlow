import { useState } from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, ChevronRight, QrCode, Wallet } from "lucide-react"
import { Card, CardContent } from "@/components/ui/Card"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { WalletEntryIcon } from "@/components/carteira/WalletEntryIcon"
import { useMeWallet } from "@/hooks/useMeSessions"
import { getApiErrorMessage } from "@/services/api"
import { formatCents, formatDateTime, WALLET_ENTRY_TYPE_LABELS } from "@/lib/utils"

const PAGE_SIZE = 20

/**
 * `/app/carteira` — saldo, dívida (se houver) e extrato paginado.
 * "Adicionar saldo" leva à recarga via Pix (F5.1, `/app/carteira/adicionar`)
 * — a rota real ainda não existe no backend, validado só contra mock MSW
 * (ver handoff da Lyra em PROGRESSO.md).
 */
export function Carteira() {
  const [page, setPage] = useState(1)
  const { data, isLoading, isError, error, refetch, isFetching } = useMeWallet({ page, pageSize: PAGE_SIZE })

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className="mx-auto max-w-md px-4 py-5">
      <h1 className="text-lg font-black tracking-tight text-ink">Carteira</h1>

      {isLoading && (
        <div className="mt-4 space-y-3" aria-hidden="true">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-16 rounded-2xl" />
        </div>
      )}

      {isError && (
        <ErrorState className="mt-4" message={getApiErrorMessage(error, "Não foi possível carregar a carteira.")} onRetry={() => refetch()} />
      )}

      {!isLoading && !isError && data && (
        <>
          <Card className="animate-fade-in-up mt-4 bg-primary-950 text-white ring-0">
            <CardContent className="p-5">
              <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-white/60">
                <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                Saldo disponível
              </p>
              <p className="mt-1.5 text-4xl font-black tracking-tight">{formatCents(data.balanceCents)}</p>
            </CardContent>
          </Card>

          {data.openDebtCents > 0 && (
            <div className="mt-3 flex items-start gap-2.5 rounded-2xl bg-danger-50 px-4 py-3.5">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger-600" aria-hidden="true" />
              <div>
                <p className="text-sm font-bold text-danger-700">Dívida em aberto: {formatCents(data.openDebtCents)}</p>
                <p className="mt-0.5 text-xs text-danger-600">Quite este valor para poder iniciar uma nova recarga.</p>
              </div>
            </div>
          )}

          <Link
            to="/app/carteira/adicionar"
            className="pressable mt-3 flex items-center gap-3 rounded-2xl bg-accent/10 p-4 ring-1 ring-accent/30 transition-colors hover:bg-accent/15"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/20 text-accent-700">
              <QrCode className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-accent-700">Adicionar saldo</p>
              <p className="text-xs text-ink-softer">Recarregue via Pix — o saldo cai na hora.</p>
            </div>
            <ChevronRight className="h-5 w-5 shrink-0 text-accent-700" aria-hidden="true" />
          </Link>

          <h2 className="mb-2 mt-6 text-sm font-bold text-ink">Extrato</h2>

          {data.entries.length === 0 ? (
            <EmptyState icon={Wallet} title="Nenhum lançamento ainda" />
          ) : (
            <div className={`space-y-2 ${isFetching ? "opacity-60" : ""}`}>
              {data.entries.map((entry, index) => {
                const credit = entry.amountCents > 0
                return (
                  <div
                    key={entry.id}
                    className={`stagger-${Math.min(index + 1, 4)} animate-fade-in-up flex items-center gap-3 rounded-2xl border border-border-subtle bg-surface p-3.5 shadow-card`}
                  >
                    <WalletEntryIcon type={entry.type} credit={credit} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{entry.description || WALLET_ENTRY_TYPE_LABELS[entry.type]}</p>
                      <p className="text-xs text-ink-softer">{formatDateTime(entry.createdAt)}</p>
                    </div>
                    <p className={`shrink-0 text-sm font-black ${credit ? "text-success-700" : "text-danger-700"}`}>
                      {credit ? "+" : ""}
                      {formatCents(entry.amountCents)}
                    </p>
                  </div>
                )
              })}
            </div>
          )}

          <Pagination page={data.page} totalPages={totalPages} total={data.total} pageSize={data.pageSize} onPageChange={setPage} label="lançamentos" />
        </>
      )}
    </div>
  )
}
