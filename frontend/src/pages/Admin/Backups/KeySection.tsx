import { useState } from "react"
import { KeyRound, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { CardContent } from "@/components/ui/Card"
import { useBackupStatus, useGenerateBackupKey } from "@/hooks/useBackup"
import { formatBrasiliaLong, isBusy, parseBackupError } from "@/lib/backup"
import type { BackupConfigDTO, GeneratedBackupKeyResponse } from "@/types/api"
import { KeyActionDialog, KeyRevealDialog, type KeyRequest } from "./KeyDialogs"
import { HelpCard } from "./parts"

/**
 * Chave do backup: existe? qual a impressão digital? "Gerar chave" (primeira vez) ou "Gerar nova chave" (substituir: aviso forte + frase `GERAR NOVA CHAVE` + senha). A chave inteira só existe aqui UMA vez,
 * no estado local `revealed` (nunca em cache de query, storage, atributo ou log): `gcTime: 0` + `reset()` na mutation, e o diálogo só fecha depois de "guardei a chave".
 * Trocar a chave exige `expectedFingerprint` (o que esta tela viu): se outra pessoa gerou antes, o servidor recusa (409) em vez de trocar uma chave que ninguém viu.
 */
export function KeySection({ dto, disabled }: { dto: BackupConfigDTO; disabled: boolean }) {
  const generate = useGenerateBackupKey()
  const { data: status } = useBackupStatus()
  const [dialog, setDialog] = useState<null | "generate" | "replace">(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<GeneratedBackupKeyResponse | null>(null)
  const exists = dto.encryptionKey.exists
  // Trocar a chave com um backup rodando o servidor recusa (409 BACKUP_BUSY): a tela já avisa e desabilita.
  const busy = isBusy(status)
  const unavailable = !dto.secretsKeyConfigured

  const closeDialog = () => {
    setDialog(null)
    setPasswordError(null)
    setDialogError(null)
  }

  async function handleConfirm(request: KeyRequest) {
    setPasswordError(null)
    setDialogError(null)
    try {
      const result = await generate.mutateAsync({
        currentPassword: request.currentPassword,
        ...(exists ? { replace: true, confirmation: request.confirmation, expectedFingerprint: dto.encryptionKey.fingerprint } : {}),
      })
      // A chave sai da mutation JÁ: o que a mutation guardou (resposta e corpo) é descartado; a única cópia fica neste estado local até a pessoa confirmar.
      setRevealed(result)
      closeDialog()
    } catch (err) {
      const parsed = parseBackupError(err)
      if (parsed.code === "INVALID_CURRENT_PASSWORD") setPasswordError(parsed.message)
      else setDialogError(parsed.message)
    } finally {
      generate.reset()
    }
  }

  return (
    <HelpCard
      testId="section-key"
      title="Chave do backup"
      description="As cópias saem do servidor trancadas com uma chave que só você guarda."
      className="h-full"
      help={
        <>
          <p>
            Cada cópia sai do servidor cifrada com esta chave. Ela aparece <span className="font-semibold">uma única vez</span>, quando é gerada: guarde-a num gerenciador de senhas E numa cópia offline. Sem ela os backups são inúteis.
          </p>
          <p>
            A impressão digital é só uma conferência: se for a mesma do arquivo que você guardou, a chave é a certa. “Gerar nova chave” troca a chave, mas uma chave nova não abre as cópias antigas: elas continuam precisando da chave antiga.
          </p>
          <p>Esta chave não substitui o JWT_SECRET do servidor, que cifra os segredos salvos (credenciais, senhas e tokens). Guarde as duas fora do servidor.</p>
        </>
      }
    >
      <CardContent className="flex-1 space-y-4">
        {unavailable && (
          <Alert tone="danger" role="alert" icon={TriangleAlert} data-testid="key-unavailable">
            <p>O servidor não tem a chave que cifra os segredos (derivada do JWT_SECRET), então não consegue guardar a chave do backup. Não dá para gerar a chave até quem cuida da infraestrutura conferir o JWT_SECRET.</p>
          </Alert>
        )}

        {exists ? (
          <>
            <div className="space-y-1">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">Impressão digital da chave atual</p>
              <p className="font-mono text-lg font-semibold text-ink" data-testid="key-fingerprint">
                {dto.encryptionKey.fingerprint}
              </p>
              <p className="text-xs text-ink-softer">
                Gerada em {formatBrasiliaLong(dto.encryptionKey.createdAt)}. Confira se é a mesma do arquivo que você guardou. A chave em si não aparece de novo.
              </p>
            </div>
            <div className="space-y-1">
              <Button type="button" variant="outline" size="touch" onClick={() => setDialog("replace")} disabled={disabled || busy || unavailable} aria-describedby="key-replace-reason" data-testid="key-replace">
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                Gerar nova chave
              </Button>
              <p id="key-replace-reason" className="text-xs font-medium text-ink-soft" data-testid="key-replace-reason" hidden={!busy}>
                Há um backup em andamento: espere terminar para trocar a chave.
              </p>
            </div>
          </>
        ) : (
          <>
            <Alert tone="warning" role="status" icon={TriangleAlert} data-testid="key-missing">
              <p>
                <span className="font-bold">Ainda não há chave.</span> Sem ela o backup não sai do servidor e o automático não liga. Ela aparece uma única vez: tenha onde guardá-la (gerenciador de senhas e uma cópia offline).
              </p>
            </Alert>
            <Button type="button" size="touch" onClick={() => setDialog("generate")} disabled={disabled || unavailable} data-testid="key-generate">
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              Gerar chave
            </Button>
          </>
        )}
      </CardContent>

      {dialog && <KeyActionDialog mode={dialog} loading={generate.isPending} passwordError={passwordError} error={dialogError} onConfirm={(request) => void handleConfirm(request)} onCancel={closeDialog} />}
      {revealed && <KeyRevealDialog result={revealed} onDone={() => setRevealed(null)} />}
    </HelpCard>
  )
}
