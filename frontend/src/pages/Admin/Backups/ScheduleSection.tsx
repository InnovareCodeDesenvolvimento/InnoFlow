import type { ReactNode } from "react"
import { CardContent } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { ALERT_MAX, ALERT_MIN, FREQUENCY_OPTIONS, HOUR_OPTIONS, RETENTION_MAX, RETENTION_MIN, effectiveOf, enableBlockers, scopeDraft, type BackupDraft, type DraftErrors } from "@/lib/backup"
import type { BackupConfigDTO } from "@/types/api"
import { HelpCard, ToggleRow } from "./parts"
import { SaveFooter } from "./SaveFooter"
import type { CardSave } from "./saveTypes"

type SchedulePatch = Partial<Pick<BackupDraft, "enabled" | "hourLocal" | "frequencyDays" | "retentionCount" | "alertAfterHours">>

/**
 * Agendamento: ligado/desligado, frequência (1/2/7 dias), hora (Brasília), quantas cópias manter e o limite de atraso do alerta. Valores efetivos = rascunho sobre o DTO.
 * O que ainda impede LIGAR aparece escrito sob o interruptor (e o interruptor fica desabilitado enquanto houver impedimento e o automático estiver desligado: o servidor recusaria com 409).
 * "Ligar" só vale com o destino JÁ SALVO (o servidor valida o estado futuro), por isso os impedimentos olham o rascunho SÓ deste cartão. Quantas cópias manter exige a senha ao salvar.
 */
export function ScheduleSection({
  dto,
  draft,
  errors,
  onChange,
  disabled,
  save,
  error,
}: {
  dto: BackupConfigDTO
  draft: BackupDraft
  errors: DraftErrors
  onChange: (patch: SchedulePatch) => void
  disabled: boolean
  save: CardSave
  error: ReactNode
}) {
  const eff = effectiveOf(dto, draft)
  const blockers = eff.enabled ? [] : enableBlockers(dto, scopeDraft(draft, "schedule"))

  return (
    <HelpCard
      testId="section-schedule"
      title="Agendamento"
      description="Quando o sistema copia sozinho (horário de Brasília) e quantas cópias guarda."
      className="h-full"
      help={
        <>
          <p>
            Com o automático ligado o sistema faz o backup sozinho, todo dia, dia sim dia não ou toda semana, na hora escolhida (horário de Brasília). Desligado, só o botão “Fazer backup agora” copia o banco. Desligar não apaga nada e
            não pede senha; ligar pede.
          </p>
          <p>
            “Cópias a manter” é quantas cópias ficam no destino: as mais antigas são apagadas depois de cada backup (nunca a única). Mudar isso pede a sua senha, porque reduzir apaga cópias. “Avisar após (horas)” é o limite sem cópia nova:
            passando dele o dono é avisado e a situação fica “Atrasado”.
          </p>
        </>
      }
    >
      <CardContent className="flex-1 space-y-5">
        <ToggleRow
          id="enabled"
          label="Backup automático"
          name="o backup automático"
          enabled={eff.enabled}
          onChange={(value) => onChange({ enabled: value })}
          disabled={disabled || (!eff.enabled && blockers.length > 0)}
          help={eff.enabled ? "Ligado: o sistema copia o banco sozinho, no horário abaixo." : "Desligado, só o botão “Fazer backup agora” copia o banco."}
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

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <Select
            label="Frequência"
            value={String(eff.frequencyDays)}
            onChange={(e) => onChange({ frequencyDays: Number(e.target.value) as 1 | 2 | 7 })}
            options={FREQUENCY_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            data-testid="field-frequency"
          />
          <Select label="Hora (Brasília)" value={String(Number(eff.hourLocal))} onChange={(e) => onChange({ hourLocal: e.target.value })} options={HOUR_OPTIONS} error={errors.hourLocal} data-testid="field-hour" />
          <Input
            label="Cópias a manter"
            inputMode="numeric"
            autoComplete="off"
            value={eff.retentionCount}
            onChange={(e) => onChange({ retentionCount: e.target.value })}
            error={errors.retentionCount}
            hint={`De ${RETENTION_MIN} a ${RETENTION_MAX}. As mais antigas são apagadas.`}
            data-testid="field-retention"
          />
          <Input
            label="Avisar após (horas)"
            inputMode="numeric"
            autoComplete="off"
            value={eff.alertAfterHours}
            onChange={(e) => onChange({ alertAfterHours: e.target.value })}
            error={errors.alertAfterHours}
            hint={`Sem cópia nova, de ${ALERT_MIN} a ${ALERT_MAX}.`}
            data-testid="field-alert-after"
          />
        </div>

        {error}
      </CardContent>

      <SaveFooter
        prefix="schedule"
        count={save.count}
        errorCount={save.errorCount}
        needsPassword={save.needsPassword}
        idleNote="Mudar as cópias a manter ou ligar o automático pede a sua senha."
        canSave={save.canSave}
        canDiscard={save.canDiscard}
        loading={save.loading}
        onSave={save.onSave}
        onDiscard={save.onDiscard}
      />
    </HelpCard>
  )
}
