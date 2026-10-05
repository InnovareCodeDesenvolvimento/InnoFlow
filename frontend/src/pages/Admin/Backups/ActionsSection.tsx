import { useEffect, useState } from "react"
import { CircleCheck, CircleX, DatabaseBackup, FlaskConical, ShieldCheck, TriangleAlert, Zap } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Card, CardContent } from "@/components/ui/Card"
import { backupKeys, useBackupRun, useBackupStatus, useRunBackup, useTestBackupDestination, useVerifyBackup } from "@/hooks/useBackup"
import { DESTINATION_LABELS, actionBlockReason, formatBytes, formatDuration, isBusy, isRunFinished, parseBackupError, runErrorText, testDestinationText, type BackupError } from "@/lib/backup"
import type { BackupConfigDTO, BackupRunDTO, BackupTestDestinationResponse } from "@/types/api"
import { SectionHeader } from "./parts"

function RunOutcome({ run }: { run: BackupRunDTO }) {
  if (run.status === "FAILED") {
    const text = runErrorText(run.errorCode)
    return (
      <Alert tone="danger" role="alert" icon={CircleX} data-testid="run-outcome" data-ok="false" data-code={run.errorCode ?? "UNKNOWN"}>
        <p className="font-bold">{run.trigger === "VERIFY" ? "A conferência reprovou" : "O backup falhou"}: {text.title}</p>
        <p className="mt-0.5">{text.action}</p>
        <p className="mt-1 break-words text-xs">Código: {run.errorCode ?? "UNKNOWN"}</p>
      </Alert>
    )
  }
  const isTest = run.trigger !== "VERIFY" && run.objectKey === null
  return (
    <Alert tone={isTest ? "warning" : "success"} role="status" icon={isTest ? FlaskConical : CircleCheck} data-testid="run-outcome" data-ok="true" data-test-only={isTest ? "true" : "false"}>
      <p className="font-bold">{run.trigger === "VERIFY" ? "A cópia está íntegra" : isTest ? "Teste do pg_dump concluído" : "Backup concluído"}</p>
      <p className="mt-0.5">
        {run.trigger === "VERIFY"
          ? `A cópia mais recente foi baixada, abriu com a chave ${run.keyFingerprint ?? ""} e passou na conferência. Nada foi restaurado.`
          : isTest
            ? "O banco foi copiado, conferido e descartado: nada saiu do servidor, então isto NÃO conta como backup. Escolha um destino para ter cópias de verdade."
            : `A cópia cifrada foi enviada ao destino (${run.destination ? DESTINATION_LABELS[run.destination] : "destino"}).`}
      </p>
      <p className="mt-1 break-words text-xs">
        {[run.fileName, run.sizeBytes !== null ? formatBytes(run.sizeBytes) : null, run.tablesWithData !== null ? `${run.tablesWithData} tabelas com dados` : null, run.durationMs !== null ? formatDuration(run.durationMs) : null]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </Alert>
  )
}

function TestOutcome({ result }: { result: BackupTestDestinationResponse }) {
  if (result.ok) {
    return (
      <Alert tone="success" role="status" icon={CircleCheck} data-testid="test-outcome" data-ok="true">
        <p className="font-bold">Destino funcionando</p>
        <p className="mt-0.5">{result.destination === "S3" ? "O sistema gravou e apagou um arquivinho de teste no bucket." : "O sistema abriu a pasta de backups no Google Drive."}</p>
      </Alert>
    )
  }
  const text = testDestinationText(result.error?.code)
  return (
    <Alert tone="danger" role="alert" icon={CircleX} data-testid="test-outcome" data-ok="false" data-code={result.error?.code ?? "UNKNOWN"}>
      <p className="font-bold">O teste do destino falhou: {text.title}</p>
      <p className="mt-0.5">{text.action}</p>
      <p className="mt-1 break-words text-xs">Código: {result.error?.code ?? "UNKNOWN"}</p>
    </Alert>
  )
}

/**
 * Ações: "Fazer backup agora", "Conferir backup" e "Testar destino". Backup e conferência são ASSÍNCRONOS (202 `QUEUED`): o pedido devolve a execução e a tela a acompanha com
 * `GET /runs/:id` (2,5 s) até o estado final; o estado geral (`activeRun`) faz o mesmo para quem recarrega a página no meio. Os botões ficam desabilitados com o MOTIVO escrito (execução
 * em andamento, alteração não salva, destino incompleto). O resultado de cada ação é guardado no estado local da tela; erro do pedido (409/429/503) por `code`.
 */
export function ActionsSection({ dto, dirty }: { dto: BackupConfigDTO; dirty: boolean }) {
  const queryClient = useQueryClient()
  const { data: status } = useBackupStatus()
  const run = useRunBackup()
  const verify = useVerifyBackup()
  const test = useTestBackupDestination()
  const [trackedId, setTrackedId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<BackupError | null>(null)
  const [testResult, setTestResult] = useState<BackupTestDestinationResponse | null>(null)
  const tracked = useBackupRun(trackedId)

  const trackedRun = tracked.data
  const finished = isRunFinished(trackedRun)
  const trackedPending = trackedId !== null && !finished && !tracked.isError
  const busy = isBusy(status) || trackedPending || run.isPending || verify.isPending

  // Execução acompanhada terminou: o estado geral e o histórico mudaram (nada de setState aqui, só reconsulta).
  useEffect(() => {
    if (!finished) return
    void queryClient.invalidateQueries({ queryKey: backupKeys.status })
    void queryClient.invalidateQueries({ queryKey: backupKeys.runs })
  }, [finished, queryClient])

  const runReason = actionBlockReason("run", { dto, dirty, busy })
  const verifyReason = actionBlockReason("verify", { dto, dirty, busy })
  // O teste do destino é rápido e síncrono: só alteração não salva e destino ausente/incompleto o bloqueiam (um backup rodando não o impede).
  const testReason = actionBlockReason("test", { dto, dirty, busy: false })

  async function start(kind: "run" | "verify") {
    setActionError(null)
    setTrackedId(null)
    try {
      const created = await (kind === "run" ? run : verify).mutateAsync()
      setTrackedId(created.id)
    } catch (err) {
      setActionError(parseBackupError(err))
    }
  }

  async function testDestination() {
    setActionError(null)
    setTestResult(null)
    try {
      setTestResult(await test.mutateAsync())
    } catch (err) {
      setActionError(parseBackupError(err))
    } finally {
      test.reset()
    }
  }

  const trackingLost = trackedId !== null && !finished && tracked.isError
  const noDestination = dto.destination === null

  return (
    <Card data-testid="section-actions">
      <SectionHeader icon={Zap} title="Ações" description="Fazer, conferir e testar agora. As três usam a configuração salva." />
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <Button type="button" size="touch" onClick={() => void start("run")} loading={run.isPending} disabled={runReason !== null} aria-describedby="backup-run-reason" data-testid="action-run">
            {!run.isPending && <DatabaseBackup className="h-4 w-4" aria-hidden="true" />}
            Fazer backup agora
          </Button>
          <Button type="button" size="touch" variant="outline" onClick={() => void start("verify")} loading={verify.isPending} disabled={verifyReason !== null} aria-describedby="backup-verify-reason" data-testid="action-verify">
            {!verify.isPending && <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            Conferir backup
          </Button>
          <Button type="button" size="touch" variant="outline" onClick={() => void testDestination()} loading={test.isPending} disabled={test.isPending || testReason !== null} aria-describedby="backup-test-reason" data-testid="action-test">
            {!test.isPending && <FlaskConical className="h-4 w-4" aria-hidden="true" />}
            Testar destino
          </Button>
        </div>

        <ul className="space-y-1 text-xs text-ink-softer">
          <li>
            <span className="font-semibold text-ink-soft">Fazer backup agora:</span> copia o banco, cifra com a chave e envia ao destino.
            {noDestination && " Sem destino escolhido é só um teste do pg_dump: o banco é copiado, conferido e descartado, e não conta como backup."}
          </li>
          <li>
            <span className="font-semibold text-ink-soft">Conferir backup:</span> baixa a cópia mais recente, abre com a chave e lê o conteúdo. Não mexe no banco.
          </li>
          <li>
            <span className="font-semibold text-ink-soft">Testar destino:</span> grava e apaga um arquivinho de teste (S3) ou abre a pasta (Drive).
          </li>
        </ul>

        <div className="space-y-1 text-xs font-medium text-ink-soft" aria-live="polite">
          <p id="backup-run-reason" data-testid="reason-run" hidden={runReason === null}>
            {runReason}
          </p>
          <p id="backup-verify-reason" data-testid="reason-verify" hidden={verifyReason === null}>
            {verifyReason}
          </p>
          <p id="backup-test-reason" data-testid="reason-test" hidden={testReason === null}>
            {testReason}
          </p>
        </div>

        <div className="space-y-3" aria-live="polite">
          {actionError && (
            <Alert tone="danger" role="alert" icon={TriangleAlert} data-testid="action-error" data-code={actionError.code}>
              <p>{actionError.message}</p>
            </Alert>
          )}
          {trackingLost && (
            <Alert tone="warning" role="status" icon={TriangleAlert} data-testid="tracking-lost">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>Não deu para acompanhar essa execução agora. O estado geral e o histórico continuam sendo atualizados.</p>
                <Button type="button" variant="outline" size="touch-sm" onClick={() => void tracked.refetch()}>
                  Tentar de novo
                </Button>
              </div>
            </Alert>
          )}
          {trackedRun && finished && <RunOutcome run={trackedRun} />}
          {testResult && <TestOutcome result={testResult} />}
        </div>
      </CardContent>
    </Card>
  )
}
