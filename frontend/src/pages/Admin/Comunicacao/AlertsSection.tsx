import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { DEDUPE_MAX, DEDUPE_MIN, SEVERITY_LABELS, SEVERITY_ORDER, SEVERITY_SHORT, type CommunicationDraft, type DraftErrors } from "@/lib/communicationSettings"
import type { CommunicationSettingsDTO, NotificationSeverity } from "@/types/api"

const SEVERITY_OPTIONS = SEVERITY_ORDER.map((value) => ({ value, label: SEVERITY_LABELS[value] }))

/**
 * Alertas: o que cada canal recebe (severidade mínima), a janela de repetição (o mesmo alerta com o mesmo contexto avisa no máximo 1 vez por janela) e, só para
 * leitura, o que o servidor impõe por variável de ambiente (piso global e teto por hora).
 */
export function AlertsSection({
  dto,
  draft,
  errors,
  onChangeEmail,
  onChangeWhatsapp,
  onChangeDedupe,
}: {
  dto: CommunicationSettingsDTO
  draft: CommunicationDraft
  errors: DraftErrors
  onChangeEmail: (value: NotificationSeverity) => void
  onChangeWhatsapp: (value: NotificationSeverity) => void
  onChangeDedupe: (value: string) => void
}) {
  const { alerts } = dto
  const dedupe = draft.alerts.dedupeMinutes ?? String(alerts.dedupeMinutes)
  const dedupeHint =
    draft.alerts.dedupeMinutes?.trim() === "" && alerts.dedupeSource === "database"
      ? "Em branco, volta ao padrão do servidor."
      : `De ${DEDUPE_MIN} a ${DEDUPE_MAX} minutos. ${alerts.dedupeSource === "database" ? "Valor salvo nesta tela; em branco volta ao padrão do servidor." : "Hoje vale o padrão do servidor."}`

  return (
    <Card data-testid="section-alerts">
      <CardHeader>
        <CardTitle as="h2">Alertas</CardTitle>
        <CardDescription>Quais avisos chegam em cada canal e com que frequência. O mesmo alerta, no mesmo contexto, é avisado no máximo uma vez por janela.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Severidade mínima — e-mail"
            value={draft.email.minSeverity ?? dto.email.minSeverity}
            onChange={(e) => onChangeEmail(e.target.value as NotificationSeverity)}
            options={SEVERITY_OPTIONS}
            data-testid="email-minSeverity"
          />
          <Select
            label="Severidade mínima — WhatsApp"
            value={draft.whatsapp.minSeverity ?? dto.whatsapp.minSeverity}
            onChange={(e) => onChangeWhatsapp(e.target.value as NotificationSeverity)}
            options={SEVERITY_OPTIONS}
            data-testid="whatsapp-minSeverity"
          />
          <Input
            label="Janela de repetição (minutos)"
            autoComplete="off"
            inputMode="numeric"
            value={dedupe}
            onChange={(e) => onChangeDedupe(e.target.value)}
            error={errors["alerts.dedupeMinutes"]}
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
    </Card>
  )
}
