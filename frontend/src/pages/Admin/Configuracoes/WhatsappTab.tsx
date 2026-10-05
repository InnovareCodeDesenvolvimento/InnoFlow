import { MessageCircle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { Skeleton } from "@/components/ui/Skeleton"
import { SecretControl } from "@/components/admin/SecretControl"
import { useTestWhatsapp } from "@/hooks/useCommunicationSettings"
import { MAX_RECIPIENTS, formatApiKeyHint, planWhatsappTest, recipientsToText, whatsappTestUsesDraft } from "@/lib/communicationSettings"
import type { CommunicationSettingsDTO } from "@/types/api"
import { ChannelHeader, EnabledRow } from "./ChannelParts"
import { ChannelTestPanel } from "./ChannelTestPanel"
import { RecipientsField } from "./RecipientsField"
import { PrivateHostsNote, SecretsKeyMissingAlert, SourceEnvBanner, UnreadableSecretsAlert, WarningsAlert } from "./StatusBanners"
import { SaveDialog, SaveErrorAlert, SaveFooter } from "./SaveParts"
import { CommunicationTabLoader } from "./TabLoader"
import { useCommunicationEditor } from "./useCommunicationEditor"

const VERSION_OPTIONS = [
  { value: "2", label: "Versão 2 (atual)" },
  { value: "1", label: "Versão 1" },
]

/** Alturas MEDIDAS no cartão real (persona "pronta"): 375 px = 1532, de 640 px = 993, a 1440 px (lg) = 961. */
function WhatsappSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando configuração de WhatsApp">
      <Skeleton className="h-[1532px] w-full rounded-card sm:h-[993px] lg:h-[961px]" />
    </div>
  )
}

/** Aba WhatsApp: Evolution API (URL, instância, apikey só de escrita, números de destino) e teste. Mesma mecânica do e-mail: rascunho sobre o DTO, branco = manter, teste com os valores digitados sem gravar. */
export default function WhatsappTab() {
  return <CommunicationTabLoader skeleton={<WhatsappSkeleton />}>{(dto) => <WhatsappEditor dto={dto} />}</CommunicationTabLoader>
}

function WhatsappEditor({ dto }: { dto: CommunicationSettingsDTO }) {
  const editor = useCommunicationEditor(dto, "whatsapp")
  const { draft, fieldErrors } = editor
  const wa = dto.whatsapp
  const w = draft.whatsapp
  const test = useTestWhatsapp()
  const enabled = w.enabled ?? wa.enabled
  const baseUrl = w.baseUrl ?? wa.baseUrl ?? ""
  const instance = w.instance ?? wa.instance ?? ""
  const apiVersion = w.apiVersion ?? wa.apiVersion
  const recipients = w.recipients ?? recipientsToText(wa.recipients)
  const keep = (value: string | undefined, saved: string | null) => (value?.trim() === "" && saved ? "Em branco, o valor atual é mantido." : undefined)

  return (
    <div className="space-y-6">
      {!dto.secretsKeyConfigured && <SecretsKeyMissingAlert />}
      {dto.secretsDecryptable === false && <UnreadableSecretsAlert />}
      <WarningsAlert warnings={dto.warnings} />
      {dto.source === "env" && <SourceEnvBanner />}
      {dto.privateHostsAllowed && <PrivateHostsNote />}
      <SaveErrorAlert editor={editor} />

      <Card data-testid="section-whatsapp">
        <ChannelHeader icon={MessageCircle} title="WhatsApp (Evolution API)" description="Usado para os avisos ao dono por WhatsApp." testId="whatsapp" state={wa} />
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (editor.canSave) editor.openSaveDialog()
          }}
        >
          <CardContent className="space-y-5 pt-3 sm:pt-3">
            <EnabledRow
              id="whatsapp"
              name="o WhatsApp"
              enabled={enabled}
              onChange={(value) => editor.patchWhatsapp({ enabled: value })}
              disabled={editor.saving}
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
                onChange={(e) => editor.patchWhatsapp({ baseUrl: e.target.value })}
                error={fieldErrors["whatsapp.baseUrl"]}
                hint={keep(w.baseUrl, wa.baseUrl) ?? "Endereço PÚBLICO, com https://."}
                data-testid="whatsapp-baseUrl"
              />
              <Input
                label="Nome da instância"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="innoflow"
                value={instance}
                onChange={(e) => editor.patchWhatsapp({ instance: e.target.value })}
                error={fieldErrors["whatsapp.instance"]}
                hint={keep(w.instance, wa.instance) ?? "Letras, números, ponto, hífen e sublinhado."}
                data-testid="whatsapp-instance"
              />
              <Select
                label="Versão da API"
                value={String(apiVersion)}
                onChange={(e) => editor.patchWhatsapp({ apiVersion: e.target.value === "1" ? 1 : 2 })}
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
              value={w.apiKey}
              onChange={(value) => editor.patchWhatsapp({ apiKey: value })}
              markedForRemoval={Boolean(draft.clear.evolutionApiKey)}
              onMarkRemoval={(marked) => editor.markClear("evolutionApiKey", marked)}
              error={fieldErrors["whatsapp.apiKey"]}
              hint="Guardada cifrada no servidor; só os 4 últimos caracteres aparecem aqui, para você reconhecer a chave."
              note={formatApiKeyHint(wa.apiKeyHint)}
              setHint="Apikey configurada. Deixe em branco para manter."
            />

            <RecipientsField
              label="Números de destino"
              value={recipients}
              onChange={(value) => editor.patchWhatsapp({ recipients: value })}
              error={fieldErrors["whatsapp.recipients"]}
              hint={`Um número por linha (até ${MAX_RECIPIENTS}), com DDI e DDD: 5511999999999. Pode colar com máscara; ela é removida.`}
              placeholder="5511999999999"
              inputMode="tel"
              testId="whatsapp-recipients"
            />
          </CardContent>
          <SaveFooter editor={editor} updatedAt={dto.updatedAt} />
        </form>
        <div className="px-5 pb-5 sm:px-6 sm:pb-6">
          <ChannelTestPanel
            testId="whatsapp-test"
            channelLabel="WhatsApp"
            buttonLabel="Enviar WhatsApp de teste"
            toLabel="Enviar o teste para"
            toPlaceholder="Em branco: o 1º número"
            toHint="Opcional. Só dígitos, com DDI. Padrão: o primeiro número da lista."
            inputMode="tel"
            usesUnsaved={whatsappTestUsesDraft(w)}
            plan={(toText) => planWhatsappTest(dto, w, toText, fieldErrors)}
            mutation={test}
            onFieldErrors={editor.setTestErrors}
          />
        </div>
      </Card>

      <SaveDialog editor={editor} title="Confirmar alterações na comunicação" />
    </div>
  )
}
