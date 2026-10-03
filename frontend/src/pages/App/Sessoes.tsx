import { useState } from "react"
import { Link } from "react-router-dom"
import { ChevronRight, History } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { useMeSessions } from "@/hooks/useMeSessions"
import { getApiErrorMessage } from "@/services/api"
import { formatSessionAmount } from "@/lib/sessionClosure"
import { CHARGING_SESSION_STATUS_LABELS, formatDateTime, formatEnergyWh, sessionStatusBadgeVariant } from "@/lib/utils"

const PAGE_SIZE = 15

/** `/app/sessoes` — histórico paginado, `GET /api/me/sessions`. Agrupamento por mês fica para uma próxima iteração (não bloqueante, ver handoff). */
export function Sessoes() {
  const [page, setPage] = useState(1)
  const { data, isLoading, isError, error, refetch, isFetching } = useMeSessions({ page, pageSize: PAGE_SIZE })

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className="mx-auto max-w-md px-4 py-5">
      <h1 className="text-lg font-black tracking-tight text-ink">Histórico de recargas</h1>

      {isLoading && (
        <div className="mt-4 space-y-2" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState className="mt-4" message={getApiErrorMessage(error, "Não foi possível carregar o histórico.")} onRetry={() => refetch()} />
      )}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState className="mt-4" icon={History} title="Nenhuma recarga ainda" description="Suas recargas aparecem aqui assim que você usar o app pela primeira vez." />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <div className={`mt-4 space-y-2.5 ${isFetching ? "opacity-60" : ""}`}>
            {data.items.map((item, index) => (
              <Link
                key={item.id}
                to={`/app/sessoes/${item.id}`}
                className={`pressable stagger-${Math.min(index + 1, 4)} animate-fade-in-up flex items-center gap-3 rounded-2xl border border-border-subtle bg-surface p-4 shadow-card transition-colors hover:border-primary/30 active:bg-primary-50`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="max-w-full truncate text-sm font-bold text-ink">{item.siteName}</p>
                    <Badge variant={sessionStatusBadgeVariant(item.status)} className="whitespace-nowrap">{CHARGING_SESSION_STATUS_LABELS[item.status]}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-softer">
                    {formatDateTime(item.startedAt)} · {item.ocppIdentity} · Conector {item.connectorId}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-ink-soft">
                    {formatEnergyWh(item.energyDeliveredWh)} · {formatSessionAmount(item.status, item.totalCostCents)}
                  </p>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-ink-subtle" aria-hidden="true" />
              </Link>
            ))}
          </div>
          <Pagination page={data.page} totalPages={totalPages} total={data.total} pageSize={data.pageSize} onPageChange={setPage} label="recargas" />
        </>
      )}
    </div>
  )
}
