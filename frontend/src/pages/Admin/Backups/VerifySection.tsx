import { ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { CardContent } from "@/components/ui/Card"
import { useBackupStatus } from "@/hooks/useBackup"
import { formatBrasiliaLong, runErrorText } from "@/lib/backup"
import { ActionFeedback } from "./Outcomes"
import { HelpCard } from "./parts"
import type { BackupActions } from "./useBackupActions"

/**
 * "Conferir backup": baixa a cópia mais recente do destino, abre com a chave e lê o conteúdo. Não mexe no banco. É ASSÍNCRONO (202 + polling, ver `useBackupActions`); o botão fica
 * desabilitado com o MOTIVO escrito (execução em andamento, alteração não salva, destino ausente ou incompleto). Mostra também quando foi a última conferência e como terminou.
 */
export function VerifySection({ actions }: { actions: BackupActions }) {
  const { data: status } = useBackupStatus()
  const lastVerify = status?.lastVerifyRun
  const reason = actions.reasons.verify

  return (
    <HelpCard
      testId="section-verify"
      title="Conferir backup"
      description="Baixa a cópia mais recente, abre com a chave e lê o conteúdo. Não mexe no banco."
      className="h-full"
      help={
        <>
          <p>
            É a prova de que a cópia serve: o sistema baixa o arquivo mais recente do destino, confere o SHA-256, abre com a chave do backup e lista as tabelas com dados. Nada é restaurado e o banco não é tocado.
          </p>
          <p>Aqui você pode conferir na hora, por exemplo depois de trocar o destino ou a chave. Se a conferência reprovar, o motivo aparece no cartão e no histórico.</p>
        </>
      }
    >
      <CardContent className="flex-1 space-y-4">
        <div className="space-y-1">
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => void actions.start("verify")}
            loading={actions.pending.verify}
            disabled={reason !== null}
            aria-describedby="backup-verify-reason"
            data-testid="action-verify"
          >
            {!actions.pending.verify && <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            Conferir backup
          </Button>
          <p id="backup-verify-reason" className="text-xs font-medium text-ink-soft" data-testid="reason-verify" hidden={reason === null}>
            {reason}
          </p>
        </div>

        <ActionFeedback actions={actions} kind="verify" />

        <div className="space-y-0.5" data-testid="fact-last-verify">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">Última conferência</p>
          {lastVerify ? (
            <>
              <p className="text-sm font-semibold text-ink">{formatBrasiliaLong(lastVerify.finishedAt ?? lastVerify.createdAt)}</p>
              <p className={lastVerify.status === "FAILED" ? "text-xs font-medium text-danger-700" : "text-xs text-ink-softer"}>
                {lastVerify.status === "FAILED" ? `Reprovou: ${runErrorText(lastVerify.errorCode).title}` : "A cópia abriu e passou na conferência"}
              </p>
            </>
          ) : (
            <p className="text-xs text-ink-softer">Nunca conferido. Use “Conferir backup”.</p>
          )}
        </div>

        <p className="text-xs text-ink-softer">Uma vez por semana o sistema faz isso sozinho e avisa por e-mail se a cópia não abrir.</p>
      </CardContent>
    </HelpCard>
  )
}
