import { useEffect, useId, useRef, useState } from "react"
import { DatabaseBackup, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/painel/PageHeader"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { ConfirmSaveDialog } from "@/components/admin/ConfirmSaveDialog"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Skeleton } from "@/components/ui/Skeleton"
import { useBackupConfig, useUpdateBackupConfig } from "@/hooks/useBackup"
import {
  EMPTY_DRAFT,
  buildUpdatePayload,
  clearDraftScope,
  describeChanges,
  draftTouched,
  exigeSenha,
  hasChanges,
  parseBackupError,
  s3HostChanged,
  scopeDraft,
  validateDraft,
  withCurrentPassword,
  type BackupDraft,
  type BackupError,
  type BackupScope,
  type DraftErrors,
} from "@/lib/backup"
import { getApiErrorStatus } from "@/services/api"
import type { BackupConfigDTO } from "@/types/api"
import { DestinationSection, type DestinationPatch } from "./DestinationSection"
import { GoogleReturnBanner } from "./GoogleReturnBanner"
import { HistorySection } from "./HistorySection"
import { KeySection } from "./KeySection"
import { RestoreNotice, SecretsKeyMissingAlert, SecretsKeyPermanentNotice, SecretsUnreadableAlert } from "./Notices"
import { ActionFeedback } from "./Outcomes"
import { HelpPanel, HelpToggle } from "./parts"
import { ScheduleSection } from "./ScheduleSection"
import { StatusSection, StatusSkeleton } from "./StatusSection"
import { useBackupActions, type BackupActions } from "./useBackupActions"
import { VerifySection } from "./VerifySection"

const PAGE_TITLE = "Backup do banco"
const PAGE_DESCRIPTION = "Cópia cifrada do banco fora do servidor, com aviso se atrasar."

/**
 * Esqueleto com a FORMA da tela pronta (faixa de estado, os 4 cartões em grade, histórico): evita salto de layout quando os dados chegam. Alturas MEDIDAS nos cartões reais (conta `backup-s3@`,
 * tela cheia): 375 px / 768 px / 1440 px (a grade vira 2 colunas em `lg`; `sm` cobre 640-1023 px). O rodapé de avisos fica abaixo do histórico e
 * não entra: o que ainda se mexe quando os dados chegam é só o que está depois do histórico.
 */
function BackupSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando a configuração de backup">
      <StatusSkeleton />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-[284px] w-full rounded-card sm:h-[252px] lg:h-[276px]" />
        <Skeleton className="h-[308px] w-full rounded-card sm:h-[256px] lg:h-[276px]" />
        <Skeleton className="h-[757px] w-full rounded-card sm:h-[429px] lg:h-[838px]" />
        <Skeleton className="h-[1179px] w-full rounded-card sm:h-[780px] lg:h-[838px]" />
      </div>
      <Skeleton className="h-[1958px] w-full rounded-card sm:h-[1590px] lg:h-[829px]" />
    </div>
  )
}

/**
 * Admin → Backup do banco (rota `/admin/backups`). ADMIN-ONLY: o guarda de papel mora na ROTA (`RequireAuth roles=["ADMIN"]`) e o servidor confere de novo (403 `FORBIDDEN`). Rota lazy.
 *
 * Organização do InnoChat: cabeçalho com a ação "Fazer backup agora" e um "ⓘ", faixa de estado, grade de 4 cartões (Chave, Conferir, Agendamento, Destino, cada um com "ⓘ") e o histórico
 * como cartão largo; o aviso do JWT_SECRET e a nota "restaurar não tem botão" ficam no rodapé.
 *
 * Estado: o servidor é a fonte da verdade (`useQuery`); o que a pessoa edita é um RASCUNHO de sobreposições (`BackupDraft`) por cima do DTO carregado, não uma cópia dele, então não há
 * efeito sincronizando estado a partir de dado assíncrono. O rascunho mora aqui (e não no editor) porque o botão do cabeçalho precisa saber se há alteração não salva (as ações usam a
 * configuração SALVA). Cada cartão de configuração salva só o seu pedaço (`BackupScope`); segredos só existem no rascunho enquanto a pessoa os digita e morrem junto com ele depois do PUT
 * (e a mutation é zerada: `gcTime: 0` + `reset()`). A chave do backup e o estado das execuções têm componentes e consultas próprios (não passam pelo rascunho).
 */
