import { useState } from "react"
import { MapPin } from "lucide-react"
import { usePublicSites } from "@/hooks/useSites"
import { PublicSiteCard } from "@/components/sites/PublicSiteCard"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { getApiErrorMessage } from "@/services/api"

const PAGE_SIZE = 12

/**
 * `GET /api/sites` — lista pública (sem mapa nesta fase; requisito mínimo do
 * escopo era a lista, ver PROGRESSO.md). Sem filtro de bounding box: sem
 * coordenadas informadas a API devolve os sites paginados normalmente.
 */
export function Eletropostos() {
  const [page, setPage] = useState(1)
  const { data, isLoading, isError, error, refetch, isFetching } = usePublicSites({ page, pageSize: PAGE_SIZE })

  return (
    <div className="container-app py-10">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-black tracking-tight text-ink">
          <MapPin className="h-6 w-6 text-primary" aria-hidden="true" />
          Eletropostos
        </h1>
        <p className="mt-1 text-sm text-ink-softer">Disponibilidade de conectores em tempo real, por operador.</p>
      </header>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      )}

      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os eletropostos.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState icon={MapPin} title="Nenhum eletroposto encontrado" description="Ainda não há eletropostos cadastrados nesta rede." />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${isFetching ? "opacity-60" : ""}`}>
            {data.items.map((site) => (
              <PublicSiteCard key={site.id} site={site} />
            ))}
          </div>
          <Pagination
            page={data.meta.page}
            totalPages={data.meta.totalPages}
            total={data.meta.total}
            pageSize={data.meta.pageSize}
            onPageChange={setPage}
            label="eletropostos"
          />
        </>
      )}
    </div>
  )
}
