import { useState } from "react"
import { MapPin } from "lucide-react"
import { usePublicSites } from "@/hooks/useSites"
import { MascotFace } from "@/components/brand/Mascot"
import { PageBand } from "@/components/layout/PageBand"
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
 *
 * Design system unificado (F-B): faixa-título escura de marca + miolo claro. O miolo tem ALTURA MÍNIMA de uma tela (`min-h-[100svh]`) de propósito:
 * o rodapé fica sempre abaixo da primeira tela, então a troca esqueleto -> lista/erro/vazio (alturas diferentes) nunca o desloca onde o usuário vê.
 * Era o CLS 0,125 medido na linha de base (o único deslocamento era o rodapé: ~129 px de salto quando o esqueleto virava erro/lista).
 */
export function Eletropostos() {
  const [page, setPage] = useState(1)
  const { data, isLoading, isError, error, refetch, isFetching } = usePublicSites({ page, pageSize: PAGE_SIZE })

  return (
    <>
      <PageBand eyebrow="Rede InnoFlow" title="Eletropostos" description="Disponibilidade de conectores em tempo real, por operador." />

      <div className="container-app min-h-[100svh] py-10">
        {isLoading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-2xl" />
            ))}
          </div>
        )}

        {isError && (
          <ErrorState
            message={getApiErrorMessage(error, "Não foi possível carregar os eletropostos.")}
            onRetry={() => refetch()}
            art={<MascotFace size={64} />}
          />
        )}

        {!isLoading && !isError && data && data.items.length === 0 && (
          <EmptyState
            tone="brand"
            icon={MapPin}
            title="Nenhum eletroposto encontrado"
            description="Ainda não há eletropostos cadastrados nesta rede."
            art={<MascotFace size={64} />}
          />
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
    </>
  )
}
