import { useState } from "react"
import { CircleCheck, CircleX, KeyRound, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Card, CardContent } from "@/components/ui/Card"
import { useBackupStatus, useGenerateBackupKey } from "@/hooks/useBackup"
import { formatBrasilia, isBusy, parseBackupError } from "@/lib/backup"
import type { BackupConfigDTO, GeneratedBackupKeyResponse } from "@/types/api"
import { KeyActionDialog, KeyRevealDialog, type KeyRequest } from "./KeyDialogs"
import { SectionHeader } from "./parts"

/**
 * Chave de criptografia do backup: existe? qual a impressão digital? Gerar (primeira vez) ou Substituir (aviso forte + frase `GERAR NOVA CHAVE` + senha). A chave inteira só existe aqui UMA vez,
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
    <Card data-testid="section-key">
      <SectionHeader
        icon={KeyRound}
        title="Chave de criptografia"
        description="As cópias saem do servidor trancadas com uma chave que só você guarda."
        aside={
          exists ? (
            <Badge variant="success" data-testid="key-status">
              <CircleCheck className="h-3 w-3" aria-hidden="true" />
              Chave gerada
            </Badge>
          ) : (
            <Badge variant="warning" data-testid="key-status">
              <CircleX className="h-3 w-3" aria-hidden="true" />
              Sem chave
            </Badge>
          )
        }
      />
      <CardContent className="space-y-4">
        {unavailable && (
          <Alert tone="danger" role="alert" icon={TriangleAlert} data-testid="key-unavailable">
            <p>O servidor não tem a PAYMENT_SECRETS_KEY, então não consegue guardar a chave do backup. Não dá para gerar a chave até quem cuida da infraestrutura configurá-la.</p>
          </Alert>
        )}

        {exists ? (
          <>
            <dl className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <dt className="text-xs font-bold uppercase tracking-wide text-ink-softer">Impressão digital</dt>
                <dd className="font-mono text-lg font-semibold text-ink" data-testid="key-fingerprint">
                  {dto.encryptionKey.fingerprint}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-xs font-bold uppercase tracking-wide text-ink-softer">Gerada em</dt>
                <dd className="text-sm font-semibold text-ink">{formatBrasilia(dto.encryptionKey.createdAt)}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-xs font-bold uppercase tracking-wide text-ink-softer">Mostrada em</dt>
                <dd className="text-sm font-semibold text-ink">{formatBrasilia(dto.encryptionKey.shownAt)}</dd>
              </div>
            </dl>
            <p className="text-xs text-ink-softer">
              Confira se a impressão digital é a mesma do arquivo que você guardou. A chave em si não aparece de novo. Sem ela os backups são inúteis, e uma chave nova não abre as cópias antigas: elas continuam
              precisando da chave antiga.
            </p>
            <div className="space-y-1">
              <Button type="button" variant="outline" size="touch" onClick={() => setDialog("replace")} disabled={disabled || busy || unavailable} aria-describedby="key-replace-reason" data-testid="key-replace">
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                Substituir a chave
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
              Gerar a chave
            </Button>
          </>
        )}
      </CardContent>

      {dialog && <KeyActionDialog mode={dialog} loading={generate.isPending} passwordError={passwordError} error={dialogError} onConfirm={(request) => void handleConfirm(request)} onCancel={closeDialog} />}
      {revealed && <KeyRevealDialog result={revealed} onDone={() => setRevealed(null)} />}
    </Card>
  )
}
