import { Mail } from "lucide-react"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { useTestEmail } from "@/hooks/useCommunicationSettings"
import {
  MAX_RECIPIENTS,
  SECURE_LABELS,
  emailTestUsesDraft,
  planEmailTest,
  recipientsToText,
  type DraftErrors,
  type EmailDraft,
} from "@/lib/communicationSettings"
import type { CommunicationSettingsDTO } from "@/types/api"
import { ChannelHeader, EnabledRow } from "./ChannelParts"
import { ChannelTestPanel } from "./ChannelTestPanel"
import { RecipientsField } from "./RecipientsField"
import { SecretControl } from "./SecretControl"

const SECURE_OPTIONS = [
  { value: "false", label: SECURE_LABELS.false },
  { value: "true", label: SECURE_LABELS.true },
]

/**
 * Canal de e-mail (SMTP). Valores efetivos = rascunho sobre o DTO; campo de texto em branco = "manter o valor atual". A senha é só de escrita (`SecretControl`).
 * O teste usa a config salva, ou, se o rascunho mexeu em conexão/remetente, os valores digitados (sem gravar).
 */
export function EmailSection({
  dto,
  draft,
  clearPassword,
  errors,
  onChange,
  onClearPassword,
  onTestFieldErrors,
  disabled,
}: {
  dto: CommunicationSettingsDTO
  draft: EmailDraft
  clearPassword: boolean
  errors: DraftErrors
  onChange: (patch: Partial<EmailDraft>) => void
  onClearPassword: (marked: boolean) => void
  onTestFieldErrors: (errors: DraftErrors) => void
  disabled: boolean
}) {
  const email = dto.email
  const test = useTestEmail()
  const enabled = draft.enabled ?? email.enabled
  const host = draft.host ?? email.host ?? ""
  const port = draft.port ?? (email.port !== null ? String(email.port) : "")
  const secure = draft.secure ?? email.secure
  const user = draft.user ?? email.user ?? ""
  const fromName = draft.fromName ?? email.fromName ?? ""
  const fromAddress = draft.fromAddress ?? email.fromAddress ?? ""
  const recipients = draft.recipients ?? recipientsToText(email.recipients)
  const keep = (value: string | undefined, saved: string | null) => (value?.trim() === "" && saved ? "Em branco, o valor atual é mantido." : undefined)

  return (
    <Card data-testid="section-email">
      <ChannelHeader icon={Mail} title="E-mail (SMTP)" testId="email" state={email} />
      <CardContent className="space-y-5">
        <EnabledRow
          id="email"
          name="o e-mail"
          enabled={enabled}
          onChange={(value) => onChange({ enabled: value })}
          disabled={disabled}
          help="Desligado: nenhum aviso sai por e-mail. Para ligar, o canal precisa ter servidor, remetente e ao menos um destinatário. Desligar nunca apaga a configuração."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Servidor SMTP"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            placeholder="smtp.seudominio.com.br"
            value={host}
            onChange={(e) => onChange({ host: e.target.value })}
            error={errors["email.host"]}
            hint={keep(draft.host, email.host) ?? "Só o endereço (nome ou IP), sem http:// nem porta."}
            data-testid="email-host"
          />
          <Input
            label="Porta"
            autoComplete="off"
            inputMode="numeric"
            placeholder="587"
            value={port}
            onChange={(e) => onChange({ port: e.target.value })}
            error={errors["email.port"]}
            hint={keep(draft.port, email.port !== null ? String(email.port) : null) ?? "587 (STARTTLS) ou 465 (TLS direto)."}
            data-testid="email-port"
          />
          <Select
            label="Conexão segura"
            value={String(secure)}
            onChange={(e) => onChange({ secure: e.target.value === "true" })}
            options={SECURE_OPTIONS}
            data-testid="email-secure"
          />
          <Input
            label="Usuário"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="alertas@seudominio.com.br"
            value={user}
            onChange={(e) => onChange({ user: e.target.value })}
            error={errors["email.user"]}
            hint="Em branco, o servidor é acessado sem login."
            data-testid="email-user"
          />
        </div>

        <SecretControl
          testId="secret-smtpPassword"
          name="Senha SMTP"
          removeLabel="Apagar a senha SMTP salva"
          isSet={email.passwordSet}
          unreadable={dto.secretsDecryptable === false}
          value={draft.password}
          onChange={(value) => onChange({ password: value })}
          markedForRemoval={clearPassword}
          onMarkRemoval={onClearPassword}
          error={errors["email.password"]}
          hint="Guardada cifrada no servidor; nunca volta para esta tela."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Nome do remetente"
            autoComplete="off"
            placeholder="InnoFlow"
            value={fromName}
            onChange={(e) => onChange({ fromName: e.target.value })}
            error={errors["email.fromName"]}
            hint="Opcional. Como o nome aparece na caixa de entrada."
            data-testid="email-fromName"
          />
          <Input
            label="E-mail do remetente"
            type="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="alertas@seudominio.com.br"
            value={fromAddress}
            onChange={(e) => onChange({ fromAddress: e.target.value })}
            error={errors["email.fromAddress"]}
            hint={keep(draft.fromAddress, email.fromAddress) ?? "Alguns provedores só aceitam o e-mail do próprio usuário."}
            data-testid="email-fromAddress"
          />
        </div>

        <RecipientsField
          label="Destinatários dos avisos"
          value={recipients}
          onChange={(value) => onChange({ recipients: value })}
          error={errors["email.recipients"]}
          hint={`Um e-mail por linha (até ${MAX_RECIPIENTS}). A lista inteira é substituída ao salvar.`}
          placeholder="dono@seudominio.com.br"
          inputMode="email"
          testId="email-recipients"
        />

        <ChannelTestPanel
          testId="email-test"
          channelLabel="e-mail"
          buttonLabel="Enviar e-mail de teste"
          toLabel="Enviar o teste para"
          toPlaceholder="Em branco: o 1º destinatário"
          toHint="Opcional. Padrão: o primeiro destinatário da lista."
          inputMode="email"
          usesUnsaved={emailTestUsesDraft(draft)}
          plan={(toText) => planEmailTest(dto, draft, toText, errors)}
          mutation={test}
          onFieldErrors={onTestFieldErrors}
        />
      </CardContent>
    </Card>
  )
}
