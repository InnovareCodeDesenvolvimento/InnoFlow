import { MessageCircle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { useTestWhatsapp } from "@/hooks/useCommunicationSettings"
import {
  MAX_RECIPIENTS,
  formatApiKeyHint,
  planWhatsappTest,
  recipientsToText,
  whatsappTestUsesDraft,
  type DraftErrors,
  type WhatsappDraft,
} from "@/lib/communicationSettings"
import type { CommunicationSettingsDTO } from "@/types/api"
import { ChannelHeader, EnabledRow } from "./ChannelParts"
import { ChannelTestPanel } from "./ChannelTestPanel"
import { RecipientsField } from "./RecipientsField"
import { SecretControl } from "@/components/admin/SecretControl"

const VERSION_OPTIONS = [
  { value: "2", label: "Versão 2 (atual)" },
  { value: "1", label: "Versão 1" },
]

/**
 * Canal de WhatsApp (Evolution API). Mesma mecânica do e-mail: rascunho sobre o DTO, branco = manter, apikey só de escrita (com a dica dos 4 últimos caracteres
 * do que está salvo) e teste com os valores digitados, sem gravar.
 */
export function WhatsappSection({
  dto,
  draft,
  clearApiKey,
  errors,
  onChange,
  onClearApiKey,
  onTestFieldErrors,
  disabled,
}: {
  dto: CommunicationSettingsDTO
  draft: WhatsappDraft
  clearApiKey: boolean
  errors: DraftErrors
  onChange: (patch: Partial<WhatsappDraft>) => void
  onClearApiKey: (marked: boolean) => void
  onTestFieldErrors: (errors: DraftErrors) => void
  disabled: boolean
}) {
  const wa = dto.whatsapp
  const test = useTestWhatsapp()
  const enabled = draft.enabled ?? wa.enabled
  const baseUrl = draft.baseUrl ?? wa.baseUrl ?? ""
  const instance = draft.instance ?? wa.instance ?? ""
  const apiVersion = draft.apiVersion ?? wa.apiVersion
  const recipients = draft.recipients ?? recipientsToText(wa.recipients)
  const keep = (value: string | undefined, saved: string | null) => (value?.trim() === "" && saved ? "Em branco, o valor atual é mantido." : undefined)

  return (
    <Card data-testid="section-whatsapp">
      <ChannelHeader icon={MessageCircle} title="WhatsApp (Evolution API)" testId="whatsapp" state={wa} />
      <CardContent className="space-y-5">
        <EnabledRow
          id="whatsapp"
          name="o WhatsApp"
          enabled={enabled}
          onChange={(value) => onChange({ enabled: value })}
          disabled={disabled}
          help="Desligado: nenhum aviso sai por WhatsApp. Para ligar, o canal precisa ter URL, instância, apikey e ao menos um número. Desligar nunca apaga a configuração."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="URL da Evolution API"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            placeholder="https://evolution.seudominio.com.br"
            value={baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            error={errors["whatsapp.baseUrl"]}
            hint={keep(draft.baseUrl, wa.baseUrl) ?? "Endereço PÚBLICO, com https://."}
            data-testid="whatsapp-baseUrl"
          />
          <Input
            label="Nome da instância"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="innoflow"
            value={instance}
            onChange={(e) => onChange({ instance: e.target.value })}
            error={errors["whatsapp.instance"]}
            hint={keep(draft.instance, wa.instance) ?? "Letras, números, ponto, hífen e sublinhado."}
            data-testid="whatsapp-instance"
          />
          <Select
            label="Versão da API"
            value={String(apiVersion)}
            onChange={(e) => onChange({ apiVersion: e.target.value === "1" ? 1 : 2 })}
            options={VERSION_OPTIONS}
            data-testid="whatsapp-apiVersion"
          />
        </div>

        <SecretControl
          testId="secret-evolutionApiKey"
          name="Apikey da Evolution"
          removeLabel="Apagar a apikey salva"
          isSet={wa.apiKeySet}
          unreadable={dto.secretsDecryptable === false}
          value={draft.apiKey}
          onChange={(value) => onChange({ apiKey: value })}
          markedForRemoval={clearApiKey}
          onMarkRemoval={onClearApiKey}
          error={errors["whatsapp.apiKey"]}
          hint="Guardada cifrada no servidor; só os 4 últimos caracteres aparecem aqui, para você reconhecer a chave."
          note={formatApiKeyHint(wa.apiKeyHint)}
        />

        <RecipientsField
          label="Números de destino"
          value={recipients}
          onChange={(value) => onChange({ recipients: value })}
          error={errors["whatsapp.recipients"]}
          hint={`Um número por linha (até ${MAX_RECIPIENTS}), com DDI e DDD: 5511999999999. Pode colar com máscara; ela é removida.`}
          placeholder="5511999999999"
          inputMode="tel"
          testId="whatsapp-recipients"
        />

        <ChannelTestPanel
          testId="whatsapp-test"
          channelLabel="WhatsApp"
          buttonLabel="Enviar WhatsApp de teste"
          toLabel="Enviar o teste para"
          toPlaceholder="Em branco: o 1º número"
          toHint="Opcional. Só dígitos, com DDI. Padrão: o primeiro número da lista."
          inputMode="tel"
          usesUnsaved={whatsappTestUsesDraft(draft)}
          plan={(toText) => planWhatsappTest(dto, draft, toText, errors)}
          mutation={test}
          onFieldErrors={onTestFieldErrors}
        />
      </CardContent>
    </Card>
  )
}
