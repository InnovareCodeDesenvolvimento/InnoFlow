import { Link } from "react-router-dom"
import { BellRing } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { IconBadge } from "@/components/ui/IconBadge"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { Skeleton } from "@/components/ui/Skeleton"
import { DEDUPE_MAX, DEDUPE_MIN, MAX_RECIPIENTS, SEVERITY_LABELS, SEVERITY_ORDER, SEVERITY_SHORT, recipientsToText } from "@/lib/communicationSettings"
import type { CommunicationSettingsDTO, NotificationSeverity } from "@/types/api"
import { RecipientsField } from "./RecipientsField"
import { SaveDialog, SaveErrorAlert, SaveFooter } from "./SaveParts"
import { SecretsKeyMissingAlert, UnreadableSecretsAlert, WarningsAlert } from "./StatusBanners"
import { CommunicationTabLoader } from "./TabLoader"
import { configTabHref } from "./tabs"
import { useCommunicationEditor } from "./useCommunicationEditor"

const SEVERITY_OPTIONS = SEVERITY_ORDER.map((value) => ({ value, label: SEVERITY_LABELS[value] }))

/** Alturas MEDIDAS no cartão real (persona "pronta"): 375 px = 1133, de 640 px = 837, a 1440 px (lg) = 753. */
function AlertasSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando configuração de alertas">
      <Skeleton className="h-[1133px] w-full rounded-card sm:h-[837px] lg:h-[753px]" />
    </div>
  )
}

/**
 * Aba Alertas: quem recebe os avisos ao dono por e-mail, a severidade mínima de cada canal e a janela de repetição (o mesmo alerta, no mesmo contexto, avisa no máximo uma vez por
 * janela). Só leitura: o piso global e o teto por hora, que o servidor impõe por variável de ambiente. Os números de WhatsApp ficam na aba WhatsApp (fazem parte de ligar o canal).
 */
export default function AlertasTab() {
  return <CommunicationTabLoader skeleton={<AlertasSkeleton />}>{(dto) => <AlertasEditor dto={dto} />}</CommunicationTabLoader>
}

function AlertasEditor({ dto }: { dto: CommunicationSettingsDTO }) {
  const editor = useCommunicationEditor(dto, "alertas")
  const { draft, fieldErrors } = editor
  const { alerts } = dto
  const recipients = draft.email.recipients ?? recipientsToText(dto.email.recipients)
  const dedupe = draft.alerts.dedupeMinutes ?? String(alerts.dedupeMinutes)
  const dedupeHint =
    draft.alerts.dedupeMinutes?.trim() === "" && alerts.dedupeSource === "database"
      ? "Em branco, volta ao padrão do servidor."
      : `De ${DEDUPE_MIN} a ${DEDUPE_MAX} minutos. ${alerts.dedupeSource === "database" ? "Valor salvo nesta tela; em branco volta ao padrão do servidor." : "Hoje vale o padrão do servidor."}`
  const whatsappCount = dto.whatsapp.recipients.length

  return (
    <div className="space-y-6">
      {!dto.secretsKeyConfigured && <SecretsKeyMissingAlert />}
      {dto.secretsDecryptable === false && <UnreadableSecretsAlert />}
      <WarningsAlert warnings={dto.warnings} />
      <SaveErrorAlert editor={editor} />

      <Card data-testid="section-alerts">
        <CardHeader className="flex flex-row items-start gap-3">
          <IconBadge icon={BellRing} size="md" tinted />
          <div className="min-w-0">
            <CardTitle as="h2">Avisos ao dono</CardTitle>
            <CardDescription>Quem recebe e quais avisos chegam em cada canal. O mesmo alerta, no mesmo contexto, é avisado no máximo uma vez por janela.</CardDescription>
          </div>
        </CardHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (editor.canSave) editor.openSaveDialog()
          }}
        >
          <CardContent className="space-y-5 pt-3 sm:pt-3">
            <RecipientsField
              label="Destinatários dos avisos por e-mail"
              value={recipients}
              onChange={(value) => editor.patchEmail({ recipients: value })}
              error={fieldErrors["email.recipients"]}
              hint={`Um e-mail por linha (até ${MAX_RECIPIENTS}). A lista inteira é substituída ao salvar. Sem destinatário, o canal de e-mail segue ativo só para os e-mails ao motorista.`}
              placeholder="dono@seudominio.com.br"
              inputMode="email"
              testId="email-recipients"
            />

            <div className="flex flex-wrap items-center gap-x-2 text-sm text-ink-softer" data-testid="whatsapp-recipients-summary">
              <p>Avisos por WhatsApp: {whatsappCount === 0 ? "nenhum número cadastrado" : whatsappCount === 1 ? "1 número cadastrado" : `${whatsappCount} números cadastrados`}.</p>
              <Link to={configTabHref("whatsapp")} className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-2">
                Editar na aba WhatsApp
              </Link>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="Severidade mínima — e-mail"
                value={draft.email.minSeverity ?? dto.email.minSeverity}
                onChange={(ev) => editor.patchEmail({ minSeverity: ev.target.value as NotificationSeverity })}
                options={SEVERITY_OPTIONS}
                data-testid="email-minSeverity"
              />
              <Select
                label="Severidade mínima — WhatsApp"
                value={draft.whatsapp.minSeverity ?? dto.whatsapp.minSeverity}
                onChange={(ev) => editor.patchWhatsapp({ minSeverity: ev.target.value as NotificationSeverity })}
                options={SEVERITY_OPTIONS}
                data-testid="whatsapp-minSeverity"
              />
              <Input
                label="Janela de repetição (minutos)"
                autoComplete="off"
                inputMode="numeric"
                value={dedupe}
                onChange={(ev) => editor.setDedupe(ev.target.value)}
                error={fieldErrors["alerts.dedupeMinutes"]}
                hint={dedupeHint}
                data-testid="alerts-dedupeMinutes"
              />
            </div>

            <dl className="divide-y divide-border-subtle rounded-xl border border-border bg-muted/50" data-testid="alerts-readonly">
              <div className="flex flex-col gap-0.5 px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <dt className="text-sm font-medium text-ink-soft">Piso global de severidade</dt>
                <dd className="text-sm font-semibold text-ink" data-testid="alerts-globalMinSeverity">
                  {SEVERITY_SHORT[alerts.globalMinSeverity]}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <dt className="text-sm font-medium text-ink-soft">Teto de avisos por hora</dt>
                <dd className="text-sm font-semibold text-ink" data-testid="alerts-maxPerHour">
                  {alerts.maxPerHour}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-ink-softer">O piso global e o teto por hora são definidos pelo servidor (variáveis de ambiente) e não mudam por aqui. Valem para qualquer canal, além do mínimo de cada um.</p>
          </CardContent>
          <SaveFooter editor={editor} updatedAt={dto.updatedAt} />
        </form>
      </Card>

      <SaveDialog editor={editor} title="Confirmar alterações na comunicação" />
    </div>
  )
}
