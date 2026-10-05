import { CircleAlert, Loader2 } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Card } from "@/components/ui/Card"
import { Skeleton } from "@/components/ui/Skeleton"
import { useBackupStatus } from "@/hooks/useBackup"
import { RUN_STATUS_LABELS, TRIGGER_LABELS, formatAge, formatBrasiliaLong, queuedTooLong, runErrorText, situationOf } from "@/lib/backup"
import type { BackupRunDTO } from "@/types/api"
import { Fact } from "./parts"

/** Esqueleto com a FORMA da faixa pronta (3 colunas): evita salto de layout quando o estado chega. Alturas medidas (conta `backup-s3@`): 375 / 768 / 1440 px. */
export function StatusSkeleton() {
  return <Skeleton className="h-[236px] w-full rounded-card sm:h-[106px]" />
}

/** O que a execução ativa está fazendo, em palavras ("Backup manual: na fila"). */
function ActiveRunLine({ run, now }: { run: BackupRunDTO; now: number }) {
  return (
    <Alert tone="info" role="status" icon={Loader2} iconClassName="animate-spin" data-testid="active-run" data-status={run.status}>
      <p className="font-bold">
        {TRIGGER_LABELS[run.trigger] === "Conferência" ? "Conferência" : `Backup ${TRIGGER_LABELS[run.trigger].toLowerCase()}`}: {RUN_STATUS_LABELS[run.status].toLowerCase()}
      </p>
      <p className="mt-0.5">
        {run.status === "QUEUED" ? "O pedido está na fila, esperando o worker pegar." : "O banco está sendo copiado e enviado. Pode levar alguns minutos."} A tela acompanha sozinha.
      </p>
      {queuedTooLong(run, now) && (
        <p className="mt-1 font-medium" data-testid="active-run-queued-hint">
          Está na fila há mais de 1 minuto: o worker pode estar fora do ar. Se passar de 15 minutos o pedido é encerrado como falha.
        </p>
      )}
    </Alert>
  )
}

/**
 * Faixa de estado (como no InnoChat): "Última cópia enviada", "Próxima cópia automática" e o selo "Situação" (Em dia / Atrasado / Nunca rodou / Desligado / Copiando agora). Quando a última
 * tentativa falhou, o motivo (por código) aparece sob a última cópia; a execução ativa aparece sob a faixa. O estado vem do servidor (`useBackupStatus`, com polling de 3 s só enquanto há
 * execução ativa). Se a consulta falhar, a tela continua útil (configuração e histórico): só este cartão mostra o erro, com "Tentar de novo".
 */
export function StatusSection({ enabled }: { enabled: boolean }) {
  const { data: status, isLoading, isError, refetch, dataUpdatedAt } = useBackupStatus()

  if (isLoading) return <StatusSkeleton />
  if (isError && !status) {
    return (
      <Alert tone="danger" role="alert" icon={CircleAlert} data-testid="status-error">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            <span className="font-bold">Não deu para ler o estado do backup.</span> A configuração abaixo continua valendo. Tente de novo em instantes.
          </p>
          <Button type="button" variant="outline" size="touch-sm" onClick={() => void refetch()}>
            Tentar de novo
          </Button>
        </div>
      </Alert>
    )
  }
  if (!status) return null

  const situation = situationOf(status, enabled)
  const lastBackup = status.lastBackupRun
  const attention = situation.tone === "danger"

  return (
    <Card className="p-5 sm:p-6" data-testid="section-status">
      <h2 className="sr-only">Estado geral</h2>
      <dl className="grid gap-4 sm:grid-cols-3">
        <Fact label="Última cópia enviada" testId="fact-last-success">
          <span className="block">{formatBrasiliaLong(status.lastSuccessAt)}</span>
          {status.ageHours !== null && <span className="block text-xs font-normal text-ink-softer">há {formatAge(status.ageHours)}</span>}
          {status.lastSuccessAt === null && <span className="block text-xs font-normal text-ink-softer">Nenhuma cópia saiu ainda.</span>}
          {lastBackup?.status === "FAILED" && (
            <span className="block text-xs font-medium text-danger-700" data-testid="fact-last-attempt">
              Última tentativa falhou: {runErrorText(lastBackup.errorCode).title}
            </span>
          )}
        </Fact>
        <Fact label="Próxima cópia automática" testId="fact-next-run">
          {status.nextRunAt ? (
            <>
              <span className="block">{formatBrasiliaLong(status.nextRunAt)}</span>
              <span className="block text-xs font-normal text-ink-softer">Horário de Brasília</span>
            </>
          ) : (
            <span className="block">Automático desligado</span>
          )}
        </Fact>
        <Fact label="Situação" testId="fact-situation">
          <span className="block" data-testid="health" data-tone={situation.health}>
            <Badge variant={situation.tone} data-testid="status-badge">
              {situation.tone === "primary" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
              {situation.label}
            </Badge>
            {situation.detail && (
              <span className={attention ? "mt-1 block text-xs font-medium text-danger-700" : "mt-1 block text-xs font-normal text-ink-softer"} role={attention ? "alert" : undefined} data-testid="health-title">
                {situation.detail}
              </span>
            )}
          </span>
        </Fact>
      </dl>

      {status.activeRun && (
        <div className="mt-4" aria-live="polite">
          <ActiveRunLine run={status.activeRun} now={dataUpdatedAt} />
        </div>
      )}
    </Card>
  )
}
