import { useState } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { AlertTriangle, HandCoins, RefreshCw, ScrollText, Wallet, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Pagination } from "@/components/ui/Pagination"
import { Skeleton } from "@/components/ui/Skeleton"
import { WalletEntryIcon } from "@/components/carteira/WalletEntryIcon"
import { useDriverWallet } from "@/hooks/useDrivers"
import { getApiErrorMessage } from "@/services/api"
import { formatCents, formatDateTime, WALLET_ENTRY_TYPE_LABELS } from "@/lib/utils"
import type { DriverListRow, WalletEntryRow } from "@/types/api"
import { AdjustBalanceDialog } from "./AdjustBalanceDialog"

const PAGE_SIZE = 10

/** Sinal explícito (não só a cor): "+ R$ 50,00" / "− R$ 12,00". */
function signedAmount(cents: number): string {
  return `${cents >= 0 ? "+" : "−"} ${formatCents(Math.abs(cents))}`
}

function EntryRow({ entry }: { entry: WalletEntryRow }) {
  const credit = entry.amountCents >= 0
  return (
    <li className="flex items-start gap-3 py-3">
      <WalletEntryIcon type={entry.type} credit={credit} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-ink">{WALLET_ENTRY_TYPE_LABELS[entry.type]}</p>
        {entry.description && <p className="break-words text-xs text-ink-softer">{entry.description}</p>}
        <p className="mt-0.5 text-[11px] text-ink-softer">{formatDateTime(entry.createdAt)}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`text-sm font-black tabular-nums ${credit ? "text-success-700" : "text-danger-700"}`}>{signedAmount(entry.amountCents)}</p>
        <p className="text-[11px] tabular-nums text-ink-softer">saldo {formatCents(entry.balanceAfterCents)}</p>
      </div>
    </li>
  )
}

/**
 * Extrato de UM motorista, em drawer lateral (padrão do admin: contido, sem
 * espetáculo). Abrir isto gera uma linha de AUDITORIA no backend — por isso o
 * aviso no rodapé e por isso a query não refaz sozinha (ver `useDriverWallet`).
 * "Ajustar saldo" só existe para ADMIN; OPERATOR só consulta.
 */
export function DriverWalletDrawer({ driver, isAdmin, onClose }: { driver: DriverListRow; isAdmin: boolean; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const [adjusting, setAdjusting] = useState(false)
  const { data, isLoading, isError, error, refetch, isFetching } = useDriverWallet(driver.id, { page, pageSize: PAGE_SIZE })

  const balanceCents = data?.balanceCents ?? driver.walletBalanceCents
  const openDebtCents = data?.openDebtCents ?? driver.openDebtCents
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <>
      <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="dialog-scrim fixed inset-0 z-50 animate-fade-in" />
          <DialogPrimitive.Content
            aria-describedby="wallet-drawer-desc"
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-surface shadow-lg duration-200 focus-visible:outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right"
          >
            <header className="flex items-start gap-3 border-b border-border-subtle px-5 py-4">
              <span className="shadow-tinted flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden="true">
                <Wallet className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="truncate text-lg font-black tracking-tight text-ink">{data?.driverName ?? driver.name}</DialogPrimitive.Title>
                <p id="wallet-drawer-desc" className="truncate text-xs text-ink-softer">
                  Extrato da carteira{driver.email ? ` · ${driver.email}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refetch()}
                disabled={isFetching}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-softer hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                aria-label="Atualizar extrato"
                title="Atualizar extrato"
              >
                <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
              </button>
              <DialogPrimitive.Close
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-softer hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label="Fechar extrato"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </DialogPrimitive.Close>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="rounded-2xl bg-primary-950 p-4 text-white">
                <p className="text-[11px] font-bold uppercase tracking-widest text-white/60">Saldo atual</p>
                <p className="mt-1 text-3xl font-black tracking-tight tabular-nums" data-testid="wallet-balance">
                  {formatCents(balanceCents)}
                </p>
                {openDebtCents > 0 && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-danger-600/25 px-2.5 py-1.5 text-xs font-semibold text-white">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Dívida em aberto de {formatCents(openDebtCents)} — bloqueia a próxima recarga.
                  </p>
                )}
              </div>

              <div className="mt-3">
                {isAdmin ? (
                  <Button type="button" className="w-full" onClick={() => setAdjusting(true)} disabled={isLoading || isError}>
                    <HandCoins className="h-4 w-4" aria-hidden="true" />
                    Ajustar saldo
                  </Button>
                ) : (
                  <p className="text-center text-xs text-ink-softer">Somente consulta — ajustes de saldo são feitos por administradores.</p>
                )}
              </div>

              <h3 className="mb-1 mt-5 text-xs font-bold uppercase tracking-wide text-ink-softer">Lançamentos</h3>

              {isLoading && (
                <div className="space-y-3 py-2" aria-hidden="true">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 rounded-xl" />
                  ))}
                </div>
              )}

              {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar o extrato.")} onRetry={() => void refetch()} />}

              {!isLoading && !isError && data && data.entries.length === 0 && (
                <EmptyState icon={Wallet} title="Nenhum lançamento" description="Esta carteira ainda não teve movimento." />
              )}

              {!isLoading && !isError && data && data.entries.length > 0 && (
                <>
                  <ul className={`divide-y divide-border-subtle ${isFetching ? "opacity-60" : ""}`}>
                    {data.entries.map((entry) => (
                      <EntryRow key={entry.id} entry={entry} />
                    ))}
                  </ul>
                  <Pagination page={page} totalPages={totalPages} total={data.total} pageSize={data.pageSize} onPageChange={setPage} label="lançamentos" />
                </>
              )}
            </div>

            <footer className="flex items-start gap-2 border-t border-border-subtle bg-muted/40 px-5 py-3 text-[11px] leading-relaxed text-ink-softer">
              <ScrollText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Consultar o extrato de um motorista fica registrado na auditoria.</span>
            </footer>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {adjusting && <AdjustBalanceDialog driver={{ id: driver.id, name: data?.driverName ?? driver.name }} balanceCents={balanceCents} onOpenChange={setAdjusting} />}
    </>
  )
}
