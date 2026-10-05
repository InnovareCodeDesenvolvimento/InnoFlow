import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { backupKeys, useBackupRun, useBackupStatus, useRunBackup, useTestBackupDestination, useVerifyBackup } from "@/hooks/useBackup"
import { actionBlockReason, isBusy, isRunFinished, parseBackupError, type BackupError } from "@/lib/backup"
import type { BackupConfigDTO, BackupTestDestinationResponse } from "@/types/api"

export type ActionKind = "run" | "verify" | "test"

/**
 * As três ações da tela ("Fazer backup agora" no cabeçalho, "Conferir backup" no cartão da conferência e "Testar conexão" no rodapé do Destino) compartilham UM estado: só pode haver uma
 * execução por vez, e o resultado de cada uma aparece junto do botão que a pediu. Backup e conferência são ASSÍNCRONOS (202 `QUEUED`): o pedido devolve a execução e a tela a acompanha com
 * `GET /runs/:id` (2,5 s) até o estado final; o estado geral (`activeRun`) faz o mesmo para quem recarrega a página no meio. Cada botão tem o MOTIVO escrito quando está desabilitado
 * (execução em andamento, alteração não salva, destino incompleto). O teste do destino é rápido e síncrono: só alteração não salva e destino ausente/incompleto o bloqueiam.
 * Erro do pedido (409/429/503) por `code`, guardado junto de QUEM o pediu.
 */
export function useBackupActions(dto: BackupConfigDTO | undefined, dirty: boolean) {
  const queryClient = useQueryClient()
  const { data: status } = useBackupStatus()
  const run = useRunBackup()
  const verify = useVerifyBackup()
  const test = useTestBackupDestination()
  const [tracked, setTracked] = useState<{ id: string; kind: "run" | "verify" } | null>(null)
  const [actionError, setActionError] = useState<{ kind: ActionKind; error: BackupError } | null>(null)
  const [testResult, setTestResult] = useState<BackupTestDestinationResponse | null>(null)
  const trackedQuery = useBackupRun(tracked?.id ?? null)

  const trackedRun = trackedQuery.data
  const finished = isRunFinished(trackedRun)
  const trackedPending = tracked !== null && !finished && !trackedQuery.isError
  const busy = isBusy(status) || trackedPending || run.isPending || verify.isPending

  // Execução acompanhada terminou: o estado geral e o histórico mudaram (nada de setState aqui, só reconsulta).
  useEffect(() => {
    if (!finished) return
    void queryClient.invalidateQueries({ queryKey: backupKeys.status })
    void queryClient.invalidateQueries({ queryKey: backupKeys.runs })
  }, [finished, queryClient])

  // Sem a configuração carregada ainda não há o que dizer (a tela mostra o esqueleto no lugar dos botões).
  const reasons: Record<ActionKind, string | null> = dto
    ? {
        run: actionBlockReason("run", { dto, dirty, busy }),
        verify: actionBlockReason("verify", { dto, dirty, busy }),
        test: actionBlockReason("test", { dto, dirty, busy: false }),
      }
    : { run: null, verify: null, test: null }

  async function start(kind: "run" | "verify") {
    setActionError(null)
    setTracked(null)
    try {
      const created = await (kind === "run" ? run : verify).mutateAsync()
      setTracked({ id: created.id, kind })
    } catch (err) {
      setActionError({ kind, error: parseBackupError(err) })
    }
  }

  async function testDestination() {
    setActionError(null)
    setTestResult(null)
    try {
      setTestResult(await test.mutateAsync())
    } catch (err) {
      setActionError({ kind: "test", error: parseBackupError(err) })
    } finally {
      test.reset()
    }
  }

  return {
    busy,
    reasons,
    pending: { run: run.isPending, verify: verify.isPending, test: test.isPending },
    start,
    testDestination,
    actionError,
    testResult,
    /** A execução que a pessoa acabou de pedir (backup ou conferência) e o que dela se sabe. */
    tracked: {
      kind: tracked?.kind ?? null,
      run: trackedRun,
      finished,
      /** A consulta da execução falhou: a tela deixa de acompanhá-la (o estado geral e o histórico seguem valendo). */
      lost: tracked !== null && !finished && trackedQuery.isError,
      retry: () => void trackedQuery.refetch(),
    },
  }
}

export type BackupActions = ReturnType<typeof useBackupActions>
