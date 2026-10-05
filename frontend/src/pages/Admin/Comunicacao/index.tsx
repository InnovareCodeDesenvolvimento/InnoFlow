import { useEffect, useRef, useState } from "react"
import { BellRing, RotateCcw, Save, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/painel/PageHeader"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { ConfirmSaveDialog } from "@/components/admin/ConfirmSaveDialog"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Card, CardContent } from "@/components/ui/Card"
import { Skeleton } from "@/components/ui/Skeleton"
import { useCommunicationSettings, useUpdateCommunicationSettings } from "@/hooks/useCommunicationSettings"
import {
  CHANNEL_NAMES,
  EMPTY_DRAFT,
  buildUpdatePayload,
  describeChanges,
  draftTouched,
  hasChanges,
  parseCommunicationError,
  validateDraft,
  withCurrentPassword,
  type CommunicationDraft,
  type CommunicationError,
  type DraftErrors,
  type EmailDraft,
  type WhatsappDraft,
} from "@/lib/communicationSettings"
import { cn } from "@/lib/utils"
import { getApiErrorStatus } from "@/services/api"
import type { CommunicationSettingsDTO } from "@/types/api"
import { AlertsSection } from "./AlertsSection"
import { EmailSection } from "./EmailSection"
import { PrivateHostsNote, SecretsKeyMissingAlert, SourceBanner, UnreadableSecretsAlert, WarningsAlert } from "./StatusBanners"
import { WhatsappSection } from "./WhatsappSection"

/** Esqueleto com a FORMA da tela pronta (banner de origem, e-mail, WhatsApp, alertas): evita salto de layout quando os dados chegam. Alturas MEDIDAS no cartão real (persona "pronta"): 375 px = 1525/1232/677; de 640 px para cima = 960/815/445. */
function CommunicationSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando configuração de comunicação">
      <Skeleton className="h-14 w-full rounded-xl" />
      <Skeleton className="h-[1525px] w-full rounded-card sm:h-[960px]" />
      <Skeleton className="h-[1232px] w-full rounded-card sm:h-[815px]" />
      <Skeleton className="h-[677px] w-full rounded-card sm:h-[445px]" />
    </div>
  )
}

const PAGE_TITLE = "Comunicação"
const PAGE_DESCRIPTION = "Avisos ao dono por e-mail (SMTP) e WhatsApp (Evolution API): servidor, destinatários e quais alertas enviar."

/**
 * Admin → Comunicação (N-7). ADMIN-ONLY: o guarda de papel mora na ROTA (`RequireAuth roles=["ADMIN"]`) e o servidor confere de novo (403 `FORBIDDEN`).
 *
 * Estado: o servidor é a fonte da verdade (`useQuery`); o que o admin edita é um RASCUNHO de sobreposições (`CommunicationDraft`) por cima do DTO carregado — não uma
 * cópia dele, então não há efeito sincronizando estado a partir de dado assíncrono. Salvar envia só o diff; segredos só existem no rascunho enquanto o admin os
 * digita e morrem junto com ele depois do PUT (e a mutation é zerada: `gcTime: 0` + `reset()`).
 */
export default function ComunicacaoPage() {
  const { data: dto, isLoading, isError, error, refetch } = useCommunicationSettings()
  const forbidden = getApiErrorStatus(error) === 403

  return (
    <div className="space-y-6">
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} icon={BellRing} />

      {isLoading && <CommunicationSkeleton />}

      {!isLoading && (isError || !dto) && (
        <ErrorState
          message={forbidden ? "Somente administradores podem ver e alterar a comunicação." : parseCommunicationError(error).message}
          onRetry={forbidden ? undefined : () => void refetch()}
        />
      )}

      {!isLoading && !isError && dto && <CommunicationEditor dto={dto} />}
    </div>
  )
}

