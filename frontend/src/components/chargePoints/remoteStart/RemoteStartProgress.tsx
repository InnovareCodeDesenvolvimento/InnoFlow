import { CircleAlert, CircleCheck, Loader2, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { commandPhaseCopy, type CommandPhase } from "@/lib/remoteStart"

const ICON = { info: Loader2, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert } as const

/**
 * Estado do acompanhamento do comando, numa região `aria-live="polite"` que fica SEMPRE no DOM (só o conteúdo troca) — é assim que o leitor de tela anuncia
 * "Aguardando…" e depois o desfecho. Recusa do carregador e falta de resposta são avisos (`warning`), não erro: o carregador respondeu / o resultado é incerto.
 * `STARTING` (aceito, sessão ainda não criada) também gira: ainda há espera. `sessionId` só muda o texto do `ACCEPTED`.
 */
export function RemoteStartProgress({ phase, sessionId = null }: { phase: CommandPhase; sessionId?: string | null }) {
  const copy = commandPhaseCopy(phase, sessionId)
  const Icon = ICON[copy.tone]
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-testid="remote-start-status" data-phase={phase}>
      <Alert tone={copy.tone} icon={Icon} iconClassName={phase === "POLLING" || phase === "STARTING" ? "animate-spin" : undefined}>
        <p className="font-bold">{copy.title}</p>
        <p className="mt-1">{copy.detail}</p>
      </Alert>
    </div>
  )
}
