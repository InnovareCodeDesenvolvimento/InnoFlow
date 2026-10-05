import { useEffect, useRef, useState } from "react"
import { DatabaseBackup, RotateCcw, Save, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/painel/PageHeader"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { ConfirmSaveDialog } from "@/components/admin/ConfirmSaveDialog"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Card, CardContent } from "@/components/ui/Card"
import { Skeleton } from "@/components/ui/Skeleton"
import { useBackupConfig, useUpdateBackupConfig } from "@/hooks/useBackup"
import {
  EMPTY_DRAFT,
  buildUpdatePayload,
  describeChanges,
  draftTouched,
  exigeSenha,
  hasChanges,
  parseBackupError,
  s3HostChanged,
  validateDraft,
  withCurrentPassword,
  type BackupDraft,
  type BackupError,
  type DraftErrors,
} from "@/lib/backup"
import { cn } from "@/lib/utils"
import { getApiErrorStatus } from "@/services/api"
import type { BackupConfigDTO } from "@/types/api"
import { ActionsSection } from "./ActionsSection"
import { DestinationSection, type DestinationPatch } from "./DestinationSection"
import { GoogleReturnBanner } from "./GoogleReturnBanner"
import { HistorySection } from "./HistorySection"
import { KeySection } from "./KeySection"
import { RestoreNotice, SecretsKeyMissingAlert, SecretsKeyPermanentNotice, SecretsUnreadableAlert } from "./Notices"
import { ScheduleSection } from "./ScheduleSection"
import { StatusSection, StatusSkeleton } from "./StatusSection"

const PAGE_TITLE = "Backups"
const PAGE_DESCRIPTION = "Cópia cifrada do banco fora do servidor, com aviso se atrasar: destino, chave, agendamento e histórico."

/**
 * Esqueleto com a FORMA da tela pronta (aviso permanente, estado, ações, chave, agendamento, destino, histórico): evita salto de layout quando os dados chegam. Alturas MEDIDAS no cartão real
 * (conta `backup-s3@`, tela cheia): 375 px / 768 px / 1440 px (de 1024 px para cima a sidebar fixa estreita a coluna, daí `sm` e `lg`). A barra de salvar e o aviso de restauração ficam
 * abaixo do histórico e não entram: o que ainda se mexe quando os dados chegam é só o que está depois do histórico.
 */
function BackupSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando a configuração de backup">
      <Skeleton className="h-[194px] w-full rounded-xl sm:h-[94px] lg:h-[74px]" />
      <StatusSkeleton />
      <Skeleton className="h-[404px] w-full rounded-card sm:h-[236px]" />
      <Skeleton className="h-[473px] w-full rounded-card sm:h-[280px] lg:h-[260px]" />
      <Skeleton className="h-[793px] w-full rounded-card sm:h-[438px] lg:h-[406px]" />
      <Skeleton className="h-[990px] w-full rounded-card sm:h-[637px] lg:h-[584px]" />
      <Skeleton className="h-[1954px] w-full rounded-card sm:h-[1586px] lg:h-[825px]" />
    </div>
  )
}

/**
 * Admin → Backups. ADMIN-ONLY: o guarda de papel mora na ROTA (`RequireAuth roles=["ADMIN"]`) e o servidor confere de novo (403 `FORBIDDEN`). Rota lazy.
 *
 * Estado: o servidor é a fonte da verdade (`useQuery`); o que a pessoa edita é um RASCUNHO de sobreposições (`BackupDraft`) por cima do DTO carregado, não uma cópia dele, então não há
 * efeito sincronizando estado a partir de dado assíncrono. Salvar envia só o diff; segredos só existem no rascunho enquanto a pessoa os digita e morrem junto com ele depois do PUT
 * (e a mutation é zerada: `gcTime: 0` + `reset()`). A chave do backup e o estado das execuções têm componentes e consultas próprios (não passam pelo rascunho).
 */
export default function BackupsPage() {
  const { data: dto, isLoading, isError, error, refetch } = useBackupConfig()
  const forbidden = getApiErrorStatus(error) === 403

  return (
    <div className="space-y-6">
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} icon={DatabaseBackup} />

      <GoogleReturnBanner />

      {isLoading && <BackupSkeleton />}

      {!isLoading && isError && !dto && (
        <ErrorState message={forbidden ? "Somente administradores podem ver e alterar os backups." : parseBackupError(error).message} onRetry={forbidden ? undefined : () => void refetch()} />
      )}

      {dto && <BackupEditor dto={dto} />}
    </div>
  )
}

