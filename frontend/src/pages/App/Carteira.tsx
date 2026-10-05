import { useState } from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, ChevronRight, CreditCard, QrCode, Wallet } from "lucide-react"
import { MascotFace } from "@/components/brand/Mascot"
import { AppBand } from "@/components/pwa/AppBand"
import { IconBadge } from "@/components/ui/IconBadge"
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
    <div>
      <AppBand className="pb-8">
        <h1 className="text-lg font-black tracking-tight text-ink">Carteira</h1>

        {isLoading && (
          <div className="mt-4" aria-hidden="true">
            <Skeleton className="h-24 rounded-feature bg-white/10" />
          </div>
        )}

        {!isLoading && !isError && data && (
          <div className="glass-strong animate-enter mt-4 rounded-feature p-5">
            <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-ink-softer">
              <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
              Saldo disponível
            </p>
            <p className="mt-1.5 text-4xl font-black tracking-tight text-white">{formatCents(data.balanceCents)}</p>
          </div>
        )}
      </AppBand>

      <div className="mx-auto max-w-md px-4 pb-5">
        {isLoading && (
          <div className="mt-4 space-y-3" aria-hidden="true">
            <Skeleton className="h-16 rounded-card" />
          </div>
        )}

        {isError && (
          <ErrorState
            className="mt-4"
            tone="page"
            art={<MascotFace size={64} />}
            message={getApiErrorMessage(error, "Não foi possível carregar a carteira.")}
            onRetry={() => refetch()}
          />
        )}

        {!isLoading && !isError && data && (
          <>
            {data.openDebtCents > 0 && (
              <div className="mt-4 flex items-start gap-2.5 rounded-card bg-danger-50 px-4 py-3.5">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger-600" aria-hidden="true" />
                <div>
                  <p className="text-sm font-bold text-danger-700">Dívida em aberto: {formatCents(data.openDebtCents)}</p>
                  <p className="mt-0.5 text-xs text-danger-600">Quite este valor para poder iniciar uma nova recarga.</p>
                </div>
              </div>
            )}

            {/* CTA ÚNICO da tela (D2): lima. "Meus cartões" é navegação secundária — linha de cartão claro. */}
            <Link
              to="/app/carteira/adicionar"
              className="mt-4 flex items-center gap-3 rounded-card bg-lime p-4 text-on-lime shadow-lime transition-[transform,box-shadow] duration-150 ease-brand active:scale-[0.98] [@media(hover:hover)]:hover:shadow-lime-lg"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-night/10">
                <QrCode className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-extrabold">Adicionar saldo</p>
                <p className="text-xs font-medium text-on-lime/80">Recarregue via Pix — o saldo cai na hora.</p>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0" aria-hidden="true" />
            </Link>

            <Link
              to="/app/carteira/cartoes"
              className="card-elevated mt-2.5 flex items-center gap-3 p-4 transition-colors active:scale-[0.99] hover:ring-primary/30"
            >
              <IconBadge icon={CreditCard} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink">Meus cartões</p>
                <p className="text-xs text-ink-softer">Cadastre um cartão para pagar a recarga sem digitar toda vez.</p>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-ink-subtle" aria-hidden="true" />
            </Link>

            <h2 className="mb-2 mt-6 text-sm font-bold text-ink">Extrato</h2>

            {data.entries.length === 0 ? (
              <EmptyState tone="brand" art={<MascotFace size={64} />} title="Nenhum lançamento ainda" className="py-8" />
            ) : (
              <div className={`space-y-2 ${isFetching ? "opacity-60" : ""}`}>
                {data.entries.map((entry) => {
                  const credit = entry.amountCents > 0
                  return (
                    <div key={entry.id} className="card-elevated flex items-center gap-3 p-3.5">
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
    </div>
  )
}
