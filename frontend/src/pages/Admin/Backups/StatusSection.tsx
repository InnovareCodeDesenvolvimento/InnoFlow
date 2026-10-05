import { Activity, CircleAlert, CircleCheck, CircleMinus, Loader2, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Card, CardContent } from "@/components/ui/Card"
import { Skeleton } from "@/components/ui/Skeleton"
import { useBackupStatus } from "@/hooks/useBackup"
import { RUN_STATUS_LABELS, TRIGGER_LABELS, formatAge, formatBrasilia, healthOf, queuedTooLong, runErrorText, type HealthTone } from "@/lib/backup"
import type { BackupRunDTO } from "@/types/api"
import { Fact, SectionHeader } from "./parts"

const HEALTH_ALERT = {
  ok: { tone: "success", icon: CircleCheck, role: "status" },
  off: { tone: "neutral", icon: CircleMinus, role: "status" },
  late: { tone: "danger", icon: TriangleAlert, role: "alert" },
  never: { tone: "danger", icon: TriangleAlert, role: "alert" },
} as const satisfies Record<HealthTone, { tone: "success" | "neutral" | "danger"; icon: typeof CircleCheck; role: "status" | "alert" }>

/** Esqueleto com a FORMA do cartão pronto (destaque + 4 dados): evita salto de layout quando o estado chega. Alturas medidas (conta `backup-s3@`): 375 / 768 / 1440 px. */
export function StatusSkeleton() {
  return <Skeleton className="h-[549px] w-full rounded-card sm:h-[332px] lg:h-[258px]" />
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
 * Estado geral: último backup OK, última tentativa, próximo agendado, última conferência e o destaque vermelho "Sem backup há X" quando atrasado. O estado vem do servidor (`useBackupStatus`,
 * com polling de 3 s só enquanto há execução ativa). Se a consulta do estado falhar, a tela continua útil (configuração e histórico): só este cartão mostra o erro, com "Tentar de novo".
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

  const health = healthOf(status, enabled)
  const style = HEALTH_ALERT[health.tone]
  const lastBackup = status.lastBackupRun
  const lastVerify = status.lastVerifyRun

  return (
    <Card data-testid="section-status">
      <SectionHeader
        icon={Activity}
        title="Estado geral"
        description="O que aconteceu por último e quando o sistema tenta de novo."
        aside={
          status.running ? (
            <Badge variant="primary" data-testid="status-badge">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Rodando agora
            </Badge>
          ) : health.tone === "late" || health.tone === "never" ? (
            <Badge variant="danger" data-testid="status-badge">
              <TriangleAlert className="h-3 w-3" aria-hidden="true" />
              Atenção
            </Badge>
          ) : enabled ? (
            <Badge variant="success" data-testid="status-badge">
              <CircleCheck className="h-3 w-3" aria-hidden="true" />
              Automático ligado
            </Badge>
          ) : (
            <Badge variant="neutral" data-testid="status-badge">
              <CircleMinus className="h-3 w-3" aria-hidden="true" />
              Automático desligado
            </Badge>
          )
        }
      />
      <CardContent className="space-y-4">
        <Alert tone={style.tone} role={style.role} icon={style.icon} data-testid="health" data-tone={health.tone}>
          <p className="font-bold" data-testid="health-title">
            {health.title}
          </p>
          <p className="mt-0.5">{health.detail}</p>
        </Alert>

        <div aria-live="polite">{status.activeRun && <ActiveRunLine run={status.activeRun} now={dataUpdatedAt} />}</div>

        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Último backup com sucesso" testId="fact-last-success">
            <span className="block">{formatBrasilia(status.lastSuccessAt)}</span>
            {status.ageHours !== null && <span className="block text-xs font-normal text-ink-softer">há {formatAge(status.ageHours)}</span>}
            {status.lastSuccessAt === null && <span className="block text-xs font-normal text-ink-softer">Nenhuma cópia saiu ainda.</span>}
          </Fact>
          <Fact label="Última tentativa" testId="fact-last-attempt">
            <span className="block">{formatBrasilia(lastBackup?.finishedAt ?? status.lastAttemptAt)}</span>
            {lastBackup ? (
              lastBackup.status === "FAILED" ? (
                <span className="block text-xs font-medium text-danger-700">Falhou: {runErrorText(lastBackup.errorCode).title}</span>
              ) : (
                <span className="block text-xs font-normal text-ink-softer">{lastBackup.objectKey ? "Deu certo" : "Teste do pg_dump (não saiu do servidor)"}</span>
              )
            ) : (
              <span className="block text-xs font-normal text-ink-softer">Nenhuma tentativa ainda.</span>
            )}
          </Fact>
          <Fact label="Próximo agendado" testId="fact-next-run">
            {status.nextRunAt ? (
              <>
                <span className="block">{formatBrasilia(status.nextRunAt)}</span>
                <span className="block text-xs font-normal text-ink-softer">Horário de Brasília</span>
              </>
            ) : (
              <span className="block">Automático desligado</span>
            )}
          </Fact>
          <Fact label="Última conferência" testId="fact-last-verify">
            {lastVerify ? (
              <>
                <span className="block">{formatBrasilia(lastVerify.finishedAt ?? lastVerify.createdAt)}</span>
                <span className={lastVerify.status === "FAILED" ? "block text-xs font-medium text-danger-700" : "block text-xs font-normal text-ink-softer"}>
                  {lastVerify.status === "FAILED" ? `Reprovou: ${runErrorText(lastVerify.errorCode).title}` : "A cópia abriu e passou na conferência"}
                </span>
              </>
            ) : (
              <span className="block text-xs font-normal text-ink-softer">Nunca conferido. Use “Conferir backup”.</span>
            )}
          </Fact>
        </dl>
      </CardContent>
    </Card>
  )
}