/** O formulário e as seções. Só existe com o DTO carregado (o rascunho nasce vazio junto com ele) e devolve os blocos como irmãos, para herdarem o `space-y-6` da página. */
function BackupEditor({ dto }: { dto: BackupConfigDTO }) {
  const mutation = useUpdateBackupConfig()

  const [draft, setDraft] = useState<BackupDraft>(EMPTY_DRAFT)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveError, setSaveError] = useState<BackupError | null>(null)
  // 403 INVALID_CURRENT_PASSWORD: o erro vive no diálogo de salvar (que continua aberto), não no alerta da página.
  const [passwordError, setPasswordError] = useState<string | null>(null)
  // Erros que o SERVIDOR apontou num campo (endereço recusado, credencial a redigitar): somem na próxima edição.
  const [serverErrors, setServerErrors] = useState<DraftErrors>({})
  const errorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (saveError) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [saveError])

  const edit = (update: (prev: BackupDraft) => BackupDraft) => {
    setServerErrors({})
    setDraft(update)
  }

  const patchSchedule = (patch: Partial<BackupDraft>) => edit((prev) => ({ ...prev, ...patch }))

  const patchDestination = (patch: DestinationPatch) =>
    edit((prev) => {
      const next: BackupDraft = { ...prev, s3: { ...prev.s3 }, drive: { ...prev.drive }, clear: { ...prev.clear } }
      if ("destination" in patch) next.destination = patch.destination
      if (patch.s3) {
        next.s3 = { ...next.s3, ...patch.s3 }
        // Digitar um valor novo num segredo desfaz "apagar" (apagar e trocar ao mesmo tempo não faz sentido).
        if (patch.s3.accessKey !== undefined) next.clear.s3AccessKey = false
        if (patch.s3.secretKey !== undefined) next.clear.s3SecretKey = false
        // Mudou o ENDEREÇO do bucket com credencial salva: abre os dois campos de credencial (as duas precisam ser digitadas de novo).
        if (patch.s3.endpoint !== undefined && s3HostChanged(dto, next)) {
          next.s3.accessKey = next.s3.accessKey ?? ""
          next.s3.secretKey = next.s3.secretKey ?? ""
        }
      }
      if (patch.drive) {
        next.drive = { ...next.drive, ...patch.drive }
        if (patch.drive.clientSecret !== undefined) next.clear.driveClientSecret = false
      }
      return next
    })

  const markClear = (key: "s3AccessKey" | "s3SecretKey" | "driveClientSecret", marked: boolean) =>
    edit((prev) => ({
      ...prev,
      clear: { ...prev.clear, [key]: marked },
      // Marcar para apagar descarta o que foi digitado.
      s3: { ...prev.s3, ...(marked && key === "s3AccessKey" ? { accessKey: undefined } : {}), ...(marked && key === "s3SecretKey" ? { secretKey: undefined } : {}) },
      drive: { ...prev.drive, ...(marked && key === "driveClientSecret" ? { clientSecret: undefined } : {}) },
    }))

  const payload = buildUpdatePayload(dto, draft)
  const changes = describeChanges(dto, payload)
  const errors = validateDraft(dto, draft)
  const fieldErrors: DraftErrors = { ...serverErrors, ...errors }
  const dirty = hasChanges(payload)
  const needsPassword = exigeSenha(payload)
  const errorCount = Object.keys(errors).length
  const canSave = dirty && errorCount === 0 && !mutation.isPending
  const reducesRetention = payload.retentionCount !== undefined && payload.retentionCount < dto.retentionCount

  const handleDiscard = () => {
    setDraft(EMPTY_DRAFT)
    setSaveError(null)
    setServerErrors({})
  }

  const closeSaveDialog = () => {
    setSaveDialogOpen(false)
    setPasswordError(null)
  }

  const handleSave = async (currentPassword?: string) => {
    if (!dirty || mutation.isPending) return
    setSaveError(null)
    setPasswordError(null)
    try {
      await mutation.mutateAsync(currentPassword ? withCurrentPassword(payload, currentPassword) : payload)
      // Segredos digitados morrem aqui: o rascunho inteiro é descartado (o DTO novo já está no cache).
      setDraft(EMPTY_DRAFT)
      setServerErrors({})
      closeSaveDialog()
      toast.success("Configuração do backup salva.")
    } catch (err) {
      const parsed = parseBackupError(err)
      if (parsed.code === "INVALID_CURRENT_PASSWORD") {
        // Senha errada: o diálogo fica aberto com o erro; o rascunho (e a sessão: é 403, não 401) seguem intactos.
        setPasswordError(parsed.message)
      } else {
        closeSaveDialog()
        setSaveError(parsed)
        setServerErrors(Object.fromEntries(parsed.fields.map((field) => [field, parsed.message])))
      }
    } finally {
      // O corpo do PUT carrega credenciais do bucket, o Client Secret e a senha atual: `mutation.variables` não pode ficar na memória até o próximo envio.
      mutation.reset()
    }
  }

  const requestSave = () => {
    setSaveError(null)
    setPasswordError(null)
    if (needsPassword) setSaveDialogOpen(true)
    else void handleSave()
  }

  return (
    <>
      <SecretsKeyPermanentNotice />
      {!dto.secretsKeyConfigured && <SecretsKeyMissingAlert />}
      {dto.secretsKeyConfigured && !dto.secretsReadable && <SecretsUnreadableAlert />}

      <StatusSection enabled={dto.enabled} />

      <ActionsSection dto={dto} dirty={dirty} />

      <KeySection dto={dto} disabled={mutation.isPending} />

      {saveError && (
        <Alert ref={errorRef} tone="danger" role="alert" icon={TriangleAlert} data-testid="save-error" data-code={saveError.code}>
          <p className="font-semibold">{saveError.message}</p>
          {saveError.draftKept && <p className="mt-1 text-xs font-medium">O que você preencheu continua na tela.</p>}
        </Alert>
      )}

      <ScheduleSection dto={dto} draft={draft} errors={fieldErrors} onChange={patchSchedule} disabled={mutation.isPending} />

      <DestinationSection dto={dto} draft={draft} errors={fieldErrors} onChange={patchDestination} onMarkClear={markClear} disabled={mutation.isPending} dirty={dirty} />

      {/* Barra de salvar: um card como os outros (mesmo padrão do gateway e da comunicação). Com alteração pendente ela gruda no fim da área de rolagem do shell (o <main> do admin); sem alteração fica no fim do bloco, sem tapar conteúdo. */}
      <Card className={cn("z-10", dirty && "sticky bottom-0 shadow-tinted-card")} data-testid="save-bar">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="space-y-0.5" aria-live="polite">
            <p className="text-sm text-ink-softer" data-testid="save-bar-status">
              {dirty ? (
                <>
                  <span className="font-semibold text-ink">
                    {changes.length} {changes.length === 1 ? "alteração não salva" : "alterações não salvas"}
                  </span>
                  {errorCount > 0 && (
                    <span className="font-semibold text-danger-700" data-testid="save-bar-errors">
                      {" "}
                      — corrija os campos marcados para salvar.
                    </span>
                  )}
                </>
              ) : (
                "Nenhuma alteração pendente."
              )}
            </p>
            <p className="text-xs text-ink-softer" data-testid="save-bar-password-note">
              {dirty ? (needsPassword ? "Esta alteração pede a sua senha atual ao salvar." : "Esta alteração não pede senha.") : "Mudar destino, credenciais, cópias a manter ou ligar o automático pede a sua senha."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button type="button" variant="outline" size="touch" onClick={handleDiscard} disabled={(!dirty && !draftTouched(draft)) || mutation.isPending}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Descartar
            </Button>
            <Button type="button" size="touch" onClick={requestSave} loading={mutation.isPending && !saveDialogOpen} disabled={!canSave} data-testid="save-button">
              {!(mutation.isPending && !saveDialogOpen) && <Save className="h-4 w-4" aria-hidden="true" />}
              Salvar alterações
            </Button>
          </div>
        </CardContent>
      </Card>

      {saveDialogOpen && dirty && (
        <ConfirmSaveDialog
          title="Confirmar alterações no backup"
          description="Revise o que será enviado ao servidor. Chaves, segredos e senhas nunca são exibidos."
          passwordHint="Pedida em toda alteração que muda para onde o backup vai, com que credencial, quantas cópias ficam ou que liga o automático."
          items={changes}
          extra={
            reducesRetention ? (
              <Alert tone="warning" size="sm" role="status" icon={TriangleAlert} className="mt-4 font-medium" data-testid="retention-warning">
                <p>Reduzir as cópias a manter apaga as mais antigas no próximo backup (nunca a única).</p>
              </Alert>
            ) : undefined
          }
          loading={mutation.isPending}
          passwordError={passwordError}
          onCancel={closeSaveDialog}
          onConfirm={(currentPassword) => void handleSave(currentPassword)}
        />
      )}

      <HistorySection />

      <RestoreNotice />
    </>
  )
}
