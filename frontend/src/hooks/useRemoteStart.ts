import { useEffect, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { chargePointsService } from "@/services/chargePoints"
import { adminCommandsService } from "@/services/adminCommands"
import { getApiErrorStatus } from "@/services/api"
import { COMMAND_POLL_INTERVAL_MS, COMMAND_POLL_MAX_FAILURES, COMMAND_POLL_TIMEOUT_MS, type CommandPhase } from "@/lib/remoteStart"
import type { RemoteStartRequest } from "@/types/api"

/**
 * Dispara a recarga remota (ADMIN). SEM toast aqui: quem decide o que mostrar é o diálogo (o 202 só quer dizer "enfileirado" — o resultado vem do acompanhamento).
 * Não retenta sozinho: reenviar um POST que debita carteira é decisão da pessoa, não do cliente HTTP.
 */
export function useRemoteStart(chargePointId: string) {
  return useMutation({
    mutationFn: (payload: RemoteStartRequest) => chargePointsService.remoteStart(chargePointId, payload),
    retry: false,
    gcTime: 0,
  })
}

export interface CommandPollingOptions {
  intervalMs?: number
  timeoutMs?: number
  maxFailures?: number
}

/**
 * Acompanha o resultado de UM comando (`GET /api/admin/commands/:id`): consulta já ao começar e depois a cada `intervalMs`, até um desfecho do carregador
 * (`ACCEPTED`/`REJECTED`/`TIMEOUT`), até `timeoutMs` (`NO_ANSWER`), 404 (`UNAVAILABLE`, "resultado indisponível") ou `maxFailures` falhas de conexão/5xx
 * seguidas (`ERROR`; uma falha isolada não derruba o acompanhamento). 403 também vira `ERROR`.
 *
 * Para de consultar ao desmontar, ao trocar/zerar o `correlationId` e ao chegar a um desfecho — o `AbortController` cancela o pedido em voo. `null` = ocioso.
 * O estado é guardado COM o id a que pertence: trocar de comando nunca mostra o desfecho do anterior (derivado no render, sem `setState` síncrono em efeito).
 */
export function useCommandPolling(correlationId: string | null, options: CommandPollingOptions = {}): CommandPhase | "IDLE" {
  const { intervalMs = COMMAND_POLL_INTERVAL_MS, timeoutMs = COMMAND_POLL_TIMEOUT_MS, maxFailures = COMMAND_POLL_MAX_FAILURES } = options
  const [outcome, setOutcome] = useState<{ id: string; phase: CommandPhase } | null>(null)

  useEffect(() => {
    if (!correlationId) return
    const id = correlationId
    const controller = new AbortController()
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let stopped = false

    const finish = (phase: CommandPhase) => {
      if (!stopped) setOutcome({ id, phase })
    }

    const tick = async () => {
      try {
        const { status } = await adminCommandsService.status(id, controller.signal)
        if (stopped) return
        failures = 0
        if (status !== "PENDING") return finish(status)
      } catch (err) {
        if (stopped) return
        const httpStatus = getApiErrorStatus(err)
        if (httpStatus === 404) return finish("UNAVAILABLE")
        if (httpStatus === 403) return finish("ERROR")
        failures += 1
        if (failures >= maxFailures) return finish("ERROR")
      }
      if (Date.now() - startedAt >= timeoutMs) return finish("NO_ANSWER")
      timer = setTimeout(() => void tick(), intervalMs)
    }

    void tick()

    return () => {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [correlationId, intervalMs, timeoutMs, maxFailures])

  if (!correlationId) return "IDLE"
  return outcome?.id === correlationId ? outcome.phase : "POLLING"
}
