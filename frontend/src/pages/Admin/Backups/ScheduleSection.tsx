import { CalendarClock, CircleCheck, CircleMinus } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { Card, CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Segmented } from "@/components/ui/Segmented"
import { Select } from "@/components/ui/Select"
import { ALERT_MAX, ALERT_MIN, FREQUENCY_OPTIONS, HOUR_OPTIONS, RETENTION_MAX, RETENTION_MIN, effectiveOf, enableBlockers, type BackupDraft, type DraftErrors } from "@/lib/backup"
import type { BackupConfigDTO } from "@/types/api"
import { SectionHeader, ToggleRow } from "./parts"

type SchedulePatch = Partial<Pick<BackupDraft, "enabled" | "hourLocal" | "frequencyDays" | "retentionCount" | "alertAfterHours">>

/**
 * Agendamento: ligado/desligado, frequência (1/2/7 dias), horário (Brasília), quantas cópias manter e o limite de atraso do alerta. Valores efetivos = rascunho sobre o DTO.
 * O que ainda impede LIGAR aparece escrito sob o interruptor (e o interruptor fica desabilitado enquanto houver impedimento e o automático estiver desligado: o servidor recusaria com 409).
 * Quantas cópias manter exige a senha ao salvar (reduzir apaga cópias no próximo backup).
 */
export function ScheduleSection({ dto, draft, errors, onChange, disabled }: { dto: BackupConfigDTO; draft: BackupDraft; errors: DraftErrors; onChange: (patch: SchedulePatch) => void; disabled: boolean }) {
  const eff = effectiveOf(dto, draft)
  const blockers = eff.enabled ? [] : enableBlockers(dto, draft)

  return (
    <Card data-testid="section-schedule">
      <SectionHeader
        icon={CalendarClock}
        title="Agendamento"
        description="Quando o sistema faz o backup sozinho e quantas cópias guarda."
        aside={
          dto.enabled ? (
            <Badge variant="success" data-testid="schedule-status">
              <CircleCheck className="h-3 w-3" aria-hidden="true" />
              Ligado
            </Badge>
          ) : (
            <Badge variant="neutral" data-testid="schedule-status">
              <CircleMinus className="h-3 w-3" aria-hidden="true" />
              Desligado
            </Badge>
          )
        }
      />
      <CardContent className="space-y-5">
        <ToggleRow
          id="enabled"
          name="o backup automático"
          enabled={eff.enabled}
          onChange={(value) => onChange({ enabled: value })}
          disabled={disabled || (!eff.enabled && blockers.length > 0)}
          help="Desligado, só o botão “Fazer backup agora” copia o banco. Desligar não apaga nada e não pede senha; ligar pede."
          error={errors.enabled}
        >
          {!eff.enabled && blockers.length > 0 && (
            <div className="text-xs text-ink-soft" data-testid="enable-blockers">
              <p className="font-semibold">Para poder ligar falta:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {blockers.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </div>
          )}
        </ToggleRow>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p id="backup-frequency-label" className="text-sm font-medium text-ink-soft">
              Frequência
            </p>
            <Segmented
              label="Frequência do backup"
              value={String(eff.frequencyDays)}
              onChange={(value) => onChange({ frequencyDays: Number(value) as 1 | 2 | 7 })}
              options={FREQUENCY_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            />
          </div>
          <Select label="Horário (Brasília)" value={String(Number(eff.hourLocal))} onChange={(e) => onChange({ hourLocal: e.target.value })} options={HOUR_OPTIONS} error={errors.hourLocal} data-testid="field-hour" />
          <Input
            label="Cópias a manter"
            inputMode="numeric"
            autoComplete="off"
            value={eff.retentionCount}
            onChange={(e) => onChange({ retentionCount: e.target.value })}
            error={errors.retentionCount}
            hint={`De ${RETENTION_MIN} a ${RETENTION_MAX}. As mais antigas são apagadas depois de cada backup (nunca a única). Mudar isto pede sua senha.`}
            data-testid="field-retention"
          />
          <Input
            label="Avisar se ficar sem backup por (horas)"
            inputMode="numeric"
            autoComplete="off"
            value={eff.alertAfterHours}
            onChange={(e) => onChange({ alertAfterHours: e.target.value })}
            error={errors.alertAfterHours}
            hint={`De ${ALERT_MIN} a ${ALERT_MAX}. Passando disso sem uma cópia nova, o dono é avisado e o estado geral fica vermelho.`}
            data-testid="field-alert-after"
          />
        </div>
      </CardContent>
    </Card>
  )
}