export default function BackupsPage() {
  const { data: dto, isLoading, isError, error, refetch } = useBackupConfig()
  const forbidden = getApiErrorStatus(error) === 403
  const [draft, setDraft] = useState<BackupDraft>(EMPTY_DRAFT)
  const [helpOpen, setHelpOpen] = useState(false)
  const helpId = useId()

  const dirty = dto ? hasChanges(buildUpdatePayload(dto, draft)) : false
  const actions = useBackupActions(dto, dirty)
  const runReason = actions.reasons.run

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <PageHeader
          title={PAGE_TITLE}
          description={PAGE_DESCRIPTION}
          icon={DatabaseBackup}
          actions={
            <>
              {dto ? (
                <Button
                  type="button"
                  size="touch"
                  onClick={() => void actions.start("run")}
                  loading={actions.pending.run}
                  disabled={runReason !== null}
                  aria-describedby="backup-run-reason"
                  data-testid="action-run"
                >
                  {!actions.pending.run && <DatabaseBackup className="h-4 w-4" aria-hidden="true" />}
                  Fazer backup agora
                </Button>
              ) : (
                isLoading && <Skeleton className="h-11 w-44 rounded-[var(--field-radius)] sm:h-10" />
              )}
              <HelpToggle open={helpOpen} onToggle={() => setHelpOpen((v) => !v)} panelId={helpId} label="Backup do banco" testId="page-help" />
            </>
          }
        />
        <HelpPanel id={helpId} open={helpOpen} testId="page-help-panel">
          <p>
            Esta tela cuida da cópia de segurança do banco de dados. O sistema copia o banco, cifra o arquivo com a chave do backup e envia para um destino fora do servidor (Google Drive ou armazenamento S3). Se passar do prazo sem cópia nova, o dono
            é avisado e a situação fica “Atrasado”.
          </p>
          <p>
            “Fazer backup agora” roda uma cópia na hora, em segundo plano: a tela acompanha sozinha e mostra o resultado. Sem destino escolhido ele só testa o pg_dump (copia, confere e descarta), o que NÃO conta como backup. Os botões desabilitados sempre
            dizem o motivo.
          </p>
          <p>Cada cartão tem o seu “ⓘ” com a explicação do que faz. Chave, destino, credenciais e “ligar o automático” pedem a sua senha atual ao salvar.</p>
        </HelpPanel>
        <p id="backup-run-reason" className="text-xs font-medium text-ink-soft" data-testid="reason-run" hidden={runReason === null}>
          {runReason}
        </p>
        <ActionFeedback actions={actions} kind="run" />
      </div>

      <GoogleReturnBanner />

      {isLoading && <BackupSkeleton />}

      {!isLoading && isError && !dto && (
        <ErrorState message={forbidden ? "Somente administradores podem ver e alterar os backups." : parseBackupError(error).message} onRetry={forbidden ? undefined : () => void refetch()} />
      )}

      {dto && <BackupEditor dto={dto} draft={draft} setDraft={setDraft} actions={actions} />}
    </div>
  )
}

/** Tudo o que a pessoa vê de um escopo (um cartão de configuração): o que muda, os erros dos campos, e se pede senha. Calculado do rascunho SÓ daquele escopo. */
function viewOf(dto: BackupConfigDTO, draft: BackupDraft, scope: BackupScope, serverErrors: DraftErrors) {
  const scoped = scopeDraft(draft, scope)
  const payload = buildUpdatePayload(dto, scoped)
  const errors = validateDraft(dto, scoped)
  return {
    payload,
    changes: describeChanges(dto, payload),
    errors: { ...serverErrors, ...errors } as DraftErrors,
    errorCount: Object.keys(errors).length,
    dirty: hasChanges(payload),
    touched: draftTouched(scoped),
    needsPassword: exigeSenha(payload),
  }
}

