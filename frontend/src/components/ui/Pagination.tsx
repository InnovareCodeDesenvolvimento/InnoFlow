import { ChevronLeft, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

/** Paginação das listagens — o backend já pagina tudo (`meta.page/pageSize/total/totalPages`), isto só navega entre páginas. */
export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  label = "registros",
  className,
}: {
  page: number
  totalPages: number
  total: number
  pageSize: number
  onPageChange: (page: number) => void
  label?: string
  className?: string
}) {
  if (total === 0) return null

  const canPrev = page > 1
  const canNext = page < totalPages
  const primeiro = (page - 1) * pageSize + 1
  const ultimo = Math.min(page * pageSize, total)

  return (
    <nav
      className={cn("mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row", className)}
      aria-label={`Paginação de ${label}`}
    >
      <p className="text-xs font-medium tabular-nums text-ink-softer">
        Mostrando <strong className="text-ink">{primeiro}</strong>–<strong className="text-ink">{ultimo}</strong> de{" "}
        <strong className="text-ink">{total}</strong> {label}
      </p>

      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => canPrev && onPageChange(page - 1)}
            disabled={!canPrev}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Página anterior"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Anterior</span>
          </button>
          <span className="px-1 text-sm text-ink-softer" aria-current="page">
            Página <span className="font-semibold text-ink">{page}</span> de {totalPages}
          </span>
          <button
            type="button"
            onClick={() => canNext && onPageChange(page + 1)}
            disabled={!canNext}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Próxima página"
          >
            <span className="hidden sm:inline">Próxima</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </nav>
  )
}
