import { useState } from "react"
import { toast } from "sonner"
import { useUpdateCommunicationSettings } from "@/hooks/useCommunicationSettings"
import {
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
import type { CommunicationSettingsDTO } from "@/types/api"
import { useReportDirty } from "./dirtyContext"

/**
 * Estado de edição de uma aba de comunicação (E-mail, WhatsApp, Alertas). O servidor é a fonte da verdade (`dto`, vindo do `useQuery`); o que o admin edita é um RASCUNHO de
 * sobreposições (`CommunicationDraft`) por cima dele, não uma cópia, então não há efeito sincronizando estado a partir de dado assíncrono. Cada aba tem o seu rascunho
 * (trocar de aba o descarta, com aviso na casca). Salvar envia só o diff, com step-up de senha; segredos só existem no rascunho enquanto o admin os digita e morrem junto
 * com ele depois do PUT (a mutation é zerada: `gcTime: 0` + `reset()`).
 */
export function useCommunicationEditor(dto: CommunicationSettingsDTO, tabId: string) {
  const mutation = useUpdateCommunicationSettings()

  const [draft, setDraft] = useState<CommunicationDraft>(EMPTY_DRAFT)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveError, setSaveError] = useState<CommunicationError | null>(null)
  // 403 INVALID_CURRENT_PASSWORD: o erro vive no diálogo de salvar (que continua aberto), não no alerta da página.
  const [passwordError, setPasswordError] = useState<string | null>(null)
  // Erros que o SERVIDOR apontou num campo (destino proibido, segredo a redigitar): somem na próxima edição.
  const [serverErrors, setServerErrors] = useState<DraftErrors>({})
  // Erros de campo do último teste (ex.: trocou o servidor e não digitou a senha de novo): idem.
  const [testErrors, setTestErrors] = useState<DraftErrors>({})

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
  const setDedupe = (value: string) => {
    edited()
    setDraft((prev) => ({ ...prev, alerts: { dedupeMinutes: value } }))
  }

  const payload = buildUpdatePayload(dto, draft)
  const changes = describeChanges(dto, payload)
  const errors = validateDraft(dto, draft)
  const fieldErrors: DraftErrors = { ...serverErrors, ...testErrors, ...errors }
  const dirty = hasChanges(payload)
  const errorCount = Object.keys(errors).length
  const canSave = dirty && errorCount === 0 && !mutation.isPending

  useReportDirty(tabId, dirty)

  const discard = () => {
    setDraft(EMPTY_DRAFT)
    setSaveError(null)
    setServerErrors({})
    setTestErrors({})
  }

  const closeSaveDialog = () => {
    setSaveDialogOpen(false)
    setPasswordError(null)
  }

  const openSaveDialog = () => {
    setSaveError(null)
    setPasswordError(null)
    setSaveDialogOpen(true)
  }

  const save = async (currentPassword: string) => {
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
      toast.success("Configuração salva.")
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

  return {
    draft,
    patchEmail,
    patchWhatsapp,
    markClear,
    setDedupe,
    fieldErrors,
    setTestErrors,
    changes,
    dirty,
    errorCount,
    canSave,
    saving: mutation.isPending,
    touched: draftTouched(draft),
    saveError,
    passwordError,
    saveDialogOpen,
    discard,
    openSaveDialog,
    closeSaveDialog,
    save,
  }
}

export type CommunicationEditor = ReturnType<typeof useCommunicationEditor>