/** A grade de cartões e o histórico. Só existe com o DTO carregado. Devolve os blocos como irmãos, para herdarem o `space-y-6` da página. */
function BackupEditor({ dto, draft, setDraft, actions }: { dto: BackupConfigDTO; draft: BackupDraft; setDraft: (update: (prev: BackupDraft) => BackupDraft) => void; actions: BackupActions }) {
  const mutation = useUpdateBackupConfig()

  // Qual cartão tem o diálogo de senha aberto / qual está salvando agora (o diálogo mostra o "carregando" dele; o botão do cartão só quando não há diálogo).
  const [saveDialog, setSaveDialog] = useState<BackupScope | null>(null)
  const [savingScope, setSavingScope] = useState<BackupScope | null>(null)
  const [saveError, setSaveError] = useState<{ scope: BackupScope; error: BackupError } | null>(null)
  // 403 INVALID_CURRENT_PASSWORD: o erro vive no diálogo de salvar (que continua aberto), não no alerta do cartão.
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

  const views = { schedule: viewOf(dto, draft, "schedule", serverErrors), destination: viewOf(dto, draft, "destination", serverErrors) }

  const discard = (scope: BackupScope) => {
    setDraft((prev) => clearDraftScope(prev, scope))
    setSaveError((current) => (current?.scope === scope ? null : current))
    setServerErrors({})
  }

  const closeSaveDialog = () => {
    setSaveDialog(null)
    setPasswordError(null)
  }

  const handleSave = async (scope: BackupScope, currentPassword?: string) => {
    const view = views[scope]
    if (!view.dirty || mutation.isPending) return
    setSaveError(null)
    setPasswordError(null)
    setSavingScope(scope)
    try {
      await mutation.mutateAsync(currentPassword ? withCurrentPassword(view.payload, currentPassword) : view.payload)
      // Segredos digitados morrem aqui: o rascunho DESTE cartão é descartado (o DTO novo já está no cache); o outro cartão segue como estava.
      setDraft((prev) => clearDraftScope(prev, scope))
      setServerErrors({})
      closeSaveDialog()
      toast.success(scope === "schedule" ? "Agendamento do backup salvo." : "Destino do backup salvo.")
    } catch (err) {
      const parsed = parseBackupError(err)
      if (parsed.code === "INVALID_CURRENT_PASSWORD") {
        // Senha errada: o diálogo fica aberto com o erro; o rascunho (e a sessão: é 403, não 401) seguem intactos.
        setPasswordError(parsed.message)
      } else {
        closeSaveDialog()
        setSaveError({ scope, error: parsed })
        setServerErrors(Object.fromEntries(parsed.fields.map((field) => [field, parsed.message])))
      }
    } finally {
      // O corpo do PUT carrega credenciais do bucket, o Client Secret e a senha atual: `mutation.variables` não pode ficar na memória até o próximo envio.
      mutation.reset()
      setSavingScope(null)
    }
  }

  const requestSave = (scope: BackupScope) => {
    setSaveError(null)
    setPasswordError(null)
    if (views[scope].needsPassword) setSaveDialog(scope)
    else void handleSave(scope)
  }

  const cardSave = (scope: BackupScope) => ({
    count: views[scope].changes.length,
    errorCount: views[scope].errorCount,
    needsPassword: views[scope].needsPassword,
    canSave: views[scope].dirty && views[scope].errorCount === 0 && !mutation.isPending,
    canDiscard: (views[scope].dirty || views[scope].touched) && !mutation.isPending,
    loading: mutation.isPending && savingScope === scope && saveDialog === null,
    onSave: () => requestSave(scope),
    onDiscard: () => discard(scope),
  })

  const errorAlert = (scope: BackupScope) =>
    saveError?.scope === scope ? (
      <Alert ref={errorRef} tone="danger" role="alert" icon={TriangleAlert} data-testid="save-error" data-code={saveError.error.code}>
        <p className="font-semibold">{saveError.error.message}</p>
        {saveError.error.draftKept && <p className="mt-1 text-xs font-medium">O que você preencheu continua na tela.</p>}
      </Alert>
    ) : null

  const dialogScope = saveDialog && views[saveDialog].dirty ? saveDialog : null
  const dialogView = dialogScope ? views[dialogScope] : null
  const reducesRetention = dialogView?.payload.retentionCount !== undefined && dialogView.payload.retentionCount < dto.retentionCount

  return (
    <>
      {!dto.secretsKeyConfigured && <SecretsKeyMissingAlert />}
      {dto.secretsKeyConfigured && !dto.secretsReadable && <SecretsUnreadableAlert />}

      <StatusSection enabled={dto.enabled} />

      <div className="grid gap-6 lg:grid-cols-2">
        <KeySection dto={dto} disabled={mutation.isPending} />
        <VerifySection actions={actions} />
        <ScheduleSection dto={dto} draft={draft} errors={views.schedule.errors} onChange={patchSchedule} disabled={mutation.isPending} save={cardSave("schedule")} error={errorAlert("schedule")} />
        <DestinationSection
          dto={dto}
          draft={draft}
          errors={views.destination.errors}
          onChange={patchDestination}
          onMarkClear={markClear}
          disabled={mutation.isPending}
          dirty={views.destination.dirty}
          actions={actions}
          save={cardSave("destination")}
          error={errorAlert("destination")}
        />
      </div>

      {dialogScope && dialogView && (
        <ConfirmSaveDialog
          title="Confirmar alterações no backup"
          description="Revise o que será enviado ao servidor. Chaves, segredos e senhas nunca são exibidos."
          passwordHint="Pedida em toda alteração que muda para onde o backup vai, com que credencial, quantas cópias ficam ou que liga o automático."
          items={dialogView.changes}
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
          onConfirm={(currentPassword) => void handleSave(dialogScope, currentPassword)}
        />
      )}

      <HistorySection />

      <div className="space-y-4">
        <SecretsKeyPermanentNotice />
        <RestoreNotice />
      </div>
    </>
  )
}
