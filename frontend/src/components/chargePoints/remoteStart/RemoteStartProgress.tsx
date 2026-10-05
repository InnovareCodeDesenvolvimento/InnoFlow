import { CircleAlert, CircleCheck, Loader2, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { COMMAND_PHASE_COPY, type CommandPhase } from "@/lib/remoteStart"

const ICON = { info: Loader2, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert } as const

/**
 * Estado do acompanhamento do comando, numa região `aria-live="polite"` que fica SEMPRE no DOM (só o conteúdo troca) — é assim que o leitor de tela anuncia
 * "Aguardando…" e depois o desfecho. Recusa do carregador e falta de resposta são avisos (`warning`), não erro: o carregador respondeu / o resultado é incerto.
 */
export function RemoteStartProgress({ phase }: { phase: CommandPhase }) {
  const copy = COMMAND_PHASE_COPY[phase]
  const Icon = ICON[copy.tone]
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-testid="remote-start-status" data-phase={phase}>
      <Alert tone={copy.tone} icon={Icon} iconClassName={phase === "POLLING" ? "animate-spin" : undefined}>
        <p className="font-bold">{copy.title}</p>
        <p className="mt-1">{copy.detail}</p>
      </Alert>
    </div>
  )
}
