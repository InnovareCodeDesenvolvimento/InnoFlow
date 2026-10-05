import { AlarmClock, Clock } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { responseDeadlineState } from "@/lib/reversals"
import { formatDate } from "@/lib/utils"
import type { ChargebackDTO } from "@/types/api"

/**
 * Prazo de resposta do chargeback. Só o EM ABERTO tem prazo vivo. Vencido = `danger`, até 3 dias = `warning` (a mesma janela do vigia do servidor); a cor NUNCA vai sozinha: o texto diz
 * "Vencido há N dias"/"Vence em N dias" e há ícone. Sem prazo cadastrado o sistema não avisa — a tela diz isso.
 */
export function DeadlineBadge({ chargeback, now }: { chargeback: Pick<ChargebackDTO, "responseDeadline" | "status">; now?: Date }) {
  const state = responseDeadlineState(chargeback.responseDeadline, chargeback.status, now)
  const date = chargeback.responseDeadline ? formatDate(chargeback.responseDeadline) : null

  if (state.kind === "overdue" || state.kind === "near") {
    return (
      <span className="flex flex-col items-start gap-1" data-deadline={state.kind}>
        <Badge variant={state.kind === "overdue" ? "danger" : "warning"}>
          <AlarmClock className="h-3 w-3" aria-hidden="true" />
          {state.label}
        </Badge>
        {date && <span className="text-xs text-ink-softer">até {date}</span>}
      </span>
    )
  }
  if (state.kind === "ok") {
    return (
      <span className="flex flex-col items-start" data-deadline="ok">
        <span className="font-semibold text-ink">{date}</span>
        <span className="text-xs text-ink-softer">{state.label}</span>
      </span>
    )
  }
  if (chargeback.status === "OPEN") {
    return (
      <span className="flex items-center gap-1 text-xs text-ink-softer" data-deadline="none">
        <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
        Sem prazo cadastrado
      </span>
    )
  }
  return <span className="text-ink-softer">{date ?? "—"}</span>
}