/** O formulário em si. Só existe com o DTO carregado (o rascunho nasce vazio junto com ele) e devolve os blocos como irmãos, para herdarem o `space-y-6` da página. */
function CommunicationEditor({ dto }: { dto: CommunicationSettingsDTO }) {
  const mutation = useUpdateCommunicationSettings()

  const [draft, setDraft] = useState<CommunicationDraft>(EMPTY_DRAFT)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveError, setSaveError] = useState<CommunicationError | null>(null)
  // 403 INVALID_CURRENT_PASSWORD: o erro vive no diálogo de salvar (que continua aberto), não no alerta da página.
  const [passwordError, setPasswordError] = useState<string | null>(null)
  // Erros que o SERVIDOR apontou num campo (destino proibido, segredo a redigitar): somem na próxima edição.
  const [serverErrors, setServerErrors] = useState<DraftErrors>({})
  // Erros de campo do último "Testar" (ex.: trocou o servidor e não digitou a senha de novo): idem.
  const [testErrors, setTestErrors] = useState<DraftErrors>({})
  const errorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (saveError) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [saveError])

  const edited = () => {
    setServerErrors({})
    setTestErrors({})
  }
  const patchEmail = (patch: Partial<EmailDraft>) => {
    edited()
    setDraft((prev) => ({ ...prev, email: { ...prev.email, ...patch }, clear: patch.password !== undefined ? { ...prev.clear, smtpPassword: false } : prev.clear }))
  }
  const patchWhatsapp = (patch: Partial<WhatsappDraft>) => {
    edited()
    setDraft((prev) => ({ ...prev, whatsapp: { ...prev.whatsapp, ...patch }, clear: patch.apiKey !== undefined ? { ...prev.clear, evolutionApiKey: false } : prev.clear }))
  }
  const markClear = (key: "smtpPassword" | "evolutionApiKey", marked: boolean) => {
    edited()
    setDraft((prev) => ({
      ...prev,
      clear: { ...prev.clear, [key]: marked },
      // Apagar o segredo e digitar um novo no mesmo envio não faz sentido: marcar descarta o que foi digitado.
      email: marked && key === "smtpPassword" ? { ...prev.email, password: undefined } : prev.email,
      whatsapp: marked && key === "evolutionApiKey" ? { ...prev.whatsapp, apiKey: undefined } : prev.whatsapp,
    }))
  }

  const payload = buildUpdatePayload(dto, draft)
  const changes = describeChanges(dto, payload)
  const errors = validateDraft(dto, draft)
  const fieldErrors: DraftErrors = { ...serverErrors, ...testErrors, ...errors }
  const dirty = hasChanges(payload)
  const errorCount = Object.keys(errors).length
  const canSave = dirty && errorCount === 0 && !mutation.isPending

  const handleDiscard = () => {
    setDraft(EMPTY_DRAFT)
    setSaveError(null)
    setServerErrors({})
    setTestErrors({})
  }

  const closeSaveDialog = () => {
    setSaveDialogOpen(false)
    setPasswordError(null)
  }

  const handleSave = async (currentPassword: string) => {
    if (!dirty || mutation.isPending) return
    setSaveError(null)
    setPasswordError(null)
    try {
      await mutation.mutateAsync(withCurrentPassword(payload, currentPassword))
      // Segredos digitados morrem aqui: o rascunho inteiro é descartado (o DTO novo já está no cache).
      setDraft(EMPTY_DRAFT)
      setServerErrors({})
      setTestErrors({})
      closeSaveDialog()
      toast.success("Configuração de comunicação salva.")
    } catch (err) {
      const parsed = parseCommunicationError(err)
      if (parsed.code === "INVALID_CURRENT_PASSWORD") {
        // Senha errada: o diálogo fica aberto com o erro; o rascunho (e a sessão — é 403, não 401) seguem intactos.
        setPasswordError(parsed.message)
      } else {
        closeSaveDialog()
        setSaveError(parsed)
        setServerErrors(Object.fromEntries(parsed.fields.map((field) => [field, parsed.message])))
      }
    } finally {
      // O corpo do PUT carrega senha SMTP, apikey e a senha atual: `mutation.variables` não pode ficar na memória até o próximo envio.
      mutation.reset()
    }
  }

  return (
    <>
      {!dto.secretsKeyConfigured && <SecretsKeyMissingAlert />}
      {dto.secretsDecryptable === false && <UnreadableSecretsAlert />}
      <WarningsAlert warnings={dto.warnings} />

      <SourceBanner source={dto.source} updatedAt={dto.updatedAt} />
      {dto.privateHostsAllowed && <PrivateHostsNote />}

      {saveError && (
        <Alert ref={errorRef} tone="danger" role="alert" icon={TriangleAlert} data-testid="save-error" data-code={saveError.code}>
          <p className="font-semibold">{saveError.message}</p>
          {saveError.problems.some((p) => p.problems.length > 0) && (
            <div className="mt-3 rounded-lg bg-surface p-3 text-ink" data-testid="save-error-problems">
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-softer">O que falta</p>
              <ul className="space-y-2 text-sm">
                {saveError.problems.map((p) => (
                  <li key={p.channel}>
                    <span className="font-semibold">{CHANNEL_NAMES[p.channel]}</span>
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                      {p.problems.map((problem, i) => (
                        <li key={`${i}-${problem}`}>{problem}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {saveError.draftKept && <p className="mt-1 text-xs font-medium">O que você preencheu continua na tela.</p>}
        </Alert>
      )}

      <EmailSection
        dto={dto}
        draft={draft.email}
        clearPassword={Boolean(draft.clear.smtpPassword)}
        errors={fieldErrors}
        onChange={patchEmail}
        onClearPassword={(marked) => markClear("smtpPassword", marked)}
        onTestFieldErrors={setTestErrors}
        disabled={mutation.isPending}
      />

      <WhatsappSection
        dto={dto}
        draft={draft.whatsapp}
        clearApiKey={Boolean(draft.clear.evolutionApiKey)}
        errors={fieldErrors}
        onChange={patchWhatsapp}
        onClearApiKey={(marked) => markClear("evolutionApiKey", marked)}
        onTestFieldErrors={setTestErrors}
        disabled={mutation.isPending}
      />

      <AlertsSection
        dto={dto}
        draft={draft}
        errors={fieldErrors}
        onChangeEmail={(value) => patchEmail({ minSeverity: value })}
        onChangeWhatsapp={(value) => patchWhatsapp({ minSeverity: value })}
        onChangeDedupe={(value) => {
          edited()
          setDraft((prev) => ({ ...prev, alerts: { dedupeMinutes: value } }))
        }}
      />

      {/* Barra de salvar: um card como os outros (mesmo padrão do gateway). Com alteração pendente ela gruda no fim da área de rolagem do shell (o <main> do admin); sem alteração fica no fim da página, sem tapar conteúdo. */}
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
            <p className="text-xs text-ink-softer" data-testid="save-bar-propagation">
              Depois de salvar, a mudança vale na API na hora e nos outros serviços em até 1 minuto.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button type="button" variant="outline" size="touch" onClick={handleDiscard} disabled={(!dirty && !draftTouched(draft)) || mutation.isPending}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Descartar
            </Button>
            <Button
              type="button"
              size="touch"
              onClick={() => {
                setSaveError(null)
                setPasswordError(null)
                setSaveDialogOpen(true)
              }}
              disabled={!canSave}
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              Salvar alterações
            </Button>
          </div>
        </CardContent>
      </Card>

      {saveDialogOpen && dirty && (
        <ConfirmSaveDialog
          title="Confirmar alterações na comunicação"
          description="Revise o que será enviado ao servidor. Senha e apikey nunca são exibidas."
          passwordHint="Pedida em toda alteração, para que só quem conhece a senha possa mudar para onde os avisos do sistema vão."
          items={changes}
          loading={mutation.isPending}
          passwordError={passwordError}
          onCancel={closeSaveDialog}
          onConfirm={(currentPassword) => void handleSave(currentPassword)}
        />
      )}
    </>
  )
}
