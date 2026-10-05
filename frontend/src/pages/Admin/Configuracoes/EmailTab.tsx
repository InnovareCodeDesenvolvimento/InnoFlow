import { Mail } from "lucide-react"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Skeleton } from "@/components/ui/Skeleton"
import { SecretControl } from "@/components/admin/SecretControl"
import { formatFrom } from "@/lib/communicationSettings"
import type { CommunicationSettingsDTO } from "@/types/api"
import { ChannelHeader, EnabledRow } from "./ChannelParts"
import { DomainCheckPanel } from "./DomainCheckPanel"
import { EmailTestBox } from "./EmailTestBox"
import { PrivateHostsNote, SecretsKeyMissingAlert, SourceEnvBanner, UnreadableSecretsAlert, WarningsAlert } from "./StatusBanners"
import { SaveDialog, SaveErrorAlert, SaveFooter } from "./SaveParts"
import { SmtpConnectionTest } from "./SmtpConnectionTest"
import { CommunicationTabLoader } from "./TabLoader"
import { useCommunicationEditor } from "./useCommunicationEditor"

/** Esqueleto com a FORMA da aba pronta (cartão do SMTP com o teste de e-mail + cartão do domínio): evita salto de layout quando os dados chegam. Alturas MEDIDAS na persona "pronta": 375 px = 1554/422, de 640 px = 1097/270, a 1440 px (lg) = 1029/234. */
function EmailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando configuração de e-mail">
      <Skeleton className="h-[1554px] w-full rounded-card sm:h-[1097px] lg:h-[1029px]" />
      <Skeleton className="h-[422px] w-full rounded-card sm:h-[270px] lg:h-[234px]" />
    </div>
  )
}

/** Aba E-mail: servidor SMTP, teste de conexão, remetente e e-mail de teste. Destinatários dos avisos e severidade moram na aba Alertas. */
export default function EmailTab() {
  return <CommunicationTabLoader skeleton={<EmailSkeleton />}>{(dto) => <EmailEditor dto={dto} />}</CommunicationTabLoader>
}

function EmailEditor({ dto }: { dto: CommunicationSettingsDTO }) {
  const editor = useCommunicationEditor(dto, "email")
  const { draft, fieldErrors } = editor
  const email = dto.email
  const e = draft.email

  const enabled = e.enabled ?? email.enabled
  const host = e.host ?? email.host ?? ""
  const port = e.port ?? (email.port !== null ? String(email.port) : "")
  const secure = e.secure ?? email.secure
  const user = e.user ?? email.user ?? ""
  const from = e.from ?? formatFrom(email.fromName, email.fromAddress)
  const keep = (value: string | undefined, saved: string | null) => (value?.trim() === "" && saved ? "Em branco, o valor atual é mantido." : undefined)

  return (
    <div className="space-y-6">
      {!dto.secretsKeyConfigured && <SecretsKeyMissingAlert />}
      {dto.secretsDecryptable === false && <UnreadableSecretsAlert />}
      <WarningsAlert warnings={dto.warnings} />
      {dto.source === "env" && <SourceEnvBanner />}
      {dto.privateHostsAllowed && <PrivateHostsNote />}
      <SaveErrorAlert editor={editor} />

      <Card data-testid="section-email">
        <ChannelHeader icon={Mail} title="E-mail transacional (SMTP)" description="Usado para lembretes e notificações por e-mail." testId="email" state={email} />
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (editor.canSave) editor.openSaveDialog()
          }}
        >
          <CardContent className="space-y-4 pt-3 sm:pt-3">
            <EnabledRow
              id="email"
              name="o e-mail"
              enabled={enabled}
              onChange={(value) => editor.patchEmail({ enabled: value })}
              disabled={editor.saving}
              help="Desligado: nenhum e-mail sai (nem lembretes ao motorista, nem avisos ao dono). Desligar nunca apaga a configuração."
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Servidor SMTP"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                placeholder="smtp.exemplo.com"
                value={host}
                onChange={(ev) => editor.patchEmail({ host: ev.target.value })}
                error={fieldErrors["email.host"]}
                hint={keep(e.host, email.host)}
                data-testid="email-host"
              />
              <Input
                label="Porta"
                autoComplete="off"
                inputMode="numeric"
                placeholder="587"
                value={port}
                onChange={(ev) => editor.patchEmail({ port: ev.target.value })}
                error={fieldErrors["email.port"]}
                hint={keep(e.port, email.port !== null ? String(email.port) : null)}
                data-testid="email-port"
              />
            </div>

            <div className="space-y-1">
              <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={secure}
                  onChange={(ev) => editor.patchEmail({ secure: ev.target.checked })}
                  className="h-5 w-5 shrink-0 rounded border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                  data-testid="email-secure"
                />
                Conexão segura (TLS/SSL)
              </label>
              <p className="text-xs text-ink-softer">Marque para TLS direto (porta 465). Desmarcado, usa STARTTLS (porta 587).</p>
            </div>

            <Input
              label="Usuário SMTP"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={user}
              onChange={(ev) => editor.patchEmail({ user: ev.target.value })}
              error={fieldErrors["email.user"]}
              data-testid="email-user"
            />

            <SecretControl
              testId="secret-smtpPassword"
              name="Senha SMTP"
              removeLabel="Apagar a senha SMTP salva"
              isSet={email.passwordSet}
              unreadable={dto.secretsDecryptable === false}
              value={e.password}
              onChange={(value) => editor.patchEmail({ password: value })}
              markedForRemoval={Boolean(draft.clear.smtpPassword)}
              onMarkRemoval={(marked) => editor.markClear("smtpPassword", marked)}
              error={fieldErrors["email.password"]}
              hint={`${email.passwordSet ? "" : "Nenhuma senha configurada ainda. "}Guardada cifrada no servidor; nunca volta para esta tela.`}
              setHint="Senha configurada. Deixe em branco para manter."
            />

            <Input
              label="Remetente"
              type="text"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="InnoFlow <no-reply@seudominio.com.br>"
              value={from}
              onChange={(ev) => editor.patchEmail({ from: ev.target.value })}
              error={fieldErrors["email.from"]}
              hint={
                keep(e.from, email.fromAddress) ??
                "Como aparece na caixa de entrada. Ex.: InnoFlow <no-reply@seudominio.com.br>. Se puser só o e-mail, o nome InnoFlow entra no lugar."
              }
              data-testid="email-from"
            />

            <SmtpConnectionTest dto={dto} draft={e} errors={fieldErrors} onFieldErrors={editor.setTestErrors} />
          </CardContent>
          <SaveFooter editor={editor} updatedAt={dto.updatedAt} />
        </form>
        <EmailTestBox dto={dto} hasUnsaved={editor.dirty} />
      </Card>

      <DomainCheckPanel dto={dto} />

      <SaveDialog editor={editor} title="Confirmar alterações na comunicação" />
    </div>
  )
}
