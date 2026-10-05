import { useState } from "react"
import { ChevronLeft, ChevronRight, History as HistoryIcon, ListChecks } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Card, CardContent } from "@/components/ui/Card"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { useBackupRuns } from "@/hooks/useBackup"
import { useMediaQuery } from "@/hooks/useMediaQuery"
import { DESTINATION_LABELS, TRIGGER_LABELS, formatBrasilia, formatBytes, formatDuration, runErrorText, runStateLabel } from "@/lib/backup"
import type { BackupRunDTO } from "@/types/api"
import { SectionHeader } from "./parts"

export const HISTORY_PAGE_SIZE = 10

/** O que a linha conta além do estado: o texto do erro por código, ou o arquivo/chave/tabelas, ou "só teste". */
function RunDetail({ run }: { run: BackupRunDTO }) {
  if (run.status === "FAILED") {
    const text = runErrorText(run.errorCode)
    return (
      <div className="max-w-lg space-y-0.5" data-testid="run-error" data-code={run.errorCode ?? "UNKNOWN"}>
        <p className="text-xs font-bold text-danger-700">{text.title}</p>
        <p className="text-xs text-ink-softer">{text.action}</p>
        <p className="text-xs text-ink-softer">
          Código: <span className="font-mono">{run.errorCode ?? "UNKNOWN"}</span>
        </p>
      </div>
    )
  }
  if (run.status === "QUEUED" || run.status === "RUNNING") return <span className="text-xs text-ink-softer">Aguarde: a tela atualiza sozinha.</span>
  if (run.trigger !== "VERIFY" && run.objectKey === null) return <span className="text-xs text-ink-softer">Teste do pg_dump: não saiu do servidor, não conta como backup.</span>
  return (
    <div className="max-w-lg space-y-0.5 text-xs text-ink-softer">
      {run.fileName && <p className="break-all font-mono">{run.fileName}</p>}
      <p>
        {[run.destination ? DESTINATION_LABELS[run.destination] : null, run.tablesWithData !== null ? `${run.tablesWithData} tabelas` : null, run.keyFingerprint ? `chave ${run.keyFingerprint}` : null]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  )
}

function StateBadge({ run }: { run: BackupRunDTO }) {
  const state = runStateLabel(run)
  return (
    <Badge variant={state.tone} data-testid="run-state">
      {state.label}
    </Badge>
  )
}

/** Pager próprio (botões de 44 px abaixo de `sm`): o `Pagination` genérico tem botões de ~34 px. */
function Pager({ page, totalPages, total, pageSize, onPageChange }: { page: number; totalPages: number; total: number; pageSize: number; onPageChange: (page: number) => void }) {
  const first = (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)
  return (
    <nav className="flex flex-col items-center justify-between gap-3 sm:flex-row" aria-label="Paginação do histórico de backups">
      <p className="text-xs font-medium tabular-nums text-ink-softer" data-testid="history-range">
        Mostrando <strong className="text-ink">{first}</strong>–<strong className="text-ink">{last}</strong> de <strong className="text-ink">{total}</strong> execuções
      </p>
      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="touch" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Página anterior" data-testid="history-prev">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Anterior</span>
          </Button>
          <span className="px-1 text-sm text-ink-softer" aria-current="page" data-testid="history-page">
            Página <span className="font-semibold text-ink">{page}</span> de {totalPages}
          </span>
          <Button type="button" variant="outline" size="touch" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} aria-label="Próxima página" data-testid="history-next">
            <span className="hidden sm:inline">Próxima</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </nav>
  )
}

/**
 * Histórico paginado (data, tipo, estado, tamanho, duração, e o erro por CÓDIGO nas que falharam). 10 por página, página anterior fica na tela enquanto a próxima carrega.
 * Tabela a partir de `lg` (com a sidebar fixa a coluna só passa de ~700 px aí; a 768 px a coluna "Detalhes" era esmagada e cortada); abaixo disso, uma lista de cartões (e a tabela de 640 px de
 * largura mínima criaria um rolo horizontal sem nada focável dentro, que o axe reprova).
 */
export function HistorySection() {
  const [page, setPage] = useState(1)
  const wide = useMediaQuery("(min-width: 1024px)")
  const { data, isLoading, isError, isFetching, refetch } = useBackupRuns(page, HISTORY_PAGE_SIZE)

  return (
    <Card data-testid="section-history">
      <SectionHeader icon={ListChecks} title="Histórico" description="Cada backup, conferência ou tentativa. As que falharam mostram o motivo." />
      <CardContent className="space-y-4">
        {isLoading && <TableSkeleton rows={5} cols={5} />}

        {!isLoading && isError && !data && <ErrorState message="Não foi possível carregar o histórico de backups." onRetry={() => void refetch()} />}

        {data && data.meta.total === 0 && (
          <EmptyState icon={HistoryIcon} title="Nenhuma execução ainda" description="Use “Fazer backup agora” para provar o caminho inteiro antes de ligar o automático." />
        )}

        {data && data.meta.total > 0 && (
          <div className={isFetching ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={isFetching || undefined} data-testid="history-list">
            {wide ? (
              <Table density="compact" aria-label="Histórico de backups">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col">Quando (Brasília)</TableHead>
                    <TableHead scope="col">Estado</TableHead>
                    <TableHead scope="col">Tamanho e duração</TableHead>
                    <TableHead scope="col">Detalhes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((run) => (
                    <TableRow key={run.id} data-testid="run-row" data-status={run.status}>
                      <TableCell className="whitespace-nowrap">
                        <span className="block tabular-nums text-ink">{formatBrasilia(run.createdAt)}</span>
                        <span className="block text-xs text-ink-softer">{TRIGGER_LABELS[run.trigger]}</span>
                      </TableCell>
                      <TableCell>
                        <StateBadge run={run} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        <span className="block">{formatBytes(run.sizeBytes)}</span>
                        <span className="block text-xs text-ink-softer">{formatDuration(run.durationMs)}</span>
                      </TableCell>
                      <TableCell className="py-3">
                        <RunDetail run={run} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <ul className="space-y-3">
                {data.items.map((run) => (
                  <li key={run.id} className="space-y-2 rounded-xl border border-border-subtle bg-surface p-3" data-testid="run-row" data-status={run.status}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold tabular-nums text-ink">{formatBrasilia(run.createdAt)}</p>
                        <p className="text-xs text-ink-softer">{TRIGGER_LABELS[run.trigger]}</p>
                      </div>
                      <StateBadge run={run} />
                    </div>
                    {(run.sizeBytes !== null || run.durationMs !== null) && (
                      <p className="text-xs tabular-nums text-ink-softer">{[run.sizeBytes !== null ? formatBytes(run.sizeBytes) : null, run.durationMs !== null ? formatDuration(run.durationMs) : null].filter(Boolean).join(" · ")}</p>
                    )}
                    <RunDetail run={run} />
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4">
              <Pager page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} pageSize={data.meta.pageSize} onPageChange={setPage} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
