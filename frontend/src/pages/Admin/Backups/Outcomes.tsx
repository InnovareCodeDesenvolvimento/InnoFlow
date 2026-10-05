import { CircleCheck, CircleX, FlaskConical, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { DESTINATION_LABELS, formatBytes, formatDuration, runErrorText, testDestinationText } from "@/lib/backup"
import type { BackupRunDTO, BackupTestDestinationResponse } from "@/types/api"
import type { ActionKind, BackupActions } from "./useBackupActions"

/** O resultado final de um backup ou de uma conferência (sempre com o texto por CÓDIGO; nunca o do servidor). */
export function RunOutcome({ run }: { run: BackupRunDTO }) {
  if (run.status === "FAILED") {
    const text = runErrorText(run.errorCode)
    return (
      <Alert tone="danger" role="alert" icon={CircleX} data-testid="run-outcome" data-ok="false" data-code={run.errorCode ?? "UNKNOWN"}>
        <p className="font-bold">
          {run.trigger === "VERIFY" ? "A conferência reprovou" : "O backup falhou"}: {text.title}
        </p>
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

/** O resultado do "Testar conexão" (200 com `ok`: a falha do destino é RESULTADO, não erro da rota). */
export function TestOutcome({ result }: { result: BackupTestDestinationResponse }) {
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
 * Tudo o que uma ação mostra DEPOIS de pedida, junto do botão que a pediu: o erro do pedido (409/429/503 por `code`), o aviso de "não deu para acompanhar", o resultado final e, para
 * "Testar conexão", o resultado do teste. `kind` filtra: o backup (cabeçalho), a conferência (cartão da conferência) e o teste (rodapé do Destino) mostram cada um o seu.
 */
export function ActionFeedback({ actions, kind }: { actions: BackupActions; kind: ActionKind }) {
  const { actionError, testResult, tracked } = actions
  const mine = tracked.kind === kind
  const error = actionError?.kind === kind ? actionError.error : null
  const hasContent = Boolean(error) || (mine && (tracked.lost || (tracked.run && tracked.finished))) || (kind === "test" && testResult)
  // Cada alerta abaixo já tem `role` (`alert`/`status`), que o leitor de tela anuncia ao entrar: não precisa de região viva própria.
  if (!hasContent) return null
  return (
    <div className="space-y-3">
      {error && (
        <Alert tone="danger" role="alert" icon={TriangleAlert} data-testid="action-error" data-code={error.code}>
          <p>{error.message}</p>
        </Alert>
      )}
      {mine && tracked.lost && (
        <Alert tone="warning" role="status" icon={TriangleAlert} data-testid="tracking-lost">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>Não deu para acompanhar essa execução agora. O estado geral e o histórico continuam sendo atualizados.</p>
            <Button type="button" variant="outline" size="touch-sm" onClick={tracked.retry}>
              Tentar de novo
            </Button>
          </div>
        </Alert>
      )}
      {mine && tracked.run && tracked.finished && <RunOutcome run={tracked.run} />}
      {kind === "test" && testResult && <TestOutcome result={testResult} />}
    </div>
  )
}
